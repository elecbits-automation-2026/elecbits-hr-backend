import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  addApplicationSchema,
  applicationSchema,
  candidateMatchSchema,
  candidateSchema,
  createCandidateSchema,
  endApplicationSchema,
  activitySchema,
  endInterviewSlotSchema,
  hiringBoardSchema,
  logActivitySchema,
  nextActionSchema,
  updateCandidateSchema,
  myInterviewSchema,
  scheduleInterviewSchema,
  submitScoreSchema,
  swapInterviewerSchema,
} from './candidates.schema.js';

const idParam = z.object({ id: z.string().uuid() });
const roundParam = z.object({ id: z.string().uuid(), round: z.string() });

/** OpenAPI registration for candidates, applications and interview scores (TA Step D). */
export const registerCandidatesDocs = (registry: OpenAPIRegistry): void => {
  const security = [{ bearerAuth: [] }];
  const tags = ['Hiring — candidates'];

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/candidates',
    tags,
    summary: 'The talent pool (TA): search by name, email or phone',
    security,
    request: { query: z.object({ q: z.string().optional() }) },
    responses: { 200: jsonResponse('Candidates', z.array(candidateSchema)) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/candidates/match',
    tags,
    summary: 'Possible duplicates by email or phone, before adding',
    security,
    request: {
      query: z.object({ email: z.string().optional(), phone: z.string().optional() }),
    },
    responses: { 200: jsonResponse('Matches', z.array(candidateMatchSchema)) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/candidates/{id}',
    tags,
    summary: 'One candidate with every application and its scores',
    security,
    request: { params: idParam },
    responses: {
      200: jsonResponse('Candidate', candidateSchema),
      404: errorResponse('Not found'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/hiring/candidates',
    tags,
    summary: 'Add a candidate (consent required; duplicates refused)',
    security,
    request: { body: jsonBody(createCandidateSchema) },
    responses: {
      201: jsonResponse('Added', candidateSchema),
      409: errorResponse('Already in the talent pool'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/hiring/candidates/{id}/cv',
    tags,
    summary: 'Upload the CV (raw PDF / Word body, ?filename=, max 10 MB)',
    security,
    request: { params: idParam },
    responses: {
      200: jsonResponse('Stored', candidateSchema),
      422: errorResponse('Wrong type or size'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/candidates/{id}/cv',
    tags,
    summary: "Open the CV (TA or the candidate's interviewers)",
    security,
    request: { params: idParam },
    responses: {
      200: { description: 'The file' },
      403: errorResponse('Not TA or an interviewer'),
      404: errorResponse('No CV'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/positions/{id}/applications',
    tags,
    summary: "A position's pipeline",
    security,
    request: { params: idParam },
    responses: { 200: jsonResponse('Applications', z.array(applicationSchema)) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/hiring/positions/{id}/applications',
    tags,
    summary: 'Consider a candidate for an open position (restarts their 6-month clock)',
    security,
    request: { params: idParam, body: jsonBody(addApplicationSchema) },
    responses: {
      201: jsonResponse('Added', applicationSchema),
      409: errorResponse('Position not open, or already applied'),
    },
  });

  for (const [action, summary] of [
    [
      'start-interviews',
      'Open round 1 — the recruiter’s screening (every round needs an interviewer; rounds then run in order)',
    ],
    ['informed', 'Record that a rejected / withdrawn candidate was told the outcome'],
  ] as const) {
    registry.registerPath({
      method: 'post',
      path: `/api/v1/hiring/applications/{id}/${action}`,
      tags,
      summary,
      security,
      request: { params: idParam },
      responses: {
        200: jsonResponse('Moved', applicationSchema),
        409: errorResponse('Wrong stage'),
      },
    });
  }

  for (const action of ['reject', 'withdraw'] as const) {
    registry.registerPath({
      method: 'post',
      path: `/api/v1/hiring/applications/{id}/${action}`,
      tags,
      summary:
        action === 'reject' ? 'Reject (reason required)' : 'Candidate withdrew (reason)',
      security,
      request: { params: idParam, body: jsonBody(endApplicationSchema) },
      responses: {
        200: jsonResponse('Ended', applicationSchema),
        409: errorResponse('Already ended'),
      },
    });
  }

  registry.registerPath({
    method: 'put',
    path: '/api/v1/hiring/requisitions/{id}/rounds/{round}/interviewer',
    tags,
    summary: "Swap a round's interviewer (the department head is told)",
    security,
    request: { params: roundParam, body: jsonBody(swapInterviewerSchema) },
    responses: { 204: { description: 'Swapped' }, 404: errorResponse('No such round') },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/interviews/mine',
    tags,
    summary: 'Rounds I conduct, with their scorecard and my score',
    security,
    responses: { 200: jsonResponse('Interviews', z.array(myInterviewSchema)) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/hiring/applications/{id}/rounds/{round}/score',
    tags,
    summary: "The round's interviewer scores it (final)",
    security,
    request: { params: roundParam, body: jsonBody(submitScoreSchema) },
    responses: {
      200: jsonResponse('Scored', applicationSchema),
      403: errorResponse('Not this round’s interviewer'),
      409: errorResponse('Not in interviews, or already scored'),
      422: errorResponse('Attributes do not match the round\'s sheet'),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/hiring/candidates/{id}',
    tags,
    summary: "Fill or correct a candidate's profile (TA)",
    security,
    request: { params: idParam, body: jsonBody(updateCandidateSchema) },
    responses: {
      200: jsonResponse('Updated', candidateSchema),
      409: errorResponse('Anonymised'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/hiring/applications/{id}/next-action',
    tags,
    summary: 'Set what happens next on an application, its owner and due date',
    security,
    request: { params: idParam, body: jsonBody(nextActionSchema) },
    responses: {
      200: jsonResponse('Set', applicationSchema),
      403: errorResponse("Not the position's recruiter or the line's TA RM"),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/applications/{id}/activities',
    tags,
    summary: 'Contacts logged with the candidate on this application',
    security,
    request: { params: idParam },
    responses: { 200: jsonResponse('Activities', z.array(activitySchema)) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/hiring/applications/{id}/activities',
    tags,
    summary: 'Log a call / email / WhatsApp / meeting with the candidate',
    security,
    request: { params: idParam, body: jsonBody(logActivitySchema) },
    responses: {
      201: jsonResponse('Logged', applicationSchema),
      403: errorResponse("Not the position's recruiter or the line's TA RM"),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/board',
    tags,
    summary: 'The Hiring board: approved lines and every candidate on their positions (TA)',
    security,
    responses: { 200: jsonResponse('Board', hiringBoardSchema) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/hiring/applications/{id}/rounds/{round}/schedule',
    tags,
    summary: "Schedule (or move) a round with its interviewer — the position's recruiter or TA RM",
    security,
    request: { params: roundParam, body: jsonBody(scheduleInterviewSchema) },
    responses: {
      200: jsonResponse('Scheduled', applicationSchema),
      403: errorResponse("Not the position's recruiter or the line's TA RM"),
      409: errorResponse('Not in interviews, or the round is scored'),
      422: errorResponse('No interviewer named, or a time in the past'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/hiring/applications/{id}/rounds/{round}/schedule/end',
    tags,
    summary: 'Call off a scheduled round: cancelled, or the candidate did not show',
    security,
    request: { params: roundParam, body: jsonBody(endInterviewSlotSchema) },
    responses: {
      200: jsonResponse('Called off', applicationSchema),
      403: errorResponse("Not the position's recruiter or the line's TA RM"),
      409: errorResponse('Nothing scheduled for this round'),
    },
  });
};
