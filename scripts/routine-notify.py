#!/usr/bin/env python3
"""Deliver the durable routine outbox. MCP acknowledgement is not exactly-once delivery.

Run after the routine_notifications migration. The receiver has no idempotency
argument: a timeout after remote delivery can produce a duplicate on retry.
No credentials or runtime IO are accessed when this module is imported.
"""
import json
import os
import subprocess
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass


@dataclass
class Config:
    container: str = 'openbot-postgres-1'
    database: str = 'openbot'
    user: str = 'openbot'
    token_file: str = '~/openbot/.secrets/notify.token'
    mcp: str = 'https://arcus-nexus-hostinger.tail3c3777.ts.net:18861/mcp'
    base_url: str = 'https://viniciuspinho.tail3c3777.ts.net:3010'
    poll_seconds: int = 30
    request_timeout: int = 120
    lease_seconds: int = 180
    max_attempts: int = 8
    batch_size: int = 50
    # Comma-separated routine ids whose runs are acknowledged without a Telegram report
    # (high-frequency routines such as the intraday curve poster).
    skip_routines: str = ''

    @classmethod
    def from_env(cls):
        defaults = cls()
        values = {}
        for key, default in vars(defaults).items():
            value = os.environ.get('OPENBOT_NOTIFY_' + key.upper(),
                                   os.environ.get('OPENBOT_PUBLIC_URL', default) if key == 'base_url' else default)
            values[key] = int(value) if isinstance(default, int) else value
        config = cls(**values)
        if any(getattr(config, key) <= 0 for key in ('poll_seconds', 'request_timeout', 'lease_seconds', 'max_attempts', 'batch_size')):
            raise ValueError('notification limits must be positive')
        if config.lease_seconds <= config.request_timeout + 30:
            raise ValueError('lease must exceed request timeout plus database timeout')
        return config


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


class Store:
    def __init__(self, config):
        self.config = config

    def query(self, sql):
        c = self.config
        result = subprocess.run(['docker', 'exec', '-i', c.container, 'psql', '-X', '-q', '-U', c.user,
                                 '-d', c.database, '-v', 'ON_ERROR_STOP=1', '-tA'],
                                input=sql, capture_output=True, text=True, timeout=30)
        if result.returncode:
            # Do not log stderr: database errors can contain private text.
            raise RuntimeError('database command failed')
        rows = json.loads(result.stdout)
        if not isinstance(rows, list):
            raise ValueError('expected database JSON array')
        return rows

    def heartbeat(self):
        self.query("""WITH updated AS (
 INSERT INTO openbot_service_health(name,last_ok_at) VALUES ('routine-notifier',now())
 ON CONFLICT(name) DO UPDATE SET last_ok_at=excluded.last_ok_at RETURNING name
) SELECT coalesce(json_agg(row_to_json(updated)), '[]'::json) FROM updated;""")

    def claim(self):
        c = self.config
        # Recover abandoned final attempts as visible failures, not stuck leases.
        # The update and claim use disjoint states; SKIP LOCKED arbitrates workers.
        rows = self.query(f"""
WITH exhausted AS (
 UPDATE routine_notifications SET status='failed', lease_until=NULL,
 last_error='Delivery outcome unknown after final lease expired'
 WHERE status='sending' AND lease_until < now() AND attempts >= {c.max_attempts}
 RETURNING run_id
), candidate AS (
 SELECT n.run_id FROM routine_notifications n
 WHERE ((n.status='pending' AND n.next_attempt_at <= now())
 OR (n.status='sending' AND n.lease_until < now())) AND n.attempts < {c.max_attempts}
 ORDER BY n.created_at, n.run_id FOR UPDATE SKIP LOCKED LIMIT 1
), claimed AS (
 UPDATE routine_notifications n SET status='sending', attempts=n.attempts+1,
 lease_until=now()+make_interval(secs => {c.lease_seconds})
 FROM candidate c WHERE n.run_id=c.run_id RETURNING n.run_id,n.attempts
)
SELECT coalesce(json_agg(row_to_json(payload)), '[]'::json) FROM (
 SELECT x.run_id,x.attempts,rr.status,coalesce(rr.reply_text,'') AS reply_text,
 coalesce(rr.error,'') AS error,rr.routine_id,coalesce(r.agent_id,'?') AS agent,
 coalesce(rr.channel_id_snapshot,r.channel_id,'') AS channel_id,coalesce(rr.instruction_snapshot,r.instruction,'') AS instruction,
 coalesce(ch.name,'') AS channel
 FROM claimed x JOIN routine_runs rr ON rr.id=x.run_id
 LEFT JOIN routines r ON r.id=rr.routine_id LEFT JOIN channels ch ON ch.id=coalesce(rr.channel_id_snapshot,r.channel_id)
) payload;""")
        return rows[0] if rows else None

    def finish(self, row, receipt=None, error=None):
        run_id, attempt = literal(row['run_id']), int(row['attempts'])
        if error is None:
            values = f"status='sent', delivered_at=now(), last_error=NULL, receipt={literal(json.dumps(receipt))}::jsonb"
        else:
            status = 'failed' if attempt >= self.config.max_attempts else 'pending'
            delay = min(3600, 30 * 2 ** min(attempt - 1, 7))
            values = f"status='{status}', next_attempt_at=now()+make_interval(secs => {delay}), last_error={literal(error)}"
        # Attempt + lease fence prevent a stale sender acknowledging a new claim.
        rows = self.query(f"""WITH updated AS (
 UPDATE routine_notifications SET {values}, lease_until=NULL
 WHERE run_id={run_id} AND status='sending' AND attempts={attempt} AND lease_until > now()
 RETURNING run_id
) SELECT coalesce(json_agg(row_to_json(updated)), '[]'::json) FROM updated;""")
        return bool(rows)


