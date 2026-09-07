import { sql } from "drizzle-orm";
import type { Database } from "../db/client";

export type InboxNotification = {
  id: string;
  runId: string;
  title: string;
  summary: string;
  status: string;
  createdAt: string;
  readAt: string | null;
};
export type InboxPage = {
  notifications: InboxNotification[];
  unreadCount: number;
  nextOffset: number | null;
};
export type NotificationsStore = {
  list(owner: string, offset?: number): Promise<InboxPage>;
  setRead(owner: string, id: string, read: boolean): Promise<boolean>;
};
export function createNotificationsStore(
  database: Database,
): NotificationsStore {
  return {
    async list(owner, offset = 0) {
      const notifications = (await database.execute(sql`
        SELECT id, run_id AS "runId", title, summary, status, created_at AS "createdAt", read_at AS "readAt"
        FROM user_notifications WHERE owner_user_id=${owner}
        ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ${offset}
      `)) as unknown as InboxNotification[];
      const [count] = (await database.execute(sql`
        SELECT count(*)::integer AS unread FROM user_notifications WHERE owner_user_id=${owner} AND read_at IS NULL
      `)) as unknown as { unread: number }[];
      return {
        notifications: notifications.slice(0, 50),
        unreadCount: count?.unread ?? 0,
        nextOffset: notifications.length > 50 ? offset + 50 : null,
      };
    },
    async setRead(owner, id, read) {
      const rows = await database.execute(sql`
        UPDATE user_notifications SET read_at=${read ? sql`coalesce(read_at,now())` : sql`NULL`}
        WHERE owner_user_id=${owner} AND id=${id} RETURNING id
      `);
      return rows.length === 1;
    },
  };
}
