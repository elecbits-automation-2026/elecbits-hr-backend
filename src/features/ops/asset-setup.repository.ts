import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { assetCategories, assetKits } from '../../db/schema/index.js';
import { auditIn, type ActorContext } from './ops.repository.js';

/** DB access for OPS setup: categories and joiner kits. */
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

  kits: () =>
    db.query<{
      designation: string;
      category_id: string;
      category_name: string;
      qty: number;
    }>(
      `SELECT k.designation, k.category_id, c.name AS category_name, k.qty
         FROM ops.asset_kits k JOIN ops.asset_categories c ON c.id = k.category_id
        ORDER BY lower(k.designation), c.name`,
    ),

  designations: async (): Promise<string[]> =>
    (
      await db.query<{ designation: string }>(
        `SELECT DISTINCT designation FROM org.employees
          WHERE designation IS NOT NULL AND btrim(designation) <> '' ORDER BY designation`,
      )
    ).map((r) => r.designation),

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

  /** Replace one designation's kit. */
  replaceKit: (
    designation: string,
    items: Array<{ categoryId: string; qty: number }>,
    actor: ActorContext,
  ) =>
    db.transaction(async (tx) => {
      await tx.orm
        .delete(assetKits)
        .where(sql`lower(${assetKits.designation}) = lower(${designation})`);
      if (items.length) {
        await tx.orm
          .insert(assetKits)
          .values(
            items.map((i) => ({ designation, categoryId: i.categoryId, qty: i.qty })),
          );
      }
      await auditIn(tx, actor, 'ops.kit_set', `asset_kits:${designation}`, {
        lines: items.length,
      });
    }),
});

export type AssetSetupRepository = ReturnType<typeof createAssetSetupRepository>;
