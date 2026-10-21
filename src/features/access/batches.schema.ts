import { ACTIONS, SCOPES } from '../../shared/constants/constants.js';
import { z } from '../../shared/zod.js';

/** A single `(module, action, scope)` grant row inside a batch (§3.1). */
export const grantSchema = z
  .object({
    moduleKey: z.string(),
    action: z.enum(ACTIONS),
    scope: z.enum(SCOPES),
  })
  .openapi('Grant');

/** A batch: a named, reusable bundle of grants (§3.2). */
export const batchSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    grants: z.array(grantSchema),
    createdAt: z.string().datetime(),
  })
  .openapi('Batch');

/**
 * Creating/editing a batch takes the full grant list; the service diffs and
 * rewrites batch_grants rows. Edits apply LIVE to every holder and are
 * audit-logged (§3.2, decision #11).
 */
export const upsertBatchSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    grants: z.array(grantSchema),
  })
  .strict()
  .openapi('UpsertBatch');

/** A seeded access module — what the batch composer offers to grant on (§3.1). */
export const moduleSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    parentKey: z.string().nullable(),
  })
  .openapi('Module');

/** Attach a batch to an employee (must be within the caller's assignable list, §3.3). */
export const assignBatchSchema = z
  .object({ employeeId: z.string().uuid() })
  .strict()
  .openapi('AssignBatch');

/** An employee currently holding a batch, with grant provenance (§10). */
export const batchHolderSchema = z
  .object({
    employeeId: z.string().uuid(),
    name: z.string(),
    employeeCode: z.string(),
    email: z.string(),
    grantedBy: z.string().uuid().nullable(),
    grantedAt: z.string().datetime(),
  })
  .openapi('BatchHolder');

export type GrantInput = z.infer<typeof grantSchema>;
export type ModuleDto = z.infer<typeof moduleSchema>;
export type UpsertBatchInput = z.infer<typeof upsertBatchSchema>;
export type AssignBatchInput = z.infer<typeof assignBatchSchema>;
export type BatchDto = z.infer<typeof batchSchema>;
export type BatchHolderDto = z.infer<typeof batchHolderSchema>;
