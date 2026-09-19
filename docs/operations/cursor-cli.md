# Cursor CLI through the shared ACP client

Cursor is supported as `provider: "cursor"` with the absolute `agent` command and
`args: ["acp"]`. Authenticate as the service user before configuring the profile.
Use the CLI's session model catalogue rather than translating model IDs from a
Claude, Grok, or Codex profile. Keep per-conversation directories and retained
history; changing providers intentionally creates a new provider session.

The shared client supplies a per-turn authenticated HTTP MCP bridge. Cursor's
structured `rawInput.providerIdentifier` and `rawInput.toolName` identify calls.
Permission requests are correlated by session and tool-call ID, permit only an
existing Ownbot grant once, and never rely on a displayed title. Native tools
are not automatically approved. Interactive Cursor question/plan extensions
receive an explicit cancelled outcome when there is no interactive handler.

Reducing the operator catalogue to Codex and Cursor does not require deleting
legacy adapters, conversations, or external workers. Keep a private backup of
the old profile configuration for rollback. Local-only privacy routing remains
independent and must not be replaced with a cloud profile.

Before cutover, verify initialize, new/load session, actual granted MCP execution,
model selection, cancellation, and persisted output/notification. A model list or
successful CLI login alone is not an end-to-end validation.
