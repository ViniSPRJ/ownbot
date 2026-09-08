import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createECDH, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import webpush from "web-push";
import { decryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  createPushStore,
  PushSubscriptionConflict,
} from "../src/notifications/push-store";

const url = process.env.DATABASE_URL;
const allowed = !!url && new URL(url).pathname.includes("test");
describe.skipIf(!allowed)("durable push with isolated PostgreSQL", () => {
  const db = createDatabase(url!, { max: 3 });
  const key = Buffer.alloc(32, 9).toString("base64");
  const store = createPushStore(db, key);
  const prefix = `push-test-${randomUUID()}`;
  const alice = `${prefix}-alice`,
    bob = `${prefix}-bob`;
  const vapid = {
    subject: "mailto:test@example.com",
    ...webpush.generateVAPIDKeys(),
  };
  const sub = () => {
    const ec = createECDH("prime256v1");
    ec.generateKeys();
    return {
      endpoint: `https://web.push.apple.com/${randomUUID()}`,
      expirationTime: null,
      keys: {
        p256dh: ec.getPublicKey().toString("base64url"),
        auth: Buffer.alloc(16, 2).toString("base64url"),
      },
    };
  };
  const notification = async (owner = alice, backdated = false) => {
    const id = `push-test-${randomUUID()}`;
    await db.execute(
      sql`INSERT INTO user_notifications(id,owner_user_id,run_id,title,summary,status,created_at) VALUES(${id},${owner},${id},'PRIVATE TITLE','PRIVATE DOCUMENT SUMMARY','succeeded',${backdated ? sql`now()-interval '1 hour'` : sql`clock_timestamp()`})`,
    );
    return id;
  };
  beforeEach(async () => {
    for (const id of [alice, bob])
      await db.execute(
        sql`INSERT INTO users(id,email) VALUES(${id},${`${id}@example.invalid`})`,
      );
  });
  afterEach(async () => {
    await db.execute(sql`DELETE FROM users WHERE id IN (${alice},${bob})`);
  });
  afterAll(async () => {
    await db.$client.close();
  });

  test("encrypted subscriptions are private, registration idempotent, cross-owner transfer rejected", async () => {
    const s = sub();
    const id = await store.subscribe(alice, s, vapid.publicKey);
    expect(await store.subscribe(alice, s, vapid.publicKey)).toBe(id);
    await expect(
      store.subscribe(bob, s, vapid.publicKey),
    ).rejects.toBeInstanceOf(PushSubscriptionConflict);
    expect(await store.list(bob)).toEqual([]);
    const [row] = await db.execute(
      sql`SELECT encrypted_subscription,endpoint_hash FROM push_subscriptions WHERE id=${id}`,
    );
    expect(String(row?.encrypted_subscription)).not.toContain(s.endpoint);
    expect(String(row?.encrypted_subscription)).not.toContain(s.keys.auth);
    expect(
      JSON.parse(await decryptSecret(key, String(row?.encrypted_subscription))),
    ).toEqual(s);
    await store.unsubscribe(bob, s.endpoint);
    expect(await store.list(alice)).toHaveLength(1);
  });
  test("only newly inserted owner notifications after opt-in queue once; no historical backlog", async () => {
    const old = await notification();
    const s = sub();
    const id = await store.subscribe(alice, s, vapid.publicKey);
    await notification(bob);
    const fresh = await notification();
    await notification(alice, true);
    await db.execute(
      sql`UPDATE user_notifications SET title='changed' WHERE id=${fresh}`,
    );
    const rows = await db.execute(
      sql`SELECT notification_id FROM push_outbox WHERE subscription_id=${id}`,
    );
    expect(rows.map((r) => r.notification_id)).toEqual([fresh]);
    expect(rows.map((r) => r.notification_id)).not.toContain(old);
  });
  test("notification and outbox rollback together", async () => {
    const id = await store.subscribe(alice, sub(), vapid.publicKey);
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`INSERT INTO user_notifications(id,owner_user_id,run_id,title,summary,status) VALUES(${`push-test-${randomUUID()}`},${alice},${randomUUID()},'private','private','succeeded')`,
        );
        throw Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(
      await db.execute(
        sql`SELECT * FROM push_outbox WHERE subscription_id=${id}`,
      ),
    ).toHaveLength(0);
  });
  test("concurrent claims serialize and send stores one durable receipt with no notification contents", async () => {
    const id = await store.subscribe(alice, sub(), vapid.publicKey);
    const n = await notification();
    const claims = await Promise.all([store.claim(), store.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    let calls = 0;
    await store.deliver(claim, vapid, async (s, notificationId) => {
      calls++;
      expect(notificationId).toBe(n);
      expect(Object.keys(s).sort()).toEqual([
        "endpoint",
        "expirationTime",
        "keys",
      ]);
      return { statusCode: 201 };
    });
    await store.deliver(claim, vapid, async () => {
      calls++;
      return { statusCode: 201 };
    });
    expect(calls).toBe(1);
    const [row] = await db.execute(
      sql`SELECT status,attempts,last_error FROM push_outbox WHERE subscription_id=${id}`,
    );
    expect(row?.status).toBe("delivered");
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBeNull();
  });
  test("opt-out cancels claimed work; reactivation cannot revive earlier generation", async () => {
    const s = sub();
    const id = await store.subscribe(alice, s, vapid.publicKey);
    await notification();
    const claim = (await store.claim())!;
    await store.unsubscribe(alice, s.endpoint);
    await store.subscribe(alice, s, vapid.publicKey);
    let sends = 0;
    await store.deliver(claim, vapid, async () => {
      sends++;
      return { statusCode: 201 };
    });
    expect(sends).toBe(0);
    expect(await store.claim()).toBeNull();
    const [row] = await db.execute(
      sql`SELECT generation FROM push_subscriptions WHERE id=${id}`,
    );
    expect(row?.generation).toBe(2);
  });
  test("expired lease can recover; old token cannot send", async () => {
    const id = await store.subscribe(alice, sub(), vapid.publicKey);
    await notification();
    const first = (await store.claim())!;
    await db.execute(
      sql`UPDATE push_outbox SET lease_until=now()-interval '1 second' WHERE subscription_id=${id}`,
    );
    const second = (await store.claim())!;
    expect(second.leaseToken).not.toBe(first.leaseToken);
    let sends = 0;
    const send = async () => {
      sends++;
      return { statusCode: 201 };
    };
    await store.deliver(first, vapid, send);
    expect(sends).toBe(0);
    await store.deliver(second, vapid, send);
    expect(sends).toBe(1);
  });
  test("transient failure backs off and410 disables device; arbitrary error bodies never persist", async () => {
    const s = sub();
    const id = await store.subscribe(alice, s, vapid.publicKey);
    await notification();
    await store.deliver((await store.claim())!, vapid, async () => {
      throw Error("PRIVATE BODY token=secret");
    });
    const [pending] = await db.execute(
      sql`SELECT status,last_error,available_at>now() AS waiting FROM push_outbox WHERE subscription_id=${id}`,
    );
    expect(pending?.status).toBe("pending");
    expect(pending?.waiting).toBe(true);
    expect(pending?.last_error).toBe("transport_failed");
    await db.execute(
      sql`UPDATE push_outbox SET available_at=now() WHERE subscription_id=${id}`,
    );
    await store.deliver((await store.claim())!, vapid, async () => ({
      statusCode: 410,
    }));
    expect(await store.list(alice)).toEqual([]);
    const [dead] = await db.execute(
      sql`SELECT status,last_error FROM push_outbox WHERE subscription_id=${id}`,
    );
    expect(dead?.status).toBe("dead");
    expect(dead?.last_error).toBe("subscription_expired");
  });
  test("revocation waits for an already dispatched send and blocks subsequent queued work", async () => {
    const s = sub();
    await store.subscribe(alice, s, vapid.publicKey);
    await notification();
    await notification();
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sends = 0;
    const delivery = store.deliver((await store.claim())!, vapid, async () => {
      sends++;
      started();
      await gate;
      return { statusCode: 201 };
    });
    await began;
    let revoked = false;
    const revoke = store.unsubscribe(alice, s.endpoint).then(() => {
      revoked = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(revoked).toBe(false);
    release();
    await delivery;
    await revoke;
    expect(await store.claim()).toBeNull();
    expect(sends).toBe(1);
    expect(await store.list(alice)).toEqual([]);
  });
  test("permanent responses and changed VAPID keys fail closed without retry", async () => {
    const id = await store.subscribe(alice, sub(), vapid.publicKey);
    await notification();
    let sends = 0;
    await store.deliver(
      (await store.claim())!,
      { ...vapid, ...webpush.generateVAPIDKeys() },
      async () => {
        sends++;
        return { statusCode: 201 };
      },
    );
    expect(sends).toBe(0);
    expect(
      (
        await db.execute(
          sql`SELECT last_error FROM push_outbox WHERE subscription_id=${id}`,
        )
      )[0]?.last_error,
    ).toBe("vapid_key_changed");
    await notification();
    await store.deliver((await store.claim())!, vapid, async () => ({
      statusCode: 403,
    }));
    expect(await store.claim()).toBeNull();
    expect(
      (
        await db.execute(
          sql`SELECT count(*)::int AS count FROM push_outbox WHERE subscription_id=${id} AND status='dead'`,
        )
      )[0]?.count,
    ).toBe(2);
  });
  test("attempt exhaustion and old queue entries are terminalized", async () => {
    const id = await store.subscribe(alice, sub(), vapid.publicKey);
    await notification();
    await db.execute(
      sql`UPDATE push_outbox SET attempts=5 WHERE subscription_id=${id}`,
    );
    await store.prune();
    expect(
      (
        await db.execute(
          sql`SELECT status FROM push_outbox WHERE subscription_id=${id}`,
        )
      )[0]?.status,
    ).toBe("dead");
    await notification();
    await db.execute(
      sql`UPDATE push_outbox SET created_at=now()-interval '25 hours' WHERE subscription_id=${id} AND status='pending'`,
    );
    expect(await store.claim()).toBeNull();
  });
});
