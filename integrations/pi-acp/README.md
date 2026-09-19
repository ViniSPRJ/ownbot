# Pi as an Ownbot ACP execution engine

This adapter runs the native Pi CLI in RPC mode. It does not replace Pi with a
chat-completions client. Pi performs the model/tool loop; Ownbot owns roles,
channels, memory, grants, receipts and the surrounding execution lifecycle.

The operator explicitly supplies a local model catalogue. There is no fallback to
hosted providers. Beelink can host the CLI while inference runs on catalogued
Tailscale endpoints. This describes local **inference**, not a promise that every
granted research tool stays offline: web search remains an explicit permitted
capability.

## Boundaries

- ACP `initialize`, `session/new`, `session/load`, model selection, text prompting,
  cancellation and streamed text/tool updates are supported.
- Model options come from the operator catalogue and are cross-checked against the
  running Pi CLI. The UI can choose Pi per agent without changing any other role.
- Only the current `ownbot` loopback MCP bridge is accepted. Every tool call gets a
  correlated one-time ACP permission check, then executes through Ownbot's existing
  grant validation and audit path. Native shell/filesystem tools are disabled.
- Pi uses an isolated HOME, agent config and working directory under the existing
  owner/agent/thread/profile namespace. Automatic extensions, skills, context files,
  prompt templates and themes are disabled; only the authored Ownbot extension is
  loaded. No existing user Pi sessions or authentication files are read.
- Inherited provider credentials are scrubbed. `PI_OFFLINE=1` and `PI_TELEMETRY=0`
  disable Pi startup networking/telemetry. Local inference passes through a relay
  that accepts only the selected model's configured Tailnet endpoint. Redirects,
  arbitrary paths, different model IDs and forwarding client credentials are refused.
- Saved session metadata binds the session ID to the operator configuration and
  private namespace. Failed or cancelled prompts restore the prior transcript;
  errors never silently become successful turns or API fallback.
- The first implementation accepts text only. Images, arbitrary ACP filesystem
  operations, native terminals, unmanaged MCP servers and mode changes are refused.

## Installation and operator activation

1. Install pinned native Pi separately from existing tools:
   `npm install --prefix /home/viniciuspinho/ownbot-pi-acp/runtime @earendil-works/pi-coding-agent@0.85.1`.
   Pi requires Node >=22.19.0; Beelink was verified at 22.23.2.
2. Deploy this integration with Ownbot, then install its dependency using
   `bun install --cwd integrations/pi-acp` (or the workspace's matching Zod 4.4.3).
3. Back up any existing private Pi ACP configs (including historical
   `pi-nemotron.json` / `pi-qwen.json`) before replacing them. Copy the current
   templates `examples/qwen-m5-new-q6.json` and `examples/qwen-m5-original-q8.json`
   to the private paths in `examples/profiles-additions.json`, mode 0600.
   `examples/nemotron-m4.json` and `examples/qwen-m5.json` are historical snapshots
   of the previous Nemotron / qwen3.8-flash-next catalog; they are not the current
   deployment templates.
4. Merge only the `pi-m4` and `pi-m5` entries into the existing operator `profiles`
   object. Preserve the entire `agents` map and every existing provider/model
   selection. Listing optional Pi connections must not migrate any role.
   `pi-m4` and `pi-m5` are **legacy profile identifiers** kept for grant, watcher
   and CLI compatibility. They do not name the physical machine: `pi-m4` currently
   points at the M5 novo Q6 catalog, `pi-m5` at the M5 original Q8 catalog.
5. Validate copied JSON against `configSchema` (catalog shape only). Then, when
   each local model is idle, run the opt-in verifier below. Schema-valid templates
   are not execution proof. On 2026-09-17, staged Beelink Q6
   (`qwen38-27b-q6`) and Q8 (`qwen38-27b-q8`) both passed that live path.
   This does not migrate any agent role. The administrator can then choose
   **Connection → CLI deste agente** for the desired role. Existing
   Codex/Claude/Grok choices remain untouched until selected.

No Pi CLI, model weights, secrets or dependency directories are vendored here.
`examples/` contains config templates, not a claim that production is activated.
The separate `integrations/pi-runner` durable background workers remain supported.

## Current catalogue vs legacy profile IDs

| Legacy ID | Private config | Template | Display name | Backend model | Endpoint |
| --- | --- | --- | --- | --- | --- |
| `pi-m4` | `/home/viniciuspinho/ownbot-acp-runtime/pi-qwen38-m5-new-q6.json` | `examples/qwen-m5-new-q6.json` | Qwen 3.8 27B Q6 · M5 novo | `Qwen3.8-27B-oQ6e-mtp` | `http://100.71.224.71:8081/v1` |
| `pi-m5` | `/home/viniciuspinho/ownbot-acp-runtime/pi-qwen38-m5-original-q8.json` | `examples/qwen-m5-original-q8.json` | Qwen 3.8 27B Q8 · M5 original | `qwen3.8-27b-8bit` | `http://100.83.149.120:8080/v1` |

Both current templates use `contextWindow` 65536 and `maxTokens` 8192 as a
conservative pilot. Do not rewrite the `agents` map or Hermes/other provider
selections when merging these profiles. Both catalogues have a staged live
verifier pass; the agent-to-CLI selections remain a separate operator choice.

## Validation

`bun test integrations/pi-acp/tests server/tests/acp-permissions.test.ts`
checks RPC framing, local endpoint policy, model selection, session isolation,
permission denial and rollback/cancellation with a fixture CLI.

Opt-in native CLI validation:
`PI_NATIVE_CLI=/path/to/pi bun test integrations/pi-acp/tests/native.test.ts`.
This uses the real Pi executable with a synthetic local model endpoint and the
real Ownbot MCP bridge, verifying that only Ownbot tools are advertised and that
a tool call completes. It performs no inference on the user's local models.

Opt-in live ACP + native Pi verification against an operator catalogue. It
refuses to run unless `OWNBOT_VERIFY_LOCAL_PI=1`:

```
OWNBOT_VERIFY_LOCAL_PI=1 bun server/scripts/verify-local-pi-acp.ts --config <absolute-config> --model <catalog-id> --timeout-ms 300000
```

`--config` is a required absolute operator Pi ACP JSON path. `--model` is a
required catalogue id from that file (`qwen38-27b-q6` or `qwen38-27b-q8`).
`--timeout-ms` is optional (default 600000, bounds 1000–3600000); 300000 is the
recorded Q6 run.

The verifier creates a temporary isolated session workspace and grants only a
harmless `verify_nonce` MCP helper. It does not open the production database or
any order/trading tools. A pass proves selected-model confirmation, a first real
nonce MCP tool call, subprocess restart with `session/load`, a second real nonce
tool call, and retention of the first nonce in the resumed transcript. It does
not prove model capacity, production activation, or trading readiness.

Recorded 2026-09-17 (staged Beelink):

| Catalogue id | Result |
| --- | --- |
| `qwen38-27b-q6` | Passed: model selected, first real nonce MCP tool call, subprocess restart/`session/load`, second real nonce tool call, first nonce retained; 16.4 s |
| `qwen38-27b-q8` | Passed the same eight checks, including two real tool calls and session resume; 35.1 s. Backend logs confirmed `Qwen3.8-27B-8bit`. |

The original M5 runtime was initially unavailable and subsequently recovered.
These small verification tasks are not a comparative performance benchmark.

`bunx tsc --noEmit -p integrations/pi-acp/tsconfig.json` checks the adapter/tests.

Primary references verified against installed Pi 0.85.1:
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/environment-variables.md
