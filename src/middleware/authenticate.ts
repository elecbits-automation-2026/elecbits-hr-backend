import type { RequestHandler } from 'express';
import createError from 'http-errors';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { createAuthRepository } from '../features/auth/auth.repository.js';

/**
 * Authentication middleware (local JWT — no Supabase / external IdP).
 *
 * Verifies the `Authorization: Bearer <token>` header and attaches the caller
 * as `req.auth`. The token carries IDENTITY only (userId, employeeId, email) —
 * never grants. Grants are resolved server-side per request by `requireAccess`
 * so a revoked permission takes effect immediately (design doc §10), which is
 * also why tokens stay short-lived.
 *
 * After the signature check, the identity's state is read from the DB on
 * EVERY request (refinement plan X1): a deactivated user or employee record
 * is turned away on their very next call, not when the token expires.
 *
 * The token's `sid` names the sign-in (refresh family) it came from. Once
 * that sign-in is ended — sign-out, deactivation, a replayed refresh token —
 * the token stops working at once, so signing out in one tab ends the other
 * tabs too. Tokens minted before `sid` existed simply expire as before.
 */

interface TokenPayload {
  sub: string; // users.id
  employeeId: string;
  email: string;
  sid?: string; // refresh_tokens.family_id of the sign-in
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(createError(401, 'Missing bearer token', { code: 'UNAUTHENTICATED' }));
  }

  let payload: TokenPayload;
  try {
    payload = jwt.verify(header.slice(7), env.auth.jwtSecret) as TokenPayload;
  } catch {
    return next(
      createError(401, 'Invalid or expired token', { code: 'UNAUTHENTICATED' }),
    );
  }

  try {
    const repo = createAuthRepository(req.db);
    const [state, ended] = await Promise.all([
      repo.sessionState(payload.sub),
      payload.sid ? repo.isFamilyEnded(payload.sid) : Promise.resolve(false),
    ]);
    if (!state || !state.isActive || state.employeeStatus === 'inactive' || ended) {
      return next(
        createError(401, 'Your session has ended — sign in again', {
          code: 'SESSION_ENDED',
        }),
      );
    }
  } catch (err) {
    return next(err);
  }

  req.auth = {
    userId: payload.sub,
    employeeId: payload.employeeId,
    email: payload.email,
  };
  next();
};
