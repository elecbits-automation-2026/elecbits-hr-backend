import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { notificationsController } from './notifications.controller.js';

/**
 * The bell — mounted at /api/v1/notifications. `me` scope only: no
 * requireAccess, the caller only ever sees and clears their own rows.
 *
 *   GET  /               -> 200 { items, unreadCount }  (?limit=1..50, default 20)
 *   GET  /unread-count   -> 200 { unreadCount }         (the badge poll)
 *   POST /read-all       -> 200 { unreadCount: 0 }
 *   POST /:id/read       -> 200 { unreadCount }         (404 if not the caller's)
 */
export const notificationsRoutes = Router();

notificationsRoutes.use(authenticate);

notificationsRoutes.get('/', notificationsController.list);
notificationsRoutes.get('/unread-count', notificationsController.unreadCount);
notificationsRoutes.post('/read-all', notificationsController.markAllRead);
notificationsRoutes.post('/:id/read', notificationsController.markRead);
