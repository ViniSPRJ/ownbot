# ownbot ACP runtime

ownbot remains the product and coordinator of record. Role IDs, channel membership,
local transcript ownership, routine scheduling and durable handoff jobs remain in
ownbot. ACP replaces the model execution for explicitly selected built-in agents.
It does not make hosted models local.

Set `OPENBOT_ACP_CONFIG` to an absolute operator-owned JSON file. The file is never
served to the browser. Commands are absolute executable paths with argument arrays;
chat input cannot configure executable paths or environments. Example:

```json
{
  "profiles": {
    "codex": {
      "command": "/opt/ownbot-acp/node_modules/.bin/codex-acp",
      "args": [],
      "workspaceRoot": "/var/lib/ownbot/acp",
      "env": {"INITIAL_AGENT_MODE": "read-only"},
      "timeoutMs": 600000
    }
  },
  "agents": {"coord": "codex", "codeexec": "codex"}
}
```

`OPENBOT_ACP_COORDINATOR=coord` sends unnamed home-page messages to the authorized
coordinator without an API classifier call. Explicit agent choices remain honored.
Unmapped agents retain their current implementation. Private agents keep the private
local model boundary even if erroneously present in the ACP map. A configured ACP
failure never falls back to the API model.

Each owner/role/channel/profile gets a hashed workspace namespace and a private
session cursor. Session/load receives the current per-run MCP bridge. When resume
is unsupported or history no longer contains the cursor, a new session receives
the available ownbot history instead of appending duplicated history to an old one.
Only successful completed turns advance the cursor. A second simultaneous run for
the same namespace is refused. Stop cancels and closes the process transport.

The loopback MCP bridge exposes current granted tools, handoff tools and computer tools routed through the existing gateway. It
uses a random per-run bearer and validates parameters before execution. Existing
ownbot grant checks and audit remain authoritative. Provider-specific MCP permission requests can be allowed once only when correlated
to a current ownbot granted tool call; unrelated native file/terminal/permission requests are rejected. There is no
blanket approval or permission bypass. Codex, Claude and Grok have explicit permission dialects (`provider` in the profile);
no tool is trusted based only on a display title. The Claude dialect was verified
with a real granted-tool call on the authenticated Mac. Grok protocol/MCP HTTP
capabilities were verified, but its granted-tool probe still requires login.

CLIs can have their own native tools, global configuration and sandbox behavior;
ACP client capability flags are not OS sandboxing. Run trusted operator-controlled
CLI installations with scoped credentials/workspaces. Do not give these processes
private-data access merely because transport runs on the local host. Private Crédito
stays outside the hosted CLI route.

Verified adapters during initial integration: codex-acp 1.10.0,
claude-agent-acp 0.75.1; Grok binary 1.0.13. Installation/runtime files are outside
the production repository. Revalidate versions before upgrades.

References: https://agentclientprotocol.com/protocol/v1/initialization ;
https://github.com/agentclientprotocol/codex-acp ;
https://github.com/agentclientprotocol/claude-agent-acp ;
https://github.com/xai-org/grok-build .


Initial Beelink activation maps `coord` and `codeexec` to Codex ACP. Claude and Grok
are installed but remain unmapped until account authentication and a granted-tool
roundtrip pass. This is a partial migration; other public roles keep their existing
runtime. Research/market role migration is not complete merely because adapters
are installed.

Validation includes a real Codex MCP echo call on two consecutive turns across
process restarts, plus tests for session isolation, cancellation, permission replay,
malformed configuration, routing authorization, private boundaries and handoffs.


## Phase 1: preserve the role, replace execution

`examples/beelink/acp-profiles.example.json` is the proposed complete phase-1 map.
It is an operator template, not an automatic migration or an authentication claim.
Activate each provider only after a real tool roundtrip on its target machine.

| Roles | CLI |
| --- | --- |
| coord, codeexec, desk, quant, infra | Codex |
| research, onyx | Claude Code |
| news, mercado | Grok Build |
| credito | Existing private local route; Pi integration is a later phase |

No standing profile, grant, memory shard or routine is rewritten by this map.
The shared prompt composer includes the role and memory, source/provenance rules,
granted-tool descriptions and computer guidance for both API and ACP execution.
Per-run handoff guidance is included in the same composition.

The `model` fields in the tenant YAML describe API routing and are not copied into
CLI profiles. CLI model identifiers belong to their own provider. Leaving the ACP
profile model unset retains the CLI's model selection. An explicit model failure
must not silently select another provider or fall back to API.

The roster and Connection page show the configured execution engine. This is not
an assertion that a CLI is authenticated, alive or has remaining quota. Executable
paths, environments and secrets are never exposed by that DTO.

Pi and the two local models, permanent worker pools and expanded event coordination
are intentionally the next phase. Phase 1 does not install a Buzz relay or replace
the existing ownbot channels, queue, authentication or notification system.
