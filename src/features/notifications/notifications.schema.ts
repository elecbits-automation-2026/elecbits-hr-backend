import { z } from '../../shared/zod.js';

export const notificationSchema = z
  .object({
    id: z.string().uuid(),
    /** Event key, e.g. 'policy.reack'. */
    type: z.string(),
    title: z.string(),
    body: z.string().nullable(),
    /** In-app path to open on click. */
    link: z.string().nullable(),
    createdAt: z.string().datetime(),
    readAt: z.string().datetime().nullable(),
  })
  .openapi('Notification');

/** GET /notifications — newest first, plus the unread total for the badge. */
export const notificationListSchema = z
  .object({
    items: z.array(notificationSchema),
    unreadCount: z.number().int(),
  })
  .openapi('NotificationList');

export const notificationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const unreadCountSchema = z
  .object({ unreadCount: z.number().int() })
  .openapi('NotificationUnreadCount');

export type NotificationDto = z.infer<typeof notificationSchema>;
export type NotificationListDto = z.infer<typeof notificationListSchema>;
