# OwnBot CLI runtime

Beelink uses **Codex CLI and Cursor CLI** for every Bot. OwnBot retains roles,
channel membership, history, memory, grants, routines and handoffs. A remote AG-UI
Bot mapped to ACP keeps its profile but no longer calls its former endpoint.

Set `OWNBOT_ACP_CONFIG` to an absolute operator-owned JSON file. The deployment
example is `examples/beelink/acp-profiles.example.json`. Set `cliOnly: true` and
`defaultProfile: "codex"`: every existing or newly created Bot inherits that
connection unless its `agents` entry chooses another installed connection. In this
mode only `codex` and `cursor` providers are accepted, and a nonempty
`OWNBOT_PRIVATE_AGENT_IDS` is rejected. Remove the old local-model mapping before
activation. A configured CLI failure never falls back to an API or local model.

`OWNBOT_ACP_COORDINATOR=coord` routes unnamed home-page messages to the authorized
coordinator without an API classifier. Tenant YAML `model` fields are legacy API
metadata; the ACP file and the CLI's authenticated catalogue select execution.
Beelink's legacy AG-UI containers are opt-in under Compose profile `legacy-bots`.
This does not stop model services used by other projects.

Each owner/role/channel/profile gets a hashed workspace namespace and a private
session cursor. Successful turns advance the cursor; interrupted turns do not.
When resume is unsupported, a fresh session receives the available OwnBot history.
Changing a connection or model starts a new CLI session without deleting history.
Active work retains the connection snapshot with which it started.

The per-run MCP bridge exposes only granted tools and existing computer/handoff
capabilities. It uses a random bearer. Native permission requests must correlate
to a current granted OwnBot call; display titles alone never authorize access.
The executable, arguments, environments and workspace roots remain operator-owned.
CLI installation, account authentication and quota require actual roundtrip tests;
a selector or health endpoint alone does not prove readiness.

## Conversation model choices

Channel members can select a model for one Bot in that conversation. Administrators
who are not members cannot read or change that choice. Membership and connection
revision are checked again after asynchronous model discovery before saving.

Conversation choices use a canonical fingerprint of that Bot's effective profile
(including command, environment and default model). Editing a different Bot or
reformatting JSON leaves them valid. Editing the same effective connection
invalidates the old choice. Administrative configuration edits still compare the
whole-file revision to prevent lost updates.

When upgrading from the previous whole-file conversation revision, migrate only
rows matching the current old file hash whose effective profile is unchanged.
Never reactivate already stale choices; preserve their history for the audit trail.

## Independent model selection per agent

In the agent dialog, **Connection → Modelo deste agente** lets the administrator
choose from the models advertised by the authenticated CLI. Listing creates a
short, prompt-free ACP session with no MCP tools. The selector prefers the ACP
`configOptions` model category and retains compatibility with legacy `models`.
Execution applies the choice before prompting, using `session/set_config_option`
(and checking its acknowledgement) or legacy `session/set_model`.

Two roles can share an executable/account while choosing different models:

```json
"agents": {
  "coord": { "profile": "codex", "model": "MODEL_ID_FROM_THE_CLI" },
  "quant": { "profile": "codex", "model": "ANOTHER_MODEL_ID_FROM_THE_CLI" },
  "desk": "codex"
}
```

These IDs are illustrative; the UI uses the actual CLI catalogue, not the API
model names from `agents.yaml`. Selecting **Padrão da conexão** removes the
per-agent override and inherits the profile's configured model or the CLI default.
Changes affect subsequent chat, handoff and routine runs; active work keeps its
original selection. A model change creates a fresh isolated CLI session with the
available ownbot history; it does not delete the channel or agent memory.

The Beelink model endpoint atomically updates only the selected agent mapping in
`OWNBOT_ACP_CONFIG` (0600 file). Keep this operator file in deployment backups.
A revision check rejects stale browser edits. The browser cannot change commands,
environments, accounts, provider mappings, permissions or executable paths.
The catalogue is cached for up to 60 seconds; a CLI/login failure never substitutes
an invented list or silently selects an API model.

Protocol reference: https://agentclientprotocol.com/protocol/v1/session-config-options
