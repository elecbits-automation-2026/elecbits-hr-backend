import { and, count, desc, eq, isNull } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { notifications } from '../../db/schema/index.js';

export type NotificationRow = typeof notifications.$inferSelect;

/** One event to announce; fanned out to every recipient. */
export interface NotificationEvent {
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
}

/**
 * The WRITE side other features use: call it with the transaction that makes
 * the change, so the bell rows land (or roll back) with the event itself —
 * the same pattern as the audit row.
 */
export const insertNotifications = async (
  db: DbClient,
  recipientIds: string[],
  event: NotificationEvent,
): Promise<number> => {
  const unique = [...new Set(recipientIds)];
  if (unique.length === 0) return 0;
  await db.orm.insert(notifications).values(
    unique.map((recipientId) => ({
      recipientId,
      type: event.type,
      title: event.title,
      body: event.body ?? null,
      link: event.link ?? null,
    })),
  );
  return unique.length;
};

/** The READ side: one person's bell. Every query is keyed to the recipient. */
export const createNotificationsRepository = (db: DbClient) => ({
  listForRecipient: async (
    recipientId: string,
    limit: number,
  ): Promise<NotificationRow[]> =>
    db.orm
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, recipientId))
      .orderBy(desc(notifications.createdAt))
      .limit(limit),

  unreadCount: async (recipientId: string): Promise<number> => {
    const rows = await db.orm
      .select({ n: count() })
      .from(notifications)
      .where(
        and(eq(notifications.recipientId, recipientId), isNull(notifications.readAt)),
      );
    return Number(rows[0]?.n ?? 0);
  },

  /**
   * Mark one of the recipient's own notifications read. Returns false when it
   * isn't theirs; an already-read row stays as it was (idempotent).
   */
  markRead: async (recipientId: string, id: string): Promise<boolean> => {
    const own = await db.orm
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.recipientId, recipientId)))
      .limit(1);
    if (own.length === 0) return false;
    await db.orm
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), isNull(notifications.readAt)));
    return true;
  },

  markAllRead: async (recipientId: string): Promise<void> => {
    await db.orm
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(eq(notifications.recipientId, recipientId), isNull(notifications.readAt)),
      );
  },
});

export type NotificationsRepository = ReturnType<typeof createNotificationsRepository>;
