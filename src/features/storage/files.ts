import { logger } from '../../config/logger.js';
import { fileStorageFor } from './index.js';

/**
 * The glue every file feature uses (leave certificates, receipts, CVs, …), so
 * moving bytes from Postgres to the Shared Drive is a storage switch, not a
 * per-feature rewrite:
 *
 *   write: withStoredFile(folder, file, (driveFileId) => repo.upsert({ …, driveFileId }))
 *          — with the drive driver the bytes go to Drive first and the row keeps
 *          only the id (the repository stores `data` only when driveFileId is
 *          null). If the row write fails, the Drive copy is trashed again.
 *   read:  loadStoredFile(row) — the bytes, from whichever place holds them.
 *
 * With STORAGE_DRIVER=db (the default) driveFileId is always null and the
 * behaviour is exactly the old one.
 */

/** One Shared Drive subfolder per area (D:\HRMS-Google-Drive-Plan.md §3). */
export const DRIVE_FOLDERS = {
  policies: 'Policies',
  leaveCertificates: 'Leave certificates',
  onboarding: 'Onboarding',
  claims: 'Claims',
  trainings: 'Training certificates',
  cvs: 'Hiring - CVs',
  offerLetters: 'Hiring - Offer letters',
  signedOffers: 'Hiring - Signed offers',
} as const;

export type DriveFolder = (typeof DRIVE_FOLDERS)[keyof typeof DRIVE_FOLDERS];

export interface StoredFileInput {
  fileName: string;
  contentType: string;
  data: Buffer;
}

/**
 * Store the bytes (Drive or nowhere yet), then run the row write with the
 * resulting Drive id (null = keep the bytes in the row).
 */
export const withStoredFile = async <R>(
  folder: DriveFolder,
  file: StoredFileInput,
  write: (driveFileId: string | null) => Promise<R>,
): Promise<R> => {
  const storage = fileStorageFor();
  const ref = await storage.put({ folder, ...file });
  try {
    return await write(ref.driveFileId);
  } catch (err) {
    if (ref.driveFileId) {
      await storage
        .remove(ref)
        .catch((cleanupErr: unknown) =>
          logger.warn(
            { err: cleanupErr, driveFileId: ref.driveFileId },
            'could not trash an orphaned Drive file after a failed save',
          ),
        );
    }
    throw err;
  }
};

/** A stored-file row as repositories return it. */
export interface StoredFileRow {
  data: Buffer | null;
  driveFileId: string | null;
}

/** Resolve a row to its bytes, wherever they live. */
export const loadStoredFile = async <T extends StoredFileRow>(
  row: T,
): Promise<Omit<T, 'data' | 'driveFileId'> & { data: Buffer }> => {
  const { data, driveFileId, ...rest } = row;
  const bytes = await fileStorageFor().get({ driveFileId, inlineData: data });
  return { ...rest, data: bytes };
};

/** What a repository writes into the row for a stored file. */
export const fileColumns = (file: { data: Buffer; driveFileId?: string | null }) => ({
  data: file.driveFileId ? null : file.data,
  driveFileId: file.driveFileId ?? null,
});

/**
 * Trash Drive copies whose rows were just deleted (e.g. the talent-pool
 * anonymiser). Best effort: a failure is logged and counted, never thrown,
 * because the database delete already happened. Returns how many went.
 */
export const discardDriveFiles = async (driveFileIds: string[]): Promise<number> => {
  const storage = fileStorageFor();
  let trashed = 0;
  for (const driveFileId of driveFileIds) {
    try {
      await storage.remove({ driveFileId, inlineData: null });
      trashed += 1;
    } catch (err) {
      logger.warn(
        { err, driveFileId },
        'could not trash a Drive file after its row was deleted',
      );
    }
  }
  return trashed;
};
