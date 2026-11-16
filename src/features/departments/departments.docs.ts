import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  addMemberSchema,
  createDepartmentSchema,
  departmentSchema,
  membershipSchema,
  setHeadSchema,
  setLeadSchema,
  updateDepartmentSchema,
} from './departments.schema.js';

const idParams = z.object({ id: z.string().uuid() });

/** OpenAPI registration for the departments endpoints. */
export const registerDepartmentsDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/departments',
    tags: ['Departments'],
    summary:
      'List org units (divisions, departments, chapters) with head, lead and counts',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Departments', z.array(departmentSchema)),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/departments/memberships',
    tags: ['Departments'],
    summary: 'Extra ("also in" / chapter) memberships — display only',
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Memberships', z.array(membershipSchema)) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/departments',
    tags: ['Departments'],
    summary: 'Create a division, department or chapter',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(createDepartmentSchema) },
    responses: {
      201: jsonResponse('Created', departmentSchema),
      409: errorResponse('A unit with this name already exists'),
      422: errorResponse('Parent missing or a chapter; a chapter cannot have a parent'),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/departments/{id}',
    tags: ['Departments'],
    summary: 'Rename, move (parentId null = top level) or change the kind of a unit',
    security: [{ bearerAuth: [] }],
    request: { params: idParams, body: jsonBody(updateDepartmentSchema) },
    responses: {
      200: jsonResponse('Updated', departmentSchema),
      409: errorResponse(
        'Duplicate name, or the unit is in use and cannot become a chapter',
      ),
      422: errorResponse('The move would create a loop, or the parent is invalid'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/departments/{id}/head',
    tags: ['Departments'],
    summary:
      "Seat the department's head (HR may not seat themselves or the HR department's head)",
    security: [{ bearerAuth: [] }],
    request: { params: idParams, body: jsonBody(setHeadSchema) },
    responses: {
      200: jsonResponse('Updated', departmentSchema),
      403: errorResponse('HR department head is Admin-only, or self-seating'),
      409: errorResponse('Already holds the seat'),
      422: errorResponse('A chapter, or the person is not active / is the Admin account'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/departments/{id}/head',
    tags: ['Departments'],
    summary: "Clear the department's head (the seat row is ended, never deleted)",
    security: [{ bearerAuth: [] }],
    request: { params: idParams },
    responses: {
      200: jsonResponse('Updated', departmentSchema),
      403: errorResponse('HR department head is Admin-only'),
      404: errorResponse('No head'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/departments/{id}/members',
    tags: ['Departments'],
    summary: 'Add an extra member ("also in" / chapter member)',
    security: [{ bearerAuth: [] }],
    request: { params: idParams, body: jsonBody(addMemberSchema) },
    responses: {
      201: jsonResponse('Updated', departmentSchema),
      409: errorResponse('Already a member, or it is their home unit'),
      422: errorResponse('Not a current employee'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/departments/memberships/{membershipId}',
    tags: ['Departments'],
    summary: 'Remove an extra membership',
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ membershipId: z.string().uuid() }) },
    responses: {
      200: jsonResponse('Updated', departmentSchema),
      404: errorResponse('Membership not found'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/departments/{id}/lead',
    tags: ['Departments'],
    summary: "Set or clear a chapter's lead (added as a member if needed; no powers)",
    security: [{ bearerAuth: [] }],
    request: { params: idParams, body: jsonBody(setLeadSchema) },
    responses: {
      200: jsonResponse('Updated', departmentSchema),
      422: errorResponse('Not a chapter, or not a current employee'),
    },
  });
};
