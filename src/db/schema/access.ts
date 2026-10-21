import {
  check,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { employees } from './employees.js';
import { actionEnum, scopeEnum } from './enums.js';
import { users } from './identity.js';

/** The `access` schema: owner, batches, grants, requests, audit (§11.1). */
export const accessSchema = pgSchema('access');

/**
 * Singleton Owner table (§6): exactly one Owner at a time, enforced at the
 * database level — the `only_row` check pins the table to a single row whose
 * `id` is always 1, so a second INSERT violates the primary key.
 * Ownership transfer is a two-step handshake committed in one transaction
 * (§6, refinement) — implemented in the access service, not here.
 */
export const orgOwner = accessSchema.table(
  'org_owner',
  {
    id: integer('id').primaryKey().default(1),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    // §5.2: the first verified sign-in from the claim email creates the org and
    // closes the claim path permanently. This timestamp is the "closed" marker.
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('org_owner_only_row', sql`${t.id} = 1`)],
);

/** SuperAdmins (§6): more than one allowed; cannot seize ownership. */
export const superadmins = accessSchema.table('superadmins', {
  employeeId: uuid('employee_id')
    .primaryKey()
    .references(() => employees.id),
  grantedBy: uuid('granted_by').references(() => employees.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Grantable module keys, organised as a tree via `parentKey` (§4.2), e.g.
 * `pr.payroll` -> `pr.payroll.bank_details`. Grants on a parent do NOT cascade
 * to children — every sub-module needs its own explicit grant row (§4.2,
 * deliberate: a general grant can never silently leak a sensitive child).
 */
export const modules = accessSchema.table('modules', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  parentKey: text('parent_key').references((): AnyPgColumn => modules.key),
});

/**
 * Batches (§3.2): named, reusable bundles of grants. Editing a batch applies
 * live to everyone holding it (and is audit-logged). "Viewer"/"Editor" are not
 * a mechanism — just different action-sets written into batch_grants (§4.1).
 */
export const batches = accessSchema.table('batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The `(module, action, scope)` tuples a batch grants (§3.1). */
export const batchGrants = accessSchema.table(
  'batch_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),
    moduleKey: text('module_key')
      .notNull()
      .references(() => modules.key),
    action: actionEnum('action').notNull(),
    scope: scopeEnum('scope').notNull(),
  },
  (t) => [uniqueIndex('batch_grants_uq').on(t.batchId, t.moduleKey, t.action, t.scope)],
);

/**
 * "May assign" rights (§3.3): holders of `batchId` may attach `assignableBatchId`
 * to others (e.g. HRBP may assign the Employee batch). Anything outside the
 * assignable list becomes a request to the Owner (§5.5).
 */
export const batchAssignRights = accessSchema.table(
  'batch_assign_rights',
  {
    batchId: uuid('batch_id')
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),
    assignableBatchId: uuid('assignable_batch_id')
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('batch_assign_rights_uq').on(t.batchId, t.assignableBatchId)],
);

/** Which batches an employee holds. Multiple batches = the Venn overlap (§1). */
export const employeeBatches = accessSchema.table(
  'employee_batches',
  {
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => batches.id),
    grantedBy: uuid('granted_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('employee_batches_uq').on(t.employeeId, t.batchId)],
);

/**
 * Rare one-off exceptions layered on top of batches (§3.2) — never a one-off
 * batch for a single person. Effective access = union of batches + these rows;
 * there are no deny rules.
 */
export const individualGrants = accessSchema.table(
  'individual_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    moduleKey: text('module_key')
      .notNull()
      .references(() => modules.key),
    action: actionEnum('action').notNull(),
    scope: scopeEnum('scope').notNull(),
    grantedBy: uuid('granted_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('individual_grants_uq').on(t.employeeId, t.moduleKey, t.action, t.scope),
  ],
);

/**
 * Append-only audit log (§10): who changed what, when, and who approved it.
 * UPDATE/DELETE are revoked in the SQL migration so entries are immutable.
 */
export const auditLog = accessSchema.table(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The signed-in identity that made the change (nullable: system actions).
    actorUserId: uuid('actor_user_id').references(() => users.id),
    // Stable machine-readable label, e.g. 'batch.grant.added', 'exit.cleared'.
    action: text('action').notNull(),
    // What was acted on, as `<table>:<id>` plus a JSON payload of the change.
    subject: text('subject').notNull(),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_created_idx').on(t.createdAt)],
);
