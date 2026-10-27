import createError from 'http-errors';
import { localDateOf } from '../../shared/helpers/helpers.js';
import type { HiringRepository } from './hiring.repository.js';
import type { ReportsRepository } from './reports.repository.js';
import type {
  HiringReportDto,
  PendingActionDto,
  TrackerRowDto,
  TrackerView,
} from './reports.schema.js';

const num = (v: string | null) => (v === null ? null : Number(v));

/**
 * The TA tracker report and the hiring trackers (TA workflow deck slides
 * 13–16, 2026-10-27). The report counts activity and outcomes per role and
 * SPOC over a period; the INTERNAL tracker lists every candidate with every
 * field for TA / HR; the EXTERNAL one leaves out contacts and CTC and is what
 * a department head sees — their own departments only.
 */
export const createReportsService = (deps: {
  repo: ReportsRepository;
  hiring: HiringRepository;
}) => {
  const { repo, hiring } = deps;

  const report = async (from: string, to: string): Promise<HiringReportDto> => {
    const rows = await repo.report(from, to, localDateOf(new Date()));
    return {
      from,
      to,
      rows: rows.map((r) => ({
        positionId: r.position_id,
        requestCode: r.request_code,
        roleTitle: r.role_title,
        positionNumber: r.position_number,
        departmentName: r.department_name,
        spocName: r.spoc_name,
        sourced: r.sourced,
        callAttempts: r.call_attempts,
        callUnique: r.call_unique,
        screened: r.screened,
        aligned: r.aligned,
        held: r.held,
        offersShared: r.offers_shared,
        accepted: r.accepted,
        joined: r.joined,
        rejected: r.rejected,
        withdrawn: r.withdrawn,
        overdue: r.overdue,
      })),
    };
  };

  const pendingActions = async (): Promise<PendingActionDto[]> =>
    (await repo.pendingActions(localDateOf(new Date()))).map((r) => ({
      applicationId: r.application_id,
      candidateName: r.candidate_name,
      candidateCode: r.candidate_code,
      roleTitle: r.role_title,
      positionNumber: r.position_number,
      stage: r.stage,
      nextAction: r.next_action,
      ownerName: r.owner_name,
      due: r.due,
      overdue: r.overdue,
    }));

  /**
   * The tracker. TA (the ta.hiring grant) gets either view of every
   * department; anyone else gets the EXTERNAL view of the departments they
   * head — or nothing.
   */
  const tracker = async (
    view: TrackerView,
    employeeId: string,
    hasTa: boolean,
  ): Promise<TrackerRowDto[]> => {
    let departments: string[] | null = null;
    if (!hasTa) {
      if (view === 'internal') {
        throw createError(403, 'The internal tracker is for TA and HR', {
          code: 'INTERNAL_TRACKER',
        });
      }
      departments = (await hiring.headOf(employeeId)).map((d) => d.department_id);
      if (departments.length === 0) return [];
    }
    const rows = await repo.tracker(departments);
    const totals = rows.length
      ? await repo.scoreTotals(rows.map((r) => r.application_id))
      : [];
    const internal = view === 'internal';
    return rows.map((r) => ({
      applicationId: r.application_id,
      requestCode: r.request_code,
      candidateCode: r.candidate_code,
      candidateName: r.candidate_name,
      roleTitle: r.role_title,
      positionNumber: r.position_number,
      departmentName: r.department_name,
      spocName: r.spoc_name,
      source: r.source,
      stage: r.stage,
      currentRound: r.current_round,
      experienceYears: num(r.experience_years),
      location: r.location,
      noticeDays: r.notice_days,
      joiningDate: r.joining_date,
      scoreTotal: totals.find((t) => t.application_id === r.application_id)?.total ?? null,
      addedOn: localDateOf(new Date(r.created_at)),
      email: internal ? r.email : null,
      phone: internal ? r.phone : null,
      currentCtc: internal ? num(r.current_ctc) : null,
      expectedCtc: internal ? num(r.expected_ctc) : null,
      offeredCtc: internal ? num(r.offered_ctc) : null,
    }));
  };

  return { report, pendingActions, tracker };
};

export type ReportsService = ReturnType<typeof createReportsService>;
