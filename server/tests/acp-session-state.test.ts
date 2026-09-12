import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, chmod, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  legacySessionKey,
  parseSessionState,
  planSessionAnchor,
  resolveWorkspaceDirectory,
  selectionFromProfile,
  serializeSessionState,
  sessionIdentityKey,
  writeSessionState,
  type AcpSessionState,
} from "../src/acp/session-state";
import type { AcpProfile } from "../src/acp/config";

const profile = (overrides: Partial<AcpProfile> = {}): AcpProfile => ({
  profileId: "codex",
  provider: "codex",
  command: "/opt/ownbot/bin/codex-acp",
  args: [],
  workspaceRoot: "/var/lib/ownbot/acp",
  env: { INITIAL_AGENT_MODE: "read-only" },
  timeoutMs: 600000,
  ...overrides,
});

const identity = { ownerId: "owner-1", agentId: "coord", threadId: "thread-1" };

describe("ACP session identity is independent of selection", () => {
  test("the identity key survives every model and profile change", () => {
    const before = sessionIdentityKey(identity);
    expect(sessionIdentityKey(identity)).toBe(before);
    // The regression: these all used to change the hash, and so the workspace and the anchor.
    for (const other of [
      profile({ model: "gpt-5.1-codex" }),
      profile({ model: "gpt-5.1-codex-mini" }),
      profile({ profileId: "claude", provider: "claude", command: "/opt/ownbot/bin/claude-agent-acp" }),
      profile({ env: { INITIAL_AGENT_MODE: "auto-edit" } }),
      profile({ args: ["--acp"] }),
      profile({ timeoutMs: 900000 }),
    ]) {
      const selection = selectionFromProfile(other);
      expect(sessionIdentityKey(identity)).toBe(before);
      expect(selection.profileId + (selection.model ?? "")).not.toBe("");
    }
  });

  test("owner, bot and thread each move the key", () => {
    const base = sessionIdentityKey(identity);
    expect(sessionIdentityKey({ ...identity, ownerId: "owner-2" })).not.toBe(base);
    expect(sessionIdentityKey({ ...identity, agentId: "news" })).not.toBe(base);
    expect(sessionIdentityKey({ ...identity, threadId: "thread-2" })).not.toBe(base);
  });

  test("the profile selection defaults provider and carries the operator model", () => {
    expect(selectionFromProfile(profile())).toEqual({
      profileId: "codex",
      provider: "codex",
      model: null,
    });
    expect(selectionFromProfile(profile({ model: "m1" })).model).toBe("m1");
  });
});

const state = (overrides: Partial<AcpSessionState> = {}): AcpSessionState => ({
  version: 2,
  sessionId: "session-abc",
  resumable: true,
  // The operator mapped this Bot to a profile without pinning a model, which is the ordinary case.
  selection: { profileId: "codex", provider: "codex", model: null },
  lastMessageId: "msg-9",
  replyMessageIds: ["reply-1", "reply-2"],
  updatedAt: "2026-09-12T12:00:00.000Z",
  ...overrides,
});

