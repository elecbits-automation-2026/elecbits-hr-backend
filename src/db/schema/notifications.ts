import { index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orgSchema } from './departments.js';
import { employees } from './employees.js';

/**
 * In-app notifications — the bell (refinement plan, Phase 0 — X2). One row
 * per recipient per event, written by the feature that owns the event, in the
 * same transaction as the change it announces. Addressed to the EMPLOYEE (the
 * domain identity every feature already speaks), not the login user. `type`
 * is a free-text event key (e.g. 'policy.reack') so sources can be added
 * without a migration. Email is v2.
 */
export const notifications = orgSchema.table(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => employees.id),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    /** In-app path the bell navigates to, e.g. '/policies'. */
    link: text('link'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [index('notifications_recipient_created_idx').on(t.recipientId, t.createdAt)],
);
