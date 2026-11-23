/**
 * Shared test harness: boots the real Express app in-process on a random port
 * against the test database `test/run.ts` prepared, and gives each test a
 * small HTTP client that signs in as any seeded person (password test1234).
 *
 * Env is read when src/config/env.ts is first imported, so a test file that
 * needs a different setting (the rate-limit test) sets process.env BEFORE
 * calling startApp().
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const PASSWORD = 'test1234';

/** A minimal PDF and PNG that pass the upload magic-byte checks. */
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
export const PNG = Buffer.from(
  '89504E470D0A1A0A0000000D4948445200000001000000010806000000',
  'hex',
);

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
  /** First bytes of a binary body (e.g. "%PDF-"), '' for JSON. */
  head: string;
  bytes: number;
}

export interface CallOptions {
  raw?: Buffer;
  contentType?: string;
  cookie?: string;
  headers?: Record<string, string>;
}

/** Today in IST (the app's business day), as YYYY-MM-DD. */
export const today = (): string =>
  new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

export const addDays = (d: string, k: number): string => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + k);
  return x.toISOString().slice(0, 10);
};

/** The first Monday–Friday on or after d. */
export const weekday = (d: string): string => {
  let x = d;
  for (;;) {
    const dow = new Date(`${x}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return x;
    x = addDays(x, 1);
  }
};

/** YYYY-MM of a date string. */
export const monthOf = (d: string): string => d.slice(0, 7);

export const prevMonth = (d = today()): string => {
  const x = new Date(`${d.slice(0, 7)}-01T00:00:00Z`);
  x.setUTCMonth(x.getUTCMonth() - 1);
  return x.toISOString().slice(0, 7);
};

export const errorCode = (r: Res): string | undefined => r.body?.error?.code;

export interface TestApp {
  base: string;
  call: (
    who: string | null,
    method: string,
    path: string,
    body?: unknown,
    opts?: CallOptions,
  ) => Promise<Res>;
  login: (who: string, password?: string) => Promise<Res>;
  token: (who: string) => Promise<string>;
  /** Employee ids by email local part ("asha.eng" → uuid). */
  ids: Record<string, string>;
  /**
   * Direct SQL on the test database — only to move the clock for a fixture
   * (e.g. a last working day in the past). Assertions go through HTTP.
   */
  sql: <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R[]>;
  stop: () => Promise<void>;
}

const emailOf = (who: string) => (who.includes('@') ? who : `${who}@elecbits.in`);

export const startApp = async (): Promise<TestApp> => {
  const { createApp } = await import('../../src/app.js');
  const { db } = await import('../../src/db/index.js');
  const app = createApp();
  const server: Server = await new Promise((done) => {
    const s = app.listen(0, '127.0.0.1', () => done(s));
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const tokens = new Map<string, string>();

  const send = async (
    method: string,
    path: string,
    body: unknown,
    opts: CallOptions,
    bearer?: string,
  ): Promise<Res> => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (opts.cookie) headers.cookie = opts.cookie;
    let payload: Buffer | string | undefined;
    if (opts.raw) {
      payload = opts.raw;
      headers['content-type'] = opts.contentType ?? 'application/octet-stream';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const url =
      path.startsWith('/api/') || !path.startsWith('/') ? path : `/api/v1${path}`;
    const r = await fetch(`${base}${url.startsWith('/') ? url : `/${url}`}`, {
      method,
      headers,
      body: payload,
    });
    const ct = r.headers.get('content-type') ?? '';
    if (ct.includes('json')) {
      return {
        status: r.status,
        body: await r.json().catch(() => null),
        headers: r.headers,
        head: '',
        bytes: 0,
      };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      status: r.status,
      body: ct.startsWith('text/') ? buf.toString('utf8') : null,
      headers: r.headers,
      head: buf.subarray(0, 8).toString('latin1'),
      bytes: buf.length,
    };
  };

  const login = (who: string, password = PASSWORD) =>
    send('POST', '/auth/login', { email: emailOf(who), password }, {});

  const token = async (who: string): Promise<string> => {
    const email = emailOf(who);
    const cached = tokens.get(email);
    if (cached) return cached;
    const r = await login(email);
    if (r.status !== 200 || !r.body?.accessToken) {
      throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    tokens.set(email, r.body.accessToken);
    return r.body.accessToken;
  };

  const call: TestApp['call'] = async (who, method, path, body, opts = {}) =>
    send(method, path, body, opts, who ? await token(who) : undefined);

  const people = await call('admin', 'GET', '/employees');
  if (people.status !== 200) throw new Error(`GET /employees failed: ${people.status}`);
  const list: Array<{ id: string; email: string }> = Array.isArray(people.body)
    ? people.body
    : (people.body?.items ?? []);
  const ids = Object.fromEntries(list.map((p) => [p.email.split('@')[0]!, p.id]));

  const stop = async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await db.close();
  };

  const sql: TestApp['sql'] = (text, params = []) => db.query(text, params) as never;

  return { base, call, login, token, ids, sql, stop };
};

/** Extract the refresh cookie ("name=value") from a response. */
export const refreshCookie = (r: Res): string =>
  (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
