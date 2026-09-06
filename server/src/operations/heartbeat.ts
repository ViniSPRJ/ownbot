import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
export async function recordServiceHeartbeat(database: Database, name: string) {
  await database.execute(sql`INSERT INTO openbot_service_health(name,last_ok_at) VALUES (${name},now())
    ON CONFLICT(name) DO UPDATE SET last_ok_at=excluded.last_ok_at`);
}
