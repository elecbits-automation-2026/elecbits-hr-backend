import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbClient } from '../../db/client.js';
import { auditLog, employees, orgOwner, recognitions } from '../../db/schema/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';

export type RecognitionRow = typeof recognitions.$inferSelect;
export type RecognitionJoinedRow = RecognitionRow & {
  employeeName: string;
  nominatorName: string;
};

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

type Notify = { recipientIds: string[]; event: NotificationEvent };

const recipient = alias(employees, 'recipient');
const nominator = alias(employees, 'nominator');

const joined = {
  row: recognitions,
  employeeName: recipient.name,
  nominatorName: nominator.name,
};

const flatten = (
  rows: Array<{ row: RecognitionRow; employeeName: string; nominatorName: string }>,
): RecognitionJoinedRow[] =>
  rows.map((r) => ({
    ...r.row,
    employeeName: r.employeeName,
    nominatorName: r.nominatorName,
  }));

const joinedSelect = (db: DbClient) =>
  db.orm
    .select(joined)
    .from(recognitions)
    .innerJoin(recipient, eq(recognitions.employeeId, recipient.id))
    .innerJoin(nominator, eq(recognitions.nominatedBy, nominator.id));

/** Every row of a nomination: the row itself, or its whole team group. */
const sameNomination = (row: Pick<RecognitionRow, 'id' | 'groupId'>) =>
  row.groupId ? eq(recognitions.groupId, row.groupId) : eq(recognitions.id, row.id);

/** The only place the recognitions feature touches the database. */
export const createRecognitionsRepository = (db: DbClient) => ({
  /** Recipient rows + chain fields the gates need, in one read. */
  findRecipients: async (employeeIds: string[]) => {
    if (employeeIds.length === 0) return [];
    return db.orm
      .select({
        id: employees.id,
        name: employees.name,
        status: employees.status,
        reportsTo: employees.reportsTo,
        leaveApprover: employees.leaveApprover,
      })
      .from(employees)
      .where(inArray(employees.id, employeeIds));
  },

  /**
   * One nomination = one row per recipient (a team award shares `groupId`,
   * the first row is the group's lead), + audit + HR's bell, one transaction.
   */
  insertNomination: async (
    rows: Array<{
      employeeId: string;
      valueInr: number;
    }>,
    shared: { type: string; awardName: string; citation: string; groupId: string | null },
    actor: ActorContext,
    notify: Notify,
  ): Promise<RecognitionRow[]> => {
    return db.transaction(async (tx) => {
      const inserted = await tx.orm
        .insert(recognitions)
        .values(
          rows.map((r, i) => ({
            employeeId: r.employeeId,
            valueInr: r.valueInr,
            type: shared.type,
            awardName: shared.awardName,
            citation: shared.citation,
            groupId: shared.groupId,
            groupLead: i === 0,
            nominatedBy: actor.actorEmployeeId,
          })),
        )
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'recognition.nominated',
        subject: `recognitions:${inserted[0]!.id}`,
        detail: JSON.stringify({
          type: shared.type,
          recipients: rows.map((r) => r.employeeId),
          groupId: shared.groupId,
        }),
      });
      await insertNotifications(tx, notify.recipientIds, notify.event);
      return inserted;
    });
  },

  findById: async (id: string): Promise<RecognitionRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(recognitions)
      .where(eq(recognitions.id, id))
      .limit(1);
    return rows[0];
  },

  /** Every row of the nomination `row` belongs to (just itself unless a team award). */
  findNominationRows: async (row: RecognitionRow): Promise<RecognitionJoinedRow[]> =>
    flatten(
      await joinedSelect(db)
        .where(sameNomination(row))
        .orderBy(desc(recognitions.groupLead)),
    ),

  /**
   * Decide a whole nomination (every team row together) + audit + bell, one
   * transaction. The WHERE re-asserts `pending`, so a concurrent decision
   * finds nothing to change instead of overwriting; the partial unique index
   * on the lead row is the cadence arbiter.
   */
  applyDecision: async (
    row: RecognitionRow,
    patch: {
      status: 'approved' | 'declined';
      cycle: string | null;
      decisionReason: string | null;
    },
    actor: ActorContext,
    notify: Notify,
  ): Promise<RecognitionRow[]> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(recognitions)
        .set({ ...patch, decidedBy: actor.actorEmployeeId, decidedAt: new Date() })
        .where(and(sameNomination(row), eq(recognitions.status, 'pending')))
        .returning();
      if (rows.length === 0) return [];
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: `recognition.${patch.status}`,
        subject: `recognitions:${row.id}`,
        detail: JSON.stringify({
          type: row.type,
          cycle: patch.cycle,
          recipients: rows.map((r) => r.employeeId),
        }),
      });
      await insertNotifications(tx, notify.recipientIds, notify.event);
      return rows;
    });
  },

  /** Approved same-type awards in a cadence window (lead rows only). */
  countApprovedInCycle: async (type: string, cycle: string): Promise<number> => {
    const rows = await db.orm
      .select({ id: recognitions.id })
      .from(recognitions)
      .where(
        and(
          eq(recognitions.type, type),
          eq(recognitions.status, 'approved'),
          eq(recognitions.cycle, cycle),
          eq(recognitions.groupLead, true),
        ),
      );
    return rows.length;
  },

  listApproved: async (): Promise<RecognitionJoinedRow[]> => {
    const rows = await joinedSelect(db)
      .where(eq(recognitions.status, 'approved'))
      .orderBy(desc(recognitions.decidedAt));
    return flatten(rows);
  },

  listForRecipient: async (employeeId: string): Promise<RecognitionJoinedRow[]> => {
    const rows = await joinedSelect(db)
      .where(
        and(eq(recognitions.employeeId, employeeId), eq(recognitions.status, 'approved')),
      )
      .orderBy(desc(recognitions.decidedAt));
    return flatten(rows);
  },

  listByNominator: async (nominatedBy: string): Promise<RecognitionJoinedRow[]> => {
    const rows = await joinedSelect(db)
      .where(eq(recognitions.nominatedBy, nominatedBy))
      .orderBy(desc(recognitions.createdAt));
    return flatten(rows);
  },

  listPending: async (): Promise<RecognitionJoinedRow[]> => {
    const rows = await joinedSelect(db)
      .where(eq(recognitions.status, 'pending'))
      .orderBy(asc(recognitions.createdAt));
    return flatten(rows);
  },

  /**
   * The nomination picker: live people (never the administration account)
   * whose EFFECTIVE RM is the caller — plus, for HR, the self-governing top
   * (effective RM = the Owner record).
   */
  directory: async (callerId: string, ownerId: string | null) => {
    const effectiveRmIs = (id: string) =>
      or(
        eq(employees.leaveApprover, id),
        and(isNull(employees.leaveApprover), eq(employees.reportsTo, id)),
      );
    return db.orm
      .select({
        id: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
        designation: employees.designation,
      })
      .from(employees)
      .leftJoin(orgOwner, eq(orgOwner.employeeId, employees.id))
      .where(
        and(
          eq(employees.status, 'active'),
          isNull(orgOwner.employeeId),
          ownerId
            ? or(effectiveRmIs(callerId), effectiveRmIs(ownerId))
            : effectiveRmIs(callerId),
        ),
      )
      .orderBy(asc(employees.name));
  },
});

export type RecognitionsRepository = ReturnType<typeof createRecognitionsRepository>;
