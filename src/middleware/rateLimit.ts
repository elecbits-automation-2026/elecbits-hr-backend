import type { Request, RequestHandler } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import createError from 'http-errors';
import { env } from '../config/env.js';

/**
 * Brute-force guards for the unauthenticated endpoints: password sign-in,
 * record / org claim and the anonymous concern follow-up.
 *
 *  - per IP: every attempt counts (an office shares one public IP, so the cap
 *    is generous — it stops scripted guessing, not a busy Monday morning);
 *  - per email (sign-in only): only FAILED attempts count, so one person's
 *    account can't be guessed at slowly from many IPs.
 *
 * Counters live in process memory: fine for the single API instance today; a
 * second instance would need a shared store (Redis / Postgres).
 *
 * Refusals go through the normal error handler, so the body has the usual
 * `{ error: { message, code } }` shape with code TOO_MANY_ATTEMPTS, plus a
 * standard `RateLimit` / `Retry-After` header.
 */

const { enabled, windowMinutes, perEmail, perIp } = env.auth.rateLimit;
const windowMs = windowMinutes * 60_000;

const tooMany: RequestHandler = (_req, _res, next) => {
  next(
    createError(
      429,
      `Too many attempts — wait ${windowMinutes} minutes and try again, or ask HR for help`,
      { code: 'TOO_MANY_ATTEMPTS' },
    ),
  );
};

const passThrough: RequestHandler = (_req, _res, next) => next();

const ipKey = (req: Request): string => ipKeyGenerator(req.ip ?? 'unknown');

const emailKey = (req: Request): string => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  // No usable email: fall back to the IP so the request is still counted.
  return typeof email === 'string' && email.length > 0
    ? `email:${email.trim().toLowerCase()}`
    : `ip:${ipKey(req)}`;
};

const limiter = (options: {
  limit: number;
  key: (req: Request) => string;
  skipSuccessfulRequests?: boolean;
}): RequestHandler =>
  enabled
    ? rateLimit({
        windowMs,
        limit: options.limit,
        keyGenerator: options.key,
        skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        handler: (req, res, next) => tooMany(req, res, next),
      })
    : passThrough;

/** Per-IP cap shared by every guarded auth route. */
export const authIpLimit = limiter({ limit: perIp, key: ipKey });

/** Failed sign-ins per email address. */
export const loginEmailLimit = limiter({
  limit: perEmail,
  key: emailKey,
  skipSuccessfulRequests: true,
});

/** Claims per email (a valid invite token is still needed; this stops guessing). */
export const claimEmailLimit = limiter({
  limit: perEmail,
  key: emailKey,
  skipSuccessfulRequests: true,
});

/** Anonymous follow-up by code + key: failed lookups per IP. */
export const followUpLimit = limiter({
  limit: Math.max(10, Math.floor(perIp / 5)),
  key: ipKey,
  skipSuccessfulRequests: true,
});
