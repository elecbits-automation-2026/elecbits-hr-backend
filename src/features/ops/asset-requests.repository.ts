import { and, eq } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { assetRequests } from '../../db/schema/index.js';
import { insertNotifications } from '../notifications/index.js';
import { auditIn, type ActorContext, type Bell } from './ops.repository.js';

export type AssetRequestRow = typeof assetRequests.$inferSelect;

/** A request joined to the names its screens show. */
export interface RequestViewRow {
  id: string;
  requested_by: string;
  requester_name: string;
  type: AssetRequestRow['type'];
  asset_id: string | null;
  asset_code: string | null;
  asset_name: string | null;
  category_id: string | null;
  category_name: string | null;
  note: string | null;
  status: AssetRequestRow['status'];
  handled_by: string | null;
  handler_name: string | null;
  handler_note: string | null;
  fulfilled_asset_id: string | null;
  fulfilled_code: string | null;
  fulfilled_name: string | null;
  created_at: Date;
  updated_at: Date;
}

const REQUEST_VIEW = `
  SELECT r.id, r.requested_by, e.name AS requester_name, r.type,
         r.asset_id, a.asset_code, a.name AS asset_name,
         r.category_id, c.name AS category_name, r.note, r.status,
         r.handled_by, h.name AS handler_name, r.handler_note,
         r.fulfilled_asset_id, f.asset_code AS fulfilled_code, f.name AS fulfilled_name,
         r.created_at, r.updated_at
    FROM ops.asset_requests r
    JOIN org.employees e ON e.id = r.requested_by
    LEFT JOIN ops.assets a ON a.id = r.asset_id
    LEFT JOIN ops.asset_categories c ON c.id = r.category_id
    LEFT JOIN org.employees h ON h.id = r.handled_by
    LEFT JOIN ops.assets f ON f.id = r.fulfilled_asset_id`;

/** DB access for the OPS request queue. */
export const createAssetRequestsRepository = (db: DbClient) => ({
  /** The shared queue (open first), or one person's requests. */
  views: (filter: { requestedBy?: string; id?: string } = {}) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.requestedBy) {
      params.push(filter.requestedBy);
      where.push(`r.requested_by = $${params.length}`);
    }
    if (filter.id) {
      params.push(filter.id);
      where.push(`r.id = $${params.length}`);
    }
    return db.query<RequestViewRow>(
      `${REQUEST_VIEW} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY (r.status IN ('open', 'in_progress')) DESC, r.created_at DESC`,
      params,
    );
  },

  findById: async (id: string): Promise<AssetRequestRow | undefined> =>
    (
      await db.orm.select().from(assetRequests).where(eq(assetRequests.id, id)).limit(1)
    )[0],

  insert: (
    values: typeof assetRequests.$inferInsert,
    actor: ActorContext,
    bell: Bell,
  ): Promise<string> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm.insert(assetRequests).values(values).returning();
      const id = rows[0]!.id;
      await auditIn(tx, actor, 'ops.request_raised', `asset_requests:${id}`, {
        type: values.type,
        assetId: values.assetId ?? null,
      });
      await insertNotifications(tx, bell.to, bell.event);
      return id;
    }),

  /** Move a request on from the status it is still in; false = it moved meanwhile. */
  setStatusIn: async (
    tx: DbClient,
    id: string,
    from: AssetRequestRow['status'],
    patch: Partial<typeof assetRequests.$inferInsert>,
    actor: ActorContext,
    bell?: Bell,
  ): Promise<boolean> => {
    const rows = await tx.orm
      .update(assetRequests)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(assetRequests.id, id), eq(assetRequests.status, from)))
      .returning();
    if (!rows[0]) return false;
    await auditIn(tx, actor, `ops.request_${patch.status}`, `asset_requests:${id}`, {
      fulfilledAssetId: patch.fulfilledAssetId ?? null,
    });
    if (bell) await insertNotifications(tx, bell.to, bell.event);
    return true;
  },

  setStatus: (
    id: string,
    from: AssetRequestRow['status'],
    patch: Partial<typeof assetRequests.$inferInsert>,
    actor: ActorContext,
    bell?: Bell,
  ): Promise<boolean> =>
    db.transaction(async (tx) =>
      createAssetRequestsRepository(tx).setStatusIn(tx, id, from, patch, actor, bell),
    ),
});

export type AssetRequestsRepository = ReturnType<typeof createAssetRequestsRepository>;
