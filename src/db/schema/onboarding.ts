import {
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
import { bytea } from './policies.js';
import {
  onboardingPhaseEnum,
  onboardingStatusEnum,
  onboardingTaskOwnerEnum,
} from './enums.js';

/**
 * One onboarding journey per hire (adopted from the hr-tool review): a
 * three-phase checklist instantiated from the template at creation, dated
 * from the joining date. Tasks are copied, not referenced, so editing the
 * template never rewrites running journeys.
 */
export const onboardingJourneys = orgSchema.table('onboarding_journeys', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id')
    .notNull()
    .unique() // one journey per person — restart = a conscious HR decision later
    .references(() => employees.id),
  startedOn: date('started_on').notNull(),
  dueOn: date('due_on').notNull(), // startedOn + 30 (the "first 30 days" line)
  status: onboardingStatusEnum('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Checklist items. `owner` is who the task WAITS ON — the service lets only
 * that owner (or broad HR) tick it. A task with `policy_code` is never ticked
 * directly: it derives its done state from the policy acknowledgement.
 */
export const onboardingTasks = orgSchema.table(
  'onboarding_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    journeyId: uuid('journey_id')
      .notNull()
      .references(() => onboardingJourneys.id),
    seq: integer('seq').notNull(),
    phase: onboardingPhaseEnum('phase').notNull(),
    taskKey: text('task_key').notNull(),
    title: text('title').notNull(),
    owner: onboardingTaskOwnerEnum('owner').notNull(),
    // Loose link to org.policies.code — the ack flow completes these tasks.
    policyCode: text('policy_code'),
    doneAt: timestamp('done_at', { withTimezone: true }),
    doneBy: uuid('done_by').references(() => employees.id),
    // What was done — required on a plain tick (proof, learner 2026-11-05).
    doneNote: text('done_note'),
  },
  (t) => [
    uniqueIndex('onboarding_tasks_uq').on(t.journeyId, t.taskKey),
    index('onboarding_tasks_journey_idx').on(t.journeyId),
  ],
);

/**
 * The proof behind a document step (ID / address, bank-PAN-UAN, BGV form):
 * uploading the file is what completes the task (test pass 2026-11-03 — a
 * bare tick proved nothing). One file per task, replaced on re-upload;
 * stored like leave certificates.
 */
export const onboardingTaskFiles = orgSchema.table('onboarding_task_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id')
    .notNull()
    .unique()
    .references(() => onboardingTasks.id),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  data: bytea('data').notNull(),
  uploadedBy: uuid('uploaded_by')
    .notNull()
    .references(() => employees.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
});
