import createError from 'http-errors';
import type {
  NotificationRow,
  NotificationsRepository,
} from './notifications.repository.js';
import type { NotificationDto, NotificationListDto } from './notifications.schema.js';

const DEFAULT_LIMIT = 20;

const toDto = (row: NotificationRow): NotificationDto => ({
  id: row.id,
  type: row.type,
  title: row.title,
  body: row.body,
  link: row.link,
  createdAt: row.createdAt.toISOString(),
  readAt: row.readAt?.toISOString() ?? null,
});

/**
 * The bell (refinement plan X2). Strictly `me`-scoped: every read and write
 * is keyed to the caller's own employee id, so there is no grant to check —
 * nobody can see or clear anyone else's notifications. Rows are WRITTEN by
 * the features that own the events (insertNotifications, inside their own
 * transactions), never through this API.
 */
export const createNotificationsService = (deps: { repo: NotificationsRepository }) => {
  const { repo } = deps;

  const list = async (
    recipientId: string,
    limit = DEFAULT_LIMIT,
  ): Promise<NotificationListDto> => {
    const [rows, unreadCount] = await Promise.all([
      repo.listForRecipient(recipientId, limit),
      repo.unreadCount(recipientId),
    ]);
    return { items: rows.map(toDto), unreadCount };
  };

  const unreadCount = async (recipientId: string): Promise<number> =>
    repo.unreadCount(recipientId);

  /** Returns the unread total afterwards, so the badge updates in one trip. */
  const markRead = async (recipientId: string, id: string): Promise<number> => {
    if (!(await repo.markRead(recipientId, id))) {
      throw createError(404, 'Notification not found', {
        code: 'NOTIFICATION_NOT_FOUND',
      });
    }
    return repo.unreadCount(recipientId);
  };

  const markAllRead = async (recipientId: string): Promise<number> => {
    await repo.markAllRead(recipientId);
    return 0;
  };

  return { list, unreadCount, markRead, markAllRead };
};

export type NotificationsService = ReturnType<typeof createNotificationsService>;
