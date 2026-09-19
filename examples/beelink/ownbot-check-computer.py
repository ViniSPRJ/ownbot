#!/usr/bin/env python3
"""Recover the existing shared computer's network after Docker/Tailscale boot races.

Runs after OwnBot's compose startup. Never recreates containers or alters volumes.
A successful in-container healthcheck does not prove the published API is reachable.
"""
import json
import subprocess
import time
import urllib.request

CONTAINER = 'openbot-agent-computer-1'
NETWORK = 'openbot_default'
HEALTH_URL = 'http://127.0.0.1:4100/health'


def docker(*args):
    result = subprocess.run(['/usr/bin/docker', *args], capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise RuntimeError('Docker operation failed: ' + ' '.join(args[:2]))
    return result.stdout


def inspect():
    return json.loads(docker('inspect', CONTAINER))[0]


def check_identity(info):
    labels = info['Config'].get('Labels') or {}
    if labels.get('com.docker.compose.project') != 'openbot' or labels.get('com.docker.compose.service') != 'agent-computer':
        raise RuntimeError('Unexpected computer ownership; refusing network changes')
    if info['HostConfig'].get('NetworkMode') != NETWORK:
        raise RuntimeError('Unexpected configured computer network; refusing network changes')
    if not info['State']['Running']:
        raise RuntimeError('Computer container is not running after compose startup')
    bindings = info['HostConfig'].get('PortBindings') or {}
    if bindings.get('4100/tcp') != [{'HostIp': '127.0.0.1', 'HostPort': '4100'}]:
        raise RuntimeError('Computer API binding changed; review the startup check')


def ensure_network():
    info = inspect()
    check_identity(info)
    networks = info['NetworkSettings'].get('Networks') or {}
    if NETWORK not in networks:
        if networks:
            raise RuntimeError('Computer has an unexpected network; refusing automatic changes')
        network = json.loads(docker('network', 'inspect', NETWORK))[0]
        if (network.get('Labels') or {}).get('com.docker.compose.project') != 'openbot':
            raise RuntimeError('Unexpected network ownership; refusing automatic changes')
        try:
            docker('network', 'connect', '--alias', 'agent-computer', NETWORK, CONTAINER)
        except RuntimeError:
            # A concurrent startup may have attached the same network first.
            if NETWORK not in (inspect()['NetworkSettings'].get('Networks') or {}):
                raise
        print('Recovered shared computer connection to its configured Docker network.', flush=True)
    info = inspect()
    check_identity(info)
    if NETWORK not in (info['NetworkSettings'].get('Networks') or {}):
        raise RuntimeError('Computer network is still missing after recovery')
    return info['State']['Pid']


def check_health():
    # This verifies the host-to-container path; browser actions are tested separately through OwnBot.
    deadline = time.monotonic() + 45
    while True:
        try:
            with urllib.request.urlopen(HEALTH_URL, timeout=3) as response:
                if response.status == 200 and json.load(response).get('status') == 'ok':
                    print('Shared computer API reachable through its loopback port.', flush=True)
                    return
        except (OSError, ValueError):
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError('Computer API is not reachable after compose startup')
        time.sleep(1)


if __name__ == '__main__':
    try:
        ensure_network()
        check_health()
    except Exception as error:
        raise SystemExit(str(error))
