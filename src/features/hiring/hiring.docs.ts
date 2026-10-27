import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  addSourceSchema,
  assignPositionSchema,
  assignTaRmSchema,
  createRequisitionSchema,
  decideRequisitionSchema,
  documentReviewSchema,
  hiringMeSchema,
  hiringPlanSchema,
  recruiterOptionSchema,
  requisitionSchema,
  saveJdSchema,
  saveScorecardSchema,
  taRmOptionSchema,
  updateRequisitionSchema,
} from './hiring.schema.js';

const idParam = z.object({ id: z.string().uuid() });

/** OpenAPI registration for the hiring endpoints. */
export const registerHiringDocs = (registry: OpenAPIRegistry): void => {
  const security = [{ bearerAuth: [] }];

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/me',
    tags: ['Hiring'],
    summary: 'Departments I head and approver roles I hold',
    security,
    responses: { 200: jsonResponse('Me', hiringMeSchema) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/plan',
    tags: ['Hiring'],
    summary: "A department's hiring plan for a quarter (its head only)",
    security,
    request: {
      query: z.object({ departmentId: z.string().uuid(), quarter: z.string() }),
    },
    responses: {
      200: jsonResponse('Plan', hiringPlanSchema),
      403: errorResponse('Not the head of this department'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/hiring/requisitions',
    tags: ['Hiring'],
    summary: 'Add a line to the plan (draft)',
    security,
    request: { body: jsonBody(createRequisitionSchema) },
    responses: {
      201: jsonResponse('Created', requisitionSchema),
      403: errorResponse('Not the head of this department'),
      422: errorResponse('Interviewer not eligible'),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/hiring/requisitions/{id}',
    tags: ['Hiring'],
    summary: 'Edit a draft or returned line (returned → new version)',
    security,
    request: { params: idParam, body: jsonBody(updateRequisitionSchema) },
    responses: {
      200: jsonResponse('Updated', requisitionSchema),
      409: errorResponse('Not editable'),
    },
  });

  for (const [action, summary] of [
    [
      'submit',
      "Submit a line: a draft waits for the quarter's deadline; a returned line goes back to the approvers",
    ],
    ['unqueue', 'Take a waiting line back to draft (before the deadline)'],
    ['cancel', 'Cancel a line'],
  ] as const) {
    registry.registerPath({
      method: 'post',
      path: `/api/v1/hiring/requisitions/{id}/${action}`,
      tags: ['Hiring'],
      summary,
      security,
      request: { params: idParam },
      responses: {
        200: jsonResponse('Done', requisitionSchema),
        403: errorResponse('Not the head of this department'),
        409: errorResponse('Wrong status'),
      },
    });
  }

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/approvals',
    tags: ['Hiring'],
    summary: 'Lines waiting for my decision',
    security,
    responses: { 200: jsonResponse('Waiting', z.array(requisitionSchema)) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/hiring/requisitions/{id}/decide',
    tags: ['Hiring'],
    summary: 'Approve or reject a submitted line (for the version seen)',
    security,
    request: { params: idParam, body: jsonBody(decideRequisitionSchema) },
    responses: {
      200: jsonResponse('Decided', requisitionSchema),
      403: errorResponse('Not an approver, or own request'),
      409: errorResponse('Changed since opened, or already decided'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/requisitions',
    tags: ['Hiring'],
    summary: 'Every hiring line (TA / HR)',
    security,
    request: { query: z.object({ status: z.string().optional() }) },
    responses: { 200: jsonResponse('Requisitions', z.array(requisitionSchema)) },
  });

  // ── Step C ──────────────────────────────────────────────────────────────

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/reviews',
    tags: ['Hiring'],
    summary: 'JDs and scorecards waiting for my review (line TA RM / dept head)',
    security,
    responses: { 200: jsonResponse('Waiting', z.array(documentReviewSchema)) },
  });

  for (const [kind, body] of [
    ['jd', saveJdSchema],
    ['scorecard', saveScorecardSchema],
  ] as const) {
    registry.registerPath({
      method: 'put',
      path: `/api/v1/hiring/positions/{id}/${kind}`,
      tags: ['Hiring'],
      summary: `Write the position's ${kind === 'jd' ? 'JD' : 'scorecard'} (its recruiter; returned → new version)`,
      security,
      request: { params: idParam, body: jsonBody(body) },
      responses: {
        200: jsonResponse('Saved', requisitionSchema),
        409: errorResponse('Line not approved, or document in review / approved'),
        422: errorResponse('Scorecard names a round the line does not use'),
      },
    });
    registry.registerPath({
      method: 'post',
      path: `/api/v1/hiring/positions/{id}/${kind}/submit`,
      tags: ['Hiring'],
      summary: `Send the position's ${kind === 'jd' ? 'JD' : 'scorecard'} for review (TA RM + dept head)`,
      security,
      request: { params: idParam },
      responses: {
        200: jsonResponse('Submitted', requisitionSchema),
        409: errorResponse('Wrong status'),
      },
    });
  }

  registry.registerPath({
    method: 'post',
    path: '/api/v1/hiring/documents/{id}/decide',
    tags: ['Hiring'],
    summary: 'Approve or reject a JD / scorecard (for the version seen)',
    security,
    request: { params: idParam, body: jsonBody(decideRequisitionSchema) },
    responses: {
      200: jsonResponse('Decided', requisitionSchema),
      403: errorResponse('Not a reviewer, or own document'),
      409: errorResponse('Changed since opened, or already decided'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/hiring/positions/{id}/assign',
    tags: ['Hiring'],
    summary:
      "The line's TA RM gives a position to a TA-batch report or keeps it (creates / moves the hiring goal)",
    security,
    request: { params: idParam, body: jsonBody(assignPositionSchema) },
    responses: {
      200: jsonResponse('Assigned', requisitionSchema),
      403: errorResponse("Not this line's TA RM"),
      409: errorResponse('Closed position, same recruiter, or closed quarter'),
      422: errorResponse('Recruiter inactive, not a direct report, or not in the TA batch'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/hiring/positions/{id}/sources',
    tags: ['Hiring'],
    summary: "Log a sourcing channel activated for a position (its recruiter / the line's TA RM)",
    security,
    request: { params: idParam, body: jsonBody(addSourceSchema) },
    responses: {
      201: jsonResponse('Logged', requisitionSchema),
      403: errorResponse("Not the position's recruiter or the line's TA RM"),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/recruiters',
    tags: ['Hiring'],
    summary: "TA RM: their reports in the TA batch — who can take a position",
    security,
    responses: {
      200: jsonResponse('Recruiters', z.array(recruiterOptionSchema)),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/ta-rms',
    tags: ['Hiring'],
    summary: 'Admin: TA-batch holders with reports — who can take a line',
    security,
    responses: {
      200: jsonResponse('TA RMs', z.array(taRmOptionSchema)),
      403: errorResponse('Not the Admin account'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/hiring/requisitions/{id}/assign-ta',
    tags: ['Hiring'],
    summary: 'Admin gives an approved line to a TA RM',
    security,
    request: { params: idParam, body: jsonBody(assignTaRmSchema) },
    responses: {
      200: jsonResponse('Given', requisitionSchema),
      403: errorResponse('Not the Admin account'),
      409: errorResponse(
        'Not approved, same TA RM, or their team already holds positions on it',
      ),
      422: errorResponse('Not a TA RM (needs the TA batch and a report)'),
    },
  });
};
