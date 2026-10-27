import type { ZodType } from 'zod';
import {
  closeLoanSchema,
  createLoanSchema,
  loanDetailSchema,
  loanSchema,
  updateLoanSchema,
} from './loans.schema.js';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import {
  annexureQuerySchema,
  createCorrectionSchema,
  createRunSchema,
  generateRunResultSchema,
  myPayslipSchema,
  payrollRunSchema,
  payslipCorrectionSchema,
  payslipSchema,
  compensationPersonSchema,
  salaryAnnexureSchema,
  tdsEstimateSchema,
  updatePayslipSchema,
  updateTdsSchema,
} from './payroll.schema.js';

const bearer = [{ bearerAuth: [] }];

/** OpenAPI registration for the payroll endpoints. */
export const registerPayrollDocs = (registry: OpenAPIRegistry): void => {
  const loanPath = (
    method: 'get' | 'post' | 'patch',
    path: string,
    summary: string,
    response: ZodType,
    body?: ZodType,
  ) =>
    registry.registerPath({
      method,
      path,
      tags: ['Payroll'],
      summary,
      security: [{ bearerAuth: [] }],
      ...(body ? { request: { body: jsonBody(body) } } : {}),
      responses: {
        200: jsonResponse('OK', response),
        403: errorResponse('Needs pr.payroll.compensation (org)'),
        404: errorResponse('Not found'),
        422: errorResponse('Not eligible / invalid'),
      },
    });
  loanPath('get', '/api/v1/payroll/loans', 'Loan register', z.array(loanSchema));
  loanPath('get', '/api/v1/payroll/loans/{loanId}', 'Loan with repayments and schedule', loanDetailSchema);
  loanPath('post', '/api/v1/payroll/loans', 'Record a loan or salary advance', loanDetailSchema, createLoanSchema);
  loanPath('patch', '/api/v1/payroll/loans/{loanId}', 'Change rate / months left', loanDetailSchema, updateLoanSchema);
  loanPath('post', '/api/v1/payroll/loans/{loanId}/close', 'Close (settled outside payroll)', loanDetailSchema, closeLoanSchema);
  loanPath('get', '/api/v1/payroll/loans/mine', 'My loans', z.array(loanSchema));
  loanPath('get', '/api/v1/payroll/loans/mine/{loanId}', 'One of my loans', loanDetailSchema);

  registry.registerPath({
    method: 'get',
    path: '/api/v1/payroll/payslips/mine',
    tags: ['Payroll'],
    summary: 'Own payslips from finalized/paid runs (me scope)',
    security: bearer,
    responses: {
      200: jsonResponse('MyPayslips', z.array(myPayslipSchema)),
      401: errorResponse('Not authenticated'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/payroll/runs',
    tags: ['Payroll'],
    summary: 'Payroll runs, newest month first (pr.payroll read)',
    security: bearer,
    responses: {
      200: jsonResponse('PayrollRuns', z.array(payrollRunSchema)),
      403: errorResponse('Not allowed'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/payroll/runs',
    tags: ['Payroll'],
    summary: 'Generate a draft run for a month (one run per month)',
    security: bearer,
    request: { body: jsonBody(createRunSchema) },
    responses: {
      201: jsonResponse('Generated', generateRunResultSchema),
      403: errorResponse('Not allowed'),
      409: errorResponse('A run already exists for this month'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/payroll/runs/{id}',
    tags: ['Payroll'],
    summary: 'A run with its payslips',
    security: bearer,
    responses: {
      200: jsonResponse(
        'Run',
        z.object({ run: payrollRunSchema, payslips: z.array(payslipSchema) }),
      ),
      404: errorResponse('Not found'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/payroll/runs/{id}/regenerate',
    tags: ['Payroll'],
    summary: 'Re-pull salary + attendance into a DRAFT run',
    security: bearer,
    responses: {
      200: jsonResponse('Regenerated', generateRunResultSchema),
      409: errorResponse('Run is not a draft'),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/payroll/runs/{id}/payslips/{payslipId}',
    tags: ['Payroll'],
    summary: 'Override LOP days / deduction amounts on a DRAFT payslip',
    security: bearer,
    request: { body: jsonBody(updatePayslipSchema) },
    responses: {
      200: jsonResponse('Payslip', payslipSchema),
      404: errorResponse('Not found in this run'),
      409: errorResponse('Run is not a draft'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/payroll/runs/{id}/finalize',
    tags: ['Payroll'],
    summary: 'Lock the numbers and publish payslips to employees',
    security: bearer,
    responses: {
      200: jsonResponse('Run', payrollRunSchema),
      409: errorResponse(
        'Run is not a draft, requests still partially approved, a recovery exceeds the pay, or corrections changed since the draft was built',
      ),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/payroll/runs/{id}/mark-paid',
    tags: ['Payroll'],
    summary: 'Mark a finalized run as paid',
    security: bearer,
    responses: {
      200: jsonResponse('Run', payrollRunSchema),
      409: errorResponse('Run is not finalized'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/payroll/runs/{id}',
    tags: ['Payroll'],
    summary: 'Delete a DRAFT run (payslips cascade)',
    security: bearer,
    responses: {
      204: { description: 'Deleted' },
      409: errorResponse('Run is not a draft'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/payroll/people',
    tags: ['Payroll'],
    summary:
      'Compensation people list: invited / active / exiting, Owner excluded (pr.payroll.compensation read)',
    security: bearer,
    responses: {
      200: jsonResponse('People', z.array(compensationPersonSchema)),
      403: errorResponse('No compensation grant'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/payroll/tds',
    tags: ['Payroll'],
    summary:
      "TDS calculator (ERP sheet's TDS tab): FY-prorated new-regime tax per employee (pr.payroll.compensation read)",
    security: bearer,
    responses: {
      200: jsonResponse('Estimates', z.array(tdsEstimateSchema)),
      403: errorResponse('No compensation grant'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/payroll/annexure',
    tags: ['Payroll'],
    summary:
      'Salary annexure (offer breakup) for an annual CTC — same engine as the payslip, full-year TDS with marginal relief (pr.payroll.compensation read)',
    security: bearer,
    request: { query: annexureQuerySchema },
    responses: {
      200: jsonResponse('Breakup', salaryAnnexureSchema),
      400: errorResponse('Invalid inputs'),
      403: errorResponse('No compensation grant'),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/payroll/tds/{employeeId}',
    tags: ['Payroll'],
    summary:
      "Write the calculator's outcome (monthly TDS, CNPS%) onto the salary row (pr.payroll.compensation update)",
    security: bearer,
    request: { body: jsonBody(updateTdsSchema) },
    responses: {
      200: jsonResponse('Updated estimate', tdsEstimateSchema),
      404: errorResponse('No salary record'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/payroll/corrections',
    tags: ['Payroll'],
    summary: 'Post-finalize corrections, newest first (pr.payroll read)',
    security: bearer,
    responses: { 200: jsonResponse('Corrections', z.array(payslipCorrectionSchema)) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/payroll/payslips/{payslipId}/corrections',
    tags: ['Payroll'],
    summary:
      'Correct a published (finalized/paid) payslip — a signed amount that rides as its own line on the next run (pr.payroll update)',
    security: bearer,
    request: { body: jsonBody(createCorrectionSchema) },
    responses: {
      201: jsonResponse('Recorded', payslipCorrectionSchema),
      404: errorResponse('Payslip not found'),
      409: errorResponse('The month is still a draft — edit the slip instead'),
      422: errorResponse('Zero amount or reason too short'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/payroll/corrections/{id}/cancel',
    tags: ['Payroll'],
    summary: 'Cancel a pending correction (pr.payroll update)',
    security: bearer,
    responses: {
      200: jsonResponse('Cancelled', payslipCorrectionSchema),
      409: errorResponse('Already applied or cancelled'),
    },
  });

  const pdfResponse = {
    description: 'The payslip as an A4 PDF (attachment)',
    content: { 'application/pdf': { schema: { type: 'string' as const, format: 'binary' } } },
  };

  registry.registerPath({
    method: 'get',
    path: '/api/v1/payroll/payslips/mine/{payslipId}/pdf',
    tags: ['Payroll'],
    summary: 'Download one of your own published payslips as a PDF (me scope)',
    security: bearer,
    responses: { 200: pdfResponse, 404: errorResponse('Not your payslip, or not published yet') },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/payroll/runs/{id}/payslips/{payslipId}/pdf',
    tags: ['Payroll'],
    summary: 'Download any payslip of a run as a PDF — drafts carry a DRAFT watermark (pr.payroll read)',
    security: bearer,
    responses: { 200: pdfResponse, 404: errorResponse('Payslip not found in this run') },
  });
};
