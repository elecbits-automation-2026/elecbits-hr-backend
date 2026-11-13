import type { Request, Response } from 'express';
import createError from 'http-errors';
import { createAuditRepository } from './audit.repository.js';
import { auditQuerySchema, type AuditPageDto } from './audit.schema.js';

/**
 * Thin read-only surface; the mapping is small enough that a separate service
 * would only be ceremony — the audit log has no business rules to enforce on
 * read (immutability is enforced at the data layer).
 */
export const auditController = {
  list: async (req: Request, res: Response): Promise<void> => {
    const query = auditQuerySchema.safeParse(req.query);
    if (!query.success) throw createError(400, 'Invalid audit-log query', { code: 'BAD_QUERY' });
    const { q, page, pageSize } = query.data;
    const { rows, total } = await createAuditRepository(req.db).listPage({
      search: q || undefined,
      page,
      pageSize,
    });
    const out: AuditPageDto = {
      entries: rows.map((row) => ({
        id: row.id,
        actorUserId: row.actor_user_id,
        actorName: row.actor_name,
        action: row.action,
        subject: row.subject,
        detail: row.detail,
        createdAt: new Date(row.created_at).toISOString(),
      })),
      total,
      page,
      pageSize,
    };
    res.json(out);
  },
};
