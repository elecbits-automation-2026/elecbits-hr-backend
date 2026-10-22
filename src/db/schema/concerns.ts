import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { orgSchema } from './departments.js';
import { employees } from './employees.js';
import {
  concernNoteKindEnum,
  concernStatusEnum,
  concernTrackEnum,
  openDoorBookingStatusEnum,
  openDoorRequestStatusEnum,
} from './enums.js';

/**
 * A concern (Batch 4): one case in one of the three policy tracks.
 *  - dispute: an employee contests a decision — Dispute Resolution Framework,
 *    level 1 RM → 2 HR → 3 Management Review Committee (final);
 *  - complaint: someone's conduct — Equal Opportunity §J / anti-bullying;
 *  - whistleblower: misconduct, fraud, ethics — the vigil team only.
 * `raised_by` is null for an anonymous report (complaints and whistleblower
 * only); the raiser then follows up with the code + a key whose HASH is kept
 * here. Bodies never reach the audit log.
 */
export const concerns = orgSchema.table(
  'concerns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    track: concernTrackEnum('track').notNull(),
    category: text('category').notNull(),
    decisionArea: text('decision_area'),
    subjectEmployeeId: uuid('subject_employee_id').references(() => employees.id),
    relatedConcernId: uuid('related_concern_id').references(
      (): AnyPgColumn => concerns.id,
    ),
    raisedBy: uuid('raised_by').references(() => employees.id),
    anonymous: boolean('anonymous').notNull().default(false),
    followUpKeyHash: text('follow_up_key_hash'),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    status: concernStatusEnum('status').notNull().default('open'),
    // Disputes: the level the case sits at, when it was decided, and the last
    // day the raiser may escalate it.
    level: integer('level'),
    levelDecidedAt: timestamp('level_decided_at', { withTimezone: true }),
    levelDecidedBy: uuid('level_decided_by').references(() => employees.id),
    escalateBy: date('escalate_by'),
    ackAt: timestamp('ack_at', { withTimezone: true }),
    ackBy: uuid('ack_by').references(() => employees.id),
    dueAckOn: date('due_ack_on'),
    dueResolveOn: date('due_resolve_on'),
    extendedTo: date('extended_to'),
    extensionReason: text('extension_reason'),
    outcome: text('outcome'),
    resolution: text('resolution'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('concerns_track_status_idx').on(t.track, t.status),
    index('concerns_raised_by_idx').on(t.raisedBy),
    check(
      'concerns_anonymous_ck',
      sql`(${t.anonymous} AND ${t.raisedBy} IS NULL AND ${t.followUpKeyHash} IS NOT NULL) OR (NOT ${t.anonymous} AND ${t.raisedBy} IS NOT NULL)`,
    ),
  ],
);

/** The case thread: internal notes, replies to the raiser, decisions, system lines. */
export const concernNotes = orgSchema.table(
  'concern_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    concernId: uuid('concern_id')
      .notNull()
      .references(() => concerns.id),
    // Null = the anonymous raiser.
    authorId: uuid('author_id').references(() => employees.id),
    kind: concernNoteKindEnum('kind').notNull(),
    level: integer('level'),
    body: text('body').notNull(),
    visibleToRaiser: boolean('visible_to_raiser').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('concern_notes_concern_idx').on(t.concernId, t.createdAt)],
);

/** Open door (Batch 4): a time someone (HR or a department head) is available to talk. */
export const openDoorSlots = orgSchema.table(
  'open_door_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => employees.id),
    date: date('date').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    capacity: integer('capacity').notNull().default(1),
    note: text('note'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('open_door_slots_date_idx').on(t.date),
    check('open_door_slots_time_ck', sql`${t.endTime} > ${t.startTime}`),
    check('open_door_slots_capacity_ck', sql`${t.capacity} BETWEEN 1 AND 20`),
  ],
);

/** A booking of a slot; the topic is visible to the slot's owner only. */
export const openDoorBookings = orgSchema.table(
  'open_door_bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slotId: uuid('slot_id')
      .notNull()
      .references(() => openDoorSlots.id),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    topic: text('topic'),
    status: openDoorBookingStatusEnum('status').notNull().default('booked'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('open_door_bookings_slot_employee_uq').on(t.slotId, t.employeeId)],
);

/**
 * "Request a session" (test-pass fix 2026-10-22): asked of a chosen host
 * (`host_id`), or — for a named concern — of whoever handles the case now
 * (`concern_id`, host resolved at read time). An offer creates a 1-seat slot
 * booked for the requester (`slot_id`). The topic is private to the host(s).
 */
export const openDoorRequests = orgSchema.table(
  'open_door_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    hostId: uuid('host_id').references(() => employees.id),
    concernId: uuid('concern_id').references(() => concerns.id),
    preferredFrom: date('preferred_from').notNull(),
    preferredTo: date('preferred_to').notNull(),
    topic: text('topic'),
    status: openDoorRequestStatusEnum('status').notNull().default('requested'),
    slotId: uuid('slot_id').references(() => openDoorSlots.id),
    declineReason: text('decline_reason'),
    decidedBy: uuid('decided_by').references(() => employees.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('open_door_requests_status_idx').on(t.status),
    index('open_door_requests_employee_idx').on(t.employeeId),
    index('open_door_requests_host_idx').on(t.hostId),
    check(
      'open_door_requests_target_ck',
      sql`${t.hostId} IS NOT NULL OR ${t.concernId} IS NOT NULL`,
    ),
    check('open_door_requests_range_ck', sql`${t.preferredTo} >= ${t.preferredFrom}`),
  ],
);
