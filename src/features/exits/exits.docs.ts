import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { ZodType } from 'zod';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  acceptSchema,
  acknowledgeSchema,
  cancelExitSchema,
  clearSchema,
  exitSchema,
  interviewSchema,
  myExitPageSchema,
  resignSchema,
  terminateSchema,
} from './exits.schema.js';

/** OpenAPI registration for the exit endpoints. */
export const registerExitsDocs = (registry: OpenAPIRegistry): void => {
  const p = (
    method: 'get' | 'post',
    path: string,
    summary: string,
    response: ZodType,
    body?: ZodType,
  ) =>
    registry.registerPath({
      method,
      path,
      tags: ['Exits'],
      summary,
      security: [{ bearerAuth: [] }],
      ...(body ? { request: { body: jsonBody(body) } } : {}),
      responses: {
        200: jsonResponse('OK', response),
        401: errorResponse('Not authenticated'),
        403: errorResponse('Not allowed for this caller'),
        404: errorResponse('Not found'),
        409: errorResponse('Not in a state that allows this'),
        422: errorResponse('Invalid'),
      },
    });
  p(
    'get',
    '/api/v1/exits',
    'Exits list (HR in reach, OPS, payroll)',
    z.array(exitSchema),
  );
  p('get', '/api/v1/exits/mine', 'My resignation page', myExitPageSchema);
  p('get', '/api/v1/exits/team', 'Exits of people who report to me', z.array(exitSchema));
  p('get', '/api/v1/exits/{id}', 'One exit', exitSchema);
  p('post', '/api/v1/exits/resign', 'Resign', myExitPageSchema, resignSchema);
  p(
    'post',
    '/api/v1/exits/terminate',
    'HR: start a termination',
    exitSchema,
    terminateSchema,
  );
  p(
    'post',
    '/api/v1/exits/{id}/withdraw',
    'Withdraw (until HR accepts)',
    myExitPageSchema,
  );
  p(
    'post',
    '/api/v1/exits/{id}/acknowledge',
    'Manager: acknowledge + handover plan',
    exitSchema,
    acknowledgeSchema,
  );
  p(
    'post',
    '/api/v1/exits/{id}/accept',
    'HR: accept, fix the last day',
    exitSchema,
    acceptSchema,
  );
  p(
    'post',
    '/api/v1/exits/{id}/cancel',
    'HR: cancel before the last day',
    exitSchema,
    cancelExitSchema,
  );
  p(
    'post',
    '/api/v1/exits/{id}/clear',
    'HR / manager / OPS clearance',
    exitSchema,
    clearSchema,
  );
  p(
    'post',
    '/api/v1/exits/{id}/interview',
    'Exit interview (last day)',
    myExitPageSchema,
    interviewSchema,
  );
  registry.registerPath({
    method: 'get',
    path: '/api/v1/exits/{id}/letters/{which}',
    tags: ['Exits'],
    summary: 'Relieving or experience letter PDF (once settled)',
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'PDF', content: { 'application/pdf': { schema: z.string() } } },
      409: errorResponse('Not settled yet'),
    },
  });
};
