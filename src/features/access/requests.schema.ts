import { ACTIONS, SCOPES } from '../../shared/constants/constants.js';
import { z } from '../../shared/zod.js';

/**
 * Grant requests (§5.5): HR asks for extra access for ONE person; the Owner
 * (or a SuperAdmin) approves as asked, approves NARROWER, or declines with a
 * recorded reason. Nobody decides a request that involves them.
 */

/** One requested/granted unit: a whole batch, or a single grant tuple. */
export const requestItemSchema = z
  .object({
    kind: z.enum(['batch', 'grant']),
    batchId: z.string().uuid().optional(),
    moduleKey: z.string().optional(),
    action: z.enum(ACTIONS).optional(),
    scope: z.enum(SCOPES).optional(),
  })
  .refine(
    (i) =>
      i.kind === 'batch'
        ? Boolean(i.batchId)
        : Boolean(i.moduleKey && i.action && i.scope),
    {
      message:
        'A batch item needs batchId; a grant item needs moduleKey, action and scope',
    },
  )
  .openapi('GrantRequestItem');

const personRef = z.object({ id: z.string().uuid(), name: z.string() });

/** A request as listed: who, by whom, what was asked and what was granted. */
export const grantRequestSchema = z
  .object({
    id: z.string().uuid(),
    employee: personRef,
    requestedBy: personRef,
    note: z.string().nullable(),
    status: z.enum(['pending', 'approved', 'approved_narrower', 'declined', 'cancelled']),
    /** What was asked. Batch items carry the batch's name for display. */
    requested: z.array(
      requestItemSchema.and(z.object({ batchName: z.string().nullable() })),
    ),
    /** What was given (empty until approved). */
    granted: z.array(
      requestItemSchema.and(z.object({ batchName: z.string().nullable() })),
    ),
    decidedBy: personRef.nullable(),
    decisionReason: z.string().nullable(),
    decidedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('GrantRequest');

export const createGrantRequestSchema = z
  .object({
    employeeId: z.string().uuid(),
    // "What the person's role is, and what access is proposed" (§5.5).
    note: z.string().trim().min(10).max(1000),
    items: z.array(requestItemSchema).min(1).max(20),
  })
  .strict()
  .openapi('CreateGrantRequest');

/** The decision — `grantedItems` may be narrower than what was asked (a subset). */
export const decideGrantRequestSchema = z
  .object({
    decision: z.enum(['approve', 'decline']),
    reason: z.string().trim().max(500).optional(),
    grantedItems: z.array(requestItemSchema).min(1).optional(),
  })
  .strict()
  .refine((v) => v.decision !== 'decline' || (v.reason?.length ?? 0) >= 3, {
    message: 'Declining needs a reason the requester will see',
    path: ['reason'],
  })
  .openapi('DecideGrantRequest');

export type RequestItem = z.infer<typeof requestItemSchema>;
export type CreateGrantRequestInput = z.infer<typeof createGrantRequestSchema>;
export type DecideGrantRequestInput = z.infer<typeof decideGrantRequestSchema>;
export type GrantRequestDto = z.infer<typeof grantRequestSchema>;
