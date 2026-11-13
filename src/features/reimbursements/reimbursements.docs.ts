import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  createClaimSchema,
  decideClaimSchema,
  markPaidResultSchema,
  markPaidSchema,
  reimbursementClaimSchema,
} from './reimbursements.schema.js';

const bearer = [{ bearerAuth: [] }];
const claims = z.array(reimbursementClaimSchema);

/** OpenAPI registration for the /reimbursements endpoints. */
export const registerReimbursementsDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'put',
    path: '/api/v1/reimbursements/{id}/receipt',
    tags: ['Reimbursements'],
    summary: 'Claimant: attach or replace the receipt (raw PDF/JPG/PNG body, ?filename=)',
    security: bearer,
    request: {
      body: {
        content: {
          'application/pdf': { schema: { type: 'string' as const, format: 'binary' } },
          'image/jpeg': { schema: { type: 'string' as const, format: 'binary' } },
          'image/png': { schema: { type: 'string' as const, format: 'binary' } },
        },
      },
    },
    responses: {
      200: jsonResponse('The claim with its receipt', reimbursementClaimSchema),
      404: errorResponse('Not your claim'),
      409: errorResponse('Claim declined or cancelled'),
      422: errorResponse('Wrong type or size'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/reimbursements/{id}/receipt',
    tags: ['Reimbursements'],
    summary: 'The receipt file (claimant, PR, or the Admin account)',
    security: bearer,
    responses: {
      200: { description: 'The file (PDF/JPG/PNG)' },
      404: errorResponse('No receipt, or not allowed'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/reimbursements/mine',
    tags: ['Reimbursements'],
    summary: 'Own claims, newest first (me scope)',
    security: bearer,
    responses: { 200: jsonResponse('Claims', claims) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/reimbursements',
    tags: ['Reimbursements'],
    summary:
      "Claim a reimbursement — waits for PR, then Admin; a PR person's own claim waits for Admin only",
    security: bearer,
    request: { body: jsonBody(createClaimSchema) },
    responses: {
      201: jsonResponse('Claim', reimbursementClaimSchema),
      403: errorResponse('The Admin account raises no claims (OWNER_NO_CLAIMS)'),
      422: errorResponse('Invalid input or a future spend date'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/reimbursements/{id}/cancel',
    tags: ['Reimbursements'],
    summary: 'Withdraw an own claim that is still waiting on someone',
    security: bearer,
    responses: {
      200: jsonResponse('Claim', reimbursementClaimSchema),
      409: errorResponse('Not yours, or already decided'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/reimbursements',
    tags: ['Reimbursements'],
    summary:
      'Every claim, optionally ?status=pending_payroll,pending_admin,approved,paid and ?month=YYYY-MM (approved in that month) — pr.payroll read, org',
    security: bearer,
    responses: {
      200: jsonResponse('Claims', claims),
      403: errorResponse('Needs pr.payroll at org scope'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/reimbursements/{id}/decision',
    tags: ['Reimbursements'],
    summary:
      'Approve or decline — PR at the PR step (pr.payroll update, org), or the Admin account at either step (its approval is final)',
    security: bearer,
    request: { body: jsonBody(decideClaimSchema) },
    responses: {
      200: jsonResponse('Claim', reimbursementClaimSchema),
      403: errorResponse('Not the approver for this step, or your own claim'),
      409: errorResponse('Already decided'),
      422: errorResponse('Approving a claim with no receipt file (RECEIPT_REQUIRED)'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/reimbursements/bank-file',
    tags: ['Reimbursements'],
    summary:
      'Excel bank file of approved, unpaid claims (?month=YYYY-MM = approved that month): "Bank transfer" (one row per person) + "Claims" — pr.payroll.bank_details read, org',
    security: bearer,
    responses: {
      200: { description: '.xlsx attachment' },
      400: errorResponse('month is not YYYY-MM'),
      403: errorResponse('Needs pr.payroll.bank_details at org scope'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/reimbursements/mark-paid',
    tags: ['Reimbursements'],
    summary:
      'After the bank transfer: approved claims become paid, with the payment date and reference (all or none) — pr.payroll update, org',
    security: bearer,
    request: { body: jsonBody(markPaidSchema) },
    responses: {
      200: jsonResponse('How many were marked, and their total', markPaidResultSchema),
      409: errorResponse('A claim is no longer approved-and-unpaid (NOT_APPROVED)'),
      422: errorResponse('Invalid input or a future payment date'),
    },
  });
};
