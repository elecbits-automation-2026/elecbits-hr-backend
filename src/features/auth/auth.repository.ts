import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import {
  auditLog,
  employees,
  orgOwner,
  refreshTokens,
  users,
} from '../../db/schema/index.js';
import type { UserRow } from './auth.types.js';

export type RefreshTokenRow = typeof refreshTokens.$inferSelect;

/**
 * Revoke every live refresh token of the user behind an employee record —
 * used by deactivation (employees feature) inside ITS transaction, so a
 * deactivated person can never renew a session.
 */
export const revokeEmployeeRefreshTokens = async (
  db: DbClient,
  employeeId: string,
  reason: string,
): Promise<void> => {
  const owners = db.orm
    .select({ id: users.id })
    .from(users)
    .where(eq(users.employeeId, employeeId));
  await db.orm
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(inArray(refreshTokens.userId, owners), isNull(refreshTokens.revokedAt)));
};

/** DB access for auth: identities, the employee link, and the owner singleton. */
export const createAuthRepository = (db: DbClient) => ({
  findUserByEmail: async (email: string): Promise<UserRow | undefined> => {
    const rows = await db.orm.select().from(users).where(eq(users.email, email)).limit(1);
    return rows[0];
  },

  /** The unclaimed employee record a sign-up must attach to (§5.4). */
  findEmployeeByEmail: async (email: string) => {
    const rows = await db.orm
      .select()
      .from(employees)
      .where(eq(employees.email, email))
      .limit(1);
    return rows[0];
  },

  /**
   * Claim the record (§5.4), atomically: create the users row, flip the
   * employee `invited -> active` (already-active rows are left alone), and
   * write the audit entry — any failure rolls all of it back.
   */
  insertUser: async (input: {
    email: string;
    passwordHash: string;
    employeeId: string;
  }): Promise<UserRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm.insert(users).values(input).returning();
      const user = rows[0]!;
      // The invite token is single-use: burn it the moment the claim lands.
      await tx.orm
        .update(employees)
        .set({ claimTokenHash: null, claimTokenExpiresAt: null, updatedAt: new Date() })
        .where(eq(employees.id, input.employeeId));
      await tx.orm
        .update(employees)
        .set({ status: 'active', updatedAt: new Date() })
        .where(and(eq(employees.id, input.employeeId), eq(employees.status, 'invited')));
      await tx.orm.insert(auditLog).values({
        actorUserId: user.id,
        action: 'record.claimed',
        subject: `employees:${input.employeeId}`,
        detail: JSON.stringify({ email: input.email }),
      });
      return user;
    });
  },

  /** True once the org has been claimed — the claim path is then closed (§5.2). */
  ownerExists: async (): Promise<boolean> => {
    const rows = await db.orm.select().from(orgOwner).limit(1);
    return rows.length > 0;
  },

  /**
   * The one-time org claim (§5.2), atomically: the Owner's employee row (root
   * of the reporting tree — no manager), their users row, the org_owner
   * singleton (whose only_row check makes a concurrent second claim fail at
   * the DB), and the audit entry. Any failure rolls the whole claim back.
   */
  createOwner: async (input: {
    email: string;
    name: string;
    passwordHash: string;
  }): Promise<UserRow> => {
    return db.transaction(async (tx) => {
      const [employee] = await tx.orm
        .insert(employees)
        .values({
          name: input.name,
          email: input.email,
          // The Owner predates HR numbering; HRBP can PATCH the code later.
          employeeCode: 'EB-0001',
          level: 'L6',
          reportsTo: null,
          status: 'active',
        })
        .returning();
      const [user] = await tx.orm
        .insert(users)
        .values({
          email: input.email,
          passwordHash: input.passwordHash,
          employeeId: employee!.id,
        })
        .returning();
      await tx.orm.insert(orgOwner).values({ employeeId: employee!.id });
      await tx.orm.insert(auditLog).values({
        actorUserId: user!.id,
        action: 'org.claimed',
        subject: `employees:${employee!.id}`,
        detail: JSON.stringify({ email: input.email }),
      });
      return user!;
    });
  },

  findUserById: async (id: string): Promise<UserRow | undefined> => {
    const rows = await db.orm.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0];
  },

  /**
   * Can this identity still act? Read on EVERY authenticated request, so a
   * deactivation bites on the next call, not when the access token expires.
   */
  sessionState: async (
    userId: string,
  ): Promise<{ isActive: boolean; employeeStatus: string } | undefined> => {
    const rows = await db.orm
      .select({ isActive: users.isActive, employeeStatus: employees.status })
      .from(users)
      .innerJoin(employees, eq(employees.id, users.employeeId))
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0];
  },

  insertRefreshToken: async (input: {
    userId: string;
    familyId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> => {
    await db.orm.insert(refreshTokens).values(input);
  },

  findRefreshByHash: async (tokenHash: string): Promise<RefreshTokenRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);
    return rows[0];
  },

  /**
   * Rotate: revoke the presented row and insert its successor, one
   * transaction. The revoke is conditional on the row still being live, so two
   * racing rotations of the same token can't both succeed — the loser gets
   * false and the service decides (grace window vs reuse).
   */
  rotateRefresh: async (
    presentedId: string,
    next: { userId: string; familyId: string; tokenHash: string; expiresAt: Date },
  ): Promise<boolean> => {
    return db.transaction(async (tx) => {
      const revoked = await tx.orm
        .update(refreshTokens)
        .set({ revokedAt: new Date(), revokedReason: 'rotated' })
        .where(and(eq(refreshTokens.id, presentedId), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });
      if (revoked.length === 0) return false;
      await tx.orm.insert(refreshTokens).values(next);
      return true;
    });
  },

  revokeFamily: async (familyId: string, reason: string): Promise<void> => {
    await db.orm
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  },
});

export type AuthRepository = ReturnType<typeof createAuthRepository>;
