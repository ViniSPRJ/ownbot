import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase } from "../src/db/client";
import { createNotificationsStore } from "../src/notifications/store";

// Explicit opt-in; never silently falls back to a local production database.
test.skipIf(!process.env.NOTIFICATIONS_TEST_DATABASE_URL)(
  "migration, transactional notifications, owner isolation, restart persistence and deletion retention",
  async () => {
    const database = createDatabase(
      process.env.NOTIFICATIONS_TEST_DATABASE_URL!,
      { max: 1 },
    );
    const client = database.$client;
    const schema = `inbox_test_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.unsafe(`CREATE SCHEMA ${schema}`);
      await client.unsafe(`SET search_path TO ${schema}`);
      await client.unsafe(
        `CREATE TABLE users(id text PRIMARY KEY); CREATE TABLE routines(id text PRIMARY KEY,owner_user_id text REFERENCES users(id),agent_id text); CREATE TABLE routine_runs(id text PRIMARY KEY,routine_id text REFERENCES routines(id) ON DELETE CASCADE,status text,finished_at timestamptz,reply_text text,error text)`,
      );
      await client.unsafe(
        "INSERT INTO users VALUES ('alice'),('bob'); INSERT INTO routines VALUES ('a','alice','news'),('b','bob','research')",
      );
      await client.unsafe(
        "INSERT INTO routine_runs VALUES ('historical','a','succeeded',now(),'Historical summary',NULL)",
      );
      await client.unsafe(
        "CREATE TABLE routine_notifications(run_id text PRIMARY KEY,status text DEFAULT 'pending',lease_until timestamptz,last_error text)",
      );
      const migration = await readFile(
        new URL("../drizzle/0029_internal_notifications.sql", import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint"))
        await client.unsafe(statement);
      const store = createNotificationsStore(database);
      expect((await store.list("alice")).unreadCount).toBe(1);
      await client.unsafe(
        "INSERT INTO routine_runs VALUES ('new','a',NULL,NULL,NULL,NULL)",
      );
      expect((await store.list("alice")).notifications).toHaveLength(1);
      await client.unsafe(
        "UPDATE routine_runs SET status='failed',finished_at=now(),error='Research unavailable' WHERE id='new'",
      );
      expect(
        (await store.list("alice")).notifications.find((n) => n.runId === "new")
          ?.summary,
      ).toBe("Research unavailable");
      await client.unsafe(
        "UPDATE routine_runs SET status='failed' WHERE id='new'",
      );
      expect((await store.list("alice")).notifications).toHaveLength(2);
      expect(await store.setRead("bob", "routine:new", true)).toBe(false);
      expect((await store.list("bob")).unreadCount).toBe(0);
      expect(await store.setRead("alice", "routine:new", true)).toBe(true);
      const restarted = createNotificationsStore(database);
      expect((await restarted.list("alice")).unreadCount).toBe(1);
      expect(
        (await restarted.list("alice")).notifications.find(
          (n) => n.runId === "new",
        )?.readAt,
      ).not.toBeNull();
      expect(await restarted.setRead("alice", "routine:new", false)).toBe(true);
      expect((await restarted.list("alice")).unreadCount).toBe(2);
      await client.unsafe("BEGIN");
      await client.unsafe(
        "INSERT INTO routine_runs VALUES ('rolled-back','a','succeeded',now(),'Must vanish',NULL)",
      );
      await client.unsafe("ROLLBACK");
      expect(
        (await store.list("alice")).notifications.some(
          (n) => n.runId === "rolled-back",
        ),
      ).toBe(false);
      await client.unsafe(
        "INSERT INTO routine_runs VALUES ('skip','b','skipped',now(),NULL,'Outside execution window')",
      );
      expect((await store.list("bob")).notifications[0]?.status).toBe(
        "skipped",
      );
      await client.unsafe(
        "INSERT INTO routine_notifications(run_id,status) VALUES ('old-pending','pending'),('old-sending','sending'),('old-sent','sent')",
      );
      await client.unsafe(
        "UPDATE outbound_notification_policy SET mode='internal'",
      );
      const suppressed = await client.unsafe(
        "SELECT status FROM routine_notifications WHERE run_id='old-pending'",
      );
      expect(suppressed[0].status).toBe("failed");
      expect(
        (
          await client.unsafe(
            "SELECT status FROM routine_notifications WHERE run_id='old-sending'",
          )
        )[0].status,
      ).toBe("failed");
      expect(
        (
          await client.unsafe(
            "SELECT status FROM routine_notifications WHERE run_id='old-sent'",
          )
        )[0].status,
      ).toBe("sent");
      await client.unsafe(
        "INSERT INTO routine_notifications(run_id) VALUES ('must-not-send')",
      );
      expect(
        (
          await client.unsafe(
            "SELECT * FROM routine_notifications WHERE run_id='must-not-send'",
          )
        ).length,
      ).toBe(0);
      await client.unsafe(
        "UPDATE outbound_notification_policy SET mode='telegram'",
      );
      expect(
        (
          await client.unsafe(
            "SELECT status FROM routine_notifications WHERE run_id='old-pending'",
          )
        )[0].status,
      ).toBe("failed");
      await client.unsafe("DELETE FROM routines WHERE id='a'");
      expect((await store.list("alice")).notifications).toHaveLength(2);
      await client.unsafe("DELETE FROM users WHERE id='alice'");
      expect((await store.list("alice")).notifications).toHaveLength(0);
    } finally {
      await client.unsafe("ROLLBACK").catch(() => {});
      await client.unsafe("SET search_path TO public");
      await client.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.close();
    }
  },
);