def parse_response(raw):
    text = raw.decode('utf-8')
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        responses = []
        for event in text.replace('\r\n', '\n').split('\n\n'):
            data = '\n'.join(line[5:].lstrip(' ') for line in event.splitlines() if line.startswith('data:'))
            if data and data != '[DONE]':
                value = json.loads(data)
                if isinstance(value, dict) and value.get('id') == 1:
                    responses.append(value)
        if len(responses) != 1:
            raise ValueError('missing or ambiguous MCP response')
        return responses[0]



def read_response(response):
    # SSE connections may remain open after a tool result. Stop at its complete
    # event instead of waiting for EOF and turning a delivered result into a retry.
    if 'text/event-stream' in response.headers.get('Content-Type', ''):
        event = []
        total = 0
        for line in response:
            total += len(line)
            if total > 2_000_000:
                raise ValueError('MCP response exceeds limit')
            if line.strip():
                event.append(line)
                continue
            if event:
                raw = b''.join(event)
                event = []
                try:
                    value = parse_response(raw)
                except ValueError:
                    continue  # SSE comment or protocol notification.
                if isinstance(value, dict) and value.get('id') == 1:
                    return value
        if event:
            return parse_response(b''.join(event))
        raise ValueError('missing MCP response')
    raw = response.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError('MCP response exceeds limit')
    return parse_response(raw)


