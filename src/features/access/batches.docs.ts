import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  assignBatchSchema,
  batchHolderSchema,
  batchSchema,
  moduleSchema,
  upsertBatchSchema,
} from './batches.schema.js';

/** OpenAPI registration for the batches endpoints. */
export const registerBatchesDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/batches',
    tags: ['Access'],
    summary: 'List access batches with their grants',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Batches', z.array(batchSchema)),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/batches/modules',
    tags: ['Access'],
    summary: 'List seeded access modules (the batch composer pick-list)',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Modules', z.array(moduleSchema)),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/batches',
    tags: ['Access'],
    summary: 'Create a batch (edits apply live to all holders)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(upsertBatchSchema) },
    responses: { 201: jsonResponse('Created', batchSchema) },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/batches/{id}',
    tags: ['Access'],
    summary: 'Replace a batch name/description/grants — applies live to every holder',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(upsertBatchSchema) },
    responses: {
      200: jsonResponse('Updated', batchSchema),
      404: errorResponse('Batch not found'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/batches/{id}/holders',
    tags: ['Access'],
    summary: 'List employees currently holding a batch',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Holders', z.array(batchHolderSchema)),
      404: errorResponse('Batch not found'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/batches/{id}/assign',
    tags: ['Access'],
    summary: 'Attach a batch to an employee',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(assignBatchSchema) },
    responses: {
      204: { description: 'Assigned' },
      403: errorResponse('Outside assignable list or self-approval'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/batches/{id}/assign/{employeeId}',
    tags: ['Access'],
    summary: 'Revoke a batch from an employee (takes effect immediately)',
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Revoked' },
      403: errorResponse('Self-approval blocked'),
      404: errorResponse('Batch not found or not held'),
    },
  });
};
