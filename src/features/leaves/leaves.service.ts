import createError from 'http-errors';
import {
  hasBroadScope,
  hasOrgScope,
  isWeekendDay,
  type WorkWeek,
} from '../../shared/helpers/helpers.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import { createRmOrHrGate } from '../access/rmOrHr.gate.js';
import { createSelfGovernance } from '../access/selfGovernance.js';
import type { SettingsReader } from '../settings/index.js';
import {
  CAPPED_LEAVE_TYPES,
  EL_BALANCE_CAP,
  EL_YEARLY_USE_LIMIT,
  accruedAllocation,
  type CappedLeaveType,
} from '../../shared/constants/constants.js';
import type {
  CreateLeaveRequestInput,
  DecideLeaveInput,
  LeaveBalanceDto,
  LeaveRequestDto,
} from './leaves.schema.js';
import type {
  ActorContext,
  LeaveRequestJoinedRow,
  LeaveRequestRow,
  LeavesRepository,
} from './leaves.repository.js';

const isCapped = (type: LeaveRequestRow['type']): type is CappedLeaveType =>
  (CAPPED_LEAVE_TYPES as readonly string[]).includes(type);

/** Menstrual-leave eligibility (policy §9.2): the gender field says female. */
const isFemale = (gender: string | null | undefined): boolean => {
  const g = (gender ?? '').trim().toLowerCase();
  return g === 'female' || g === 'f';
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** States a request can still move from. */
const LIVE_STATUSES: ReadonlyArray<LeaveRequestRow['status']> = [
  'pending',
  'partially_approved',
];

const DAY_MS = 86_400_000;
const localDate = (d = new Date()): string => d.toLocaleDateString('en-CA');

/**
 * NO-SANDWICH counting (user decision): only WORKING days consume balance —
 * weekends (Sundays + the work week's off Saturdays) and company holidays
 * inside the range are free, so Fri→Mon costs 2 days. Half day is 0.5 and must itself be a working day.
 * Returns 0 when the range has no working days (the service rejects that).
 */
const computeDays = (
  input: CreateLeaveRequestInput,
  holidaySet: Set<string>,
  workWeek: WorkWeek,
): number => {
  // Entirely in UTC: Date.parse('YYYY-MM-DD') is UTC midnight, so a local
  // format/getDay() would shift every date west of UTC and break under DST.
  const isWorking = (date: string, _t: number): boolean =>
    !isWeekendDay(date, workWeek) && !holidaySet.has(date);
  if (input.dayPart !== 'full') {
    const t = Date.parse(input.startDate);
    return isWorking(input.startDate, t) ? 0.5 : 0;
  }
  let days = 0;
  for (let t = Date.parse(input.startDate); ; t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    if (date > input.endDate) break;
    if (isWorking(date, t)) days += 1;
  }
  return days;
};

const toLeave = (row: LeaveRequestJoinedRow): LeaveRequestDto => ({
  id: row.id,
  employee: {
    id: row.employeeId,
    name: row.employeeName,
    employeeCode: row.employeeCode,
  },
  type: row.type,
  startDate: row.startDate,
  endDate: row.endDate,
  dayPart: row.dayPart,
  days: Number(row.days),
  reason: row.reason,
  status: row.status,
  rmRequired: row.rmRequired,
  hrRequired: row.hrRequired,
  rmApprovedBy: row.rmApprovedBy,
  rmApprovedAt: row.rmApprovedAt?.toISOString() ?? null,
  hrApprovedBy: row.hrApprovedBy,
  hrApprovedAt: row.hrApprovedAt?.toISOString() ?? null,
  // Filled by withApproverNames — kept null on paths that skip decoration.
  rmApprovedByName: null,
  hrApprovedByName: null,
  decidedBy: row.decidedBy,
  decisionReason: row.decisionReason,
  // Filled by withApproverNames (certificate info rides the same pass).
  certificateNeeded: false,
  certificate: null,
  createdAt: row.createdAt.toISOString(),
});

const CERT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const CERT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Leave rules. The dual approval (user decision): the employee's RM
 * (leave_approver ?? reports_to) AND an `hrbp.leaves` holder must BOTH
 * approve, in any order — one in is `partially_approved`, both `approved`,
 * either declining ends it. The RM is a RELATIONSHIP, so the RM slot is
 * resolved here against the target row, never by route middleware; the HR
 * slot is resolved through the same authz read requireAccess uses.
 */
export const createLeavesService = (deps: {
  repo: LeavesRepository;
  authz: AuthzRepository;
  settings: SettingsReader;
}) => {
  const { repo, authz, settings } = deps;
  const rmOrHr = createRmOrHrGate(authz);
  const selfGoverned = createSelfGovernance(authz);

  const requireRow = async (id: string): Promise<LeaveRequestRow> => {
    const row = await repo.findById(id);
    if (!row)
      throw createError(404, 'Leave request not found', { code: 'LEAVE_NOT_FOUND' });
    return row;
  };

  /** Resolve the names behind the filled approval slots (queues show WHO). */
  const withApproverNames = async (
    dtos: LeaveRequestDto[],
  ): Promise<LeaveRequestDto[]> => {
    const ids = [
      ...new Set(
        dtos
          .flatMap((d) => [d.rmApprovedBy, d.hrApprovedBy])
          .filter((v): v is string => v !== null),
      ),
    ];
    const [names, certs] = await Promise.all([
      ids.length ? repo.namesByIds(ids) : Promise.resolve(new Map<string, string>()),
      repo.certificateInfo(dtos.map((d) => d.id)),
    ]);
    return dtos.map((d) => {
      const c = certs.get(d.id);
      return {
        ...d,
        rmApprovedByName: d.rmApprovedBy ? (names.get(d.rmApprovedBy) ?? null) : null,
        hrApprovedByName: d.hrApprovedBy ? (names.get(d.hrApprovedBy) ?? null) : null,
        certificateNeeded: c?.needed ?? false,
        certificate: c?.fileName
          ? { fileName: c.fileName, uploadedAt: c.uploadedAt!.toISOString() }
          : null,
      };
    });
  };

  const withEmployee = async (row: LeaveRequestRow): Promise<LeaveRequestDto> => {
    const emp = await repo.findEmployeeApprovers(row.employeeId);
    const [dto] = await withApproverNames([
      toLeave({
        ...row,
        employeeName: emp?.name ?? '',
        employeeCode: emp?.employeeCode ?? '',
      }),
    ]);
    return dto!;
  };

  const listMine = async (employeeId: string) =>
    withApproverNames((await repo.listByEmployee(employeeId)).map(toLeave));

  const listTeam = async (rmId: string) =>
    withApproverNames((await repo.listForRm(rmId)).map(toLeave));

  const listQueue = async (status?: LeaveRequestRow['status']) =>
    withApproverNames((await repo.listAll(status)).map(toLeave));

  /**
   * Balances for one year (policy §9.2/§9.3): earned and menstrual accrue
   * monthly (lazily materialized here), earned carries forward via `opening`
   * with the 30-day effective cap (excess reads as lapsed), menstrual shows
   * only for eligible people, unpaid stays uncapped.
   */
  const balances = async (
    employeeId: string,
    year: number,
  ): Promise<LeaveBalanceDto[]> => {
    const me = await repo.findEmployeeApprovers(employeeId);
    const eligible = isFemale(me?.gender);
    await repo.ensureAccruals(employeeId, year, eligible);
    const [rows, unpaidUsed] = await Promise.all([
      repo.listBalances(employeeId, year),
      repo.sumApprovedUnpaid(employeeId, year),
    ]);
    const capped = CAPPED_LEAVE_TYPES.filter((t) => t !== 'menstrual' || eligible).map(
      (type) => {
        const row = rows.find((r) => r.type === type);
        const opening = row ? Number(row.opening) : 0;
        const allocated = row
          ? Number(row.allocated)
          : accruedAllocation(type, year, { joinedOn: me?.dateOfJoining ?? null });
        const used = row ? Number(row.used) : 0;
        const effective =
          type === 'earned'
            ? Math.min(opening + allocated, EL_BALANCE_CAP)
            : opening + allocated;
        return {
          type,
          year,
          allocated: round1(allocated),
          opening: round1(opening),
          used,
          remaining: round1(effective - used),
        };
      },
    );
    return [
      ...capped,
      {
        type: 'unpaid' as const,
        year,
        allocated: null,
        opening: 0,
        used: unpaidUsed,
        remaining: null,
      },
    ];
  };

  /**
   * A report's balances for the RM's person sheet — the shared RM-or-HR
   * gate (access/rmOrHr.gate.ts) with broad hrbp.leaves read as the HR door.
   * Menstrual is CONFIDENTIAL (policy §9.2): the
   * row is stripped here no matter who asks — this endpoint is an RM surface.
   */
  const teamBalances = async (
    targetId: string,
    actorEmployeeId: string,
    year: number,
  ): Promise<LeaveBalanceDto[]> => {
    await rmOrHr(
      actorEmployeeId,
      targetId,
      { moduleKey: 'hrbp.leaves', action: 'read' },
      "Only this person's RM or HR reads their balances",
    );
    return (await balances(targetId, year)).filter((b) => b.type !== 'menstrual');
  };

  const raise = async (
    employeeId: string,
    input: CreateLeaveRequestInput,
    actor: ActorContext,
  ): Promise<LeaveRequestDto> => {
    if (await repo.isSystemAccount(employeeId)) {
      // admin@ is the ADMINISTRATION concept, not a person (user decision).
      throw createError(403, 'The administration account does not take leave', {
        code: 'SYSTEM_ACCOUNT',
      });
    }
    // Application window (leaves.applicationWindowDays): planned leave —
    // earned and vacation_family — is raised N calendar days ahead; sick,
    // menstrual, compassionate and unpaid are always exempt. 0 = no window.
    if (input.type === 'earned' || input.type === 'vacation_family') {
      const windows = await settings.effective('leaves.applicationWindowDays');
      const need = windows[input.type];
      const ahead = Math.round(
        (Date.parse(`${input.startDate}T00:00:00Z`) -
          Date.parse(`${localDate()}T00:00:00Z`)) /
          DAY_MS,
      );
      if (need > 0 && ahead < need) {
        throw createError(
          422,
          `${input.type === 'earned' ? 'Earned' : 'Vacation / family'} leave must be applied for at least ${need} days before it starts`,
          { code: 'TOO_SHORT_NOTICE' },
        );
      }
    }
    const overlaps = await repo.listOverlapping(
      employeeId,
      input.startDate,
      input.endDate,
    );
    if (overlaps.length > 0) {
      throw createError(409, 'This range overlaps an existing leave request', {
        code: 'OVERLAPPING_LEAVE',
      });
    }

    const holidayDates = await repo.listHolidayDates(input.startDate, input.endDate);
    const workWeek = await settings.effective('attendance.workWeek');
    const days = computeDays(input, new Set(holidayDates), workWeek);
    if (days === 0) {
      throw createError(422, 'The selected dates have no working days', {
        code: 'NO_WORKING_DAYS',
      });
    }
    const year = Number(input.startDate.slice(0, 4));

    const gate = await repo.findEmployeeApprovers(employeeId);
    if (!gate)
      throw createError(404, 'Employee record not found', { code: 'EMPLOYEE_NOT_FOUND' });

    // Policy §9.3c: during probation and the notice period, only sick leave
    // may be raised. A missing confirmation date reads as CONFIRMED — most
    // records predate the field; once HR maintains it, a future date is what
    // marks probation.
    const today = localDate();
    // The date alone isn't enough: an undecided review keeps it open (close-out).
    const onProbation =
      (gate.confirmationDate !== null && gate.confirmationDate > today) ||
      (await repo.probationOpen(employeeId));
    const onNotice = gate.status === 'exiting';
    if ((onProbation || onNotice) && input.type !== 'sick') {
      throw createError(
        403,
        `Only sick leave can be raised during ${onNotice ? 'the notice period' : 'probation'}`,
        { code: 'SICK_ONLY_PERIOD' },
      );
    }

    // Policy §9.2: menstrual leave is gender-gated and confidential.
    if (input.type === 'menstrual' && !isFemale(gate.gender)) {
      throw createError(403, 'This leave type is not available on your record', {
        code: 'NOT_ELIGIBLE',
      });
    }

    // Policy §9.3(a.2): at most 18 earned days COMMITTED per calendar year —
    // pending and approved both count; beyond that needs HR + Management
    // outside the system.
    if (input.type === 'earned') {
      const committed = await repo.sumLiveEarnedDays(employeeId, year);
      if (committed + days > EL_YEARLY_USE_LIMIT) {
        throw createError(
          409,
          `Earned leave is limited to ${EL_YEARLY_USE_LIMIT} days a year (${committed} already requested or taken) — beyond that needs HR and Management approval`,
          { code: 'EL_USE_LIMIT' },
        );
      }
    }

    if (isCapped(input.type)) {
      // Pending requests do not reserve balance — the conditional UPDATE at
      // final approval is the arbiter. This is only the friendly early check.
      const all = await balances(employeeId, year);
      const mine = all.find((b) => b.type === input.type)!;
      if (mine.remaining !== null && days > mine.remaining) {
        throw createError(409, 'Not enough leave balance for this request', {
          code: 'INSUFFICIENT_BALANCE',
        });
      }
    }

    // SELF-GOVERNED (the org chart's apex, refinement plan Phase 2): nobody
    // above them, so the request is born approved — every type, menstrual
    // included — with the balance charged by the arbiter in the same
    // transaction; an exhausted balance writes nothing.
    if (await selfGoverned(gate)) {
      const row = await repo
        .insertSelfApproved(
          {
            employeeId,
            type: input.type,
            startDate: input.startDate,
            endDate: input.endDate,
            dayPart: input.dayPart,
            days: String(days),
            reason: input.reason ?? null,
          },
          isCapped(input.type)
            ? { op: 'deduct', employeeId, type: input.type, year, days }
            : null,
          actor,
        )
        .catch((err: unknown) => {
          if ((err as { code?: string }).code === 'INSUFFICIENT_BALANCE') {
            throw createError(409, 'Not enough leave balance for this request', {
              code: 'INSUFFICIENT_BALANCE',
            });
          }
          throw err;
        });
      return withEmployee(row);
    }

    const me = gate;
    // Waived only when there is no effective RM at raise time (the Owner).
    let rmRequired = Boolean(me.leaveApprover ?? me.reportsTo);
    // An HRBP's own leave needs only their RM (user decision): the HR slot is
    // waived when the requester holds hrbp.leaves THEMSELVES — via a real
    // broad grant (same bar as holding the HR slot in decide), not the
    // Owner/SuperAdmin bypass and not a me/team-scoped grant — and only while
    // an RM slot exists, so a request can never require nobody.
    const myHrAccess = await authz.resolveAccess(employeeId, 'hrbp.leaves', 'update');
    let hrRequired = !(rmRequired && hasBroadScope(myHrAccess.scopes));
    // Menstrual leave is CONFIDENTIAL (policy §9.2): the RM never sees it, so
    // HR fills the only slot — even for an HRBP's own request (another broad
    // hrbp.leaves holder approves; nobody fills a slot on their own request).
    if (input.type === 'menstrual') {
      rmRequired = false;
      hrRequired = true;
    }

    const row = await repo.insertRequest(
      {
        employeeId,
        type: input.type,
        startDate: input.startDate,
        endDate: input.endDate,
        dayPart: input.dayPart,
        days: String(days),
        reason: input.reason ?? null,
        rmRequired,
        hrRequired,
      },
      actor,
    );
    return withEmployee(row);
  };

  /**
   * Cancel a live request, or REVOKE a future approved one (user decision):
   * an approved leave whose start date hasn't arrived can be taken back by
   * the employee, refunding the balance; once the date has come, it cannot.
   */
  /** The optimistic-concurrency snapshot handed to every applyDecision call. */
  const snapshotOf = (row: LeaveRequestRow) => ({
    status: row.status,
    rmApprovedBy: row.rmApprovedBy,
    hrApprovedBy: row.hrApprovedBy,
  });

  /** DECISION_CONFLICT (someone decided first) → retryable 409. */
  const mapConflict = (err: unknown): never => {
    if ((err as { code?: string }).code === 'DECISION_CONFLICT') {
      throw createError(
        409,
        'This request was just updated by someone else — refresh and retry',
        {
          code: 'DECISION_CONFLICT',
        },
      );
    }
    throw err;
  };

  const cancel = async (id: string, actor: ActorContext): Promise<LeaveRequestDto> => {
    const row = await requireRow(id);
    if (row.employeeId !== actor.actorEmployeeId) {
      throw createError(403, 'You can only cancel your own leave request', {
        code: 'NOT_YOUR_REQUEST',
      });
    }

    const patch = {
      status: 'cancelled' as const,
      decidedBy: actor.actorEmployeeId,
      decidedAt: new Date(),
    };

    if (LIVE_STATUSES.includes(row.status)) {
      // Not fully approved yet — nothing was deducted, nothing to refund.
      const updated = await repo
        .applyDecision(
          id,
          patch,
          null,
          { action: 'leave.cancelled', detail: { type: row.type, days: row.days } },
          actor,
          snapshotOf(row),
        )
        .catch(mapConflict);
      return withEmployee(updated);
    }

    if (row.status === 'approved' && row.startDate > localDate()) {
      const refund = isCapped(row.type)
        ? {
            op: 'refund' as const,
            employeeId: row.employeeId,
            type: row.type,
            year: Number(row.startDate.slice(0, 4)),
            days: Number(row.days),
          }
        : null;
      const updated = await repo
        .applyDecision(
          id,
          patch,
          refund,
          { action: 'leave.revoked', detail: { type: row.type, days: row.days } },
          actor,
          snapshotOf(row),
        )
        .catch(mapConflict);
      return withEmployee(updated);
    }

    throw createError(
      409,
      row.status === 'approved'
        ? 'This leave has already started — contact HR to adjust it'
        : 'This request has already been decided',
      { code: 'ALREADY_DECIDED' },
    );
  };

  const decide = async (
    id: string,
    input: DecideLeaveInput,
    actor: ActorContext,
  ): Promise<LeaveRequestDto> => {
    const caller = actor.actorEmployeeId;
    const row = await requireRow(id);
    if (!LIVE_STATUSES.includes(row.status)) {
      throw createError(409, 'This request has already been decided', {
        code: 'ALREADY_DECIDED',
      });
    }
    if (row.employeeId === caller) {
      // No self-approval (§10) — even for hrbp.leaves holders and the Owner.
      throw createError(403, 'You cannot decide your own leave request', {
        code: 'NO_SELF_APPROVAL',
      });
    }

    // Slots are resolved LIVE: a manager change mid-flight moves the RM slot.
    // A named leave approver JOINS the chain alongside the RM (user decision):
    // either of them may fill the RM slot.
    const target = await repo.findEmployeeApprovers(row.employeeId);
    const rmEligible =
      caller !== null &&
      (caller === target?.leaveApprover || caller === target?.reportsTo);
    const holdsRmSlot = row.rmRequired && rmEligible;
    // The HR slot: a hrbp.leaves grant that REACHES this person (M4, Phase 3
    // — a dept grant decides for its department only).
    const holdsHrSlot = await authz.reaches(caller, 'hrbp.leaves', 'update', row.employeeId);
    if (!holdsRmSlot && !holdsHrSlot) {
      throw createError(403, 'You are not an approver for this request', {
        code: 'NOT_AN_APPROVER',
      });
    }

    if (input.decision === 'decline') {
      const updated = await repo
        .applyDecision(
          id,
          {
            status: 'declined',
            decidedBy: caller,
            decisionReason: input.reason ?? null,
            decidedAt: new Date(),
          },
          null,
          { action: 'leave.declined', detail: { type: row.type, days: row.days } },
          actor,
          snapshotOf(row),
        )
        .catch(mapConflict);
      return withEmployee(updated);
    }

    // Approve: fill every unfilled slot the caller holds (a person wearing
    // both hats completes the request in one decision).
    const now = new Date();
    const fillsRm = holdsRmSlot && !row.rmApprovedBy;
    const fillsHr = holdsHrSlot && !row.hrApprovedBy;
    if (!fillsRm && !fillsHr) {
      throw createError(409, 'You have already approved this request', {
        code: 'SLOT_ALREADY_DECIDED',
      });
    }

    const rmSatisfied = !row.rmRequired || Boolean(row.rmApprovedBy) || fillsRm;
    const hrSatisfied = !row.hrRequired || Boolean(row.hrApprovedBy) || fillsHr;
    const final = rmSatisfied && hrSatisfied;

    const slots = [...(fillsRm ? ['rm'] : []), ...(fillsHr ? ['hr'] : [])];
    const deduction =
      final && isCapped(row.type)
        ? {
            op: 'deduct' as const,
            employeeId: row.employeeId,
            type: row.type,
            year: Number(row.startDate.slice(0, 4)),
            days: Number(row.days),
          }
        : null;

    try {
      const updated = await repo.applyDecision(
        id,
        {
          ...(fillsRm ? { rmApprovedBy: caller, rmApprovedAt: now } : {}),
          ...(fillsHr ? { hrApprovedBy: caller, hrApprovedAt: now } : {}),
          status: final ? 'approved' : 'partially_approved',
        },
        deduction,
        {
          action: 'leave.approved',
          detail: { type: row.type, days: row.days, slots, final },
        },
        actor,
        snapshotOf(row),
      );
      return withEmployee(updated);
    } catch (err) {
      if ((err as { code?: string }).code === 'INSUFFICIENT_BALANCE') {
        // A competing request consumed the balance first; nothing was written.
        throw createError(409, 'Not enough leave balance remains for this request', {
          code: 'INSUFFICIENT_BALANCE',
        });
      }
      return mapConflict(err);
    }
  };

  /**
   * MONTH-END policy (user decision): a request still `partially_approved`
   * when the month is processed counts as approved — one signature shouldn't
   * cost the employee pay because the second never came. Runs from payroll
   * generation/regeneration for the run month. Balances are deducted exactly
   * as a normal final approval would; a request whose balance ran out in the
   * meantime is SKIPPED (stays partial) and its days fall through to the
   * EL-auto-cover / LOP safety net.
   */
  const monthBounds = (month: string): { from: string; to: string } => {
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y!, m!, 0).getDate();
    return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
  };

  /**
   * Finalize's guard (M7): every partial TOUCHING the month, not just what
   * the sweep would approve — a month-spanning partial escapes the sweep, so
   * it must block finalize for a human decision instead of silently landing
   * as absence + a later double balance charge.
   */
  const pendingMonthEndPartials = async (month: string): Promise<number> => {
    const { from, to } = monthBounds(month);
    return (await repo.listPartiallyApprovedOverlapping(from, to)).length;
  };

  const autoApproveMonthEnd = async (
    month: string,
    actor: ActorContext,
  ): Promise<{ approved: number; skipped: number }> => {
    const { from, to } = monthBounds(month);

    let approved = 0;
    let skipped = 0;
    for (const row of await repo.listPartiallyApprovedWithin(from, to)) {
      const deduction = isCapped(row.type)
        ? {
            op: 'deduct' as const,
            employeeId: row.employeeId,
            type: row.type,
            year: Number(row.startDate.slice(0, 4)),
            days: Number(row.days),
          }
        : null;
      try {
        await repo.applyDecision(
          row.id,
          { status: 'approved', decisionReason: 'auto-approved at month end' },
          deduction,
          {
            action: 'leave.auto_approved',
            detail: { type: row.type, days: row.days, month },
          },
          actor,
          snapshotOf(row),
        );
        approved += 1;
      } catch (err) {
        const code = (err as { code?: string }).code;
        // Balance ran out → EL-cover/LOP net; concurrent decision → theirs wins.
        if (code === 'INSUFFICIENT_BALANCE' || code === 'DECISION_CONFLICT') {
          skipped += 1;
          continue;
        }
        throw err;
      }
    }
    return { approved, skipped };
  };

  /** The leave's owner uploads (or replaces) a medical certificate for a sick leave. */
  const uploadCertificate = async (
    id: string,
    file: { fileName: string; contentType: string; data: Buffer },
    actor: ActorContext,
  ) => {
    const leave = await repo.findById(id);
    if (!leave || leave.employeeId !== actor.actorEmployeeId) {
      throw createError(404, 'Leave not found', { code: 'LEAVE_NOT_FOUND' });
    }
    if (leave.type !== 'sick') {
      throw createError(422, 'Certificates are for sick leave', { code: 'NOT_SICK_LEAVE' });
    }
    if (leave.status === 'declined' || leave.status === 'cancelled') {
      throw createError(409, `This leave is ${leave.status}`, { code: 'LEAVE_CLOSED' });
    }
    const type = file.contentType.split(';')[0]!.trim().toLowerCase();
    if (!CERT_TYPES.includes(type)) {
      throw createError(422, 'Upload a PDF, JPG or PNG', { code: 'BAD_FILE_TYPE' });
    }
    if (file.data.length === 0 || file.data.length > CERT_MAX_BYTES) {
      throw createError(422, 'The file must be under 10 MB', { code: 'BAD_FILE_SIZE' });
    }
    await repo.upsertCertificate(
      { leaveId: id, fileName: file.fileName, contentType: type, data: file.data },
      actor,
    );
    return withEmployee((await repo.findById(id))!);
  };

  /** The owner, HR in reach (hrbp.leaves read) or payroll (org) may open it. */
  const certificate = async (id: string, callerId: string) => {
    const leave = await repo.findById(id);
    if (!leave) throw createError(404, 'Certificate not found', { code: 'CERT_NOT_FOUND' });
    if (leave.employeeId !== callerId) {
      const [hr, pr] = await Promise.all([
        authz.reaches(callerId, 'hrbp.leaves', 'read', leave.employeeId),
        authz.resolveAccess(callerId, 'pr.payroll', 'read'),
      ]);
      if (!hr && !hasOrgScope(pr)) {
        throw createError(404, 'Certificate not found', { code: 'CERT_NOT_FOUND' });
      }
    }
    const file = await repo.getCertificate(id);
    if (!file) throw createError(404, 'Certificate not found', { code: 'CERT_NOT_FOUND' });
    return file;
  };

  return {
    uploadCertificate,
    certificate,
    listMine,
    listTeam,
    listQueue,
    balances,
    teamBalances,
    raise,
    cancel,
    decide,
    autoApproveMonthEnd,
    pendingMonthEndPartials,
  };
};

export type LeavesService = ReturnType<typeof createLeavesService>;
