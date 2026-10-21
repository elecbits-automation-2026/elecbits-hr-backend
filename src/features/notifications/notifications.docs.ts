import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonResponse } from '../../docs/helpers.js';
import {
  notificationListQuerySchema,
  notificationListSchema,
  unreadCountSchema,
} from './notifications.schema.js';

/** OpenAPI registration for the /notifications endpoints (the bell). */
export const registerNotificationsDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/notifications',
    tags: ['Notifications'],
    summary: "The caller's notifications, newest first, with the unread total",
    security: [{ bearerAuth: [] }],
    request: { query: notificationListQuerySchema },
    responses: { 200: jsonResponse('Notifications', notificationListSchema) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/notifications/unread-count',
    tags: ['Notifications'],
    summary: 'Unread total for the bell badge',
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Unread count', unreadCountSchema) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/notifications/read-all',
    tags: ['Notifications'],
    summary: "Mark every one of the caller's notifications read",
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Unread count (0)', unreadCountSchema) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/notifications/{id}/read',
    tags: ['Notifications'],
    summary: 'Mark one notification read (idempotent)',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Unread count after', unreadCountSchema),
      404: errorResponse("Not one of the caller's notifications"),
    },
  });
};
