import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { orgSchema } from './departments.js';
import { employees } from './employees.js';
import { exits } from './exits.js';
import {
  loanKindEnum,
  loanRepaymentKindEnum,
  loanStatusEnum,
  payrollRunStatusEnum,
  payslipCorrectionStatusEnum,
} from './enums.js';

/**
 * One payroll run per month (draft → finalized → paid). Finalizing locks the
 * numbers and publishes the payslips to their employees; a draft can be
 * regenerated or deleted, a finalized run can only be marked paid.
 */
export const payrollRuns = orgSchema.table('payroll_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  // YYYY-MM; one run per month — off-cycle/arrear runs are a later concern.
  month: text('month').notNull().unique(),
  status: payrollRunStatusEnum('status').notNull().default('draft'),
  generatedBy: uuid('generated_by')
    .notNull()
    .references(() => employees.id),
  finalizedBy: uuid('finalized_by').references(() => employees.id),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  paidBy: uuid('paid_by').references(() => employees.id),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A payslip is a full SNAPSHOT: every number is copied/computed at generation
 * (or draft edit) time and never re-derives from salary/attendance afterwards
 * — a finalized month stays exactly what was published (§12, authoritative
 * tables). Me-scoped like employee_salary: the employee, pr.payroll holders,
 * and the bypass.
 */
export const payslips = orgSchema.table(
  'payslips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => payrollRuns.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),

    // Inputs snapshotted from the salary row.
    ctc: numeric('ctc', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull(),

    // The structure split, snapshotted from the salary record at build
    // (blank record = 50 / 25) so edits and finalize recompute the same.
    basicPercent: numeric('basic_percent', { precision: 5, scale: 2 }).notNull().default('50'),
    hraPercent: numeric('hra_percent', { precision: 5, scale: 2 }).notNull().default('25'),

    // Earnings (ERP sheet model): monthly CTC prorated over a fixed 30-day
    // base, split Basic / HRA (per person, default 50 / 25) / LTA 10 /
    // Special = remainder-after-PF.
    monthlyGross: numeric('monthly_gross', { precision: 12, scale: 2 }).notNull(),
    basic: numeric('basic', { precision: 12, scale: 2 }).notNull(),
    hra: numeric('hra', { precision: 12, scale: 2 }).notNull(),
    lta: numeric('lta', { precision: 12, scale: 2 }).notNull().default('0'),
    specialAllowance: numeric('special_allowance', { precision: 12, scale: 2 }).notNull(),

    // Loss of pay: derived from attendance at generation, PR-overridable in draft.
    workingDays: numeric('working_days', { precision: 4, scale: 1 }).notNull(),
    lopDays: numeric('lop_days', { precision: 4, scale: 1 }).notNull().default('0'),
    lopAmount: numeric('lop_amount', { precision: 12, scale: 2 }).notNull().default('0'),
    // Month-end auto-leave (user decision): unmarked absences covered from
    // balances EL -> SL -> CL; provisional at generation, written for real at
    // finalize. A manual LOP edit sets lop_overridden and opts the slip out.
    autoElDays: numeric('auto_el_days', { precision: 4, scale: 1 })
      .notNull()
      .default('0'),
    autoSlDays: numeric('auto_sl_days', { precision: 4, scale: 1 })
      .notNull()
      .default('0'),
    autoClDays: numeric('auto_cl_days', { precision: 4, scale: 1 })
      .notNull()
      .default('0'),
    lopOverridden: boolean('lop_overridden').notNull().default(false),

    // Deductions (ERP sheet model): PF both sides computed from basic with
    // the blended wage-cap formula; PT by the snapshotted location rule; TDS
    // and the rest are per-month entries, editable in draft.
    pf: numeric('pf', { precision: 12, scale: 2 }).notNull().default('0'),
    pfEmployer: numeric('pf_employer', { precision: 12, scale: 2 }).notNull().default('0'),
    tds: numeric('tds', { precision: 12, scale: 2 }).notNull().default('0'),
    professionalTax: numeric('professional_tax', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    // Snapshot of the PT location rule at generation — the slip never
    // re-derives from the live zone (§12).
    ptEligible: boolean('pt_eligible').notNull().default(false),
    // The PT state (payroll.ptStates) the slip was taxed under, snapshotted
    // with eligibility; its slab amounts are applied when the slip is computed.
    ptState: text('pt_state'),
    // Loan EMI / recovery / other deductions (sheet column AA).
    otherDeduction: numeric('other_deduction', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    healthInsurance: numeric('health_insurance', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    cnpsEmployer: numeric('cnps_employer', { precision: 12, scale: 2 }).notNull().default('0'),

    // Earnings-side per-month adjustments (sheet: final pay = net + these).
    reimbursement: numeric('reimbursement', { precision: 12, scale: 2 }).notNull().default('0'),
    performanceBonus: numeric('performance_bonus', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    // Approved R&R awards from the PREVIOUS month, snapshotted when the draft
    // is built (refinement plan, Phase 2) — its own payslip line, not editable.
    recognitionBonus: numeric('recognition_bonus', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    otherBonus: numeric('other_bonus', { precision: 12, scale: 2 }).notNull().default('0'),
    // Signed total of post-finalize corrections to EARLIER slips carried by
    // this one (+ pays more, − recovers). Not editable: it follows
    // payslip_corrections (Phase 3).
    correction: numeric('correction', { precision: 12, scale: 2 }).notNull().default('0'),
    leaveEncashment: numeric('leave_encashment', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    advance: numeric('advance', { precision: 12, scale: 2 }).notNull().default('0'),

    // Full & final (exit module): set only on the slip that settles an exit.
    // Earnings: gratuity, notice pay in lieu. Deductions: notice shortfall
    // recovered on Basic, sick days without a certificate, typed recoveries.
    exitId: uuid('exit_id').references(() => exits.id),
    encashedElDays: numeric('encashed_el_days', { precision: 5, scale: 1 })
      .notNull()
      .default('0'),
    gratuityYears: integer('gratuity_years').notNull().default(0),
    gratuity: numeric('gratuity', { precision: 12, scale: 2 }).notNull().default('0'),
    noticePay: numeric('notice_pay', { precision: 12, scale: 2 }).notNull().default('0'),
    noticeRecovery: numeric('notice_recovery', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    sickLopDays: numeric('sick_lop_days', { precision: 5, scale: 1 }).notNull().default('0'),
    sickLopDeduction: numeric('sick_lop_deduction', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    fnfRecovery: numeric('fnf_recovery', { precision: 12, scale: 2 }).notNull().default('0'),
    // Loan / advance EMIs due this month (the whole balance on an F&F slip).
    loanEmi: numeric('loan_emi', { precision: 12, scale: 2 }).notNull().default('0'),

    earningsTotal: numeric('earnings_total', { precision: 12, scale: 2 }).notNull(),
    deductionsTotal: numeric('deductions_total', { precision: 12, scale: 2 }).notNull(),
    // Net = prorated − every deduction; final = net + the adjustments above.
    netPay: numeric('net_pay', { precision: 12, scale: 2 }).notNull(),
    finalPay: numeric('final_pay', { precision: 12, scale: 2 }).notNull().default('0'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payslips_run_employee_uq').on(t.runId, t.employeeId),
    check('payslips_lop_days_ck', sql`${t.lopDays} >= 0`),
  ],
);

/**
 * Post-finalize correction (refinement plan, Phase 3): a finalized slip is
 * never edited. PR records a signed amount + reason against the WRONG slip;
 * it rides as its own line on the employee's next run (draft slips pick up
 * every pending correction from an earlier month) and is marked applied when
 * that run finalizes.
 */
export const payslipCorrections = orgSchema.table(
  'payslip_corrections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    sourcePayslipId: uuid('source_payslip_id')
      .notNull()
      .references(() => payslips.id),
    // YYYY-MM of the wrong slip's run — denormalized so "earlier than this
    // run" is a plain comparison.
    sourceMonth: text('source_month').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    reason: text('reason').notNull(),
    status: payslipCorrectionStatusEnum('status').notNull().default('pending'),
    appliedRunId: uuid('applied_run_id').references(() => payrollRuns.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => employees.id),
    cancelledBy: uuid('cancelled_by').references(() => employees.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('payslip_corrections_amount_ck', sql`${t.amount} <> 0`),
    index('payslip_corrections_employee_idx').on(t.employeeId, t.status),
  ],
);

/**
 * Loans & advances (close-out, user decisions 2026-10-16): payroll records
 * them — no application step — for confirmed full-time employees. Each loan
 * has its own interest rate (editable) and months; the EMI is deducted in
 * every payroll run from the start month (reducing balance; flat when the
 * rate is 0). An advance is a one-month loan. At exit the balance goes into
 * the F&F.
 */
export const loans = orgSchema.table(
  'loans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    kind: loanKindEnum('kind').notNull(),
    principal: numeric('principal', { precision: 12, scale: 2 }).notNull(),
    interestRatePct: numeric('interest_rate_pct', { precision: 5, scale: 2 })
      .notNull()
      .default('0'),
    months: integer('months').notNull(),
    // First payroll month that deducts an EMI (YYYY-MM).
    startMonth: text('start_month').notNull(),
    emi: numeric('emi', { precision: 12, scale: 2 }).notNull(),
    status: loanStatusEnum('status').notNull().default('active'),
    note: text('note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => employees.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('loans_employee_idx').on(t.employeeId)],
);

/** What came back, written when a run finalizes (or when closed outside payroll). */
export const loanRepayments = orgSchema.table(
  'loan_repayments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loanId: uuid('loan_id')
      .notNull()
      .references(() => loans.id),
    runId: uuid('run_id').references(() => payrollRuns.id),
    month: text('month'),
    kind: loanRepaymentKindEnum('kind').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    principalPart: numeric('principal_part', { precision: 12, scale: 2 }).notNull(),
    interestPart: numeric('interest_part', { precision: 12, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('loan_repayments_loan_idx').on(t.loanId)],
);
