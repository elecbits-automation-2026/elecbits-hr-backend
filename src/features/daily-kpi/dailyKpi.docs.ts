import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonResponse } from '../../docs/helpers.js';
import { dailyKpiQuerySchema, dailyKpiSchema } from './dailyKpi.schema.js';

/** OpenAPI registration for the /daily-kpi endpoints. */
export const registerDailyKpiDocs = (registry: OpenAPIRegistry): void => {
  const paths = [
    ['/api/v1/daily-kpi/mine', 'Your own day against the record'],
    ['/api/v1/daily-kpi/team', "Your reports' day, worst first"],
    [
      '/api/v1/daily-kpi/org',
      "Everyone's day, worst first (HR, org-wide hrbp.people read)",
    ],
  ] as const;
  for (const [path, summary] of paths) {
    registry.registerPath({
      method: 'get',
      path,
      tags: ['Daily KPI'],
      summary,
      security: [{ bearerAuth: [] }],
      request: { query: dailyKpiQuerySchema },
      responses: {
        200: jsonResponse('Daily KPI', dailyKpiSchema),
        400: errorResponse('date is not YYYY-MM-DD'),
        422: errorResponse('A future day, or more than 60 days back'),
      },
    });
  }
};
