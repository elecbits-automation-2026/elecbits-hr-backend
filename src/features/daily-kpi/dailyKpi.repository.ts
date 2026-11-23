import type { DbClient } from '../../db/client.js';

/** A person the page judges, with the home department its targets come from. */
export interface KpiPerson {
  id: string;
  name: string;
  employeeCode: string;
  departmentId: string | null;
  departmentName: string | null;
}

const SELECT = `SELECT e.id, e.name, e.employee_code AS "employeeCode",
                       e.department_id AS "departmentId", d.name AS "departmentName"
                  FROM org.employees e
                  LEFT JOIN org.departments d ON d.id = e.department_id`;

/** Who is in each view — the only place this feature touches the database. */
export const createDailyKpiRepository = (db: DbClient) => ({
  person: async (id: string): Promise<KpiPerson | undefined> =>
    (await db.query<KpiPerson>(`${SELECT} WHERE e.id = $1`, [id]))[0],

  /** Same reach as the team goals / updates views: reports and leave-approvees. */
  team: (rmId: string) =>
    db.query<KpiPerson>(
      `${SELECT}
        WHERE (e.reports_to = $1 OR e.leave_approver = $1)
          AND e.status <> 'inactive' AND e.id <> $1
        ORDER BY e.name`,
      [rmId],
    ),

  /**
   * Goals each person moved the progress of in [from, to), per person. Read
   * from the append-only `goal.progress` audit rows — every move is kept
   * there with its time (goals.updated_at keeps only the last edit, and
   * also changes on definition edits and hiring-driven moves). Only the
   * owner moves progress, so a row is always the person's own move.
   */
  goalsMoved: async (
    ids: string[],
    from: Date,
    to: Date,
  ): Promise<Map<string, number>> => {
    if (ids.length === 0) return new Map();
    const rows = await db.query<{ employeeId: string; moved: number }>(
      `SELECT g.employee_id AS "employeeId", count(DISTINCT g.id)::int AS moved
         FROM access.audit_log a
         JOIN org.goals g ON a.subject = 'goals:' || g.id::text
        WHERE a.action = 'goal.progress'
          AND a.created_at >= $2 AND a.created_at < $3
          AND g.employee_id = ANY($1::uuid[])
        GROUP BY g.employee_id`,
      [ids, from, to],
    );
    return new Map(rows.map((r) => [r.employeeId, r.moved]));
  },

  /** Everyone working here — active or on notice — but the Admin account. */
  org: () =>
    db.query<KpiPerson>(
      `${SELECT}
        WHERE e.status IN ('active', 'exiting')
          AND NOT EXISTS (SELECT 1 FROM access.org_owner o WHERE o.employee_id = e.id)
        ORDER BY e.name`,
    ),
});

export type DailyKpiRepository = ReturnType<typeof createDailyKpiRepository>;
