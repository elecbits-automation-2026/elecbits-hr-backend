import { eq } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { assetCategories } from '../../db/schema/index.js';
import { auditIn, type ActorContext } from './ops.repository.js';

/** DB access for OPS setup: categories. */
export const createAssetSetupRepository = (db: DbClient) => ({
  categoriesWithCounts: () =>
    db.query<{
      id: string;
      name: string;
      code_prefix: string;
      kind: 'equipment' | 'lab';
      requires_gate_pass: boolean;
      asset_count: number;
    }>(
      `SELECT c.id, c.name, c.code_prefix, c.kind, c.requires_gate_pass,
              (SELECT count(*)::int FROM ops.assets a WHERE a.category_id = c.id) AS asset_count
         FROM ops.asset_categories c ORDER BY c.name`,
    ),

  /** Name or prefix already used (case-insensitive), ignoring one category. */
  clash: async (
    name: string | undefined,
    prefix: string | undefined,
    exceptId?: string,
  ) =>
    (
      await db.query<{ id: string }>(
        `SELECT id FROM ops.asset_categories
          WHERE (lower(name) = lower($1) OR lower(code_prefix) = lower($2))
            AND ($3::uuid IS NULL OR id <> $3::uuid)`,
        [name ?? '', prefix ?? '', exceptId ?? null],
      )
    ).length > 0,

  insertCategory: (values: typeof assetCategories.$inferInsert, actor: ActorContext) =>
    db.transaction(async (tx) => {
      const rows = await tx.orm.insert(assetCategories).values(values).returning();
      await auditIn(tx, actor, 'ops.category_created', `asset_categories:${rows[0]!.id}`);
      return rows[0]!;
    }),

  updateCategory: (
    id: string,
    patch: Partial<typeof assetCategories.$inferInsert>,
    actor: ActorContext,
  ) =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(assetCategories)
        .set(patch)
        .where(eq(assetCategories.id, id))
        .returning();
      if (rows[0]) {
        await auditIn(tx, actor, 'ops.category_updated', `asset_categories:${id}`, {
          fields: Object.keys(patch),
        });
      }
      return rows[0];
    }),
});

export type AssetSetupRepository = ReturnType<typeof createAssetSetupRepository>;
