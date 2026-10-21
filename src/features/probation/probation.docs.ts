import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { ZodType } from 'zod';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  decideSchema,
  probationReviewSchema,
  recommendSchema,
} from './probation.schema.js';

/** OpenAPI registration for the probation endpoints. */
export const registerProbationDocs = (registry: OpenAPIRegistry): void => {
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
      tags: ['Probation'],
      summary,
      security: [{ bearerAuth: [] }],
      ...(body ? { request: { body: jsonBody(body) } } : {}),
      responses: {
        200: jsonResponse('OK', response),
        403: errorResponse('Not allowed'),
        404: errorResponse('Not found'),
        409: errorResponse('Already decided'),
      },
    });
  p(
    'get',
    '/api/v1/probation',
    'Probation reviews I can see',
    z.array(probationReviewSchema),
  );
  p(
    'get',
    '/api/v1/probation/mine',
    'My probation review',
    probationReviewSchema.nullable(),
  );
  p(
    'post',
    '/api/v1/probation/{id}/recommend',
    'RM: recommend confirm or end',
    probationReviewSchema,
    recommendSchema,
  );
  p(
    'post',
    '/api/v1/probation/{id}/decide',
    'HR: confirm, or end (starts a termination)',
    probationReviewSchema,
    decideSchema,
  );
  registry.registerPath({
    method: 'get',
    path: '/api/v1/probation/{id}/letter',
    tags: ['Probation'],
    summary: 'Confirmation letter PDF',
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'PDF', content: { 'application/pdf': { schema: z.string() } } },
    },
  });
};
