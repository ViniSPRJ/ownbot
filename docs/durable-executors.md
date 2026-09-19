# Durable Pi executors

OwnBot tracks background Pi work by wrapping a **submit** tool and polling a
**status** tool. Those names are not inferred from a vendor prefix or from a
tool that happens to be called `pi_run`. They come from an explicit,
machine-independent registry. Executor **ids** are logical; they do not name a
physical host.

The registry is not a CLI runtime. It does not launch Pi, Hermes, Codex, or any
other worker, and it does not translate a foreign protocol into Pi's. A future
Hermes adapter must implement the same durable submit/status contract
(`pi-durable-v1`) before this registry may list it.

Startup loads the registry once from `OWNBOT_DURABLE_EXECUTORS_CONFIG` (wired
by `server/src/index.ts`) and passes the **same instance** to the plugin store
(admission) and the Pi watcher. A changed config file takes a process restart.

## Default mapping

With no config file, the shipped registry is:

| id      | protocol        | submit tool    | status tool       |
| ------- | --------------- | -------------- | ----------------- |
| `pi-m4` | `pi-durable-v1` | `pi-m4/pi_run` | `pi-m4/pi_status` |
| `pi-m5` | `pi-durable-v1` | `pi-m5/pi_run` | `pi-m5/pi_status` |

These ids are logical aliases, independent of any physical machine. A provided
config **replaces** this mapping. It is not merged with the defaults. A generic
worker can keep existing MCP refs by listing them under any logical id.

## Config file

`loadDurableExecutors(configPath?: string)` reads synchronously at startup.
The server passes `process.env.OWNBOT_DURABLE_EXECUTORS_CONFIG`.

- Omitted or empty path → the default mapping above.
- Any other path must be absolute. Relative paths are refused.
- Unreadable files, malformed JSON, and schema failures throw
  `Durable executor configuration is invalid.` The path and file contents are
  not included in the error.

Strict JSON shape:

```json
{
  "version": 1,
  "executors": [
    {
      "id": "lab-worker",
      "protocol": "pi-durable-v1",
      "submitTool": "lab/pi_run",
      "statusTool": "lab/pi_status"
    }
  ]
}
```

A worker that still exposes the shipped MCP names can map them:

```json
{
  "version": 1,
  "executors": [
    {
      "id": "lab-worker",
      "protocol": "pi-durable-v1",
      "submitTool": "pi-m4/pi_run",
      "statusTool": "pi-m4/pi_status"
    }
  ]
}
```

Rules:

- At most 32 executors.
- No extra fields on the document or on an entry.
- `id` is kebab-case lowercase, 1–64 characters (`a-z`, `0-9`, hyphen; no
  leading, trailing, or doubled hyphens).
- `pi-durable-v1` `submitTool` is `vendor/pi_run` and `statusTool` is
  `vendor/pi_status`. Each vendor half is 1–64 characters of letters, digits,
  underscore, or hyphen. Arbitrary method names are a future protocol.
- Submit and status on one entry must be different.
- Ids are unique. Every submit and status ref in the file is unique (no two
  entries share any tool ref).
- Trust is exact registration only. `pi-m4-extra/pi_run`, `other/pi_run`, and
  `pi-m4/PI_RUN` are not the Pi M4 submit tool.

## Admission

Registered **submit** refs require `background:true` and a stable
`idempotencyKey` before vault or network access. The refusal names that entry's
full status ref.

Any **unregistered** ref that ends in `/pi_run` is refused even with a valid
background flag and key. That suffix is a **deny-only** wildcard: it never
admits a tool. Removing a registration must not turn a former durable submit
into an untracked synchronous call.

Other refs (including status tools and names that do not end in `/pi_run`) keep
ordinary MCP semantics.

## API

| Export | Role |
| ------ | ---- |
| `DurableExecutorRegistry` | Immutable lookup: `findById(id)`, `findBySubmitTool(ref)`. |
| `createDurableExecutorRegistry(input)` | Validate `{version:1,executors:[…]}` and freeze it. |
| `DEFAULT_DURABLE_EXECUTORS` | Shared default registry. |
| `loadDurableExecutors(configPath?)` | Startup read; see above. |
| `resolveWatchExecutor(work, registry?)` | Bind a persisted watch record to the live registry, or `undefined`. |
| `createPiWatcher({ executors? })` | Observe and poll using that registry (default: shared defaults). |
| `piRunAdmissionRefusal(ref, args, executors?)` | Refuse sync calls to registered **submit** refs (message names the full status ref) and unregistered `*/pi_run` refs. |
| `createPluginStore({ executors? })` | Same registry, passed through to admission. Grant and policy order is unchanged. |

Returned executor objects are frozen. Mutating the input after construction
does not change lookups.

## Persisted watches

New jobs save `protocolVersion: 1`, `submitTool`, `statusTool`, and
`worker` equal to the executor **id**. The queue kind remains `pi.watch`; the
key remains `piWatchKey(actorId, worker, jobId)`. Origin, authorisation,
checksums, the 12k inline receipt, seven-day retention, and "never resubmit"
are unchanged.

On every sweep, **before** authorisation or a status poll:

- A v1 record must still match the live registry on id, protocol, submit tool,
  and status tool, exactly.
- An explicitly unsupported `protocolVersion` does not resolve, including when
  the payload otherwise looks like a shipped legacy job. It is not treated as
  legacy.
- A legacy record (no new fields) is only `pi-m4` or `pi-m5`, and only when
  that id still maps to the original Pi refs above. A custom id without the v1
  fields is not a legacy record.
- The three new fields are all present or all absent. A partial payload is
  invalid.
- Removed or remapped registrations finish `executor_unavailable` with no
  poll, no wake, and no replay.

`PiWatchWork.statusTool` stays optional so existing callers can still construct
legacy records. Polls and receipt `retrieve.tool` use the **resolved** status
tool. Callers that check grants first resolve the binding with
`resolveWatchExecutor(work, executors)`, refuse when it returns `undefined`,
and check the grant for the returned `statusTool`. Never trust a saved tool
ref before it matches the current registry.
