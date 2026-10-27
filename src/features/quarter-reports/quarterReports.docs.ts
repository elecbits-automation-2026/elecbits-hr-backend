import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  adjustScoreSchema,
  closeCycleSchema,
  quarterCycleSchema,
  quarterReportSchema,
  quarterViewSchema,
} from './quarterReports.schema.js';

const bearer = [{ bearerAuth: [] }];

/** OpenAPI registration for the /quarter-reports endpoints. */
export const registerQuarterReportsDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/quarter-reports/cycles',
    tags: ['Quarter reports'],
    summary: 'Every quarter on record with its close state and report count',
    security: bearer,
    responses: { 200: jsonResponse('Quarters', z.array(quarterCycleSchema)) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/quarter-reports/cycles/{name}/close',
    tags: ['Quarter reports'],
    summary:
      'Close a quarter (e.g. 2026-Q4): freeze goals and write one report per person (hrbp.people update, org)',
    security: bearer,
    request: { body: jsonBody(closeCycleSchema) },
    responses: {
      200: jsonResponse('Closed quarter', quarterCycleSchema),
      409: errorResponse(
        'Already closed, or the quarter is still running without early: true',
      ),
      422: errorResponse('Quarter has not started'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/quarter-reports/cycles/{name}',
    tags: ['Quarter reports'],
    summary:
      "A quarter's reports the caller may see (their people as manager at close + their hrbp.people reach) with a per-team overview; ?as=rm limits it to their own people",
    security: bearer,
    request: { query: z.object({ as: z.enum(['rm']).optional() }) },
    responses: { 200: jsonResponse('Quarter view', quarterViewSchema) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/quarter-reports/mine',
    tags: ['Quarter reports'],
    summary: 'Own quarter reports, newest first (me scope)',
    security: bearer,
    responses: { 200: jsonResponse('Reports', z.array(quarterReportSchema)) },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/quarter-reports/{id}/score',
    tags: ['Quarter reports'],
    summary:
      'Set the final score with a reason (manager at close, or HR whose grant reaches them)',
    security: bearer,
    request: { body: jsonBody(adjustScoreSchema) },
    responses: {
      200: jsonResponse('Report', quarterReportSchema),
      403: errorResponse('Not their manager or HR, or your own report'),
      404: errorResponse('Report not found'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/quarter-reports/people/{employeeId}',
    tags: ['Quarter reports'],
    summary:
      "One person's reports — the person, their manager or HR whose grant reaches them see all; an earlier manager sees the quarters they managed",
    security: bearer,
    responses: { 200: jsonResponse('Reports', z.array(quarterReportSchema)) },
  });
};
