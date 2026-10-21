import { sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { orgSchema } from './departments.js';
import { employees } from './employees.js';
import {
  exitClearanceKindEnum,
  exitKindEnum,
  exitStatusEnum,
  noticeShortfallActionEnum,
  terminationModeEnum,
} from './enums.js';

/**
 * Exit / offboarding (user decisions 2026-10-16). One row per leaver per
 * attempt:
 *   resignation: submitted → (withdrawn) | accepted → relieved → settled
 *   termination: accepted (HR starts it) → relieved → settled
 *   HR may cancel before the last day.
 * Notice comes from the person's record; a shortfall is waived or recovered
 * on Basic, a termination may pay the unserved notice in lieu. Relieved = the
 * last working day has passed and the login is off; settled = the F&F rode
 * a finalized payroll run. Never deleted.
 */
export const exits = orgSchema.table(
  'exits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    kind: exitKindEnum('kind').notNull(),
    status: exitStatusEnum('status').notNull(),
    reason: text('reason').notNull(),
    initiatedBy: uuid('initiated_by')
      .notNull()
      .references(() => employees.id),
    // The day notice starts (resignation date / termination notice date).
    noticeStartOn: date('notice_start_on').notNull(),
    // Snapshot of the person's notice days when the exit started.
    noticeDays: integer('notice_days').notNull().default(0),
    proposedLastDay: date('proposed_last_day').notNull(),
    // Fixed by HR on accept (= proposed until then).
    lastWorkingDay: date('last_working_day').notNull(),
    shortfallDays: integer('shortfall_days').notNull().default(0),
    shortfallAction: noticeShortfallActionEnum('shortfall_action'),
    shortfallReason: text('shortfall_reason'),
    terminationMode: terminationModeEnum('termination_mode'),
    // Manager's acknowledgement + handover plan.
    handoverPlan: text('handover_plan'),
    acknowledgedBy: uuid('acknowledged_by').references(() => employees.id),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => employees.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    // Withdrawn by the leaver / cancelled by HR.
    closedBy: uuid('closed_by').references(() => employees.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closeReason: text('close_reason'),
    relievedAt: timestamp('relieved_at', { withTimezone: true }),
    // Exit interview, filled by the leaver on the last day (HR sees it).
    interview: jsonb('interview'),
    interviewAt: timestamp('interview_at', { withTimezone: true }),
    // The payroll run that carried the F&F (soft link: payroll references exits).
    settledRunId: uuid('settled_run_id'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('exits_employee_idx').on(t.employeeId),
    // One live exit per person.
    uniqueIndex('exits_one_live_uq')
      .on(t.employeeId)
      .where(sql`status IN ('submitted', 'accepted', 'relieved')`),
  ],
);

/**
 * The four clearances, in parallel: HR (from the resignation date through
 * notice), the manager (handover, during notice), OPS (on the last day,
 * against the asset register) and payroll (at F&F — set by finalizing the
 * run). Nobody clears their own.
 */
export const exitClearances = orgSchema.table(
  'exit_clearances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    exitId: uuid('exit_id')
      .notNull()
      .references(() => exits.id),
    kind: exitClearanceKindEnum('kind').notNull(),
    clearedBy: uuid('cleared_by').references(() => employees.id),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    note: text('note'),
  },
  (t) => [uniqueIndex('exit_clearances_uq').on(t.exitId, t.kind)],
);

/** Recovery lines payroll types into the F&F (no loan register yet). */
export const fnfRecoveries = orgSchema.table(
  'fnf_recoveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    exitId: uuid('exit_id')
      .notNull()
      .references(() => exits.id),
    label: text('label').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    note: text('note'),
    addedBy: uuid('added_by')
      .notNull()
      .references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('fnf_recoveries_exit_idx').on(t.exitId)],
);
