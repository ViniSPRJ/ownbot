import { expect, test } from "bun:test";
import { createHandoffRunner } from "../src/agents/handoff-runner";
import { createHandoffDelivery } from "../src/agents/handoff-delivery";
import type { WorkQueue } from "../src/work/queue";
import { Observable } from "rxjs";
const payload = {
  fromBotId: "a",
  toBotId: "b",
  actorId: "u",
  threadId: "t",
  runId: "r",
  depth: 1,
  task: "test",
};
const auditStore = { insert: async () => {} };

test("a completion write failure cannot replay an admitted effect", async () => {
  let effect = 0,
    released = 0,
    finishes = 0;
  const item = {
    kind: "bot.message",
    key: "k",
    payload: { ...payload } as Record<string, unknown>,
    attempts: 1,
  };
  const queue = {
    claim: async () => [item],
    renew: async () => true,
    admit: async () => {
      item.payload._deliveryStartedAt = new Date().toISOString();
      return true;
    },
    finish: async () => {
      if (++finishes <= 2) throw new Error("database lost");
      return true;
    },
    release: async () => {
      released++;
      return true;
    },
  } as unknown as WorkQueue;
  const runner = createHandoffRunner({
    queue,
    owner: "one",
    sign: () => "signed",
    auditStore,
    delivery: {
      deliver: async ({ admit }) => {
        await admit!();
        effect++;
        return { answer: "done" };
      },
    },
  });
  await runner.sweep();
  item.attempts++;
  const result = await runner.sweep();
  expect(effect).toBe(1);
  expect(released).toBe(0);
  expect(result.skipped[0]?.reason).toContain("not replayed");
});

test("lost queue lease aborts an in-flight delivery", async () => {
  let renewals = 0;
  const queue = {
    claim: async () => [
      { kind: "bot.message", key: "k", payload, attempts: 1 },
    ],
    renew: async () => ++renewals === 1,
    admit: async () => true,
    finish: async () => true,
  } as unknown as WorkQueue;
  let aborted = false;
  const runner = createHandoffRunner({
    queue,
    owner: "one",
    sign: () => "s",
    auditStore,
    renewEveryMs: 5,
    delivery: {
      deliver: async ({ admit, signal }) => {
        await admit!();
        return await new Promise((_, reject) => {
          signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal!.reason);
            },
            { once: true },
          );
        });
      },
    },
  });
  await runner.sweep();
  expect(aborted).toBe(true);
});

test("lost thread lock stops the agent and runner and releases the exact lock", async () => {
  let aborted = 0,
    stopped = 0,
    unsubscribed = 0,
    released = 0,
    admitted = 0;
  const delivery = createHandoffDelivery({
    agentFor: async () =>
      ({
        setMessages() {},
        abortRun() {
          aborted++;
        },
      }) as never,
    history: async () => [],
    runner: {
      run: () =>
        new Observable(() => () => {
          unsubscribed++;
        }),
      stop: async () => {
        stopped++;
      },
    },
    lock: {
      acquire: async () => ({ runId: "actual" }),
      renew: async () => {
        throw new Error("lock lost");
      },
      release: async (input) => {
        expect(input).toEqual({ threadId: "scratch", runId: "actual" });
        released++;
      },
    },
    mintThreadId: () => "scratch",
    newRunId: () => "requested",
    renewEveryMs: 5,
    deadlineMs: 1000,
  });
  await expect(
    delivery.deliver({
      work: payload,
      message: "test",
      assertion: "s",
      admit: async () => {
        admitted++;
      },
    }),
  ).rejects.toThrow("lock lost");
  expect(admitted).toBe(1);
  expect(aborted).toBeGreaterThan(0);
  expect(stopped).toBe(1);
  expect(unsubscribed).toBe(1);
  expect(released).toBe(1);
});
