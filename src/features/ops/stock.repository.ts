import { eq } from 'drizzle-orm';
import createError from 'http-errors';
import type { DbClient } from '../../db/client.js';
import { stockItems, stockMovements } from '../../db/schema/index.js';
import { auditIn, type ActorContext } from './ops.repository.js';

export type StockItemRow = typeof stockItems.$inferSelect;

/** One ledger line to write; `delta` is signed (+ into the zone, - out). */
export interface StockLine {
  itemId: string;
  zoneId: string;
  delta: number;
  kind: (typeof stockMovements.$inferInsert)['kind'];
  employeeId?: string | null;
  transferId?: string | null;
  note?: string | null;
}

export interface MovementViewRow {
  id: string;
  item_id: string;
  sku: string;
  item_name: string;
  unit: string;
  zone_id: string;
  zone_name: string;
  kind: StockLine['kind'];
  qty: number;
  employee_id: string | null;
  employee_name: string | null;
  note: string | null;
  by_id: string;
  by_name: string;
  created_at: Date;
}

/** DB access for consumable stock: items, per-zone levels, the append-only ledger. */
export const createStockRepository = (db: DbClient) => ({
  items: () =>
    db.query<{
      id: string;
      sku: string;
      name: string;
      category: string | null;
      unit: string;
      active: boolean;
      total: number;
    }>(
      `SELECT i.id, i.sku, i.name, i.category, i.unit, i.active,
              coalesce((SELECT sum(l.qty) FROM ops.stock_levels l WHERE l.item_id = i.id), 0)::int AS total
         FROM ops.stock_items i ORDER BY i.active DESC, i.name`,
    ),

  levels: () =>
    db.query<{ item_id: string; zone_id: string; qty: number }>(
      `SELECT item_id, zone_id, qty FROM ops.stock_levels WHERE qty <> 0`,
    ),

  item: async (id: string): Promise<StockItemRow | undefined> =>
    (await db.orm.select().from(stockItems).where(eq(stockItems.id, id)).limit(1))[0],

  skuTaken: async (sku: string) =>
    (
      await db.query<{ id: string }>(
        `SELECT id FROM ops.stock_items WHERE lower(sku) = lower($1)`,
        [sku],
      )
    ).length > 0,

  insertItem: (values: typeof stockItems.$inferInsert, actor: ActorContext) =>
    db.transaction(async (tx) => {
      const rows = await tx.orm.insert(stockItems).values(values).returning();
      await auditIn(tx, actor, 'ops.stock_item_created', `stock_items:${rows[0]!.id}`);
      return rows[0]!;
    }),

  updateItem: (
    id: string,
    patch: Partial<typeof stockItems.$inferInsert>,
    actor: ActorContext,
  ) =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(stockItems)
        .set(patch)
        .where(eq(stockItems.id, id))
        .returning();
      if (rows[0]) {
        await auditIn(tx, actor, 'ops.stock_item_updated', `stock_items:${id}`, {
          fields: Object.keys(patch),
        });
      }
      return rows[0];
    }),

  /**
   * Write ledger lines and move the levels with them, all or nothing. A line
   * that would take a zone below zero fails the whole move (422).
   */
  move: (lines: StockLine[], actor: ActorContext): Promise<void> =>
    db.transaction(async (tx) => {
      for (const l of lines) {
        if (l.delta > 0) {
          await tx.query(
            `INSERT INTO ops.stock_levels (item_id, zone_id, qty) VALUES ($1, $2, $3)
             ON CONFLICT (item_id, zone_id)
             DO UPDATE SET qty = ops.stock_levels.qty + EXCLUDED.qty, updated_at = now()`,
            [l.itemId, l.zoneId, l.delta],
          );
        } else {
          const rows = await tx.query<{ qty: number }>(
            `UPDATE ops.stock_levels SET qty = qty + $3, updated_at = now()
              WHERE item_id = $1 AND zone_id = $2 AND qty + $3 >= 0
              RETURNING qty`,
            [l.itemId, l.zoneId, l.delta],
          );
          if (!rows[0]) {
            const have = await tx.query<{ qty: number }>(
              `SELECT qty FROM ops.stock_levels WHERE item_id = $1 AND zone_id = $2`,
              [l.itemId, l.zoneId],
            );
            throw createError(
              422,
              `Not enough stock in that zone — ${have[0]?.qty ?? 0} left`,
              { code: 'NOT_ENOUGH_STOCK' },
            );
          }
        }
        const inserted = await tx.orm
          .insert(stockMovements)
          .values({
            itemId: l.itemId,
            zoneId: l.zoneId,
            kind: l.kind,
            qty: l.delta,
            employeeId: l.employeeId ?? null,
            transferId: l.transferId ?? null,
            note: l.note ?? null,
            byEmployeeId: actor.actorEmployeeId,
          })
          .returning();
        await auditIn(
          tx,
          actor,
          `ops.stock_${l.kind}`,
          `stock_movements:${inserted[0]!.id}`,
          {
            itemId: l.itemId,
            zoneId: l.zoneId,
            qty: l.delta,
          },
        );
      }
    }),

  movements: (filter: { itemId?: string; employeeId?: string; limit: number }) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.itemId) {
      params.push(filter.itemId);
      where.push(`m.item_id = $${params.length}`);
    }
    if (filter.employeeId) {
      params.push(filter.employeeId);
      where.push(`m.employee_id = $${params.length}`);
    }
    params.push(filter.limit);
    return db.query<MovementViewRow>(
      `SELECT m.id, m.item_id, i.sku, i.name AS item_name, i.unit, m.zone_id, z.name AS zone_name,
              m.kind, m.qty, m.employee_id, e.name AS employee_name, m.note,
              m.by_employee_id AS by_id, b.name AS by_name, m.created_at
         FROM ops.stock_movements m
         JOIN ops.stock_items i ON i.id = m.item_id
         JOIN org.punch_zones z ON z.id = m.zone_id
         JOIN org.employees b ON b.id = m.by_employee_id
         LEFT JOIN org.employees e ON e.id = m.employee_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY m.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
  },
});

export type StockRepository = ReturnType<typeof createStockRepository>;
