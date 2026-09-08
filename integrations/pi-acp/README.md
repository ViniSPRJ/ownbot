# Pi as an Ownbot ACP execution engine

This adapter runs the native Pi CLI in RPC mode. It does not replace Pi with a
chat-completions client. Pi performs the model/tool loop; Ownbot owns roles,
channels, memory, grants, receipts and the surrounding execution lifecycle.

The operator explicitly supplies a local model catalogue. There is no fallback to
hosted providers. Beelink can host the CLI while inference runs on the M4/M5 over
Tailscale. This describes local **inference**, not a promise that every granted
research tool stays offline: web search remains an explicit permitted capability.

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
3. Copy `examples/nemotron-m4.json` and `examples/qwen-m5.json` to the private config
   paths in `examples/profiles-additions.json`, mode0600. Verify endpoint catalogues
   directly from Beelink. On 2026-09-07 they advertised Nemotron-3-Super-120B-5bit and
   qwen3.8-flash-next respectively. Catalog presence is not execution proof.
4. Merge only the `pi-m4` and `pi-m5` entries into the existing operator `profiles`
   object. Preserve the entire `agents` map and every existing provider/model
   selection. Listing optional Pi connections must not migrate any role.
5. Run prompt-free discovery and then a real granted MCP tool roundtrip using each
   profile when the local model is idle. Recheck session resume and permissions.
   The administrator can then choose **Connection → CLI deste agente** for the
   desired role. Existing Codex/Claude/Grok choices remain untouched until selected.

No Pi CLI, model weights, secrets or dependency directories are vendored here.
`examples/` contains config templates, not a claim that production is activated.
The separate `integrations/pi-runner` durable background workers remain supported.

## Validation

`bun test integrations/pi-acp/tests server/tests/acp-permissions.test.ts`
checks RPC framing, local endpoint policy, model selection, session isolation,
permission denial and rollback/cancellation with a fixture CLI.

Opt-in native CLI validation:
`PI_NATIVE_CLI=/path/to/pi bun test integrations/pi-acp/tests/native.test.ts`.
This uses the real Pi executable with a synthetic local model endpoint and the
real Ownbot MCP bridge, verifying that only Ownbot tools are advertised and that
a tool call completes. It performs no inference on the user's local models.

`bunx tsc --noEmit -p integrations/pi-acp/tsconfig.json` checks the adapter/tests.

Primary references verified against installed Pi 0.85.1:
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/environment-variables.md
