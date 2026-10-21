import type { DbClient } from '../../db/client.js';
import type { Action, Scope } from '../../shared/constants/constants.js';

export interface ResolvedAccess {
  /** Owner or SuperAdmin — passes every check (§6). */
  bypass: boolean;
  /** Scopes of every matching batch/individual grant (empty = no access). */
  scopes: Scope[];
}

/**
 * Whose rows a caller's grants reach (refinement plan, Phase 3 scope
 * filtering). `all` = every employee (bypass or an org grant); otherwise the
 * union of what each held scope reaches — always including the holder.
 */
export type PeopleScope = { all: true } | { all: false; ids: Set<string> };

export const reachesIn = (scope: PeopleScope, employeeId: string): boolean =>
  scope.all || scope.ids.has(employeeId);

/**
 * The read side of the single decision point `access.can(module, action)`
 * (§11.3), used by the requireAccess middleware on every request. One
 * round-trip: owner/superadmin membership and all matching grant rows come
 * back together. Grants are NEVER cached into the JWT — resolving them here
 * per request is what makes revocation immediate (§9/§10).
 */
export const createAuthzRepository = (db: DbClient) => {
  const reachableFor = (holderId: string, access: ResolvedAccess) =>
    repo.reachable(holderId, access);
  const repo = {
    resolveAccess: async (
      employeeId: string,
      moduleKey: string,
      action: Action,
    ): Promise<ResolvedAccess> => {
      const rows = await db.query<{ kind: string; scope: string }>(
        `SELECT kind, scope FROM (
         SELECT 'owner' AS kind, 'org' AS scope
           FROM access.org_owner WHERE employee_id = $1
         UNION ALL
         SELECT 'superadmin', 'org'
           FROM access.superadmins WHERE employee_id = $1
         UNION ALL
         SELECT 'batch', bg.scope::text
           FROM access.employee_batches eb
           JOIN access.batch_grants bg ON bg.batch_id = eb.batch_id
          WHERE eb.employee_id = $1 AND bg.module_key = $2 AND bg.action = $3::action
         UNION ALL
         SELECT 'individual', ig.scope::text
           FROM access.individual_grants ig
          WHERE ig.employee_id = $1 AND ig.module_key = $2 AND ig.action = $3::action
       ) t`,
        [employeeId, moduleKey, action],
      );

      return {
        bypass: rows.some((r) => r.kind === 'owner' || r.kind === 'superadmin'),
        scopes: rows
          .filter((r) => r.kind === 'batch' || r.kind === 'individual')
          .map((r) => r.scope as Scope),
      };
    },

    /**
     * Live people who hold `moduleKey`/`action` at org or dept scope through a
     * batch or an individual grant — the audience for HR-facing bell events.
     * SuperAdmins are included; the Owner (the administration account) is not.
     */
    listBroadHolders: async (
      moduleKey: string,
      action: Action,
      subjectId?: string,
    ): Promise<string[]> => {
      // Every live holder with the grant at any scope (and SuperAdmins), with
      // the scopes they hold it at; then keep those who reach the subject — or,
      // with no subject, only org-wide holders.
      const rows = await db.query<{
        id: string;
        superadmin: boolean;
        scopes: string[] | null;
      }>(
        `SELECT e.id,
              EXISTS (SELECT 1 FROM access.superadmins s WHERE s.employee_id = e.id) AS superadmin,
              (SELECT array_agg(DISTINCT x.scope) FROM (
                 SELECT bg.scope::text AS scope FROM access.employee_batches eb
                   JOIN access.batch_grants bg ON bg.batch_id = eb.batch_id
                  WHERE eb.employee_id = e.id AND bg.module_key = $1 AND bg.action = $2::action
                 UNION ALL
                 SELECT ig.scope::text FROM access.individual_grants ig
                  WHERE ig.employee_id = e.id AND ig.module_key = $1 AND ig.action = $2::action
               ) x) AS scopes
         FROM org.employees e
        WHERE e.status IN ('active', 'exiting')
          AND NOT EXISTS (SELECT 1 FROM access.org_owner o WHERE o.employee_id = e.id)`,
        [moduleKey, action],
      );
      const out: string[] = [];
      for (const r of rows) {
        const access: ResolvedAccess = {
          bypass: r.superadmin,
          scopes: (r.scopes ?? []) as Scope[],
        };
        if (!access.bypass && access.scopes.length === 0) continue;
        if (access.bypass || access.scopes.includes('org')) {
          out.push(r.id);
          continue;
        }
        if (!subjectId) continue;
        const reach = await reachableFor(r.id, access);
        if (reachesIn(reach, subjectId)) out.push(r.id);
      }
      return out;
    },

    /**
     * What a set of grant scopes reaches from the holder:
     *   me          — the holder only
     *   team_direct — + people whose reports_to OR leave_approver is the holder
     *   team        — + everyone below the holder in the reporting tree
     *   dept        — + everyone in the holder's department
     *   org         — everyone
     * No scopes at all reaches nobody. Inactive records are included: HR
     * reads history; status rules live in each feature.
     */
    reachable: async (holderId: string, access: ResolvedAccess): Promise<PeopleScope> => {
      if (access.bypass || access.scopes.includes('org')) return { all: true };
      if (access.scopes.length === 0) return { all: false, ids: new Set() };
      const has = (s: Scope) => access.scopes.includes(s);
      const rows = await db.query<{ id: string }>(
        `WITH RECURSIVE tree AS (
         SELECT id FROM org.employees WHERE reports_to = $1 OR leave_approver = $1
         UNION
         SELECT e.id FROM org.employees e JOIN tree t ON e.reports_to = t.id
       )
       SELECT $1::uuid AS id
       UNION SELECT id FROM org.employees
        WHERE $2 AND (reports_to = $1 OR leave_approver = $1)
       UNION SELECT id FROM tree WHERE $3
       UNION SELECT e.id FROM org.employees e
        WHERE $4 AND e.department_id IS NOT NULL
          AND e.department_id = (SELECT department_id FROM org.employees WHERE id = $1)`,
        [holderId, has('team_direct'), has('team'), has('dept')],
      );
      return { all: false, ids: new Set(rows.map((r) => r.id)) };
    },

    /** The Owner's employee id — the administration account (null before the org claim). */
    ownerId: async (): Promise<string | null> => {
      const rows = await db.query<{ employee_id: string }>(
        'SELECT employee_id FROM access.org_owner LIMIT 1',
        [],
      );
      return rows[0]?.employee_id ?? null;
    },

    /** Who manages this person — the RM-or-HR gate's relationship half. */
    findReportingLine: async (
      employeeId: string,
    ): Promise<
      | { status: string; reportsTo: string | null; leaveApprover: string | null }
      | undefined
    > => {
      const rows = await db.query<{
        status: string;
        reports_to: string | null;
        leave_approver: string | null;
      }>(
        `SELECT status::text AS status, reports_to, leave_approver
         FROM org.employees WHERE id = $1`,
        [employeeId],
      );
      const row = rows[0];
      return row
        ? {
            status: row.status,
            reportsTo: row.reports_to,
            leaveApprover: row.leave_approver,
          }
        : undefined;
    },
    /** Resolve the caller's grants and what they reach, in one call. */
    peopleScope: async (
      employeeId: string,
      moduleKey: string,
      action: Action,
    ): Promise<PeopleScope> =>
      repo.reachable(employeeId, await repo.resolveAccess(employeeId, moduleKey, action)),

    /** May the caller act on THIS person under (module, action)? */
    reaches: async (
      employeeId: string,
      moduleKey: string,
      action: Action,
      targetId: string,
    ): Promise<boolean> =>
      reachesIn(await repo.peopleScope(employeeId, moduleKey, action), targetId),
  };
  return repo;
};

export type AuthzRepository = ReturnType<typeof createAuthzRepository>;
