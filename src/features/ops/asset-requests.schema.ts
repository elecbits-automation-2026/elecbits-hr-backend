import { z } from '../../shared/zod.js';
import { ASSET_CONDITIONS } from './assets.schema.js';

const ref = z.object({ id: z.string().uuid(), name: z.string() });
const assetRef = z.object({
  id: z.string().uuid(),
  assetCode: z.string(),
  name: z.string(),
});
export const REQUEST_TYPES = [
  'new',
  'upgrade',
  'replacement',
  'repair',
  'return',
] as const;

/**
 * Employee asset requests: new / upgrade / replacement / repair / return.
 * Routed to the shared OPS queue, not a named person (decision #24). An
 * upgrade or replacement is fulfilled by issuing the new item and taking the
 * old one back in one step (user decision).
 */
export const assetRequestSchema = z
  .object({
    id: z.string().uuid(),
    requestedBy: ref,
    type: z.enum(REQUEST_TYPES),
    asset: assetRef.nullable(),
    category: ref.nullable(),
    note: z.string().nullable(),
    status: z.enum(['open', 'in_progress', 'fulfilled', 'declined']),
    handledBy: ref.nullable(),
    handlerNote: z.string().nullable(),
    fulfilledAsset: assetRef.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('AssetRequest');

export const createAssetRequestSchema = z
  .object({
    type: z.enum(REQUEST_TYPES),
    // The item it is about — required for all but `new`; must be yours.
    assetId: z.string().uuid().optional(),
    // What you'd like (new / upgrade / replacement).
    categoryId: z.string().uuid().optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .openapi('CreateAssetRequest');

/** OPS picks it up or declines it (fulfil has its own route). */
export const updateAssetRequestSchema = z
  .object({
    status: z.enum(['in_progress', 'declined']),
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .openapi('UpdateAssetRequest');

export const fulfilAssetRequestSchema = z
  .object({
    // new / upgrade / replacement: the idle or shared asset to hand over.
    issueAssetId: z.string().uuid().optional(),
    zoneId: z.string().uuid().optional(),
    dueOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    // upgrade / replacement / return: the old item's condition when it comes back.
    returnCondition: z.enum(ASSET_CONDITIONS).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .openapi('FulfilAssetRequest');

export type CreateAssetRequestInput = z.infer<typeof createAssetRequestSchema>;
export type UpdateAssetRequestInput = z.infer<typeof updateAssetRequestSchema>;
export type FulfilAssetRequestInput = z.infer<typeof fulfilAssetRequestSchema>;
export type AssetRequestDto = z.infer<typeof assetRequestSchema>;
