import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  createFeedbackSchema,
  feedbackNoteSchema,
  noteHistorySchema,
} from './feedback.schema.js';

/** OpenAPI registration for the feedback endpoints. */
export const registerFeedbackDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'post',
    path: '/api/v1/feedback',
    tags: ['Feedback'],
    summary: 'Send a drafted appreciation/concern note (chain or broad HR only)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(createFeedbackSchema) },
    responses: {
      201: jsonResponse('Sent', feedbackNoteSchema),
      403: errorResponse('Not in the reporting chain / self-feedback'),
      404: errorResponse('Recipient not found'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/feedback/mine',
    tags: ['Feedback'],
    summary: 'Notes received (me scope)',
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Notes', z.array(feedbackNoteSchema)) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/feedback/sent',
    tags: ['Feedback'],
    summary: 'Notes the caller has sent',
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Notes', z.array(feedbackNoteSchema)) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/feedback/about/{employeeId}',
    tags: ['Feedback'],
    summary:
      "One person's notes history for their RM or HR — type, date, sender; the body only for the note's sender",
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Notes', z.array(noteHistorySchema)),
      403: errorResponse('Not their RM or HR'),
    },
  });
};
