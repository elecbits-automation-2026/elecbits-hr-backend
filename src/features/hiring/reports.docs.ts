import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  hiringReportSchema,
  pendingActionSchema,
  TRACKER_VIEWS,
  trackerRowSchema,
} from './reports.schema.js';

/** OpenAPI registration for the TA tracker report and the hiring trackers. */
export const registerReportsDocs = (registry: OpenAPIRegistry): void => {
  const security = [{ bearerAuth: [] }];
  const tags = ['Hiring — reports'];

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/report',
    tags,
    summary: 'Role × SPOC activity and outcomes over a period (TA)',
    security,
    request: { query: z.object({ from: z.string().date(), to: z.string().date() }) },
    responses: {
      200: jsonResponse('Report', hiringReportSchema),
      400: errorResponse('Missing or reversed period'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/pending-actions',
    tags,
    summary: 'Open next actions by owner and due date, overdue flagged (TA)',
    security,
    responses: { 200: jsonResponse('Pending', z.array(pendingActionSchema)) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/tracker',
    tags,
    summary:
      'Hiring tracker — internal (TA / HR, every field) or external (no contacts / CTC; dept heads see their departments)',
    security,
    request: { query: z.object({ view: z.enum(TRACKER_VIEWS) }) },
    responses: {
      200: jsonResponse('Tracker', z.array(trackerRowSchema)),
      403: errorResponse('The internal view needs the TA grant'),
    },
  });
};
