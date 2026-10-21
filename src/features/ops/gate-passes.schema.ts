import { z } from '../../shared/zod.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const ref = z.object({ id: z.string().uuid(), name: z.string() });

/** What the requester accepts (shown on the form; the tick is stored with its time). */
export const GATE_PASS_DISCLAIMER =
  'I take responsibility for this item while it is outside its zone. Any damage or loss until it is back is my responsibility, and I will bring it back by the return date.';

/**
 * Gate passes: taking a flagged-category item out of its zone (lab
 * equipment, products, samples — never laptops). The requester becomes
 * answerable for it; OPS alone approves and approval lets it leave; the RM is
 * told (FYI). After the return date the holder answers "back" or "still out
 * — why, and a new date". Overdue is derived, never stored.
 */
export const gatePassSchema = z
  .object({
    id: z.string().uuid(),
    asset: z.object({
      id: z.string().uuid(),
      assetCode: z.string(),
      name: z.string(),
      zone: ref,
    }),
    holder: ref,
    purpose: z.string(),
    destination: z.string(),
    returnOn: isoDate,
    originalReturnOn: isoDate,
    disclaimerAcceptedAt: z.string().datetime(),
    status: z.enum(['requested', 'approved', 'declined', 'returned']),
    overdue: z.boolean(),
    decidedBy: ref.nullable(),
    decidedAt: z.string().datetime().nullable(),
    declineReason: z.string().nullable(),
    returnedAt: z.string().datetime().nullable(),
    returnedConfirmedBy: ref.nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('GatePass');

export const createGatePassSchema = z
  .object({
    assetId: z.string().uuid(),
    purpose: z.string().trim().min(3).max(300),
    destination: z.string().trim().min(2).max(200),
    returnOn: isoDate,
    disclaimerAccepted: z.literal(true, {
      message: 'Accept the responsibility note to request a pass',
    }),
  })
  .strict()
  .openapi('CreateGatePass');

export const declineGatePassSchema = z
  .object({ reason: z.string().trim().min(2).max(500) })
  .strict()
  .openapi('DeclineGatePass');

/** "Still out": why, and the new return date. */
export const extendReturnSchema = z
  .object({
    returnOn: isoDate,
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .openapi('ExtendReturn');

export type CreateGatePassInput = z.infer<typeof createGatePassSchema>;
export type DeclineGatePassInput = z.infer<typeof declineGatePassSchema>;
export type ExtendReturnInput = z.infer<typeof extendReturnSchema>;
export type GatePassDto = z.infer<typeof gatePassSchema>;
