import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';

/**
 * Google Drive REST client, no SDK — one token call, then plain file calls, in
 * the spirit of the Gmail driver. The service account acts as ITSELF here (it
 * is a Content manager on the company Shared Drive), so there is no
 * domain-wide impersonation — the JWT carries no `subject`. Scope is full
 * `drive` because the robot both writes and reads files it owns on the Shared
 * Drive. Every call sets supportsAllDrives — a Shared Drive is not "My Drive".
 */

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveConfig {
  /** The service-account JSON key: the JSON itself, or a path to the file. */
  serviceAccountKey: string;
  /** The Shared Drive id (its own id is also its root folder id). */
  sharedDriveId: string;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const loadKey = (raw: string): ServiceAccountKey => {
  const json = raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8');
  const key = JSON.parse(json) as Partial<ServiceAccountKey>;
  if (!key.client_email || !key.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not a service-account key');
  }
  return key as ServiceAccountKey;
};

/** Drive query strings are single-quoted; a name with a quote would break them. */
const escapeQuery = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export interface StoredObject {
  data: Buffer;
  contentType: string | null;
}

export const createDriveClient = (config: DriveConfig) => {
  const key = loadKey(config.serviceAccountKey);
  const tokenUri = key.token_uri ?? 'https://oauth2.googleapis.com/token';
  let cached: { token: string; expiresAt: number } | null = null;
  // Folder ids are stable; resolve each subfolder name once per process.
  const folderIds = new Map<string, Promise<string>>();

  const accessToken = async (): Promise<string> => {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const assertion = jwt.sign({ scope: DRIVE_SCOPE }, key.private_key, {
      algorithm: 'RS256',
      issuer: key.client_email,
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
      throw new Error(
        `Google sign-in failed (${res.status}): ${data.error ?? ''} ${
          data.error_description ?? ''
        }`.trim(),
      );
    }
    cached = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    return cached.token;
  };

  const authed = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const res = await fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${await accessToken()}` },
    });
    if (res.status === 401) cached = null;
    return res;
  };

  /** A subfolder of the Shared Drive root, found or created once and cached. */
  const ensureFolder = (name: string): Promise<string> => {
    const existing = folderIds.get(name);
    if (existing) return existing;
    const resolve = (async (): Promise<string> => {
      const q =
        `name = '${escapeQuery(name)}' and mimeType = '${FOLDER_MIME}' ` +
        `and '${config.sharedDriveId}' in parents and trashed = false`;
      const listUrl =
        `${FILES_URL}?q=${encodeURIComponent(q)}&corpora=drive` +
        `&driveId=${config.sharedDriveId}&includeItemsFromAllDrives=true` +
        `&supportsAllDrives=true&fields=files(id)`;
      const found = (await (await authed(listUrl)).json().catch(() => ({}))) as {
        files?: Array<{ id: string }>;
      };
      if (found.files?.[0]) return found.files[0].id;

      const res = await authed(`${FILES_URL}?supportsAllDrives=true&fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          mimeType: FOLDER_MIME,
          parents: [config.sharedDriveId],
        }),
      });
      const made = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: unknown;
      };
      if (!res.ok || !made.id) {
        throw new Error(`Drive folder "${name}" could not be created (${res.status})`);
      }
      return made.id;
    })();
    folderIds.set(name, resolve);
    // A failed lookup must not be cached as the answer forever.
    resolve.catch(() => folderIds.delete(name));
    return resolve;
  };

  /** Upload bytes into a named subfolder; returns the new Drive file id. */
  const upload = async (input: {
    folder: string;
    fileName: string;
    contentType: string;
    data: Buffer;
  }): Promise<string> => {
    const folderId = await ensureFolder(input.folder);
    const boundary = `b_${randomUUID()}`;
    const metadata = JSON.stringify({ name: input.fileName, parents: [folderId] });
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Type: ${input.contentType || 'application/octet-stream'}\r\n\r\n`,
      ),
      input.data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await authed(
      `${UPLOAD_URL}?uploadType=multipart&supportsAllDrives=true&fields=id`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    const made = (await res.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };
    if (!res.ok || !made.id) {
      throw new Error(
        `Drive upload failed (${res.status}): ${made.error?.message ?? ''}`.trim(),
      );
    }
    return made.id;
  };

  /** Download a file's bytes by id. */
  const download = async (fileId: string): Promise<StoredObject> => {
    const res = await authed(
      `${FILES_URL}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    );
    if (!res.ok) {
      throw new Error(`Drive download failed (${res.status}) for ${fileId}`);
    }
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type'),
    };
  };

  /** Move a file to the Shared Drive trash (recoverable; not a hard delete). */
  const trash = async (fileId: string): Promise<void> => {
    const res = await authed(
      `${FILES_URL}/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Drive trash failed (${res.status}) for ${fileId}`);
    }
  };

  return { ensureFolder, upload, download, trash };
};

export type DriveClient = ReturnType<typeof createDriveClient>;
