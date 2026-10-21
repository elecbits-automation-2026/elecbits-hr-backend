import { index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orgSchema } from './departments.js';
import { employees } from './employees.js';
import { feedbackTypeEnum } from './enums.js';

/**
 * Feedback notes — the actionable end of the insights loop (user decision):
 * the SYSTEM drafts a note from evidence (an insight + its period), a HUMAN
 * reviews, edits and sends. Appreciation or concern, always person-to-person,
 * never auto-sent. Visible to the recipient (their Home) and the author;
 * sending is audited without the body.
 */
export const feedbackNotes = orgSchema.table(
  'feedback_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    authorId: uuid('author_id')
      .notNull()
      .references(() => employees.id),
    type: feedbackTypeEnum('type').notNull(),
    body: text('body').notNull(),
    // What the draft was based on — insight kind + human-readable evidence
    // (e.g. "3 late check-ins in the last 7 punched days · 2026-10"). Kept so
    // a note can always answer "why did I get this?".
    evidence: text('evidence'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('feedback_notes_employee_idx').on(t.employeeId, t.createdAt),
    index('feedback_notes_author_idx').on(t.authorId, t.createdAt),
  ],
);
