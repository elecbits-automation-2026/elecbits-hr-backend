import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
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
import { bytea } from './policies.js';
import { leaveDayPartEnum, leaveStatusEnum, leaveTypeEnum } from './enums.js';

/**
 * Leave requests with DUAL approval: the employee's RM (leave_approver, falling
 * back to reports_to) AND any `hrbp.leaves` holder must both approve, in any
 * order — one approval is `partially_approved`, both are `approved`, and either
 * party declining ends it. The two slots are fixed, so they are columns, not a
 * child table (same shape as grant_requests' decision columns).
 */
export const leaveRequests = orgSchema.table(
  'leave_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    type: leaveTypeEnum('type').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    dayPart: leaveDayPartEnum('day_part').notNull().default('full'),
    // Calendar days incl. both ends; 0.5 for a half day. Working-day and
    // holiday calendars are a later policy layer.
    days: numeric('days', { precision: 5, scale: 1 }).notNull(),
    reason: text('reason'),
    status: leaveStatusEnum('status').notNull().default('pending'),
    // Frozen at raise time: false means the employee had no effective RM (the
    // Owner) and the RM slot is waived. The decision flow resolves the actual
    // RM live, so a manager change never orphans a request.
    rmRequired: boolean('rm_required').notNull(),
    // Also frozen at raise: false when the requester is themselves an HRBP
    // (holds hrbp.leaves) — their RM's approval then suffices. Never false
    // together with rm_required=false, so a request always needs someone.
    hrRequired: boolean('hr_required').notNull().default(true),
    rmApprovedBy: uuid('rm_approved_by').references(() => employees.id),
    rmApprovedAt: timestamp('rm_approved_at', { withTimezone: true }),
    hrApprovedBy: uuid('hr_approved_by').references(() => employees.id),
    hrApprovedAt: timestamp('hr_approved_at', { withTimezone: true }),
    // Terminal actor: the decliner, or the employee themselves on cancel.
    decidedBy: uuid('decided_by').references(() => employees.id),
    decisionReason: text('decision_reason'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('leave_requests_employee_idx').on(t.employeeId),
    index('leave_requests_status_idx').on(t.status),
    check('leave_requests_dates_ck', sql`${t.endDate} >= ${t.startDate}`),
    check(
      'leave_requests_half_day_ck',
      sql`${t.dayPart} = 'full' OR ${t.startDate} = ${t.endDate}`,
    ),
    check('leave_requests_days_ck', sql`${t.days} > 0`),
  ],
);

/**
 * Yearly balances, one row per (employee, capped type, year). `unpaid` never
 * has a row — no cap, nothing to deduct. Rows are created lazily the first
 * time a write needs them; `used` moves only on the transition to `approved`,
 * guarded by a conditional UPDATE (`used + days <= allocated`) so concurrent
 * approvals cannot overdraw. `used <= allocated` is deliberately NOT a CHECK:
 * a later HR quota reduction must not strand existing rows.
 */
export const leaveBalances = orgSchema.table(
  'leave_balances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    type: leaveTypeEnum('type').notNull(),
    year: integer('year').notNull(),
    allocated: numeric('allocated', { precision: 5, scale: 1 }).notNull(),
    used: numeric('used', { precision: 5, scale: 1 }).notNull().default('0'),
    // Carry-forward credited at year start (earned leave only, policy §9.3a.3);
    // effective balance = LEAST(opening + allocated, 30) for earned.
    opening: numeric('opening', { precision: 5, scale: 1 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('leave_balances_uq').on(t.employeeId, t.type, t.year),
    check('leave_balances_allocated_ck', sql`${t.allocated} >= 0`),
    check('leave_balances_used_ck', sql`${t.used} >= 0`),
  ],
);

/**
 * Medical certificate for a sick leave (exit module): during notice, 3+
 * consecutive sick days need proof, or those days are LOP in the F&F. One
 * file per leave, replaced on re-upload; stored like policy PDFs.
 */
export const leaveCertificates = orgSchema.table('leave_certificates', {
  id: uuid('id').primaryKey().defaultRandom(),
  leaveId: uuid('leave_id')
    .notNull()
    .unique()
    .references(() => leaveRequests.id),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  data: bytea('data').notNull(),
  uploadedBy: uuid('uploaded_by')
    .notNull()
    .references(() => employees.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
});
