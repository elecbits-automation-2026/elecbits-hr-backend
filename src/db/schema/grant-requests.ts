import { text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accessSchema, batches } from './access.js';
import { employees } from './employees.js';
import { actionEnum, requestStatusEnum, scopeEnum } from './enums.js';

/**
 * Grant requests (§5.5): HRBP (or anyone whose assignable list doesn't cover a
 * batch) asks the Owner for extra access, with a note on the person's role.
 * The Owner can approve as requested, approve something NARROWER, or decline
 * with a recorded reason — hence the separate items table: requested items and
 * granted items can differ (§5.5, decision #18).
 *
 * No self-approval, at any level (§10) — enforced in the service.
 * Pending requests are cancelled when the subject exits (§8).
 */
export const grantRequests = accessSchema.table('grant_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Who the access is FOR.
  employeeId: uuid('employee_id')
    .notNull()
    .references(() => employees.id),
  // Who asked.
  requestedBy: uuid('requested_by')
    .notNull()
    .references(() => employees.id),
  // "What the person's role is, and what access is proposed" (§5.5).
  note: text('note'),
  status: requestStatusEnum('status').notNull().default('pending'),
  decidedBy: uuid('decided_by').references(() => employees.id),
  decisionReason: text('decision_reason'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per requested (or granted) unit. A unit is either a whole batch or a
 * single `(module, action, scope)` tuple; `kind` disambiguates. `granted=false`
 * rows are what was asked; on approval the decision writes `granted=true` rows,
 * which may be a subset or a narrower variant ("approve narrower", §5.5).
 */
export const grantRequestItems = accessSchema.table('grant_request_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id')
    .notNull()
    .references(() => grantRequests.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['batch', 'grant'] }).notNull(),
  batchId: uuid('batch_id').references(() => batches.id),
  moduleKey: text('module_key'),
  action: actionEnum('action'),
  scope: scopeEnum('scope'),
  granted: text('granted', { enum: ['requested', 'granted'] })
    .notNull()
    .default('requested'),
});
