import { z } from '../../shared/zod.js';
import { assetRequestSchema } from './asset-requests.schema.js';
import { assetCategoryRefSchema, assetSchema } from './assets.schema.js';
import { gatePassSchema } from './gate-passes.schema.js';
import { stockMovementSchema } from './stock.schema.js';

/**
 * The employee's own view: what they hold (loans with due dates), the passes
 * they are answerable for, their requests, stock issued to them, and what
 * they may take out on a gate pass. `me` scope — no OPS grant needed.
 */
export const myAssetsSchema = z
  .object({
    held: z.array(assetSchema),
    passes: z.array(gatePassSchema),
    requests: z.array(assetRequestSchema),
    stock: z.array(stockMovementSchema),
    categories: z.array(assetCategoryRefSchema),
    // Items in gate-pass categories they hold, or zone items nobody holds.
    passable: z.array(
      z.object({
        id: z.string().uuid(),
        assetCode: z.string(),
        name: z.string(),
        category: z.string(),
        zone: z.string(),
        mine: z.boolean(),
      }),
    ),
    disclaimer: z.string(),
  })
  .openapi('MyAssets');

export type MyAssetsDto = z.infer<typeof myAssetsSchema>;
