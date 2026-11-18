/**
 * One-off: prove the robot can write and read the company Shared Drive —
 * uploads a tiny file, downloads it, checks the bytes match, then trashes it.
 * Verifies Part E (Shared Drive + the robot as Content manager) and the key.
 *   npx tsx src/scripts/test-drive.ts
 * Needs GOOGLE_SERVICE_ACCOUNT_KEY and DRIVE_SHARED_DRIVE_ID in .env.
 */
import { env } from '../config/env.js';
import { createDriveClient } from '../features/storage/drive.js';

const main = async (): Promise<void> => {
  if (!env.google.serviceAccountKey || !env.google.driveSharedDriveId) {
    console.error(
      'Set GOOGLE_SERVICE_ACCOUNT_KEY and DRIVE_SHARED_DRIVE_ID in .env first.',
    );
    process.exit(1);
  }
  const drive = createDriveClient({
    serviceAccountKey: env.google.serviceAccountKey,
    sharedDriveId: env.google.driveSharedDriveId,
  });
  const data = Buffer.from(
    `Elecbits HR Drive connectivity test — ${new Date().toISOString()}\n`,
    'utf8',
  );
  try {
    console.log('Uploading a test file to the Shared Drive ...');
    const id = await drive.upload({
      folder: '_connectivity-test',
      fileName: `test-${Date.now()}.txt`,
      contentType: 'text/plain',
      data,
    });
    console.log(`  uploaded, file id ${id}`);
    const back = await drive.download(id);
    const match = back.data.equals(data);
    console.log(`  downloaded ${back.data.length} bytes, bytes match: ${match}`);
    await drive.trash(id);
    console.log('  trashed the test file');
    console.log(
      match
        ? 'OK — the robot can create, read and remove files on the Shared Drive.'
        : 'Downloaded bytes did not match — check the Drive setup.',
    );
    process.exit(match ? 0 : 1);
  } catch (err) {
    console.error('FAILED:');
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
};

void main();
