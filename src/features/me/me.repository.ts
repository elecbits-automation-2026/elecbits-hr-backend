import { and, desc, eq, ne, or } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import {
  assetCategories,
  assets,
  auditLog,
  batches,
  departments,
  employeeBatches,
  employeeSalary,
  employees,
  exits,
  orgOwner,
  punchZones,
  superadmins,
} from '../../db/schema/index.js';
import type { UpdateMeInput } from './me.schema.js';

/** DB access for the caller's own profile + held batches. */
export const createMeRepository = (db: DbClient) => ({
  findEmployee: async (employeeId: string) => {
    const rows = await db.orm
      .select()
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);
    return rows[0];
  },

  findZone: async (zoneId: string) => {
    const rows = await db.orm
      .select({ id: punchZones.id, name: punchZones.name })
      .from(punchZones)
      .where(eq(punchZones.id, zoneId))
      .limit(1);
    return rows[0];
  },

  findDepartment: async (departmentId: string) => {
    const rows = await db.orm
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .where(eq(departments.id, departmentId))
      .limit(1);
    return rows[0];
  },

  /** The RM as the profile shows them — enough to recognize, nothing more. */
  findManager: async (managerId: string) => {
    const rows = await db.orm
      .select({
        id: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
      })
      .from(employees)
      .where(eq(employees.id, managerId))
      .limit(1);
    return rows[0];
  },

  listBatchNames: async (employeeId: string): Promise<string[]> => {
    const rows = await db.orm
      .select({ name: batches.name })
      .from(employeeBatches)
      .innerJoin(batches, eq(employeeBatches.batchId, batches.id))
      .where(eq(employeeBatches.employeeId, employeeId));
    return rows.map((r) => r.name);
  },

  isOwner: async (employeeId: string): Promise<boolean> => {
    const rows = await db.orm
      .select()
      .from(orgOwner)
      .where(eq(orgOwner.employeeId, employeeId))
      .limit(1);
    return rows.length > 0;
  },

  /**
   * The caller's CHAIN — people who report to them or name them leave
   * approver. SANITIZED on purpose: identity, role and contact only; salary,
   * balances and personal details never leave through this read.
   */
  listTeam: async (employeeId: string) => {
    return db.orm
      .select({
        id: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
        email: employees.email,
        phone: employees.phone,
        designation: employees.designation,
        status: employees.status,
        reportsTo: employees.reportsTo,
        leaveApprover: employees.leaveApprover,
        level: employees.level,
        dateOfJoining: employees.dateOfJoining,
        departmentName: departments.name,
        baseZoneName: punchZones.name,
      })
      .from(employees)
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .leftJoin(punchZones, eq(employees.baseZoneId, punchZones.id))
      .where(
        and(
          or(
            eq(employees.reportsTo, employeeId),
            eq(employees.leaveApprover, employeeId),
          ),
          ne(employees.status, 'inactive'),
        ),
      )
      .orderBy(employees.name);
  },

  /** True when anyone routes to this person as RM or leave approver. */
  hasReports: async (employeeId: string): Promise<boolean> => {
    const rows = await db.query<{ found: number }>(
      `SELECT 1 AS found FROM org.employees
        WHERE (reports_to = $1 OR leave_approver = $1) AND status <> 'inactive'
        LIMIT 1`,
      [employeeId],
    );
    return rows.length > 0;
  },

  isSuperadmin: async (employeeId: string): Promise<boolean> => {
    const rows = await db.orm
      .select()
      .from(superadmins)
      .where(eq(superadmins.employeeId, employeeId))
      .limit(1);
    return rows.length > 0;
  },

  /** Own salary/bank row — me scope; PR reads it via the employees feature. */
  findSalary: async (employeeId: string) => {
    const rows = await db.orm
      .select()
      .from(employeeSalary)
      .where(eq(employeeSalary.employeeId, employeeId))
      .limit(1);
    return rows[0];
  },

  /** Assets currently in the caller's custody (profile "Assigned Assets"). */
  listMyAssets: async (employeeId: string) => {
    return db.orm
      .select({
        id: assets.id,
        assetCode: assets.assetCode,
        name: assets.name,
        category: assetCategories.name,
        status: assets.status,
      })
      .from(assets)
      .innerJoin(assetCategories, eq(assetCategories.id, assets.categoryId))
      .where(eq(assets.holderId, employeeId));
  },

  /** The caller's own exit record, newest first, if any. */
  findMyExit: async (employeeId: string) => {
    const rows = await db.orm
      .select()
      .from(exits)
      .where(eq(exits.employeeId, employeeId))
      .orderBy(desc(exits.createdAt))
      .limit(1);
    return rows[0];
  },

  /** Self-serve edit of own identity fields + audit row, one transaction (§10). */
  updateOwnProfile: async (
    employeeId: string,
    actorUserId: string,
    input: UpdateMeInput & { name?: string },
  ) => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(employees)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(employees.id, employeeId))
        .returning();
      const row = rows[0];
      if (!row) return undefined;
      await tx.orm.insert(auditLog).values({
        actorUserId,
        action: 'me.updated',
        subject: `employees:${employeeId}`,
        detail: JSON.stringify(input),
      });
      return row;
    });
  },
});

export type MeRepository = ReturnType<typeof createMeRepository>;
