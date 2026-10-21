import { z } from '../../shared/zod.js';

export const POLICY_CATEGORIES = [
  'conduct',
  'handbook',
  'performance',
  'time',
  'culture',
  'other',
] as const;

/** ok = signed the current version; stale = signed an older one; none = never. */
export const ACK_STATES = ['ok', 'stale', 'none'] as const;

export const createPolicySchema = z
  .object({
    code: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, 'lowercase letters, digits, - and _'),
    title: z.string().trim().min(3).max(200),
    category: z.enum(POLICY_CATEGORIES),
    version: z.string().trim().min(1).max(20),
    ackRequired: z.boolean().default(true),
    summary: z.string().trim().max(2000).optional(),
    docUrl: z.string().url().max(500).optional(),
    effectiveFrom: z.string().date().optional(),
  })
  .strict()
  .openapi('CreatePolicy');

/**
 * Edit a policy. Changing `version` is the deliberate "everyone signs again"
 * act; every other field edits in place without touching acknowledgements.
 */
export const updatePolicySchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    category: z.enum(POLICY_CATEGORIES).optional(),
    version: z.string().trim().min(1).max(20).optional(),
    ackRequired: z.boolean().optional(),
    summary: z.string().trim().max(2000).nullable().optional(),
    docUrl: z.string().url().max(500).nullable().optional(),
    effectiveFrom: z.string().date().nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .openapi('UpdatePolicy');

export const policySchema = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    title: z.string(),
    category: z.enum(POLICY_CATEGORIES),
    version: z.string(),
    ackRequired: z.boolean(),
    summary: z.string().nullable(),
    docUrl: z.string().nullable(),
    /** True when the PDF itself is stored in our DB — served by /:id/document. */
    hasDocument: z.boolean(),
    effectiveFrom: z.string().nullable(),
    /** Set = withdrawn: hidden from the library and tracker, not signable. */
    retiredAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Policy');

/** A policy + the CALLER's acknowledgement state against the current version. */
export const myPolicySchema = policySchema
  .extend({
    ack: z.object({
      state: z.enum(ACK_STATES),
      ackedVersion: z.string().nullable(),
      ackedAt: z.string().datetime().nullable(),
    }),
  })
  .openapi('MyPolicy');

export const ackResultSchema = z
  .object({
    policyId: z.string().uuid(),
    version: z.string(),
    ackedAt: z.string().datetime(),
  })
  .openapi('PolicyAck');

/** HR tracker: people × ack-required policies, one cell per pair. */
export const trackerSchema = z
  .object({
    policies: z.array(policySchema),
    rows: z.array(
      z.object({
        employee: z.object({
          id: z.string().uuid(),
          name: z.string(),
          employeeCode: z.string(),
        }),
        cells: z.array(
          z.object({
            policyId: z.string().uuid(),
            state: z.enum(ACK_STATES),
            ackedVersion: z.string().nullable(),
            ackedAt: z.string().datetime().nullable(),
          }),
        ),
      }),
    ),
  })
  .openapi('PolicyTracker');

export type CreatePolicyInput = z.infer<typeof createPolicySchema>;
export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;
export type PolicyDto = z.infer<typeof policySchema>;
export type MyPolicyDto = z.infer<typeof myPolicySchema>;
export type AckResultDto = z.infer<typeof ackResultSchema>;
export type PolicyTrackerDto = z.infer<typeof trackerSchema>;
export type AckState = (typeof ACK_STATES)[number];
