import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  listSettingsQuerySchema,
  publicSettingsSchema,
  settingSchema,
  updateSettingSchema,
} from './settings.schema.js';

/** OpenAPI registration for the /settings endpoints. */
export const registerSettingsDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/settings',
    tags: ['Settings'],
    summary:
      "Org-tunable settings the caller may read, with effective values (override or code default) — access.settings, or the area's owning module",
    security: [{ bearerAuth: [] }],
    request: { query: listSettingsQuerySchema },
    responses: {
      200: jsonResponse('Settings (empty when none readable)', z.array(settingSchema)),
      400: errorResponse('Unknown area'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/settings/public',
    tags: ['Settings'],
    summary:
      'Effective values of the public keys (employee-side hints) — any signed-in user',
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Public settings', publicSettingsSchema) },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/settings/{key}',
    tags: ['Settings'],
    summary:
      "Override one setting — needs update on access.settings or the key's area module; value validated against the key's registry schema",
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(updateSettingSchema) },
    responses: {
      200: jsonResponse('Updated', settingSchema),
      403: errorResponse('Not allowed to change this setting'),
      404: errorResponse('Unknown setting'),
      422: errorResponse('Value fails the setting schema'),
    },
  });
};
