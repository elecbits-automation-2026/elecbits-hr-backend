import type { DriveClient } from './drive.js';

/**
 * File storage, one interface over two drivers. `db` keeps bytes in the row
 * (today's behaviour); `drive` puts them on the company Shared Drive and keeps
 * only a file id. A stored file is addressed by a FileRef: exactly one of
 * `driveFileId` (bytes in Drive) or `inlineData` (bytes in Postgres) is set,
 * so a table can hold a mix during the one-off migration and reads just work.
 */

export interface FileRef {
  driveFileId: string | null;
  inlineData: Buffer | null;
}

export interface PutInput {
  /** The Shared Drive subfolder this kind of file belongs in. */
  folder: string;
  fileName: string;
  contentType: string;
  data: Buffer;
}

export const createFileStorage = (deps: {
  driver: 'db' | 'drive';
  drive: DriveClient | null;
}) => {
  const useDrive = deps.driver === 'drive' && deps.drive !== null;

  /** Store bytes and return what the owning row should persist. */
  const put = async (input: PutInput): Promise<FileRef> => {
    if (useDrive && deps.drive) {
      return { driveFileId: await deps.drive.upload(input), inlineData: null };
    }
    return { driveFileId: null, inlineData: input.data };
  };

  /** Read bytes back, wherever they live. */
  const get = async (ref: FileRef): Promise<Buffer> => {
    if (ref.driveFileId) {
      if (!deps.drive) {
        throw new Error('File is stored in Drive but Drive is not configured');
      }
      return (await deps.drive.download(ref.driveFileId)).data;
    }
    if (!ref.inlineData) {
      throw new Error('File has neither a Drive id nor inline bytes');
    }
    return ref.inlineData;
  };

  /** Best-effort removal — only Drive-backed files need an external delete. */
  const remove = async (ref: FileRef): Promise<void> => {
    if (ref.driveFileId && deps.drive) await deps.drive.trash(ref.driveFileId);
  };

  return { put, get, remove, usesDrive: useDrive };
};

export type FileStorage = ReturnType<typeof createFileStorage>;
