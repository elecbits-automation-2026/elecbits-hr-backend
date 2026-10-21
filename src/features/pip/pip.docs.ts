import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { ZodType } from 'zod';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  cancelPipSchema,
  createCheckinSchema,
  createPipSchema,
  decidePipSchema,
  pipOutcomeSchema,
  pipSchema,
} from './pip.schema.js';

/** OpenAPI registration for the PIP endpoints. */
export const registerPipDocs = (registry: OpenAPIRegistry): void => {
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
      tags: ['PIP'],
      summary,
      security: [{ bearerAuth: [] }],
      ...(body ? { request: { body: jsonBody(body) } } : {}),
      responses: {
        200: jsonResponse('OK', response),
        403: errorResponse('Not allowed'),
        404: errorResponse('Not found'),
        409: errorResponse('Not in a state that allows this'),
      },
    });
  p('get', '/api/v1/pips', 'PIPs I can see', z.array(pipSchema));
  p('post', '/api/v1/pips', 'RM: open a PIP', pipSchema, createPipSchema);
  p('get', '/api/v1/pips/{id}', 'One PIP', pipSchema);
  p(
    'post',
    '/api/v1/pips/{id}/decide',
    'HR: approve or decline',
    pipSchema,
    decidePipSchema,
  );
  p('post', '/api/v1/pips/{id}/acknowledge', 'Employee: acknowledge', pipSchema);
  p(
    'post',
    '/api/v1/pips/{id}/checkins',
    'RM: log a check-in',
    pipSchema,
    createCheckinSchema,
  );
  p(
    'post',
    '/api/v1/pips/{id}/outcome',
    'RM: passed / extend / not passed',
    pipSchema,
    pipOutcomeSchema,
  );
  p('post', '/api/v1/pips/{id}/cancel', 'Withdraw', pipSchema, cancelPipSchema);
};
