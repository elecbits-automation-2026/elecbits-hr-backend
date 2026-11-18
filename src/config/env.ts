import 'dotenv/config';
import { readFileSync } from 'node:fs';

// ONE company timezone (user decision): all server-local date math — the
// attendance "today", late/early punctuality, payroll month boundaries —
// runs in IST even on UTC cloud hosts. Set before any Date is created.
process.env.TZ ??= 'Asia/Kolkata';

/**
 * Centralised, validated access to environment variables.
 * Everything that reads from `process.env` goes through here so the rest of
 * the codebase stays free of stringly-typed env lookups.
 */
function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function bool(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/** Parse a comma-separated env var into a trimmed, non-empty list. */
function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';

/**
 * Express `trust proxy` setting. Matters once the app sits behind an ALB in
 * production; locally there is no proxy so the default is `false`.
 */
function resolveTrustProxy(): boolean | number {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '') return isProduction ? 1 : false;
  if (raw.toLowerCase() === 'true') return true;
  if (raw.toLowerCase() === 'false') return false;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`TRUST_PROXY must be a number or true/false, got "${raw}"`);
  }
  return n;
}

/**
 * Build a Postgres connection string. Prefer DATABASE_URL; otherwise assemble
 * one from the discrete PG* parts so RDS credentials can come from Secrets
 * Manager / SSM as individual values once DevOps provisions the server.
 */
