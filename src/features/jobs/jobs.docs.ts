import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonResponse } from '../../docs/helpers.js';
import { jobRunSchema, jobsOverviewSchema } from './jobs.schema.js';

const bearer = [{ bearerAuth: [] }];

/** OpenAPI registration for the /admin/jobs endpoints. */
export const registerJobsDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/admin/jobs',
    tags: ['Background jobs'],
    summary:
      'Scheduler on/off, the registered jobs and the latest runs (access.settings, org)',
    security: bearer,
    responses: { 200: jsonResponse('Jobs overview', jobsOverviewSchema) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/admin/jobs/{name}/run',
    tags: ['Background jobs'],
    summary: 'Run a job now, e.g. approval-reminders (access.settings update, org)',
    security: bearer,
    responses: {
      200: jsonResponse('The run', jobRunSchema),
      404: errorResponse('No such job'),
    },
  });
};
