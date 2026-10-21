import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createNotificationsRepository } from './notifications.repository.js';
import { notificationListQuerySchema } from './notifications.schema.js';
import { createNotificationsService } from './notifications.service.js';

/** Composition root: request-scoped service. */
const service = (req: Request) =>
  createNotificationsService({ repo: createNotificationsRepository(req.db) });

/** HTTP layer only: every call is about the caller's own bell. */
export const notificationsController = {
  list: async (req: Request, res: Response): Promise<void> => {
    const parsed = notificationListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw createError(400, 'Invalid limit');
    res.json(await service(req).list(req.auth!.employeeId, parsed.data.limit));
  },

  unreadCount: async (req: Request, res: Response): Promise<void> => {
    res.json({ unreadCount: await service(req).unreadCount(req.auth!.employeeId) });
  },

  markRead: async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!isUuid(id)) throw createError(400, 'Invalid notification id');
    res.json({ unreadCount: await service(req).markRead(req.auth!.employeeId, id) });
  },

  markAllRead: async (req: Request, res: Response): Promise<void> => {
    res.json({ unreadCount: await service(req).markAllRead(req.auth!.employeeId) });
  },
};
