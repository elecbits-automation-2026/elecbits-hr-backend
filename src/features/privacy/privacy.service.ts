import createError from 'http-errors';
import { addMonthsIso, localDateOf } from '../../shared/helpers/helpers.js';
import type { SettingsReader } from '../settings/index.js';
import { discardDriveFiles } from '../storage/index.js';
import type {
  PrivacyRepository,
  RetentionCutoffs,
  SensitiveRead,
} from './privacy.repository.js';
import type {
  MyDataExportDto,
  PrivacyStatusDto,
  RetentionPreviewDto,
} from './privacy.schema.js';

/**
 * Privacy (DPDP Act 2023, report M12, 2026-11-23):
 *  - the privacy notice everyone accepts, per version, before using the app;
 *  - "download my data" — the caller's own records as JSON;
 *  - retention: what is past its keep-by date, and the opt-in purge job;
 *  - an audit row whenever someone opens ANOTHER person's salary, bank
 *    details, payslip PDF or medical certificate.
 */
export const createPrivacyService = (deps: {
  repo: PrivacyRepository;
  settings: SettingsReader;
}) => {
  const { repo, settings } = deps;

  const status = async (employeeId: string): Promise<PrivacyStatusDto> => {
    const [notice, last] = await Promise.all([
      settings.effective('privacy.notice'),
      repo.latestAcceptance(employeeId),
    ]);
    const accepted = await repo.hasAccepted(employeeId, notice.version);
    return {
      version: notice.version,
      text: notice.text,
      acceptedVersion: last?.version ?? null,
      acceptedAt: last ? new Date(last.accepted_at).toISOString() : null,
      required: !accepted,
    };
  };

  /** Only the CURRENT version can be accepted — never a stale screen's. */
  const accept = async (
    employeeId: string,
    version: string,
    actorUserId: string,
  ): Promise<PrivacyStatusDto> => {
    const notice = await settings.effective('privacy.notice');
    if (version !== notice.version) {
      throw createError(
        409,
        'The privacy notice has changed — please read the new version',
        {
          code: 'PRIVACY_NOTICE_CHANGED',
        },
      );
    }
    await repo.accept(employeeId, version, actorUserId);
    return status(employeeId);
  };

  const exportMine = async (employeeId: string): Promise<MyDataExportDto> => ({
    exportedAt: new Date().toISOString(),
    note: 'Everything Elecbits HR holds about you. Uploaded files are listed by name; open them in the app to download each one. To correct anything, update My profile or ask HR.',
    sections: await repo.exportFor(employeeId),
  });

  const cutoffs = async (
    now: Date,
  ): Promise<RetentionCutoffs & { periods: RetentionPreviewDto['periods'] }> => {
    const periods = await settings.effective('privacy.retention');
    const today = localDateOf(now);
    return {
      periods,
      gps: addMonthsIso(today, -periods.gpsMonths),
      medical: addMonthsIso(today, -periods.medicalCertificateMonths),
      exEmployee: addMonthsIso(today, -12 * periods.exEmployeeYears),
    };
  };

  const retentionPreview = async (now = new Date()): Promise<RetentionPreviewDto> => {
    const [c, purge] = await Promise.all([
      cutoffs(now),
      settings.effective('privacy.purge'),
    ]);
    return {
      purgeEnabled: purge.enabled,
      periods: c.periods,
      cutoffs: { gps: c.gps, medical: c.medical, exEmployee: c.exEmployee },
      wouldRemove: await repo.retentionCounts(c),
    };
  };

  /** The privacy-retention job: does nothing until the purge switch is on. */
  const retentionRun = async (now: Date): Promise<Record<string, number>> => {
    if (!(await settings.effective('privacy.purge')).enabled) return { skipped: 1 };
    const c = await cutoffs(now);
    const { counts, driveFileIds } = await repo.purge({
      gps: c.gps,
      medical: c.medical,
      exEmployee: c.exEmployee,
    });
    // Rows are gone; their Drive copies (STORAGE_DRIVER=drive) go too, best effort.
    const driveFilesTrashed = driveFileIds.length
      ? await discardDriveFiles(driveFileIds)
      : 0;
    return { ...counts, driveFilesTrashed };
  };

  /**
   * Audit a sensitive read. Reading your own record is not logged; a lookup
   * that finds no owner (bad id — the read itself 404s) logs nothing.
   */
  const logRead = async (input: {
    actorUserId: string;
    actorEmployeeId: string;
    what: SensitiveRead;
    subjectEmployeeId?: string;
    payslipId?: string;
    leaveId?: string;
  }): Promise<void> => {
    const subject =
      input.subjectEmployeeId ??
      (input.payslipId ? await repo.payslipOwner(input.payslipId) : undefined) ??
      (input.leaveId ? await repo.leaveOwner(input.leaveId) : undefined);
    if (!subject || subject === input.actorEmployeeId) return;
    await repo.recordSensitiveRead({
      actorUserId: input.actorUserId,
      subjectEmployeeId: subject,
      what: input.what,
      ref: input.payslipId ?? input.leaveId,
    });
  };

  return { status, accept, exportMine, retentionPreview, retentionRun, logRead };
};

export type PrivacyService = ReturnType<typeof createPrivacyService>;
