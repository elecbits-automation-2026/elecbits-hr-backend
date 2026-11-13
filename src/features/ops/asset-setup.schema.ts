import { z } from '../../shared/zod.js';
import { assetCategoryRefSchema } from './assets.schema.js';

/**
 * OPS setup: categories (kind + gate-pass flag). There are no joiner kits by
 * designation any more — OPS decides each joiner's assets (2026-11-05).
 */
export const assetSetupSchema = z
  .object({
    categories: z.array(assetCategoryRefSchema.extend({ assetCount: z.number().int() })),
  })
  .openapi('AssetSetup');

export const createCategorySchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    // Letters/digits only, used in generated tags: EB-<prefix>-0001.
    codePrefix: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{2,6}$/, '2–6 letters or digits'),
    kind: z.enum(['equipment', 'lab']),
    requiresGatePass: z.boolean(),
  })
  .strict()
  .openapi('CreateAssetCategory');

export const updateCategorySchema = createCategorySchema
  .partial()
  .strict()
  .openapi('UpdateAssetCategory');

export type AssetSetupDto = z.infer<typeof assetSetupSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
