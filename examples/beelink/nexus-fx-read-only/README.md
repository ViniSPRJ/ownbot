# Nexus FX: read-only receipt snapshot

This package contains an exporter and SSH reader; it is not installed by adding an
Ownbot tool grant. The Ownbot catalogue contract is vendor `nexus-fx`, tool `status`,
arguments `{}`. Its transport runs **exactly** `ownbot-fx-status` over authenticated
Tailnet SSH as `ownbot-fx-reader`. The server-side reader rejects any other command.

The source is the live **codex-fx** lane. It is not the Grok submission service.
The service reads these fixed files, without importing or calling executor code:

- `/var/lib/tch-isolated-fx/runner-audit.jsonl` (last 256 KiB, completed lines only)
- `/var/lib/tch-isolated-fx-decisions/latest/codex-fx/{EURUSD,GBPUSD,USDCAD,USDCHF,USDJPY}.json`
- `/var/lib/tch-carrier-state/fxpro/{EURUSD,GBPUSD,USDCAD,USDCHF,USDJPY}/quote.json`

Root needs to read the existing mode-0600 files. Ownbot receives neither root
access nor these files: the exporter writes one redacted mode-0640 snapshot owned
by root and group `ownbot-fx-reader`. The reader account can read only this snapshot
and has no sudo, executor, broker, decision-receiver or source-file privileges.
The exporter is isolated from networking and cannot write outside its snapshot
directory. It does not change trading flags, decisions, orders, accounts or feeds.

## JSON contract

One UTF-8 object, at most 20 KiB, `schemaVersion: 1`, `host` equal to
`nexus-ops-vps.tail3c3777.ts.net`, `source: "codex-fx"`, `observedAt` (UTC),
`status: "ok" | "degraded" | "unknown"`, `warnings: string[]`, and at most five
`receipts`. Each receipt includes:

```json
{
  "id": "decision-id", "timestamp": "2026-09-07T20:42:52Z",
  "symbol": "EURUSD", "source": "codex-fx", "state": "hold_persisted",
  "carrierEmitted": false, "gatewayStatus": null,
  "gatewayDecision": null, "gatewayReason": null,
  "decisionIssuedAt": "2026-09-07T20:42:29Z",
  "quote": {
    "observedAt": "2026-09-07T20:42:48Z", "generatedAt": "2026-09-07T20:42:52Z",
    "valid": true, "invalidReason": null, "tickAgeSeconds": 4
  },
  "warnings": []
}
```

All receipt fields are always present; unknown scalar values are `null`.
No positions, rationale, free-form logs, account identifiers, credentials or
arbitrary source fields are exported. Reason fields accept bounded code tokens;
free-form error strings are omitted. `ok` means this snapshot has fresh readable
evidence without the listed source failures, **not** broker/execution readiness,
trading authorization, no existing positions, or investment advice. In particular,
`hold_persisted` is merely a persisted HOLD; a fresh HOLD does not hide a stale quote.

Missing/invalid receipts produce `unknown`; stale/invalid quotes and receipt
failures produce warnings and `degraded`. A latest decision with a different ID
than the latest receipt is explicitly unconfirmed. Receipts older than one hour
are marked old, never fabricated or refreshed. A snapshot older than 120 seconds
is returned as `unknown` with `snapshot_stale`, preserving its original timestamp.

The runner's older `blocked_before_gateway` audit branch has no `decision_id` or
`ok` field: it records a guard failure before loading a decision. A valid timestamp,
`carrier_emitted:false` and bounded reason code identify this readable negative event.
An older block does not label the whole history corrupt when newer receipts exist;
if it is the newest event for a symbol, its null ID, blocked state and failure reason
remain explicit and degraded. Unknown/malformed shapes still produce a history-gap
warning. The exporter never rewrites or removes audit history.

## Operator provisioning

Nexus port 22 is **Tailscale SSH**, not ordinary OpenSSH. Its policy would bypass
OpenSSH key/ForceCommand configuration, so this package has a separate listener
on **100.93.82.41:22224**. Existing Tailscale, root and operator SSH remain untouched.
The adapter uses the pinned port 22224. Do not install a Match block in the main
SSH configuration and assume it governs Tailscale SSH.

1. Run tests and inventory account/group, target paths, service names and port
   22224 for collisions. Record a rollback manifest under a mode-0700 backup
   directory. Existing files must be backed up before an intentional upgrade;
   first installation refuses collisions.
