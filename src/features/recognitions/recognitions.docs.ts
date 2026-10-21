import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  boardSchema,
  catalogEntrySchema,
  createRecognitionSchema,
  decideRecognitionSchema,
  directoryEntrySchema,
  recognitionSchema,
} from './recognitions.schema.js';

/** OpenAPI registration for the /recognitions endpoints. */
export const registerRecognitionsDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/recognitions/board',
    tags: ['Recognitions'],
    summary: 'The board — approved awards only, ranked by count then value',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Board', boardSchema),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/recognitions/mine',
    tags: ['Recognitions'],
    summary: 'Awards the caller has received (approved)',
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Recognitions', z.array(recognitionSchema)) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/recognitions/sent',
    tags: ['Recognitions'],
    summary: "The caller's nominations, every status, with decision reasons",
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Recognitions', z.array(recognitionSchema)) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/recognitions/pending',
    tags: ['Recognitions'],
    summary: 'Nominations the caller may decide — their reports; broad HR sees all',
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Recognitions', z.array(recognitionSchema)) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/recognitions/directory',
    tags: ['Recognitions'],
    summary: 'Sanitized active roster (names only) for the nomination picker',
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Directory', z.array(directoryEntrySchema)) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/recognitions',
    tags: ['Recognitions'],
    summary: 'Nominate someone — citation 50 to 500 characters, never yourself',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(createRecognitionSchema) },
    responses: {
      201: jsonResponse('Nominated', recognitionSchema),
      403: errorResponse('Self-nomination'),
      422: errorResponse(
        'Award type not in the catalog, or a single award to several people',
      ),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/recognitions/{id}/decide',
    tags: ['Recognitions'],
    summary:
      "Approve or decline (recipient's RM or broad HR; decline needs a reason; monthly/quarterly cadence enforced)",
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(decideRecognitionSchema) },
    responses: {
      200: jsonResponse('Decided', recognitionSchema),
      403: errorResponse('Not an approver / self-approval'),
      409: errorResponse('Already decided, or the cadence window is full'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/recognitions/catalog',
    tags: ['Recognitions'],
    summary: 'Award types nominators can pick (from the HR-edited catalog)',
    security: [{ bearerAuth: [] }],
    responses: { 200: jsonResponse('Catalog', z.array(catalogEntrySchema)) },
  });
};
