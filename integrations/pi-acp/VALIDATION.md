# Pi ACP acceptance

## Native CLI and protocol

- Pi CLI installed separately on Beelink at
  `/home/viniciuspinho/ownbot-pi-acp/runtime/node_modules/.bin/pi`: **0.85.1**.
- Node **22.23.2**, Bun **1.4.0** on Beelink.
- Temporary adapter acceptance copy at
  `/home/viniciuspinho/ownbot-pi-acp/adapter`, outside the active Ownbot repository.
- Two private config files (0600): `ownbot-acp-runtime/pi-nemotron.json` and
  `ownbot-acp-runtime/pi-qwen.json`. Existing provider profiles and agent mappings
  have not been changed by this subtask.
- Both prompt-free catalogues passed using the native Pi CLI on Beelink:
  Nemotron-3-Super-120B-5bit (M4) and qwen3.8-flash-next (M5).
- The real Pi executable completed an Ownbot granted MCP echo call against a
  synthetic local inference fixture on both Mac and Beelink. Exactly the granted
  Ownbot tool was advertised, with no native filesystem/shell tools. This fixture
  performs no heavy inference and is not evidence that either actual model ran.
- Nine adapter tests passed, including the opt-in native fixture, and tests for
  actual ACP stdio framing, permission exchange, persistence/resume, model choice,
  denied permissions, transcript rollback and owner/config mismatch.
- Typecheck for the adapter passed. Existing Codex/Claude/Grok permission tests and
  the added Pi permission replay/target/session checks passed.

## Actual model inference

Both actual local models passed from Beelink using native Pi 0.85.1, during idle
inference windows coordinated with the existing cmux tasks:

| Profile | Actual model | ACP session | Result |
| --- | --- | --- | --- |
| `qwen-m5` | `qwen3.8-flash-next` | `824b50a4-f0f1-4c9e-a956-f2088fd74751` | One granted echo, `end_turn`, successful resume |
| `nemotron-m4` | `Nemotron-3-Super-120B-5bit` | `a23519ae-a9e5-4a40-b7ae-f00b20fb1043` | One granted echo, `end_turn`, successful resume |

The acceptance script is
`/home/viniciuspinho/ownbot-pi-acp/acceptance/probe.ts tool`, launched with the
corresponding `OWNBOT_PI_ACP_CONFIG`. Each probe executed exactly one neutral
Ownbot MCP echo through the correlated Pi permission gate, then started a new
adapter process and recovered the previous marker from persisted session history
without another tool call. The final markers were
`OWNBOT_PI_ACP_qwen-m5_OK` and `OWNBOT_PI_ACP_nemotron-m4_OK`.

This proves the direct native Pi adapter, real model, Ownbot tool bridge and
session resume path. Full application activation and UI acceptance are separate:
the probes did not modify production provider profiles, role assignments,
existing cmux sessions or model settings, and did not restart Ownbot.

## Application activation

After those isolated probes, production added optional `pi-m4` and `pi-m5` profiles with
operator-owned private configs. Existing coworker mappings were compared and preserved.
The deployed Connection panel displayed both Pi choices alongside Codex, Claude and Grok;
Onyx retained its selected GPT-5.6-Terra model. The separate durable-worker application
roundtrip is recorded in [Pi worker validation](../pi-runner/VALIDATION.md).
