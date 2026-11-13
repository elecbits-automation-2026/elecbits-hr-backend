import { z } from '../../shared/zod.js';

/** An immutable audit-log entry (§10). Read-only over the API — no writes. */
export const auditEntrySchema = z
  .object({
    id: z.string().uuid(),
    actorUserId: z.string().uuid().nullable(),
    /** The actor's employee name, else the account email; null for system jobs. */
    actorName: z.string().nullable(),
    action: z.string(),
    subject: z.string(),
    detail: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('AuditEntry');

/** GET /audit-log query: free-text search + which page (newest first). */
export const auditQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
});

/** One page of entries and how many match in total. */
export const auditPageSchema = z
  .object({
    entries: z.array(auditEntrySchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .openapi('AuditPage');

export type AuditEntryDto = z.infer<typeof auditEntrySchema>;
export type AuditPageDto = z.infer<typeof auditPageSchema>;
