import {
  boolean,
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
import { goalCategoryEnum } from './enums.js';

/**
 * Performance layer (adopted from the hr-tool review). A review cycle is one
 * calendar quarter, materialized lazily the first time anyone touches it —
 * the current cycle is simply the row whose dates contain today.
 */
export const reviewCycles = orgSchema.table('review_cycles', {
  id: uuid('id').primaryKey().defaultRandom(),
  // '2026-Q4' — unique, so two lazy creators collide safely.
  name: text('name').notNull().unique(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  // Set when HR closes the quarter: goals freeze and the quarter reports are
  // generated (Phase 4). A closed cycle never reopens.
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: uuid('closed_by').references(() => employees.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Weighted goals in the CGP categories. The RM or HR sets them; ONLY the
 * owner moves `progress`. The quarter score = 50% Fundamental + 25%
 * Corporate + 25% General, each category Σ(progress×weight)/Σweight —
 * computed, never stored (until the quarter report freezes it).
 */
export const goals = orgSchema.table(
  'goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => reviewCycles.id),
    title: text('title').notNull(),
    category: goalCategoryEnum('category').notNull().default('fundamental'),
    metric: text('metric'),
    target: text('target'),
    weight: numeric('weight', { precision: 5, scale: 1 }).notNull(),
    progress: integer('progress').notNull().default(0),
    dueOn: date('due_on').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('goals_employee_cycle_idx').on(t.employeeId, t.cycleId)],
);

/**
 * Daily work updates: one entry per person per working day, written on the
 * day itself. A MISSED day may be filled in LATE (within the regularization
 * window): it is marked `late_status` 'pending' until the RM approves it
 * (then it clears the miss) or declines it (the miss stands); a
 * self-governing person's late entry is approved as written. `goal_ids`
 * optionally tags the update with the person's own goals. `score` is
 * the AI's 0–100 alignment against the person's OWN goals; a failed or
 * disabled scoring stores NULL ("unscored"), never 0 — an outage must not
 * create a bad performance record (load-bearing rule).
 */
export const workUpdates = orgSchema.table(
  'work_updates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    date: date('date').notNull(),
    note: text('note').notNull(),
    score: integer('score'),
    feedback: text('feedback'),
    kpiHits: text('kpi_hits').array(),
    /** Own goals this update is about (optional tags). */
    goalIds: uuid('goal_ids').array(),
    /** null = written on the day; 'pending' | 'approved' | 'declined' = a late entry. */
    lateStatus: text('late_status'),
    lateDecidedBy: uuid('late_decided_by').references(() => employees.id),
    lateDecidedAt: timestamp('late_decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('work_updates_employee_date_uq').on(t.employeeId, t.date)],
);

/**
 * A month in which someone missed more work updates than the allowance
 * (WORK_UPDATE_MISS_ALLOWANCE). One row per person per month — the
 * row IS the quarter-report flag, and inserting it is what triggers the RM's
 * bell exactly once.
 */
export const workUpdateMissFlags = orgSchema.table(
  'work_update_miss_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    /** 'YYYY-MM' */
    month: text('month').notNull(),
    misses: integer('misses').notNull(),
    flaggedAt: timestamp('flagged_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('work_update_miss_flags_uq').on(t.employeeId, t.month)],
);

/**
 * The quarter report (Phase 4, CGP Performance & Appraisal Policy): one row
 * per person per closed quarter, generated once at close and never
 * recomputed. The computed score + band are the frozen record; the effective
 * RM (or HR) may set a final score with a reason — no approval step (user
 * decision). Evidence (goals, updates, attendance, recognition, notes) is
 * snapshotted as JSON so later edits never rewrite history.
 */
export const quarterReports = orgSchema.table(
  'quarter_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => reviewCycles.id),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    // Who managed them and where they sat, as at close.
    rmId: uuid('rm_id').references(() => employees.id),
    departmentName: text('department_name'),
    goals: jsonb('goals').notNull(),
    fundamental: integer('fundamental'),
    corporate: integer('corporate'),
    general: integer('general'),
    computedScore: integer('computed_score'),
    computedBand: text('computed_band'),
    finalScore: integer('final_score'),
    finalBand: text('final_band'),
    adjustReason: text('adjust_reason'),
    adjustedBy: uuid('adjusted_by').references(() => employees.id),
    adjustedAt: timestamp('adjusted_at', { withTimezone: true }),
    updates: jsonb('updates').notNull(),
    attendance: jsonb('attendance').notNull(),
    recognitions: integer('recognitions').notNull().default(0),
    feedback: jsonb('feedback').notNull(),
    atRiskGoals: integer('at_risk_goals').notNull().default(0),
    pipCandidate: boolean('pip_candidate').notNull().default(false),
    appraisalEligible: boolean('appraisal_eligible').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('quarter_reports_cycle_employee_uq').on(t.cycleId, t.employeeId),
    index('quarter_reports_rm_idx').on(t.cycleId, t.rmId),
  ],
);
