import { z } from '../../shared/zod.js';

const ref = z.object({ id: z.string().uuid(), name: z.string() });

export const stockItemSchema = z
  .object({
    id: z.string().uuid(),
    sku: z.string(),
    name: z.string(),
    category: z.string().nullable(),
    unit: z.string(),
    active: z.boolean(),
    total: z.number().int(),
  })
  .openapi('StockItem');

/** Items × zones: the quantities OPS keeps per zone. */
export const stockOverviewSchema = z
  .object({
    items: z.array(stockItemSchema),
    zones: z.array(ref),
    levels: z.array(
      z.object({
        itemId: z.string().uuid(),
        zoneId: z.string().uuid(),
        qty: z.number().int(),
      }),
    ),
  })
  .openapi('StockOverview');

export const stockMovementSchema = z
  .object({
    id: z.string().uuid(),
    item: z.object({
      id: z.string().uuid(),
      sku: z.string(),
      name: z.string(),
      unit: z.string(),
    }),
    zone: ref,
    kind: z.enum(['in', 'issue', 'transfer_out', 'transfer_in', 'adjust']),
    qty: z.number().int(),
    employee: ref.nullable(),
    note: z.string().nullable(),
    by: ref,
    createdAt: z.string().datetime(),
  })
  .openapi('StockMovement');

export const createStockItemSchema = z
  .object({
    sku: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(120),
    category: z.string().trim().max(60).optional(),
    unit: z.string().trim().min(1).max(12).optional(),
  })
  .strict()
  .openapi('CreateStockItem');

export const updateStockItemSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    category: z.string().trim().max(60).nullable(),
    unit: z.string().trim().min(1).max(12),
    active: z.boolean(),
  })
  .partial()
  .strict()
  .openapi('UpdateStockItem');

/**
 * One stock move. in / issue / transfer take a positive quantity; adjust
 * (a recount) takes a signed one and needs a reason. issue needs the person;
 * transfer needs the zone it goes to.
 */
export const stockMoveSchema = z
  .object({
    kind: z.enum(['in', 'issue', 'transfer', 'adjust']),
    itemId: z.string().uuid(),
    zoneId: z.string().uuid(),
    qty: z.number().int().min(-1_000_000).max(1_000_000),
    toZoneId: z.string().uuid().optional(),
    employeeId: z.string().uuid().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .openapi('StockMove');

export type StockItemDto = z.infer<typeof stockItemSchema>;
export type StockOverviewDto = z.infer<typeof stockOverviewSchema>;
export type StockMovementDto = z.infer<typeof stockMovementSchema>;
export type CreateStockItemInput = z.infer<typeof createStockItemSchema>;
export type UpdateStockItemInput = z.infer<typeof updateStockItemSchema>;
export type StockMoveInput = z.infer<typeof stockMoveSchema>;
