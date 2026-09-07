#!/usr/bin/env python3
"""Apply audited policy/grants via authenticated API; never invoke a coworker/tool.
Use a private OPENBOT_ADMIN_COOKIE_FILE, not a cookie on the command line.
Run while configuration has a single writer. Policy is saved before grants.
"""
import argparse
import json
import os
from pathlib import Path
import urllib.request

BOUNDARY = json.loads(Path(__file__).with_name('read-only-boundary.json').read_text())

def merge_policy(current):
    if current.get('mode') != 'enforce':
        raise ValueError('Existing policy must already enforce; refusing to alter global mode.')
    return {**current, 'deny': list(dict.fromkeys([*[rule for rule in current['deny'] if rule not in BOUNDARY.get('previousDeny', [])], BOUNDARY['deny']]))}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:3001')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--policy-only', action='store_true', help='Apply before package startup exposes coworkers')
    args = parser.parse_args()
    cookie_path = Path(os.environ['OPENBOT_ADMIN_COOKIE_FILE'])
    if cookie_path.stat().st_mode & 0o077:
        raise ValueError('Cookie file must be private (0600).')
    cookie = cookie_path.read_text().strip()
    def call(path, method='GET', body=None):
        request = urllib.request.Request(args.url.rstrip('/')+path, method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Cookie': cookie, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    current = call('/api/computers/policy')['policy']
    desired = merge_policy(current)
    if not args.apply:
        print(json.dumps({'policyChange': desired != current, 'grants': BOUNDARY['grants'], 'apply': False}))
        return
    # Preserve pre-existing rules; refuse if another writer changed them during preflight.
    if call('/api/computers/policy')['policy'] != current:
        raise ValueError('Policy changed concurrently; rerun with a single configuration writer.')
    call('/api/computers/policy', 'PUT', desired)
    if call('/api/computers/policy')['policy'] != desired:
        raise ValueError('Policy verification failed; no grants applied.')
    if not args.policy_only:
        for ref in BOUNDARY['grants']:
            call('/api/plugins/grants', 'POST', {'kind': 'mcp', 'ref': ref, 'agentId': 'infra'})
        offered = call('/api/plugins/for/infra')['tools']
        if {tool['ref'] for tool in offered} != set(BOUNDARY['grants']):
            raise ValueError('Infra offered tools differ; policy remains enforced, inspect grants.')
    print(json.dumps({'policy': 'verified', 'grants': 'unchanged' if args.policy_only else 'verified'}))

if __name__ == '__main__':
    main()
