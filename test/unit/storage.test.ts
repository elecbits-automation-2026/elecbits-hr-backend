/**
 * M10: storage driver selection and the Drive client's upload check, with a
 * fake Drive — no network, no Google credentials.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { createDriveClient } from '../../src/features/storage/drive.js';
import { fileColumns } from '../../src/features/storage/files.js';
import { createFileStorage, type DriveClient } from '../../src/features/storage/index.js';

const fakeDrive = () => {
  const files = new Map<string, Buffer>();
  const trashed: string[] = [];
  let n = 0;
  const drive = {
    ensureFolder: async (name: string) => `folder-${name}`,
    upload: async (input: { data: Buffer }) => {
      n += 1;
      files.set(`drv-${n}`, input.data);
      return `drv-${n}`;
    },
    download: async (id: string) => ({
      data: files.get(id)!,
      contentType: 'application/pdf',
    }),
    trash: async (id: string) => {
      trashed.push(id);
    },
  } as unknown as DriveClient;
  return { drive, files, trashed };
};

const pdf = Buffer.from('%PDF-1.4 test');

describe('createFileStorage', () => {
  it('db driver keeps bytes in the row', async () => {
    const s = createFileStorage({ driver: 'db', drive: null });
    const ref = await s.put({
      folder: 'Claims',
      fileName: 'r.pdf',
      contentType: 'application/pdf',
      data: pdf,
    });
    assert.deepEqual(ref, { driveFileId: null, inlineData: pdf });
    assert.equal(s.usesDrive, false);
    assert.deepEqual(await s.get(ref), pdf);
  });

  it('drive driver keeps only the Drive id and reads it back', async () => {
    const { drive } = fakeDrive();
    const s = createFileStorage({ driver: 'drive', drive });
    const ref = await s.put({
      folder: 'Claims',
      fileName: 'r.pdf',
      contentType: 'application/pdf',
      data: pdf,
    });
    assert.equal(ref.inlineData, null);
    assert.ok(ref.driveFileId);
    assert.deepEqual(await s.get(ref), pdf);
  });

  it('drive driver without a client falls back to the database', async () => {
    const s = createFileStorage({ driver: 'drive', drive: null });
    const ref = await s.put({
      folder: 'Claims',
      fileName: 'r.pdf',
      contentType: 'application/pdf',
      data: pdf,
    });
    assert.equal(ref.driveFileId, null);
    assert.equal(s.usesDrive, false);
  });

  it('reads a mixed table: old rows inline, new rows in Drive', async () => {
    const { drive } = fakeDrive();
    const s = createFileStorage({ driver: 'drive', drive });
    assert.deepEqual(await s.get({ driveFileId: null, inlineData: pdf }), pdf);
  });

  it('refuses a Drive row when Drive is not configured, and an empty row', async () => {
    const s = createFileStorage({ driver: 'db', drive: null });
    await assert.rejects(
      s.get({ driveFileId: 'x', inlineData: null }),
      /Drive is not configured/,
    );
    await assert.rejects(s.get({ driveFileId: null, inlineData: null }), /neither/);
  });

  it('remove trashes Drive files only', async () => {
    const { drive, trashed } = fakeDrive();
    const s = createFileStorage({ driver: 'drive', drive });
    await s.remove({ driveFileId: 'drv-9', inlineData: null });
    await s.remove({ driveFileId: null, inlineData: pdf });
    assert.deepEqual(trashed, ['drv-9']);
  });
});

describe('fileColumns', () => {
  it('stores bytes only when there is no Drive id', () => {
    assert.deepEqual(fileColumns({ data: pdf }), { data: pdf, driveFileId: null });
    assert.deepEqual(fileColumns({ data: pdf, driveFileId: 'drv-1' }), {
      data: null,
      driveFileId: 'drv-1',
    });
  });
});

describe('Drive client upload verification (fake Google)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = JSON.stringify({
    client_email: 'robot@test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: 'https://oauth.test/token',
  });

  const fakeGoogle = (uploadReply: (body: Buffer) => Record<string, unknown>) => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url.startsWith('https://oauth.test/token'))
        return json({ access_token: 'tok', expires_in: 3600 });
      if (url.includes('/drive/v3/files?') && (init?.method ?? 'GET') === 'GET')
        return json({ files: [{ id: 'fld' }] });
      if (url.includes('/upload/drive/v3/files'))
        return json(uploadReply(Buffer.from(init!.body as Uint8Array)));
      if ((init?.method ?? '') === 'PATCH') return json({});
      return json({ error: { message: 'unexpected' } }, 500);
    }) as typeof fetch;
    return calls;
  };

  it('accepts an upload whose size and md5 match', async () => {
    fakeGoogle(() => ({
      id: 'f1',
      size: String(pdf.length),
      md5Checksum: createHash('md5').update(pdf).digest('hex'),
    }));
    const client = createDriveClient({ serviceAccountKey: key, sharedDriveId: 'sd' });
    assert.equal(
      await client.upload({
        folder: 'Claims',
        fileName: 'r.pdf',
        contentType: 'application/pdf',
        data: pdf,
      }),
      'f1',
    );
  });

  it('trashes and fails an upload whose checksum does not match', async () => {
    const calls = fakeGoogle(() => ({
      id: 'f2',
      size: String(pdf.length),
      md5Checksum: 'deadbeef',
    }));
    const client = createDriveClient({ serviceAccountKey: key, sharedDriveId: 'sd' });
    await assert.rejects(
      client.upload({
        folder: 'Claims',
        fileName: 'r.pdf',
        contentType: 'application/pdf',
        data: pdf,
      }),
      /did not verify/,
    );
    assert.ok(
      calls.some((c) => c.startsWith('PATCH') && c.includes('/f2')),
      calls.join('\n'),
    );
  });
});
