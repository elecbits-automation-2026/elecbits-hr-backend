import { date, index, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orgSchema } from './departments.js';
import { trainingStatusEnum, trainingStreamEnum } from './enums.js';
import { employees } from './employees.js';
import { bytea, storedFileCheck } from './policies.js';

/**
 * Trainings (learner, 2026-11-16): a manager assigns to their own reports,
 * HR to anyone (one person or many at once — the rows share `batchId`). The
 * person marks it done, optionally with a certificate; the assigner or HR
 * may reopen or withdraw it. Rows are never deleted.
 */
export const trainings = orgSchema.table(
  'trainings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    title: text('title').notNull(),
    stream: trainingStreamEnum('stream').notNull(),
    description: text('description'),
    /** Where to take it (course URL, Drive file, …). */
    link: text('link'),
    dueOn: date('due_on'),
    status: trainingStatusEnum('status').notNull().default('assigned'),
    /** Rows assigned together in one go. */
    batchId: uuid('batch_id'),
    assignedBy: uuid('assigned_by')
      .notNull()
      .references(() => employees.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completionNote: text('completion_note'),
    cancelledBy: uuid('cancelled_by').references(() => employees.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => [
    index('trainings_employee_idx').on(t.employeeId),
    index('trainings_status_due_idx').on(t.status, t.dueOn),
  ],
);

/** The proof a person attached when completing a training (one per training). */
export const trainingCertificates = orgSchema.table(
  'training_certificates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trainingId: uuid('training_id')
      .notNull()
      .unique()
      .references(() => trainings.id),
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
  (t) => [storedFileCheck('training_certificates_stored_ck', t)],
);
