# Pi durable job extension

This directory contains the authored durable-job extension and a narrow patch for the existing Pi runner; it does not vendor the original runner, credentials or dependencies.
Both live workers use identical personal, non-git source at:
`/Users/viniciuspinho/Cluster/pi-runner/src/server.ts`.
Baseline SHA256: `326fb38746d7c2fc617a92c5ab874415d0d10e93487950d5363f13c5daeb2291`.
LaunchAgent on both: `com.viniciuspinho.pi-runner`.

## Compatibility and limits

Existing synchronous `pi_run` is unchanged. New calls use:

```json
{"task":"Create marker.txt with the specified smoke marker", "workspace":"/home/viniciuspinho/pi-smoke/UNIQUE_ID", "tools":["write"], "model":"MODEL_FROM_PI_STATUS", "background":true, "idempotencyKey":"ownbot:UNIQUE_TASK_ID", "timeout_seconds":900}
```

The reply contains `jobId` and `state`. Poll `pi_status({"jobId":"..."})` for
queued/running/completed/failed/interrupted and terminal `result`, including `ok`,
text, diff, stagingPath, runId, duration and tool counts. `pi_status({})` retains
host aggregate data and adds `backgroundJobs:true`.
Use the same idempotency key and identical input on uncertain transport retries.
Changing input under the same key is rejected. A genuinely new task needs a new key.
After restart, queued/running receipts become interrupted; tasks are never replayed
automatically. Review artifacts before deliberately replacing an interrupted task.

A single worker process owns its job directory. Background and synchronous work use
the same existing FIFO semaphore. Receipts are private (directory 0700/files 0600),
atomically renamed and fsynced, with no task text persisted in the receipt. Results
are retained seven days (or configured artifact retention, minimum one day).
Default limits are 64 pending jobs, 1000 receipts and 2 MB per result. Oversized
results fail visibly and remain available as local worker artifacts. A corrupted
receipt cannot be silently replaced and re-executed. Idempotency retention ends
when the terminal receipt expires.

## Symmetric deployment by root

1. Recheck both live source hashes against the baseline above. Stop if they drifted.
2. Confirm both Pi MCP aggregate states have busy=0 and queued=0. These counters do
   not include cmux Pi work; preserve any active cmux model work as well.
3. Back up each `src/server.ts` with a timestamp. Copy `src/durable-jobs.ts` and the
   staged `src/server.ts` to each Mac, retaining all current LaunchAgent settings,
   credentials, model catalogs, concurrency and endpoint configuration.
4. Run `/opt/homebrew/bin/bun run typecheck` in each live worker directory before
   restarting. Optionally copy the staged `tests/` and run `bun test tests` first;
   fixtures use their own temporary server, fake Pi executable and private dirs.
5. Restart each worker via `launchctl kickstart -k gui/$(id -u)/com.viniciuspinho.pi-runner`
   only after the idle checks, then verify authenticated `tools/list`, host
   `pi_status`, and `backgroundJobs:true` on both Tailscale endpoints.
6. Refresh ownbot's Pi MCP tool catalogue before asking Code to use new parameters.
7. Submit one lightweight marker job at a time through ownbot with the exact live
   advertised model. Use dedicated empty Beelink smoke workspace and tools:[write].
   Poll durable status, verify `completed` AND result.ok, then independently read
   the staged marker on Beelink. Verify source smoke workspace was not modified.
   Repeat the same submission key and confirm the same jobId and no additional run.
8. Do not treat HTTP health, catalog listing, a receipt, or a queued state as model
   execution success. A restart receipt test can use the fixture instead of
   interrupting production inference.

Current verified live catalogs (read-only): M4 `omlx-m4` / Nemotron-3-Super-120B-5bit;
M5 `mlx-rdma` / qwen3.8-flash-next. Do not substitute GPT-OSS from older memory.

Rollback: restore the backed-up server file on each Mac and restart only while
idle. Retain jobs/ receipts for review; do not silently remove or replay jobs.

## Evidence

`bun test tests`: 11 pass / 0 fail / 45 assertions. The HTTP integration test
starts real MCP transport with a fake Pi, validates synchronous compatibility,
shared concurrency=1, idempotent submission, completed artifact/diff, process
restart persistence and interrupted state. No model or user data are involved.
`bun run typecheck`: pass.

`server.patch` contains the narrow server changes. `src/durable-jobs.ts` is the new
module, and `tests/` contains unit and protocol integration checks.

Run from this directory: `PI_RUNNER_ROOT=/path/to/original/pi-runner bun test tests`.
The HTTP fixture copies the supplied runner source to a temporary directory and
applies this patch there when the extension is not already installed; it never patches the supplied installation. Without
`PI_RUNNER_ROOT`, only the unit tests run and the integration test is explicitly
skipped. Install dependencies in the original runner before running the fixture.
