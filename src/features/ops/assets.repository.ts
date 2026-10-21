import { eq } from 'drizzle-orm';
import createError from 'http-errors';
import type { DbClient } from '../../db/client.js';
import { assetEvents, assetIncidents, assets } from '../../db/schema/index.js';
import { insertNotifications } from '../notifications/index.js';
import {
  applyAssetChangeIn,
  auditIn,
  type ActorContext,
  type AssetChange,
  type AssetEventInsert,
  type Bell,
} from './ops.repository.js';

export type IncidentRow = typeof assetIncidents.$inferSelect;
export type AssetInsert = typeof assets.$inferInsert;

/** A new asset plus its first history row (and the bell when it is issued). */
export interface NewAsset {
  values: AssetInsert;
  event: AssetEventInsert;
  bells?: Bell[];
}

export interface EventViewRow {
  id: string;
  kind: string;
  employee_id: string | null;
  employee_name: string | null;
  zone_id: string | null;
  zone_name: string | null;
  status: string | null;
  condition: string | null;
  due_on: string | null;
  prev_due_on: string | null;
  note: string | null;
  by_id: string | null;
  by_name: string | null;
  at: Date;
}

export interface IncidentViewRow {
  id: string;
  asset_id: string;
  asset_code: string;
  asset_name: string;
  employee_id: string | null;
  employee_name: string | null;
  kind: 'damage' | 'loss' | 'theft';
  description: string;
  reported_by: string;
  reporter_name: string;
  status: 'open' | 'closed';
  outcome: string | null;
  closed_by: string | null;
  closer_name: string | null;
  closed_at: Date | null;
  created_at: Date;
}

export interface PassSummaryRow {
  id: string;
  holder_id: string;
  holder_name: string;
  purpose: string;
  destination: string;
  status: 'requested' | 'approved' | 'declined' | 'returned';
  return_on: string;
  created_at: Date;
}

const INCIDENT_VIEW = `
  SELECT i.id, i.asset_id, a.asset_code, a.name AS asset_name,
         i.employee_id, e.name AS employee_name, i.kind, i.description,
         i.reported_by, r.name AS reporter_name, i.status, i.outcome,
         i.closed_by, c.name AS closer_name, i.closed_at, i.created_at
    FROM ops.asset_incidents i
    JOIN ops.assets a ON a.id = i.asset_id
    JOIN org.employees r ON r.id = i.reported_by
    LEFT JOIN org.employees e ON e.id = i.employee_id
    LEFT JOIN org.employees c ON c.id = i.closed_by`;

