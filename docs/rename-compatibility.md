# OwnBot naming and compatibility

OwnBot is the product name. Source and package identifiers use `ownbot`, configuration uses
`OWNBOT_*`, and the maintained source repository is [ViniSPRJ/ownbot](https://github.com/ViniSPRJ/ownbot).
The project derives from [CopilotKit OpenBot](https://github.com/CopilotKit/OpenBot); upstream URLs,
licenses and dated operational records retain their original identity.

## Existing deployments

An `OPENBOT_*` environment variable remains a compatibility alias if the matching `OWNBOT_*`
variable is absent. When both are set, the current name wins, even if its value is empty.
Update operator configuration gradually; preserve authentication keys, persistent databases,
computer volumes, browser profiles, workspace roots and ACP session directories.

The example fintech package retains its persisted tenant id `openbot`; its display name is OwnBot.

The existing local administrator identity `dev@openbot.local` remains valid. Renaming the product
does not create another account or move the account's bots, conversations and documents.

Existing service, database and volume names are deployment identities, not display branding.
Do not delete or recreate an `openbot` resource merely to remove its old name. Use explicit
configuration or a compatibility alias while moving a deployment to the current naming, and
verify that it reaches the same stored data before removing an old alias.

## Browser preferences and conversations

The app writes new browser preferences under `ownbot-theme`, `ownbot-sidebar`,
`ownbot.workspace-mode`, `ownbot.cowork-coworkers` and `ownbot.bot-thread.<agentId>`.
When a new key is absent, it reads the corresponding `openbot` key. This keeps the selected
appearance, sidebar state, coworker grouping and remembered conversation available after an
upgrade. Existing keys are retained, and an explicitly stored new value takes precedence.

## References and images

Links to `CopilotKit/OpenBot`, `copilotkit.ai/openbot` and upstream container artifacts still name
their original publisher. They are not OwnBot release artifacts. Use the configured registry and
verified release manifest for a deployment; replacing a name in an external URL does not publish
an image there. Dated review and delivery reports preserve the paths and service names that were
used at the time.

## Helm upgrades from the old chart

The chart now lives at `charts/ownbot`. For an existing release, keep its release name and
namespace, set `nameOverride=openbot`, and preserve any existing `fullnameOverride`.
This keeps component names and selectors derived from the old chart name. Preserve the current
`database.*`, `postgresql.auth.*`, storage and secret values. The bundled database default remains
`openbot`. Render the upgrade with the saved values and compare resource names, selectors and
volume claims with the installed manifests before applying it. A new release can use OwnBot names.
Do not uninstall the existing release to rename it.

## Persisted protocol and infrastructure names

The PostgreSQL table `openbot_service_health`, notification channel `openbot_work_offered`, audit
setting `openbot.audit_retention_days` and signed-run context `openbot:agent-run` remain unchanged.
The supervisor namespace and `openbot.*` ownership labels continue identifying existing browser
containers and volumes; SPIRE retains its `openbot.local` trust domain. Development-token defaults
are retained so upgrading does not rotate credentials. New peer headers use `x-ownbot-*`, while
legacy headers remain compatible; conflicting identity/token aliases are rejected.