2. Generate a dedicated Ed25519 identity **on Beelink**, mode 0600. The private
   key never leaves Beelink and has no root/general SSH grants. Copy only its
   public key to Nexus. Obtain `/etc/ssh/ssh_host_ed25519_key.pub` through the
   authenticated operator connection and pin it as
   `[nexus-ops-vps.tail3c3777.ts.net]:22224` in a dedicated mode-0600 known_hosts.
   No unauthenticated TOFU or unchecked `ssh-keyscan` is used.
3. Create system user/group `ownbot-fx-reader` with home
   `/var/lib/ownbot-fx-reader`, `/bin/sh`, no extra groups and no sudo grants.
   The shell is required for the fixed SSH command; password authentication is
   disabled in this dedicated listener. Root owns its home and `.ssh` (0755) and
   `authorized_keys` (0644). The sole public key line has these restrictions:

   ```text
   restrict,from="100.122.56.122",command="/usr/bin/python3 -I -B /usr/local/lib/ownbot-fx-status/ownbot_fx_status.py --read" ssh-ed25519 <dedicated-public-key>
   ```

4. Install `ownbot_fx_status.py` root:root 0644 under root:root 0755
   `/usr/local/lib/ownbot-fx-status`. Create `/var/lib/ownbot-fx-status` as
   root:ownbot-fx-reader 0750. Install the supplied service/timer files to
   `/etc/systemd/system` and `sshd_config_ownbot_fx` to `/etc/ssh`, root:root 0644.
   The isolated SSH config allows only the reader, a fixed command, public-key
   authentication and the single Tailnet listener. It forbids root/password/CA
   authentication, forwarding, TTY, tunnel and user startup/environment files.
5. Validate both syntax and effective settings before starting the new service:

   ```sh
   /usr/sbin/sshd -t -f /etc/ssh/sshd_config_ownbot_fx
   /usr/sbin/sshd -T -f /etc/ssh/sshd_config_ownbot_fx -C user=ownbot-fx-reader,host=beelink,addr=100.122.56.122
   systemctl daemon-reload
   systemctl start ownbot-fx-status.service
   systemctl enable --now ownbot-fx-status.timer ownbot-fx-status-sshd.service
   ```

   No existing sshd is reloaded or restarted. Confirm the new socket binds only
   100.93.82.41:22224 and the snapshot is root:ownbot-fx-reader 0640. Verify that the
   reader cannot read the source receipts or write the snapshot/directory.
6. From Beelink, use the dedicated identity, pinned key, `BatchMode=yes`, strict
   host checking, no agent/config/forwarding/TTY. Confirm `ownbot-fx-status`
   succeeds and `id`, empty command, separators, extra path arguments, SFTP and
   `submit_fx_decision` are rejected by the fixed reader. No broker/order endpoint
   is called by these transport refusal tests.
7. Bind only the authorized Ownbot owner through `OPENBOT_NEXUS_FX_CONFIG`.
   Example structure (all referenced files private, absolute, mode 0600):

   ```json
   {"owners":{"dev-local-user":{"host":"nexus-ops-vps.tail3c3777.ts.net","expectedHost":"nexus-ops-vps.tail3c3777.ts.net","sshUser":"ownbot-fx-reader","port":22224,"identityFile":"/home/viniciuspinho/ownbot-acp-runtime/nexus-fx/id_ed25519","knownHostsFile":"/home/viniciuspinho/ownbot-acp-runtime/nexus-fx/known_hosts"}}}
   ```

   Catalogue tool remains `nexus-fx/status {}`. Keep trading mutation deny rules.
   Missing/broken/stale snapshots never trigger a broader SSH/MCP fallback.

Provisioned on 2026-09-07: new Nexus services and snapshot, plus Beelink private
config `/home/viniciuspinho/ownbot-acp-runtime/nexus-fx-owners.json`. Rollback manifest
is `/opt/backups/ownbot-fx-readonly-20260907T210134Z/new-resources.json` on Nexus.
Ownbot activation still requires its operator to wire that config and grant the
read-only tool. Provisioning alone does not claim this application activation.

Rollback: revoke this dedicated reader key, disable only `ownbot-fx-status.timer`
and `ownbot-fx-status-sshd.service`, and remove the new Ownbot config/grant.
Preserve all trading services/data and the snapshot until operator review.

## Tests

```sh
python3 -B -m unittest discover -s examples/beelink/nexus-fx-read-only/tests -v
```

Fixtures cover source attribution, no source writes, secret projection, stale
quotes, missing/malformed receipts, unmatched decisions, duplicate JSON keys,
bounded tails, symlinks, FIFOs, writable/oversized sources, command rejection,
stale snapshots, future timestamps and failed receipt outcomes. No production
data, credentials, API keys or live broker calls are used in the tests.
