import { z } from '../../shared/zod.js';

/** An immutable audit-log entry (§10). Read-only over the API — no writes. */
export const auditEntrySchema = z
  .object({
    id: z.string().uuid(),
    actorUserId: z.string().uuid().nullable(),
    action: z.string(),
    subject: z.string(),
    detail: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('AuditEntry');

export type AuditEntryDto = z.infer<typeof auditEntrySchema>;
