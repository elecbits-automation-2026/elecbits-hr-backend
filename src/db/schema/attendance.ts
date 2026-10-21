import { sql } from 'drizzle-orm';
import {
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
import { approvalStatusEnum, attendanceSourceEnum, remoteWorkTypeEnum } from './enums.js';

/**
 * Attendance (web check-in/out, Mon–Fri week). A row exists only when someone
 * actually punched — or an approved regularization wrote one. Everything else
 * (weekend, holiday, on-leave, WFH, ABSENT) is computed at read time from the
 * calendar, the leave/WFH requests, and the gaps; absence is never stored.
 */
export const attendance = orgSchema.table(
  'attendance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    date: date('date').notNull(),
    checkInAt: timestamp('check_in_at', { withTimezone: true }).notNull(),
    checkOutAt: timestamp('check_out_at', { withTimezone: true }),
    // office/remote decided at punch time by GEOLOCATION: within
    // env.attendance radius of the office coordinates = office. No browser
    // coords (denied/unavailable) = remote. Remote is FLAGGED in views unless
    // a WFH approval covers the day — never blocked.
    source: attendanceSourceEnum('source').notNull(),
    checkInIp: text('check_in_ip'),
    checkOutIp: text('check_out_ip'),
    // Where the punches happened, when the browser shared it — lets HR see
    // how far a flagged punch actually was.
    checkInLat: numeric('check_in_lat', { precision: 9, scale: 6 }),
    checkInLng: numeric('check_in_lng', { precision: 9, scale: 6 }),
    checkOutLat: numeric('check_out_lat', { precision: 9, scale: 6 }),
    checkOutLng: numeric('check_out_lng', { precision: 9, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('attendance_employee_date_uq').on(t.employeeId, t.date),
    check(
      'attendance_out_after_in_ck',
      sql`${t.checkOutAt} IS NULL OR ${t.checkOutAt} > ${t.checkInAt}`,
    ),
  ],
);

/**
 * Punch zones — the places people may check in/out from (offices, warehouse;
 * Admin-managed, grows over time). A punch inside ANY zone's radius is a
 * clean `office` punch; in at one zone and out at another is fine. The asset
 * manager uses these zones as its locations. Falls back to the OFFICE_* env
 * coordinates while this table is empty.
 */
export const punchZones = orgSchema.table('punch_zones', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  lat: numeric('lat', { precision: 9, scale: 6 }).notNull(),
  lng: numeric('lng', { precision: 9, scale: 6 }).notNull(),
  radiusM: integer('radius_m').notNull().default(250),
  // Zone working hours ('HH:mm'); null = the env WORK_START/WORK_END defaults.
  // Punctuality follows the employee's BASE zone schedule, wherever they punch.
  workStart: text('work_start'),
  workEnd: text('work_end'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Company holidays, HRBP-maintained; the classifier reads them per year. */
export const holidays = orgSchema.table('holidays', {
  id: uuid('id').primaryKey().defaultRandom(),
  date: date('date').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * "Fix my punch" (forgot to check in/out, client visit): the employee proposes
 * in/out times for a recent date; their RM approves — approval upserts the
 * attendance row (source 'regularized') in the same transaction.
 */
export const attendanceRegularizations = orgSchema.table(
  'attendance_regularizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    date: date('date').notNull(),
    proposedIn: timestamp('proposed_in', { withTimezone: true }).notNull(),
    proposedOut: timestamp('proposed_out', { withTimezone: true }).notNull(),
    reason: text('reason'),
    status: approvalStatusEnum('status').notNull().default('pending'),
    decidedBy: uuid('decided_by').references(() => employees.id),
    decisionReason: text('decision_reason'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('attendance_reg_employee_idx').on(t.employeeId),
    index('attendance_reg_status_idx').on(t.status),
    check('attendance_reg_out_after_in_ck', sql`${t.proposedOut} > ${t.proposedIn}`),
  ],
);

/**
 * Remote-work requests (WFH / client visit / other remote), RM-approved. No
 * attendance row is written — an approved range classifies those days as
 * `wfh` (counts as present), unflags remote punches inside it, and is the
 * ONLY way to punch from beyond the flag radius (geo policy: office radius
 * clean, flag radius flagged, farther blocked without an approval).
 */
export const wfhRequests = orgSchema.table(
  'wfh_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    type: remoteWorkTypeEnum('type').notNull().default('remote'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    reason: text('reason'),
    status: approvalStatusEnum('status').notNull().default('pending'),
    // Dual approval (user decision): RM + HR, any order — mirrors leave_requests.
    rmApprovedBy: uuid('rm_approved_by').references(() => employees.id),
    rmApprovedAt: timestamp('rm_approved_at', { withTimezone: true }),
    hrApprovedBy: uuid('hr_approved_by').references(() => employees.id),
    hrApprovedAt: timestamp('hr_approved_at', { withTimezone: true }),
    decidedBy: uuid('decided_by').references(() => employees.id),
    decisionReason: text('decision_reason'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('wfh_requests_employee_idx').on(t.employeeId),
    index('wfh_requests_status_idx').on(t.status),
    check('wfh_requests_dates_ck', sql`${t.endDate} >= ${t.startDate}`),
  ],
);
