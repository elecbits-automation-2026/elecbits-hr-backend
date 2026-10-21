import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  numeric,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { orgSchema } from './departments.js';
import { employees } from './employees.js';
import { reimbursementStatusEnum } from './enums.js';
import { payrollRuns } from './payroll.js';
import { bytea } from './policies.js';

/**
 * Reimbursement claims (refinement plan, Phase 3 — the approval trail behind
 * the payslip's Reimbursement line). The employee claims; the effective RM
 * approves, then Payroll. An approved claim is carried by the next payroll
 * draft (payslips.reimbursement is the sum of them, never typed) and is
 * marked paid, with the run, when that run finalizes.
 */
export const reimbursementClaims = orgSchema.table(
  'reimbursement_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    spentOn: date('spent_on').notNull(),
    category: text('category').notNull(),
    description: text('description').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    // Where the receipt is (e.g. "emailed to finance 3 Oct") — no uploads yet.
    receiptNote: text('receipt_note'),
    status: reimbursementStatusEnum('status').notNull(),
    rmDecidedBy: uuid('rm_decided_by').references(() => employees.id),
    rmDecidedAt: timestamp('rm_decided_at', { withTimezone: true }),
    payrollDecidedBy: uuid('payroll_decided_by').references(() => employees.id),
    payrollDecidedAt: timestamp('payroll_decided_at', { withTimezone: true }),
    declineReason: text('decline_reason'),
    paidRunId: uuid('paid_run_id').references(() => payrollRuns.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('reimbursement_claims_amount_ck', sql`${t.amount} > 0`),
    index('reimbursement_claims_employee_idx').on(t.employeeId, t.status),
    index('reimbursement_claims_status_idx').on(t.status),
  ],
);

/**
 * The receipt behind a claim (close-out): one file per claim, replaced on
 * re-upload, stored like policy PDFs. The claimant uploads; the RM and
 * payroll open it.
 */
export const claimReceipts = orgSchema.table('claim_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  claimId: uuid('claim_id')
    .notNull()
    .unique()
    .references(() => reimbursementClaims.id),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  data: bytea('data').notNull(),
  uploadedBy: uuid('uploaded_by')
    .notNull()
    .references(() => employees.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
});
