import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import {
  auditLog,
  batches,
  departments,
  employeeBatches,
  employeeSalary,
  employees,
  orgOwner,
  users,
} from '../../db/schema/index.js';
import { revokeEmployeeRefreshTokens } from '../auth/index.js';
import { recordLevelChange } from '../career/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';
import { BASELINE_BATCHES } from '../../shared/constants/constants.js';
import type {
  CreateEmployeeInput,
  InviteEmployeeInput,
  UpdateEmployeeInput,
  UpdateSalaryInput,
} from './employees.schema.js';
import type { EmployeeRow } from './employees.types.js';

/** Who performed the mutation — for granted_by and the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

/** Attach the baseline Employee batch (§5.3); false when the seed hasn't run. */
const attachEmployeeBatch = async (
  tx: DbClient,
  employeeId: string,
  grantedBy: string,
): Promise<boolean> => {
  const rows = await tx.orm
    .select({ id: batches.id })
    .from(batches)
    .where(eq(batches.name, BASELINE_BATCHES.employee))
    .limit(1);
  const batch = rows[0];
  if (!batch) return false;
  await tx.orm
    .insert(employeeBatches)
    .values({ employeeId, batchId: batch.id, grantedBy })
    .onConflictDoNothing();
  return true;
};

/** An invited record, ready to insert (the Admin invite and the CSV import). */
export type InvitedInsertInput = InviteEmployeeInput & {
  noticeDays: number | null;
  confirmationDate: string | null;
  /** HR bell rows for an incomplete record — written in this transaction. */
  notify?: { recipientIds: string[]; event: NotificationEvent };
  claimTokenHash: string;
  claimTokenExpiresAt: Date;
};

/**
 * Insert one invited record: next free employee code, the Employee batch plus
 * any pre-attached batches, the audit row and optional bell rows — one
 * transaction (reused when the caller is already inside one, as the import is).
 */
const insertInvitedRow = async (
  db: DbClient,
  input: InvitedInsertInput,
  actor: ActorContext,
): Promise<{ row: EmployeeRow; employeeBatchAttached: boolean }> => {
  return db.transaction(async (tx) => {
    // Next free code. The unique index still backstops a concurrent race —
    // callers surface that as the same 409 a duplicate email produces.
    const maxRows = await tx.query<{ max: number }>(
      `SELECT COALESCE(MAX(SUBSTRING(employee_code FROM 4)::int), 0) AS max
         FROM org.employees
        WHERE employee_code ~ '^EB-[0-9]+$'`,
    );
    const employeeCode = `EB-${String((maxRows[0]?.max ?? 0) + 1).padStart(4, '0')}`;

    const rows = await tx.orm
      .insert(employees)
      .values({
        name: input.name,
        email: input.email,
        employeeCode,
        level: input.level,
        reportsTo: input.reportsTo,
        baseZoneId: input.baseZoneId ?? null,
        noticeDays: input.noticeDays,
        dateOfJoining: input.dateOfJoining ?? null,
        confirmationDate: input.confirmationDate,
        departmentId: input.departmentId ?? null,
        designation: input.designation ?? null,
        claimTokenHash: input.claimTokenHash,
        claimTokenExpiresAt: input.claimTokenExpiresAt,
      })
      .returning();
    const row = rows[0]!;

    const employeeBatchAttached = await attachEmployeeBatch(
      tx,
      row.id,
      actor.actorEmployeeId,
    );
    if (input.batchIds.length > 0) {
      await tx.orm
        .insert(employeeBatches)
        .values(
          input.batchIds.map((batchId) => ({
            employeeId: row.id,
            batchId,
            grantedBy: actor.actorEmployeeId,
          })),
        )
        .onConflictDoNothing();
    }

    await tx.orm.insert(auditLog).values({
      actorUserId: actor.actorUserId,
      action: 'employee.invited',
      subject: `employees:${row.id}`,
      detail: JSON.stringify({
        employeeCode,
        email: row.email,
        reportsTo: row.reportsTo,
        batchIds: input.batchIds,
        employeeBatchAttached,
      }),
    });
    if (input.notify) {
      await insertNotifications(tx, input.notify.recipientIds, input.notify.event);
    }

    return { row, employeeBatchAttached };
  });
};

/**
 * The only place the employees feature touches the database, via the injected
 * DbClient. Scope filtering (me/team/dept/org, §3.1) belongs here once the
 * access resolver lands: `team` derives from `reports_to` with a recursive CTE
 * (the SQL `org.in_subtree` function, §11.3), never stored per person.
 */