/** DB access for the asset register: create / import, history, incidents, custody. */
export const createAssetsRepository = (db: DbClient) => ({
  /** Insert assets with their first history rows — all or nothing. */
  insertMany: (rows: NewAsset[], actor: ActorContext): Promise<string[]> =>
    db.transaction(async (tx) => {
      const ids: string[] = [];
      for (const r of rows) {
        const inserted = await tx.orm.insert(assets).values(r.values).returning();
        const id = inserted[0]!.id;
        ids.push(id);
        await tx.orm.insert(assetEvents).values({
          ...r.event,
          assetId: id,
          byEmployeeId: actor.actorEmployeeId,
        });
        await auditIn(tx, actor, 'ops.asset_registered', `assets:${id}`, {
          status: r.values.status,
          holderId: r.values.holderId ?? null,
        });
        for (const b of r.bells ?? []) await insertNotifications(tx, b.to, b.event);
      }
      return ids;
    }),

  events: (assetId: string) =>
    db.query<EventViewRow>(
      `SELECT ev.id, ev.kind, ev.employee_id, e.name AS employee_name,
              ev.zone_id, z.name AS zone_name, ev.status, ev.condition,
              ev.due_on::text, ev.prev_due_on::text, ev.note,
              ev.by_employee_id AS by_id, b.name AS by_name, ev.at
         FROM ops.asset_events ev
         LEFT JOIN org.employees e ON e.id = ev.employee_id
         LEFT JOIN org.punch_zones z ON z.id = ev.zone_id
         LEFT JOIN org.employees b ON b.id = ev.by_employee_id
        WHERE ev.asset_id = $1
        ORDER BY ev.at DESC`,
      [assetId],
    ),

  passesFor: (assetId: string) =>
    db.query<PassSummaryRow>(
      `SELECT p.id, p.requested_by AS holder_id, e.name AS holder_name, p.purpose,
              p.destination, p.status, p.return_on::text, p.created_at
         FROM ops.gate_passes p JOIN org.employees e ON e.id = p.requested_by
        WHERE p.asset_id = $1 ORDER BY p.created_at DESC`,
      [assetId],
    ),

  incidents: (filter: { assetId?: string } = {}) =>
    db.query<IncidentViewRow>(
      `${INCIDENT_VIEW} ${filter.assetId ? 'WHERE i.asset_id = $1' : ''}
        ORDER BY (i.status = 'open') DESC, i.created_at DESC`,
      filter.assetId ? [filter.assetId] : [],
    ),

  incident: async (id: string): Promise<IncidentRow | undefined> =>
    (
      await db.orm.select().from(assetIncidents).where(eq(assetIncidents.id, id)).limit(1)
    )[0],

  /** Record an incident and its history row; tell OPS when someone else reported it. */
  insertIncident: (
    values: typeof assetIncidents.$inferInsert,
    actor: ActorContext,
    bell?: Bell,
  ): Promise<string> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm.insert(assetIncidents).values(values).returning();
      const id = rows[0]!.id;
      await tx.orm.insert(assetEvents).values({
        assetId: values.assetId,
        kind: 'incident_opened',
        employeeId: values.employeeId ?? null,
        byEmployeeId: actor.actorEmployeeId,
      });
      await auditIn(tx, actor, 'ops.incident_opened', `asset_incidents:${id}`, {
        assetId: values.assetId,
        kind: values.kind,
      });
      if (bell) await insertNotifications(tx, bell.to, bell.event);
      return id;
    }),

  /**
   * Close an incident; when the asset is confirmed lost, the asset change
   * (status `lost`) rides in the same transaction. False = it moved meanwhile.
   */
  closeIncident: async (
    id: string,
    patch: { outcome: string; closedBy: string },
    actor: ActorContext,
    assetChange?: AssetChange,
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(assetIncidents)
        .set({
          status: 'closed',
          outcome: patch.outcome,
          closedBy: patch.closedBy,
          closedAt: new Date(),
        })
        .where(eq(assetIncidents.id, id))
        .returning();
      const inc = rows[0];
      if (!inc) return false;
      if (assetChange) {
        if (!(await applyAssetChangeIn(tx, assetChange, actor))) {
          throw createError(409, 'The asset changed meanwhile — reload and try again', {
            code: 'ASSET_CHANGED',
          });
        }
      } else {
        await tx.orm.insert(assetEvents).values({
          assetId: inc.assetId,
          kind: 'incident_closed',
          byEmployeeId: actor.actorEmployeeId,
        });
      }
      await auditIn(tx, actor, 'ops.incident_closed', `asset_incidents:${id}`, {
        assetId: inc.assetId,
        assetLost: !!assetChange,
      });
      return true;
    }),

  /** Kit lines for a designation with how many of each category the person holds. */
  kitCheck: (designation: string, employeeId: string) =>
    db.query<{ category_id: string; category_name: string; qty: number; held: number }>(
      `SELECT k.category_id, c.name AS category_name, k.qty,
              (SELECT count(*)::int FROM ops.assets a
                WHERE a.category_id = k.category_id AND a.holder_id = $2) AS held
         FROM ops.asset_kits k JOIN ops.asset_categories c ON c.id = k.category_id
        WHERE lower(k.designation) = lower($1)
        ORDER BY c.name`,
      [designation, employeeId],
    ),
});

/**
 * What a person still has to give back — the Exit clearance reads this (p71:
 * return all company property). Assets they hold (loans included) and items
 * out on a gate pass they are responsible for.
 */
export const createOpsCustodyReader = (db: DbClient) => ({
  openCustody: async (employeeId: string) => {
    const [held, passes] = await Promise.all([
      db.query<{
        id: string;
        asset_code: string;
        name: string;
        loan_due_on: string | null;
      }>(
        `SELECT id, asset_code, name, loan_due_on::text FROM ops.assets
          WHERE holder_id = $1 AND status = 'assigned' ORDER BY asset_code`,
        [employeeId],
      ),
      db.query<{ id: string; asset_code: string; name: string; return_on: string }>(
        `SELECT p.id, a.asset_code, a.name, p.return_on::text
           FROM ops.gate_passes p JOIN ops.assets a ON a.id = p.asset_id
          WHERE p.requested_by = $1 AND p.status = 'approved'
            AND a.status NOT IN ('scrapped', 'gifted', 'lost')`,
        [employeeId],
      ),
    ]);
    return {
      assets: held.map((a) => ({
        id: a.id,
        assetCode: a.asset_code,
        name: a.name,
        loanDueOn: a.loan_due_on,
      })),
      passes: passes.map((p) => ({
        id: p.id,
        assetCode: p.asset_code,
        name: p.name,
        returnOn: p.return_on,
      })),
    };
  },
});

export type AssetsRepository = ReturnType<typeof createAssetsRepository>;
export type OpsCustodyReader = ReturnType<typeof createOpsCustodyReader>;
