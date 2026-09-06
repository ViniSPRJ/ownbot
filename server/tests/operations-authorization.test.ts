import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { createRequireUser, type AuthService } from "../src/auth/guards";
import type { Database } from "../src/db/client";
import { createOperationsRoutes } from "../src/operations/routes";
import {
  createOperationsStore,
  type OperationsStore,
  type RunRecord,
} from "../src/operations/store";

function harness(
  sessionUser: string | null,
  roles: ("admin" | "user")[] = ["user"],
) {
  const calls: { kind: string; owner: string; id?: string }[] = [];
  const store: OperationsStore = {
    runs: async (owner, id) => {
      calls.push({ kind: "runs", owner, id });
      return owner === "alice" && (!id || id === "alice-run")
        ? [{ id: "alice-run", replyText: "private result" } as RunRecord]
        : [];
    },
    handoffs: async (owner) => {
      calls.push({ kind: "handoffs", owner });
      return [];
    },
    readiness: async () => ({ status: "ready", checks: { database: true } }),
  };
  const auth = {
    api: {
      getSession: async () =>
        sessionUser
          ? { user: { id: sessionUser, email: "test@example.invalid" } }
          : null,
    },
  } as unknown as AuthService;
  const requireUser = createRequireUser(auth, {
    rolesForUser: async () => roles,
  });
  return { app: createOperationsRoutes(store, requireUser), calls };
}

describe("operations ownership boundary", () => {
  test("all list and detail routes require a session before reading any store", async () => {
    const { app, calls } = harness(null);
    for (const path of ["/runs", "/runs/alice-run", "/handoffs"])
      expect((await app.request(path)).status).toBe(401);
    expect(calls).toEqual([]);
  });
  test("a session without an application role cannot read operations", async () => {
    const { app, calls } = harness("alice", []);
    expect((await app.request("/runs")).status).toBe(403);
    expect(calls).toEqual([]);
  });
  test("caller-controlled owner fields cannot change the authenticated owner", async () => {
    const { app, calls } = harness("bob");
    const response = await app.request(
      "/runs/alice-run?owner=alice&ownerUserId=alice",
      { headers: { "x-user-id": "alice" } },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Execution not found." });
    await app.request("/handoffs?owner=alice");
    expect(calls).toEqual([
      { kind: "runs", owner: "bob", id: "alice-run" },
      { kind: "handoffs", owner: "bob" },
    ]);
  });
  test("administrators still receive their own operations rather than another user's", async () => {
    const { app, calls } = harness("bob", ["admin"]);
    expect((await app.request("/runs/alice-run")).status).toBe(404);
    expect(calls[0]?.owner).toBe("bob");
  });
  test("an owner's detail returns that execution's persisted result", async () => {
    const { app } = harness("alice");
    const response = await app.request("/runs/alice-run");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      run: { id: "alice-run", replyText: "private result" },
    });
  });
  test("SQL reads bind both owner and run ID, and handoffs bind actor ownership", async () => {
    const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
    const dialect = new PgDialect();
    const database = {
      execute: async (query: SQL) => {
        queries.push(dialect.sqlToQuery(query));
        return [];
      },
    } as unknown as Database;
    const store = createOperationsStore(database);
    await store.runs("owner-secret", "run-secret");
    await store.handoffs("owner-secret");
    expect(queries[0]?.sql).toContain("WHERE r.owner_user_id=$1 AND rr.id=$2");
    expect(queries[0]?.params.slice(0, 2)).toEqual([
      "owner-secret",
      "run-secret",
    ]);
    expect(queries[0]?.sql).not.toContain("owner-secret");
    expect(queries[1]?.sql).toContain("WHERE actor_user_id=$1");
    expect(queries[1]?.params).toEqual(["owner-secret"]);
  });
});
