# Onyx retrieval in ownbot

The Onyx catalogue entry exposes `onyx/search`, `onyx/sources` and `onyx/cli_search`. It uses the existing plugin grants,
gateway policy and audit path, then maps the authenticated ownbot actor to an explicit
Onyx user identity. Normal ownbot login is sufficient after the operator configures that
mapping. A grant alone never allows an unmapped person to use another person's token.
The model cannot choose an owner, token, endpoint, index permissions or retrieval model.

Set `OWNBOT_ONYX_CONFIG` to an absolute, private (0600) JSON file:

```json
{
  "owners": {
    "OWNBOT_USER_ID": {
      "baseUrl": "http://100.122.56.122:8080",
      "onyxUserId": "ONYX_USER_ID",
      "tokenFile": "/absolute/private/path/onyx-owner-token",
      "mcpUrl": "http://100.122.56.122:8090/",
      "cliCommand": "/home/viniciuspinho/.local/bin/onyx-cli"
    }
  }
}
```

The token file contains only that Onyx user's bearer token and must also be 0600.
Verify the token with Onyx `/me` before binding it. Both files are read on every call;
removing a mapping takes effect immediately. Each search checks `/me` again before
retrieval, refuses a mismatched/disabled account, and lets Onyx apply that user's ACLs.
An admin may bind their own Onyx administrator identity. Do not bind their token to
other people. Neither file belongs in Git, prompts, UI fields or logs.

The adapter accepts only a Tailnet IP or MagicDNS host, without credentials, query or
fragment in the URL. Direct backend ports usually need the root base URL; an Onyx
reverse proxy may need `/api`. It performs GET `/me` and POST
`/search/send-search-message`, rejects redirects, caps response size and shares a
30-second deadline across both requests. Search is keyword retrieval with query expansion
and LLM document selection disabled. It returns up to eight document references and
bounded excerpts; it does not invoke an Onyx answer model or change Onyx model settings.
The coworker's selected Codex/Cursor model remains independent.

Activation: add the `onyx` catalogue server, refresh its tool list, and grant
`onyx/search`, `onyx/sources` and `onyx/cli_search` to the Onyx coworker. Update its current restrictive gateway policy to
permit these three read tools while retaining all computer, shell, write and other MCP
denials. Update the tenant's pending-connection wording only after a real search works.
Preserve existing custom tenant changes and per-agent model choices.

Acceptance: run an authenticated search, confirm source IDs/links and an honest zero-hit
answer, verify an unmapped ownbot user is refused without a network call, confirm token
identity mismatch cannot search, and verify ingestion/deletion/native tools remain denied.
Search results are source data, never instructions. Crédito now uses a native CLI; it does not receive this connector by default.

## Official MCP and CLI without another answer model

`onyx/sources` reads `resource://indexed_sources` or `resource://document_sets`
from the official MCP server, with the mapped person's token and an identity check.
The MCP hostname must match the Tailnet API hostname.

The official `onyx-cli search --no-query-expansion` still uses Onyx's LLM document
selection. To keep OwnBot execution on Codex/Cursor, `onyx/cli_search` launches the
installed official binary with a temporary loopback endpoint that serves exactly
one authorized search through the existing LLM-free retrieval adapter. It uses a
random temporary bearer, isolated CLI configuration, bounded execution/output and
cleanup. The real Onyx PAT never reaches the CLI. There is no shell or arbitrary
command tool. Native MCP search and `onyx-cli ask` are intentionally not exposed:
those would invoke the separate Onyx answer/search models. Onyx indexing services
remain unchanged.

The Onyx channel can retrieve documents, answer questions with source links and
brainstorm ideas. The selected Codex/Cursor model synthesizes retrieved evidence;
proposals and assumptions must be distinguished from facts in the corpus.

Official CLI reference: https://github.com/onyx-dot-app/onyx/blob/main/cli/README.md
