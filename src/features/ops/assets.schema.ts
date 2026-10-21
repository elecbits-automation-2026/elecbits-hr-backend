import { z } from '../../shared/zod.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const ref = z.object({ id: z.string().uuid(), name: z.string() });

export const ASSET_STATUSES = [
  'assigned',
  'idle',
  'in_use_shared',
  'needs_repair',
  'scrapped',
  'gifted',
  'lost',
] as const;
export const ASSET_CONDITIONS = ['new', 'good', 'fair', 'damaged'] as const;
/** Final statuses: the asset has left the register (kept, never deleted). */
export const DISPOSED_STATUSES = ['scrapped', 'gifted', 'lost'] as const;

export const assetCategoryRefSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    codePrefix: z.string(),
    kind: z.enum(['equipment', 'lab']),
    requiresGatePass: z.boolean(),
  })
  .openapi('AssetCategory');

/** The live gate pass on an asset, if any — "off premises" is this, not a status. */
export const openPassSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['requested', 'approved']),
  holder: ref,
  returnOn: isoDate,
  overdue: z.boolean(),
});

/** One register entry: always a zone, plus a holder when `assigned`. */
export const assetSchema = z
  .object({
    id: z.string().uuid(),
    assetCode: z.string(),
    name: z.string(),
    category: assetCategoryRefSchema,
    status: z.enum(ASSET_STATUSES),
    zone: ref,
    holder: ref.nullable(),
    loanDueOn: isoDate.nullable(),
    loanOverdue: z.boolean(),
    make: z.string().nullable(),
    model: z.string().nullable(),
    serialNo: z.string().nullable(),
    purchasedOn: isoDate.nullable(),
    purchaseCost: z.number().nullable(),
    vendor: z.string().nullable(),
    warrantyUntil: isoDate.nullable(),
    condition: z.enum(ASSET_CONDITIONS),
    notes: z.string().nullable(),
    giftedTo: ref.nullable(),
    disposedOn: isoDate.nullable(),
    disposeReason: z.string().nullable(),
    openPass: openPassSchema.nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('Asset');

export const assetEventSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.string(),
    employee: ref.nullable(),
    zone: ref.nullable(),
    status: z.enum(ASSET_STATUSES).nullable(),
    condition: z.enum(ASSET_CONDITIONS).nullable(),
    dueOn: isoDate.nullable(),
    prevDueOn: isoDate.nullable(),
    note: z.string().nullable(),
    by: ref.nullable(),
    at: z.string().datetime(),
  })
  .openapi('AssetEvent');

