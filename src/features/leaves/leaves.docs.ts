import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  createLeaveRequestSchema,
  decideLeaveSchema,
  leaveBalanceSchema,
  leaveRequestSchema,
} from './leaves.schema.js';

/** OpenAPI registration for the leaves endpoints. */
export const registerLeavesDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/leaves/mine',
    tags: ['Leaves'],
    summary: 'Own leave requests (me scope)',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('LeaveRequests', z.array(leaveRequestSchema)),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/leaves/balances',
    tags: ['Leaves'],
    summary: 'Own yearly balances (?year=; unpaid is uncapped)',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('LeaveBalances', z.array(leaveBalanceSchema)),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/leaves/team/{employeeId}/balances',
    tags: ['Leaves'],
    summary:
      "A report's balances for the RM person sheet (effective RM or broad hrbp.leaves; menstrual stripped — confidential)",
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('LeaveBalances', z.array(leaveBalanceSchema)),
      403: errorResponse('Not their RM / not HR'),
      404: errorResponse('Employee not found'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/leaves/team',
    tags: ['Leaves'],
    summary: 'Requests of people the caller is the effective RM for',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('LeaveRequests', z.array(leaveRequestSchema)),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/leaves',
    tags: ['Leaves'],
    summary: 'HR queue (?status=; requires hrbp.leaves read)',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('LeaveRequests', z.array(leaveRequestSchema)),
      401: errorResponse('Not authenticated'),
      403: errorResponse('Not allowed'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/leaves',
    tags: ['Leaves'],
    summary: 'Raise a leave request (caller is the subject)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(createLeaveRequestSchema) },
    responses: {
      201: jsonResponse('Raised', leaveRequestSchema),
      401: errorResponse('Not authenticated'),
      409: errorResponse('Overlapping leave or insufficient balance'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/leaves/{id}/cancel',
    tags: ['Leaves'],
    summary: 'Cancel an own request while not fully approved',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Cancelled', leaveRequestSchema),
      403: errorResponse('Not your request'),
      404: errorResponse('Not found'),
      409: errorResponse('Already decided'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/leaves/{id}/decision',
    tags: ['Leaves'],
    summary: 'Approve or decline (dual approval: RM + HRBP, any order)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(decideLeaveSchema) },
    responses: {
      200: jsonResponse('Decided', leaveRequestSchema),
      403: errorResponse('Not an approver / self-approval'),
      404: errorResponse('Not found'),
      409: errorResponse('Already decided or insufficient balance'),
    },
  });
};
