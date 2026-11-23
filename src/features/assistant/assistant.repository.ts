import type { DbClient } from '../../db/client.js';
import { auditLog } from '../../db/schema/index.js';

/** A current person as the action tools see them: name + how they relate to the caller. */
export interface ActionablePerson {
  id: string;
  name: string;
  department: string | null;
  status: string;
  /** The caller is their effective RM (leave approver, else reports-to) — goals and R&R. */
  effectiveRm: boolean;
  /** The caller is their RM or leave approver — the trainings "team". */
  team: boolean;
  /** The Admin account (takes no trainings). */
  isOwner: boolean;
}

/**
 * DB access for the HR Assistant. Chats are never stored (user decision,
 * 2026-11-19); the audit log holds one row per message (the daily cap counts
 * these) and one per tool call — tool name + input only, never the question
 * or the results.
 */
export const createAssistantRepository = (db: DbClient) => ({
  /** True when anyone routes to this person as RM or leave approver (same rule as /me). */
  hasReports: async (employeeId: string): Promise<boolean> => {
    const rows = await db.query<{ found: number }>(
      `SELECT 1 AS found FROM org.employees
        WHERE (reports_to = $1 OR leave_approver = $1) AND status <> 'inactive'
        LIMIT 1`,
      [employeeId],
    );
    return rows.length > 0;
  },

  /** Holds a current department-head seat (the hiring plan's author). */
  isDeptHead: async (employeeId: string): Promise<boolean> => {
    const rows = await db.query<{ found: number }>(
      `SELECT 1 AS found FROM org.seats
        WHERE seat = 'dept_head' AND ended_at IS NULL AND employee_id = $1
        LIMIT 1`,
      [employeeId],
    );
    return rows.length > 0;
  },

  /**
   * Every non-inactive person but the caller, with how they relate to the
   * caller — the pool the action tools resolve typed names against. Access is
   * NOT decided here: the tools filter by relationship + HR reach, and the
   * real endpoint checks again on confirm.
   */
  actionablePeople: async (employeeId: string): Promise<ActionablePerson[]> => {
    const rows = await db.query<{
      id: string;
      name: string;
      department: string | null;
      status: string;
      effective_rm: boolean;
      team: boolean;
      is_owner: boolean;
    }>(
      `SELECT e.id, e.name, d.name AS department, e.status::text AS status,
              COALESCE(e.leave_approver, e.reports_to) IS NOT DISTINCT FROM $1::uuid AS effective_rm,
              (e.reports_to = $1 OR e.leave_approver = $1) IS TRUE AS team,
              EXISTS (SELECT 1 FROM access.org_owner o WHERE o.employee_id = e.id) AS is_owner
         FROM org.employees e
         LEFT JOIN org.departments d ON d.id = e.department_id
        WHERE e.status <> 'inactive' AND e.id <> $1
        ORDER BY e.name`,
      [employeeId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      department: r.department,
      status: r.status,
      effectiveRm: r.effective_rm,
      team: r.team,
      isOwner: r.is_owner,
    }));
  },

  employeeName: async (employeeId: string): Promise<string | null> => {
    const rows = await db.query<{ name: string }>(
      'SELECT name FROM org.employees WHERE id = $1',
      [employeeId],
    );
    return rows[0]?.name ?? null;
  },

  /** Messages this user has sent since `since` — the daily cap. */
  messagesSince: async (userId: string, since: Date): Promise<number> => {
    const rows = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM access.audit_log
        WHERE action = 'assistant.message' AND actor_user_id = $1 AND created_at >= $2`,
      [userId, since],
    );
    return Number(rows[0]?.n ?? 0);
  },

  logMessage: async (
    userId: string,
    employeeId: string,
    tools: string[],
  ): Promise<void> => {
    await db.orm.insert(auditLog).values({
      actorUserId: userId,
      action: 'assistant.message',
      subject: `employees:${employeeId}`,
      detail: JSON.stringify({ tools }),
    });
  },

  logToolCall: async (
    userId: string,
    employeeId: string,
    tool: string,
    input: unknown,
  ): Promise<void> => {
    await db.orm.insert(auditLog).values({
      actorUserId: userId,
      action: 'assistant.tool',
      subject: `employees:${employeeId}`,
      detail: JSON.stringify({ tool, input }),
    });
  },
});

export type AssistantRepository = ReturnType<typeof createAssistantRepository>;
