import { and, eq, isNull } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { auditLog, seats } from '../../db/schema/index.js';
import type { SeatKind } from './seats.schema.js';

export type SeatRow = typeof seats.$inferSelect;

/** Who performed the mutation — null for the scheduler (system). */
export interface ActorContext {
  actorUserId: string | null;
  actorEmployeeId: string | null;
}

/** An open seat joined with the names the UI shows. */
export interface OpenSeat {
  id: string;
  seat: SeatKind;
  department_id: string | null;
  department_name: string | null;
  employee_id: string;
  employee_name: string;
  acting: boolean;
  started_at: Date;
}

const audit = (
  tx: DbClient,
  actor: ActorContext,
  action: string,
  seatId: string,
  detail?: Record<string, unknown>,
) =>
  tx.orm.insert(auditLog).values({
    actorUserId: actor.actorUserId,
    action,
    subject: `seats:${seatId}`,
    detail: detail ? JSON.stringify(detail) : null,
  });

const openOf = (seat: SeatKind, departmentId: string | null) =>
  and(
    eq(seats.seat, seat),
    departmentId ? eq(seats.departmentId, departmentId) : isNull(seats.departmentId),
    isNull(seats.endedAt),
  );

/** The only place the seats feature touches the database. */
export const createSeatsRepository = (db: DbClient) => ({
  listOpen: () =>
    db.query<OpenSeat>(
      `SELECT s.id, s.seat, s.department_id, d.name AS department_name,
              s.employee_id, e.name AS employee_name, s.acting, s.started_at
         FROM org.seats s
         JOIN org.employees e ON e.id = s.employee_id
         LEFT JOIN org.departments d ON d.id = s.department_id
        WHERE s.ended_at IS NULL
        ORDER BY s.seat, d.name`,
    ),

  departments: () =>
    db.query<{ id: string; name: string }>(
      `SELECT id, name FROM org.departments ORDER BY name`,
    ),

  departmentExists: async (id: string): Promise<boolean> =>
    (await db.query(`SELECT 1 FROM org.departments WHERE id = $1`, [id])).length > 0,

  employeeStatus: async (id: string): Promise<string | undefined> =>
    (
      await db.query<{ status: string }>(
        `SELECT status FROM org.employees WHERE id = $1`,
        [id],
      )
    )[0]?.status,

  /** The Admin (Owner) account — the company itself, never a seat holder. */
  ownerEmployeeId: async (): Promise<string | null> =>
    (
      await db.query<{ employee_id: string }>(`SELECT employee_id FROM access.org_owner`)
    )[0]?.employee_id ?? null,

  findOpen: async (
    seat: SeatKind,
    departmentId: string | null,
  ): Promise<SeatRow | undefined> =>
    (await db.orm.select().from(seats).where(openOf(seat, departmentId)).limit(1))[0],

  /** End the current holder (if any) and seat the new one, in one transaction. */
  assign: (
    input: {
      seat: SeatKind;
      departmentId: string | null;
      employeeId: string;
      acting: boolean;
    },
    actor: ActorContext,
  ): Promise<SeatRow> =>
    db.transaction(async (tx) => {
      const ended = await tx.orm
        .update(seats)
        .set({
          endedAt: new Date(),
          endedReason: 'replaced',
          endedBy: actor.actorEmployeeId,
        })
        .where(openOf(input.seat, input.departmentId))
        .returning();
      const rows = await tx.orm
        .insert(seats)
        .values({ ...input, assignedBy: actor.actorEmployeeId })
        .returning();
      const row = rows[0]!;
      await audit(tx, actor, 'seat.assigned', row.id, {
        seat: input.seat,
        departmentId: input.departmentId,
        employeeId: input.employeeId,
        acting: input.acting,
        replaced: ended[0]?.employeeId ?? null,
      });
      return row;
    }),

  /** End the current holder; false = nobody held it. */
  vacate: (
    seat: SeatKind,
    departmentId: string | null,
    actor: ActorContext,
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(seats)
        .set({
          endedAt: new Date(),
          endedReason: 'vacated',
          endedBy: actor.actorEmployeeId,
        })
        .where(openOf(seat, departmentId))
        .returning();
      if (!rows[0]) return false;
      await audit(tx, actor, 'seat.vacated', rows[0].id, {
        employeeId: rows[0].employeeId,
      });
      return true;
    }),
});

export type SeatsRepository = ReturnType<typeof createSeatsRepository>;

/**
 * Who holds a seat right now — for the TA steps (approvers, reviewers).
 * Undefined = the seat is empty, and dept-head steps wait (TA design).
 */
export const findSeatHolder = async (
  db: DbClient,
  seat: SeatKind,
  departmentId: string | null = null,
): Promise<{ employeeId: string; acting: boolean } | undefined> => {
  const row = await createSeatsRepository(db).findOpen(seat, departmentId);
  return row ? { employeeId: row.employeeId, acting: row.acting } : undefined;
};

/**
 * End every seat a leaver holds, inside the caller's transaction (exit-day
 * relieve). Returns the seats left empty so HR can be told.
 */
export const endSeatsOfLeaver = async (
  tx: DbClient,
  employeeId: string,
): Promise<Array<{ seat: SeatKind; department_name: string | null }>> => {
  const ended = await tx.query<{
    id: string;
    seat: SeatKind;
    department_name: string | null;
  }>(
    `UPDATE org.seats s SET ended_at = now(), ended_reason = 'relieved'
       FROM (SELECT s2.id, d.name AS department_name FROM org.seats s2
               LEFT JOIN org.departments d ON d.id = s2.department_id
              WHERE s2.employee_id = $1 AND s2.ended_at IS NULL) x
      WHERE s.id = x.id
      RETURNING s.id, s.seat, x.department_name`,
    [employeeId],
  );
  for (const s of ended) {
    await tx.orm.insert(auditLog).values({
      actorUserId: null,
      action: 'seat.ended_at_exit',
      subject: `seats:${s.id}`,
      detail: JSON.stringify({ employeeId }),
    });
  }
  return ended.map(({ seat, department_name }) => ({ seat, department_name }));
};
