"""Offline protocol, outbox, and parsing regressions. Never accesses live services."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('routine_notify', Path(__file__).parents[1] / 'routine-notify.py')
n = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = n
spec.loader.exec_module(n)


def row(index=1):
    return dict(run_id=f'run-{index}', routine_id='routine', attempts=1, status='succeeded',
                reply_text='Fatos:\nPrimeiro | item\nOpinião: texto completo', error='',
                agent='News', channel_id='channel_1', instruction='Briefing\ncom opiniões', channel='Notícias\nda manhã')


class MemoryStore:
    """Minimal lease model for fault injection, independent of SQL implementation."""
    def __init__(self, count=1, max_attempts=8):
        self.rows = [dict(row(i), delivery='pending', due=0, lease=0, attempts=0) for i in range(count)]
        self.clock = 0
        self.heartbeats = 0
        self.max_attempts = max_attempts

    def heartbeat(self):
        self.heartbeats += 1

    def claim(self):
        for item in self.rows:
            if item['delivery'] == 'sending' and item['lease'] < self.clock and item['attempts'] >= self.max_attempts:
                item['delivery'] = 'failed'
            if ((item['delivery'] == 'pending' and item['due'] <= self.clock) or
                    (item['delivery'] == 'sending' and item['lease'] < self.clock)) and item['attempts'] < self.max_attempts:
                item['attempts'] += 1
                item['delivery'] = 'sending'
                item['lease'] = self.clock + 180
                return dict(item)
        return None

    def finish(self, claim, receipt=None, error=None):
        item = next(x for x in self.rows if x['run_id'] == claim['run_id'])
        if item['delivery'] != 'sending' or item['attempts'] != claim['attempts'] or item['lease'] <= self.clock:
            return False
        item['delivery'] = 'sent' if error is None else ('failed' if item['attempts'] >= self.max_attempts else 'pending')
        item['due'] = self.clock + 30 * 2 ** (item['attempts'] - 1)
        item['receipt'] = receipt
        item['error'] = error
        return True


class NotifyTests(unittest.TestCase):
    def test_250_deliveries_do_not_replay_on_subsequent_polls(self):
        store, sent = MemoryStore(250), []
        config = n.Config(batch_size=50)
        for _ in range(12):
            n.tick(store, config, lambda _, **args: sent.append(args) or {'ack': True})
        self.assertEqual(len(sent), 250)
        self.assertTrue(all(r['delivery'] == 'sent' for r in store.rows))

    def test_transport_failure_retries_after_backoff(self):
        store = MemoryStore()
        def fail(*args, **kwargs):
            raise TimeoutError('sensitive-token-must-not-be-stored')
        n.tick(store, n.Config(), fail)
        self.assertEqual(store.rows[0]['delivery'], 'pending')
        self.assertEqual(store.rows[0]['error'], 'TimeoutError')
        self.assertIsNone(store.claim())
        store.clock = 31
        n.tick(store, n.Config(), lambda *a, **kw: {'ack': True})
        self.assertEqual(store.rows[0]['delivery'], 'sent')
        self.assertEqual(store.rows[0]['attempts'], 2)

    def test_final_failure_stays_visible(self):
        store = MemoryStore(max_attempts=1)
        def fail(*args, **kwargs):
            raise ValueError()
        n.tick(store, n.Config(max_attempts=1), fail)
        self.assertEqual(store.rows[0]['delivery'], 'failed')
        store.clock = 99999
        self.assertIsNone(store.claim())

    def test_lease_collision_and_stale_ack(self):
        store = MemoryStore()
        first = store.claim()
        self.assertIsNone(store.claim())
        store.clock = 181
        second = store.claim()
        self.assertFalse(store.finish(first, receipt={'ack': True}))
        self.assertTrue(store.finish(second, receipt={'ack': True}))
        self.assertIsNone(store.claim())

    def test_abandoned_final_lease_is_failed(self):
        store = MemoryStore(max_attempts=1)
        store.claim()
        store.clock = 181
        self.assertIsNone(store.claim())
        self.assertEqual(store.rows[0]['delivery'], 'failed')

    def test_multiline_content_is_persisted_run_result(self):
        result = n.payload(row(), n.Config())
        self.assertIn(row()['reply_text'], result['text'])
        self.assertIn('Execução: run-1', result['text'])
        self.assertIn('/routine-runs/run-1', result['text'])
        self.assertEqual(set(result), {'routine', 'agent', 'channel', 'text', 'status'})
        self.assertEqual(result['channel'], 'Notícias\nda manhã')

    def test_psql_parses_json_and_checks_return_code(self):
        store = n.Store(n.Config())
        with patch.object(n.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps([row()]), '')) as run:
            self.assertEqual(store.query('select'), [row()])
            self.assertIn('ON_ERROR_STOP=1', run.call_args.args[0])
            self.assertIn('-X', run.call_args.args[0])
        with patch.object(n.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '[]', 'secret')):
            with self.assertRaisesRegex(RuntimeError, '^database command failed$'):
                store.query('select')
        with patch.object(n.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'not-json', '')):
            with self.assertRaises(ValueError):
                store.query('select')

    def test_sql_claim_has_atomic_lease_and_finish_has_fence(self):
        store = n.Store(n.Config())
        with patch.object(store, 'query', return_value=[row()]) as query:
            store.claim()
            sql = query.call_args.args[0]
            self.assertIn('FOR UPDATE SKIP LOCKED LIMIT 1', sql)
            self.assertIn('attempts=n.attempts+1', sql)
            self.assertIn('rr.reply_text', sql)
            self.assertNotIn('last_message', sql)
            store.finish(row(), receipt={'ack': True})
            sql = query.call_args.args[0]
            self.assertIn("status='sending' AND attempts=1 AND lease_until > now()", sql)
            self.assertIn("status='sent'", sql)
            store.finish(row(), error='TimeoutError')
            self.assertIn("status='pending'", query.call_args.args[0])
            last = dict(row(), attempts=8)
            store.finish(last, error='TimeoutError')
            self.assertIn("status='failed'", query.call_args.args[0])

    def test_jsonrpc_and_mcp_failures(self):
        invalid = [None, {}, {'jsonrpc': '2.0', 'id': 1, 'error': {'code': -1}},
                   {'jsonrpc': '2.0', 'id': 1, 'result': {'isError': True, 'content': [{'type': 'text', 'text': 'failed'}]}},
                   {'jsonrpc': '2.0', 'id': 1, 'result': {'content': []}},
                   {'jsonrpc': '2.0', 'id': 1, 'result': {'content': [{'type': 'text', 'text': '{"ok":false}'}]}},
                   {'jsonrpc': '2.0', 'id': 1, 'result': {'structuredContent': {'success': False}}}]
        for envelope in invalid:
            with self.subTest(envelope=envelope), self.assertRaises(ValueError):
                n.validate_receipt(envelope)

    def test_protocol_failure_remains_retryable(self):
        for result in ({'isError': True}, {'content': [{'type': 'text', 'text': '{"ok":false}'}]}):
            store = MemoryStore()
            def fail(*args, **kwargs):
                return n.validate_receipt({'jsonrpc': '2.0', 'id': 1, 'result': result})
            n.tick(store, n.Config(), fail)
            self.assertEqual(store.rows[0]['delivery'], 'pending')

    def test_json_and_sse_acknowledgements(self):
        envelope = {'jsonrpc': '2.0', 'id': 1, 'result': {'content': [{'type': 'text', 'text': '{"ok":true,"message_id":42}'}]}}
        for raw in (json.dumps(envelope), ': heartbeat\r\n\r\nevent: message\r\ndata: ' + json.dumps(envelope) + '\r\n\r\n'):
            ack = n.validate_receipt(n.parse_response(raw.encode()))
            self.assertEqual(ack['acknowledged_by'], 'routine_report')
            self.assertNotIn('content', ack)
        with self.assertRaises(ValueError):
            n.parse_response(b': heartbeat\n\n')

    def test_sse_stops_after_result_without_waiting_for_eof(self):
        class Stream:
            headers = {'Content-Type': 'text/event-stream'}
            def __iter__(self):
                yield b': heartbeat\n'
                yield b'\n'
                yield b'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}}\n'
                yield b'\n'
                raise AssertionError('must not wait for EOF')
        self.assertEqual(n.read_response(Stream())['id'], 1)

    def test_heartbeat_including_empty_poll_but_not_db_failure(self):
        store = MemoryStore(0)
        n.tick(store, n.Config())
        self.assertEqual(store.heartbeats, 1)
        with patch.object(store, 'claim', side_effect=RuntimeError('db offline')):
            with self.assertRaises(RuntimeError):
                n.tick(store, n.Config())
        self.assertEqual(store.heartbeats, 1)
        database = n.Store(n.Config())
        with patch.object(database, 'query', return_value=[]) as query:
            database.heartbeat()
            self.assertIn("'routine-notifier'", query.call_args.args[0])
            self.assertIn('ON CONFLICT(name)', query.call_args.args[0])

    def test_public_url_environment(self):
        with patch.dict(n.os.environ, {'OPENBOT_PUBLIC_URL': 'https://example.invalid'}):
            self.assertEqual(n.Config.from_env().base_url, 'https://example.invalid')

    def test_default_config_and_lease_safety(self):
        with patch.dict(n.os.environ, {'OPENBOT_NOTIFY_LEASE_SECONDS': '100'}):
            with self.assertRaises(ValueError):
                n.Config.from_env()


if __name__ == '__main__':
    unittest.main()
