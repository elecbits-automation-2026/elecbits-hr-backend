import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { orgSchema } from './departments.js';
import { employees } from './employees.js';
import { policyCategoryEnum } from './enums.js';

/** Raw bytes — drizzle has no built-in bytea. */
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Every stored-file table keeps its bytes in exactly one place: the row's
 * `data` (STORAGE_DRIVER=db) or the company Shared Drive (`drive_file_id`).
 * Both may be set only for an instant during files:to-drive, which writes the
 * id and clears the bytes in one UPDATE — so "at least one" is the invariant.
 */
export const storedFileCheck = (
  name: string,
  t: { data: AnyPgColumn; driveFileId: AnyPgColumn },
) => check(name, sql`${t.data} IS NOT NULL OR ${t.driveFileId} IS NOT NULL`);

/**
 * Policy library — one row per policy CODE; `version` is the CURRENT version.
 * Acknowledgements are stored against a SPECIFIC version (user decision,
 * adopted from the hr-tool review): bumping the version asks everyone to sign
 * again while the old signatures stay on record as history; editing any other
 * field re-asks nobody.
 */
export const policies = orgSchema.table('policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Stable short handle ('coc', 'leave') — referenced by onboarding tasks.
  code: text('code').notNull().unique(),
  title: text('title').notNull(),
  category: policyCategoryEnum('category').notNull(),
  version: text('version').notNull(),
  ackRequired: boolean('ack_required').notNull().default(true),
  summary: text('summary'),
  docUrl: text('doc_url'),
  effectiveFrom: date('effective_from'),
  /**
   * RETIRED (refinement plan, Phase 1): set = withdrawn from the library and
   * the tracker and no longer signable; the row and every signature stay on
   * record forever. Clearing it restores the policy.
   */
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  retiredBy: uuid('retired_by').references(() => employees.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Acknowledgements, APPEND-ONLY: a row is one person signing one version of
 * one policy, never updated or deleted. "Has X acknowledged P?" compares the
 * latest ack's version with the policy's current version — equal is `ok`,
 * older is `stale` (re-ack needed), none is `none`.
 */
/**
 * The policy DOCUMENT itself, stored in OUR database (user decision) — one
 * current PDF per policy, replaced wholesale on re-upload. Serving it goes
 * through the API like any other read, so an external link can never go
 * stale or leak outside the login.
 */
export const policyDocuments = orgSchema.table(
  'policy_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    policyId: uuid('policy_id')
      .notNull()
      .unique()
      .references(() => policies.id),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    // Bytes in the row (STORAGE_DRIVER=db) or only the Shared Drive id (drive);
    // storedFileCheck keeps exactly one of them set.
    data: bytea('data'),
    driveFileId: text('drive_file_id'),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => employees.id),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [storedFileCheck('policy_documents_stored_ck', t)],
);

export const policyAcks = orgSchema.table(
  'policy_acks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => policies.id),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    version: text('version').notNull(),
    ackedAt: timestamp('acked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One signature per person per version — the double-click arbiter.
    uniqueIndex('policy_acks_uq').on(t.policyId, t.employeeId, t.version),
    index('policy_acks_employee_idx').on(t.employeeId),
  ],
);