export const createEmployeesRepository = (db: DbClient) => ({
  /** Every record — the controller narrows it to the caller's grant (Phase 3). */
  list: async (): Promise<EmployeeRow[]> => {
    return db.orm.select().from(employees).orderBy(employees.name);
  },

  /** Department id -> name, for the department column on every surface. */
  departmentNames: async (): Promise<Map<string, string>> => {
    const rows = await db.orm
      .select({ id: departments.id, name: departments.name })
      .from(departments);
    return new Map(rows.map((r) => [r.id, r.name]));
  },

  /**
   * Live records (not inactive, not the administration account) missing any
   * intake detail HR owes: joining date, department or designation.
   */
  listIncomplete: async (): Promise<EmployeeRow[]> => {
    return db.orm
      .select({ employee: employees })
      .from(employees)
      .leftJoin(orgOwner, eq(orgOwner.employeeId, employees.id))
      .where(
        and(
          ne(employees.status, 'inactive'),
          isNull(orgOwner.employeeId),
          or(
            isNull(employees.dateOfJoining),
            isNull(employees.departmentId),
            isNull(employees.designation),
          ),
        ),
      )
      .orderBy(employees.name)
      .then((rows) => rows.map((r) => r.employee));
  },

  /** The Owner-linked record — the administration account, never deactivated. */
  isOwnerAccount: async (employeeId: string): Promise<boolean> => {
    const rows = await db.orm
      .select({ id: orgOwner.employeeId })
      .from(orgOwner)
      .where(eq(orgOwner.employeeId, employeeId))
      .limit(1);
    return rows.length > 0;
  },

  findById: async (id: string): Promise<EmployeeRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(employees)
      .where(eq(employees.id, id))
      .limit(1);
    return rows[0];
  },

  listDirectReports: async (managerId: string): Promise<EmployeeRow[]> => {
    return db.orm.select().from(employees).where(eq(employees.reportsTo, managerId));
  },

  /** True once a users row exists — the record can no longer be (re)claimed. */
  isClaimed: async (employeeId: string): Promise<boolean> => {
    const rows = await db.orm
      .select({ id: users.id })
      .from(users)
      .where(eq(users.employeeId, employeeId))
      .limit(1);
    return rows.length > 0;
  },

  /** Reissue the claim token (hash only) + audit, one transaction (§10). */
  setClaimToken: async (
    employeeId: string,
    claimTokenHash: string,
    claimTokenExpiresAt: Date,
    actor: ActorContext,
  ): Promise<EmployeeRow | undefined> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(employees)
        .set({ claimTokenHash, claimTokenExpiresAt, updatedAt: new Date() })
        .where(eq(employees.id, employeeId))
        .returning();
      const row = rows[0];
      if (!row) return undefined;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'employee.claim_link_reissued',
        subject: `employees:${employeeId}`,
        detail: JSON.stringify({ expiresAt: claimTokenExpiresAt.toISOString() }),
      });
      return row;
    });
  },

  /**
   * Create the employee, attach the baseline Employee batch (§5.3), and write
   * the audit row — one transaction (§10). A missing Employee batch (seed not
   * run yet) must not block onboarding: the flag lets the caller warn instead.
   */
  insertWithOnboarding: async (
    input: CreateEmployeeInput & {
      name: string;
      claimTokenHash: string;
      claimTokenExpiresAt: Date;
    },
    actor: ActorContext,
  ): Promise<{ row: EmployeeRow; employeeBatchAttached: boolean }> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm.insert(employees).values(input).returning();
      const row = rows[0]!;

      const employeeBatchAttached = await attachEmployeeBatch(
        tx,
        row.id,
        actor.actorEmployeeId,
      );

      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'employee.created',
        subject: `employees:${row.id}`,
        detail: JSON.stringify({
          employeeCode: row.employeeCode,
          email: row.email,
          reportsTo: row.reportsTo,
          employeeBatchAttached,
        }),
      });

      return { row, employeeBatchAttached };
    });
  },

  /**
   * The Admin invite door (D1–D4): auto-generate the next EB-xxxx code, create
   * the record (status `invited`), pre-attach the Employee batch plus every
   * invited batch, and write ONE `employee.invited` audit row — all in a
   * single transaction. Access arrives with the invite; the person fills in
   * their own details after claiming.
   */
  insertInvited: async (
    input: InvitedInsertInput,
    actor: ActorContext,
  ): Promise<{ row: EmployeeRow; employeeBatchAttached: boolean }> =>
    insertInvitedRow(db, input, actor),

  /** Every record with one of these emails (any status) — import's lookups. */
  findByEmails: async (
    emails: string[],
  ): Promise<Array<{ id: string; email: string; status: string }>> => {
    if (emails.length === 0) return [];
    return db.orm
      .select({ id: employees.id, email: employees.email, status: employees.status })
      .from(employees)
      .where(inArray(employees.email, emails));
  },

  /** Department name (lower-cased) -> id, for import's name matching. */
  departmentIdsByName: async (): Promise<Map<string, string>> => {
    const rows = await db.orm
      .select({ id: departments.id, name: departments.name })
      .from(departments);
    return new Map(rows.map((r) => [r.name.trim().toLowerCase(), r.id]));
  },

  /**
   * Bulk import, ALL OR NOTHING: each row goes through the same invited insert
   * as an Admin invite (code numbering, Employee batch, audit) inside one
   * outer transaction — rows must arrive managers-first.
   */
  importInvited: async (
    inputs: Array<{
      input: Omit<InvitedInsertInput, 'reportsTo'>;
      /** An existing record's id, or the email of an EARLIER row in this file. */
      manager: { id: string } | { email: string };
    }>,
    actor: ActorContext,
  ): Promise<EmployeeRow[]> => {
    return db.transaction(async (tx): Promise<EmployeeRow[]> => {
      const created: EmployeeRow[] = [];
      const idByEmail = new Map<string, string>();
      for (const { input, manager } of inputs) {
        const reportsTo = 'id' in manager ? manager.id : idByEmail.get(manager.email);
        if (!reportsTo)
          throw new Error(
            `Import order: manager ${'email' in manager ? manager.email : ''} not created yet`,
          );
        const { row } = await insertInvitedRow(tx, { ...input, reportsTo }, actor);
        idByEmail.set(row.email, row.id);
        created.push(row);
      }
      return created;
    });
  },

  /**
   * True when `targetId` appears in the reports_to chain starting at (and
   * including) `startId` — the no-cycle walk (§2.2, §10). The recursive CTE is
   * the query-shape of `org.in_subtree` (§11.3), walking upward.
   */
  isInReportingChain: async (startId: string, targetId: string): Promise<boolean> => {
    const rows = await db.query<{ found: number }>(
      `WITH RECURSIVE chain AS (
         SELECT id, reports_to FROM org.employees WHERE id = $1
         UNION ALL
         SELECT e.id, e.reports_to FROM org.employees e JOIN chain c ON e.id = c.reports_to
       )
       SELECT 1 AS found FROM chain WHERE id = $2 LIMIT 1`,
      [startId, targetId],
    );
    return rows.length > 0;
  },

  /**
   * HR edit of an org-controlled record + audit row, one transaction (§10,
   * review finding M10). The detail logs WHICH fields changed, never values —
   * a PATCH can move email, RM and status, all of which must be traceable.
   */
  update: async (
    id: string,
    input: UpdateEmployeeInput & { name?: string },
    actor: ActorContext,
  ): Promise<EmployeeRow | undefined> => {
    return db.transaction(async (tx) => {
      // The level before the edit — a change becomes a promotion-history row.
      const before = input.level
        ? (
            await tx.orm
              .select({ level: employees.level })
              .from(employees)
              .where(eq(employees.id, id))
              .for('update')
          )[0]
        : undefined;
      const rows = await tx.orm
        .update(employees)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(employees.id, id))
        .returning();
      const row = rows[0];
      if (!row) return undefined;
      if (before) {
        await recordLevelChange(tx, { employeeId: id, from: before.level, to: row.level }, actor);
      }
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'employee.updated',
        subject: `employees:${id}`,
        detail: JSON.stringify({ fields: Object.keys(input) }),
      });
      // Deactivation ends every session for good: the per-request check
      // already rejects the access token; this stops any refresh.
      if (input.status === 'inactive') {
        await revokeEmployeeRefreshTokens(tx, id, 'deactivated');
      }
      return row;
    });
  },

  /** The me-scoped salary row (§3.1) — gated by pr.payroll.* in the routes. */
  findSalary: async (employeeId: string) => {
    const rows = await db.orm
      .select()
      .from(employeeSalary)
      .where(eq(employeeSalary.employeeId, employeeId))
      .limit(1);
    return rows[0];
  },

  /**
   * Payroll sets or amends the salary row + audit entry, one transaction (§10).
   * The audit detail records WHICH fields changed, never their values — CTC and
   * bank numbers must not leak into the org-readable audit log.
   */
  upsertSalary: async (
    employeeId: string,
    input: UpdateSalaryInput,
    actor: ActorContext,
  ) => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .insert(employeeSalary)
        .values({ employeeId, ...input })
        .onConflictDoUpdate({
          target: employeeSalary.employeeId,
          set: { ...input, updatedAt: new Date() },
        })
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'salary.updated',
        subject: `employees:${employeeId}`,
        detail: JSON.stringify({ fields: Object.keys(input) }),
      });
      return rows[0]!;
    });
  },
});

export type EmployeesRepository = ReturnType<typeof createEmployeesRepository>;
