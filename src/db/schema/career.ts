import { sql } from 'drizzle-orm';
import { index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { orgSchema } from './departments.js';
import { employees } from './employees.js';
import { careerTrackStatusEnum, levelEnum } from './enums.js';

/**
 * Career tracks (adopted from the hr-tool review): a row says "a roadmap
 * conversation about the band above is OPEN" — who opened it, from which
 * band toward which. Deliberately not a promotion record; the promotion
 * itself is an employees.level edit by HR. One open track per person.
 */
export const careerTracks = orgSchema.table(
  'career_tracks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    bandCode: levelEnum('band_code').notNull(), // level when the track opened
    targetBand: levelEnum('target_band').notNull(),
    note: text('note'),
    openedBy: uuid('opened_by')
      .notNull()
      .references(() => employees.id),
    status: careerTrackStatusEnum('status').notNull().default('open'),
    closedBy: uuid('closed_by').references(() => employees.id),
    closeReason: text('close_reason'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One open conversation per person — the DB-level arbiter.
    uniqueIndex('career_tracks_open_uq')
      .on(t.employeeId)
      .where(sql`${t.status} = 'open'`),
  ],
);

/**
 * Promotion history: one row per change of employees.level, written in the
 * same transaction as the edit. `trackId` links the open roadmap the change
 * fulfilled, when there was one. The newest row's createdAt is "in band since".
 */
export const careerLevelChanges = orgSchema.table(
  'career_level_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    fromLevel: levelEnum('from_level').notNull(),
    toLevel: levelEnum('to_level').notNull(),
    changedBy: uuid('changed_by').references(() => employees.id),
    trackId: uuid('track_id').references(() => careerTracks.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('career_level_changes_employee_idx').on(t.employeeId, t.createdAt)],
);

/** The conversation itself: RM/HR write, the employee reads. */
export const careerTrackNotes = orgSchema.table(
  'career_track_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trackId: uuid('track_id')
      .notNull()
      .references(() => careerTracks.id),
    authorId: uuid('author_id')
      .notNull()
      .references(() => employees.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('career_track_notes_track_idx').on(t.trackId, t.createdAt)],
);
