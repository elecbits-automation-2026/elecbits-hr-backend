import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import {
  acceptPrivacySchema,
  myDataExportSchema,
  privacyStatusSchema,
  retentionPreviewSchema,
} from './privacy.schema.js';

const bearer = [{ bearerAuth: [] }];

/** OpenAPI registration for the privacy endpoints (DPDP, report M12). */
export const registerPrivacyDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/me/privacy',
    tags: ['Privacy'],
    summary:
      'The current privacy notice and whether you still need to accept it (me scope)',
    security: bearer,
    responses: { 200: jsonResponse('Privacy status', privacyStatusSchema) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/me/privacy/accept',
    tags: ['Privacy'],
    summary: 'Accept the current privacy notice version (me scope)',
    security: bearer,
    request: { body: jsonBody(acceptPrivacySchema) },
    responses: {
      200: jsonResponse('Privacy status after accepting', privacyStatusSchema),
      409: errorResponse('PRIVACY_NOTICE_CHANGED — a newer version must be read first'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/me/export',
    tags: ['Privacy'],
    summary: 'Download everything the HRMS holds about you, as JSON (me scope)',
    security: bearer,
    responses: { 200: jsonResponse('Your data', myDataExportSchema) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/admin/privacy/retention',
    tags: ['Privacy'],
    summary:
      'Retention periods, the purge switch and what the purge would remove today (access.settings, org)',
    security: bearer,
    responses: { 200: jsonResponse('Retention preview', retentionPreviewSchema) },
  });
};
