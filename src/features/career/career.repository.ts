import { and, asc, desc, eq, gte, inArray, ne, or, sql } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { insertNotifications } from '../notifications/index.js';
import {
  attendance,
  auditLog,
  careerLevelChanges,
  careerTrackNotes,
  careerTracks,
  employees,
  feedbackNotes,
  reviewCycles,
  goals,
  recognitions,
} from '../../db/schema/index.js';

export type CareerTrackRow = typeof careerTracks.$inferSelect;

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

export type LevelChangeRow = typeof careerLevelChanges.$inferSelect;
export type TrackNoteRow = typeof careerTrackNotes.$inferSelect;
type Level = LevelChangeRow['toLevel'];

/**
 * Promotion history, written by whoever changes employees.level, inside THEIR
 * transaction. A change that reaches the open track's target closes that
 * track as met and links it. Same-level writes record nothing.
 */
export const recordLevelChange = async (
  db: DbClient,
  input: { employeeId: string; from: Level; to: Level },
  actor: ActorContext,
): Promise<void> => {
  if (input.from === input.to) return;
  const open = await db.orm
    .select()
    .from(careerTracks)
    .where(and(eq(careerTracks.employeeId, input.employeeId), eq(careerTracks.status, 'open')))
    .limit(1);
  const met = open[0] && input.to >= open[0].targetBand ? open[0] : undefined;
  if (met) {
    await db.orm
      .update(careerTracks)
      .set({
        status: 'met',
        closedBy: actor.actorEmployeeId,
        closedAt: new Date(),
        closeReason: `Moved to ${input.to}`,
      })
      .where(eq(careerTracks.id, met.id));
  }
  await db.orm.insert(careerLevelChanges).values({
    employeeId: input.employeeId,
    fromLevel: input.from,
    toLevel: input.to,
    changedBy: actor.actorEmployeeId,
    trackId: met?.id ?? null,
  });
  await db.orm.insert(auditLog).values({
    actorUserId: actor.actorUserId,
    action: 'career.level_changed',
    subject: `employees:${input.employeeId}`,
    detail: JSON.stringify({ from: input.from, to: input.to, trackMet: met?.id ?? null }),
  });
};

