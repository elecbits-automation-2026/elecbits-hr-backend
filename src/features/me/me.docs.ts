import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import {
  meSchema,
  myAssetSchema,
  myExitSchema,
  salarySchema,
  teamMemberSchema,
  updateMeSchema,
} from './me.schema.js';
import { z } from '../../shared/zod.js';

/** OpenAPI registration for the /me endpoints. */
export const registerMeDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/me',
    tags: ['Me'],
    summary: "The signed-in employee's own profile and held batches",
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Me', meSchema),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/me',
    tags: ['Me'],
    summary: 'Self-serve profile edit (personal identity fields only)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(updateMeSchema) },
    responses: {
      200: jsonResponse('Me', meSchema),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/me/team',
    tags: ['Me'],
    summary:
      "The caller's chain (reports + approver-only), sanitized — no salary/personal data",
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('TeamMembers', z.array(teamMemberSchema)),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/me/salary',
    tags: ['Me'],
    summary: 'Own salary + bank details (me scope — never another employee’s)',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('EmployeeSalary', salarySchema),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/me/assets',
    tags: ['Me'],
    summary: 'Assets currently in own custody',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('MyAsset[]', z.array(myAssetSchema)),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/me/exit',
    tags: ['Me'],
    summary: 'Own exit record, or null when none exists',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('MyExit', myExitSchema),
      401: errorResponse('Not authenticated'),
    },
  });
};
