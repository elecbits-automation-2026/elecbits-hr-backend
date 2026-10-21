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
 */

interface TokenPayload {
  sub: string; // users.id
  employeeId: string;
  email: string;
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
    const state = await createAuthRepository(req.db).sessionState(payload.sub);
    if (!state || !state.isActive || state.employeeStatus === 'inactive') {
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
