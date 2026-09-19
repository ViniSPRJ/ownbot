import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { acpModelSelectionFor } from "../src/acp/config";
import { createAcpConversationModelRoutes } from "../src/acp/conversation-model-routes";
import { createConversationModelStore } from "../src/acp/conversation-models";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channels,
  channelMemberships,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const db = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const profiles = createAgentProfileStore(
  db,
  new URL("https://managed.example.test/ag-ui"),
);
const store = createConversationModelStore(db, {
  insert: async () => {},
} as never);
const id = randomUUID();
const owner = `acp-member-${id}`,
  outsider = `acp-outsider-${id}`;
const channel = `acp-channel-${id}`,
  thread = `acp-thread-${id}`;
let agentId: string;
let root: string;
const priorConfig = process.env.OWNBOT_ACP_CONFIG;

beforeAll(async () => {
  await db.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: outsider, email: `${outsider}@example.test` },
  ]);
  const agent = await profiles.create(
    { id: owner, role: "user" },
    {
      name: "Membership fixture",
      title: "Test",
      roleDescription: "Test",
      visibility: "public",
    },
  );
  agentId = agent.id;
  await db
    .insert(channels)
    .values({
      id: channel,
      name: "Private conversation",
      description: "Only owner is a member",
    });
  await db
    .insert(channelMemberships)
    .values({ channelId: channel, userId: owner });
  await db
    .insert(intelligenceChannelMappings)
    .values({ channelId: channel, userId: owner, threadId: thread });
  root = mkdtempSync(join(tmpdir(), "acp-membership-"));
  const file = join(root, "profiles.json");
  writeFileSync(
    file,
    JSON.stringify({
      profiles: { codex: { command: "/bin/false", workspaceRoot: root } },
      agents: { [agentId]: "codex" },
    }),
  );
  process.env.OWNBOT_ACP_CONFIG = file;
});

afterAll(async () => {
  await db.delete(channels).where(eq(channels.id, channel));
  if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
  await db.delete(users).where(inArray(users.id, [owner, outsider]));
  await db.$client.close();
  if (priorConfig === undefined) delete process.env.OWNBOT_ACP_CONFIG;
  else process.env.OWNBOT_ACP_CONFIG = priorConfig;
  if (root) rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await db
    .insert(channelMemberships)
    .values({ channelId: channel, userId: owner })
    .onConflictDoNothing();
  await store.set(
    {
      threadId: thread,
      agentId,
      profileId: "codex",
      provider: "codex",
      model: "A",
      operatorRevision: acpModelSelectionFor(agentId)!.conversationRevision,
    },
    owner,
  );
});

function routes(actor: AgentActor, afterDiscovery?: () => Promise<void>) {
  return createAcpConversationModelRoutes(
    profiles,
    store,
    async (c, next) => {
      c.set("actor", actor);
      await next();
    },
    undefined,
    undefined,
    async () => {
      await afterDiscovery?.();
      return {
        currentModel: "A",
        models: [
          { id: "A", name: "A" },
          { id: "B", name: "B" },
        ],
      };
    },
  );
}
const put = (app: ReturnType<typeof routes>, model: string) =>
  app.request(`/${thread}/acp-model/${agentId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      revision: acpModelSelectionFor(agentId)!.conversationRevision,
    }),
  });

test("a real member can select a model; a nonmember administrator cannot read or change it", async () => {
  expect((await put(routes({ id: owner, role: "user" }), "A")).status).toBe(
    200,
  );
  for (const role of ["user", "admin"] as const) {
    const app = routes({ id: outsider, role });
    expect((await app.request(`/${thread}/acp-model/${agentId}`)).status).toBe(
      403,
    );
    expect(
      (await app.request(`/${thread}/acp-session/${agentId}`)).status,
    ).toBe(403);
    expect((await put(app, "B")).status).toBe(403);
    expect((await store.get(thread, agentId))?.model).toBe("A");
  }
});

test("membership revoked during model discovery cannot authorize a subsequent write", async () => {
  const app = routes({ id: owner, role: "admin" }, async () => {
    await db
      .delete(channelMemberships)
      .where(eq(channelMemberships.channelId, channel));
  });
  expect((await put(app, "B")).status).toBe(403);
  expect((await store.get(thread, agentId))?.model).toBe("A");
});
