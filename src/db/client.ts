import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg, { type Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';

export type Schema = typeof schema;

/**
 * The seam between the application and the database engine.
 *
 * Everything above the data layer depends on this interface, never on Drizzle
 * or `pg` directly. To swap the ORM later, write a new implementation of
 * `DbClient` and change `createDbClient()` — nothing else in the codebase moves.
 *
 *  - `query`        : raw, parameterized SQL escape hatch (fully ORM-agnostic).
 *  - `orm`          : the typed query builder for ergonomic reads/writes.
 *  - `transaction`  : runs work against a single connection with BEGIN/COMMIT.
 */
export interface DbClient {
  /** Typed query builder. Treat as "the current ORM" — the swappable part. */
  readonly orm: NodePgDatabase<Schema>;
  /** Parameterized SQL; returns rows. Never string-concatenate user input. */
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
  /** Run `fn` inside a transaction; the `tx` is itself a DbClient. */
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  /** Liveness probe — `SELECT 1`. */
  healthcheck(): Promise<boolean>;
  /** Drain the pool (call on shutdown / at the end of scripts). */
  close(): Promise<void>;
}

class DrizzlePgClient implements DbClient {
  readonly orm: NodePgDatabase<Schema>;

  constructor(
    private readonly executor: Pool | PoolClient,
    private readonly pool: Pool,
    private readonly inTransaction = false,
  ) {
    this.orm = drizzle(executor as Pool, { schema });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const res = await this.executor.query<T>(text, params as unknown[]);
    return res.rows;
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    // Already inside a transaction: reuse the same connection (no nested BEGIN).
    if (this.inTransaction) return fn(this);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = new DrizzlePgClient(client, this.pool, true);
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async healthcheck(): Promise<boolean> {
    const rows = await this.query<{ ok: number }>('SELECT 1 AS ok');
    return rows[0]?.ok === 1;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Build the application's DbClient. The one place the engine is chosen. */
export function createDbClient(): DbClient {
  const pool = new pg.Pool({
    connectionString: env.databaseUrl,
    ssl: env.ssl,
    max: 20,
    // Fail fast instead of hanging forever when the DB is unreachable
    // (wrong local port now; security-group misconfig on RDS later).
    connectionTimeoutMillis: 10_000,
  });
  return new DrizzlePgClient(pool, pool);
}
