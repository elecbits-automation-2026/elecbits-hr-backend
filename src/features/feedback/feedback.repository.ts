import { desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbClient } from '../../db/client.js';
import { auditLog, employees, feedbackNotes } from '../../db/schema/index.js';
import type { CreateFeedbackInput } from './feedback.schema.js';

export type FeedbackRow = typeof feedbackNotes.$inferSelect;
export type FeedbackJoinedRow = FeedbackRow & {
  employeeName: string;
  authorName: string;
};

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

const recipient = alias(employees, 'recipient');
const author = alias(employees, 'author');

const joined = {
  row: feedbackNotes,
  employeeName: recipient.name,
  authorName: author.name,
};

const flatten = (
  rows: Array<{ row: FeedbackRow; employeeName: string; authorName: string }>,
) =>
  rows.map((r): FeedbackJoinedRow => ({
    ...r.row,
    employeeName: r.employeeName,
    authorName: r.authorName,
  }));

/** The only place the feedback feature touches the database. */
export const createFeedbackRepository = (db: DbClient) => ({
  /** Recipient row + chain fields the send-gate needs, in one read. */
  findRecipient: async (employeeId: string) => {
    const rows = await db.orm
      .select({
        id: employees.id,
        name: employees.name,
        status: employees.status,
        reportsTo: employees.reportsTo,
        leaveApprover: employees.leaveApprover,
      })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);
    return rows[0];
  },

  /** Insert + audit (no body in the audit — §10 style), one transaction. */
  insert: async (
    input: CreateFeedbackInput,
    actor: ActorContext,
  ): Promise<FeedbackRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .insert(feedbackNotes)
        .values({
          employeeId: input.employeeId,
          authorId: actor.actorEmployeeId,
          type: input.type,
          body: input.body,
          evidence: input.evidence ?? null,
        })
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'feedback.sent',
        subject: `employees:${input.employeeId}`,
        detail: JSON.stringify({
          type: input.type,
          hasEvidence: Boolean(input.evidence),
        }),
      });
      return rows[0]!;
    });
  },

  listForRecipient: async (employeeId: string): Promise<FeedbackJoinedRow[]> => {
    const rows = await db.orm
      .select(joined)
      .from(feedbackNotes)
      .innerJoin(recipient, eq(feedbackNotes.employeeId, recipient.id))
      .innerJoin(author, eq(feedbackNotes.authorId, author.id))
      .where(eq(feedbackNotes.employeeId, employeeId))
      .orderBy(desc(feedbackNotes.createdAt));
    return flatten(rows);
  },

  listByAuthor: async (authorId: string): Promise<FeedbackJoinedRow[]> => {
    const rows = await db.orm
      .select(joined)
      .from(feedbackNotes)
      .innerJoin(recipient, eq(feedbackNotes.employeeId, recipient.id))
      .innerJoin(author, eq(feedbackNotes.authorId, author.id))
      .where(eq(feedbackNotes.authorId, authorId))
      .orderBy(desc(feedbackNotes.createdAt));
    return flatten(rows);
  },
});

export type FeedbackRepository = ReturnType<typeof createFeedbackRepository>;
