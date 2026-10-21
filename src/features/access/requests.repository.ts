import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import {
  auditLog,
  batches,
  employeeBatches,
  employees,
  grantRequestItems,
  grantRequests,
  individualGrants,
  orgOwner,
  superadmins,
} from '../../db/schema/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';
import type { CreateGrantRequestInput, RequestItem } from './requests.schema.js';

export type GrantRequestRow = typeof grantRequests.$inferSelect;
export type GrantRequestItemRow = typeof grantRequestItems.$inferSelect & {
  batchName: string | null;
};

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

type Notify = { recipientIds: string[]; event: NotificationEvent };

/** DB access for grant requests and their items. */
export const createRequestsRepository = (db: DbClient) => ({
  list: async (opts: { requestedBy?: string } = {}): Promise<GrantRequestRow[]> =>
    db.orm
      .select()
      .from(grantRequests)
      .where(
        opts.requestedBy ? eq(grantRequests.requestedBy, opts.requestedBy) : undefined,
      )
      .orderBy(desc(grantRequests.createdAt)),

  findById: async (id: string): Promise<GrantRequestRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(grantRequests)
      .where(eq(grantRequests.id, id))
      .limit(1);
    return rows[0];
  },

  itemsFor: async (requestIds: string[]): Promise<GrantRequestItemRow[]> => {
    if (requestIds.length === 0) return [];
    const rows = await db.orm
      .select({ item: grantRequestItems, batchName: batches.name })
      .from(grantRequestItems)
      .leftJoin(batches, eq(batches.id, grantRequestItems.batchId))
      .where(inArray(grantRequestItems.requestId, requestIds));
    return rows.map((r) => ({ ...r.item, batchName: r.batchName }));
  },

  namesByIds: async (ids: string[]): Promise<Map<string, string>> => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await db.orm
      .select({ id: employees.id, name: employees.name })
      .from(employees)
      .where(inArray(employees.id, unique));
    return new Map(rows.map((r) => [r.id, r.name]));
  },

  findEmployee: async (id: string) => {
    const rows = await db.orm
      .select({ id: employees.id, name: employees.name, status: employees.status })
      .from(employees)
      .where(eq(employees.id, id))
      .limit(1);
    return rows[0];
  },

  /** Batches HR may propose — every batch except the baseline Employee one. */
  requestableBatches: async () =>
    db.orm
      .select({ id: batches.id, name: batches.name, description: batches.description })
      .from(batches)
      .where(ne(batches.name, 'Employee'))
      .orderBy(batches.name),

  /** The deciders: the Owner and every SuperAdmin. */
  deciderIds: async (): Promise<string[]> => {
    const [owner, admins] = await Promise.all([
      db.orm.select({ id: orgOwner.employeeId }).from(orgOwner),
      db.orm.select({ id: superadmins.employeeId }).from(superadmins),
    ]);
    return [...new Set([...owner, ...admins].map((r) => r.id))];
  },

  isOwner: async (employeeId: string): Promise<boolean> => {
    const rows = await db.orm
      .select({ id: orgOwner.employeeId })
      .from(orgOwner)
      .where(eq(orgOwner.employeeId, employeeId))
      .limit(1);
    return rows.length > 0;
  },

  /** Request + items + audit + the deciders' bell, together or not at all. */
  insertWithItems: async (
    input: CreateGrantRequestInput,
    actor: ActorContext,
    notify: Notify,
  ): Promise<GrantRequestRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .insert(grantRequests)
        .values({
          employeeId: input.employeeId,
          requestedBy: actor.actorEmployeeId,
          note: input.note,
        })
        .returning();
      const request = rows[0]!;
      await tx.orm
        .insert(grantRequestItems)
        .values(input.items.map((item) => ({ ...item, requestId: request.id })));
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'grant_request.created',
        subject: `grant_requests:${request.id}`,
        detail: JSON.stringify({ employeeId: input.employeeId, items: input.items }),
      });
      await insertNotifications(tx, notify.recipientIds, notify.event);
      return request;
    });
  },

  /**
   * The decision, ONE transaction (§5.5, §10): the status flips only if the
   * request is still pending (two deciders can't both land), the granted
   * items are written as their own rows (what was asked and what was given
   * both survive), the access is attached so it bites on the next request,
   * then the audit row and the bell.
   */
  applyDecision: async (
    request: GrantRequestRow,
    decision: {
      status: 'approved' | 'approved_narrower' | 'declined';
      reason: string | null;
      granted: RequestItem[];
    },
    actor: ActorContext,
    notify: Notify,
  ): Promise<GrantRequestRow | undefined> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(grantRequests)
        .set({
          status: decision.status,
          decidedBy: actor.actorEmployeeId,
          decisionReason: decision.reason,
          decidedAt: new Date(),
        })
        .where(and(eq(grantRequests.id, request.id), eq(grantRequests.status, 'pending')))
        .returning();
      const updated = rows[0];
      if (!updated) return undefined;

      if (decision.granted.length > 0) {
        await tx.orm.insert(grantRequestItems).values(
          decision.granted.map((item) => ({
            ...item,
            requestId: request.id,
            granted: 'granted' as const,
          })),
        );
        for (const item of decision.granted) {
          if (item.kind === 'batch') {
            await tx.orm
              .insert(employeeBatches)
              .values({
                employeeId: request.employeeId,
                batchId: item.batchId!,
                grantedBy: actor.actorEmployeeId,
              })
              .onConflictDoNothing();
          } else {
            await tx.orm
              .insert(individualGrants)
              .values({
                employeeId: request.employeeId,
                moduleKey: item.moduleKey!,
                action: item.action!,
                scope: item.scope!,
                grantedBy: actor.actorEmployeeId,
              })
              .onConflictDoNothing();
          }
        }
      }

      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: `grant_request.${decision.status}`,
        subject: `grant_requests:${request.id}`,
        detail: JSON.stringify({
          employeeId: request.employeeId,
          granted: decision.granted,
          reason: decision.reason,
        }),
      });
      await insertNotifications(tx, notify.recipientIds, notify.event);
      return updated;
    });
  },
});

export type RequestsRepository = ReturnType<typeof createRequestsRepository>;
