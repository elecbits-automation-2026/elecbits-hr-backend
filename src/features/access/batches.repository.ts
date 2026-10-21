import { and, eq } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import {
  auditLog,
  batchGrants,
  batches,
  employeeBatches,
  employees,
  modules,
} from '../../db/schema/index.js';
import type { GrantInput, UpsertBatchInput } from './batches.schema.js';

export type BatchRow = typeof batches.$inferSelect;
export type BatchGrantRow = typeof batchGrants.$inferSelect;

/** Who performed the mutation — for granted_by and the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

/** DB access for batches and their grant rows. */
export const createBatchesRepository = (db: DbClient) => ({
  list: async (): Promise<BatchRow[]> =>
    db.orm.select().from(batches).orderBy(batches.name),

  findById: async (id: string): Promise<BatchRow | undefined> => {
    const rows = await db.orm.select().from(batches).where(eq(batches.id, id)).limit(1);
    return rows[0];
  },

  listGrants: async (batchId: string): Promise<BatchGrantRow[]> =>
    db.orm.select().from(batchGrants).where(eq(batchGrants.batchId, batchId)),

  /** All seeded modules — the composer's pick-list. Seeding is the only writer. */
  listModules: async () => db.orm.select().from(modules).orderBy(modules.key),

  /**
   * Create the batch and its grant rows in one transaction — a batch existing
   * without its grants would be a live, holder-visible half-state (§3.2).
   * Access-shape changes are audited in the same transaction (§10).
   */
  insertWithGrants: async (
    input: UpsertBatchInput,
    actor: ActorContext,
  ): Promise<BatchRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .insert(batches)
        .values({ name: input.name, description: input.description })
        .returning();
      const batch = rows[0]!;
      if (input.grants.length > 0) {
        await tx.orm
          .insert(batchGrants)
          .values(input.grants.map((g: GrantInput) => ({ ...g, batchId: batch.id })));
      }
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'batch.created',
        subject: `batches:${batch.id}`,
        detail: JSON.stringify({ name: input.name, grants: input.grants }),
      });
      return batch;
    });
  },

  /**
   * Replace a batch's name/description/grants in one transaction. Grants are
   * resolved per request, so the edit applies LIVE to every holder on their
   * very next call (§3.2 decision #11) — hence the mandatory audit row.
   */
  updateWithGrants: async (
    batchId: string,
    input: UpsertBatchInput,
    actor: ActorContext,
  ): Promise<BatchRow | undefined> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(batches)
        .set({ name: input.name, description: input.description ?? null })
        .where(eq(batches.id, batchId))
        .returning();
      const batch = rows[0];
      if (!batch) return undefined;
      await tx.orm.delete(batchGrants).where(eq(batchGrants.batchId, batchId));
      if (input.grants.length > 0) {
        await tx.orm
          .insert(batchGrants)
          .values(input.grants.map((g: GrantInput) => ({ ...g, batchId })));
      }
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'batch.updated',
        subject: `batches:${batchId}`,
        detail: JSON.stringify({ name: input.name, grants: input.grants }),
      });
      return batch;
    });
  },

  /** Does this employee currently hold the batch? (self-edit guard, §10) */
  isHolder: async (batchId: string, employeeId: string): Promise<boolean> => {
    const rows = await db.orm
      .select({ employeeId: employeeBatches.employeeId })
      .from(employeeBatches)
      .where(
        and(
          eq(employeeBatches.batchId, batchId),
          eq(employeeBatches.employeeId, employeeId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  },

  /** Everyone currently holding the batch, with who granted it and when. */
  listHolders: async (batchId: string) =>
    db.orm
      .select({
        employeeId: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
        email: employees.email,
        grantedBy: employeeBatches.grantedBy,
        grantedAt: employeeBatches.createdAt,
      })
      .from(employeeBatches)
      .innerJoin(employees, eq(employees.id, employeeBatches.employeeId))
      .where(eq(employeeBatches.batchId, batchId))
      .orderBy(employees.name),

  /** Attach + audit row in one transaction (§10). */
  attachToEmployee: async (batchId: string, employeeId: string, actor: ActorContext) => {
    await db.transaction(async (tx) => {
      await tx.orm
        .insert(employeeBatches)
        .values({ batchId, employeeId, grantedBy: actor.actorEmployeeId })
        .onConflictDoNothing();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'batch.assigned',
        subject: `employees:${employeeId}`,
        detail: JSON.stringify({ batchId }),
      });
    });
  },

  /**
   * Detach + audit row in one transaction. Removal takes effect on the
   * holder's very next request — grants are never cached in the token (§10).
   */
  detachFromEmployee: async (
    batchId: string,
    employeeId: string,
    actor: ActorContext,
  ): Promise<boolean> => {
    return db.transaction(async (tx) => {
      const removed = await tx.orm
        .delete(employeeBatches)
        .where(
          and(
            eq(employeeBatches.batchId, batchId),
            eq(employeeBatches.employeeId, employeeId),
          ),
        )
        .returning();
      if (removed.length === 0) return false;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'batch.revoked',
        subject: `employees:${employeeId}`,
        detail: JSON.stringify({ batchId }),
      });
      return true;
    });
  },
});

export type BatchesRepository = ReturnType<typeof createBatchesRepository>;
