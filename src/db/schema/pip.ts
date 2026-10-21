import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { orgSchema } from './departments.js';
import { employees } from './employees.js';
import { pipCheckinRatingEnum, pipStatusEnum } from './enums.js';

/**
 * Performance Improvement Plans (close-out, user decisions 2026-10-16).
 * Never started automatically: a poor quarter score only rings the RM, who
 * decides. The RM writes targets and support; HR approves; the employee
 * acknowledges; 60 days with a check-in every 2 weeks; the outcome is passed,
 * extended once by 30 days, or not passed (HR may then start a
 * termination). A dispute doesn't pause it (policy §3.5).
 */
export const pips = orgSchema.table(
  'pips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    // The RM who opened it.
    rmId: uuid('rm_id')
      .notNull()
      .references(() => employees.id),
    status: pipStatusEnum('status').notNull().default('pending_hr'),
    reason: text('reason').notNull(),
    // [{ title, measure }]
    targets: jsonb('targets').notNull(),
    support: text('support').notNull(),
    startOn: date('start_on').notNull(),
    endOn: date('end_on').notNull(),
    extended: boolean('extended').notNull().default(false),
    hrBy: uuid('hr_by').references(() => employees.id),
    hrAt: timestamp('hr_at', { withTimezone: true }),
    hrNote: text('hr_note'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    outcomeNote: text('outcome_note'),
    outcomeBy: uuid('outcome_by').references(() => employees.id),
    outcomeAt: timestamp('outcome_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pips_employee_idx').on(t.employeeId),
    // One live PIP per person.
    uniqueIndex('pips_one_live_uq')
      .on(t.employeeId)
      .where(sql`status IN ('pending_hr', 'active')`),
  ],
);

/** The RM's fortnightly check-ins. */
export const pipCheckins = orgSchema.table(
  'pip_checkins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pipId: uuid('pip_id')
      .notNull()
      .references(() => pips.id),
    on: date('on').notNull(),
    rating: pipCheckinRatingEnum('rating').notNull(),
    note: text('note').notNull(),
    by: uuid('by')
      .notNull()
      .references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('pip_checkins_pip_idx').on(t.pipId)],
);
