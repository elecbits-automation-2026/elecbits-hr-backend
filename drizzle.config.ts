import { readFileSync } from 'node:fs';
import { defineConfig, type Config } from 'drizzle-kit';
import 'dotenv/config';

/**
 * drizzle-kit does not load `.env` or interpolate JSON placeholders, so the
 * credentials are resolved here in TS. Local dev talks to a plain Postgres;
 * SSL (PGSSL / PGSSL_CA) is only for the AWS RDS instance later.
 */

function ssl(): boolean | { rejectUnauthorized: boolean; ca?: string } {
  const raw = process.env.PGSSL;
  const enabled =
    raw !== undefined && ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
  if (!enabled) return false;
  const caPath = process.env.PGSSL_CA;
  if (caPath) {
    return { rejectUnauthorized: true, ca: readFileSync(caPath, 'utf8') };
  }
  return { rejectUnauthorized: false };
}

function dbCredentials(): Config['dbCredentials'] {
  if (process.env.DATABASE_URL) {
    return { url: process.env.DATABASE_URL, ssl: ssl() };
  }

  const host = process.env.PGHOST;
  const database = process.env.PGDATABASE;
  const user = process.env.PGUSER;
  const password = process.env.PGPASSWORD;
  if (!host || !database || !user || password === undefined) {
    throw new Error(
      'Set DATABASE_URL or PGHOST, PGPORT, PGDATABASE, PGUSER, and PGPASSWORD',
    );
  }

  return {
    host,
    port: Number(process.env.PGPORT ?? 5432),
    user,
    password,
    database,
    ssl: ssl(),
  };
}

export default defineConfig({
  schema: './src/db/schema/index.ts',
  // MUST match the folder src/scripts/migrate.ts applies from (`./migrations`).
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: dbCredentials(),
});
