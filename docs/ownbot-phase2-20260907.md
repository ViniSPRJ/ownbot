# ownbot phase 2 — September 7, 2026 (Brasília)

This record supplements [the initial delivery](ownbot-delivery-20260907.md).
The earlier results and failed runs remain historical evidence.

## Agent execution and completion

The connection selector now exposes Codex, Claude Code, Grok Build, Pi M4 and Pi M5.
The deployed UI was checked without changing any existing agent/provider/model mapping;
Onyx still showed GPT-5.6-Terra. Each coworker retains its own selection, role, memory and
granted tools. Dark mode remains the default; explicit user theme choices are respected.

[Pi ACP](../integrations/pi-acp/VALIDATION.md) passed real native CLI inference, a granted
MCP tool call, process replacement and session resume on both Nemotron M4 and Qwen3.8 M5.
The adapter isolates native Pi from ambient tools and credentials. Only the configured
Tailnet inference target and granted Ownbot tools are available through this integration.
The separate durable Pi workers remain compatible with existing callers.

Accepted background Pi jobs now register a durable watcher. Completion or failure wakes
the original requesting coworker automatically, through the owner-scoped handoff queue.
It checks current permissions, retains the original job ID and does not resubmit the job.
A live browser → Coord → Code → Pi M5 → watcher → Coord acceptance passed with one job,
one status read after Code ended its turn, and one return to the original channel.
See the [worker validation record](../integrations/pi-runner/VALIDATION.md).

Urgent handoffs receive a bounded queue preference; sufficiently old normal work is not
starved. This is queue priority, not cancellation or preemption of an active CLI turn.

## Notifications

Routine notifications remain internal. Optional Web Push now has device controls on the
Notifications page, a service worker and a configured private VAPID identity on Beelink.
The subscription endpoint is authenticated, owner-scoped and protected against cross-origin
writes. Subscription secrets are encrypted at rest; delivery uses an outbox with leases,
bounded retry and explicit handling of revoked devices. The push payload contains only a
generic ownbot notice and an opaque notification reference, never the report or documents.

The live endpoint reports enabled with zero subscribed devices. The Codex in-app browser
correctly reports that push is unsupported; its normal notification inbox works. End-device
receipt has not yet been demonstrated because browser permission requires the user's action.
On iPhone, add ownbot to the Home Screen from Safari, open that installed app, then use
Notificações → Ativar avisos. Permission is requested only after that explicit action.

Existing Qwen and Nemotron cmux/Pi sessions performed implementation and review. Their
models and sessions were preserved. Qwen implemented the device UI and worker tests;
independent review and browser checks supplemented the worker's limited DOM harness.

## Research and read-only operations

The unique morning News routine has a bounded research phase, serialized browser access,
stale-reference protection and reserved final-writing time. Its original request and opinion
requirement stay together; the disabled duplicate and existing schedule are preserved.
ACP output now separates intermediate narration from final text. The second live acceptance
completed in 355.196 seconds; its internal notification was exactly a prefix of the final
report, with no initial narration and no outbound notification row.

That report exposed two editorial failures: a Valor report substituted for an opinion column,
and an older Estadão item was treated as current. Delivery success does not certify source
coverage or factual accuracy. The new `news_record_evidence` tool records sources against
article bodies actually returned during that run, including title, author and literal excerpt.
A Valor report cannot count as a `/opiniao/coluna/` article. Only explicitly labelled, zoned
ISO publication timestamps are machine-certified; other dates remain unverified context.
The evidence table displays the timestamp when available. Missing opinion coverage,
unregistered citations or old/unverified sources registered as current produce
`editorial_coverage_incomplete`, with the draft preserved in the run ledger and inbox.
Editorial incompleteness neither retries the run nor triggers the infrastructure fatigue rule.

This is a conservative source-registration check, not a semantic fact checker. The run ledger,
inbox and channel preview carry its qualification; previously streamed conversation messages
and intermediate handoffs are not rewritten or retrospectively certified. The live v2 report
was replayed through the guard and rejected without altering its retained history.

Nexus FX's read-only exporter now recognizes valid historical blocked-before-gateway
receipts while continuing to reject malformed records. Live quote validity and the age of
the last decision receipt are reported separately; no trading flags, orders or receipts were
changed to make status appear healthy. Onyx identity linkage and model choice are unchanged.

## Verification and deployment

The broad run passed 1,896 server tests, 212 app tests and 295 other tests, with 27 explicit
skips and no failures. Tests used a disposable database, not production. After ACP output
segmentation changed, 69 focused tests with 323 assertions passed. The final push worker
checks passed six tests with 93 assertions, and the Beelink UI build/typecheck passed.
Thirteen Python exporter tests and the Pi native/live acceptance checks also passed. The
final editorial change passed 128 focused and database integration tests plus server typecheck.

Source, profiles, Postgres, SQLite history and UI backups were retained before deployment,
including backup-delivery-20260908T000355Z. The original repository remains configured as
upstream, and the fork's beelink-local branch receives the reviewed changes. Credentials,
private configuration and dependency links are excluded from source control.

This phase does not make hosted CLI inference local: Codex, Claude and Grok retain their
selected vendor connections. Pi and Crédito use local models. Web research remains enabled.
There is no generic infrastructure-remediation or trading-execution authority added here.
The retained old exhausted Desk handoff still degrades queue readiness; current services,
database, scheduler, notifications, history and runs passed their checks with no active stuck work.
