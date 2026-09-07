# Beelink coworker operations

The product keeps one coordinator and the existing durable work queue. Bot messages already wake workers through PostgreSQL LISTEN/NOTIFY. A received job is not a completed task: `message_bot` returns a stable job ID, recipient output and return are committed together, and `handoff_status` exposes the saved answer and relay state only to the original actor/bot/conversation. No active tool is preempted. Work-queue records have finite retention; this is not a permanent project archive.

## Personal agent memory

Open a coworker, Manage coworker → Memória. Save standing instructions and reference notes (6,000 characters each). Memory is stored in Postgres by user+agent independently of channel history. Empty fields clear current context. Revision checks reject stale browser edits. Memory is loaded afresh for interactive and headless turns; it cannot grant tools, prove completion or authorize an action. No model-facing memory write tool is provided. Neither quoted examples nor model guesses are automatically saved as standing orders.

GET/PUT `/api/agent-memory/:agentId` use normal user authentication and bot visibility. PUT body: `{standingInstructions,notes,expectedRevision}`. A new document has expectedRevision0; stale writes return409. A public coworker does not share personal memories between users.

## Events and health

`POST /api/routine-events/:routineId` takes `{eventId,evidence}` using the routine owner's authenticated session. IDs are stable strings of1–160 safe characters, evidence at most4,000 characters. Treat evidence as data, not instructions. First offer returns202 and an execution link; identical replay returns200 with the same run. Different evidence for an existing event ID returns409. Disabled routines refuse new offers, other owners get404, and10 unfinished events per routine limits admission. Cron timestamps do not change.

This endpoint is an event ingestion primitive, not a configured Slack/GitHub/Nexus listener. External adapters must verify provider signatures, map to the correct owner/routine and preserve stable delivery IDs. Never expose an unauthenticated webhook or put credentials in event evidence. In single-user mode, Tailnet access is the application's existing authentication perimeter; do not expose this instance publicly.

The routines page polls the authenticated `/api/operations/health` projection of `/ready` every30seconds and shows missing scheduler/notifier heartbeats, pending work and database/history availability. Healthy infrastructure does not prove that every model or source can answer.

## Infra, Onyx and FX

See the tenant's READ-ONLY-COWORKERS.md. Apply the gateway deny rule before creating the coworkers, then grant Infra only status/health/disk. Computer/shell and other MCP actions remain blocked. Preserve existing unrelated agents' policies. Onyx remains visibly pending until a read-only search connector with appropriate user ACLs exists. FX receipt interpretation is research only; no trading mutations are granted and no live receipt feed is implied.

## Runtime and maintenance

`OPENBOT_SELF_HOSTED=true` already selects local SQLite history and SSE without requiring Intelligence configuration. Model providers, MCP endpoints and optional UI licensing remain separate dependencies. Set `COPILOTKIT_TELEMETRY_DISABLED=true` and `DO_NOT_TRACK=1` in server/worker environment to disable the installed runtime telemetry client; that does not turn external models or tools into local services.

Keep upstream as the source reference and the Beelink tenant as the maintained deployment package. Review updates against the deployed commit, run isolated migration/queue/memory tests, build the static UI and take verified Postgres+SQLite backups before changing services. Do not change coordinator ownership or publish a repository as a side effect of an upstream update. A remote private fork and external supervisor integration are separate deployment choices.
