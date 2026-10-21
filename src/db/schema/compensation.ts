import { numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orgSchema } from './departments.js';
import { employees } from './employees.js';

/**
 * Salary + bank details, ONE ROW PER EMPLOYEE, kept out of `employees` on
 * purpose: this data is me-scoped (§3.1) — visible only to the employee
 * themselves, holders of the `pr.payroll.compensation` module, and the
 * Owner/SuperAdmin bypass. Never to other HR, never to the RM. A separate
 * table means a profile read can never leak it by selecting `*`.
 */
export const employeeSalary = orgSchema.table('employee_salary', {
  employeeId: uuid('employee_id')
    .primaryKey()
    .references(() => employees.id),

  // Compensation (module `pr.payroll.compensation`).
  ctc: numeric('ctc', { precision: 14, scale: 2 }),
  payrollCostCenter: text('payroll_cost_center'),
  salaryCurrency: text('salary_currency').notNull().default('INR'),
  // Bank / Cash / Cheque — free text like the other presentation lists.
  salaryMode: text('salary_mode'),
  panNumber: text('pan_number'),
  providentFundAccount: text('provident_fund_account'),
  employeeAdvanceAccount: text('employee_advance_account'),

  // Bank details (module `pr.payroll.bank_details`).
  bankName: text('bank_name'),
  bankAccountNo: text('bank_account_no'),
  ifscCode: text('ifsc_code'),

  // Salary structure: % of monthly gross (CTC/12). Null = the service
  // defaults (Basic 50, HRA 20); special allowance is always the remainder.
  basicPercent: numeric('basic_percent', { precision: 5, scale: 2 }),
  hraPercent: numeric('hra_percent', { precision: 5, scale: 2 }),

  // Recurring monthly deductions, copied into each draft payslip (editable
  // per run there). Manual amounts for now — statutory formulas deferred.
  pfAmount: numeric('pf_amount', { precision: 12, scale: 2 }),
  tdsAmount: numeric('tds_amount', { precision: 12, scale: 2 }),
  // ERP TDS sheet: CNPS contribution as a % of basic (50% of FY CTC) —
  // reduces taxable income; per-employee, 0/null = not enrolled.
  cnpsPercent: numeric('cnps_percent', { precision: 5, scale: 2 }),
  // Annual variable-pay target: joins taxable income in the TDS projection;
  // the actual payout goes on a payslip as an earnings adjustment.
  variablePay: numeric('variable_pay', { precision: 14, scale: 2 }),
  professionalTaxAmount: numeric('professional_tax_amount', { precision: 12, scale: 2 }),
  otherDeductionAmount: numeric('other_deduction_amount', { precision: 12, scale: 2 }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
