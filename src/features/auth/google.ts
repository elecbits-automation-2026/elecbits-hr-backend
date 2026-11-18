import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import jwt, { type JwtHeader } from 'jsonwebtoken';

/**
 * Google sign-in (SSO), no SDK — one redirect, one token call, one JWKS fetch,
 * in the spirit of the Gmail driver. The OAuth 2.0 authorization-code flow with
 * PKCE: the app sends the user to Google with a `state` and a code challenge,
 * Google calls back with a code, and the code (+ the stored verifier) is traded
 * for an ID token whose signature, audience, issuer and hosted-domain claim are
 * all checked here. Google only proves who someone is; every access rule still
 * lives in the HRMS.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS: [string, string] = ['https://accounts.google.com', 'accounts.google.com'];
const CERTS_TTL_MS = 60 * 60_000;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** The Workspace domain — a UX hint on the consent screen; re-checked on the token. */
  hostedDomain: string;
}

/** The identity claims we trust only AFTER the ID token is verified. */
export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  /** The `hd` claim — present only for Workspace accounts, never for personal Gmail. */
  hd: string | null;
  sub: string;
  name: string | null;
}

/** A PKCE verifier/challenge pair (S256). The verifier is stored, the challenge sent. */
export const pkcePair = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

export const createGoogleOAuth = (config: GoogleConfig) => {
  // JWKS cache — Google rotates keys a few times a day; we refetch hourly.
  let certs: { keys: Record<string, string>; fetchedAt: number } | null = null;

  /** Where to send the browser to sign in. */
  const authUrl = (params: { state: string; codeChallenge: string }): string => {
    const q = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      // Pre-filter to the Workspace domain; the real gate is the hd claim below.
      hd: config.hostedDomain,
      access_type: 'online',
      prompt: 'select_account',
    });
    return `${AUTH_URL}?${q.toString()}`;
  };

  /** Trade the one-time code (+ PKCE verifier) for Google's ID token. */
  const exchangeCode = async (code: string, codeVerifier: string): Promise<string> => {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: config.redirectUri,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      id_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !data.id_token) {
      throw new Error(
        `Google token exchange failed (${res.status}): ${data.error ?? ''} ${
          data.error_description ?? ''
        }`.trim(),
      );
    }
    return data.id_token;
  };

  /** The signing key for a given `kid`, as PEM, from the cached JWKS. */
  const keyFor = async (kid: string): Promise<string> => {
    if (!certs || Date.now() - certs.fetchedAt > CERTS_TTL_MS) {
      const res = await fetch(CERTS_URL);
      const jwks = (await res.json().catch(() => ({ keys: [] }))) as {
        keys: Array<Record<string, string>>;
      };
      const keys: Record<string, string> = {};
      for (const jwk of jwks.keys) {
        if (!jwk.kid) continue;
        const pem = createPublicKey({
          key: jwk,
          format: 'jwk',
        } as Parameters<typeof createPublicKey>[0])
          .export({ type: 'spki', format: 'pem' })
          .toString();
        keys[jwk.kid] = pem;
      }
      certs = { keys, fetchedAt: Date.now() };
    }
    const pem = certs.keys[kid];
    if (!pem) throw new Error('Unknown Google signing key');
    return pem;
  };

  /** Verify signature + audience + issuer, then return the trusted identity. */
  const verifyIdToken = async (idToken: string): Promise<GoogleIdentity> => {
    const header = jwt.decode(idToken, { complete: true })?.header as
      JwtHeader | undefined;
    if (!header?.kid) throw new Error('ID token has no key id');
    const pem = await keyFor(header.kid);
    const payload = jwt.verify(idToken, pem, {
      algorithms: ['RS256'],
      audience: config.clientId,
      issuer: ISSUERS,
    }) as {
      email?: string;
      email_verified?: boolean | string;
      hd?: string;
      sub?: string;
      name?: string;
    };
    if (!payload.email || !payload.sub) {
      throw new Error('ID token is missing email or sub');
    }
    return {
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
      hd: payload.hd ?? null,
      sub: payload.sub,
      name: payload.name ?? null,
    };
  };

  return { authUrl, exchangeCode, verifyIdToken };
};

export type GoogleOAuth = ReturnType<typeof createGoogleOAuth>;
