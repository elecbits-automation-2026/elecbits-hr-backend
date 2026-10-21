import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import { createDepartmentSchema, departmentSchema } from './departments.schema.js';

/** OpenAPI registration for the departments endpoints. */
export const registerDepartmentsDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/departments',
    tags: ['Departments'],
    summary: 'List the department tree',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Departments', z.array(departmentSchema)),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/departments',
    tags: ['Departments'],
    summary: 'Create a department',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(createDepartmentSchema) },
    responses: {
      201: jsonResponse('Created', departmentSchema),
      422: errorResponse('Parent department does not exist'),
    },
  });
};
