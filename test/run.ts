/**
 * Test runner: `npm test` (extra args are passed to `node --test`, e.g.
 * `npm test -- --test-name-pattern=leave`).
 *
 * 1. Refuses anything that could be a real database: DATABASE_URL must be set
 *    explicitly, its database name must contain test / e2e / ci, and
 *    NODE_ENV must not be production.
 * 2. Drops and recreates that database, then runs `db:migrate` ONCE on the
 *    empty database (this is the guard for the "migrations fail on a fresh
 *    database" bug), then the seeds in their documented order.
 * 3. Runs every test file under test/ sequentially (they share the database),
 *    each in its own process with the app booted in-process.
 *
 * Pass --no-reset to reuse an already-seeded database (faster local reruns).
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = join(ROOT, 'test');
const SAFE_DB_NAME = /(test|e2e|ci)/i;

const fail = (msg: string): never => {
  process.stderr.write(`\n[test] ${msg}\n`);
  process.exit(1);
};

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  fail(
    'DATABASE_URL is not set. Point it at a THROWAWAY database, e.g.\n' +
      '  DATABASE_URL=postgres://postgres:postgres@localhost:5432/hrms_test npm test',
  );
}
if (process.env.NODE_ENV === 'production')
  fail('Refusing to run with NODE_ENV=production.');
const url = new URL(rawUrl!);
const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
if (!SAFE_DB_NAME.test(dbName)) {
  fail(
    `Database "${dbName}" doesn't look like a test database (name must contain test, e2e or ci).`,
  );
}

// Everything the app and the seeds read. Explicit values win over .env (dotenv
// never overrides), so a developer's .env (RDS host, Gmail, Drive, AI key)
// can't leak into a test run.
const testEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: rawUrl,
  PGSSL: process.env.PGSSL ?? 'false',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
  SCHEDULER_ENABLED: 'false',
  EMAIL_DRIVER: 'log',
  EMAIL_REDIRECT_TO: '',
  STORAGE_DRIVER: 'db',
  GOOGLE_SERVICE_ACCOUNT_KEY: '',
  DRIVE_SHARED_DRIVE_ID: '',
  ANTHROPIC_API_KEY: '',
  ATTENDANCE_DEV_LOOPBACK: 'true',
  // Repeated sign-ins across the suite would trip the login limiter; the one
  // test that checks the limiter turns it back on for its own app instance.
  AUTH_RATE_LIMIT: 'off',
  OWNER_CLAIM_EMAIL: 'admin@elecbits.in',
  COMPANY_EMAIL_DOMAIN: 'elecbits.in',
  JWT_SECRET: process.env.JWT_SECRET ?? 'test-only-secret',
  CORS_ORIGIN: 'http://localhost:5173',
};

const run = (label: string, args: string[]) => {
  process.stdout.write(`[test] ${label}\n`);
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: testEnv,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (res.status !== 0) fail(`${label} failed (exit ${res.status ?? res.signal})`);
};

const resetDatabase = async () => {
  const admin = new URL(rawUrl!);
  admin.pathname = '/postgres';
  const client = new pg.Client({
    connectionString: admin.toString(),
    ssl: testEnv.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  const ident = `"${dbName.replace(/"/g, '""')}"`;
  await client.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [dbName],
  );
  await client.query(`DROP DATABASE IF EXISTS ${ident}`);
  await client.query(`CREATE DATABASE ${ident}`);
  await client.end();
};

const testFiles = (dir: string): string[] =>
  readdirSync(dir)
    .flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return name === 'helpers' ? [] : testFiles(full);
      return name.endsWith('.test.ts') ? [full] : [];
    })
    .sort();

const tsx = ['--import', 'tsx'];
const passThrough = process.argv.slice(2).filter((a) => a !== '--no-reset');

if (!process.argv.includes('--no-reset')) {
  process.stdout.write(`[test] resetting ${dbName}\n`);
  await resetDatabase();
  // One migrate call on the EMPTY database — must succeed in a single run.
  run('db:migrate (empty database, one run)', [...tsx, 'src/scripts/migrate.ts']);
  for (const seed of [
    'seed-modules',
    'seed-batches',
    'seed-policies',
    'seed-asset-categories',
    'seed-test-employees',
  ]) {
    run(seed, [...tsx, `src/scripts/${seed}.ts`]);
  }
}

const files = testFiles(TEST_DIR).map((f) => relative(ROOT, f));
run(`node --test (${files.length} files)`, [
  ...tsx,
  '--test',
  '--test-concurrency=1',
  '--test-reporter=spec',
  ...passThrough,
  ...files,
]);
