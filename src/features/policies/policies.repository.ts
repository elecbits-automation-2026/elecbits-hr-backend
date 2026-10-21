import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import {
  auditLog,
  employees,
  orgOwner,
  policies,
  policyAcks,
  policyDocuments,
} from '../../db/schema/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';
import type { CreatePolicyInput } from './policies.schema.js';

export type PolicyRow = typeof policies.$inferSelect;
export type PolicyAckRow = typeof policyAcks.$inferSelect;

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

/** The only place the policies feature touches the database. */
export const createPoliciesRepository = (db: DbClient) => ({
  /** Live policies only, unless HR asks for retired ones too. */
  list: async (opts: { includeRetired?: boolean } = {}): Promise<PolicyRow[]> => {
    return db.orm
      .select()
      .from(policies)
      .where(opts.includeRetired ? undefined : isNull(policies.retiredAt))
      .orderBy(asc(policies.category), asc(policies.title));
  },

  /** Retire (retiredBy set) or restore (null) + audit, one transaction. */
  setRetired: async (
    policy: PolicyRow,
    retiredBy: string | null,
    actor: ActorContext,
  ): Promise<PolicyRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(policies)
        .set({
          retiredAt: retiredBy ? new Date() : null,
          retiredBy,
          updatedAt: new Date(),
        })
        .where(eq(policies.id, policy.id))
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: retiredBy ? 'policy.retired' : 'policy.restored',
        subject: `policies:${policy.id}`,
        detail: JSON.stringify({ code: policy.code }),
      });
      return rows[0]!;
    });
  },

  findById: async (id: string): Promise<PolicyRow | undefined> => {
    const rows = await db.orm.select().from(policies).where(eq(policies.id, id)).limit(1);
    return rows[0];
  },

  /** Insert + audit, one transaction (§10). */
  insert: async (input: CreatePolicyInput, actor: ActorContext): Promise<PolicyRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .insert(policies)
        .values({
          code: input.code,
          title: input.title,
          category: input.category,
          version: input.version,
          ackRequired: input.ackRequired,
          summary: input.summary ?? null,
          docUrl: input.docUrl ?? null,
          effectiveFrom: input.effectiveFrom ?? null,
        })
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'policy.created',
        subject: `policies:${rows[0]!.id}`,
        detail: JSON.stringify({ code: input.code, version: input.version }),
      });
      return rows[0]!;
    });
  },

  /** Patch + audit; the service decides the action name and detail. */
  update: async (
    id: string,
    patch: Partial<typeof policies.$inferInsert>,
    actor: ActorContext,
    audit: { action: string; detail: Record<string, unknown> },
    /** Bell rows announced by this edit — written in the same transaction. */
    notify?: { recipientIds: string[]; event: NotificationEvent },
  ): Promise<PolicyRow | undefined> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(policies)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(policies.id, id))
        .returning();
      if (!rows[0]) return undefined;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: audit.action,
        subject: `policies:${id}`,
        detail: JSON.stringify(audit.detail),
      });
      if (notify) await insertNotifications(tx, notify.recipientIds, notify.event);
      return rows[0];
    });
  },

  /** Append-only signature + audit. The unique index is the double-ack arbiter. */
  insertAck: async (
    policy: PolicyRow,
    employeeId: string,
    actor: ActorContext,
  ): Promise<PolicyAckRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .insert(policyAcks)
        .values({ policyId: policy.id, employeeId, version: policy.version })
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'policy.acknowledged',
        subject: `policies:${policy.id}`,
        detail: JSON.stringify({ code: policy.code, version: policy.version }),
      });
      return rows[0]!;
    });
  },

  /** Every ack the caller has ever signed — the service keeps the latest per policy. */
  listAcksFor: async (employeeId: string): Promise<PolicyAckRow[]> => {
    return db.orm
      .select()
      .from(policyAcks)
      .where(eq(policyAcks.employeeId, employeeId))
      .orderBy(desc(policyAcks.ackedAt));
  },

  /** Org-wide acks for the tracker. TODO(skeleton): filter by resolved scope. */
  /** Live (active/exiting) people holding ANY signature on this policy. */
  listSignerIds: async (policyId: string): Promise<string[]> => {
    const rows = await db.orm
      .selectDistinct({ id: policyAcks.employeeId })
      .from(policyAcks)
      .innerJoin(employees, eq(employees.id, policyAcks.employeeId))
      .where(
        and(
          eq(policyAcks.policyId, policyId),
          inArray(employees.status, ['active', 'exiting']),
        ),
      );
    return rows.map((r) => r.id);
  },

  listAllAcks: async (): Promise<PolicyAckRow[]> => {
    return db.orm.select().from(policyAcks).orderBy(desc(policyAcks.ackedAt));
  },

  /** Policy ids that have a stored PDF — powers the hasDocument flag. */
  documentPolicyIds: async (): Promise<Set<string>> => {
    const rows = await db.orm
      .select({ policyId: policyDocuments.policyId })
      .from(policyDocuments);
    return new Set(rows.map((r) => r.policyId));
  },

  findDocument: async (policyId: string) => {
    const rows = await db.orm
      .select()
      .from(policyDocuments)
      .where(eq(policyDocuments.policyId, policyId))
      .limit(1);
    return rows[0];
  },

  /**
   * Store/replace the PDF and CLEAR the external link in one transaction —
   * from here on, our database is where the document lives.
   */
  upsertDocument: async (
    policy: PolicyRow,
    doc: { fileName: string; contentType: string; data: Buffer },
    actor: ActorContext,
  ): Promise<void> => {
    await db.transaction(async (tx) => {
      await tx.orm
        .insert(policyDocuments)
        .values({
          policyId: policy.id,
          fileName: doc.fileName,
          contentType: doc.contentType,
          sizeBytes: doc.data.length,
          data: doc.data,
          uploadedBy: actor.actorEmployeeId,
        })
        .onConflictDoUpdate({
          target: policyDocuments.policyId,
          set: {
            fileName: doc.fileName,
            contentType: doc.contentType,
            sizeBytes: doc.data.length,
            data: doc.data,
            uploadedBy: actor.actorEmployeeId,
            uploadedAt: new Date(),
          },
        });
      await tx.orm
        .update(policies)
        .set({ docUrl: null, updatedAt: new Date() })
        .where(eq(policies.id, policy.id));
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'policy.document_uploaded',
        subject: `policies:${policy.id}`,
        detail: JSON.stringify({
          code: policy.code,
          fileName: doc.fileName,
          sizeBytes: doc.data.length,
        }),
      });
    });
  },

  /**
   * Tracker rows: people who can actually sign — active + exiting, system
   * account excluded (user decision). `invited` stays out until the record is
   * claimed, so the coverage % never counts someone who cannot log in yet.
   */
  listTrackedEmployees: async () => {
    return db.orm
      .select({
        id: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
      })
      .from(employees)
      .leftJoin(orgOwner, eq(orgOwner.employeeId, employees.id))
      .where(
        and(
          inArray(employees.status, ['active', 'exiting']),
          isNull(orgOwner.employeeId),
        ),
      )
      .orderBy(asc(employees.name));
  },
});

export type PoliciesRepository = ReturnType<typeof createPoliciesRepository>;