describe("reading a stored anchor", () => {
  const current = selectionFromProfile(profile());

  test("a missing record is an ordinary first turn", () => {
    expect(parseSessionState(null, current)).toEqual({
      state: undefined,
      freshReason: undefined,
    });
  });

  test("a v1 record resumes under the current selection instead of being discarded", () => {
    const legacy = JSON.stringify({
      sessionId: "old-session",
      lastMessageId: "msg-5",
      replyMessageId: "reply-old",
      replyMessageIds: ["reply-old", "reply-older"],
    });
    const { state: parsed, freshReason } = parseSessionState(legacy, current);
    expect(freshReason).toBeUndefined();
    expect(parsed?.sessionId).toBe("old-session");
    expect(parsed?.resumable).toBe(true);
    expect(parsed?.selection).toEqual(current);
    expect(parsed?.lastMessageId).toBe("msg-5");
    expect(parsed?.replyMessageIds).toEqual(["reply-old", "reply-older"]);
    expect(parsed?.version).toBe(2);
  });

  test("a v2 record round-trips", () => {
    const written = serializeSessionState(state());
    const { state: parsed, freshReason } = parseSessionState(written, current);
    expect(freshReason).toBeUndefined();
    expect(parsed).toEqual(state());
  });

  test("a corrupt, oversized or foreign record reports why it cannot resume", () => {
    for (const raw of [
      "{not json",
      "[]",
      '"a string"',
      JSON.stringify({ sessionId: 7, lastMessageId: null }),
      JSON.stringify({ version: 2, sessionId: "s", resumable: true, lastMessageId: null }),
      JSON.stringify({
        version: 2,
        sessionId: "s",
        resumable: true,
        lastMessageId: null,
        replyMessageIds: [],
        selection: { profileId: "codex", provider: "not-a-provider", model: null },
      }),
      JSON.stringify({
        version: 2,
        sessionId: "s",
        resumable: true,
        lastMessageId: null,
        replyMessageIds: [],
        selection: { profileId: "codex", provider: "codex" },
      }),
      JSON.stringify({ version: 2, ...state(), transcript: "x".repeat(64 * 1024) }),
    ]) {
      expect(parseSessionState(raw, current).freshReason).toBe("record_unreadable");
      expect(parseSessionState(raw, current).state).toBeUndefined();
    }
  });

  test("an anchor cleared on purpose stays cleared", () => {
    const cleared = state({ sessionId: null, resumable: false });
    const { state: parsed } = parseSessionState(serializeSessionState(cleared), current);
    expect(parsed?.sessionId).toBeNull();
    expect(parsed?.resumable).toBe(false);
  });

  test("a record never carries free-form text beyond identifiers", () => {
    const keys = Object.keys(JSON.parse(serializeSessionState(state()))).sort();
    expect(keys).toEqual([
      "lastMessageId",
      "replyMessageIds",
      "resumable",
      "selection",
      "sessionId",
      "updatedAt",
      "version",
    ]);
  });

  test("a record big enough to be a transcript is refused before it reaches disk", () => {
    expect(() =>
      serializeSessionState(state({ replyMessageIds: Array.from({ length: 4000 }, (_, i) => `reply-${i}`) })),
    ).toThrow(/size limit/);
  });
});

