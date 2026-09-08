# Beelink Pi delivery — 2026-09-07

Installed symmetrically on the M4 and M5 over Tailscale. Existing model and launchd
configuration was retained. Only the independent `pi-runner` daemons were restarted;
the cmux Pi processes remained running.

| File | SHA256 on both Macs |
| --- | --- |
| src/server.ts | 563ca78c4e1baf4069a7251a54dfc080bb4aa2d3d273db49b4d942ac7fe85ecd |
| src/durable-jobs.ts | 74c05a3a20c61b119b9a12df86f9d2f368d4cbce6ad79f99434f185d0197ac1a |

Source backups in `/Users/viniciuspinho/Cluster/pi-runner/src/`:
M4 `server.ts.before-durable-20260907T205936Z`;
M5 `server.ts.before-durable-20260907T205934Z`.
Both typechecks passed before restart. Both authenticated Pi endpoints advertised
`backgroundJobs:true` after restart, with their previous model catalogs intact.

## M4 real model smoke

- Model: Nemotron-3-Super-120B-5bit, provider omlx-m4.
- Job: `8305b58ae70b2df4c6e62ac1612c0a12`.
- Duplicate submission returned the same job ID.
- Completed with `ok:true`, one write tool, zero tool errors, 19.7 seconds.
- Independent Beelink artifact verification:
  `/home/viniciuspinho/pi-staging/8305b58ae70b2df4c6e62ac1612c0a12/marker.txt`.
- SHA256: `4439174daff50265a7146a1c83f25d514f1cd806db8efa74f51c9b7fb5cc4797`.
- Source workspace `/home/viniciuspinho/pi-smoke/m4-20260907T2100` stayed empty.
- The model produced the correct marker but omitted the requested trailing newline.
- Result and diff remained available through authenticated `pi_status({jobId})`
  after a real worker restart.
- Receipt directory 0700, receipt and local artifact 0600, remote staging directory
  0700. Remote staging permission was tightened after the first smoke inspection.

## M5 real model smoke

The smoke was submitted after the existing Qwen cmux task finished naturally.
No model switch or interruption was performed.

- Model: qwen3.8-flash-next, provider mlx-rdma.
- Job: `7e8700f1d4bff8a8eca36afc07aabed8`.
- Immediate duplicate and a second duplicate after completion returned the same
  job ID without re-execution.
- Completed with `ok:true`, one write tool, zero tool errors, 8.8 seconds.
- Independent Beelink artifact verification:
  `/home/viniciuspinho/pi-staging/7e8700f1d4bff8a8eca36afc07aabed8/marker.txt`.
- SHA256: `1666f4657e460b064a29a46bd68309a0d7945d4a9ddad3eaacb94bd5a8d16773`.
- Exact marker plus newline verified; original smoke workspace stayed empty.
- Remote staging directory 0700 and marker file 0600 verified.

The smoke tests above are authenticated direct-MCP worker roundtrips. They prove
local execution, receipts, staging and idempotency.

## Ownbot automatic completion E2E — 2026-09-08 UTC

The deployed Ownbot application accepted a browser request in synthetic channel
`channel_382ea377-b7c1-41e7-802f-7cb4f9f409c4`. Coord delegated to Code at urgent
priority; Code submitted one `pi-m5/pi_run` with `background:true`, `tools:[]`,
idempotency key `ownbot-auto-wake-20260908-v1` and a neutral marker prompt.

- Job `4451db694db262ed77ec4d0d2af0ab8d` completed on qwen3.8-flash-next in 2680 ms:
  `ok:true`, `toolCalls:0`, no changed/deleted files, text `OWNBOT_PI_AUTO_WAKE_OK`.
- Audit records show one `pi_run` at 00:07:08.876Z. Code finished at 00:07:16.338Z.
  The sole `pi_status` occurred afterward at 00:07:23.776Z through the watcher;
  Code did not poll during its turn.
- `pi.watch` key
  `9f367134073e250ba1ab60beccfb0df5c720564b7c053a18ee978ff62f992127`
  finished at 00:07:23.780Z with state `completed`, one attempt, no error.
- Exactly one `bot.message` with the matching `pi-return:` key finished at
  00:07:34.898Z, one attempt, no error. It returned to the requesting thread
  `e712a02b-83a6-8c08-a70c-ca04c3e0a250`.
- Coord's final persisted message reports the marker, `completed` and the correct
  job ID. Its run `9a4c441e-9eb6-4da0-b4dd-d69fbfc121af` has `RUN_FINISHED`.

This acceptance covers browser request → Coord → Code → local Pi background job →
durable watcher → automatic Coord wake → persisted answer in the original channel.
It did not require another prompt, manual polling, model changes or service restart.
