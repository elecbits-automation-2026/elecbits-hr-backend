import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  createGoalSchema,
  goalSchema,
  myGoalsSchema,
  myUpdatesSchema,
  submitUpdateSchema,
  teamGoalsRowSchema,
  teamUpdatesRowSchema,
  updateProgressSchema,
  workUpdateSchema,
  updateGoalSchema,
  decideLateSchema,
  lateUpdateSchema,
} from './performance.schema.js';

/** OpenAPI registration for the /goals and /work-updates endpoints. */
export const registerPerformanceDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/goals/mine',
    tags: ['Performance'],
    summary: 'Own quarterly goals + attainment (Σ progress×weight / Σ weight)',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('My goals', myGoalsSchema),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/goals/team',
    tags: ['Performance'],
    summary: "The caller's chain: goal count, attainment, at-risk per person",
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Team', z.array(teamGoalsRowSchema)) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/goals/team/{employeeId}',
    tags: ['Performance'],
    summary: "One report's full goal sheet (effective RM or broad HR — service-gated)",
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Their goals', myGoalsSchema),
      403: errorResponse('Not their RM / not HR'),
      404: errorResponse('Employee not found'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/goals',
    tags: ['Performance'],
    summary: 'Set a goal for a report (RM-or-HR; never yourself)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(createGoalSchema) },
    responses: {
      201: jsonResponse('Created', goalSchema),
      403: errorResponse('Not the RM / not HR / self-goal'),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/goals/{id}/progress',
    tags: ['Performance'],
    summary: 'Move progress — the goal OWNER only',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(updateProgressSchema) },
    responses: {
      200: jsonResponse('Updated', goalSchema),
      403: errorResponse('Only the owner moves progress'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/work-updates/team/{employeeId}',
    tags: ['Performance'],
    summary:
      "One report's recent updates (?days=14; effective RM or broad HR — service-gated)",
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Their updates', z.array(workUpdateSchema)),
      403: errorResponse('Not their RM / not HR'),
      404: errorResponse('Employee not found'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/work-updates/mine',
    tags: ['Performance'],
    summary: 'Own daily updates (?days=14) + whether AI scoring is on',
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('My updates', myUpdatesSchema) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/work-updates/team',
    tags: ['Performance'],
    summary: "The chain's update sheet (?days=7) — read-only for the RM",
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Team sheet', z.array(teamUpdatesRowSchema)) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/work-updates',
    tags: ['Performance'],
    summary:
      "Submit TODAY's update (resubmit replaces + rescores); scored against own goals, null when scoring is off or fails — never 0",
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(submitUpdateSchema) },
    responses: { 201: jsonResponse('Stored', workUpdateSchema) },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/goals/{id}',
    tags: ['Performance'],
    summary:
      "Edit a goal's definition — the owner's RM or HR, open quarter only (progress stays the owner's)",
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(updateGoalSchema) },
    responses: {
      200: jsonResponse('Goal', goalSchema),
      403: errorResponse('Not their RM or HR'),
      409: errorResponse('The quarter is closed'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/goals/{id}',
    tags: ['Performance'],
    summary: "Delete a goal — the owner's RM or HR, open quarter only; audited",
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Deleted' },
      403: errorResponse('Not their RM or HR'),
      409: errorResponse('The quarter is closed'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/work-updates/late',
    tags: ['Performance'],
    summary: 'Late entries for missed days waiting on the caller (their effective RM)',
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Late entries', z.array(lateUpdateSchema)) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/work-updates/{id}/late-decision',
    tags: ['Performance'],
    summary: "Approve (clears the miss) or decline a late entry — the person's RM or HR",
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(decideLateSchema) },
    responses: {
      200: jsonResponse('Decided', workUpdateSchema),
      403: errorResponse('Not their RM or HR, or your own entry'),
      409: errorResponse('Already decided'),
    },
  });
};
