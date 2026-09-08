import { sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import {
  type PushSubscription,
  parsePushSubscription,
  pushEndpointHash,
  type VapidConfig,
} from "./push-config";
import type { PushSend } from "./push-delivery";

export class PushSubscriptionConflict extends Error {}
export class PushSubscriptionLimit extends Error {}
export type PushStore = ReturnType<typeof createPushStore>;
export type PushClaim = {
  notificationId: string;
  subscriptionId: string;
  leaseToken: string;
};
export function createPushStore(db: Database, encryptionKey: string) {
  return {
    async list(owner: string): Promise<{ id: string; endpointHash: string }[]> {
      return (await db.execute(sql`SELECT id,endpoint_hash AS "endpointHash" FROM push_subscriptions
        WHERE owner_user_id=${owner} AND enabled ORDER BY created_at,id`)) as unknown as {
        id: string;
        endpointHash: string;
      }[];
    },
    async subscribe(
      owner: string,
      subscription: PushSubscription,
      publicKey: string,
    ): Promise<string> {
      const encrypted = await encryptSecret(
        encryptionKey,
        JSON.stringify(subscription),
      );
      const hash = pushEndpointHash(subscription.endpoint);
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`push-owner:${owner}`},0))`,
        );
        const [existing] = await tx.execute(
          sql`SELECT id,owner_user_id FROM push_subscriptions WHERE endpoint_hash=${hash} FOR UPDATE`,
        );
        if (existing && existing.owner_user_id !== owner)
          throw new PushSubscriptionConflict();
        if (!existing) {
          const [count] = await tx.execute(
            sql`SELECT count(*)::int AS count FROM push_subscriptions WHERE owner_user_id=${owner}`,
          );
          if (Number(count?.count) >= 32) throw new PushSubscriptionLimit();
        }
        const rows =
          await tx.execute(sql`INSERT INTO push_subscriptions(id,owner_user_id,endpoint_hash,encrypted_subscription,vapid_public_key)
          VALUES (${crypto.randomUUID()},${owner},${hash},${encrypted},${publicKey})
          ON CONFLICT(endpoint_hash) DO UPDATE SET
            encrypted_subscription=EXCLUDED.encrypted_subscription,vapid_public_key=EXCLUDED.vapid_public_key,
            generation=CASE WHEN push_subscriptions.enabled THEN push_subscriptions.generation ELSE push_subscriptions.generation+1 END,
            opted_in_at=CASE WHEN push_subscriptions.enabled THEN push_subscriptions.opted_in_at ELSE clock_timestamp() END,
            enabled=true,updated_at=clock_timestamp()
          WHERE push_subscriptions.owner_user_id=EXCLUDED.owner_user_id RETURNING id`);
        if (!rows[0]) throw new PushSubscriptionConflict();
        return String(rows[0].id);
      });
    },
    async unsubscribe(owner: string, endpoint: string): Promise<void> {
      await db.transaction(async (tx) => {
        const rows =
          await tx.execute(sql`UPDATE push_subscriptions SET enabled=false,updated_at=clock_timestamp()
          WHERE owner_user_id=${owner} AND endpoint_hash=${pushEndpointHash(endpoint)} RETURNING id`);
        if (rows[0])
          await tx.execute(sql`UPDATE push_outbox SET status='cancelled',lease_token=NULL,lease_until=NULL,last_error='opted_out'
          WHERE subscription_id=${rows[0].id} AND status='pending'`);
      });
    },
    async claim(): Promise<PushClaim | null> {
      const token = crypto.randomUUID();
      return db.transaction(async (tx) => {
        // Terminalize stale generations/backlog rather than quietly letting them occupy the queue.
        await tx.execute(sql`UPDATE push_outbox o SET status='cancelled',lease_until=NULL,lease_token=NULL,last_error='inactive_or_expired'
          WHERE o.status='pending' AND (o.lease_until IS NULL OR o.lease_until<now()) AND
            (o.created_at<now()-interval '24 hours' OR NOT EXISTS(SELECT 1 FROM push_subscriptions s WHERE s.id=o.subscription_id AND s.enabled AND s.generation=o.generation))`);
        const rows = await tx.execute(sql`WITH next AS (
          SELECT o.notification_id,o.subscription_id FROM push_outbox o
          JOIN push_subscriptions s ON s.id=o.subscription_id AND s.enabled AND s.generation=o.generation
          WHERE o.status='pending' AND o.attempts<5 AND o.available_at<=now() AND (o.lease_until IS NULL OR o.lease_until<now())
          ORDER BY o.available_at,o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1)
          UPDATE push_outbox o SET attempts=o.attempts+1,lease_token=${token},lease_until=now()+interval '30 seconds'
          FROM next WHERE o.notification_id=next.notification_id AND o.subscription_id=next.subscription_id
          RETURNING o.notification_id AS "notificationId",o.subscription_id AS "subscriptionId",o.lease_token AS "leaseToken"`);
        return (rows[0] as PushClaim | undefined) ?? null;
      });
    },
    async deliver(
      claim: PushClaim,
      config: VapidConfig,
      send: PushSend,
    ): Promise<void> {
      await db.transaction(async (tx) => {
        // Subscription lock linearizes opt-out with dispatch: unsubscribe completes only after an
        // already-started bounded send settles. Queued or reactivated-generation work cannot send.
        const rows =
          await tx.execute(sql`SELECT s.encrypted_subscription,s.vapid_public_key,s.enabled,s.generation AS active_generation,
          o.generation,o.attempts,o.status,o.lease_token,o.lease_until>now() AS lease_active
          FROM push_subscriptions s JOIN push_outbox o ON o.subscription_id=s.id
          JOIN user_notifications n ON n.id=o.notification_id AND n.owner_user_id=s.owner_user_id
          WHERE o.notification_id=${claim.notificationId} AND o.subscription_id=${claim.subscriptionId}
          FOR UPDATE OF s,o`);
        const row = rows[0];
        if (
          row?.status !== "pending" ||
          row.lease_token !== claim.leaseToken ||
          row.lease_active !== true
        )
          return;
        const finish = async (status: string, error: string | null) =>
          tx.execute(sql`UPDATE push_outbox
          SET status=${status},last_error=${error},lease_token=NULL,lease_until=NULL,delivered_at=${status === "delivered" ? sql`now()` : sql`NULL`}
          WHERE notification_id=${claim.notificationId} AND subscription_id=${claim.subscriptionId} AND lease_token=${claim.leaseToken}`);
        if (!row.enabled || row.generation !== row.active_generation) {
          await finish("cancelled", "opted_out");
          return;
        }
        if (row.vapid_public_key !== config.publicKey) {
          await finish("dead", "vapid_key_changed");
          return;
        }
        let subscription: PushSubscription | null;
        try {
          subscription = parsePushSubscription(
            JSON.parse(
              await decryptSecret(
                encryptionKey,
                String(row.encrypted_subscription),
              ),
            ),
          );
        } catch {
          subscription = null;
        }
        if (!subscription) {
          await finish("dead", "invalid_subscription");
          return;
        }
        let code: number | null = null;
        try {
          code = (await send(subscription, claim.notificationId, config))
            .statusCode;
        } catch {
          /* No upstream errors or private response bodies enter storage/logs. */
        }
        if (code !== null && code >= 200 && code < 300) {
          await finish("delivered", null);
          return;
        }
        if (code === 404 || code === 410) {
          await tx.execute(
            sql`UPDATE push_subscriptions SET enabled=false,updated_at=clock_timestamp() WHERE id=${claim.subscriptionId}`,
          );
          await finish("dead", "subscription_expired");
          return;
        }
        const retryable =
          code === null || code === 408 || code === 429 || code >= 500;
        if (!retryable || Number(row.attempts) >= 5) {
          await finish(
            "dead",
            code === null ? "transport_failed" : `http_${code}`,
          );
          return;
        }
        const seconds = Math.min(3600, 30 * 2 ** (Number(row.attempts) - 1));
        await tx.execute(sql`UPDATE push_outbox SET lease_token=NULL,lease_until=NULL,available_at=now()+${seconds}*interval '1 second',last_error=${code === null ? "transport_failed" : `http_${code}`}
          WHERE notification_id=${claim.notificationId} AND subscription_id=${claim.subscriptionId} AND lease_token=${claim.leaseToken}`);
      });
    },
    async prune(): Promise<void> {
      await db.execute(sql`UPDATE push_outbox SET status='dead',last_error='attempts_exhausted',lease_until=NULL,lease_token=NULL
        WHERE status='pending' AND attempts>=5 AND (lease_until IS NULL OR lease_until<now())`);
      await db.execute(
        sql`DELETE FROM push_outbox WHERE status<>'pending' AND created_at<now()-interval '30 days'`,
      );
    },
  };
}
