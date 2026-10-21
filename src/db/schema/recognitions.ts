import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { orgSchema } from './departments.js';
import { employees } from './employees.js';
import { recognitionStatusEnum } from './enums.js';

/**
 * R&R nominations (refinement plan, Phase 2): a manager nominates their own
 * reports (HR nominates the self-governing top) with a written citation; HR
 * gives the single, final approval; only approved rows reach the board and,
 * the month after approval, the payslip. `cycle` ("2026-10" / "2026-Q4") is
 * stamped at APPROVAL — monthly/quarterly types allow one approved award per
 * window.
 *
 * `type` is a key of the HR-edited award catalog (settings awards.catalog),
 * free text so HR can add types; `awardName` and `valueInr` are SNAPSHOTS
 * taken at nomination, so editing or removing a catalog entry never rewrites
 * an award already given. A TEAM award to several people is one row per
 * recipient sharing `groupId`, the value split equally; only the group's
 * LEAD row counts for the cadence arbiter.
 */
export const recognitions = orgSchema.table(
  'recognitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    type: text('type').notNull(),
    awardName: text('award_name'),
    groupId: uuid('group_id'),
    groupLead: boolean('group_lead').notNull().default(true),
    citation: text('citation').notNull(),
    // Snapshot of the plan's ₹ value at nomination time.
    valueInr: integer('value_inr').notNull(),
    nominatedBy: uuid('nominated_by')
      .notNull()
      .references(() => employees.id),
    status: recognitionStatusEnum('status').notNull().default('pending'),
    cycle: text('cycle'),
    decidedBy: uuid('decided_by').references(() => employees.id),
    decisionReason: text('decision_reason'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('recognitions_employee_idx').on(t.employeeId, t.createdAt),
    index('recognitions_status_idx').on(t.status),
    index('recognitions_type_cycle_idx').on(t.type, t.cycle),
    // The cadence ARBITER (refinement plan, Phase 1): one APPROVED award per
    // type per window, enforced by the database so two racing approvals can't
    // both land. 'any'-cadence awards have a NULL cycle and never collide; a
    // team award's member rows (group_lead = false) don't count.
    uniqueIndex('recognitions_approved_cycle_uq')
      .on(t.type, t.cycle)
      .where(sql`status = 'approved' AND group_lead`),
    index('recognitions_group_idx').on(t.groupId),
  ],
);