def validate_receipt(envelope):
    if not isinstance(envelope, dict) or envelope.get('jsonrpc') != '2.0' or envelope.get('id') != 1 or 'error' in envelope:
        raise ValueError('invalid JSON-RPC acknowledgement')
    result = envelope.get('result')
    if not isinstance(result, dict) or result.get('isError'):
        raise ValueError('MCP tool failed')
    content, structured = result.get('content'), result.get('structuredContent')
    if not (isinstance(content, list) and content) and not isinstance(structured, dict):
        raise ValueError('empty MCP acknowledgement')
    candidates = [structured] if isinstance(structured, dict) else []
    for block in content or []:
        if not isinstance(block, dict) or not isinstance(block.get('type'), str):
            raise ValueError('malformed MCP content')
        if block['type'] == 'text':
            if not isinstance(block.get('text'), str) or not block['text'].strip():
                raise ValueError('empty MCP text')
            try:
                candidates.append(json.loads(block['text']))
            except json.JSONDecodeError:
                pass  # Tool contract may acknowledge in prose.
    for value in candidates:
        if isinstance(value, dict) and (value.get('ok') is False or value.get('success') is False or value.get('error') or value.get('status') in ('failed', 'error')):
            raise ValueError('negative delivery acknowledgement')
    # Persist only protocol evidence, not the message text or credential-bearing response.
    receipt = {'acknowledged_by': 'routine_report', 'jsonrpc_id': 1, 'isError': False,
               'acknowledged_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    for value in candidates:
        if isinstance(value, dict):
            for key in ('message_id', 'delivery_id'):
                identifier = value.get(key)
                if isinstance(identifier, (str, int)) and not isinstance(identifier, bool):
                    receipt[key] = str(identifier)[:200]
    return receipt


def external_delivery_enabled():
    mode = os.environ.get('OPENBOT_NOTIFICATION_DELIVERY', 'telegram')
    if mode not in ('internal', 'telegram'):
        raise ValueError('invalid notification delivery mode')
    return mode == 'telegram'


def report(config, **args):
    if not external_delivery_enabled():
        raise RuntimeError('external notifications are disabled')
    with open(os.path.expanduser(config.token_file), encoding='utf-8') as source:
        token = source.read().strip()
    if not token:
        raise ValueError('empty notification credential')
    body = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'routine_report', 'arguments': args}}
    request = urllib.request.Request(config.mcp, data=json.dumps(body).encode(), headers={
        'authorization': f'Bearer {token}', 'content-type': 'application/json', 'accept': 'application/json, text/event-stream'})
    with urllib.request.urlopen(request, timeout=config.request_timeout) as response:
        return validate_receipt(read_response(response))


def payload(row, config):
    name = row['instruction'].split('\n')[0].strip(' .:')[:100] or row['routine_id']
    text = row['reply_text'] or row['error'] or 'Execução concluída sem resposta persistida; consulte o canal.'
    # Leave space for metadata inside Telegram's 4096-character message budget.
    text = text[:2800] + ('\n[Resposta completa no canal]' if len(text) > 2800 else '')
    text += '\n\nExecução: ' + row['run_id']
    text += '\n' + config.base_url.rstrip('/') + '/routine-runs/' + urllib.parse.quote(row['run_id'], safe='')
    return dict(routine=name, agent=row['agent'], channel=row['channel'] or row['channel_id'], text=text, status=row['status'])


def tick(store, config, send=report):
    if not external_delivery_enabled():
        return 0
    count = 0
    for _ in range(config.batch_size):
        row = store.claim()
        if not row:
            break
        skipped = {r.strip() for r in config.skip_routines.split(',') if r.strip()}
        try:
            if row['routine_id'] in skipped:
                receipt = {'acknowledged_by': 'skip-list',
                           'acknowledged_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
            else:
                receipt = send(config, **payload(row, config))
        except Exception as error:
            store.finish(row, error=type(error).__name__)
        else:
            if not store.finish(row, receipt=receipt):
                print(json.dumps({'type': 'routine-notify', 'event': 'lease_lost', 'run': row['run_id']}), flush=True)
        count += 1
    store.heartbeat()
    return count


def main():
    if not external_delivery_enabled():
        print('External notifications disabled: internal inbox is active', flush=True)
        return
    config = Config.from_env()
    store = Store(config)
    while True:
        try:
            tick(store, config)
        except Exception as error:
            print(json.dumps({'type': 'routine-notify', 'loop_error': type(error).__name__}), flush=True)
        time.sleep(config.poll_seconds)


if __name__ == '__main__':
    main()
