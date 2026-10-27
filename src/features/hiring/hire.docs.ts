import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import { applicationSchema } from './candidates.schema.js';
import {
  bgvSchema,
  decideHireSchema,
  endOfferSchema,
  hireDecisionSchema,
  makeOfferSchema,
  markHiredResultSchema,
  markHiredSchema,
} from './hire.schema.js';

const idParam = z.object({ id: z.string().uuid() });

/** OpenAPI registration for the final decision, offer, BGV and hire (TA Step E). */
export const registerHireDocs = (registry: OpenAPIRegistry): void => {
  const security = [{ bearerAuth: [] }];
  const tags = ['Hiring — offer & hire'];
  const post = (
    path: string,
    summary: string,
    body: z.ZodTypeAny | null,
    ok: z.ZodTypeAny,
    errors: Record<number, string>,
  ) =>
    registry.registerPath({
      method: 'post',
      path: `/api/v1/hiring${path}`,
      tags,
      summary,
      security,
      request: { params: idParam, ...(body ? { body: jsonBody(body) } : {}) },
      responses: {
        200: jsonResponse('Done', ok),
        ...Object.fromEntries(
          Object.entries(errors).map(([k, v]) => [k, errorResponse(v)]),
        ),
      },
    });

  post(
    '/applications/{id}/send-for-decision',
    'Every round scored → the four decide',
    null,
    applicationSchema,
    {
      409: 'Not every round is scored',
    },
  );
  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/decisions',
    tags,
    summary: 'Hire decisions waiting for me (with the scores, while pending)',
    security,
    responses: { 200: jsonResponse('Waiting', z.array(hireDecisionSchema)) },
  });
  post(
    '/applications/{id}/decide',
    "Approve or reject the hire (dept head, line's TA RM, HR head, Admin)",
    decideHireSchema,
    applicationSchema,
    {
      403: 'Not one of the four',
      409: 'Not open, or already decided',
    },
  );
  registry.registerPath({
    method: 'put',
    path: '/api/v1/hiring/applications/{id}/offer-letter',
    tags,
    summary: 'Upload the offer letter (raw PDF / Word body, ?filename=)',
    security,
    request: { params: idParam },
    responses: {
      200: jsonResponse('Stored', applicationSchema),
      422: errorResponse('Type or size'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/applications/{id}/offer-letter',
    tags,
    summary: 'Open the offer letter (TA)',
    security,
    request: { params: idParam },
    responses: { 200: { description: 'The file' }, 404: errorResponse('None uploaded') },
  });
  post(
    '/applications/{id}/offer',
    'Send the offer (selected; letter uploaded; line approved)',
    makeOfferSchema,
    applicationSchema,
    {
      409: 'Not selected, or the line is not approved',
      422: 'No offer letter, or a past joining date',
    },
  );
  post(
    '/applications/{id}/bgv',
    'Record the background verification',
    bgvSchema,
    applicationSchema,
    {
      409: 'Wrong stage',
    },
  );
  post(
    '/applications/{id}/offer-declined',
    'The candidate declined',
    endOfferSchema,
    applicationSchema,
    {
      409: 'No open offer',
    },
  );
  post(
    '/applications/{id}/withdraw-offer',
    'Withdraw the offer (e.g. failed BGV); the four are told',
    endOfferSchema,
    applicationSchema,
    {
      409: 'No open offer',
    },
  );
  post(
    '/applications/{id}/hire',
    'The candidate accepted: create the employee + start onboarding',
    markHiredSchema,
    markHiredResultSchema,
    {
      409: 'No open offer, or the email / code already exists',
      422: 'Not a company email, or the RM does not exist',
    },
  );
  post(
    '/applications/{id}/no-show',
    'Backed out before joining: deactivate the record, reopen',
    endOfferSchema,
    applicationSchema,
    {
      409: 'Not hired, or already joined',
    },
  );
};
