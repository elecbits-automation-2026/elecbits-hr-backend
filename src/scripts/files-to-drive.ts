/**
 * CLI: move uploaded files out of Postgres into the company Shared Drive.
 *   npm run files:to-drive -- --dry-run     counts and sizes only, touches nothing
 *   npm run files:to-drive                  moves them
 *   npm run files:to-drive -- --limit=50    at most 50 files this run
 *
 * Needs STORAGE_DRIVER=drive plus GOOGLE_SERVICE_ACCOUNT_KEY and
 * DRIVE_SHARED_DRIVE_ID (except --dry-run). Take a manual RDS snapshot first
 * (docs/operations-runbook.md §3).
 *
 * Safe to stop and run again: each row is uploaded, the upload is verified
 * (Drive reports size + MD5, checked inside the Drive client), and only then
 * is ONE update made that stores the Drive id and clears the bytes — guarded
 * by `drive_file_id IS NULL`, so a row is never moved twice. A row that a
 * concurrent upload replaced meanwhile keeps its new bytes and the stray
 * Drive copy is trashed.
 */
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { db } from '../db/index.js';
import {
  DRIVE_FOLDERS,
  fileStorageFor,
  type DriveFolder,
} from '../features/storage/index.js';

interface FileTable {
  table: string;
  key: string;
  folder: DriveFolder;
  /** Drive file name for a row (person/record first, so Drive search works). */
  prefix: string;
}

const TABLES: FileTable[] = [
  {
    table: 'org.policy_documents',
    key: 'id',
    folder: DRIVE_FOLDERS.policies,
    prefix: 'policy',
  },
  {
    table: 'org.leave_certificates',
    key: 'id',
    folder: DRIVE_FOLDERS.leaveCertificates,
    prefix: 'leave-cert',
  },
  {
    table: 'org.onboarding_task_files',
    key: 'id',
    folder: DRIVE_FOLDERS.onboarding,
    prefix: 'onboarding',
  },
  {
    table: 'org.claim_receipts',
    key: 'id',
    folder: DRIVE_FOLDERS.claims,
    prefix: 'claim',
  },
  {
    table: 'org.training_certificates',
    key: 'id',
    folder: DRIVE_FOLDERS.trainings,
    prefix: 'training',
  },
  {
    table: 'ta.candidate_cvs',
    key: 'candidate_id',
    folder: DRIVE_FOLDERS.cvs,
    prefix: 'candidate',
  },
  {
    table: 'ta.offer_letters',
    key: 'application_id',
    folder: DRIVE_FOLDERS.offerLetters,
    prefix: 'application',
  },
  {
    table: 'ta.signed_offer_letters',
    key: 'application_id',
    folder: DRIVE_FOLDERS.signedOffers,
    prefix: 'application-signed',
  },
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Number.POSITIVE_INFINITY;

async function main() {
  const storage = fileStorageFor();
  if (!dryRun && !storage.usesDrive) {
    throw new Error(
      `Drive is not active (STORAGE_DRIVER=${env.storage.driver}; key/drive id set: ` +
        `${Boolean(env.google.serviceAccountKey && env.google.driveSharedDriveId)}). ` +
        'Set STORAGE_DRIVER=drive, GOOGLE_SERVICE_ACCOUNT_KEY and DRIVE_SHARED_DRIVE_ID, or use --dry-run.',
    );
  }

  const summary: Array<Record<string, string | number>> = [];
  let budget = limit;

  for (const t of TABLES) {
    const pending = await db.query<{ k: string; bytes: string }>(
      `SELECT ${t.key}::text AS k, size_bytes::text AS bytes FROM ${t.table}
        WHERE data IS NOT NULL AND drive_file_id IS NULL ORDER BY ${t.key}`,
    );
    const row = {
      table: t.table,
      pending: pending.length,
      bytes: 0,
      moved: 0,
      skipped: 0,
      failed: 0,
    };
    row.bytes = pending.reduce((n, p) => n + Number(p.bytes), 0);

    if (!dryRun) {
      for (const p of pending) {
        if (budget <= 0) break;
        budget -= 1;
        // One row's bytes at a time — never the whole table in memory.
        const [file] = await db.query<{
          file_name: string;
          content_type: string;
          data: Buffer | null;
        }>(
          `SELECT file_name, content_type, data FROM ${t.table}
            WHERE ${t.key} = $1 AND drive_file_id IS NULL`,
          [p.k],
        );
        if (!file?.data) {
          row.skipped += 1;
          continue;
        }
        try {
          const ref = await storage.put({
            folder: t.folder,
            fileName: `${t.prefix}-${p.k}-${file.file_name}`,
            contentType: file.content_type,
            data: file.data,
          });
          const moved = await db.query(
            `UPDATE ${t.table} SET drive_file_id = $2, data = NULL
              WHERE ${t.key} = $1 AND drive_file_id IS NULL AND size_bytes = $3
              RETURNING 1`,
            [p.k, ref.driveFileId, file.data.length],
          );
          if (moved.length === 0) {
            // Replaced or moved by someone else meanwhile: drop our copy.
            await storage.remove(ref);
            row.skipped += 1;
          } else {
            row.moved += 1;
          }
        } catch (err) {
          row.failed += 1;
          logger.error(
            { err, table: t.table, key: p.k },
            'file move failed — left in the database',
          );
        }
      }
    }
    summary.push(row);
  }

  logger.info(
    { dryRun, summary },
    dryRun ? 'files:to-drive dry run' : 'files:to-drive finished',
  );
  if (summary.some((r) => Number(r.failed) > 0)) process.exitCode = 1;
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'files:to-drive failed');
    process.exitCode = 1;
  })
  .finally(() => db.close());
