import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * CLI: apply pending Drizzle migrations against the configured database.
 *   npm run db:migrate
 *
 * Migrations are generated from the schema with `npm run db:generate` and live
 * in ./migrations (alongside Drizzle's meta journal). Applying them is wrapped
 * in a Postgres advisory lock so that when several app instances boot at once,
 * only one runs the migrations and the rest wait.
 */

// dist/scripts/migrate.js -> ../../migrations === <app root>/migrations
const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

// Arbitrary but fixed key so every instance contends for the same lock.
const MIGRATION_LOCK_KEY = 7_310_042;

async function main() {
  const pool = new pg.Pool({
    connectionString: env.databaseUrl,
    ssl: env.ssl,
    max: 2,
    connectionTimeoutMillis: 10_000,
  });

  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    // Count the bookkeeping rows either side of the run and report the
    // difference — `migrate()` returns nothing, and silently skipping is a
    // real outcome, so say which happened.
    const countApplied = async (): Promise<number> => {
      const { rows } = await lock.query<{ n: string }>(
        `SELECT count(*) AS n FROM drizzle.__drizzle_migrations`,
      );
      return Number(rows[0]?.n ?? 0);
    };
    // Zero before the very first run, when the schema does not exist yet.
    const before = await countApplied().catch(() => 0);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
    const after = await countApplied();

    if (after > before) {
      logger.info({ applied: after - before, total: after }, 'Migrations applied');
    } else {
      logger.info({ total: after }, 'No migrations to apply');
    }
  } finally {
    await lock
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => {});
    lock.release();
    await pool.end();
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'Migration failed');
  process.exit(1);
});
