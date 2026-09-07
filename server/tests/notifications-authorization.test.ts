import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { createRequireUser, type AuthService } from "../src/auth/guards";
import type { Database } from "../src/db/client";
import { createNotificationsRoutes } from "../src/notifications/routes";
import {
  createNotificationsStore,
  type NotificationsStore,
} from "../src/notifications/store";
function harness(user: string | null, roles: ("admin" | "user")[] = ["user"]) {
  const calls: unknown[][] = [];
  const store: NotificationsStore = {
    list: async (owner, offset) => {
      calls.push(["list", owner, offset]);
      return { notifications: [], unreadCount: 0, nextOffset: null };
    },
    setRead: async (owner, id, read) => {
      calls.push(["read", owner, id, read]);
      return owner === "alice" && id === "alice-id";
    },
  };
  const auth = {
    api: {
      getSession: async () =>
        user ? { user: { id: user, email: "test@example.invalid" } } : null,
    },
  } as unknown as AuthService;
  return {
    app: createNotificationsRoutes(
      store,
      createRequireUser(auth, { rolesForUser: async () => roles }),
    ),
    calls,
  };
}
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
describe("private notification inbox", () => {
  test("unauthenticated requests never read or modify the store", async () => {
    const { app, calls } = harness(null);
    expect((await app.request("/")).status).toBe(401);
    expect(
      (await app.request("/alice-id/read", post({ read: true }))).status,
    ).toBe(401);
    expect(calls).toEqual([]);
  });
  test("login without an application role is forbidden", async () => {
    expect((await harness("alice", []).app.request("/")).status).toBe(403);
  });
  test("owner and header spoofing cannot read another user's inbox", async () => {
    const { app, calls } = harness("bob");
    const response = await app.request("/?owner=alice&offset=50", {
      headers: { "x-user-id": "alice" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(calls).toEqual([["list", "bob", 50]]);
  });
  test("admin cannot alter another user's read state", async () => {
    const { app, calls } = harness("bob", ["admin"]);
    expect(
      (
        await app.request(
          "/alice-id/read",
          post({ read: true, owner: "alice" }),
        )
      ).status,
    ).toBe(404);
    expect(calls).toEqual([["read", "bob", "alice-id", true]]);
  });
  test("owner can mark read and unread", async () => {
    const { app, calls } = harness("alice");
    expect(
      (await app.request("/alice-id/read", post({ read: true }))).status,
    ).toBe(200);
    expect(
      (await app.request("/alice-id/read", post({ read: false }))).status,
    ).toBe(200);
    expect(calls).toEqual([
      ["read", "alice", "alice-id", true],
      ["read", "alice", "alice-id", false],
    ]);
  });
  test("invalid pagination and read state are rejected before store access", async () => {
    const { app, calls } = harness("alice");
    for (const offset of ["-1", "0.5", "NaN", "1000001"])
      expect((await app.request(`/?offset=${offset}`)).status).toBe(400);
    expect(
      (await app.request("/alice-id/read", post({ read: "true" }))).status,
    ).toBe(400);
    expect(
      (await app.request("/alice-id/read", { method: "POST", body: "{" }))
        .status,
    ).toBe(400);
    expect(calls).toEqual([]);
  });
  test("every SQL read and update binds owner, without exposing user input as SQL", async () => {
    const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
    const dialect = new PgDialect();
    const db = {
      execute: async (q: SQL) => {
        queries.push(dialect.sqlToQuery(q));
        return [];
      },
    } as unknown as Database;
    const store = createNotificationsStore(db);
    await store.list("private-owner");
    await store.setRead("private-owner", "private-id", true);
    await store.setRead("private-owner", "private-id", false);
    expect(queries).toHaveLength(4);
    for (const q of queries) {
      expect(q.sql).toContain("owner_user_id=$1");
      expect(q.params[0]).toBe("private-owner");
      expect(q.sql).not.toContain("private-owner");
    }
    expect(queries[2]?.params).toEqual(["private-owner", "private-id"]);
  });
});

test("internal readiness verifies inbox and persistent no-egress policy without requiring Telegram worker", async () => {
  const { createOperationsStore } = await import("../src/operations/store");
  const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const dialect = new PgDialect();
  const db = {
    execute: async (q: SQL) => {
      queries.push(dialect.sqlToQuery(q));
      return [{ scheduler: true, notifications: true, runs: true }];
    },
  } as unknown as Database;
  expect(
    (await createOperationsStore(db, undefined, "internal").readiness()).status,
  ).toBe("ready");
  expect(queries[0]?.sql).toContain("outbound_notification_policy");
  expect(queries[0]?.sql).toContain("routine_run_inbox");
  expect(queries[0]?.sql).toContain("gate_external_notification");
  expect(queries[0]?.sql).not.toContain("routine-notifier");
});
