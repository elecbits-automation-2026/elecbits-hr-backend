import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env.js';
import { createAuthRepository } from './auth.repository.js';
import type { ClaimOrgInput, ClaimRecordInput, LoginInput } from './auth.schema.js';
import { createAuthService } from './auth.service.js';
import type { IssuedSession } from './auth.types.js';

/** Composition root: build the auth service with a request-scoped repository. */
const service = (req: Request) =>
  createAuthService({ repo: createAuthRepository(req.db) });

/**
 * The refresh token travels ONLY in this httpOnly cookie — page scripts can
 * never read it — and only to the auth routes (path-scoped).
 */
const REFRESH_COOKIE = 'eb_refresh';
const cookieBase: CookieOptions = {
  httpOnly: true,
  // SameSite=None is only honoured on secure cookies.
  secure: env.isProduction || env.auth.refreshCookieSameSite === 'none',
  sameSite: env.auth.refreshCookieSameSite,
  path: '/api/v1/auth',
};

/** Raw cookie header parse — the one cookie this API reads. */
const readRefreshCookie = (req: Request): string | undefined => {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === REFRESH_COOKIE) return decodeURIComponent(value.join('='));
  }
  return undefined;
};

/** Set the cookie and return the body (access token + user). */
const sendSession = (res: Response, issued: IssuedSession, status = 200): void => {
  res.cookie(REFRESH_COOKIE, issued.refresh.token, {
    ...cookieBase,
    expires: issued.refresh.expiresAt,
  });
  res.status(status).json(issued.session);
};

export const authController = {
  login: async (req: Request, res: Response): Promise<void> => {
    const input: LoginInput = req.body;
    sendSession(res, await service(req).login(input));
  },

  claimRecord: async (req: Request, res: Response): Promise<void> => {
    const input: ClaimRecordInput = req.body;
    const issued = await service(req).claimRecord(input);
    req.log.info({ userId: issued.session.user.id }, 'employee record claimed');
    sendSession(res, issued, 201);
  },

  claimOrg: async (req: Request, res: Response): Promise<void> => {
    const input: ClaimOrgInput = req.body;
    const issued = await service(req).claimOrg(input);
    // The single most consequential event in the system's lifetime (§5.2).
    req.log.info(
      { userId: issued.session.user.id },
      'organization claimed; claim path closed',
    );
    sendSession(res, issued, 201);
  },

  refresh: async (req: Request, res: Response): Promise<void> => {
    try {
      sendSession(res, await service(req).refresh(readRefreshCookie(req)));
    } catch (err) {
      // A dead refresh token should not linger in the browser.
      res.clearCookie(REFRESH_COOKIE, cookieBase);
      throw err;
    }
  },

  logout: async (req: Request, res: Response): Promise<void> => {
    await service(req).logout(readRefreshCookie(req));
    res.clearCookie(REFRESH_COOKIE, cookieBase);
    res.status(204).end();
  },
};
