# Recovery and execution boundaries

## Handoffs

The delivery adapter calls `admit` after history/agent/lock preflight and immediately before starting the run. This atomically stores `_deliveryStartedAt` under the queue lease. A later claimant must not rerun an admitted item. Completion and return enqueue remain one transaction.

Failure after admission, including a failed completion write, is an **unknown outcome**, not a retryable failure. Unknown items remain retained, visible in the audit, and degrade `/ready` until reconciled. The retention sweep does not delete them. Loss or failure of queue/thread renewal aborts the agent and requests runner stop. Cancellation cannot undo an external effect. This is at-most-once admission, not an exactly-once external-effects guarantee.

Before restarting an old deployment, inspect previously attempted pending handoffs: older code did not record admission. Reconcile or quarantine these explicitly with an append-only audit record. Do not send the same task to another bot merely because a previous result is missing. For a confirmed outcome, record supporting receipt IDs in the audit and in `payload.result`; only then replace `outcome=unknown` with a reconciled disposition. Do not manufacture a receipt or clear degradation merely to make health green.

## Routines and readiness

Cron occurrences expire after ten minutes, including durable rows recovered after dispatch failure. The execution runner checks the scheduled timestamp after atomic claim and before invoking tools. Event/manual rows with no scheduled timestamp retain their existing semantics.

The worker and `/ready` use the same abandoned-run policy: max(10 minutes, configured turn timeout + 2 minutes). Running age is measured from `claimed_at`, not row insertion. A 25-minute configured turn therefore has a 27-minute abandoned bound. `/health` is only liveness.

## Beelink recovery

1. Stop server and worker before restoring a database; otherwise stale queues may run immediately.
2. Back up the stopped PostgreSQL volume, SQLite with its backup API, local source changes and service configuration.
3. Start only PostgreSQL, inspect queues and reconcile legacy ambiguous work.
4. Deploy tested source, then start server and worker. Inspect `/ready`, durable run/audit records and actual receipts.
5. Keep PostgreSQL `restart: unless-stopped`; intentionally stopped containers remain stopped. Do not start retired containers as part of recovery.

Internal notifications are the configured production delivery path. External notifier delivery is not proven idempotent; keep it disabled until the receiver supports stable idempotency keys or ambiguous sends are quarantined. No external test messages are necessary for this recovery.

## Remaining isolation boundary

ACP protocol filtering is not an OS sandbox. On the current Beelink deployment ACP children still share the service UID. Profiles containing sensitive configuration must remain mode 0600; saving model selections already writes mode 0600 atomically. A separate UID/container, dedicated HOME, credential allowlist, filesystem policy and real provider-authentication tests are required before giving this runtime critical execution authority.

Hermes on Arcus remains a research process with root service identity; moving identity or restricting mounts requires a dedicated staged migration of its HOME, credentials and cron workflows. This patch does not claim that boundary is solved. Do not install a second OpenBot there or transfer FX execution on the basis of these tests.

FX execution remains exclusively on Nexus through the isolated runner/Gateway/signed cTrader path. OpenBot's Nexus adapter remains read-only. Viable next stage: isolated OpenBot coordination and Hermes research, shadow validation, then reviewed promotion; no broker-order authority is added here.

## Computer dependency recovery (2026-09-17)

The Beelink shared computer is a required dependency of News. `ROUTINE_COMPUTER_REQUIRED_AGENTS` is a comma-separated list, default `news`; preflight records a failed run and its ordinary internal receipt before spending a model turn when this dependency is unavailable. Other routines retain their existing behavior. Readiness adds a `computer` check when a provider is configured, without calling ensure/locate or starting a browser. Shared status verifies both public health and the authenticated read-only computer listing.

Transport failures report unverified reachability, timeout or cancellation rather than asserting a stopped machine. Headless tools return structured dependency failures; a 30-second bounded circuit suppresses repeated calls against the same bot/owner dependency. It does not replay actions or bypass policy. Individual page failures do not trip this circuit. News preserves its partial draft if the computer fails mid-turn, while recording `infrastructure_computer_unavailable` instead of hiding the failure behind editorial validation. Existing run admission and the unique internal receipt remain the deduplication boundary; notifying another LLM is not required.

The Beelink headed-browser entrypoint uses `Xvfb -displayfd` instead of a fixed display and sleep. A stale X lock in the container's writable layer cannot prevent the next start. It waits for display allocation, watches Xvfb/VNC/websockify, forwards shutdown to Bun, and exits on dependency failure. Docker uses `init: true` and `restart: unless-stopped`. `/health` returns 503 when the headed display socket is unavailable. The socket probe is not proof of article access: always test navigation and reading through the News gateway, including login/paywall outcomes, before declaring coverage restored.

Recovery never replays the morning briefing or resolves old unknown handoffs automatically. Do not change the provider to the coordinator's independently running container as a shortcut; preserve the configured endpoint, profiles, workspace, policy and grants.
