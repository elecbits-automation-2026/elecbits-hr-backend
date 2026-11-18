import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonResponse } from '../../docs/helpers.js';
import { emailRetrySchema, emailStatusSchema, emailTestSchema } from './email.schema.js';

const bearer = [{ bearerAuth: [] }];

/** OpenAPI registration for the /admin/email endpoints. */
export const registerEmailDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/admin/email',
    tags: ['Email'],
    summary:
      'Email switch, driver, outbox counts and recent failures (access.settings, org)',
    security: bearer,
    responses: { 200: jsonResponse('Email status', emailStatusSchema) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/admin/email/retry-failed',
    tags: ['Email'],
    summary: 'Put every failed email back in the queue (access.settings update, org)',
    security: bearer,
    responses: { 200: jsonResponse('How many were re-queued', emailRetrySchema) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/admin/email/test',
    tags: ['Email'],
    summary:
      'Send a test email to your own address now, even while delivery is off (access.settings update, org)',
    security: bearer,
    responses: {
      200: jsonResponse('Where it went', emailTestSchema),
      422: errorResponse('Your account has no email address'),
      502: errorResponse('The driver could not send it — the message says why'),
    },
  });
};
