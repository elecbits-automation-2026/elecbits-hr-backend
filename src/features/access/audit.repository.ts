import { desc } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { auditLog } from '../../db/schema/index.js';

export type AuditRow = typeof auditLog.$inferSelect;

/**
 * Read side of the audit log. The WRITE side deliberately has no repository of
 * its own: entries are appended inside the same transaction as the mutation
 * they record (§10), by whichever feature performs the mutation.
 */
export const createAuditRepository = (db: DbClient) => ({
  listRecent: async (limit = 100): Promise<AuditRow[]> =>
    db.orm.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(limit),
});

export type AuditRepository = ReturnType<typeof createAuditRepository>;
