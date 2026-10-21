import {
  boolean,
  date,
  index,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { orgSchema } from './departments.js';
import { employees } from './employees.js';
import { exits } from './exits.js';
import { probationOutcomeEnum, probationStatusEnum } from './enums.js';

/**
 * The end-of-probation decision (close-out, user decisions 2026-10-16):
 * probation is a fixed 2 months with no extension; the RM recommends, HR
 * decides confirm or end; still undecided 7 days after the date = confirmed
 * automatically. Opened by the scheduler a week before the confirmation
 * date. While pending the person is still on probation (sick leave only).
 * Ending it starts a termination exit.
 */
export const probationReviews = orgSchema.table(
  'probation_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    dueOn: date('due_on').notNull(),
    status: probationStatusEnum('status').notNull().default('pending'),
    recommendation: probationOutcomeEnum('recommendation'),
    recommendationNote: text('recommendation_note'),
    recommendedBy: uuid('recommended_by').references(() => employees.id),
    recommendedAt: timestamp('recommended_at', { withTimezone: true }),
    decidedBy: uuid('decided_by').references(() => employees.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    // Confirmed by the 7-day rule, not by a person.
    autoConfirmed: boolean('auto_confirmed').notNull().default(false),
    // Ended: the termination exit it started.
    exitId: uuid('exit_id').references(() => exits.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('probation_reviews_employee_uq').on(t.employeeId),
    index('probation_reviews_status_idx').on(t.status),
  ],
);
