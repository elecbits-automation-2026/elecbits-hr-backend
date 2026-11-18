import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env.js';
import { createAuthRepository } from './auth.repository.js';
import type { ClaimOrgInput, ClaimRecordInput, LoginInput } from './auth.schema.js';
import { createAuthService } from './auth.service.js';
import { createGoogleOAuth, type GoogleOAuth } from './google.js';
import type { IssuedSession } from './auth.types.js';

/**
 * The Google client is built ONCE (not per request) so its JWKS cache lives
 * across sign-ins. No client id/secret => null => SSO routes answer 503 and the
 * password form stays the only way in.
 */
const googleClient: GoogleOAuth | null =
  env.google.oauthClientId && env.google.oauthClientSecret
    ? createGoogleOAuth({
        clientId: env.google.oauthClientId,
        clientSecret: env.google.oauthClientSecret,
        redirectUri: env.google.oauthRedirectUri,
        hostedDomain: env.auth.companyEmailDomain,
      })
    : null;

/** Composition root: build the auth service with a request-scoped repository. */
const service = (req: Request) =>
  createAuthService({ repo: createAuthRepository(req.db), google: googleClient });

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

/** The SPA's sign-in page (its AUTH_ROUTE), where Google sign-in lands either way. */
const loginPage = (query: string): string => `${env.appUrl}/auth?${query}`;

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

  /**
   * Start: 302 the browser to Google's consent screen. This is a full-page
   * navigation, so a failure (SSO not configured) goes back to the login page
   * with its code rather than leaving the user on a bare JSON error.
   */
  googleStart: async (req: Request, res: Response): Promise<void> => {
    try {
      res.redirect(302, await service(req).googleStart());
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'OAUTH_FAILED';
      req.log.warn({ code, err }, 'Google sign-in could not start');
      res.redirect(302, loginPage(`error=${encodeURIComponent(code)}`));
    }
  },

  /**
   * Callback: Google redirects here. On success we set the same refresh cookie
   * as any sign-in and bounce the browser back to the SPA's login page, which
   * then calls /auth/refresh to pick up its access token — the token never
   * rides in a URL. On any failure it lands there with a short error code.
   */
  googleCallback: async (req: Request, res: Response): Promise<void> => {
    const q = req.query as { state?: string; code?: string; error?: string };
    if (q.error) {
      res.redirect(302, loginPage(`error=${encodeURIComponent(q.error)}`));
      return;
    }
    try {
      const issued = await service(req).googleCallback({ state: q.state, code: q.code });
      res.cookie(REFRESH_COOKIE, issued.refresh.token, {
        ...cookieBase,
        expires: issued.refresh.expiresAt,
      });
      req.log.info({ userId: issued.session.user.id }, 'signed in with Google');
      res.redirect(302, loginPage('google=done'));
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'OAUTH_FAILED';
      req.log.warn({ code, err }, 'Google sign-in rejected');
      res.redirect(302, loginPage(`error=${encodeURIComponent(code)}`));
    }
  },
};
