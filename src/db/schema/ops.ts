import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { punchZones } from './attendance.js';
import { employees } from './employees.js';
import {
  assetCategoryKindEnum,
  assetConditionEnum,
  assetIncidentKindEnum,
  assetRequestStatusEnum,
  assetRequestTypeEnum,
  assetStatusEnum,
  gatePassStatusEnum,
  stockMovementKindEnum,
} from './enums.js';

/** The `ops` schema: the asset manager (register, history, requests, gate passes, incidents, kits, stock) and the scheduler tables (§11.1). */
export const opsSchema = pgSchema('ops');

/**
 * Asset categories (OPS setup). `lab` ones are lent with a due date;
 * `requiresGatePass` decides whether an item may leave a zone at all —
 * lab equipment and samples, never laptops (user decision).
 */
export const assetCategories = opsSchema.table('asset_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  // Tag prefix OPS uses for this category (EB-LAP-0042 -> "LAP").
  codePrefix: text('code_prefix').notNull().unique(),
  kind: assetCategoryKindEnum('kind').notNull().default('equipment'),
  requiresGatePass: boolean('requires_gate_pass').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The asset register. Every asset ALWAYS sits in a punch zone; a person may
 * hold it on top of that (status `assigned`). No person = it belongs to the
 * zone. The current holder is kept here for fast reads; every change is also
 * appended to `asset_events` — nothing is overwritten.
 */
export const assets = opsSchema.table(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The tag OPS sticks on the asset (e.g. "EB-LAP-0042").
    assetCode: text('asset_code').notNull().unique(),
    name: text('name').notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => assetCategories.id),
    status: assetStatusEnum('status').notNull().default('idle'),
    zoneId: uuid('zone_id')
      .notNull()
      .references(() => punchZones.id),
    holderId: uuid('holder_id').references(() => employees.id),
    // Lab loans only: when the holder must bring it back to the zone.
    loanDueOn: date('loan_due_on'),
    make: text('make'),
    model: text('model'),
    serialNo: text('serial_no'),
    purchasedOn: date('purchased_on'),
    purchaseCost: numeric('purchase_cost', { precision: 12, scale: 2 }),
    vendor: text('vendor'),
    warrantyUntil: date('warranty_until'),
    condition: assetConditionEnum('condition').notNull().default('good'),
    notes: text('notes'),
    giftedTo: uuid('gifted_to').references(() => employees.id),
    // Scrapped / gifted / lost: when and why it left the register.
    disposedOn: date('disposed_on'),
    disposeReason: text('dispose_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('assets_holder_idx').on(t.holderId),
    index('assets_zone_idx').on(t.zoneId),
    check(
      'assets_holder_matches_status',
      sql`(${t.status} = 'assigned') = (${t.holderId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Asset history, append-only: registered, issued, returned, transferred, zone
 * moved, status changed, gate-pass and loan steps, incidents. The custody
 * trail (who held it, where) is the issue / return / transfer rows. Never
 * edited or deleted.
 */
export const assetEvents = opsSchema.table(
  'asset_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    // registered | edited | issued | returned | transferred | zone_changed |
    // status_changed | loan_back | loan_extended | pass_requested |
    // pass_approved | pass_declined | pass_back | pass_extended |
    // incident_opened | incident_closed
    kind: text('kind').notNull(),
    // The person the step concerns (new holder, returner, pass holder…).
    employeeId: uuid('employee_id').references(() => employees.id),
    zoneId: uuid('zone_id').references(() => punchZones.id),
    status: assetStatusEnum('status'),
    condition: assetConditionEnum('condition'),
    dueOn: date('due_on'),
    prevDueOn: date('prev_due_on'),
    note: text('note'),
    byEmployeeId: uuid('by_employee_id').references(() => employees.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('asset_events_asset_idx').on(t.assetId, t.at)],
);

/**
 * Employee requests for a new asset / upgrade / replacement / repair / return.
 * Routed to the OPS QUEUE (anyone holding the OPS batch), not a named person.
 * Fulfilling an upgrade / replacement issues the new asset and takes the old
 * one back in one step.
 */
export const assetRequests = opsSchema.table(
  'asset_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => employees.id),
    type: assetRequestTypeEnum('type').notNull(),
    // The asset it is about (upgrade / replacement / repair / return).
    assetId: uuid('asset_id').references(() => assets.id),
    // What they want (new / upgrade / replacement), when they say.
    categoryId: uuid('category_id').references(() => assetCategories.id),
    note: text('note'),
    status: assetRequestStatusEnum('status').notNull().default('open'),
    handledBy: uuid('handled_by').references(() => employees.id),
    handlerNote: text('handler_note'),
    // The asset OPS issued to fulfil it.
    fulfilledAssetId: uuid('fulfilled_asset_id').references(() => assets.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('asset_requests_requested_by_idx').on(t.requestedBy)],
);

/**
 * Gate passes — taking a flagged-category item out of its zone. The
 * requester accepts responsibility (the disclaimer) and is answerable for it
 * until it is back; OPS alone approves, and approval lets it leave; the RM is
 * told (FYI). After return_on the holder is asked "back or still out?".
 */
export const gatePasses = opsSchema.table(
  'gate_passes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => employees.id),
    purpose: text('purpose').notNull(),
    destination: text('destination').notNull(),
    // Current due date (moves on "still out"); the first one is kept.
    returnOn: date('return_on').notNull(),
    originalReturnOn: date('original_return_on').notNull(),
    disclaimerAcceptedAt: timestamp('disclaimer_accepted_at', {
      withTimezone: true,
    }).notNull(),
    status: gatePassStatusEnum('status').notNull().default('requested'),
    decidedBy: uuid('decided_by').references(() => employees.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    declineReason: text('decline_reason'),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    returnedConfirmedBy: uuid('returned_confirmed_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('gate_passes_requested_by_idx').on(t.requestedBy),
    // One live pass per asset.
    uniqueIndex('gate_passes_one_open_uq')
      .on(t.assetId)
      .where(sql`status IN ('requested', 'approved')`),
  ],
);

/** Damage / loss / theft — recorded only (no payroll recovery, user decision). */
export const assetIncidents = opsSchema.table(
  'asset_incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    // Who had it at the time (holder, or the gate-pass holder while out).
    employeeId: uuid('employee_id').references(() => employees.id),
    kind: assetIncidentKindEnum('kind').notNull(),
    description: text('description').notNull(),
    reportedBy: uuid('reported_by')
      .notNull()
      .references(() => employees.id),
    // open | closed
    status: text('status').notNull().default('open'),
    outcome: text('outcome'),
    closedBy: uuid('closed_by').references(() => employees.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('asset_incidents_asset_idx').on(t.assetId)],
);

/** Joiner kits: what a designation should be given (a checklist for OPS). */
export const assetKits = opsSchema.table(
  'asset_kits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    designation: text('designation').notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => assetCategories.id),
    qty: integer('qty').notNull().default(1),
  },
  (t) => [
    uniqueIndex('asset_kits_designation_category_uq').on(t.designation, t.categoryId),
  ],
);

/** Consumable stock items (components, cables, stationery) — counted, not tagged. */
export const stockItems = opsSchema.table('stock_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  sku: text('sku').notNull().unique(),
  name: text('name').notNull(),
  category: text('category'),
  unit: text('unit').notNull().default('pcs'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Current quantity per item per zone — kept in step with the ledger, never below 0. */
export const stockLevels = opsSchema.table(
  'stock_levels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => stockItems.id),
    zoneId: uuid('zone_id')
      .notNull()
      .references(() => punchZones.id),
    qty: integer('qty').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('stock_levels_item_zone_uq').on(t.itemId, t.zoneId),
    check('stock_levels_qty_non_negative', sql`${t.qty} >= 0`),
  ],
);

/** The stock ledger, append-only. A transfer is a transfer_out + transfer_in pair. */
export const stockMovements = opsSchema.table(
  'stock_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => stockItems.id),
    zoneId: uuid('zone_id')
      .notNull()
      .references(() => punchZones.id),
    kind: stockMovementKindEnum('kind').notNull(),
    // Signed: + into the zone, - out of it.
    qty: integer('qty').notNull(),
    // issue: who took it.
    employeeId: uuid('employee_id').references(() => employees.id),
    // Ties the two rows of a transfer together.
    transferId: uuid('transfer_id'),
    note: text('note'),
    byEmployeeId: uuid('by_employee_id')
      .notNull()
      .references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('stock_movements_item_idx').on(t.itemId, t.createdAt),
    index('stock_movements_employee_idx').on(t.employeeId),
  ],
);

/**
 * Background job runs (end-of-pass scheduler). One row per job per run key
 * (a date for daily jobs, `manual-…` for "run now"); the unique key is the
 * cross-instance lock — whoever inserts it runs it, everyone else skips.
 */
export const scheduledJobRuns = opsSchema.table(
  'scheduled_job_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    job: text('job').notNull(),
    runKey: text('run_key').notNull(),
    // running | succeeded | failed
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(1),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    summary: jsonb('summary'),
    error: text('error'),
  },
  (t) => [
    uniqueIndex('scheduled_job_runs_job_key_uq').on(t.job, t.runKey),
    index('scheduled_job_runs_started_idx').on(t.startedAt),
  ],
);

/** Every approval reminder sent — so the next one waits its turn. */
export const remindersSent = opsSchema.table(
  'reminders_sent',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // leave | remote_work | regularization | reimbursement | late_update | access_request |
    // nomination | concern_overdue | return_due | return_due_ops | return_escalated |
    // hiring_plan:<quarter> (per department) | hiring_plan_due:<quarter> (per recipient)
    kind: text('kind').notNull(),
    subjectId: uuid('subject_id').notNull(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => employees.id),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reminders_sent_lookup_idx').on(t.kind, t.subjectId, t.recipientId, t.sentAt),
  ],
);
