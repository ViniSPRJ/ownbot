#!/usr/bin/env python3
"""Authenticated gateway probe; never run a model, send a message or call a mutating tool."""
import argparse
import json
import os
from pathlib import Path
import urllib.error
import urllib.request

PAIRS = [('coord', 'infra'), ('infra', 'coord'), ('coord', 'onyx'), ('onyx', 'coord')]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:3001')
    parser.add_argument('--grant-handoffs', action='store_true')
    args = parser.parse_args()
    path = Path(os.environ['OPENBOT_ADMIN_COOKIE_FILE'])
    if path.stat().st_mode & 0o077:
        raise ValueError('Cookie file must be private (0600).')
    cookie = path.read_text().strip()
    def call(route, method='GET', body=None):
        request = urllib.request.Request(args.url.rstrip('/')+route, method=method,
            headers={'Cookie':cookie, 'Content-Type':'application/json'},
            data=None if body is None else json.dumps(body).encode())
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())
    if args.grant_handoffs:
        for source, target in PAIRS:
            status, _ = call('/api/plugins/grants', 'POST',
                {'kind':'bot', 'ref':target, 'agentId':source})
            if status != 200:
                raise RuntimeError(f'Handoff grant failed HTTP {status}; stop.')
    for source, target in PAIRS:
        status, data = call(f'/api/agents/{source}/handoff')
        if status != 200 or target not in data.get('handoff', {}).get('reachable', []):
            raise RuntimeError(f'Handoff {source} -> {target} not verified.')
    # This API resolves actor ID from the session, checks visibility, exact MCP grant,
    # builds the same policy context as runtime, audits, then calls the MCP transport.
    # It takes no run ID: this is an explicit operator probe, not a fabricated model run.
    status, result = call('/api/plugins/call', 'POST',
        {'agentId':'infra', 'ref':'vps-ops/status', 'args':{}})
    if status != 200 or result.get('isError') is not False or not result.get('text'):
        raise RuntimeError(f'Infra status failed HTTP {status}; inspect private audit.')
    # Read-only status is harmless even if a bug incorrectly permits this negative probe.
    denied_status, _ = call('/api/plugins/call', 'POST',
        {'agentId':'onyx', 'ref':'vps-ops/status', 'args':{}})
    if denied_status != 403:
        raise RuntimeError(f'Onyx unexpected status access HTTP {denied_status}.')
    print(json.dumps({'handoffs':'verified', 'infraStatus':'gateway response verified',
        'onyxStatus':'refused', 'modelTurns':0, 'externalMessages':0}))

if __name__ == '__main__':
    main()