describe("writing the anchor", () => {
  test("owner-only, atomic, and it tightens a world-readable predecessor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ownbot-anchor-"));
    try {
      const file = join(dir, ".ownbot-session.json");
      await writeSessionState(file, state());
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(file, "utf8")).sessionId).toBe("session-abc");

      // A v1 predecessor written 0644 must not survive this write still readable by others.
      await chmod(file, 0o644);
      await writeSessionState(file, state({ sessionId: "session-next", resumable: true }));
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(file, "utf8")).sessionId).toBe("session-next");
      expect((await readdirNames(dir))).toEqual([".ownbot-session.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a failed write leaves the previous anchor intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ownbot-anchor-"));
    try {
      const file = join(dir, ".ownbot-session.json");
      await writeSessionState(file, state());
      // Oversize serializes to a throw, so the rename never happens.
      await expect(
        writeSessionState(
          file,
          state({ replyMessageIds: Array.from({ length: 4000 }, (_, i) => `reply-${i}`) }),
        ),
      ).rejects.toThrow(/size limit/);
      expect(JSON.parse(await readFile(file, "utf8")).sessionId).toBe("session-abc");
      expect((await readdirNames(dir))).toEqual([".ownbot-session.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function readdirNames(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(dir)).sort();
}

describe("planning whether a turn continues a session", () => {
  const selection = selectionFromProfile(profile());
  const messages = [{ id: "msg-1" }, { id: "msg-2" }, { id: "reply-1" }, { id: "msg-9" }, { id: "msg-10" }];
  const support = { messages, selection, loadSupported: true, unreadable: false, restartRequested: false };

  test("the first turn opens a session", () => {
    const plan = planSessionAnchor({ ...support, state: undefined });
    expect(plan.load).toBe(false);
    expect(plan.freshReason).toBe("first_turn");
    expect(plan.fromIndex).toBe(0);
  });

  test("an adapter without loadSession never gets a load", () => {
    const plan = planSessionAnchor({ ...support, loadSupported: false, state: state() });
    expect(plan.load).toBe(false);
    expect(plan.freshReason).toBe("load_unsupported");
  });

  test("a normal continuation loads the anchor and skips what the CLI already has", () => {
    const plan = planSessionAnchor({ ...support, state: state() });
    expect(plan.load).toBe(true);
    expect(plan.sessionId).toBe("session-abc");
    expect(plan.freshReason).toBeUndefined();
    expect(plan.fromIndex).toBe(4);
    expect(plan.previousReplyIds.has("reply-1")).toBe(true);
  });

  test("changing the model moves the session but not the workspace", () => {
    /*
     * The existing invariant, kept: one ACP session answers with one model, so selecting another model
     * mid-conversation opens a session rather than retuning the live one under the person.
     *
     * What the split buys is what this used to throw away: the folder stays put, so the files the last
     * turn wrote and the history ownbot re-seeds into the new session both survive the switch.
     */
    const stored = state({ selection: { ...selection, model: null } });
    const plan = planSessionAnchor({
      ...support,
      selection: { ...selection, model: "gpt-5.1-codex-mini" },
      state: stored,
    });
    expect(plan.load).toBe(false);
    expect(plan.freshReason).toBe("model_changed");
    expect(plan.fromIndex).toBe(0);
    expect(plan.previousReplyIds.size).toBe(0);
    expect(sessionIdentityKey(identity)).toBe(sessionIdentityKey(identity));
  });

  test("changing the provider cannot reuse a foreign anchor", () => {
    const stored = state({ selection: { profileId: "codex", provider: "codex", model: null } });
    const plan = planSessionAnchor({
      ...support,
      selection: selectionFromProfile(profile({ profileId: "claude", provider: "claude" })),
      state: stored,
    });
    expect(plan.load).toBe(false);
    expect(plan.freshReason).toBe("provider_changed");
    // A fresh session has never seen the thread, so nothing may be filtered out of its context.
    expect(plan.previousReplyIds.size).toBe(0);
  });

  test("an anchor whose cursor is gone is dead, not resumed", () => {
    const plan = planSessionAnchor({ ...support, state: state({ lastMessageId: "msg-evicted" }) });
    expect(plan.load).toBe(false);
    expect(plan.freshReason).toBe("anchor_dead");
  });

  test("an unreadable record opens fresh and says so", () => {
    const plan = planSessionAnchor({ ...support, state: undefined, unreadable: true });
    expect(plan.freshReason).toBe("record_unreadable");
  });

  test("a requested restart drops the anchor and resends everything", () => {
    const plan = planSessionAnchor({ ...support, state: state(), restartRequested: true });
    expect(plan.load).toBe(false);
    expect(plan.freshReason).toBe("requested");
    expect(plan.fromIndex).toBe(0);
    expect(plan.previousReplyIds.size).toBe(0);
  });
});

describe("the workspace follows the conversation, not the selection", () => {
  const exists = (directories: Set<string>) => async (directory: string) =>
    directories.has(directory);

  test("a new conversation lands on the identity key", async () => {
    const key = sessionIdentityKey(identity);
    const resolved = await resolveWorkspaceDirectory({
      workspaceRoot: "/var/lib/ownbot/acp",
      identityKey: key,
      legacyKey: "legacy",
      exists: exists(new Set<string>()),
    });
    expect(resolved).toEqual({ directory: `/var/lib/ownbot/acp/${key}`, migrated: false });
  });

  test("a conversation that already has a folder keeps it, anchor and files together", async () => {
    const legacy = legacySessionKey(identity, profile({ model: "gpt-5.1-codex" }));
    const resolved = await resolveWorkspaceDirectory({
      workspaceRoot: "/var/lib/ownbot/acp",
      identityKey: sessionIdentityKey(identity),
      legacyKey: legacy,
      exists: exists(new Set([`/var/lib/ownbot/acp/${legacy}`])),
    });
    expect(resolved.directory).toBe(`/var/lib/ownbot/acp/${legacy}`);
    expect(resolved.migrated).toBe(true);
  });

  test("an existing identity folder wins over any legacy one", async () => {
    const key = sessionIdentityKey(identity);
    const resolved = await resolveWorkspaceDirectory({
      workspaceRoot: "/var/lib/ownbot/acp",
      identityKey: key,
      legacyKey: "legacy",
      exists: exists(new Set([`/var/lib/ownbot/acp/${key}`, "/var/lib/ownbot/acp/legacy"])),
    });
    expect(resolved).toEqual({ directory: `/var/lib/ownbot/acp/${key}`, migrated: false });
  });

  test("the legacy key still moves with the model, which is why it is only ever read", () => {
    const before = legacySessionKey(identity, profile({ model: "gpt-5.1-codex" }));
    const after = legacySessionKey(identity, profile({ model: "gpt-5.1-codex-mini" }));
    expect(before).not.toBe(after);
    expect(sessionIdentityKey(identity)).not.toBe(before);
  });
});
