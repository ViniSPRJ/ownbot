import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { userNotifications } from "./notifications";

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpointHash: text("endpoint_hash").notNull().unique(),
    encryptedSubscription: text("encrypted_subscription").notNull(),
    vapidPublicKey: text("vapid_public_key").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    generation: integer("generation").notNull().default(1),
    optedInAt: timestamp("opted_in_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [index("push_subscriptions_owner").on(t.ownerUserId)],
);

export const pushOutbox = pgTable(
  "push_outbox",
  {
    notificationId: text("notification_id")
      .notNull()
      .references(() => userNotifications.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => pushSubscriptions.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.notificationId, t.subscriptionId] }),
    index("push_outbox_due")
      .on(t.availableAt)
      .where(sql`${t.status}='pending'`),
  ],
);
