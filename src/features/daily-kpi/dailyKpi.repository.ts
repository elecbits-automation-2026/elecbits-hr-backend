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
