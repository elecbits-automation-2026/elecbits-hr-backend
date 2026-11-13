import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonResponse } from '../../docs/helpers.js';
import { auditPageSchema, auditQuerySchema } from './audit.schema.js';

/** OpenAPI registration for the audit-log endpoint. */
export const registerAuditDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/audit-log',
    tags: ['Access'],
    summary:
      'Audit-log entries, newest first, one page at a time (immutable, read-only); q searches action/subject/detail/actor',
    security: [{ bearerAuth: [] }],
    request: { query: auditQuerySchema },
    responses: {
      200: jsonResponse('One page of entries + the total', auditPageSchema),
      400: errorResponse('Bad page / pageSize'),
      401: errorResponse('Not authenticated'),
    },
  });
};