function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const host = required('PGHOST');
  const port = required('PGPORT');
  const database = required('PGDATABASE');
  const user = required('PGUSER');
  const password = required('PGPASSWORD');

  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(
    password,
  )}@${host}:${port}/${database}`;
}

/**
 * Build the `pg` SSL option. Local dev runs without TLS; AWS RDS requires it.
 *  - PGSSL=false            -> no SSL (local dev).
 *  - PGSSL_CA set           -> verify against the RDS global CA bundle (correct).
 *  - PGSSL=true, no CA      -> encrypt but skip cert verification (quick trial only).
 */
type SslConfig = false | { rejectUnauthorized: boolean; ca?: string };

function resolveSsl(): SslConfig {
  if (!bool('PGSSL', false)) return false;

  const caPath = process.env.PGSSL_CA;
  if (caPath) {
    return { rejectUnauthorized: true, ca: readFileSync(caPath, 'utf8') };
  }
  return { rejectUnauthorized: false };
}

export const env = {
  nodeEnv,
  isProduction,
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: resolveDatabaseUrl(),
  // SSL/TLS connection config for PostgreSQL (AWS RDS in prod, off locally).
  ssl: resolveSsl(),
  // Pino level. Default: quieter in prod, chatty in dev.
  logLevel: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),

  // --- HTTP hardening -------------------------------------------------------
  trustProxy: resolveTrustProxy(),
  // Max JSON request body. Keeps a malicious client from exhausting memory.
  bodyLimit: process.env.BODY_LIMIT ?? '100kb',
  // Allowed CORS origins (comma-separated). Empty => no cross-origin in prod,
  // reflect-any in development. Never use a wildcard with credentials.
  corsOrigins: list('CORS_ORIGIN'),

  // --- Auth (local JWT; deliberately no Supabase / external IdP) ------------
  // Grants are checked server-side on every request, not cached into the token,
  // so revocation takes effect immediately (design doc §10). Keep tokens short.
  auth: {
    jwtSecret: required('JWT_SECRET', isProduction ? undefined : 'dev-only-secret'),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
    // Rotating refresh token (httpOnly cookie): sliding lifetime in days —
    // every renewal starts a fresh window; idle this long and you sign in again.
    refreshTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7),
    // 'lax' works while the app and API share a site (localhost ports, or
    // app./api. subdomains); a cross-site deploy needs 'none' (+ HTTPS).
    refreshCookieSameSite: (process.env.REFRESH_COOKIE_SAMESITE ?? 'lax') as
      'lax' | 'strict' | 'none',
    // Company-email-only sign-in blocks outsiders entirely (§5.4).
    companyEmailDomain: required('COMPANY_EMAIL_DOMAIN', 'elecbits.in'),
    // The only email that may claim the org as Owner, once (§5.2).
    ownerClaimEmail: required('OWNER_CLAIM_EMAIL', 'admin@elecbits.in'),
  },

  // --- App ------------------------------------------------------------------
  // Frontend base URL, used to build links in notifications later.
  appUrl: required('APP_URL', 'http://localhost:5173'),

  // --- AI (optional) --------------------------------------------------------
  // Work-update scoring. No key = scoring quietly off: updates store with a
  // NULL score ("unscored"), never a fabricated number (load-bearing rule).
  ai: {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
  },

  // --- Email ------------------------------------------------------------------
  // Outbox sender (email service). `log` writes each email to the server log
  // and sends nothing — the default until Workspace credentials exist; `gmail`
  // sends through the Gmail API as EMAIL_FROM via a service account with
  // domain-wide delegation (scope gmail.send only). The Admin switch
  // (settings email.delivery) must ALSO be on before anything leaves.
  email: {
    driver: (process.env.EMAIL_DRIVER ?? 'log') as 'log' | 'gmail',
    from: process.env.EMAIL_FROM ?? 'no-reply@elecbits.in',
    fromName: process.env.EMAIL_FROM_NAME ?? 'Elecbits HR',
    replyTo: process.env.EMAIL_REPLY_TO || null,
    // Testing safety net: when set, EVERY email goes to this one address
    // instead (the real recipient is named in the subject).
    redirectTo: process.env.EMAIL_REDIRECT_TO || null,
    // The service account's JSON key — the whole JSON, or a path to the file.
    serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || null,
  },

  // --- Google sign-in (SSO) ---------------------------------------------------
  // OAuth 2.0 (auth code + PKCE). Google only proves identity; access still
  // needs a claimed, active HR record. No client id/secret => SSO is simply
  // unavailable (the password form stays the way in), so the app runs without
  // Workspace credentials.
  google: {
    oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || null,
    oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || null,
    oauthRedirectUri:
      process.env.GOOGLE_OAUTH_REDIRECT_URI ??
      'http://localhost:4000/api/v1/auth/google/callback',
    // The service-account JSON key (JSON itself or a path) — shared by the
    // Gmail sender and Drive storage. The same robot account does both.
    serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || null,
    // The company-owned Shared Drive that holds HR files (its id from the URL).
    driveSharedDriveId: process.env.DRIVE_SHARED_DRIVE_ID || null,
  },

  // --- File storage -----------------------------------------------------------
  // Where uploaded HR files live. `db` keeps the bytes in Postgres (today's
  // behaviour); `drive` stores them in the company Shared Drive and keeps only
  // a file id in the row. `drive` needs google.serviceAccountKey +
  // driveSharedDriveId, so the app falls back to `db` until those exist.
  storage: {
    driver: (process.env.STORAGE_DRIVER ?? 'db') as 'db' | 'drive',
  },

  // --- Attendance -----------------------------------------------------------
  attendance: {
    // GEO policy, ONE radius from the office point: inside -> clean `office`
    // punch; beyond / no location -> punch BLOCKED unless an approved
    // remote-work request covers the day (those punch as `remote`).
    officeLat: process.env.OFFICE_LAT ? Number(process.env.OFFICE_LAT) : null,
    officeLng: process.env.OFFICE_LNG ? Number(process.env.OFFICE_LNG) : null,
    officeRadiusMeters: Number(process.env.OFFICE_RADIUS_M ?? 250),
    // Official workday, for the punctuality dots: late past workStart,
    // early before workEnd, with a grace band in between.
    workStart: process.env.WORK_START ?? '09:30',
    workEnd: process.env.WORK_END ?? '18:30',
    graceMinutes: Number(process.env.WORK_GRACE_MIN ?? 15),
    // Testing shortcut, off unless asked for: a punch from this machine
    // (loopback) with NO location counts as inside a zone. Never in production.
    devLoopbackInZone: !isProduction && process.env.ATTENDANCE_DEV_LOOPBACK === 'true',
  },

  // --- Background jobs ------------------------------------------------------
  scheduler: {
    // In-process scheduler (reminders). On by default; set
    // SCHEDULER_ENABLED=false on a second instance or for one-off scripts —
    // the job-run table still guarantees each daily run happens once.
    enabled: (process.env.SCHEDULER_ENABLED ?? 'true').toLowerCase() !== 'false',
    // Local time (company timezone) the daily jobs become due.
    dailyAt: process.env.SCHEDULER_DAILY_AT ?? '09:30',
  },
} as const;

export type Env = typeof env;
