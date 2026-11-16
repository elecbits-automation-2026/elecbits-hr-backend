import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  assignResultSchema,
  assignTrainingSchema,
  completeTrainingSchema,
  trainingSchema,
} from './trainings.schema.js';

const idParams = z.object({ id: z.string().uuid() });
const list = z.array(trainingSchema);

/** OpenAPI registration for the /trainings endpoints. */
export const registerTrainingsDocs = (registry: OpenAPIRegistry): void => {
  const base = { tags: ['Trainings'], security: [{ bearerAuth: [] }] };

  registry.registerPath({
    ...base,
    method: 'get',
    path: '/api/v1/trainings/mine',
    summary: 'My trainings, open first',
    responses: { 200: jsonResponse('Trainings', list) },
  });
  registry.registerPath({
    ...base,
    method: 'get',
    path: '/api/v1/trainings/team',
    summary: "My reports' trainings",
    responses: { 200: jsonResponse('Trainings', list) },
  });
  registry.registerPath({
    ...base,
    method: 'get',
    path: '/api/v1/trainings',
    summary: "Everyone's trainings (HR, org-wide hrbp.people read)",
    responses: { 200: jsonResponse('Trainings', list), 403: errorResponse('Not HR') },
  });
  registry.registerPath({
    ...base,
    method: 'get',
    path: '/api/v1/trainings/person/{employeeId}',
    summary: "One person's trainings (self, their manager, or HR)",
    request: { params: z.object({ employeeId: z.string().uuid() }) },
    responses: {
      200: jsonResponse('Trainings', list),
      403: errorResponse('Not their manager or HR'),
    },
  });
  registry.registerPath({
    ...base,
    method: 'post',
    path: '/api/v1/trainings',
    summary:
      'Assign a training to one or more people (manager: own reports; HR: anyone in reach)',
    request: { body: jsonBody(assignTrainingSchema) },
    responses: {
      201: jsonResponse('Assigned', assignResultSchema),
      403: errorResponse('Someone is not your report'),
      422: errorResponse('Yourself, the Admin account, a leaver, or a past due date'),
    },
  });
  registry.registerPath({
    ...base,
    method: 'post',
    path: '/api/v1/trainings/{id}/complete',
    summary: 'Mark my training done, with an optional note',
    request: { params: idParams, body: jsonBody(completeTrainingSchema) },
    responses: {
      200: jsonResponse('Completed', trainingSchema),
      409: errorResponse('Not open'),
    },
  });
  for (const [action, summary] of [
    ['reopen', 'Reopen a completed training (assigner, manager or HR)'],
    ['cancel', 'Withdraw an open training (assigner, manager or HR)'],
  ] as const) {
    registry.registerPath({
      ...base,
      method: 'post',
      path: `/api/v1/trainings/{id}/${action}`,
      summary,
      request: { params: idParams },
      responses: {
        200: jsonResponse('Updated', trainingSchema),
        403: errorResponse('Not the assigner, manager or HR'),
        409: errorResponse('Wrong status'),
      },
    });
  }
  registry.registerPath({
    ...base,
    method: 'put',
    path: '/api/v1/trainings/{id}/certificate',
    summary: 'Attach a certificate (PDF / JPG / PNG, up to 10 MB) — the person only',
    request: { params: idParams },
    responses: {
      200: jsonResponse('Stored', trainingSchema),
      422: errorResponse('Wrong type or size'),
    },
  });
  registry.registerPath({
    ...base,
    method: 'get',
    path: '/api/v1/trainings/{id}/certificate',
    summary: 'Open the certificate (person, assigner, manager or HR)',
    request: { params: idParams },
    responses: { 200: { description: 'The file' }, 404: errorResponse('No certificate') },
  });
};
