import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { auditLog, concernNotes, concerns, employees } from '../../db/schema/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';

export type ConcernRow = typeof concerns.$inferSelect;
export type ConcernInsert = typeof concerns.$inferInsert;
export type ConcernNoteRow = typeof concernNotes.$inferSelect;

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

/** A bell to ring in the same transaction. */
export interface Bell {
  to: string[];
  event: NotificationEvent;
}

/** A note to add in the same transaction. */
export interface NoteInsert {
  authorId: string | null;
  kind: ConcernNoteRow['kind'];
  level?: number | null;
  body: string;
  visibleToRaiser: boolean;
}

/** The only place the concerns feature touches the database. */
export const createConcernsRepository = (db: DbClient) => {
  /** Audit rows carry ids and transitions only — never bodies or names (policy §9). */
  const audit = (
    tx: DbClient,
    actor: ActorContext | null,
    concern: ConcernRow,
    action: string,
  ) =>
    tx.orm.insert(auditLog).values({
      actorUserId: actor?.actorUserId ?? null,
      action: `concern.${action}`,
      subject: `concerns:${concern.id}`,
      detail: JSON.stringify({
        track: concern.track,
        status: concern.status,
        level: concern.level,
      }),
    });

  return {
    findEmployee: async (id: string) =>
      (
        await db.orm
          .select({
            id: employees.id,
            name: employees.name,
            status: employees.status,
            reportsTo: employees.reportsTo,
            leaveApprover: employees.leaveApprover,
          })
          .from(employees)
          .where(eq(employees.id, id))
          .limit(1)
      )[0],

    /** Everyone in work (active or serving notice) — the "who is it about" picker. */
    people: () =>
      db.orm
        .select({
          id: employees.id,
          name: employees.name,
          employeeCode: employees.employeeCode,
          designation: employees.designation,
        })
        .from(employees)
        .where(inArray(employees.status, ['active', 'exiting']))
        .orderBy(asc(employees.name)),

    namesByIds: async (ids: string[]): Promise<Map<string, string>> => {
      if (ids.length === 0) return new Map();
      const rows = await db.orm
        .select({ id: employees.id, name: employees.name })
        .from(employees)
        .where(inArray(employees.id, ids));
      return new Map(rows.map((r) => [r.id, r.name]));
    },

    holidaysFrom: async (from: string): Promise<Set<string>> => {
      const rows = await db.query<{ date: string }>(
        `SELECT date::text AS date FROM org.holidays WHERE date >= $1`,
        [from],
      );
      return new Set(rows.map((r) => r.date));
    },

    findById: async (id: string): Promise<ConcernRow | undefined> =>
      (await db.orm.select().from(concerns).where(eq(concerns.id, id)).limit(1))[0],

    findByCode: async (code: string): Promise<ConcernRow | undefined> =>
      (await db.orm.select().from(concerns).where(eq(concerns.code, code)).limit(1))[0],

    listByRaiser: (employeeId: string): Promise<ConcernRow[]> =>
      db.orm
        .select()
        .from(concerns)
        .where(eq(concerns.raisedBy, employeeId))
        .orderBy(desc(concerns.createdAt)),

    /** Cases still in someone's hands — queues filter these by handler. */
    listActive: (): Promise<ConcernRow[]> =>
      db.orm
        .select()
        .from(concerns)
        .where(notInArray(concerns.status, ['closed', 'resolved', 'declined']))
        .orderBy(asc(concerns.createdAt)),

    listNotes: (concernId: string): Promise<ConcernNoteRow[]> =>
      db.orm
        .select()
        .from(concernNotes)
        .where(eq(concernNotes.concernId, concernId))
        .orderBy(asc(concernNotes.createdAt)),

    /** Next sequential code for a prefix and year: DSP-2026-001. */
    nextCode: async (prefix: string, year: number): Promise<string> => {
      const rows = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM org.concerns WHERE code LIKE $1`,
        [`${prefix}-${year}-%`],
      );
      return `${prefix}-${year}-${String((rows[0]?.n ?? 0) + 1).padStart(3, '0')}`;
    },

    /** New case + its first note + audit + handler bells, one transaction. */
    insert: async (
      values: ConcernInsert,
      firstNote: NoteInsert,
      actor: ActorContext,
      bells: Bell[],
    ): Promise<ConcernRow> =>
      db.transaction(async (tx) => {
        const rows = await tx.orm.insert(concerns).values(values).returning();
        const row = rows[0]!;
        await tx.orm.insert(concernNotes).values({ ...firstNote, concernId: row.id });
        // An anonymous report is audited without its actor.
        await audit(tx, row.anonymous ? null : actor, row, 'raised');
        for (const b of bells) await insertNotifications(tx, b.to, b.event);
        return row;
      }),

    /**
     * One transition: patch the case (re-asserting the status it was read in,
     * so two handlers can't both act), add notes, audit, ring bells.
     */
    transition: async (
      id: string,
      expectedStatus: ConcernRow['status'],
      patch: Partial<ConcernInsert>,
      notes: NoteInsert[],
      actor: ActorContext | null,
      action: string,
      bells: Bell[],
    ): Promise<ConcernRow | undefined> =>
      db.transaction(async (tx) => {
        const rows = await tx.orm
          .update(concerns)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(concerns.id, id), eq(concerns.status, expectedStatus)))
          .returning();
        const row = rows[0];
        if (!row) return undefined;
        if (notes.length > 0) {
          await tx.orm
            .insert(concernNotes)
            .values(notes.map((n) => ({ ...n, concernId: id })));
        }
        await audit(tx, actor, row, action);
        for (const b of bells) await insertNotifications(tx, b.to, b.event);
        return row;
      }),

    /** A note on its own (no status change) + bells. */
    addNote: async (
      concern: ConcernRow,
      note: NoteInsert,
      actor: ActorContext | null,
      bells: Bell[],
    ): Promise<ConcernNoteRow> =>
      db.transaction(async (tx) => {
        const rows = await tx.orm
          .insert(concernNotes)
          .values({ ...note, concernId: concern.id })
          .returning();
        await tx.orm
          .update(concerns)
          .set({ updatedAt: new Date() })
          .where(eq(concerns.id, concern.id));
        await audit(tx, actor, concern, note.visibleToRaiser ? 'replied' : 'noted');
        for (const b of bells) await insertNotifications(tx, b.to, b.event);
        return rows[0]!;
      }),

    /** Level-2 decider of a dispute (excluded from deciding level 3). */
    deciderAtLevel: async (concernId: string, level: number): Promise<string | null> => {
      const rows = await db.orm
        .select({ authorId: concernNotes.authorId })
        .from(concernNotes)
        .where(
          and(
            eq(concernNotes.concernId, concernId),
            eq(concernNotes.kind, 'decision'),
            eq(concernNotes.level, level),
          ),
        )
        .orderBy(desc(concernNotes.createdAt))
        .limit(1);
      return rows[0]?.authorId ?? null;
    },

    /** Overdue active cases: due date (or extension) before `today`. */
    overdueActive: async (today: string): Promise<ConcernRow[]> =>
      db.orm
        .select()
        .from(concerns)
        .where(
          and(
            notInArray(concerns.status, ['closed', 'resolved', 'declined', 'decided']),
            sql`coalesce(${concerns.extendedTo}, CASE WHEN ${concerns.ackAt} IS NULL AND ${concerns.dueAckOn} IS NOT NULL THEN ${concerns.dueAckOn} ELSE ${concerns.dueResolveOn} END) < ${today}`,
          ),
        ),
  };
};

export type ConcernsRepository = ReturnType<typeof createConcernsRepository>;
