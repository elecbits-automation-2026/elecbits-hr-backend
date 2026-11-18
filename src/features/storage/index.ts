import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { createDriveClient } from './drive.js';
import { createFileStorage, type FileStorage } from './storage.js';

/** Public surface of the storage module. */
export type { FileRef, FileStorage, PutInput } from './storage.js';
export type { DriveClient } from './drive.js';
export { createFileStorage } from './storage.js';
export { createDriveClient } from './drive.js';

const driveReady =
  env.storage.driver === 'drive' &&
  Boolean(env.google.serviceAccountKey && env.google.driveSharedDriveId);

if (env.storage.driver === 'drive' && !driveReady) {
  logger.warn(
    'STORAGE_DRIVER=drive but GOOGLE_SERVICE_ACCOUNT_KEY / DRIVE_SHARED_DRIVE_ID is missing — uploaded files stay in the database',
  );
}

const drive = driveReady
  ? createDriveClient({
      serviceAccountKey: env.google.serviceAccountKey!,
      sharedDriveId: env.google.driveSharedDriveId!,
    })
  : null;

// Built once per process; the Drive client caches its token and folder ids.
let shared: FileStorage | null = null;

/** The storage the app uses, chosen by STORAGE_DRIVER (with a safe db fallback). */
export const fileStorageFor = (): FileStorage => {
  shared ??= createFileStorage({ driver: drive ? 'drive' : 'db', drive });
  return shared;
};
