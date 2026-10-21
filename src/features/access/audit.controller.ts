import type { Request, Response } from 'express';
import { createAuditRepository } from './audit.repository.js';
import type { AuditEntryDto } from './audit.schema.js';

/**
 * Thin read-only surface; the mapping is small enough that a separate service
 * would only be ceremony — the audit log has no business rules to enforce on
 * read (immutability is enforced at the data layer).
 */
export const auditController = {
  list: async (req: Request, res: Response): Promise<void> => {
    const rows = await createAuditRepository(req.db).listRecent();
    const entries: AuditEntryDto[] = rows.map((row) => ({
      id: row.id,
      actorUserId: row.actorUserId,
      action: row.action,
      subject: row.subject,
      detail: row.detail,
      createdAt: row.createdAt.toISOString(),
    }));
    res.json(entries);
  },
};
