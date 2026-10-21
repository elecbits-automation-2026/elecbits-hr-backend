import { asc, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import {
  assetCategories,
  assetEvents,
  assets,
  auditLog,
  employees,
  punchZones,
} from '../../db/schema/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

/** A bell to ring in the same transaction as the change. */
export interface Bell {
  to: string[];
  event: NotificationEvent;
}

export type AssetRow = typeof assets.$inferSelect;
export type AssetPatch = Partial<typeof assets.$inferInsert>;
export type AssetEventInsert = Omit<typeof assetEvents.$inferInsert, 'assetId'>;
export type CategoryRow = typeof assetCategories.$inferSelect;

/**
 * One change to one asset: the state it must still be in (so two OPS clicks
 * can't both win), the new values, the history row, the audit row and bells.
 */
export interface AssetChange {
  assetId: string;
  expect: { status: AssetRow['status']; holderId: string | null };
  patch: AssetPatch;
  event: AssetEventInsert;
  audit: { action: string; detail?: Record<string, unknown> };
  bells?: Bell[];
}

/** A register row joined to its category, zone, holder and live gate pass. */
export interface AssetViewRow {
  id: string;
  asset_code: string;
  name: string;
  status: AssetRow['status'];
  zone_id: string;
  zone_name: string;
  holder_id: string | null;
  holder_name: string | null;
  loan_due_on: string | null;
  make: string | null;
  model: string | null;
  serial_no: string | null;
  purchased_on: string | null;
  purchase_cost: string | null;
  vendor: string | null;
  warranty_until: string | null;
  condition: AssetRow['condition'];
  notes: string | null;
  gifted_to: string | null;
  gifted_name: string | null;
  disposed_on: string | null;
  dispose_reason: string | null;
  created_at: Date;
  cat_id: string;
  cat_name: string;
  cat_prefix: string;
  cat_kind: 'equipment' | 'lab';
  cat_gate: boolean;
  pass_id: string | null;
  pass_status: 'requested' | 'approved' | null;
  pass_holder_id: string | null;
  pass_holder_name: string | null;
  pass_return_on: string | null;
}

const ASSET_VIEW = `
  SELECT a.id, a.asset_code, a.name, a.status, a.zone_id, z.name AS zone_name,
         a.holder_id, h.name AS holder_name, a.loan_due_on::text,
         a.make, a.model, a.serial_no, a.purchased_on::text, a.purchase_cost::text,
         a.vendor, a.warranty_until::text, a.condition, a.notes,
         a.gifted_to, g.name AS gifted_name, a.disposed_on::text, a.dispose_reason,
         a.created_at,
         c.id AS cat_id, c.name AS cat_name, c.code_prefix AS cat_prefix,
         c.kind AS cat_kind, c.requires_gate_pass AS cat_gate,
         p.id AS pass_id, p.status AS pass_status, p.requested_by AS pass_holder_id,
         pe.name AS pass_holder_name, p.return_on::text AS pass_return_on
    FROM ops.assets a
    JOIN ops.asset_categories c ON c.id = a.category_id
    JOIN org.punch_zones z ON z.id = a.zone_id
    LEFT JOIN org.employees h ON h.id = a.holder_id
    LEFT JOIN org.employees g ON g.id = a.gifted_to
    LEFT JOIN ops.gate_passes p ON p.asset_id = a.id AND p.status IN ('requested', 'approved')
    LEFT JOIN org.employees pe ON pe.id = p.requested_by`;

/** Thrown inside a transaction to roll it back when an asset moved meanwhile. */
const CONFLICT = Object.freeze({ conflict: true });

/** Write one asset change inside an open transaction; false = it moved meanwhile. */
export const applyAssetChangeIn = async (
  tx: DbClient,
  change: AssetChange,
  actor: ActorContext,
): Promise<boolean> => {
  const locked = await tx.query<{ status: AssetRow['status']; holder_id: string | null }>(
    `SELECT status, holder_id FROM ops.assets WHERE id = $1 FOR UPDATE`,
    [change.assetId],
  );
  const now = locked[0];
  if (
    !now ||
    now.status !== change.expect.status ||
    now.holder_id !== change.expect.holderId
  ) {
    return false;
  }
  await tx.orm
    .update(assets)
    .set({ ...change.patch, updatedAt: new Date() })
    .where(eq(assets.id, change.assetId));
  await tx.orm.insert(assetEvents).values({
    ...change.event,
    assetId: change.assetId,
    byEmployeeId: change.event.byEmployeeId ?? actor.actorEmployeeId,
  });
  await auditIn(
    tx,
    actor,
    change.audit.action,
    `assets:${change.assetId}`,
    change.audit.detail,
  );
  for (const b of change.bells ?? []) await insertNotifications(tx, b.to, b.event);
  return true;
};

/** The audit row (§10): ids and kinds only, never free text. */
export const auditIn = async (
  tx: DbClient,
  actor: ActorContext,
  action: string,
  subject: string,
  detail?: Record<string, unknown>,
): Promise<void> => {
  await tx.orm.insert(auditLog).values({
    actorUserId: actor.actorUserId,
    action,
    subject,
    detail: detail ? JSON.stringify(detail) : null,
  });
};

/** Reads shared by every OPS fileset, and the one generic asset write. */
export const createOpsRepository = (db: DbClient) => ({
  employee: async (id: string) =>
    (
      await db.query<{
        id: string;
        name: string;
        status: string;
        designation: string | null;
        base_zone_id: string | null;
        effective_rm: string | null;
      }>(
        `SELECT id, name, status, designation, base_zone_id,
                coalesce(leave_approver, reports_to) AS effective_rm
           FROM org.employees WHERE id = $1`,
        [id],
      )
    )[0],

  /** Live people, for the issue / transfer pickers. */
  people: () =>
    db.orm
      .select({
        id: employees.id,
        name: employees.name,
        designation: employees.designation,
        baseZoneId: employees.baseZoneId,
      })
      .from(employees)
      .where(inArray(employees.status, ['active', 'exiting']))
      .orderBy(asc(employees.name)),

  peopleByEmail: async (
    emails: string[],
  ): Promise<Map<string, { id: string; status: string }>> => {
    if (emails.length === 0) return new Map();
    const rows = await db.query<{ id: string; email: string; status: string }>(
      `SELECT id, lower(email) AS email, status FROM org.employees WHERE lower(email) = ANY($1::text[])`,
      [emails.map((e) => e.toLowerCase())],
    );
    return new Map(rows.map((r) => [r.email, { id: r.id, status: r.status }]));
  },

  zones: () =>
    db.orm
      .select({ id: punchZones.id, name: punchZones.name })
      .from(punchZones)
      .orderBy(asc(punchZones.name)),

  zone: async (id: string) =>
    (
      await db.orm
        .select({ id: punchZones.id, name: punchZones.name })
        .from(punchZones)
        .where(eq(punchZones.id, id))
        .limit(1)
    )[0],

  categories: (): Promise<CategoryRow[]> =>
    db.orm.select().from(assetCategories).orderBy(asc(assetCategories.name)),

  category: async (id: string): Promise<CategoryRow | undefined> =>
    (
      await db.orm
        .select()
        .from(assetCategories)
        .where(eq(assetCategories.id, id))
        .limit(1)
    )[0],

  asset: async (id: string): Promise<AssetRow | undefined> =>
    (await db.orm.select().from(assets).where(eq(assets.id, id)).limit(1))[0],

  /** Register rows, optionally narrowed to one holder or one id set. */
  assetViews: (
    filter: { holderId?: string; ids?: string[]; gatePassOnly?: boolean } = {},
  ) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.holderId) {
      params.push(filter.holderId);
      where.push(`a.holder_id = $${params.length}`);
    }
    if (filter.ids) {
      params.push(filter.ids);
      where.push(`a.id = ANY($${params.length}::uuid[])`);
    }
    if (filter.gatePassOnly) where.push(`c.requires_gate_pass`);
    return db.query<AssetViewRow>(
      `${ASSET_VIEW} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.asset_code`,
      params,
    );
  },

  /** Codes already used with a prefix — to hand out the next EB-XXX-nnnn. */
  codesLike: async (prefix: string): Promise<string[]> =>
    (
      await db.query<{ asset_code: string }>(
        `SELECT asset_code FROM ops.assets WHERE asset_code LIKE $1`,
        [`${prefix}%`],
      )
    ).map((r) => r.asset_code),

  codeTaken: async (code: string, exceptId?: string): Promise<boolean> =>
    (
      await db.orm
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.assetCode, code))
        .limit(1)
    ).some((r) => r.id !== exceptId),

  applyAssetChange: (change: AssetChange, actor: ActorContext): Promise<boolean> =>
    db.transaction((tx) => applyAssetChangeIn(tx, change, actor)),

  /** Several asset changes and extra writes as one unit; any conflict rolls all back. */
  applyAssetChanges: async (
    changes: AssetChange[],
    actor: ActorContext,
    extra?: (tx: DbClient) => Promise<void>,
  ): Promise<boolean> => {
    try {
      return await db.transaction(async (tx) => {
        for (const c of changes) {
          if (!(await applyAssetChangeIn(tx, c, actor))) throw CONFLICT;
        }
        if (extra) await extra(tx);
        return true;
      });
    } catch (err) {
      if (err === CONFLICT) return false;
      throw err;
    }
  },
});

export type OpsRepository = ReturnType<typeof createOpsRepository>;
