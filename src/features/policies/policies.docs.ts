import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  ackResultSchema,
  createPolicySchema,
  myPolicySchema,
  policySchema,
  trackerSchema,
  updatePolicySchema,
} from './policies.schema.js';

/** OpenAPI registration for the /policies endpoints. */
export const registerPoliciesDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/policies',
    tags: ['Policies'],
    summary: 'The policy library — readable by every signed-in employee',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Policies', z.array(policySchema)),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/policies/mine',
    tags: ['Policies'],
    summary: "The library + the caller's acknowledgement state per policy (me scope)",
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Policies with ack state', z.array(myPolicySchema)),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/policies/{id}/ack',
    tags: ['Policies'],
    summary: 'Sign the CURRENT version of a policy — append-only, one ack per version',
    security: [{ bearerAuth: [] }],
    responses: {
      201: jsonResponse('Acknowledged', ackResultSchema),
      404: errorResponse('Policy not found'),
      409: errorResponse('This version is already acknowledged'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/policies/tracker',
    tags: ['Policies'],
    summary: 'People × ack-required policies grid (hrbp.policies read)',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Tracker', trackerSchema),
      403: errorResponse('No hrbp.policies grant'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/policies',
    tags: ['Policies'],
    summary: 'Add a policy (hrbp.policies create)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(createPolicySchema) },
    responses: {
      201: jsonResponse('Created', policySchema),
      409: errorResponse('A policy with this code already exists'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/policies/{id}/document',
    tags: ['Policies'],
    summary: 'The stored policy PDF, streamed from the database',
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The document (application/pdf)' },
      404: errorResponse('No document stored for this policy'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/policies/{id}/document',
    tags: ['Policies'],
    summary:
      'Store/replace the policy PDF (raw body, ?filename=) — clears the external link (hrbp.policies update)',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Updated policy', policySchema),
      404: errorResponse('Policy not found'),
      422: errorResponse('Empty or missing file body'),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/policies/{id}',
    tags: ['Policies'],
    summary: 'Edit a policy — changing `version` re-asks everyone to acknowledge',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(updatePolicySchema) },
    responses: {
      200: jsonResponse('Updated', policySchema),
      404: errorResponse('Policy not found'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/policies/manage',
    tags: ['Policies'],
    summary: 'Every policy including retired ones, for HR to manage — hrbp.policies read',
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Policies', z.array(policySchema)) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/policies/{id}/retire',
    tags: ['Policies'],
    summary:
      'Retire a policy: hidden from the library and tracker, no longer signable; rows and signatures kept — hrbp.policies update',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Retired', policySchema),
      404: errorResponse('Policy not found'),
      409: errorResponse('Already retired'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/policies/{id}/restore',
    tags: ['Policies'],
    summary: 'Bring a retired policy back — hrbp.policies update',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Restored', policySchema),
      404: errorResponse('Policy not found'),
      409: errorResponse('Not retired'),
    },
  });
};
