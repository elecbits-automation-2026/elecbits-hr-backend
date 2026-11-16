import { and, eq } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { auditLog, departmentMemberships, departments } from '../../db/schema/index.js';
import type { UnitKind } from './departments.schema.js';

export type DepartmentRow = typeof departments.$inferSelect;

/** Who performed the mutation. */
export interface ActorContext {
  actorUserId: string | null;
  actorEmployeeId: string | null;
}

/** A unit with its head / lead and member counts, as the page lists it. */
export interface UnitListRow {
  id: string;
  name: string;
  kind: UnitKind;
  parent_id: string | null;
  created_at: Date;
  head_id: string | null;
  head_name: string | null;
  head_acting: boolean | null;
  lead_id: string | null;
  lead_name: string | null;
  member_count: number;
  extra_count: number;
}

export interface MembershipListRow {
  id: string;
  department_id: string;
  employee_id: string;
  employee_name: string;
  is_lead: boolean;
  created_at: Date;
}

const audit = (
  tx: DbClient,
  actor: ActorContext,
  action: string,
  departmentId: string,
  detail?: Record<string, unknown>,
) =>
  tx.orm.insert(auditLog).values({
    actorUserId: actor.actorUserId,
    action,
    subject: `departments:${departmentId}`,
    detail: detail ? JSON.stringify(detail) : null,
  });

/** DB access for org units and their extra memberships. */
export const createDepartmentsRepository = (db: DbClient) => ({
  list: () =>
    db.query<UnitListRow>(
      `SELECT d.id, d.name, d.kind, d.parent_id, d.created_at,
              hs.employee_id AS head_id, he.name AS head_name, hs.acting AS head_acting,
              lm.employee_id AS lead_id, le.name AS lead_name,
              (SELECT count(*)::int FROM org.employees e
                WHERE e.department_id = d.id AND e.status <> 'inactive') AS member_count,
              (SELECT count(*)::int FROM org.department_memberships m
                 JOIN org.employees e ON e.id = m.employee_id
                WHERE m.department_id = d.id AND e.status <> 'inactive') AS extra_count
         FROM org.departments d
         LEFT JOIN org.seats hs
           ON hs.department_id = d.id AND hs.seat = 'dept_head' AND hs.ended_at IS NULL
         LEFT JOIN org.employees he ON he.id = hs.employee_id
         LEFT JOIN org.department_memberships lm ON lm.department_id = d.id AND lm.is_lead
         LEFT JOIN org.employees le ON le.id = lm.employee_id
        ORDER BY d.name`,
    ),

  findById: async (id: string): Promise<DepartmentRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(departments)
      .where(eq(departments.id, id))
      .limit(1);
    return rows[0];
  },

  /** Child units, home members and an open head seat — what blocks becoming a chapter. */
  usage: async (id: string) =>
    (
      await db.query<{ children: number; members: number; heads: number }>(
        `SELECT (SELECT count(*)::int FROM org.departments WHERE parent_id = $1) AS children,
                (SELECT count(*)::int FROM org.employees
                  WHERE department_id = $1 AND status <> 'inactive') AS members,
                (SELECT count(*)::int FROM org.seats
                  WHERE department_id = $1 AND seat = 'dept_head' AND ended_at IS NULL) AS heads`,
        [id],
      )
    )[0]!,

  employee: async (id: string) =>
    (
      await db.query<{
        id: string;
        name: string;
        status: string;
        department_id: string | null;
      }>(`SELECT id, name, status, department_id FROM org.employees WHERE id = $1`, [id])
    )[0],

  listMemberships: () =>
    db.query<MembershipListRow>(
      `SELECT m.id, m.department_id, m.employee_id, e.name AS employee_name, m.is_lead,
              m.created_at
         FROM org.department_memberships m
         JOIN org.employees e ON e.id = m.employee_id
        WHERE e.status <> 'inactive'
        ORDER BY m.is_lead DESC, e.name`,
    ),

  findMembership: async (id: string) =>
    (
      await db.orm
        .select()
        .from(departmentMemberships)
        .where(eq(departmentMemberships.id, id))
        .limit(1)
    )[0],

  insert: (
    input: { name: string; kind: UnitKind; parentId: string | null },
    actor: ActorContext,
  ): Promise<DepartmentRow> =>
    db.transaction(async (tx) => {
      const row = (await tx.orm.insert(departments).values(input).returning())[0]!;
      await audit(tx, actor, 'department.created', row.id, input);
      return row;
    }),

  /**
   * Rename / move / re-kind in one transaction. A unit that stops being a
   * chapter keeps its members as "also in" members, without a lead.
   */
  update: (
    id: string,
    patch: { name?: string; kind?: UnitKind; parentId?: string | null },
    before: DepartmentRow,
    actor: ActorContext,
  ): Promise<DepartmentRow> =>
    db.transaction(async (tx) => {
      const row = (
        await tx.orm
          .update(departments)
          .set(patch)
          .where(eq(departments.id, id))
          .returning()
      )[0]!;
      if (before.kind === 'chapter' && row.kind !== 'chapter') {
        await tx.orm
          .update(departmentMemberships)
          .set({ isLead: false })
          .where(eq(departmentMemberships.departmentId, id));
      }
      await audit(tx, actor, 'department.updated', id, {
        before: { name: before.name, kind: before.kind, parentId: before.parentId },
        after: { name: row.name, kind: row.kind, parentId: row.parentId },
      });
      return row;
    }),

  addMember: (departmentId: string, employeeId: string, actor: ActorContext) =>
    db.transaction(async (tx) => {
      const row = (
        await tx.orm
          .insert(departmentMemberships)
          .values({ departmentId, employeeId, addedBy: actor.actorEmployeeId })
          .returning()
      )[0]!;
      await audit(tx, actor, 'department.member_added', departmentId, { employeeId });
      return row;
    }),

  removeMember: (
    membership: { id: string; departmentId: string; employeeId: string },
    actor: ActorContext,
  ) =>
    db.transaction(async (tx) => {
      await tx.orm
        .delete(departmentMemberships)
        .where(eq(departmentMemberships.id, membership.id));
      await audit(tx, actor, 'department.member_removed', membership.departmentId, {
        employeeId: membership.employeeId,
      });
    }),

  /** Clear the chapter's lead and (when given) make this person the lead, adding them if needed. */
  setLead: (departmentId: string, employeeId: string | null, actor: ActorContext) =>
    db.transaction(async (tx) => {
      const cleared = await tx.orm
        .update(departmentMemberships)
        .set({ isLead: false })
        .where(
          and(
            eq(departmentMemberships.departmentId, departmentId),
            eq(departmentMemberships.isLead, true),
          ),
        )
        .returning();
      if (employeeId) {
        await tx.orm
          .insert(departmentMemberships)
          .values({
            departmentId,
            employeeId,
            isLead: true,
            addedBy: actor.actorEmployeeId,
          })
          .onConflictDoUpdate({
            target: [
              departmentMemberships.departmentId,
              departmentMemberships.employeeId,
            ],
            set: { isLead: true },
          });
      }
      await audit(tx, actor, 'department.lead_set', departmentId, {
        employeeId,
        replaced: cleared[0]?.employeeId ?? null,
      });
    }),
});

export type DepartmentsRepository = ReturnType<typeof createDepartmentsRepository>;
