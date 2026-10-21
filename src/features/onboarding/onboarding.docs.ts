import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  journeySchema,
  myJourneySchema,
  queueRowSchema,
  startJourneySchema,
  teamTaskSchema,
} from './onboarding.schema.js';

/** OpenAPI registration for the /onboarding endpoints. */
export const registerOnboardingDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/onboarding/team-tasks/{owner}',
    tags: ['Onboarding'],
    summary: 'OPS (ops) or payroll (payroll): joiner tasks waiting on the team',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Tasks', z.array(teamTaskSchema)),
      403: errorResponse('Not an OPS / payroll holder'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/onboarding/mine',
    tags: ['Onboarding'],
    summary: 'Own journey — auto-created for recent joiners; null when it does not apply',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Journey or null', myJourneySchema),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/onboarding/tasks/{id}/toggle',
    tags: ['Onboarding'],
    summary: "Tick/untick a step — only the task's owner (or broad HR); policy steps 409",
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Updated journey', journeySchema),
      403: errorResponse('Not the task owner'),
      409: errorResponse('Policy-linked step — completed by acknowledging the policy'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/onboarding',
    tags: ['Onboarding'],
    summary: 'Who is onboarding — progress and days left (hrbp.people read)',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Queue', z.array(queueRowSchema)),
      403: errorResponse('No hrbp.people grant'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/onboarding/employee/{employeeId}',
    tags: ['Onboarding'],
    summary: "One hire's journey — the HR drill-in (hrbp.people read)",
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Journey', journeySchema),
      404: errorResponse('No journey for this employee'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/onboarding',
    tags: ['Onboarding'],
    summary: 'Start a journey by hand (hrbp.people update) — one per person',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(startJourneySchema) },
    responses: {
      201: jsonResponse('Created', journeySchema),
      409: errorResponse('A journey already exists for this person'),
    },
  });
};