/** The only place the career feature touches the database. */
export const createCareerRepository = (db: DbClient) => ({
  findEmployee: async (employeeId: string) => {
    const rows = await db.orm
      .select({
        id: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
        status: employees.status,
        level: employees.level,
        reportsTo: employees.reportsTo,
        leaveApprover: employees.leaveApprover,
        dateOfJoining: employees.dateOfJoining,
      })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);
    return rows[0];
  },

  findOpenTrack: async (employeeId: string): Promise<CareerTrackRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(careerTracks)
      .where(and(eq(careerTracks.employeeId, employeeId), eq(careerTracks.status, 'open')))
      .limit(1);
    return rows[0];
  },

  findTrackById: async (id: string): Promise<CareerTrackRow | undefined> => {
    const rows = await db.orm.select().from(careerTracks).where(eq(careerTracks.id, id)).limit(1);
    return rows[0];
  },

  insertTrack: async (
    input: {
      employeeId: string;
      bandCode: CareerTrackRow['bandCode'];
      targetBand: CareerTrackRow['targetBand'];
      note: string | null;
    },
    actor: ActorContext,
  ): Promise<CareerTrackRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .insert(careerTracks)
        .values({ ...input, openedBy: actor.actorEmployeeId })
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'career.track_opened',
        subject: `employees:${input.employeeId}`,
        detail: JSON.stringify({ from: input.bandCode, toward: input.targetBand }),
      });
      return rows[0]!;
    });
  },

  /** Close + audit; the WHERE re-asserts `open` so a double close returns nothing. */
  closeTrack: async (
    id: string,
    patch: { status: 'met' | 'closed'; closeReason: string | null },
    actor: ActorContext,
  ): Promise<CareerTrackRow | undefined> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(careerTracks)
        .set({ ...patch, closedBy: actor.actorEmployeeId, closedAt: new Date() })
        .where(and(eq(careerTracks.id, id), eq(careerTracks.status, 'open')))
        .returning();
      if (!rows[0]) return undefined;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'career.track_closed',
        subject: `employees:${rows[0].employeeId}`,
        detail: JSON.stringify({ outcome: patch.status }),
      });
      return rows[0];
    });
  },

  /** Evidence reads — all derived, nothing typed in. */
  punchedDaysSince: async (employeeId: string, fromDate: string): Promise<number> => {
    const rows = await db.orm
      .select({ id: attendance.id })
      .from(attendance)
      .where(and(eq(attendance.employeeId, employeeId), gte(attendance.date, fromDate)));
    return rows.length;
  },

  approvedRecognitionsFor: async (
    employeeIds: string[],
  ): Promise<Map<string, { count: number; lastAt: Date | null }>> => {
    if (employeeIds.length === 0) return new Map();
    const rows = await db.orm
      .select({ employeeId: recognitions.employeeId, decidedAt: recognitions.decidedAt })
      .from(recognitions)
      .where(
        and(eq(recognitions.status, 'approved'), inArray(recognitions.employeeId, employeeIds)),
      )
      .orderBy(desc(recognitions.decidedAt));
    const map = new Map<string, { count: number; lastAt: Date | null }>();
    for (const r of rows) {
      const entry = map.get(r.employeeId) ?? { count: 0, lastAt: null };
      entry.count += 1;
      if (!entry.lastAt && r.decidedAt) entry.lastAt = r.decidedAt;
      map.set(r.employeeId, entry);
    }
    return map;
  },

  appreciationNotesCount: async (employeeId: string): Promise<number> => {
    const rows = await db.orm
      .select({ id: feedbackNotes.id })
      .from(feedbackNotes)
      .where(and(eq(feedbackNotes.employeeId, employeeId), eq(feedbackNotes.type, 'appreciation')));
    return rows.length;
  },

  /** The caller's direct chain (reports_to OR leave_approver), like /me/team. */
  listChain: async (rmId: string) => {
    return db.orm
      .select({
        id: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
        level: employees.level,
      })
      .from(employees)
      .where(
        and(
          or(eq(employees.reportsTo, rmId), eq(employees.leaveApprover, rmId)),
          ne(employees.status, 'inactive'),
        ),
      )
      .orderBy(sql`${employees.level} desc`, employees.name);
  },

  openTracksFor: async (employeeIds: string[]): Promise<Map<string, CareerTrackRow>> => {
    if (employeeIds.length === 0) return new Map();
    const rows = await db.orm
      .select()
      .from(careerTracks)
      .where(
        and(eq(careerTracks.status, 'open'), inArray(careerTracks.employeeId, employeeIds)),
      );
    return new Map(rows.map((r) => [r.employeeId, r]));
  },

  /** Promotion history, oldest first. */
  levelChanges: async (employeeId: string): Promise<LevelChangeRow[]> =>
    db.orm
      .select()
      .from(careerLevelChanges)
      .where(eq(careerLevelChanges.employeeId, employeeId))
      .orderBy(asc(careerLevelChanges.createdAt)),

  /** The most recent track this person had closed WITHOUT a promotion. */
  lastClosedTrack: async (employeeId: string): Promise<CareerTrackRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(careerTracks)
      .where(and(eq(careerTracks.employeeId, employeeId), eq(careerTracks.status, 'closed')))
      .orderBy(desc(careerTracks.closedAt))
      .limit(1);
    return rows[0];
  },

  /**
   * Goals of one quarter, by cycle name. Read-only: a quarter nobody has
   * opened yet has no cycle row and simply returns no goals.
   */
  goalsInCycle: async (employeeId: string, cycleName: string) =>
    db.orm
      .select({ progress: goals.progress, weight: goals.weight, category: goals.category })
      .from(goals)
      .innerJoin(reviewCycles, eq(goals.cycleId, reviewCycles.id))
      .where(and(eq(goals.employeeId, employeeId), eq(reviewCycles.name, cycleName))),

  listNotes: async (trackId: string): Promise<TrackNoteRow[]> =>
    db.orm
      .select()
      .from(careerTrackNotes)
      .where(eq(careerTrackNotes.trackId, trackId))
      .orderBy(asc(careerTrackNotes.createdAt)),

  /** A note + the employee's bell, one transaction. */
  insertNote: async (
    input: { trackId: string; employeeId: string; body: string },
    actor: ActorContext,
  ): Promise<TrackNoteRow> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .insert(careerTrackNotes)
        .values({ trackId: input.trackId, authorId: actor.actorEmployeeId, body: input.body })
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'career.note_added',
        subject: `employees:${input.employeeId}`,
        detail: JSON.stringify({ trackId: input.trackId }),
      });
      await insertNotifications(tx, [input.employeeId], {
        type: 'career.note',
        title: 'New note on your growth roadmap',
        link: '/growth',
      });
      return rows[0]!;
    }),

  namesByIds: async (ids: string[]): Promise<Map<string, string>> => {
    if (ids.length === 0) return new Map();
    const rows = await db.orm
      .select({ id: employees.id, name: employees.name })
      .from(employees)
      .where(inArray(employees.id, ids));
    return new Map(rows.map((r) => [r.id, r.name]));
  },
});

export type CareerRepository = ReturnType<typeof createCareerRepository>;
