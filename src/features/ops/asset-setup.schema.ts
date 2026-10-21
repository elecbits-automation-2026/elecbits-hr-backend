import { z } from '../../shared/zod.js';
import { assetCategoryRefSchema } from './assets.schema.js';

export const kitSchema = z
  .object({
    designation: z.string(),
    items: z.array(
      z.object({
        categoryId: z.string().uuid(),
        categoryName: z.string(),
        qty: z.number().int(),
      }),
    ),
  })
  .openapi('AssetKit');

/** OPS setup: categories (kind + gate-pass flag) and joiner kits by designation. */
export const assetSetupSchema = z
  .object({
    categories: z.array(assetCategoryRefSchema.extend({ assetCount: z.number().int() })),
    kits: z.array(kitSchema),
    // Designations in use on employee records — the kit picker.
    designations: z.array(z.string()),
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

export const putKitSchema = z
  .object({
    designation: z.string().trim().min(1).max(80),
    // Empty list = no kit for this designation.
    items: z
      .array(
        z.object({ categoryId: z.string().uuid(), qty: z.number().int().min(1).max(20) }),
      )
      .max(30),
  })
  .strict()
  .openapi('PutAssetKit');

export type AssetSetupDto = z.infer<typeof assetSetupSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type PutKitInput = z.infer<typeof putKitSchema>;
