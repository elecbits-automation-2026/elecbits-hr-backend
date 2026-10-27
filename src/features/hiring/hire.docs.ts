import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import { applicationSchema } from './candidates.schema.js';
import {
  addCandidateDocumentSchema,
  candidateDocumentSchema,
  endOfferSchema,
  folderLinkSchema,
  markHiredResultSchema,
  markHiredSchema,
  offerDraftSchema,
  pendingOfferSchema,
  returnOfferSchema,
  setCandidateDocumentSchema,
} from './hire.schema.js';

const idParam = z.object({ id: z.string().uuid() });
const docParam = z.object({ id: z.string().uuid(), docId: z.string().uuid() });

/** OpenAPI registration for documents, the HR Head-approved offer, the hire and joining. */
export const registerHireDocs = (registry: OpenAPIRegistry): void => {
  const security = [{ bearerAuth: [] }];
  const tags = ['Hiring — offer & hire'];
  const call = (
    method: 'get' | 'post' | 'put',
    path: string,
    summary: string,
    body: z.ZodTypeAny | null,
    ok: z.ZodTypeAny,
    errors: Record<number, string>,
    params: typeof idParam | typeof docParam = idParam,
  ) =>
    registry.registerPath({
      method,
      path: `/api/v1/hiring${path}`,
      tags,
      summary,
      security,
      request: { params, ...(body ? { body: jsonBody(body) } : {}) },
      responses: {
        200: jsonResponse('Done', ok),
        ...Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, errorResponse(v)])),
      },
    });
  const fileUpload = (path: string, summary: string, errors: Record<number, string>) =>
    registry.registerPath({
      method: 'put',
      path: `/api/v1/hiring${path}`,
      tags,
      summary,
      security,
      request: {
        params: idParam,
        query: z.object({ filename: z.string().optional() }),
        body: {
          content: { 'application/pdf': { schema: z.string().openapi({ format: 'binary' }) } },
        },
      },
      responses: {
        200: jsonResponse('Uploaded', applicationSchema),
        ...Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, errorResponse(v)])),
      },
    });
  const docs = z.array(candidateDocumentSchema);

  // ── Documents ──
  call('get', '/applications/{id}/documents', 'The candidate document checklist', null, docs, {});
  call('post', '/applications/{id}/documents', 'Ask for one more document', addCandidateDocumentSchema, docs, {
    403: "Not the position's recruiter or the line's TA RM",
    409: 'Already on the list',
  });
  call(
    'put',
    '/applications/{id}/documents/{docId}',
    'Mark a document requested / received / not applicable',
    setCandidateDocumentSchema,
    docs,
    { 404: 'Document not found' },
    docParam,
  );
  call('put', '/applications/{id}/folder', 'Link the candidate folder (Candidate ID + Name)', folderLinkSchema, applicationSchema, {});

  // ── Offer ──
  fileUpload('/applications/{id}/offer-letter', 'TA uploads the draft offer letter (raw body)', {
    409: 'Not yet — every round must pass first',
    422: 'Not a PDF / Word file, or over 10 MB',
  });
  call('put', '/applications/{id}/offer-draft', 'TA saves the negotiated terms (approved terms that change go back to the HR Head)', offerDraftSchema, applicationSchema, {
    409: 'Wrong stage',
    422: 'Joining date in the past',
  });
  call('post', '/applications/{id}/offer/submit', 'Send the drafted offer to the HR Head', null, applicationSchema, {
    409: 'Terms missing, wrong stage, or no HR Head set',
    422: 'Draft letter missing',
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/hiring/offers/pending',
    tags,
    summary: 'Offers waiting for my approval and signature (the HR Head)',
    security,
    responses: { 200: jsonResponse('Offers', z.array(pendingOfferSchema)) },
  });
  fileUpload('/applications/{id}/signed-offer', 'The HR Head uploads the signed offer letter (raw body)', {
    403: 'Not the HR Head',
    409: 'Not waiting for approval',
  });
  call('post', '/applications/{id}/offer/approve', 'The HR Head approves the offer (signed letter required)', null, applicationSchema, {
    403: 'Not the HR Head',
    409: 'Not waiting for approval',
    422: 'Signed letter missing',
  });
  call('post', '/applications/{id}/offer/return', 'The HR Head returns the offer with what to change', returnOfferSchema, applicationSchema, {
    403: 'Not the HR Head',
    409: 'Not waiting for approval',
  });
  call('post', '/applications/{id}/offer', 'TA shares the approved, signed offer with the candidate', null, applicationSchema, {
    409: 'Not approved and signed yet',
  });
  call('post', '/applications/{id}/offer-declined', 'The candidate declined the offer', endOfferSchema, applicationSchema, {
    409: 'No open offer',
  });
  call('post', '/applications/{id}/withdraw-offer', 'Withdraw the offer (the HR Head is told)', endOfferSchema, applicationSchema, {
    409: 'No open offer',
  });

  // ── Hire, joining ──
  registry.registerPath({
    method: 'post',
    path: '/api/v1/hiring/applications/{id}/hire',
    tags,
    summary: 'Mark hired: create the employee (normal intake + onboarding); HRBP gets the handover',
    security,
    request: { params: idParam, body: jsonBody(markHiredSchema) },
    responses: {
      200: jsonResponse('Hired', markHiredResultSchema),
      409: errorResponse('Offer not accepted / not open'),
      422: errorResponse('Not a company email, or record rules failed'),
    },
  });
  call('post', '/applications/{id}/joined', 'HRBP confirms the actual joining', null, applicationSchema, {
    403: 'Not HRBP',
    409: 'Not hired, or before the joining date',
  });
  call('post', '/applications/{id}/no-show', 'Did not join: deactivate the record, reopen the position', endOfferSchema, applicationSchema, {
    409: 'Already joined, or not hired',
  });
};
