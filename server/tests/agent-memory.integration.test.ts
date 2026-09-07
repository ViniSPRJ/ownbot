import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, agentProfiles, users } from "../src/db/schema";
import { createAgentMemoryStore } from "../src/memory/store";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";

if (!process.env.DATABASE_URL)
  throw new Error("Set DATABASE_URL to an isolated migrated test database.");
const db = createDatabase(process.env.DATABASE_URL);
const prefix = "memory-test-" + randomUUID();
const alice = prefix + "-alice",
  bob = prefix + "-bob",
  agentId = prefix + "-bot",
  remoteId = prefix + "-remote";
const input = {
  standingInstructions: "User preference survives restart",
  notes: "Untrusted reference notes",
  expectedRevision: 0,
};
beforeAll(async () => {
  await db
    .insert(users)
    .values([alice, bob].map((id) => ({ id, email: id + "@example.test" })));
  await db.insert(agents).values([
    {
      id: agentId,
      name: "Memory test",
      type: "built_in",
      configuration: { systemPrompt: "Base role" },
    },
    {
      id: remoteId,
      name: "Memory remote test",
      type: "remote_ag_ui",
      configuration: { endpoint: "https://agent.example.test/ag-ui" },
    },
  ]);
  await db
    .insert(agentProfiles)
    .values(
      [agentId, remoteId].map((id) => ({
        agentId: id,
        ownerUserId: alice,
        title: "Test",
        roleDescription: "Base role",
        avatarSeed: id,
        visibility: "public" as const,
      })),
    );
});
afterAll(async () => {
  await db.delete(agents).where(inArray(agents.id, [agentId, remoteId]));
  await db.delete(users).where(inArray(users.id, [alice, bob]));
  await db.$client.close();
});

test("memory persists across store instances and remains isolated for public bots", async () => {
  const first = await createAgentMemoryStore(db).write(alice, agentId, input);
  expect(first?.revision).toBe(1);
  expect(
    (await createAgentMemoryStore(db).read(alice, agentId))
      ?.standingInstructions,
  ).toBe(input.standingInstructions);
  expect(await createAgentMemoryStore(db).read(bob, agentId)).toBeNull();
  expect(
    await createAgentMemoryStore(db).write(bob, agentId, {
      ...input,
      expectedRevision: 1,
    }),
  ).toBeNull();
});
test("atomic optimistic concurrency permits exactly one winner", async () => {
  const results = await Promise.all(
    ["edit1", "edit2"].map((notes) =>
      createAgentMemoryStore(db).write(alice, agentId, {
        ...input,
        notes,
        expectedRevision: 1,
      }),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(
    (await createAgentMemoryStore(db).read(alice, agentId))?.revision,
  ).toBe(2);
  expect(
    await createAgentMemoryStore(db).write(alice, agentId, input),
  ).toBeNull();
});
test("runtime loads fresh owner memory for built-in and remote coworker and omits other owner memory", async () => {
  await createAgentMemoryStore(db).write(alice, remoteId, input);
  const load = createRuntimeAgentLoader(db);
  const a = await load({ id: alice, role: "user" }),
    b = await load({ id: bob, role: "user" });
  const built = a.find((x) => x.id === agentId),
    remote = a.find((x) => x.id === remoteId),
    other = b.find((x) => x.id === agentId);
  expect(built?.type).toBe("built_in");
  if (built?.type === "built_in")
    expect(built.systemPrompt).toContain(input.standingInstructions);
  expect(remote?.type).toBe("remote_ag_ui");
  if (remote?.type === "remote_ag_ui")
    expect(remote.standingMessage.content).toContain(
      input.standingInstructions,
    );
  if (other?.type === "built_in")
    expect(other.systemPrompt).not.toContain(input.standingInstructions);
  await createAgentMemoryStore(db).write(alice, agentId, {
    standingInstructions: "",
    notes: "",
    expectedRevision: 2,
  });
  const cleared = (await load({ id: alice, role: "user" })).find(
    (x) => x.id === agentId,
  );
  if (cleared?.type === "built_in")
    expect(cleared.systemPrompt).not.toContain(input.standingInstructions);
  expect(
    (await createAgentMemoryStore(db).read(alice, agentId))?.revision,
  ).toBe(3);
});
