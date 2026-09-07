# Nexus FX receipts

`nexus-fx/status` reads a redacted snapshot from Nexus through a dedicated SSH identity.
It never executes trading, restarts, file edits or an arbitrary shell command. The
existing plugin grant, gateway policy and audit apply before this transport runs.
Normal ownbot login identifies the actor; a protected operator mapping specifies which
actor may use the dedicated read-only key. Other users are refused even if granted the tool.

Set `OPENBOT_NEXUS_FX_CONFIG` to a private absolute JSON path (0600):

```json
{
  "owners": {
    "OWNBOT_USER_ID": {
      "host": "nexus-ops-vps.tail3c3777.ts.net",
      "expectedHost": "nexus-ops-vps.tail3c3777.ts.net",
      "sshUser": "ownbot-fx-reader",
      "port": 22224,
      "identityFile": "/absolute/private/nexus-fx-key",
      "knownHostsFile": "/absolute/private/nexus-fx-known-hosts"
    }
  }
}
```

Both key and known-hosts files must be 0600. Pin the Nexus host key after verifying its
identity using the existing trusted connection. A Tailnet IP is also accepted as `host`;
the host key entry must match `[host]:22224`. The dedicated OpenSSH listener uses port
22224 because port 22 belongs to Tailscale SSH; existing operator SSH stays unchanged.
`expectedHost` remains the fixed Nexus identity.
No user/model field supplies a host, account, key path or command.

The remote account must have its dedicated authorized key constrained by ForceCommand
to the snapshot reader, with forwarding and PTY disabled. The reader accepts only
`SSH_ORIGINAL_COMMAND=ownbot-fx-status` and can read only the redacted snapshot generated
by the exporter. Install the exporter/reader independently; do not give the SSH reader
access to root, trading state directories or trading credentials.

The client disables SSH configuration files, ssh-agent, forwarding, interactive login
and local commands, requires the pinned host key, and runs only `/usr/bin/ssh` with a
fixed argument vector. It limits execution to 15 seconds and output to 20 KB. There is
no alternate host, generic command, API fallback or mutation endpoint.

Snapshot contract: `schemaVersion:1`, ISO `observedAt`, fixed `host`, `source:codex-fx`,
`status:ok|degraded|unknown`, `warnings`, and at most five receipts. Receipts include
their actual timestamps, state, gateway decision and quote validity when known.
Unrecognized fields are removed before delivery. Snapshots older than 120 seconds
are marked unknown with `snapshot_stale`, preserving their original timestamp. A
fresh snapshot can still contain stale quotes; the agent must use the receipt's quote
age and validity instead of treating snapshot freshness or HOLD as proof of readiness.

Activate the catalogue entry only after the fixed-command reader works, refresh tools,
grant the exact `nexus-fx/status` read tool to the intended agent and retain all trading
mutation denials. Validate a real receipt and a stale snapshot, user isolation, host-key
mismatch and refusal of any command other than the reader. Tool results are untrusted
evidence, never authorization to trade.
