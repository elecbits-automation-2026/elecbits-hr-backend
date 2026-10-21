import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  createGrantRequestSchema,
  decideGrantRequestSchema,
  grantRequestSchema,
} from './requests.schema.js';

/** OpenAPI registration for the grant-request endpoints. */
export const registerGrantRequestsDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/grant-requests',
    tags: ['Access'],
    summary:
      "Admin's queue: every grant request with what was asked and granted — access.requests read",
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Requests', z.array(grantRequestSchema)),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/grant-requests/options',
    tags: ['Access'],
    summary: 'Batches HR may propose in a request (every batch but Employee) — HR only',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse(
        'Batches',
        z.array(
          z.object({
            id: z.string().uuid(),
            name: z.string(),
            description: z.string().nullable(),
          }),
        ),
      ),
      403: errorResponse('Not HR'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/grant-requests/mine',
    tags: ['Access'],
    summary: 'Requests the caller raised',
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Requests', z.array(grantRequestSchema)) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/grant-requests',
    tags: ['Access'],
    summary:
      'HR asks the Owner for extra access for one person (broad hrbp.people update; never for yourself)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(createGrantRequestSchema) },
    responses: {
      201: jsonResponse('Created', grantRequestSchema),
      403: errorResponse('Not HR, or a request for yourself'),
      422: errorResponse(
        'Unknown batch/module, the administration account, or the caller is Admin (ASSIGN_DIRECTLY)',
      ),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/grant-requests/{id}/decision',
    tags: ['Access'],
    summary: 'Decide a request (approve, approve narrower, or decline)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(decideGrantRequestSchema) },
    responses: {
      200: jsonResponse('Decided', grantRequestSchema),
      403: errorResponse('Self-approval rejected'),
      409: errorResponse('Already decided'),
      422: errorResponse('Granted more than was asked'),
    },
  });
};
