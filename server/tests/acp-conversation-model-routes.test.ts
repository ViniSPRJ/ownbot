import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpModelSelectionFor } from "../src/acp/config";
import { createAcpConversationModelRoutes } from "../src/acp/conversation-model-routes";
import type { ConversationModelStore } from "../src/acp/conversation-models";
import {
  createConversationModelStore,
  resolveConversationModel,
} from "../src/acp/conversation-models";

const original = {
  config: process.env.OPENBOT_ACP_CONFIG,
  private: process.env.OPENBOT_PRIVATE_AGENT_IDS,
};
let root: string;

afterEach(() => {
  for (const [key, value] of [
    ["OPENBOT_ACP_CONFIG", original.config],
    ["OPENBOT_PRIVATE_AGENT_IDS", original.private],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

/** A store that keeps one selection in memory, which is all the route needs to be honest about. */
function fakeStore(input: {
  member?: boolean;
  stored?: ConversationModelSelection | null;
}): { store: ConversationModelStore; writes: unknown[]; cleared: unknown[] } {
  let stored = input.stored ?? null;
  const writes: unknown[] = [];
  const cleared: unknown[] = [];
  return {
    writes,
    cleared,
    store: {
      channelForThread: async () =>
        input.member === false ? undefined : { channelId: "chan-1" },
      get: async () => stored ?? undefined,
      set: async (selection, selectedBy) => {
        writes.push({ selection, selectedBy });
        stored = selection;
      },
      clear: async (threadId, agentId) => {
        cleared.push({ threadId, agentId });
        stored = null;
      },
    },
  };
}

function setup(
  input: {
    role?: "admin" | "user";
    member?: boolean;
    /** Chosen by the person in this conversation. Built after the config exists, so its revision is live. */
    storedModel?: string | null;
    storedRevision?: string;
    discoveryFails?: boolean;
    catalogModels?: { id: string; name: string }[];
    /** Session rows the trail returns, newest first, as the reader orders them. */
    sessionEvents?: {
      eventType: string;
      payload: Record<string, unknown>;
      createdAt: string;
    }[];
    sessionReadFails?: boolean;
  } = {},
) {
  root = mkdtempSync(join(tmpdir(), "acp-conversation-models-"));
  const file = join(root, "profiles.json");
  writeFileSync(
    file,
    JSON.stringify({
      profiles: {
        codex: {
          command: "/secret/cli",
          workspaceRoot: root,
          env: { TOKEN: "hidden" },
        },
      },
      agents: { coord: "codex", credito: "codex" },
    }),
  );
  process.env.OPENBOT_ACP_CONFIG = file;
  process.env.OPENBOT_PRIVATE_AGENT_IDS = "credito";
  // Only now can a revision exist: the file has to be on disk and named by the environment first.
  const stored =
    input.storedModel === undefined
      ? null
      : selection({
          model: input.storedModel,
          operatorRevision:
            input.storedRevision ?? acpModelSelectionFor("coord")!.revision,
        });
  const fake = fakeStore({ member: input.member, stored });
  const audits: Record<string, unknown>[] = [];
  // Bound to a name first: `async () => { ... } as never` inline is not something this transpiler parses.
  const discover = async () => {
    if (input.discoveryFails) throw new Error("secret-cli-error");
    return {
      currentModel: "gpt-5.1-codex",
      configId: "model",
      models: input.catalogModels ?? [
        { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
        { id: "gpt-5.1", name: "GPT-5.1" },
      ],
    };
  };
  const auditReader = {
    list: async () => {
      if (input.sessionReadFails) throw new Error("trail-unavailable");
      return { events: input.sessionEvents ?? [] };
    },
  };
  const route = createAcpConversationModelRoutes(
    {
      get: async () => ({ id: "coord", systemOwned: true, deletedAt: null }),
    } as never,
    fake.store,
    async (c, next) => {
      c.set("actor", {
        id: input.role === "admin" ? "admin-1" : "owner",
      } as never);
      await next();
    },
    {
      insert: async (event: Record<string, unknown>) => {
        void audits.push(event);
      },
    } as never,
    auditReader as never,
    discover,
  );
  const call = (method: "GET" | "PUT", body?: unknown, agentId = "coord") =>
    route.request(`/thread-1/acp-model/${agentId}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const session = (agentId = "coord") =>
    route.request(`/thread-1/acp-session/${agentId}`);
  return { ...fake, audits, call, session, revision: () => currentRevision() };
}

function currentRevision() {
  // The route reads the same file, so the live revision is whatever config.ts computes for it now.
  return acpModelSelectionFor("coord")!.revision;
}

const selection = (
  over: Partial<ConversationModelSelection> = {},
): ConversationModelSelection => ({
  threadId: "thread-1",
  agentId: "coord",
  profileId: "codex",
  provider: "codex",
  model: "gpt-5.1",
  operatorRevision: "",
  ...over,
});

test("a member reads the catalogue and their own standing choice", async () => {
  const h = setup({ storedModel: "gpt-5.1" });
  const response = await h.call("GET");
  expect(response.status).toBe(200);
  const body = (await response.json()).selection;
  expect(body.selected).toBe("gpt-5.1");
  expect(body.dropped).toBeNull();
  expect(body.models.map((m: { id: string }) => m.id)).toEqual([
    "gpt-5.1-codex",
    "gpt-5.1",
  ]);
});

test("nobody outside the channel chooses or reads, whatever the thread id they hold", async () => {
  const h = setup({ member: false });
  expect((await h.call("GET")).status).toBe(403);
  expect(
    (await h.call("PUT", { model: "gpt-5.1", revision: currentRevision() }))
      .status,
  ).toBe(403);
  expect(h.writes.length).toBe(0);
});

test("a private coworker stays in the private runtime", async () => {
  const h = setup();
  expect((await h.call("GET", undefined, "credito")).status).toBe(409);
  expect(
    (
      await h.call(
        "PUT",
        { model: "gpt-5.1", revision: currentRevision() },
        "credito",
      )
    ).status,
  ).toBe(409);
});

test("a model this CLI does not advertise is refused, and nothing is written", async () => {
  const h = setup();
  const response = await h.call("PUT", {
    model: "claude-opus-5",
    revision: currentRevision(),
  });
  expect(response.status).toBe(400);
  expect(h.writes.length).toBe(0);
  expect(JSON.stringify(await response.json())).not.toContain("claude-opus-5");
});

test("an edit raced with the operator is refused rather than applied over it", async () => {
  const h = setup();
  expect(
    (await h.call("PUT", { model: "gpt-5.1", revision: "not-the-revision" }))
      .status,
  ).toBe(409);
  expect(h.writes.length).toBe(0);
});

test("the route takes a model and nothing else, so a connection cannot be sent in its place", async () => {
  const h = setup();
  const revision = currentRevision();
  for (const body of [
    { model: "gpt-5.1", revision, profileId: "evil" },
    { model: "gpt-5.1", revision, command: "/bin/sh" },
    { model: "gpt-5.1", revision, args: ["--yolo"] },
    { model: "gpt-5.1", revision, env: { TOKEN: "x" } },
    { model: "gpt-5.1", revision, workspaceRoot: "/etc" },
    { revision },
    { model: "", revision },
    { model: 5, revision },
  ]) {
    expect(await (await h.call("PUT", body)).status).toBe(400);
  }
  expect(h.writes.length).toBe(0);
});

test("choosing the operator default is a choice, and it clears the override", async () => {
  const h = setup({ storedModel: "gpt-5.1" });
  const response = await h.call("PUT", {
    model: null,
    revision: currentRevision(),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).model).toBeNull();
  expect(h.writes[0]).toMatchObject({ selection: { model: null } });
});

test("the choice is audited with the connection and the model, never the prompt", async () => {
  const h = setup();
  await h.call("PUT", { model: "gpt-5.1", revision: currentRevision() });
  expect(h.audits).toHaveLength(1);
  expect(h.audits[0]).toMatchObject({
    eventType: "session.model_changed",
    targetType: "thread",
    targetId: "thread-1",
  });
  expect(JSON.stringify(h.audits[0])).not.toContain("hidden");
  expect(JSON.stringify(h.audits[0])).not.toContain("/secret/cli");
});

test("a dead CLI says it is unavailable and never claims a selection", async () => {
  const h = setup({ discoveryFails: true });
  expect((await h.call("GET")).status).toBe(503);
  expect(
    (await h.call("PUT", { model: "gpt-5.1", revision: currentRevision() }))
      .status,
  ).toBe(503);
  expect(h.writes.length).toBe(0);
});

test("a stale choice is reported as dropped instead of being shown as running", async () => {
  const h = setup({ storedModel: "gpt-5.1", storedRevision: "old-revision" });
  const body = (await (await h.call("GET")).json()).selection;
  expect(body.selected).toBeNull();
  expect(body.dropped).toBe("stale");
});

test("resolution drops a foreign connection and a lost membership, and honours neither silently", async () => {
  const current = { profileId: "codex", revision: "rev-1" };
  const asStore = (
    over: Partial<ConversationModelStore>,
  ): ConversationModelStore => ({
    channelForThread: async () => ({ channelId: "chan-1" }),
    get: async () => undefined,
    set: async () => {},
    clear: async () => {},
    ...over,
  });

  expect(
    await resolveConversationModel({
      store: asStore({ channelForThread: async () => undefined }),
      actor: { userId: "owner", admin: false },
      threadId: "thread-1",
      agentId: "coord",
      current,
    }),
  ).toEqual({ dropped: "membership" });

  expect(
    await resolveConversationModel({
      store: asStore({
        get: async () => selection({ operatorRevision: "rev-0" }),
      }),
      actor: { userId: "owner", admin: false },
      threadId: "thread-1",
      agentId: "coord",
      current,
    }),
  ).toEqual({ dropped: "stale" });

  expect(
    await resolveConversationModel({
      store: asStore({
        get: async () =>
          selection({ profileId: "claude", operatorRevision: "rev-1" }),
      }),
      actor: { userId: "owner", admin: false },
      threadId: "thread-1",
      agentId: "coord",
      current,
    }),
  ).toEqual({ dropped: "stale" });

  expect(
    await resolveConversationModel({
      store: asStore({
        get: async () => selection({ operatorRevision: "rev-1" }),
      }),
      actor: { userId: "owner", admin: false },
      threadId: "thread-1",
      agentId: "coord",
      current,
    }),
  ).toEqual({ model: "gpt-5.1" });

  expect(
    await resolveConversationModel({
      store: asStore({
        get: async () => selection({ model: null, operatorRevision: "rev-1" }),
      }),
      actor: { userId: "owner", admin: false },
      threadId: "thread-1",
      agentId: "coord",
      current,
    }),
  ).toEqual({ model: null });
});

test("the trail says whether the turn continued the session, with the model that answered", async () => {
  // Only the audit half of the store is exercised here, so the database half is a planted failure: if
  // recording a turn ever starts needing the selection table, this fails loudly rather than quietly
  // writing nothing.
  const rows: Record<string, unknown>[] = [];
  const store = createConversationModelStore(
    {
      insert: () => {
        throw new Error("recording a turn must not touch the selection table");
      },
    } as never,
    {
      insert: async (event) => {
        void rows.push(event);
      },
    },
  );

  await store.recordTurnSession?.({
    threadId: "thread-1",
    agentId: "coord",
    actorUserId: "owner",
    resumed: true,
    model: "gpt-5.1",
    provider: "codex",
    profileId: "codex",
  });
  await store.recordTurnSession?.({
    threadId: "thread-1",
    agentId: "coord",
    actorUserId: "owner",
    resumed: false,
    freshReason: "anchor_dead",
    model: null,
    provider: "codex",
    profileId: "codex",
  });

  expect(rows.map((row) => row.eventType)).toEqual([
    "session.resumed",
    "session.started",
  ]);
  expect(rows[0]).toMatchObject({ targetType: "thread", targetId: "thread-1" });
  expect(
    (rows[0] as { payload: Record<string, unknown> }).payload,
  ).toMatchObject({
    agentId: "coord",
    model: "gpt-5.1",
  });
  // A new session names why. A resumed one has no reason to give, and must not invent one.
  expect((rows[1] as { payload: Record<string, unknown> }).payload.reason).toBe(
    "anchor_dead",
  );
  expect(
    "reason" in (rows[0] as { payload: Record<string, unknown> }).payload,
  ).toBe(false);
});

test("a trail that cannot take the row still answers the person", async () => {
  const store = createConversationModelStore({} as never, {
    insert: async () => {
      throw new Error("the audit table is unreachable");
    },
  });
  // Resolves rather than throwing: the turn already answered, and a trail that is late is not a reason
  // to take the answer back.
  await store.recordTurnSession?.({
    threadId: "thread-1",
    agentId: "coord",
    actorUserId: "owner",
    resumed: true,
    model: null,
    provider: "codex",
    profileId: "codex",
  });
});

const sessionRow = (
  over: {
    eventType?: string;
    payload?: Record<string, unknown>;
    createdAt?: string;
  } = {},
) => ({
  eventType: over.eventType ?? "session.started",
  payload: {
    agentId: "coord",
    provider: "codex",
    profileId: "codex",
    model: "gpt-5.1",
    ...over.payload,
  },
  createdAt: over.createdAt ?? "2026-09-12T17:54:00.000Z",
});

test("the session row a conversation reads back is its own coworker's newest", async () => {
  // One thread holds several coworkers, so the newest row for the thread is not necessarily the newest
  // row for the coworker being asked about. Answering with another coworker's restart would tell this
  // person their session was lost when it was not.
  const h = setup({
    sessionEvents: [
      sessionRow({
        payload: { agentId: "other", reason: "anchor_dead" },
        createdAt: "2026-09-12T18:00:00.000Z",
      }),
      sessionRow({
        eventType: "session.resumed",
        createdAt: "2026-09-12T17:59:00.000Z",
      }),
      sessionRow({ payload: { reason: "first_turn" } }),
    ],
  });
  const response = await h.session();
  expect(response.status).toBe(200);
  expect((await response.json()).session).toEqual({
    resumed: true,
    reason: null,
    model: "gpt-5.1",
    provider: "codex",
    at: "2026-09-12T17:59:00.000Z",
  });
});

test("a new session carries the reason it was opened", async () => {
  const h = setup({
    sessionEvents: [sessionRow({ payload: { reason: "anchor_dead" } })],
  });
  const body = (await (await h.session()).json()).session;
  expect(body.resumed).toBe(false);
  expect(body.reason).toBe("anchor_dead");
});

test("a coworker that has not answered in the window reads as nothing recorded", async () => {
  const h = setup({ sessionEvents: [sessionRow({ payload: { agentId: "other" } })] });
  expect((await (await h.session()).json()).session).toBeNull();
  const empty = setup({ sessionEvents: [] });
  expect((await (await empty.session()).json()).session).toBeNull();
});

test("a trail that cannot be read does not take the conversation down with it", async () => {
  // The transcript is readable without this. Refusing the conversation because its footnote is
  // unavailable would trade a missing sentence for a broken screen.
  const h = setup({ sessionReadFails: true });
  const response = await h.session();
  expect(response.status).toBe(200);
  expect((await response.json()).session).toBeNull();
});

test("the session row is behind the same membership gate as the choice", async () => {
  const h = setup({ member: false, sessionEvents: [sessionRow()] });
  expect((await h.session()).status).toBe(403);
});

test("a private coworker has no ACP session to report", async () => {
  const h = setup({ sessionEvents: [sessionRow()] });
  expect((await h.session("credito")).status).toBe(409);
});