export const assetIncidentSchema = z
  .object({
    id: z.string().uuid(),
    asset: z.object({ id: z.string().uuid(), assetCode: z.string(), name: z.string() }),
    employee: ref.nullable(),
    kind: z.enum(['damage', 'loss', 'theft']),
    description: z.string(),
    reportedBy: ref,
    status: z.enum(['open', 'closed']),
    outcome: z.string().nullable(),
    closedBy: ref.nullable(),
    closedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('AssetIncident');

export const assetPassSummarySchema = z.object({
  id: z.string().uuid(),
  holder: ref,
  purpose: z.string(),
  destination: z.string(),
  status: z.enum(['requested', 'approved', 'declined', 'returned']),
  returnOn: isoDate,
  createdAt: z.string().datetime(),
});

export const assetDetailSchema = assetSchema
  .extend({
    events: z.array(assetEventSchema),
    incidents: z.array(assetIncidentSchema),
    passes: z.array(assetPassSummarySchema),
  })
  .openapi('AssetDetail');

/** What the register's forms need: categories, zones, designations, people. */
export const assetOptionsSchema = z
  .object({
    categories: z.array(assetCategoryRefSchema),
    zones: z.array(ref),
    people: z.array(
      ref.extend({
        designation: z.string().nullable(),
        baseZoneId: z.string().nullable(),
      }),
    ),
  })
  .openapi('AssetOptions');

// ── Inputs ──────────────────────────────────────────────────────────────

const details = {
  name: z.string().trim().min(1).max(120),
  categoryId: z.string().uuid(),
  make: z.string().trim().max(80).nullish(),
  model: z.string().trim().max(80).nullish(),
  serialNo: z.string().trim().max(80).nullish(),
  purchasedOn: isoDate.nullish(),
  purchaseCost: z.number().min(0).max(100_000_000).nullish(),
  vendor: z.string().trim().max(120).nullish(),
  warrantyUntil: isoDate.nullish(),
  condition: z.enum(ASSET_CONDITIONS).optional(),
  notes: z.string().trim().max(1000).nullish(),
};

/**
 * Register an asset. A blank code is generated from the category prefix
 * (EB-LAP-0042). Giving a holder issues it straight away — how an existing
 * allocation is brought in.
 */
export const createAssetSchema = z
  .object({
    assetCode: z.string().trim().max(40).optional(),
    ...details,
    zoneId: z.string().uuid(),
    status: z.enum(['idle', 'in_use_shared', 'needs_repair']).optional(),
    holderId: z.string().uuid().optional(),
    loanDueOn: isoDate.optional(),
  })
  .strict()
  .openapi('CreateAsset');

export const updateAssetSchema = z
  .object({
    assetCode: z.string().trim().min(1).max(40).optional(),
    ...details,
  })
  .partial()
  .strict()
  .openapi('UpdateAsset');

/** CSV import: names instead of ids, resolved and checked row by row. */
export const importAssetRowSchema = z.object({
  assetCode: z.string().optional(),
  name: z.string().optional(),
  category: z.string().optional(),
  zone: z.string().optional(),
  status: z.string().optional(),
  holderEmail: z.string().optional(),
  loanDueOn: z.string().optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  serialNo: z.string().optional(),
  purchasedOn: z.string().optional(),
  purchaseCost: z.string().optional(),
  vendor: z.string().optional(),
  warrantyUntil: z.string().optional(),
  condition: z.string().optional(),
  notes: z.string().optional(),
});

export const importAssetsSchema = z
  .object({
    rows: z.array(importAssetRowSchema).min(1).max(1000),
    // true = check only, nothing saved (the edit screen's "Check").
    dryRun: z.boolean().optional(),
  })
  .strict()
  .openapi('ImportAssets');

export const importResultSchema = z
  .object({
    ok: z.boolean(),
    created: z.number().int(),
    errors: z.array(z.object({ row: z.number().int(), message: z.string() })),
  })
  .openapi('ImportAssetsResult');

export const issueAssetSchema = z
  .object({
    employeeId: z.string().uuid(),
    // Defaults to the person's base zone, else where the asset is now.
    zoneId: z.string().uuid().optional(),
    // Required for lab categories (a loan), ignored otherwise.
    dueOn: isoDate.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .openapi('IssueAsset');

export const returnAssetSchema = z
  .object({
    condition: z.enum(ASSET_CONDITIONS),
    // Where it goes after: the pool (idle), shared use, or repair.
    toStatus: z.enum(['idle', 'in_use_shared', 'needs_repair']).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .openapi('ReturnAsset');

export const transferAssetSchema = z
  .object({
    employeeId: z.string().uuid(),
    zoneId: z.string().uuid().optional(),
    dueOn: isoDate.optional(),
    condition: z.enum(ASSET_CONDITIONS).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .openapi('TransferAsset');

export const moveAssetSchema = z
  .object({
    zoneId: z.string().uuid(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .openapi('MoveAsset');

/** Statuses OPS sets by hand. `assigned` comes from issue; `lost` from an incident. */
export const setAssetStatusSchema = z
  .object({
    status: z.enum(['idle', 'in_use_shared', 'needs_repair', 'scrapped', 'gifted']),
    // Gifted to whom (defaults to the current holder).
    giftedTo: z.string().uuid().optional(),
    // Required for scrapped / gifted: why it left the register.
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .openapi('SetAssetStatus');

export const reportIncidentSchema = z
  .object({
    kind: z.enum(['damage', 'loss', 'theft']),
    description: z.string().trim().min(5).max(2000),
  })
  .strict()
  .openapi('ReportAssetIncident');

export const closeIncidentSchema = z
  .object({
    outcome: z.string().trim().min(2).max(2000),
    // Loss / theft only: confirm the asset is gone (status `lost`).
    assetLost: z.boolean().optional(),
  })
  .strict()
  .openapi('CloseAssetIncident');

export const kitCheckSchema = z
  .object({
    designation: z.string().nullable(),
    items: z.array(
      z.object({
        categoryId: z.string().uuid(),
        categoryName: z.string(),
        qty: z.number().int(),
        held: z.number().int(),
      }),
    ),
  })
  .openapi('KitCheck');

export type AssetCategoryRefDto = z.infer<typeof assetCategoryRefSchema>;
export type AssetDto = z.infer<typeof assetSchema>;
export type AssetDetailDto = z.infer<typeof assetDetailSchema>;
export type AssetEventDto = z.infer<typeof assetEventSchema>;
export type AssetIncidentDto = z.infer<typeof assetIncidentSchema>;
export type AssetOptionsDto = z.infer<typeof assetOptionsSchema>;
export type KitCheckDto = z.infer<typeof kitCheckSchema>;
export type CreateAssetInput = z.infer<typeof createAssetSchema>;
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;
export type ImportAssetsInput = z.infer<typeof importAssetsSchema>;
export type ImportAssetRow = z.infer<typeof importAssetRowSchema>;
export type ImportResultDto = z.infer<typeof importResultSchema>;
export type IssueAssetInput = z.infer<typeof issueAssetSchema>;
export type ReturnAssetInput = z.infer<typeof returnAssetSchema>;
export type TransferAssetInput = z.infer<typeof transferAssetSchema>;
export type MoveAssetInput = z.infer<typeof moveAssetSchema>;
export type SetAssetStatusInput = z.infer<typeof setAssetStatusSchema>;
export type ReportIncidentInput = z.infer<typeof reportIncidentSchema>;
export type CloseIncidentInput = z.infer<typeof closeIncidentSchema>;
