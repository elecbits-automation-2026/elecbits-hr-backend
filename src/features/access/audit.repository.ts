import type { DbClient } from '../../db/client.js';

/** One entry plus who did it (the actor's employee name, else the account email). */
export interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_name: string | null;
  action: string;
  subject: string;
  detail: string | null;
  created_at: Date;
}

// `search` matches the action, subject, detail text or the actor's name.
const FROM_WHERE = `
         FROM access.audit_log a
         LEFT JOIN users u ON u.id = a.actor_user_id
         LEFT JOIN org.employees e ON e.id = u.employee_id
        WHERE $1::text IS NULL
           OR a.action ILIKE $1 OR a.subject ILIKE $1 OR a.detail ILIKE $1
           OR coalesce(e.name, u.email) ILIKE $1`;

/**
 * Read side of the audit log. The WRITE side deliberately has no repository of
 * its own: entries are appended inside the same transaction as the mutation
 * they record (§10), by whichever feature performs the mutation.
 */
export const createAuditRepository = (db: DbClient) => ({
  /** One page, newest first, plus how many entries match in total. */
  listPage: async (opts: {
    search?: string;
    page: number;
    pageSize: number;
  }): Promise<{ rows: AuditRow[]; total: number }> => {
    const like = opts.search ? `%${opts.search}%` : null;
    const rows = await db.query<AuditRow>(
      `SELECT a.id, a.actor_user_id, coalesce(e.name, u.email) AS actor_name,
              a.action, a.subject, a.detail, a.created_at
       ${FROM_WHERE}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $2 OFFSET $3`,
      [like, opts.pageSize, (opts.page - 1) * opts.pageSize],
    );
    const [count] = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total ${FROM_WHERE}`,
      [like],
    );
    return { rows, total: count?.total ?? 0 };
  },
});

export type AuditRepository = ReturnType<typeof createAuditRepository>;
