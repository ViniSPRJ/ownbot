import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
export const openbotServiceHealth = pgTable("openbot_service_health", {
  name: text("name").primaryKey(),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
