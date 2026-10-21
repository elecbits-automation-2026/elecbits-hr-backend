import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import createError from 'http-errors';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { hashClaimToken, isCompanyEmail } from '../../shared/helpers/helpers.js';
import type { ClaimOrgInput, ClaimRecordInput, LoginInput } from './auth.schema.js';
import type { AuthRepository } from './auth.repository.js';
import type { IssuedSession, SessionDto, UserRow } from './auth.types.js';

const BCRYPT_ROUNDS = 12;

/**
 * Two tabs can refresh with the same cookie at once; the loser presents a
 * token rotated a moment ago. Within this window that is a race, not theft.
 */
const REUSE_GRACE_MS = 30_000;

const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** 401 that tells the client to sign in again (no retry). */
const sessionEnded = (message = 'Your session has ended — sign in again') =>
  createError(401, message, { code: 'SESSION_ENDED' });

/**
 * Auth rules (§5, §10):
 *  - company email only — outsiders can never sign in;
 *  - the account is active on day one; only EXTRA portal access is ever
 *    pending (§5.4, decision #17);
 *  - the org claim (§5.2) works exactly once, then is permanently closed;
 *  - access tokens are short-lived and carry identity only — grants are
 *    resolved server-side per request so revocation is immediate;
 *  - a rotating refresh token (httpOnly cookie, hash-only in the DB, sliding
 *    env.auth.refreshTtlDays) renews them: single-use, rotated on every
 *    renewal, a replayed old token revokes its whole family (theft), and
 *    logout / deactivation revoke families outright.
 */
