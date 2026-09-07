import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./core";
export const userNotifications = pgTable(
  "user_notifications",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull().unique(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [
    index("user_notifications_owner_created").on(
      table.ownerUserId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index("user_notifications_owner_unread")
      .on(table.ownerUserId)
      .where(sql`${table.readAt} IS NULL`),
  ],
);

export const outboundNotificationPolicy = pgTable(
  "outbound_notification_policy",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    mode: text("mode").notNull().default("telegram"),
  },
);
