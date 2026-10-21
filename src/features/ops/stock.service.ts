import { randomUUID } from 'node:crypto';
import createError from 'http-errors';
import type { ActorContext, OpsRepository } from './ops.repository.js';
import type { MovementViewRow, StockLine, StockRepository } from './stock.repository.js';
import type {
  CreateStockItemInput,
  StockMoveInput,
  StockMovementDto,
  StockOverviewDto,
  UpdateStockItemInput,
} from './stock.schema.js';

export const toMovement = (m: MovementViewRow): StockMovementDto => ({
  id: m.id,
  item: { id: m.item_id, sku: m.sku, name: m.item_name, unit: m.unit },
  zone: { id: m.zone_id, name: m.zone_name },
  kind: m.kind,
  qty: m.qty,
  employee: m.employee_id ? { id: m.employee_id, name: m.employee_name ?? '' } : null,
  note: m.note,
  by: { id: m.by_id, name: m.by_name },
  createdAt: m.created_at.toISOString(),
});

/**
 * Consumable stock (user decisions 2026-10-15): counted per zone; OPS
 * records stock in, issues to a person, transfers between zones and adjusts
 * after a recount (with a reason). No reorder alerts, no purchasing. Every
 * move is a ledger row; a zone can never go below zero.
 */
export const createStockService = (deps: {
  repo: StockRepository;
  ops: OpsRepository;
}) => {
  const { repo, ops } = deps;

  const overview = async (): Promise<StockOverviewDto> => {
    const [items, zones, levels] = await Promise.all([
      repo.items(),
      ops.zones(),
      repo.levels(),
    ]);
    return {
      items,
      zones,
      levels: levels.map((l) => ({ itemId: l.item_id, zoneId: l.zone_id, qty: l.qty })),
    };
  };

  const createItem = async (input: CreateStockItemInput, actor: ActorContext) => {
    if (await repo.skuTaken(input.sku)) {
      throw createError(409, `SKU ${input.sku} is already used`, { code: 'SKU_TAKEN' });
    }
    await repo.insertItem(
      {
        sku: input.sku,
        name: input.name,
        category: input.category ?? null,
        unit: input.unit ?? 'pcs',
      },
      actor,
    );
    return overview();
  };

  const updateItem = async (
    id: string,
    input: UpdateStockItemInput,
    actor: ActorContext,
  ) => {
    if (!(await repo.updateItem(id, input, actor))) {
      throw createError(404, 'Stock item not found', { code: 'ITEM_NOT_FOUND' });
    }
    return overview();
  };

  const move = async (input: StockMoveInput, actor: ActorContext) => {
    const item = await repo.item(input.itemId);
    if (!item) throw createError(404, 'Stock item not found', { code: 'ITEM_NOT_FOUND' });
    if (!item.active && input.kind !== 'adjust') {
      throw createError(422, `${item.name} is archived`, { code: 'ITEM_ARCHIVED' });
    }
    if (!(await ops.zone(input.zoneId))) {
      throw createError(422, 'Unknown zone', { code: 'ZONE_NOT_FOUND' });
    }
    if (input.kind === 'adjust') {
      if (input.qty === 0)
        throw createError(422, 'Adjust by a non-zero amount', { code: 'BAD_QTY' });
      if (!input.note?.trim()) {
        throw createError(422, 'Say why the count changed', { code: 'REASON_REQUIRED' });
      }
    } else if (input.qty <= 0) {
      throw createError(422, 'Quantity must be at least 1', { code: 'BAD_QTY' });
    }
    const note = input.note?.trim() || null;
    let lines: StockLine[];
    switch (input.kind) {
      case 'in':
        lines = [
          { itemId: item.id, zoneId: input.zoneId, delta: input.qty, kind: 'in', note },
        ];
        break;
      case 'issue': {
        if (!input.employeeId) {
          throw createError(422, 'Who is it for?', { code: 'EMPLOYEE_REQUIRED' });
        }
        const e = await ops.employee(input.employeeId);
        if (!e || e.status !== 'active') {
          throw createError(422, 'Pick an active employee', { code: 'NOT_ACTIVE' });
        }
        lines = [
          {
            itemId: item.id,
            zoneId: input.zoneId,
            delta: -input.qty,
            kind: 'issue',
            employeeId: e.id,
            note,
          },
        ];
        break;
      }
      case 'transfer': {
        if (!input.toZoneId || input.toZoneId === input.zoneId) {
          throw createError(422, 'Pick the zone it goes to', {
            code: 'TO_ZONE_REQUIRED',
          });
        }
        if (!(await ops.zone(input.toZoneId))) {
          throw createError(422, 'Unknown zone', { code: 'ZONE_NOT_FOUND' });
        }
        const transferId = randomUUID();
        lines = [
          {
            itemId: item.id,
            zoneId: input.zoneId,
            delta: -input.qty,
            kind: 'transfer_out',
            transferId,
            note,
          },
          {
            itemId: item.id,
            zoneId: input.toZoneId,
            delta: input.qty,
            kind: 'transfer_in',
            transferId,
            note,
          },
        ];
        break;
      }
      default:
        lines = [
          {
            itemId: item.id,
            zoneId: input.zoneId,
            delta: input.qty,
            kind: 'adjust',
            note,
          },
        ];
    }
    await repo.move(lines, actor);
    return overview();
  };

  const movements = async (filter: {
    itemId?: string;
    employeeId?: string;
    limit?: number;
  }) =>
    (await repo.movements({ ...filter, limit: Math.min(filter.limit ?? 200, 500) })).map(
      toMovement,
    );

  return { overview, createItem, updateItem, move, movements };
};

export type StockService = ReturnType<typeof createStockService>;
