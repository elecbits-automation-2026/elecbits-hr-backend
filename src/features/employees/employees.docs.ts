import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../docs/helpers.js';
import { z } from '../../shared/zod.js';
import { bankDetailsSchema, payrollSalarySchema } from '../me/me.schema.js';
import {
  createEmployeeSchema,
  employeeSchema,
  importEmployeesSchema,
  importResultSchema,
  incompleteRecordSchema,
  inviteEmployeeSchema,
  updateEmployeeSchema,
  updateBankDetailsSchema,
  updateSalarySchema,
} from './employees.schema.js';

/** The single-use claim link payload — the token appears only in this response. */
const claimInfoSchema = z
  .object({ token: z.string(), expiresAt: z.string().datetime() })
  .openapi('ClaimInfo');

/** OpenAPI registration for the employees endpoints. */
export const registerEmployeesDocs = (registry: OpenAPIRegistry): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/v1/employees',
    tags: ['Employees'],
    summary: 'List employees (scope-filtered)',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Employees', z.array(employeeSchema)),
      401: errorResponse('Not authenticated'),
      403: errorResponse('Not allowed'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/employees',
    tags: ['Employees'],
    summary: 'Create an employee record (HRBP, top-down)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(createEmployeeSchema) },
    responses: {
      201: jsonResponse('Created', employeeSchema),
      403: errorResponse('Not allowed'),
      409: errorResponse('Duplicate email or employee code'),
      422: errorResponse('Reporting manager does not exist'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/employees/invite',
    tags: ['Employees'],
    summary: 'Invite an employee with batches (Admin, access-first; code auto-generated)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(inviteEmployeeSchema) },
    responses: {
      201: jsonResponse('Invited', employeeSchema),
      403: errorResponse('Not allowed'),
      409: errorResponse('Duplicate email'),
      422: errorResponse('Unknown reporting manager or batch'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/employees/{id}/claim-link',
    tags: ['Employees'],
    summary: 'Reissue the single-use claim link for an unclaimed record',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('New claim token (shown once)', claimInfoSchema),
      404: errorResponse('Employee not found'),
      409: errorResponse('Record already claimed'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/employees/{id}',
    tags: ['Employees'],
    summary: 'Get one employee',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Employee', employeeSchema),
      403: errorResponse('Not allowed'),
      404: errorResponse('Not found'),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/employees/{id}',
    tags: ['Employees'],
    summary: 'Update an employee (incl. RM change; no reporting cycles)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(updateEmployeeSchema) },
    responses: {
      200: jsonResponse('Updated', employeeSchema),
      403: errorResponse('Not allowed'),
      409: errorResponse('Duplicate email or employee code'),
      422: errorResponse('Reporting cycle rejected'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/employees/{id}/salary',
    tags: ['Employees'],
    summary:
      'Salary (Payroll only — me-scoped data, §3.1); bank fields hidden without pr.payroll.bank_details',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('PayrollEmployeeSalary', payrollSalarySchema),
      403: errorResponse('Not allowed (requires pr.payroll.compensation)'),
      404: errorResponse('Employee not found'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/employees/{id}/salary',
    tags: ['Employees'],
    summary:
      'Set or amend salary (Payroll only); bank fields need pr.payroll.bank_details (403 BANK_DETAILS_FORBIDDEN)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(updateSalarySchema) },
    responses: {
      200: jsonResponse('PayrollEmployeeSalary', payrollSalarySchema),
      403: errorResponse('Not allowed (requires pr.payroll.compensation)'),
      404: errorResponse('Employee not found'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/employees/incomplete',
    tags: ['Employees'],
    summary:
      'Live records missing a joining date, department or designation — hrbp.people read',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('Incomplete records', z.array(incompleteRecordSchema)),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/employees/import',
    tags: ['Employees'],
    summary:
      'Bulk import from CSV rows — dryRun validates and reports per line; a real run writes all or nothing (invited, Employee batch only) and returns one-time claim tokens — hrbp.people create',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(importEmployeesSchema) },
    responses: {
      200: jsonResponse('Report (and created records on a real run)', importResultSchema),
      422: jsonResponse(
        'Real run refused — the per-line report says why',
        importResultSchema,
      ),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/employees/{id}/bank-details',
    tags: ['Employees'],
    summary: 'Bank name, account and IFSC (pr.payroll.bank_details, org)',
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse('BankDetails', bankDetailsSchema),
      403: errorResponse('Requires pr.payroll.bank_details at org scope'),
      404: errorResponse('Employee not found'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/v1/employees/{id}/bank-details',
    tags: ['Employees'],
    summary: 'Set or amend bank details (pr.payroll.bank_details, org)',
    security: [{ bearerAuth: [] }],
    request: { body: jsonBody(updateBankDetailsSchema) },
    responses: {
      200: jsonResponse('BankDetails', bankDetailsSchema),
      403: errorResponse('Requires pr.payroll.bank_details at org scope'),
      404: errorResponse('Employee not found'),
      422: errorResponse('Invalid account number or IFSC'),
    },
  });
};
