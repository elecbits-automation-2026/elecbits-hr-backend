import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { departments, orgSchema } from './departments.js';
import { employees } from './employees.js';
import { seatEnum } from './enums.js';

/**
 * Seats HR assigns explicitly (TA design): a department's head and the VP (a
 * company seat, no powers yet; the HR head is the HR department's head). The TA head seat is retired. Who
 * holds a seat is a relationship, not a grant —
 * nothing is derived from level or designation. A row is one holder's
 * tenure: replacing or vacating ENDS it (never deleted), so history answers
 * "who was head when this was approved". `acting` marks a stand-in after the
 * head left. One open row per seat (per department for `dept_head`).
 */
export const seats = orgSchema.table(
  'seats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seat: seatEnum('seat').notNull(),
    departmentId: uuid('department_id').references(() => departments.id),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    acting: boolean('acting').notNull().default(false),
    assignedBy: uuid('assigned_by').references(() => employees.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** 'replaced' | 'vacated' | 'relieved' */
    endedReason: text('ended_reason'),
    endedBy: uuid('ended_by').references(() => employees.id),
  },
  (t) => [
    check(
      'seats_department_ck',
      sql`(${t.seat} = 'dept_head') = (${t.departmentId} IS NOT NULL)`,
    ),
    // NULLs are distinct in a unique index, so the department seat and the
    // company-wide seats each get their own "one open holder" arbiter.
    uniqueIndex('seats_open_dept_uq')
      .on(t.seat, t.departmentId)
      .where(sql`${t.endedAt} IS NULL AND ${t.departmentId} IS NOT NULL`),
    uniqueIndex('seats_open_org_uq')
      .on(t.seat)
      .where(sql`${t.endedAt} IS NULL AND ${t.departmentId} IS NULL`),
    index('seats_employee_idx').on(t.employeeId),
  ],
);
