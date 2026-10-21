import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  concernPersonSchema,
  concernSchema,
  createConcernSchema,
  createdConcernSchema,
  decideSchema,
  declineSchema,
  escalateSchema,
  extendSchema,
  followUpNoteSchema,
  followUpSchema,
  noteSchema,
  queueSummarySchema,
  resolveSchema,
} from './concerns.schema.js';

const bearer = [{ bearerAuth: [] }];
const tags = ['Concerns'];

/** OpenAPI registration for the /concerns endpoints. */
export const registerConcernsDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'post',
    path: '/api/v1/concerns',
    tags,
    summary:
      'Raise a concern: dispute (3 levels), complaint (EO / anti-bullying) or whistleblower report. Sexual harassment is refused (422 POSH_ROUTE) — the Internal Committee handles it',
    security: bearer,
    request: { body: jsonBody(createConcernSchema) },
    responses: {
      201: jsonResponse(
        'Raised; followUpKey only for anonymous reports, shown once',
        createdConcernSchema,
      ),
      422: errorResponse('POSH_ROUTE, BAD_CATEGORY, DISPUTE_NOT_ANONYMOUS, SELF_SUBJECT'),
    },
  });

  const simple: Array<[string, 'get' | 'post', string, unknown]> = [
    [
      '/api/v1/concerns/mine',
      'get',
      'Own named cases (the raiser view)',
      z.array(concernSchema),
    ],
    [
      '/api/v1/concerns/people',
      'get',
      'Colleagues a concern can be about — everyone in work except the caller',
      z.array(concernPersonSchema),
    ],
    [
      '/api/v1/concerns/queues',
      'get',
      "The caller's queues with open and overdue counts",
      z.array(queueSummarySchema),
    ],
    [
      '/api/v1/concerns/queue/{queue}',
      'get',
      'One queue: manager | hr | mrc | vigil',
      z.array(concernSchema),
    ],
    [
      '/api/v1/concerns/{id}',
      'get',
      'One case — raiser or handler view; 404 for anyone else (including its subject)',
      concernSchema,
    ],
    [
      '/api/v1/concerns/{id}/acknowledge',
      'post',
      'Handler acknowledges (complaints, whistleblower, disputes at level 2)',
      concernSchema,
    ],
    [
      '/api/v1/concerns/{id}/accept',
      'post',
      'Raiser accepts a dispute decision — closed',
      concernSchema,
    ],
  ];
  for (const [path, method, summary, schema] of simple) {
    registry.registerPath({
      method,
      path,
      tags,
      summary,
      security: bearer,
      responses: {
        200: jsonResponse('OK', schema as typeof concernSchema),
        404: errorResponse('Not found or not yours to see'),
      },
    });
  }

  const withBody: Array<[string, string, typeof noteSchema | typeof decideSchema]> = [
    [
      '/api/v1/concerns/{id}/notes',
      'Raiser note, or handler internal note / reply (visibleToRaiser)',
      noteSchema,
    ],
    [
      '/api/v1/concerns/{id}/decide',
      'Written decision at the current dispute level (level 3 is final)',
      decideSchema,
    ],
    [
      '/api/v1/concerns/{id}/resolve',
      'Outcome + resolution for a complaint or whistleblower report',
      resolveSchema as unknown as typeof decideSchema,
    ],
    [
      '/api/v1/concerns/{id}/extend',
      'Extend the deadline with a written reason sent to the raiser',
      extendSchema as unknown as typeof decideSchema,
    ],
    [
      '/api/v1/concerns/{id}/decline',
      'HR declines a repeat dispute (level 2), optionally linking the earlier case',
      declineSchema as unknown as typeof decideSchema,
    ],
    [
      '/api/v1/concerns/{id}/escalate',
      'Raiser escalates a decided dispute within the escalation window',
      escalateSchema as unknown as typeof decideSchema,
    ],
    [
      '/api/v1/concerns/follow-up',
      'Anonymous raiser: status and replies by code + key',
      followUpSchema as unknown as typeof decideSchema,
    ],
    [
      '/api/v1/concerns/follow-up/notes',
      'Anonymous raiser adds information by code + key',
      followUpNoteSchema as unknown as typeof decideSchema,
    ],
  ];
  for (const [path, summary, body] of withBody) {
    registry.registerPath({
      method: 'post',
      path,
      tags,
      summary,
      security: bearer,
      request: { body: jsonBody(body) },
      responses: {
        200: jsonResponse('The case', concernSchema),
        404: errorResponse('Not found or not yours'),
        409: errorResponse(
          'The case moved on, is closed, or the escalation window closed',
        ),
      },
    });
  }
};
