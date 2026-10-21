import { and, eq } from 'drizzle-orm';
import createError from 'http-errors';
import type { DbClient } from '../../db/client.js';
import { assetEvents, gatePasses } from '../../db/schema/index.js';
import { insertNotifications } from '../notifications/index.js';
import {
  auditIn,
  type ActorContext,
  type AssetEventInsert,
  type Bell,
} from './ops.repository.js';

export type GatePassRow = typeof gatePasses.$inferSelect;

export interface PassViewRow {
  id: string;
  asset_id: string;
  asset_code: string;
  asset_name: string;
  zone_id: string;
  zone_name: string;
  requested_by: string;
  holder_name: string;
  purpose: string;
  destination: string;
  return_on: string;
  original_return_on: string;
  disclaimer_accepted_at: Date;
  status: GatePassRow['status'];
  decided_by: string | null;
  decider_name: string | null;
  decided_at: Date | null;
  decline_reason: string | null;
  returned_at: Date | null;
  returned_confirmed_by: string | null;
  confirmer_name: string | null;
  created_at: Date;
}

const PASS_VIEW = `
  SELECT p.id, p.asset_id, a.asset_code, a.name AS asset_name, a.zone_id, z.name AS zone_name,
         p.requested_by, e.name AS holder_name, p.purpose, p.destination,
         p.return_on::text, p.original_return_on::text, p.disclaimer_accepted_at, p.status,
         p.decided_by, d.name AS decider_name, p.decided_at, p.decline_reason,
         p.returned_at, p.returned_confirmed_by, c.name AS confirmer_name, p.created_at
    FROM ops.gate_passes p
    JOIN ops.assets a ON a.id = p.asset_id
    JOIN org.punch_zones z ON z.id = a.zone_id
    JOIN org.employees e ON e.id = p.requested_by
    LEFT JOIN org.employees d ON d.id = p.decided_by
    LEFT JOIN org.employees c ON c.id = p.returned_confirmed_by`;

const isUniqueViolation = (err: unknown) =>
  (err as { code?: string }).code === '23505' ||
  (err as { cause?: { code?: string } }).cause?.code === '23505';

/** DB access for gate passes. Every step also writes the asset's history row. */
export const createGatePassesRepository = (db: DbClient) => ({
  views: (filter: { requestedBy?: string; id?: string } = {}) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.requestedBy) {
      params.push(filter.requestedBy);
      where.push(`p.requested_by = $${params.length}`);
    }
    if (filter.id) {
      params.push(filter.id);
      where.push(`p.id = $${params.length}`);
    }
    return db.query<PassViewRow>(
      `${PASS_VIEW} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY (p.status IN ('requested', 'approved')) DESC, p.return_on, p.created_at DESC`,
      params,
    );
  },

  findById: async (id: string): Promise<GatePassRow | undefined> =>
    (await db.orm.select().from(gatePasses).where(eq(gatePasses.id, id)).limit(1))[0],

  /** One live pass per asset — a second one is a 409, not a crash. */
  insert: async (
    values: typeof gatePasses.$inferInsert,
    event: AssetEventInsert,
    actor: ActorContext,
    bell: Bell,
  ): Promise<string> => {
    try {
      return await db.transaction(async (tx) => {
        const rows = await tx.orm.insert(gatePasses).values(values).returning();
        const id = rows[0]!.id;
        await tx.orm.insert(assetEvents).values({
          ...event,
          assetId: values.assetId,
          byEmployeeId: actor.actorEmployeeId,
        });
        await auditIn(tx, actor, 'ops.pass_requested', `gate_passes:${id}`, {
          assetId: values.assetId,
        });
        await insertNotifications(tx, bell.to, bell.event);
        return id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw createError(409, 'This item already has a live gate pass', {
          code: 'PASS_OPEN',
        });
      }
      throw err;
    }
  },

  /** Move a pass on from the status it is still in, with its history row and bells. */
  transition: (
    pass: GatePassRow,
    patch: Partial<typeof gatePasses.$inferInsert>,
    event: AssetEventInsert,
    action: string,
    actor: ActorContext,
    bells: Bell[],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(gatePasses)
        .set(patch)
        .where(and(eq(gatePasses.id, pass.id), eq(gatePasses.status, pass.status)))
        .returning();
      if (!rows[0]) return false;
      await tx.orm.insert(assetEvents).values({
        ...event,
        assetId: pass.assetId,
        byEmployeeId: actor.actorEmployeeId,
      });
      await auditIn(tx, actor, action, `gate_passes:${pass.id}`, {
        assetId: pass.assetId,
      });
      for (const b of bells) await insertNotifications(tx, b.to, b.event);
      return true;
    }),
});

export type GatePassesRepository = ReturnType<typeof createGatePassesRepository>;
