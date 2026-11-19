import type { DbClient } from '../../db/client.js';
import { auditLog } from '../../db/schema/index.js';

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

  logMessage: async (userId: string, employeeId: string, tools: string[]): Promise<void> => {
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
