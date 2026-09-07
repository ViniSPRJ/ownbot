# ownbot delivery — 2026-09-07

Dark mode is the default before the first paint. An explicit saved light preference and the
theme toggle remain available.

## Agent connections

Each mapped coworker keeps its standing role, grants, memory, channel and routine identity.
In Agents → Connection, choose its installed CLI and then its model. Two coworkers using
Codex can select different models. Saving the same CLI preserves that coworker’s model;
changing CLI selects the new connection’s default until a model is selected. The next
turn uses the new selection; an active turn retains the connection it started with.

Codex, Claude Code and Grok Build use authenticated native CLIs through ACP. Failure
stays visible and does not silently fall back to an API runtime. Model catalogues come
from the CLI’s ACP session. Commands, environments and credentials remain operator-owned.
Crédito keeps its separate private local runtime. Other current user-selected mappings
are preserved; Onyx retrieval does not constrain its coworker’s model.

## Local workers

The existing Pi sessions performed implementation and review during this delivery:
Qwen3.8 on M5 implemented a regression test; Nemotron on M4 reviewed ACP isolation,
permissions and cancellation. Read [Pi integration](../integrations/pi-runner/README.md)
and its validation record for the deployed durable worker protocol and evidence.

The ownbot path uses background jobs, stable idempotency keys and persisted receipts.
Poll the returned job ID; acceptance alone is not completion. Results, diffs and artifacts
must be verified before applying changes. Restarted unfinished jobs become interrupted,
not successful or automatically duplicated. Existing synchronous worker consumers remain
compatible. Both workers keep their existing model and concurrency configuration.

## Retrieval and operations

[Onyx](onyx-integration.md) has one actor-scoped read tool; normal ownbot login resolves
the explicitly linked Onyx identity. [Nexus FX](nexus-fx-integration.md) has one fixed
read-only snapshot tool through a dedicated SSH listener. It cannot submit decisions,
execute arbitrary commands or alter trading flags. Snapshot freshness, quote validity and
receipt persistence are separate facts. The current receipt source is codex-fx.

The routine page now includes handoff queue readiness, including expired leases and
exhausted attempts. Historical exhausted work can keep this check degraded until retention
or explicit resolution; a healthy scheduler alone is insufficient. A routine reaching its
deadline records that cause instead of generic ACP cancellation. The News routine observed
during validation researched actively until its existing eight-minute deadline. Its failure
receipt remains history; the delivery does not relabel it as successful or retry it silently.

Persistent personal instructions remain owner-scoped in local Postgres and survive channel
clears and service restarts. Local SQLite stores conversation history. The existing morning
News routine remains unified, including the opinion request; its previous duplicate remains
disabled. Internal notification receipts accompany completed routine runs. Event ingestion
exists through the authenticated, idempotent routine-events API; no unrequested external
webhook subscription is created by this delivery.

## Local-operation boundary

This is not yet a claim of 100% local inference: Codex, Claude and Grok selected here still
use their vendors. Pi and Crédito use the local models. Search remains available, and
retrieved private text reaches the model chosen for that coworker. History, memory and
internal notifications use the self-hosted services. Moving all inference local is a separate
provider choice, not implied merely by using ACP or self-hosting the UI.

No generic infrastructure remediation or trading execution authority was introduced.

## Verification

Combined suite: 2,384 passed, 26 explicitly skipped, zero failed (2,410 cases).
The test database was isolated from production. After the final theme change, its seven
existing tests, application typecheck and Beelink-branded build passed. Server typecheck,
13 Python boundary/exporter tests and the real two-Mac Pi validations also passed.
