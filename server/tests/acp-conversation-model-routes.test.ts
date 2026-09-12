import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpModelSelectionFor } from "../src/acp/config";
import { createAcpConversationModelRoutes } from "../src/acp/conversation-model-routes";
import type { ConversationModelStore } from "../src/acp/conversation-models";
import { resolveConversationModel } from "../src/acp/conversation-models";

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
    discover,
  );
  const call = (method: "GET" | "PUT", body?: unknown, agentId = "coord") =>
    route.request(`/thread-1/acp-model/${agentId}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...fake, audits, call, revision: () => currentRevision() };
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