export const createAuthService = (deps: { repo: AuthRepository }) => {
  const { repo } = deps;

  const accessSession = (user: UserRow): SessionDto => ({
    accessToken: jwt.sign(
      { sub: user.id, employeeId: user.employeeId, email: user.email },
      env.auth.jwtSecret,
      { expiresIn: env.auth.jwtExpiresIn } as jwt.SignOptions,
    ),
    user: { id: user.id, email: user.email, employeeId: user.employeeId },
  });

  const newRefresh = (userId: string, familyId: string) => {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + env.auth.refreshTtlDays * 86_400_000);
    return { token, row: { userId, familyId, tokenHash: hashToken(token), expiresAt } };
  };

  /** A fresh sign-in: access token + the first refresh token of a new family. */
  const issueSession = async (user: UserRow): Promise<IssuedSession> => {
    const refresh = newRefresh(user.id, randomUUID());
    await repo.insertRefreshToken(refresh.row);
    return {
      session: accessSession(user),
      refresh: { token: refresh.token, expiresAt: refresh.row.expiresAt },
    };
  };

  /** Signed-in and still allowed: users.isActive AND not a deactivated record. */
  const canAct = async (userId: string): Promise<boolean> => {
    const state = await repo.sessionState(userId);
    return state !== undefined && state.isActive && state.employeeStatus !== 'inactive';
  };

  const requireCompanyEmail = (email: string): void => {
    if (!isCompanyEmail(email, env.auth.companyEmailDomain)) {
      throw createError(403, 'Sign-in is restricted to company email addresses', {
        code: 'NOT_COMPANY_EMAIL',
      });
    }
  };

  const login = async (input: LoginInput): Promise<IssuedSession> => {
    requireCompanyEmail(input.email);
    const user = await repo.findUserByEmail(input.email.toLowerCase());
    // Same error for unknown email and wrong password — no account probing.
    const ok = user && (await bcrypt.compare(input.password, user.passwordHash));
    if (!ok || !(await canAct(user.id))) {
      throw createError(401, 'Invalid credentials', { code: 'INVALID_CREDENTIALS' });
    }
    return issueSession(user);
  };

  /** First sign-in: connect to the record HRBP already created (§5.4). */
  const claimRecord = async (input: ClaimRecordInput): Promise<IssuedSession> => {
    requireCompanyEmail(input.email);
    const email = input.email.toLowerCase();

    if (await repo.findUserByEmail(email)) {
      throw createError(409, 'This record is already claimed — sign in instead', {
        code: 'ALREADY_CLAIMED',
      });
    }
    const employee = await repo.findEmployeeByEmail(email);
    if (!employee) {
      // No self-registration: HRBP must have created the record first (§5.4).
      throw createError(404, 'No employee record exists for this email', {
        code: 'RECORD_NOT_FOUND',
      });
    }

    // Claim security: the claimer must present the single-use invite token.
    // Knowing a colleague's email must never be enough to become them.
    if (
      !employee.claimTokenHash ||
      !employee.claimTokenExpiresAt ||
      employee.claimTokenExpiresAt < new Date() ||
      hashClaimToken(input.token) !== employee.claimTokenHash
    ) {
      throw createError(
        403,
        'This invite link is invalid or expired — ask HR for a new one',
        {
          code: 'INVALID_CLAIM_TOKEN',
        },
      );
    }

    // One transaction in the repo: users row + invited -> active + audit (§10).
    const user = await repo.insertUser({
      email,
      passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
      employeeId: employee.id,
    });
    return issueSession(user);
  };

  /** The one-time org claim (§5.2). */
  const claimOrg = async (input: ClaimOrgInput): Promise<IssuedSession> => {
    if (input.email.toLowerCase() !== env.auth.ownerClaimEmail.toLowerCase()) {
      throw createError(403, 'This email cannot claim the organization', {
        code: 'CLAIM_FORBIDDEN',
      });
    }
    if (await repo.ownerExists()) {
      // Permanently closed after the first claim — a leftover setup route must
      // never become a takeover route (§5.2).
      throw createError(410, 'The organization has already been claimed', {
        code: 'CLAIM_CLOSED',
      });
    }
    const user = await repo.createOwner({
      email: input.email.toLowerCase(),
      name: input.name,
      passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
    });
    return issueSession(user);
  };

  /**
   * Renew: trade a live refresh token for a new access token + its rotated
   * successor. Unknown, expired, logged-out or deactivated -> 401. A token
   * rotated more than REUSE_GRACE_MS ago is a replay: the family dies.
   */
  const refresh = async (rawToken: string | undefined): Promise<IssuedSession> => {
    if (!rawToken) throw sessionEnded();
    const row = await repo.findRefreshByHash(hashToken(rawToken));
    if (!row) throw sessionEnded();

    const inGrace =
      row.revokedReason === 'rotated' &&
      row.revokedAt !== null &&
      Date.now() - row.revokedAt.getTime() <= REUSE_GRACE_MS;
    if (row.revokedAt && !inGrace) {
      if (row.revokedReason === 'rotated') await repo.revokeFamily(row.familyId, 'reuse');
      throw sessionEnded();
    }
    if (row.expiresAt < new Date()) throw sessionEnded();

    const user = await repo.findUserById(row.userId);
    if (!user || !(await canAct(user.id))) {
      await repo.revokeFamily(row.familyId, 'deactivated');
      throw sessionEnded();
    }

    const next = newRefresh(user.id, row.familyId);
    // In the grace window (or losing a rotation race) the presented row is
    // already revoked: hand this tab a sibling in the same family instead.
    const rotated = !inGrace && (await repo.rotateRefresh(row.id, next.row));
    if (!rotated) await repo.insertRefreshToken(next.row);
    return {
      session: accessSession(user),
      refresh: { token: next.token, expiresAt: next.row.expiresAt },
    };
  };

  /** Sign out: the presented token's whole family stops working. */
  const logout = async (rawToken: string | undefined): Promise<void> => {
    if (!rawToken) return;
    const row = await repo.findRefreshByHash(hashToken(rawToken));
    if (row) await repo.revokeFamily(row.familyId, 'logout');
  };

  /** The per-request check `authenticate` runs after verifying the JWT. */
  const isSessionLive = canAct;

  return { login, claimRecord, claimOrg, refresh, logout, isSessionLive };
};

export type AuthService = ReturnType<typeof createAuthService>;
