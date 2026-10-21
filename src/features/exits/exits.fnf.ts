import type { DbClient } from '../../db/client.js';
import { EL_BALANCE_CAP, accruedAllocation } from '../../shared/constants/constants.js';
import {
  createExitsRepository,
  type ActorContext,
  type ExitRow,
  type RecoveryRow,
} from './exits.repository.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The full & final lines for one exit (all rupees; days where named). */
export interface FnfLines {
  encashedElDays: number;
  leaveEncashment: number;
  gratuityYears: number;
  gratuity: number;
  noticePay: number;
  noticeRecovery: number;
  sickLopDays: number;
  sickLopDeduction: number;
  fnfRecovery: number;
  /** Outstanding loans / advances — recovered on the F&F slip (as its loan line). */
  loanBalance: number;
}

export const NO_FNF: FnfLines = {
  encashedElDays: 0,
  leaveEncashment: 0,
  gratuityYears: 0,
  gratuity: 0,
  noticePay: 0,
  noticeRecovery: 0,
  sickLopDays: 0,
  sickLopDeduction: 0,
  fnfRecovery: 0,
  loanBalance: 0,
};

/** Completed months between two ISO dates (the last day counts as worked). */
const monthsBetween = (fromIso: string, toIso: string): number => {
  const [fy, fm, fd] = fromIso.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = toIso.split('-').map(Number) as [number, number, number];
  let months = (ty - fy) * 12 + (tm - fm);
  if (td + 1 < fd) months -= 1;
  return Math.max(0, months);
};

/**
 * Gratuity service years (user decision: from 1 year, under the new rules):
 * nothing below 12 months; above it, completed years plus one more when the
 * last part-year reaches 6 months.
 */
export const gratuityYearsOf = (joinedOn: string | null, lastDay: string): number => {
  if (!joinedOn) return 0;
  const months = monthsBetween(joinedOn, lastDay);
  if (months < 12) return 0;
  return Math.floor(months / 12) + (months % 12 >= 6 ? 1 : 0);
};

/**
 * The F&F maths (user decisions 2026-10-16), from the salary on record:
 *   monthly Basic = CTC/12 × Basic% (the record's, default 50 — the payslip split)
 *   leave encashment = every remaining EL day × Basic/30
 *   gratuity (≥ 1 year) = Basic/26 × 15 × service years
 *   notice shortfall recovered = days × Basic/30
 *   notice paid in lieu (termination) = days × gross/30
 *   sick days without a certificate = days × gross/30 (LOP)
 *   + recovery lines payroll typed.
 */
export const computeFnf = (input: {
  ctc: number;
  basicPercent?: number;
  joinedOn: string | null;
  lastDay: string;
  elRemaining: number;
  shortfallDays: number;
  shortfallAction: ExitRow['shortfallAction'];
  terminationMode: ExitRow['terminationMode'];
  sickDays: number;
  recoveries: number;
  loanBalance?: number;
}): FnfLines => {
  const gross = input.ctc / 12;
  const basic = (gross * (input.basicPercent ?? 50)) / 100;
  const years = gratuityYearsOf(input.joinedOn, input.lastDay);
  const elDays = round1(Math.max(0, input.elRemaining));
  const payInLieu = input.terminationMode === 'pay_in_lieu';
  return {
    encashedElDays: elDays,
    leaveEncashment: round2((elDays * basic) / 30),
    gratuityYears: years,
    gratuity: round2((basic / 26) * 15 * years),
    noticePay: payInLieu ? round2((input.shortfallDays * gross) / 30) : 0,
    noticeRecovery:
      !payInLieu && input.shortfallAction === 'recover'
        ? round2((input.shortfallDays * basic) / 30)
        : 0,
    sickLopDays: round1(input.sickDays),
    sickLopDeduction: round2((input.sickDays * gross) / 30),
    fnfRecovery: round2(input.recoveries),
    loanBalance: round2(input.loanBalance ?? 0),
  };
};

/**
 * What payroll (and the exit drawer) read about exits: which exits a run
 * must handle, each exit's F&F lines, and payroll's recovery lines. The one
 * direction of coupling: payroll imports this; exits never imports payroll.
 */
export const createExitsFnf = (db: DbClient) => {
  const repo = createExitsRepository(db);

  /** Remaining EL as of the last day: accrual to that month, 30-day cap, minus used. */
  const elAsOf = async (employeeId: string, joinedOn: string | null, lastDay: string) => {
    const year = Number(lastDay.slice(0, 4));
    const row = await repo.earnedBalanceRow(employeeId, year);
    const accrued = accruedAllocation('earned', year, {
      joinedOn,
      now: new Date(`${lastDay}T12:00:00`),
    });
    const effective = Math.min(Number(row?.opening ?? 0) + accrued, EL_BALANCE_CAP);
    return effective - Number(row?.used ?? 0);
  };

  const fnfFor = async (exit: ExitRow, ctc: number): Promise<FnfLines> => {
    const person = await repo.person(exit.employeeId);
    const [el, sick, recoveries, loans] = await Promise.all([
      elAsOf(exit.employeeId, person?.date_of_joining ?? null, exit.lastWorkingDay),
      repo.uncertifiedSickDays(exit.employeeId, exit.noticeStartOn, exit.lastWorkingDay),
      repo.recoveries(exit.id),
      repo.loanBalance(exit.employeeId),
    ]);
    return computeFnf({
      ctc,
      basicPercent: person?.basic_percent ? Number(person.basic_percent) : 50,
      joinedOn: person?.date_of_joining ?? null,
      lastDay: exit.lastWorkingDay,
      elRemaining: el,
      shortfallDays: exit.shortfallDays,
      shortfallAction: exit.shortfallAction,
      terminationMode: exit.terminationMode,
      sickDays: Number(sick ?? 0),
      recoveries: recoveries.reduce((acc, r) => acc + Number(r.amount), 0),
      loanBalance: loans,
    });
  };

  return {
    find: repo.find,
    touching: repo.touching,
    fnfFor,
    recoveries: (exitId: string): Promise<RecoveryRow[]> => repo.recoveries(exitId),
    addRecovery: (
      exitId: string,
      line: { label: string; amount: number; note?: string },
      actor: ActorContext & { actorEmployeeId: string },
    ) =>
      repo.addRecovery(
        {
          exitId,
          label: line.label,
          amount: String(line.amount),
          note: line.note ?? null,
          addedBy: actor.actorEmployeeId,
        },
        actor,
      ),
    removeRecovery: repo.removeRecovery,
  };
};

export type ExitsFnf = ReturnType<typeof createExitsFnf>;
