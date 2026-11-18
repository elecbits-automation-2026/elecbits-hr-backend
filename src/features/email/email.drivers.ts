import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import type { Env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/** One fully rendered email, ready for a driver. */
export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** A way to deliver mail. Throws on failure — the sender records and retries. */
export interface EmailDriver {
  name: 'log' | 'gmail';
  send: (email: OutgoingEmail) => Promise<void>;
}

/** Development default: the email goes to the server log, nothing leaves. */
export const createLogDriver = (): EmailDriver => ({
  name: 'log',
  send: async (email) => {
    logger.info(
      { to: email.to, subject: email.subject, text: email.text },
      'email (log driver — not sent)',
    );
  },
});

// --- Gmail --------------------------------------------------------------------

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** The key is the JSON itself or a path to the file (env GOOGLE_SERVICE_ACCOUNT_KEY). */
const loadKey = (raw: string): ServiceAccountKey => {
  const json = raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8');
  const key = JSON.parse(json) as Partial<ServiceAccountKey>;
  if (!key.client_email || !key.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not a service-account key');
  }
  return key as ServiceAccountKey;
};

/** Header values never carry a line break (no header injection). */
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();

/** RFC 2047 — non-ASCII subjects and names survive every mail client. */
const encodeWord = (s: string): string =>
  /^[\x20-\x7e]*$/.test(s)
    ? s
    : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

const base64Lines = (s: string): string =>
  Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n');

/** A multipart/alternative message (plain text + HTML), as Gmail's `raw` wants. */
export const buildMime = (
  email: OutgoingEmail,
  from: { address: string; name: string },
  replyTo: string | null,
): string => {
  const boundary = `b_${randomUUID()}`;
  const headers = [
    `From: ${encodeWord(oneLine(from.name))} <${oneLine(from.address)}>`,
    `To: ${oneLine(email.to)}`,
    ...(replyTo ? [`Reply-To: ${oneLine(replyTo)}`] : []),
    `Subject: ${encodeWord(oneLine(email.subject))}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset=UTF-8`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(body),
    ].join('\r\n');
  return [
    ...headers,
    '',
    part('text/plain', email.text),
    part('text/html', email.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
};

/**
 * Gmail API as EMAIL_FROM: the service account signs a JWT that impersonates
 * the sender mailbox (domain-wide delegation, gmail.send only), trades it for
 * an access token (cached until shortly before it expires), and posts the
 * raw message. No Google SDK — one token call and one send call.
 */
export const createGmailDriver = (config: Env['email']): EmailDriver => {
  if (!config.serviceAccountKey) {
    throw new Error('EMAIL_DRIVER=gmail needs GOOGLE_SERVICE_ACCOUNT_KEY');
  }
  const key = loadKey(config.serviceAccountKey);
  const tokenUri = key.token_uri ?? 'https://oauth2.googleapis.com/token';
  let cached: { token: string; expiresAt: number } | null = null;

  const accessToken = async (): Promise<string> => {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const assertion = jwt.sign({ scope: GMAIL_SCOPE }, key.private_key, {
      algorithm: 'RS256',
      issuer: key.client_email,
      subject: config.from,
      audience: tokenUri,
      expiresIn: 3600,
    });
    const res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !data.access_token) {
      // Google's own error text (e.g. unauthorized_client = delegation not set up) — no secrets in it.
      throw new Error(
        `Google sign-in failed (${res.status}): ${data.error ?? ''} ${data.error_description ?? ''}`.trim(),
      );
    }
    cached = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    return cached.token;
  };

  return {
    name: 'gmail',
    send: async (email) => {
      const raw = Buffer.from(
        buildMime(email, { address: config.from, name: config.fromName }, config.replyTo),
        'utf8',
      ).toString('base64url');
      const res = await fetch(GMAIL_SEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      });
      if (!res.ok) {
        if (res.status === 401) cached = null;
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(
          `Gmail refused the email (${res.status}): ${body.error?.message ?? ''}`.trim(),
        );
      }
    },
  };
};

/** The driver EMAIL_DRIVER names — built once per process. */
let shared: EmailDriver | null = null;
export const driverFor = (config: Env['email']): EmailDriver => {
  shared ??= config.driver === 'gmail' ? createGmailDriver(config) : createLogDriver();
  return shared;
};
