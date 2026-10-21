import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  addTrackNoteSchema,
  careerTrackSchema,
  closeTrackSchema,
  myCareerSchema,
  openTrackSchema,
  personCareerSchema,
  teamCareerRowSchema,
  trackNoteSchema,
} from './career.schema.js';

/** OpenAPI registration for the /career endpoints. */
export const registerCareerDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/career/mine',
    tags: ['Career'],
    summary: 'Own ladder view: current/next band, derived evidence, open conversation',
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('My career', myCareerSchema), 401: errorResponse('Not authenticated') },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/career/request',
    tags: ['Career'],
    summary: 'Ask for the roadmap conversation — opens a track toward the next band',
    security: [{ bearerAuth: [] }],
    responses: {
      201: jsonResponse('Opened', careerTrackSchema),
      409: errorResponse('A conversation is already open'),
      422: errorResponse('Top of the ladder, or the career.selfRequest minimums are not met'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/career/team',
    tags: ['Career'],
    summary: "The caller's chain grouped by band, with recognition recency and open tracks",
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Team', z.array(teamCareerRowSchema)) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/career/tracks',
    tags: ['Career'],
    summary: 'Open a conversation for a report (RM-or-HR; never for yourself)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(openTrackSchema) },
    responses: {
      201: jsonResponse('Opened', careerTrackSchema),
      403: errorResponse('Not the RM / not HR'),
      409: errorResponse('A conversation is already open'),
      422: errorResponse('Top of the ladder, or a target other than the next band'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/career/tracks/{id}/close',
    tags: ['Career'],
    summary: 'Close a conversation as met or closed (RM-or-HR; never the person themselves)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(closeTrackSchema) },
    responses: {
      200: jsonResponse('Closed', careerTrackSchema),
      403: errorResponse('Not the RM / not HR / self-close'),
      409: errorResponse('Already closed'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/career/tracks/{id}/notes',
    tags: ['Career'],
    summary: 'Add a note to an open conversation (RM-or-HR; the employee is notified)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(addTrackNoteSchema) },
    responses: {
      201: jsonResponse('Added', trackNoteSchema),
      403: errorResponse('Not the RM / not HR / own roadmap'),
      409: errorResponse('Conversation closed'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/career/people/{employeeId}',
    tags: ['Career'],
    summary: "One person's promotion history, open conversation and its notes (RM-or-HR)",
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Person career', personCareerSchema),
      403: errorResponse('Not the RM / not HR'),
      404: errorResponse('Employee not found'),
    },
  });
};
