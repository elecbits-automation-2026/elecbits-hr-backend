import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import { auditEntrySchema } from './audit.schema.js';

/** OpenAPI registration for the audit-log endpoint. */
export const registerAuditDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/audit-log',
    tags: ['Access'],
    summary: 'Recent audit-log entries (immutable, read-only)',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Entries', z.array(auditEntrySchema)),
      401: errorResponse('Not authenticated'),
    },
  });
};
