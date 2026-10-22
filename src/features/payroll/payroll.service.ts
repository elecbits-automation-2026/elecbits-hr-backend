import createError from 'http-errors';
import { hasOrgScope } from '../../shared/helpers/helpers.js';
import { EL_BALANCE_CAP, accruedAllocation } from '../../shared/constants/constants.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import type { AttendanceService } from '../attendance/attendance.service.js';
import { NO_FNF, type ExitsFnf, type FnfLines } from '../exits/index.js';
import type { LoanPayment, LoansService } from './loans.service.js';
import type { LeavesService } from '../leaves/leaves.service.js';
import type { SettingValue, SettingsReader } from '../settings/index.js';
import type {
  AnnexureQuery,
  CreateCorrectionInput,
  CreateRunInput,
  FnfRecoveryInput,
  GenerateRunResultDto,
  MyPayslipDto,
  PayrollRunDto,
  PayslipCorrectionDto,
  PayslipDto,
  SalaryAnnexureDto,
  TdsEstimateDto,
  CompensationPersonDto,
  UpdatePayslipInput,
  UpdateTdsInput,
} from './payroll.schema.js';
import type {
  ActorContext,
  PayrollRepository,
  PayrollRunRow,
  PayslipInsert,
  PayslipJoinedRow,
  PayslipRow,
} from './payroll.repository.js';
import { renderPayslipPdf } from './payslip.pdf.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** '2026-11' -> '2026-10'; '2026-01' -> '2025-12'. */
const previousMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, '0')}`;
};
const round1 = (n: number): number => Math.round(n * 10) / 10;
const num = (v: string | null | undefined, fallback = 0): number =>
  v === null || v === undefined ? fallback : Number(v);

/** Auto-coverable leave days still available this year (quota default when no row). */
type Remaining = Record<AutoCoverType, number>;
type AutoCoverType = SettingValue<'payroll.autoCoverLeaveTypes'>[number];

/** Every payroll setting, read once per operation. */
const POLICY_KEYS = [
  'payroll.ptStates',
  'payroll.autoCoverLeaveTypes',
  'payroll.monthEndAutoApprove',
] as const;
type PayrollPolicy = { [K in (typeof POLICY_KEYS)[number]]: SettingValue<K> };

/**
 * Month-end auto-leave: unmarked absence is covered from the balances the
 * payroll.autoCoverLeaveTypes setting lists, in that order (default: EARNED
 * only). 5 unmarked days with 4 EL left = 4 EL + 1 day LOP; with
 * ['earned','sick'] and 2 SL left, 4 EL + 1 SL. Mutates `remaining`.
 */
const splitAbsence = (
  absentDays: number,
  remaining: Remaining,
  order: readonly AutoCoverType[],
) => {
  const taken: Remaining = { earned: 0, sick: 0 };
  let left = absentDays;
  for (const type of order) {
    const use = round1(Math.min(left, Math.max(0, remaining[type])));
    taken[type] = use;
    remaining[type] = round1(remaining[type] - use);
    left = round1(left - use);
  }
  return { el: taken.earned, sl: taken.sick, uncovered: left };
};

/** PT zone match: the base-zone name contains any configured name (case-insensitive). */
type PtStates = SettingValue<'payroll.ptStates'>['states'];

/** The PT state whose zones match this base zone name (first match), or null. */
const ptStateFor = (
  zoneName: string | null | undefined,
  states: PtStates,
): string | null => {
  const name = (zoneName ?? '').toLowerCase();
  if (!name) return null;
  return (
    states.find((st) => st.zoneNames.some((z) => name.includes(z.toLowerCase())))
      ?.state ?? null
  );
};

/** A slip's PT rule: its state's slabs and whether the month is February. */
interface PtRule {
  slabs: PtStates[number]['slabs'];
  february: boolean;
}

const ptRuleFor = (
  state: string | null,
  month: string,
  states: PtStates,
): PtRule | null => {
  const found = state ? states.find((st) => st.state === state) : undefined;
  return found ? { slabs: found.slabs, february: month.slice(5, 7) === '02' } : null;
};

/** Highest slab the prorated salary reaches; February's own amount where set. */
const ptAmount = (rule: PtRule | null, prorated: number): number => {
  if (!rule) return 0;
  const slab = [...rule.slabs]
    .sort((a, b) => b.fromMonthly - a.fromMonthly)
    .find((sl) => prorated >= sl.fromMonthly);
  if (!slab) return 0;
  return rule.february && slab.februaryAmount !== null
    ? slab.februaryAmount
    : slab.amount;
};

/**
 * ERP-sheet payslip model (user decision: reproduce "EB Dummy Sheet — ERP
 * Portal" faithfully, blended PF included):
 *   prorated  J = ctc/12 ÷ 30 × daysPaid           (fixed 30-day base)
 *   basic B% · HRA H% · LTA 10% of J; special = gross − (basic+hra+lta)
 *     (B / H from the person's salary record, default 50 / 25 — close-out)
 *   PF (employee AND employer, identical) =
 *     12% × min(basic, 15000) × 16/30 + 12% × min(basic, 25000) × 14/30
 *     — the sheet's wage-cap transition blend, kept verbatim
 *   gross Q = J − PF(employee);  PT = setting amount (₹200) when PT-eligible
 *     and J ≥ the setting's salary floor (25000)
 *   net  AG = J − (PF×2 + PT + TDS + health insurance + CNPS + other/loan)
 *   final AH = net + reimbursement + bonuses + leave encashment + advance
 */
const SHEET_DAY_BASE = 30;
const PF_RATE = 0.12;
const PF_OLD_CAP = 15000;
const PF_OLD_DAYS = 16;
const PF_NEW_CAP = 25000;
const PF_NEW_DAYS = 14;

const pfOf = (basic: number): number =>
  round2(
    Math.min(basic, PF_OLD_CAP) * (PF_OLD_DAYS / SHEET_DAY_BASE) * PF_RATE +
      Math.min(basic, PF_NEW_CAP) * (PF_NEW_DAYS / SHEET_DAY_BASE) * PF_RATE,
  );

/** The structure split when the salary record leaves it blank. */
export const DEFAULT_BASIC_PCT = 50;
export const DEFAULT_HRA_PCT = 25;
export const LTA_PCT = 10;

interface ComputeInput {
  ctc: number;
  /** Basic and HRA as % of the prorated month (snapshotted on the slip). */
  basicPct: number;
  hraPct: number;
  lopDays: number;
  tds: number;
  otherDeduction: number;
  healthInsurance: number;
  cnpsEmployer: number;
  reimbursement: number;
  performanceBonus: number;
  /** Approved R&R awards from the PREVIOUS month (snapshot at build). */
  recognitionBonus: number;
  otherBonus: number;
  leaveEncashment: number;
  advance: number;
  /** Signed post-finalize corrections to earlier slips (never edited here). */
  correction: number;
  /** F&F earnings (gratuity + notice paid in lieu) — exit slips only. */
  fnfEarnings: number;
  /** F&F deductions (notice shortfall, uncertified sick days, typed recoveries). */
  fnfDeductions: number;
  /** Loan / advance EMIs due this month (the whole balance on an F&F slip). */
  loanEmi: number;
}

/** The F&F lines stored on a slip. */
const fnfOfSlip = (slip: PayslipRow): FnfLines => ({
  encashedElDays: num(slip.encashedElDays),
  leaveEncashment: num(slip.leaveEncashment),
  gratuityYears: slip.gratuityYears,
  gratuity: num(slip.gratuity),
  noticePay: num(slip.noticePay),
  noticeRecovery: num(slip.noticeRecovery),
  sickLopDays: num(slip.sickLopDays),
  sickLopDeduction: num(slip.sickLopDeduction),
  fnfRecovery: num(slip.fnfRecovery),
  // The slip carries the loan balance as its own line (loanEmi).
  loanBalance: 0,
});
const fnfEarningsOf = (f: FnfLines) => round2(f.gratuity + f.noticePay);
const fnfDeductionsOf = (f: FnfLines) =>
  round2(f.noticeRecovery + f.sickLopDeduction + f.fnfRecovery);
/** The F&F columns to write onto a slip. */
const fnfColumns = (f: FnfLines) => ({
  encashedElDays: String(f.encashedElDays),
  gratuityYears: f.gratuityYears,
  gratuity: String(f.gratuity),
  noticePay: String(f.noticePay),
  noticeRecovery: String(f.noticeRecovery),
  sickLopDays: String(f.sickLopDays),
  sickLopDeduction: String(f.sickLopDeduction),
  fnfRecovery: String(f.fnfRecovery),
});

/**
 * The PT amount is NOT snapshotted (only the state is): a draft picks up a
 * changed payroll.ptStates slab when it is next edited or finalized.
 */
const compute = (input: ComputeInput, pt: PtRule | null) => {
  const monthlyGross = round2(input.ctc / 12);
  const daysPaid = Math.max(0, SHEET_DAY_BASE - input.lopDays);
  const prorated = round2((monthlyGross / SHEET_DAY_BASE) * daysPaid);
  const basic = round2((prorated * input.basicPct) / 100);
  const hra = round2((prorated * input.hraPct) / 100);
  const lta = round2((prorated * LTA_PCT) / 100);
  const pfEmployee = pfOf(basic);
  const pfEmployer = pfOf(basic);
  const gross = round2(prorated - pfEmployee);
  const specialAllowance = round2(gross - basic - hra - lta);
  const professionalTax = ptAmount(pt, prorated);
  const lopAmount = round2(monthlyGross - prorated);
  const earningsTotal = prorated;
  const deductionsTotal = round2(
    pfEmployee +
      pfEmployer +
      professionalTax +
      input.tds +
      input.healthInsurance +
      input.cnpsEmployer +
      input.otherDeduction,
  );
  const netPay = Math.max(0, round2(prorated - deductionsTotal));
  const finalPay = round2(
    netPay +
      input.reimbursement +
      input.performanceBonus +
      input.recognitionBonus +
      input.otherBonus +
      input.leaveEncashment +
      input.advance +
      input.correction +
      input.fnfEarnings -
      input.fnfDeductions -
      input.loanEmi,
  );
  return {
    monthlyGross,
    basic,
    hra,
    lta,
    specialAllowance,
    pfEmployee,
    pfEmployer,
    professionalTax,
    lopAmount,
    earningsTotal,
    deductionsTotal,
    netPay,
    finalPay,
  };
};

/**
 * TDS calculator (ERP sheet, "TDS" tab — new tax regime):
 *   FY months = (FY close − DOJ)/30 capped at 12; FY CTC = ctc × months/12
 *   taxable = FY CTC − standard deduction 75,000 − employer PF (1,800/month)
 *             − CNPS (FY CTC × 50% basic share × CNPS%)
 *   tax: nil to 12L (rebate); then 4–8L 5%, 8–12L 10%, 12–16L 15%,
 *        16–20L 20%, 20–24L 25%, above 30% — all × 1.04 cess
 *   revised TDS = (total tax − already deducted this FY) ÷ months left.
 */
const TDS_STD_DEDUCTION = 75_000;
const TDS_EMPLOYER_PF_MONTHLY = 1_800;
const TDS_CESS = 1.04;
const TDS_REBATE_LIMIT = 1_200_000;

const slabTax = (p: number): number => {
  if (p <= 400_000) return 0;
  if (p <= 800_000) return (p - 400_000) * 0.05;
  if (p <= 1_200_000) return 20_000 + (p - 800_000) * 0.1;
  if (p <= 1_600_000) return 60_000 + (p - 1_200_000) * 0.15;
  if (p <= 2_000_000) return 120_000 + (p - 1_600_000) * 0.2;
  if (p <= 2_400_000) return 200_000 + (p - 2_000_000) * 0.25;
  return 300_000 + (p - 2_400_000) * 0.3;
};

/**
 * New-regime surcharge (statutory, kept in code like the slabs): 10% above
 * ₹50L, 15% above ₹1Cr, 25% above ₹2Cr (the new regime's cap). Marginal
 * relief at each line: tax + surcharge never exceeds the tax + surcharge AT
 * the line plus the income above it — so ₹50,10,000 owes ₹10,90,000 before
 * cess, not ₹11,91,300.
 */
const SURCHARGE_BANDS: ReadonlyArray<readonly [threshold: number, rate: number]> = [
  [20_000_000, 0.25],
  [10_000_000, 0.15],
  [5_000_000, 0.1],
];

const taxWithSurcharge = (taxable: number): { base: number; surcharge: number } => {
  const base = slabTax(taxable);
  const band = SURCHARGE_BANDS.find(([t]) => taxable > t);
  if (!band) return { base, surcharge: 0 };
  const [threshold, rate] = band;
  const atLine = taxWithSurcharge(threshold);
  const capped = Math.min(
    base * (1 + rate),
    atLine.base + atLine.surcharge + (taxable - threshold),
  );
  return { base, surcharge: Math.max(0, capped - base) };
};

/**
 * Total tax for a taxable income: rebate to 12L, slabs, surcharge, 4% cess —
 * WITH marginal relief at the rebate line, which the sheet lacks (review doc
 * §8): just above 12L the tax before cess cannot exceed the income above it,
 * so ₹12,10,000 owes ₹10,400 (10,000 × 1.04), not the sheet's ₹63,960.
 */
const taxBreakdown = (taxable: number): { surcharge: number; total: number } => {
  if (taxable <= TDS_REBATE_LIMIT) return { surcharge: 0, total: 0 };
  const { base, surcharge } = taxWithSurcharge(taxable);
  // Rebate marginal relief: just above 12L, tax cannot exceed the income above it.
  const beforeCess = Math.min(base + surcharge, taxable - TDS_REBATE_LIMIT);
  return {
    surcharge: round2(Math.max(0, beforeCess - Math.min(base, beforeCess))),
    total: round2(beforeCess * TDS_CESS),
  };
};

/** The Indian FY around `now`: April 1 start, March 31 close. */
const fyBounds = (now = new Date()) => {
  const fyStartYear = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    startMonth: `${fyStartYear}-04`,
    endMonth: `${fyStartYear + 1}-03`,
    close: `${fyStartYear + 1}-03-31`,
    monthsRemaining: Math.min(
      12,
      Math.max(
        1,
        (fyStartYear + 1) * 12 + 3 - (now.getFullYear() * 12 + now.getMonth() + 1) + 1,
      ),
    ),
  };
};

const toRun = (
  row: PayrollRunRow,
  payslipCount: number,
  netTotal: number,
): PayrollRunDto => ({
  id: row.id,
  month: row.month,
  status: row.status,
  payslipCount,
  netTotal,
  createdAt: row.createdAt.toISOString(),
  finalizedAt: row.finalizedAt?.toISOString() ?? null,
  paidAt: row.paidAt?.toISOString() ?? null,
});

type CorrectionListRow = Awaited<
  ReturnType<PayrollRepository['listCorrections']>
>[number];

const toCorrection = (r: CorrectionListRow): PayslipCorrectionDto => ({
  id: r.row.id,
  employee: { id: r.row.employeeId, name: r.employeeName, employeeCode: r.employeeCode },
  sourcePayslipId: r.row.sourcePayslipId,
  sourceMonth: r.row.sourceMonth,
  amount: num(r.row.amount),
  reason: r.row.reason,
  status: r.row.status,
  appliedMonth: r.appliedMonth ?? null,
  createdByName: r.createdByName,
  createdAt: r.row.createdAt.toISOString(),
});

/**
 * Which corrections a slip CARRIES (a draft: the pending ones from earlier
 * months; a published run: the ones applied to it) and which were recorded
 * AGAINST it.
 */
const correctionsFor = (
  slip: { id: string; employeeId: string },
  run: { id: string; month: string; status: PayrollRunRow['status'] },
  all: PayslipCorrectionDto[],
): Pick<PayslipDto, 'corrections' | 'correctedBy'> => ({
  corrections: all
    .filter(
      (c) =>
        c.employee.id === slip.employeeId &&
        (run.status === 'draft'
          ? c.status === 'pending' && c.sourceMonth < run.month
          : c.status === 'applied' && c.appliedMonth === run.month),
    )
    .map((c) => ({
      id: c.id,
      sourceMonth: c.sourceMonth,
      amount: c.amount,
      reason: c.reason,
    })),
  correctedBy: all
    .filter((c) => c.sourcePayslipId === slip.id)
    .map((c) => ({
      id: c.id,
      amount: c.amount,
      reason: c.reason,
      status: c.status,
      appliedMonth: c.appliedMonth,
    })),
});

type ClaimLine = Awaited<ReturnType<PayrollRepository['claimsFor']>>[number];

/** The claims a slip carries: approved-unpaid while a draft, paid-by-it once published. */
const claimsOn = (
  slip: { employeeId: string },
  run: { id: string; month: string; status: PayrollRunRow['status'] },
  claims: ClaimLine[],
): PayslipDto['reimbursementClaims'] =>
  claims
    .filter(
      (c) =>
        c.employeeId === slip.employeeId &&
        (run.status === 'draft'
          ? c.status === 'approved' && c.spentOn.slice(0, 7) <= run.month
          : c.paidRunId === run.id),
    )
    .map((c) => ({
      id: c.id,
      spentOn: c.spentOn,
      category: c.category,
      description: c.description,
      amount: num(c.amount),
    }));

type SlipLines = Pick<PayslipDto, 'corrections' | 'correctedBy' | 'reimbursementClaims'>;

const toPayslip = (
  row: PayslipJoinedRow,
  lines: SlipLines = { corrections: [], correctedBy: [], reimbursementClaims: [] },
): PayslipDto => ({
  id: row.id,
  runId: row.runId,
  employee: {
    id: row.employeeId,
    name: row.employeeName,
    employeeCode: row.employeeCode,
  },
  currency: row.currency,
  basicPercent: num(row.basicPercent),
  hraPercent: num(row.hraPercent),
  monthlyGross: num(row.monthlyGross),
  basic: num(row.basic),
  hra: num(row.hra),
  lta: num(row.lta),
  specialAllowance: num(row.specialAllowance),
  workingDays: num(row.workingDays),
  lopDays: num(row.lopDays),
  lopAmount: num(row.lopAmount),
  autoElDays: num(row.autoElDays),
  autoSlDays: num(row.autoSlDays),
  autoClDays: num(row.autoClDays),
  lopOverridden: row.lopOverridden,
  pf: num(row.pf),
  pfEmployer: num(row.pfEmployer),
  tds: num(row.tds),
  professionalTax: num(row.professionalTax),
  otherDeduction: num(row.otherDeduction),
  healthInsurance: num(row.healthInsurance),
  cnpsEmployer: num(row.cnpsEmployer),
  reimbursement: num(row.reimbursement),
  performanceBonus: num(row.performanceBonus),
  recognitionBonus: num(row.recognitionBonus),
  otherBonus: num(row.otherBonus),
  leaveEncashment: num(row.leaveEncashment),
  advance: num(row.advance),
  loanEmi: num(row.loanEmi),
  exitId: row.exitId,
  encashedElDays: num(row.encashedElDays),
  gratuityYears: row.gratuityYears,
  gratuity: num(row.gratuity),
  noticePay: num(row.noticePay),
  noticeRecovery: num(row.noticeRecovery),
  sickLopDays: num(row.sickLopDays),
  sickLopDeduction: num(row.sickLopDeduction),
  fnfRecovery: num(row.fnfRecovery),
  earningsTotal: num(row.earningsTotal),
  deductionsTotal: num(row.deductionsTotal),
  netPay: num(row.netPay),
  correction: num(row.correction),
  ptState: row.ptState,
  ...lines,
  finalPay: num(row.finalPay),
});

/**
 * Payroll rules: one run per month, Draft → Finalized → Paid. Finalizing
 * locks every payslip and publishes them to employees; nothing re-derives
 * after that. LOP comes from the attendance classifier IN-PROCESS (no HTTP,
 * no hrbp.attendance grant needed): absent days + unpaid-leave days.
 */
export const createPayrollService = (deps: {
  repo: PayrollRepository;
  attendance: AttendanceService;
  leaves: LeavesService;
  settings: SettingsReader;
  exits: ExitsFnf;
  authz: AuthzRepository;
  loans: LoansService;
}) => {
  const { repo, attendance, leaves, settings, exits, authz, loans } = deps;

  type Touching = Awaited<ReturnType<ExitsFnf['touching']>>[number];

  const monthEndOf = (month: string) => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  };

  /**
   * LOP for one slip (exit module on top of the month-end model):
   *  - a leaver's month after their last day is not paid (scaled to the
   *    30-day base) and their absences stop at that day;
   *  - anyone in notice or leaving is never auto-covered from balances —
   *    every EL day is encashed in the F&F instead, so absence is LOP;
   *  - an F&F-only slip (last day in an earlier month) pays no salary;
   *  - a joiner's days before their joining date are not paid either.
   */
  const lopFor = (
    view: Parameters<typeof absenceOf>[0],
    month: string,
    exit: Touching | undefined,
    inNotice: boolean,
    remaining: Remaining,
    order: PayrollPolicy['payroll.autoCoverLeaveTypes'],
    joinedOn: string | null = null,
  ) => {
    if (exit && exit.last_working_day < `${month}-01`) {
      return { lopDays: SHEET_DAY_BASE, split: { el: 0, sl: 0, uncovered: 0 } };
    }
    const { absent, unpaid } = absenceOf(view);
    const daysInMonth = Number(monthEndOf(month).slice(8, 10));
    const after =
      exit && exit.last_working_day.slice(0, 7) === month
        ? round1(
            (SHEET_DAY_BASE * (daysInMonth - Number(exit.last_working_day.slice(8, 10)))) /
              daysInMonth,
          )
        : 0;
    const before =
      joinedOn && joinedOn.slice(0, 7) === month
        ? round1((SHEET_DAY_BASE * (Number(joinedOn.slice(8, 10)) - 1)) / daysInMonth)
        : 0;
    const split =
      exit || inNotice
        ? { el: 0, sl: 0, uncovered: absent }
        : splitAbsence(absent, remaining, order);
    return {
      lopDays: Math.min(SHEET_DAY_BASE, round1(split.uncovered + unpaid + after + before)),
      split,
    };
  };

  /** F&F lines for a settleable exit (null when it can't ride this run). */
  const fnfLinesFor = async (t: Touching | undefined, ctc: number): Promise<FnfLines | null> => {
    if (!t?.settleable) return null;
    const exit = await exits.find(t.exit_id);
    return exit ? exits.fnfFor(exit, ctc) : null;
  };

  const loadPolicy = (): Promise<PayrollPolicy> => settings.effectiveMany(POLICY_KEYS);

  /**
   * MONTH-END policy (payroll.monthEndAutoApprove, default both on):
   * processing a month first auto-approves every request still
   * `partially_approved` for it — leave (with the normal balance deduction;
   * insufficient balance skips the request so its days fall to auto-cover/LOP)
   * and remote work. Runs before payslips are built so the classifier already
   * sees the approvals. A switched-off kind is left for humans to decide.
   */
  const sweepPartialApprovals = async (
    month: string,
    actor: ActorContext,
    policy: PayrollPolicy,
  ): Promise<void> => {
    const sweep = policy['payroll.monthEndAutoApprove'];
    if (sweep.leaves) await leaves.autoApproveMonthEnd(month, actor);
    if (sweep.remote) await attendance.autoApproveRemoteMonthEnd(month, actor);
  };

  const requireRun = async (id: string): Promise<PayrollRunRow> => {
    const run = await repo.findRunById(id);
    if (!run) throw createError(404, 'Payroll run not found', { code: 'RUN_NOT_FOUND' });
    return run;
  };

  /** RUN_CONFLICT (status changed under us, M5) → retryable 409. */
  const mapRunConflict = (err: unknown): never => {
    if ((err as { code?: string }).code === 'RUN_CONFLICT') {
      throw createError(
        409,
        'This run was just changed by someone else — refresh and retry',
        {
          code: 'RUN_CONFLICT',
        },
      );
    }
    throw err;
  };

  const requireStatus = (run: PayrollRunRow, status: PayrollRunRow['status']): void => {
    if (run.status !== status) {
      throw createError(409, `This run is ${run.status}, not ${status}`, {
        code: 'WRONG_RUN_STATUS',
      });
    }
  };

  /** Remaining balances per employee for the auto-leave split. */
  const loadRemaining = async (employeeIds: string[], year: number) => {
    const [rows, joined] = await Promise.all([
      repo.listBalancesFor(employeeIds, year),
      repo.joiningDates(employeeIds),
    ]);
    const map = new Map<string, Remaining>();
    for (const id of employeeIds) {
      // No row yet: the lazy accrual hasn't run for them — assume accrued-to-date
      // (sick prorated in the joining year).
      map.set(id, {
        earned: accruedAllocation('earned', year, { joinedOn: joined.get(id) ?? null }),
        sick: accruedAllocation('sick', year, { joinedOn: joined.get(id) ?? null }),
      });
    }
    for (const r of rows) {
      const rem = map.get(r.employeeId);
      if (!rem) continue;
      if (r.type === 'earned') {
        // Carry-forward counts; the 30-day cap lapses the excess (policy §9.3a).
        const effective = Math.min(num(r.opening) + num(r.allocated), EL_BALANCE_CAP);
        rem.earned = round1(effective - num(r.used));
      } else if (r.type === 'sick') {
        rem.sick = round1(num(r.opening) + num(r.allocated) - num(r.used));
      }
    }
    return map;
  };

  /** Absent + unpaid-leave days for one classified month view. */
  const absenceOf = (
    view:
      | {
          summary: { absent: number };
          days: Array<{ status: string; leaveType: string | null }>;
        }
      | undefined,
  ) => {
    const absent = view?.summary.absent ?? 0;
    const unpaid = (view?.days ?? []).reduce(
      (acc, d) =>
        d.leaveType === 'unpaid' ? acc + (d.status === 'half_leave' ? 0.5 : 1) : acc,
      0,
    );
    return { absent, unpaid };
  };

  /**
   * Draft payslip rows for every employee on payroll with a CTC (others
   * skipped): active and in-notice people, leavers whose last day falls in
   * the month, and leavers whose F&F is ready to ride this run.
   */
  const buildPayslips = async (month: string, policy: PayrollPolicy) => {
    const monthStart = `${month}-01`;
    const touching = await exits.touching(monthEndOf(month));
    const exitBy = new Map(touching.map((t) => [t.employee_id, t]));
    // A leaver from an earlier month only comes back for a ready F&F.
    const wanted = (t: Touching | undefined) =>
      !t || t.last_working_day >= monthStart || t.settleable;
    const base = (await repo.listActiveWithSalary()).filter((p) => wanted(exitBy.get(p.id)));
    const extraIds = touching
      .filter((t) => wanted(t) && !base.some((p) => p.id === t.employee_id))
      .map((t) => t.employee_id);
    const people = [...base, ...(extraIds.length ? await repo.listActiveWithSalary(extraIds) : [])];
    const lastDays = new Map(
      touching
        .filter((t) => t.last_working_day.slice(0, 7) === month)
        .map((t) => [t.employee_id, t.last_working_day]),
    );

    const [months, awards, corrections, claims] = await Promise.all([
      attendance.peopleMonth(people, month, lastDays),
      // R&R awards approved LAST month pay this month (approval month + 1).
      repo.recognitionAwardsApprovedIn(previousMonth(month)),
      // Every still-pending correction to an earlier month rides on this slip.
      repo.pendingCorrectionsBefore(month),
      // Approved reimbursement claims spent by this month (the claim trail).
      repo.approvedClaimsUpTo(month),
    ]);
    const byEmployee = new Map(months.map((m) => [m.employee.id, m]));
    const remaining = await loadRemaining(
      people.map((p) => p.id),
      Number(month.slice(0, 4)),
    );

    const slips: Omit<PayslipInsert, 'runId'>[] = [];
    const skipped: Array<{ id: string; name: string; employeeCode: string }> = [];

    // F&F first: whoever settles this run repays every loan in full.
    const fnfBy = new Map<string, FnfLines>();
    for (const p of people) {
      if (p.ctc === null || p.ctc === undefined) continue;
      const f = await fnfLinesFor(exitBy.get(p.id), num(p.ctc));
      if (f) fnfBy.set(p.id, f);
    }
    const loanDue = await loans.dueFor(
      people.map((p) => p.id),
      month,
      new Set(fnfBy.keys()),
    );

    for (const p of people) {
      if (p.ctc === null || p.ctc === undefined) {
        skipped.push({ id: p.id, name: p.name, employeeCode: p.employeeCode });
        continue;
      }
      const view = byEmployee.get(p.id);
      const summary = view?.summary;
      const daysInMonth = view?.days.length ?? 30;
      const workingDays = daysInMonth - (summary?.weekend ?? 0) - (summary?.holiday ?? 0);
      const exit = exitBy.get(p.id);
      // Month-end auto-leave (provisional — finalize recomputes for real):
      // absence is covered from the configured balances; unpaid leave is
      // always LOP. Leavers and people in notice are never auto-covered.
      const { lopDays, split } = lopFor(
        view,
        month,
        exit,
        p.status === 'exiting',
        remaining.get(p.id) ?? { earned: 0, sick: 0 },
        policy['payroll.autoCoverLeaveTypes'],
        p.dateOfJoining,
      );
      const fnf = fnfBy.get(p.id) ?? null;
      const lines = fnf ?? NO_FNF;

      // PT location rule, SNAPSHOTTED: the slip never re-derives from the
      // live zone (§12). Matched by base-zone name (payroll.ptZones).
      const ptState = ptStateFor(p.baseZoneName, policy['payroll.ptStates'].states);
      const input: ComputeInput = {
        ctc: num(p.ctc),
        basicPct: num(p.basicPercent, DEFAULT_BASIC_PCT),
        hraPct: num(p.hraPercent, DEFAULT_HRA_PCT),
        lopDays,
        tds: num(p.tdsAmount),
        otherDeduction: num(p.otherDeductionAmount),
        // Per-month adjustments start at zero — PR fills them on the draft.
        healthInsurance: 0,
        cnpsEmployer: 0,
        reimbursement: round2(claims.get(p.id) ?? 0),
        performanceBonus: 0,
        recognitionBonus: awards.get(p.id) ?? 0,
        otherBonus: 0,
        leaveEncashment: lines.leaveEncashment,
        advance: 0,
        correction: round2(corrections.get(p.id) ?? 0),
        fnfEarnings: fnfEarningsOf(lines),
        fnfDeductions: fnfDeductionsOf(lines),
        loanEmi: loanDue.get(p.id)?.total ?? 0,
      };
      const c = compute(
        input,
        ptRuleFor(ptState, month, policy['payroll.ptStates'].states),
      );
      slips.push({
        employeeId: p.id,
        ctc: String(input.ctc),
        currency: p.currency ?? 'INR',
        basicPercent: String(input.basicPct),
        hraPercent: String(input.hraPct),
        monthlyGross: String(c.monthlyGross),
        basic: String(c.basic),
        hra: String(c.hra),
        lta: String(c.lta),
        specialAllowance: String(c.specialAllowance),
        workingDays: String(workingDays),
        lopDays: String(lopDays),
        lopAmount: String(c.lopAmount),
        autoElDays: String(split.el),
        autoSlDays: String(split.sl),
        // Casual is retired — never auto-consumed.
        autoClDays: '0',
        pf: String(c.pfEmployee),
        pfEmployer: String(c.pfEmployer),
        tds: String(input.tds),
        professionalTax: String(c.professionalTax),
        ptEligible: ptState !== null,
        ptState,
        otherDeduction: String(input.otherDeduction),
        healthInsurance: '0',
        cnpsEmployer: '0',
        reimbursement: String(input.reimbursement),
        performanceBonus: '0',
        recognitionBonus: String(input.recognitionBonus),
        otherBonus: '0',
        leaveEncashment: String(lines.leaveEncashment),
        advance: '0',
        correction: String(input.correction),
        exitId: fnf ? exit!.exit_id : null,
        ...fnfColumns(lines),
        loanEmi: String(input.loanEmi),
        earningsTotal: String(c.earningsTotal),
        deductionsTotal: String(c.deductionsTotal),
        netPay: String(c.netPay),
        finalPay: String(c.finalPay),
      });
    }
    return { slips, skipped };
  };

  const getRun = async (
    id: string,
  ): Promise<{ run: PayrollRunDto; payslips: PayslipDto[] }> => {
    const run = await requireRun(id);
    const rows = await repo.listPayslipsForRun(id);
    const ids = rows.map((r) => r.employeeId);
    const [corrections, claims] = await Promise.all([
      repo.listCorrections({ employeeIds: ids }),
      repo.claimsFor(ids),
    ]);
    const all = corrections.map(toCorrection);
    const slips = rows.map((r) =>
      toPayslip(r, {
        ...correctionsFor(r, run, all),
        reimbursementClaims: claimsOn(r, run, claims),
      }),
    );
    const netTotal = round2(slips.reduce((acc, s) => acc + s.netPay, 0));
    return { run: toRun(run, slips.length, netTotal), payslips: slips };
  };

  const listRuns = async (): Promise<PayrollRunDto[]> => {
    const rows = await repo.listRuns();
    return rows.map((r) =>
      toRun(
        {
          id: r.id,
          month: r.month,
          status: r.status,
          createdAt: new Date(r.created_at),
          finalizedAt: r.finalized_at ? new Date(r.finalized_at) : null,
          paidAt: r.paid_at ? new Date(r.paid_at) : null,
          generatedBy: '',
          finalizedBy: null,
          paidBy: null,
        },
        Number(r.payslip_count),
        num(r.net_total),
      ),
    );
  };

  const generate = async (
    input: CreateRunInput,
    actor: ActorContext,
  ): Promise<GenerateRunResultDto> => {
    if (await repo.findRunByMonth(input.month)) {
      throw createError(409, 'A payroll run already exists for this month', {
        code: 'RUN_EXISTS',
      });
    }
    const policy = await loadPolicy();
    await sweepPartialApprovals(input.month, actor, policy);
    const { slips, skipped } = await buildPayslips(input.month, policy);
    const run = await repo.insertRunWithPayslips(input.month, slips, actor);
    const full = await getRun(run.id);
    return { ...full, skipped };
  };

  const regenerate = async (
    id: string,
    actor: ActorContext,
  ): Promise<GenerateRunResultDto> => {
    const run = await requireRun(id);
    requireStatus(run, 'draft');
    const policy = await loadPolicy();
    await sweepPartialApprovals(run.month, actor, policy);
    const { slips, skipped } = await buildPayslips(run.month, policy);
    await repo.replacePayslips(id, run.month, slips, actor).catch(mapRunConflict);
    const full = await getRun(id);
    return { ...full, skipped };
  };

  const updatePayslip = async (
    runId: string,
    payslipId: string,
    input: UpdatePayslipInput,
    actor: ActorContext,
  ): Promise<PayslipDto> => {
    const run = await requireRun(runId);
    requireStatus(run, 'draft');
    const slip = await repo.findPayslip(payslipId);
    if (!slip || slip.runId !== runId) {
      throw createError(404, 'Payslip not found in this run', {
        code: 'PAYSLIP_NOT_FOUND',
      });
    }

    // PF and PT are COMPUTED by the sheet model (never edited); everything a
    // human types on the sheet — TDS, loan/recovery, insurance, CNPS and the
    // earnings-side adjustments — merges over the stored slip.
    const merged: ComputeInput = {
      ctc: num(slip.ctc),
      basicPct: num(slip.basicPercent),
      hraPct: num(slip.hraPercent),
      lopDays: input.lopDays ?? num(slip.lopDays),
      tds: input.tds ?? num(slip.tds),
      otherDeduction: input.otherDeduction ?? num(slip.otherDeduction),
      healthInsurance: input.healthInsurance ?? num(slip.healthInsurance),
      cnpsEmployer: input.cnpsEmployer ?? num(slip.cnpsEmployer),
      // Approved claims only — never typed on the draft (Phase 3).
      reimbursement: num(slip.reimbursement),
      performanceBonus: input.performanceBonus ?? num(slip.performanceBonus),
      recognitionBonus: num(slip.recognitionBonus),
      otherBonus: input.otherBonus ?? num(slip.otherBonus),
      leaveEncashment: input.leaveEncashment ?? num(slip.leaveEncashment),
      advance: input.advance ?? num(slip.advance),
      correction: num(slip.correction),
      fnfEarnings: fnfEarningsOf(fnfOfSlip(slip)),
      fnfDeductions: fnfDeductionsOf(fnfOfSlip(slip)),
      loanEmi: num(slip.loanEmi),
    };
    const c = compute(
      merged,
      ptRuleFor(
        slip.ptState,
        run.month,
        (await settings.effective('payroll.ptStates')).states,
      ),
    );

    const updated = await repo
      .updatePayslip(
        payslipId,
        {
          lopDays: String(merged.lopDays),
          lopAmount: String(c.lopAmount),
          // A manual LOP edit takes control: the auto-leave split is zeroed and
          // finalize will not recompute it for this slip (user decision).
          ...(input.lopDays !== undefined
            ? { lopOverridden: true, autoElDays: '0', autoSlDays: '0', autoClDays: '0' }
            : {}),
          basic: String(c.basic),
          hra: String(c.hra),
          lta: String(c.lta),
          specialAllowance: String(c.specialAllowance),
          pf: String(c.pfEmployee),
          pfEmployer: String(c.pfEmployer),
          tds: String(merged.tds),
          professionalTax: String(c.professionalTax),
          otherDeduction: String(merged.otherDeduction),
          healthInsurance: String(merged.healthInsurance),
          cnpsEmployer: String(merged.cnpsEmployer),
          reimbursement: String(merged.reimbursement),
          performanceBonus: String(merged.performanceBonus),
          otherBonus: String(merged.otherBonus),
          leaveEncashment: String(merged.leaveEncashment),
          advance: String(merged.advance),
          earningsTotal: String(c.earningsTotal),
          deductionsTotal: String(c.deductionsTotal),
          netPay: String(c.netPay),
          finalPay: String(c.finalPay),
        },
        Object.keys(input),
        actor,
      )
      .catch(mapRunConflict);
    const slips = await repo.listPayslipsForRun(runId);
    const joined = slips.find((s) => s.id === updated.id)!;
    return toPayslip(joined);
  };

  /**
   * Finalize = the month-end moment (user decision): the auto-leave split is
   * recomputed against LIVE balances and charged for real, LOP/totals are
   * rewritten, then everything locks. Slips whose LOP was manually overridden
   * are passed through untouched.
   */
  const finalize = async (id: string, actor: ActorContext): Promise<PayrollRunDto> => {
    const run = await requireRun(id);
    requireStatus(run, 'draft');

    // M7 guard: a request still partially approved for this month would be
    // auto-approved on a re-pull — finalizing past it would charge those days
    // as auto-cover now AND deduct the balance again when the second approver
    // lands. Force the draft to be re-pulled (or the requests decided) first.
    // A kind whose month-end sweep is switched off can only be decided.
    const [leavePartials, remotePartials, policy] = await Promise.all([
      leaves.pendingMonthEndPartials(run.month),
      attendance.pendingRemoteMonthEndPartials(run.month),
      loadPolicy(),
    ]);
    if (leavePartials + remotePartials > 0) {
      const sweep = policy['payroll.monthEndAutoApprove'];
      const repullClears =
        (leavePartials === 0 || sweep.leaves) && (remotePartials === 0 || sweep.remote);
      throw createError(
        409,
        repullClears
          ? `${leavePartials + remotePartials} request(s) for ${run.month} are still partially approved — use "Re-pull from attendance" (or decide them) before finalizing`
          : `${leavePartials + remotePartials} request(s) for ${run.month} are still partially approved and month-end auto-approval is off — decide them before finalizing`,
        { code: 'PARTIAL_APPROVALS_PENDING' },
      );
    }

    const slips = await repo.listPayslipsForRun(id);
    const year = Number(run.month.slice(0, 4));
    const touching = await exits.touching(monthEndOf(run.month));
    const exitBy = new Map(touching.map((t) => [t.employee_id, t]));
    const lastDays = new Map(
      touching
        .filter((t) => t.last_working_day.slice(0, 7) === run.month)
        .map((t) => [t.employee_id, t.last_working_day]),
    );
    const [months, remaining, statuses, joined] = await Promise.all([
      attendance.peopleMonth(
        slips.map((s) => ({ id: s.employeeId, name: s.employeeName, employeeCode: s.employeeCode })),
        run.month,
        lastDays,
      ),
      loadRemaining(
        slips.map((s) => s.employeeId),
        year,
      ),
      repo.statusesOf(slips.map((s) => s.employeeId)),
      repo.joiningDates(slips.map((s) => s.employeeId)),
    ]);
    const byEmployee = new Map(months.map((m) => [m.employee.id, m]));

    // Every F&F this run carries must be ready: the leaver relieved, HR /
    // manager / OPS cleared — and nobody settles their own.
    const settleExits: string[] = [];
    for (const slip of slips.filter((sl) => sl.exitId)) {
      const t = exitBy.get(slip.employeeId);
      const exit = await exits.find(slip.exitId!);
      if (slip.employeeId === actor.actorEmployeeId) {
        throw createError(403, 'Someone else must finalize the run that carries your own F&F', {
          code: 'NO_SELF_SETTLEMENT',
        });
      }
      if (!exit || exit.status !== 'relieved') {
        throw createError(
          409,
          `${slip.employeeName}'s exit is not relieved yet (the exit-day job runs after the last working day) — run it, or re-pull`,
          { code: 'EXIT_NOT_RELIEVED' },
        );
      }
      if (!t?.settleable) {
        throw createError(
          409,
          `${slip.employeeName}'s HR, manager or OPS clearance is no longer done — re-pull`,
          { code: 'EXIT_CLEARANCES_PENDING' },
        );
      }
      settleExits.push(exit.id);
    }

    // Loans: an instalment each, or the whole balance on an F&F slip.
    const loanDue = await loans.dueFor(
      slips.map((s) => s.employeeId),
      run.month,
      new Set(slips.filter((s) => s.exitId).map((s) => s.employeeId)),
    );
    const loanPayments: LoanPayment[] = [...loanDue.values()].flatMap((d) => d.payments);

    const updates = [];
    for (const slip of slips) {
      const view = byEmployee.get(slip.employeeId);
      const exit = exitBy.get(slip.employeeId);
      const fnf = slip.exitId
        ? await exits.fnfFor((await exits.find(slip.exitId))!, num(slip.ctc))
        : null;
      const lines = fnf ?? fnfOfSlip(slip);
      const recomputeLop = !slip.lopOverridden && !!view;
      const { lopDays, split } = recomputeLop
        ? lopFor(
            view,
            run.month,
            exit,
            statuses.get(slip.employeeId) === 'exiting',
            remaining.get(slip.employeeId) ?? { earned: 0, sick: 0 },
            policy['payroll.autoCoverLeaveTypes'],
            joined.get(slip.employeeId) ?? null,
          )
        : { lopDays: num(slip.lopDays), split: { el: 0, sl: 0, uncovered: 0 } };
      // Recompute the WHOLE slip with the sheet engine at the final LOP — the
      // structure split, PF and PT all move with the prorated salary.
      const c = compute(
        {
          ctc: num(slip.ctc),
          basicPct: num(slip.basicPercent),
          hraPct: num(slip.hraPercent),
          lopDays,
          tds: num(slip.tds),
          otherDeduction: num(slip.otherDeduction),
          healthInsurance: num(slip.healthInsurance),
          cnpsEmployer: num(slip.cnpsEmployer),
          reimbursement: num(slip.reimbursement),
          performanceBonus: num(slip.performanceBonus),
          recognitionBonus: num(slip.recognitionBonus),
          otherBonus: num(slip.otherBonus),
          leaveEncashment: fnf ? fnf.leaveEncashment : num(slip.leaveEncashment),
          advance: num(slip.advance),
          correction: num(slip.correction),
          fnfEarnings: fnfEarningsOf(lines),
          fnfDeductions: fnfDeductionsOf(lines),
          loanEmi: loanDue.get(slip.employeeId)?.total ?? 0,
        },
        ptRuleFor(slip.ptState, run.month, policy['payroll.ptStates'].states),
      );
      updates.push({
        id: slip.id,
        employeeId: slip.employeeId,
        year,
        autoEl: recomputeLop ? split.el : 0,
        autoSl: recomputeLop ? split.sl : 0,
        lopDays: String(lopDays),
        lopAmount: String(c.lopAmount),
        money: {
          basic: String(c.basic),
          hra: String(c.hra),
          lta: String(c.lta),
          specialAllowance: String(c.specialAllowance),
          pf: String(c.pfEmployee),
          pfEmployer: String(c.pfEmployer),
          professionalTax: String(c.professionalTax),
          loanEmi: String(loanDue.get(slip.employeeId)?.total ?? 0),
          ...(fnf ? { leaveEncashment: String(fnf.leaveEncashment), ...fnfColumns(fnf) } : {}),
        } as Record<string, string | number>,
        earningsTotal: String(c.earningsTotal),
        deductionsTotal: String(c.deductionsTotal),
        netPay: String(c.netPay),
        finalPay: String(c.finalPay),
      });
    }

    // A recovery larger than the month's pay can't be carried — PR splits it.
    const negative = updates.filter((u) => num(u.finalPay) < 0);
    if (negative.length > 0) {
      const names = slips
        .filter((sl) => negative.some((u) => u.id === sl.id))
        .map((sl) => sl.employeeName);
      throw createError(
        409,
        `A recovery is larger than this month's pay for ${names.join(', ')} — cancel it and record a smaller one, then carry the rest next month`,
        { code: 'RECOVERY_EXCEEDS_PAY' },
      );
    }

    try {
      const updated = await repo.finalizeRun(run, updates, actor, settleExits, loanPayments);
      const { run: dto } = await getRun(updated.id);
      return dto;
    } catch (err) {
      if ((err as { code?: string }).code === 'REIMBURSEMENTS_CHANGED') {
        throw createError(
          409,
          'Reimbursement claims changed since this draft was built — use "Re-pull from attendance", then finalize',
          { code: 'REIMBURSEMENTS_CHANGED' },
        );
      }
      if ((err as { code?: string }).code === 'CORRECTIONS_CHANGED') {
        throw createError(
          409,
          'Payslip corrections changed since this draft was built — use "Re-pull from attendance", then finalize',
          { code: 'CORRECTIONS_CHANGED' },
        );
      }
      if ((err as { code?: string }).code === 'EXIT_CONFLICT') {
        throw createError(409, 'An exit changed while finalizing — re-pull, then finalize', {
          code: 'EXIT_CONFLICT',
        });
      }
      if ((err as { code?: string }).code === 'AUTO_LEAVE_CONFLICT') {
        throw createError(409, 'Leave balances changed while finalizing — retry', {
          code: 'AUTO_LEAVE_CONFLICT',
        });
      }
      return mapRunConflict(err);
    }
  };

  const markPaid = async (id: string, actor: ActorContext): Promise<PayrollRunDto> => {
    const run = await requireRun(id);
    requireStatus(run, 'finalized');
    const updated = await repo
      .updateRunStatus(
        id,
        { status: 'paid', paidBy: actor.actorEmployeeId, paidAt: new Date() },
        'payroll.run_paid',
        run.month,
        actor,
        'finalized',
      )
      .catch(mapRunConflict);
    const { run: dto } = await getRun(updated.id);
    return dto;
  };

  const deleteRun = async (id: string, actor: ActorContext): Promise<void> => {
    const run = await requireRun(id);
    requireStatus(run, 'draft');
    await repo.deleteRun(run, actor).catch(mapRunConflict);
  };

  /** Everyone payroll may set a salary for (route gated compensation read, org). */
  const compensationPeople = async (): Promise<CompensationPersonDto[]> =>
    (await repo.listCompensationPeople()).map((p) => ({
      id: p.id,
      name: p.name,
      employeeCode: p.employeeCode,
      status: p.status as CompensationPersonDto['status'],
    }));

  /** The TDS calculator rows — the ERP sheet's TDS tab from live data. */
  const tdsEstimates = async (): Promise<TdsEstimateDto[]> => {
    const fy = fyBounds();
    const [people, deducted] = await Promise.all([
      repo.listTdsInputs(),
      repo.sumTdsDeducted(fy.startMonth, fy.endMonth),
    ]);
    return people
      .filter((p) => p.ctc !== null)
      .map((p) => {
        const ctc = num(p.ctc);
        const fyMonths = p.dateOfJoining
          ? Math.min(
              Math.max(
                0,
                (Date.parse(fy.close) - Date.parse(p.dateOfJoining)) / (30 * 86_400_000),
              ),
              12,
            )
          : 12;
        const months = round1(fyMonths);
        const fyCtc = round2((ctc * months) / 12);
        const cnpsPercent = num(p.cnpsPercent);
        const basicShare = num(p.basicPercent, DEFAULT_BASIC_PCT) / 100;
        const cnpsAmount = round2(fyCtc * basicShare * (cnpsPercent / 100));
        const employerPfAnnual = round2(TDS_EMPLOYER_PF_MONTHLY * Math.round(months));
        const variablePay = num(p.variablePay);
        const fyVariablePay = round2((variablePay * months) / 12);
        const taxableIncome = Math.max(
          0,
          round2(
            fyCtc + fyVariablePay - TDS_STD_DEDUCTION - employerPfAnnual - cnpsAmount,
          ),
        );
        const { surcharge, total: totalTax } = taxBreakdown(taxableIncome);
        const payrollMonths = Math.max(1, Math.round(months));
        const already = deducted.get(p.id) ?? 0;
        return {
          employee: { id: p.id, name: p.name, employeeCode: p.employeeCode },
          ctc,
          dateOfJoining: p.dateOfJoining,
          fyClose: fy.close,
          fyMonths: months,
          payrollMonthsRemaining: fy.monthsRemaining,
          cnpsPercent,
          fyCtc,
          cnpsAmount,
          stdDeduction: TDS_STD_DEDUCTION,
          employerPfAnnual,
          variablePay,
          fyVariablePay,
          taxableIncome,
          surcharge,
          totalTax,
          tdsPerMonth: round2(totalTax / payrollMonths),
          tdsAlreadyDeducted: round2(already),
          revisedTdsPerMonth: Math.max(
            0,
            round2((totalTax - already) / fy.monthsRemaining),
          ),
          currentTdsAmount: num(p.tdsAmount),
        };
      });
  };

  /**
   * Salary annexure (offer breakup). Pure math over the same compute() the
   * payslip uses (a full 30-day month, no LOP) plus a full-year TDS
   * projection (12 months, marginal relief) — so the offer letter, month
   * one's payslip and the tax projection all tell the same story, the
   * review doc's target flow. No DB touched; nothing is stored.
   */
  const annexure = async (input: AnnexureQuery): Promise<SalaryAnnexureDto> => {
    const ctcMonthly = round2(input.ctc / 12);
    const cnpsAnnual = round2(
      input.ctc * (input.basicPercent / 100) * (input.cnpsPercent / 100),
    );
    const cnpsMonthly = round2(cnpsAnnual / 12);
    const taxableIncome = Math.max(
      0,
      round2(
        input.ctc +
          input.variablePay -
          TDS_STD_DEDUCTION -
          TDS_EMPLOYER_PF_MONTHLY * 12 -
          cnpsAnnual,
      ),
    );
    const { surcharge: surchargeAnnual, total: totalTaxAnnual } =
      taxBreakdown(taxableIncome);
    const tdsPerMonth = round2(totalTaxAnnual / 12);
    const { states } = await settings.effective('payroll.ptStates');
    // A regular month (not February) — the offer shows the usual figure.
    const parts = compute(
      {
        ctc: input.ctc,
        basicPct: input.basicPercent,
        hraPct: input.hraPercent,
        lopDays: 0,
        tds: tdsPerMonth,
        otherDeduction: 0,
        healthInsurance: input.healthInsurance,
        cnpsEmployer: cnpsMonthly,
        reimbursement: 0,
        performanceBonus: 0,
        recognitionBonus: 0,
        otherBonus: 0,
        leaveEncashment: 0,
        advance: 0,
        correction: 0,
        fnfEarnings: 0,
        fnfDeductions: 0,
        loanEmi: 0,
      },
      ptRuleFor(input.ptState ?? null, '2026-04', states),
    );
    return {
      ctcAnnual: input.ctc,
      ctcMonthly,
      basic: parts.basic,
      hra: parts.hra,
      lta: parts.lta,
      specialAllowance: parts.specialAllowance,
      grossSalary: round2(ctcMonthly - parts.pfEmployer),
      pfEmployee: parts.pfEmployee,
      pfEmployer: parts.pfEmployer,
      professionalTax: parts.professionalTax,
      healthInsurance: input.healthInsurance,
      cnpsEmployer: cnpsMonthly,
      variablePayAnnual: input.variablePay,
      taxableIncome,
      surchargeAnnual,
      totalTaxAnnual,
      tdsPerMonth,
      netTakeHome: parts.netPay,
    };
  };

  /** Write the calculator's outcome (TDS/month, CNPS%) onto the salary row. */
  const updateTds = async (
    employeeId: string,
    input: UpdateTdsInput,
    actor: ActorContext,
  ): Promise<TdsEstimateDto> => {
    const ok = await repo.updateSalaryTds(
      employeeId,
      {
        ...(input.tdsAmount !== undefined ? { tdsAmount: String(input.tdsAmount) } : {}),
        ...(input.cnpsPercent !== undefined
          ? { cnpsPercent: String(input.cnpsPercent) }
          : {}),
      },
      actor,
    );
    if (!ok) {
      throw createError(404, 'No salary record for this employee', {
        code: 'SALARY_NOT_FOUND',
      });
    }
    const row = (await tdsEstimates()).find((r) => r.employee.id === employeeId);
    if (!row)
      throw createError(404, 'Employee not in the calculator', { code: 'NOT_FOUND' });
    return row;
  };

  /** Own payslips, published runs only (finalized/paid) — me scope. */
  const myPayslips = async (employeeId: string): Promise<MyPayslipDto[]> => {
    const [rows, mine, claims] = await Promise.all([
      repo.listMyPayslips(employeeId),
      repo.listCorrections({ employeeIds: [employeeId] }),
      repo.claimsFor([employeeId]),
    ]);
    const all = mine.map(toCorrection);
    return rows.map((r) => {
      const run = { id: r.slip.runId, month: r.month, status: r.runStatus };
      return {
        ...toPayslip(
          { ...r.slip, employeeName: '', employeeCode: '' },
          {
            ...correctionsFor(r.slip, run, all),
            reimbursementClaims: claimsOn(r.slip, run, claims),
          },
        ),
        employee: { id: employeeId, name: '', employeeCode: '' },
        month: r.month,
        runStatus: r.runStatus,
      };
    });
  };

  /**
   * Post-finalize correction: only a PUBLISHED slip (finalized/paid) can be
   * corrected — a draft is simply edited. The amount rides on the employee's
   * next run as its own line; TDS on it stays PR's call on that draft.
   */
  const addCorrection = async (
    payslipId: string,
    input: CreateCorrectionInput,
    actor: ActorContext,
  ): Promise<PayslipCorrectionDto> => {
    const slip = await repo.findPayslipWithRun(payslipId);
    if (!slip) throw createError(404, 'Payslip not found', { code: 'PAYSLIP_NOT_FOUND' });
    if (slip.runStatus === 'draft') {
      throw createError(409, 'This month is still a draft — edit the payslip instead', {
        code: 'RUN_NOT_PUBLISHED',
      });
    }
    const row = await repo.insertCorrection(
      {
        employeeId: slip.employeeId,
        sourcePayslipId: slip.id,
        sourceMonth: slip.month,
        amount: round2(input.amount),
        reason: input.reason,
      },
      actor,
    );
    const listed = await repo.listCorrections({ employeeIds: [slip.employeeId] });
    return toCorrection(listed.find((c) => c.row.id === row.id)!);
  };

  const cancelCorrection = async (
    id: string,
    actor: ActorContext,
  ): Promise<PayslipCorrectionDto> => {
    const row = await repo.cancelCorrection(id, actor);
    if (!row) {
      throw createError(409, 'Only a pending correction can be cancelled', {
        code: 'CORRECTION_NOT_PENDING',
      });
    }
    const listed = await repo.listCorrections({ employeeIds: [row.employeeId] });
    return toCorrection(listed.find((c) => c.row.id === row.id)!);
  };

  const listCorrections = async (): Promise<PayslipCorrectionDto[]> =>
    (await repo.listCorrections()).map(toCorrection);

  /** One slip as a PDF, from its stored snapshot. */
  const pdfFor = async (
    slip: PayslipDto,
    month: string,
    runStatus: PayrollRunRow['status'],
  ): Promise<{ file: Buffer; filename: string }> => {
    const [header, company] = await Promise.all([
      repo.payslipHeader(slip.employee.id),
      settings.effective('payroll.payslipHeader'),
    ]);
    const file = await renderPayslipPdf({
      company: { name: company.companyName, address: company.address },
      month,
      runStatus,
      employee: {
        name: header?.name ?? slip.employee.name,
        employeeCode: header?.employeeCode ?? slip.employee.employeeCode,
        designation: header?.designation ?? null,
        department: header?.department ?? null,
        dateOfJoining: header?.dateOfJoining ?? null,
        panLast4: header?.panLast4 ?? null,
        bankName: header?.bankName ?? null,
        accountLast4: header?.accountLast4 ?? null,
      },
      slip,
    });
    const code = (header?.employeeCode ?? slip.employee.employeeCode).replace(
      /[^A-Za-z0-9-]/g,
      '',
    );
    return {
      file,
      filename: `payslip-${code}-${month}${runStatus === 'draft' ? '-DRAFT' : ''}.pdf`,
    };
  };

  /** PR: any slip of a run (drafts carry a DRAFT watermark). */
  const runPayslipPdf = async (runId: string, payslipId: string) => {
    const { run, payslips: slips } = await getRun(runId);
    const slip = slips.find((sl) => sl.id === payslipId);
    if (!slip) {
      throw createError(404, 'Payslip not found in this run', {
        code: 'PAYSLIP_NOT_FOUND',
      });
    }
    return pdfFor(slip, run.month, run.status);
  };

  // ── Full & final (exit module) ───────────────────────────────────────────

  const exitForRecoveries = async (exitId: string) => {
    const exit = await exits.find(exitId);
    if (!exit) throw createError(404, 'Exit not found', { code: 'EXIT_NOT_FOUND' });
    return exit;
  };

  /** Re-work a DRAFT F&F slip after its recovery lines change. */
  const refreshExitSlip = async (exitId: string, actor: ActorContext) => {
    const draft = await repo.draftSlipForExit(exitId);
    if (!draft) return;
    const slip = await repo.findPayslip(draft.id);
    const exit = await exits.find(exitId);
    if (!slip || !exit) return;
    const lines = await exits.fnfFor(exit, num(slip.ctc));
    const c = compute(
      {
        ctc: num(slip.ctc),
        basicPct: num(slip.basicPercent),
        hraPct: num(slip.hraPercent),
        lopDays: num(slip.lopDays),
        tds: num(slip.tds),
        otherDeduction: num(slip.otherDeduction),
        healthInsurance: num(slip.healthInsurance),
        cnpsEmployer: num(slip.cnpsEmployer),
        reimbursement: num(slip.reimbursement),
        performanceBonus: num(slip.performanceBonus),
        recognitionBonus: num(slip.recognitionBonus),
        otherBonus: num(slip.otherBonus),
        leaveEncashment: lines.leaveEncashment,
        advance: num(slip.advance),
        correction: num(slip.correction),
        fnfEarnings: fnfEarningsOf(lines),
        fnfDeductions: fnfDeductionsOf(lines),
        loanEmi: num(slip.loanEmi),
      },
      ptRuleFor(slip.ptState, draft.month, (await settings.effective('payroll.ptStates')).states),
    );
    await repo
      .updatePayslip(
        slip.id,
        {
          leaveEncashment: String(lines.leaveEncashment),
          ...fnfColumns(lines),
          earningsTotal: String(c.earningsTotal),
          deductionsTotal: String(c.deductionsTotal),
          netPay: String(c.netPay),
          finalPay: String(c.finalPay),
        },
        ['fnfRecovery'],
        actor,
      )
      .catch(mapRunConflict);
  };

  const recoveries = async (exitId: string) => {
    await exitForRecoveries(exitId);
    return (await exits.recoveries(exitId)).map((r) => ({
      id: r.id,
      label: r.label,
      amount: num(r.amount),
      note: r.note,
    }));
  };

  const addRecovery = async (
    exitId: string,
    input: FnfRecoveryInput,
    actor: ActorContext,
  ) => {
    const exit = await exitForRecoveries(exitId);
    if (exit.employeeId === actor.actorEmployeeId) {
      throw createError(403, 'You cannot work your own F&F', { code: 'NO_SELF_SETTLEMENT' });
    }
    if (exit.status !== 'accepted' && exit.status !== 'relieved') {
      throw createError(409, `This exit is ${exit.status}`, { code: 'EXIT_CLOSED' });
    }
    await exits.addRecovery(exitId, input, actor);
    await refreshExitSlip(exitId, actor);
    return recoveries(exitId);
  };

  const removeRecovery = async (exitId: string, recoveryId: string, actor: ActorContext) => {
    const exit = await exitForRecoveries(exitId);
    if (exit.status !== 'accepted' && exit.status !== 'relieved') {
      throw createError(409, `This exit is ${exit.status}`, { code: 'EXIT_CLOSED' });
    }
    if (!(await exits.removeRecovery(exitId, recoveryId, actor))) {
      throw createError(404, 'Recovery line not found', { code: 'RECOVERY_NOT_FOUND' });
    }
    await refreshExitSlip(exitId, actor);
    return recoveries(exitId);
  };

  /**
   * The F&F statement: the published slip that settled the exit. Payroll
   * (org) or HR in reach of the leaver may download it.
   */
  const exitStatementPdf = async (exitId: string, callerId: string) => {
    const exit = await exitForRecoveries(exitId);
    const [pr, hr] = await Promise.all([
      authz.resolveAccess(callerId, 'pr.payroll', 'read'),
      authz.reaches(callerId, 'hrbp.exits', 'read', exit.employeeId),
    ]);
    if (!hasOrgScope(pr) && !hr) {
      throw createError(404, 'Exit not found', { code: 'EXIT_NOT_FOUND' });
    }
    const settled = await repo.settledSlipForExit(exitId);
    if (!settled) {
      throw createError(409, 'The F&F has not been settled in a finalized run yet', {
        code: 'NOT_SETTLED',
      });
    }
    const { payslips } = await getRun(settled.run_id);
    const slip = payslips.find((sl) => sl.id === settled.id)!;
    const out = await pdfFor(slip, settled.month, settled.status);
    return { ...out, filename: out.filename.replace('payslip-', 'full-and-final-') };
  };

  /** The employee: their own PUBLISHED slips only — anything else is a 404. */
  const myPayslipPdf = async (employeeId: string, payslipId: string) => {
    const mine = await myPayslips(employeeId);
    const slip = mine.find((sl) => sl.id === payslipId);
    if (!slip) throw createError(404, 'Payslip not found', { code: 'PAYSLIP_NOT_FOUND' });
    return pdfFor(slip, slip.month, slip.runStatus);
  };

  return {
    recoveries,
    addRecovery,
    removeRecovery,
    exitStatementPdf,
    runPayslipPdf,
    myPayslipPdf,
    addCorrection,
    cancelCorrection,
    listCorrections,
    listRuns,
    getRun,
    generate,
    regenerate,
    updatePayslip,
    finalize,
    markPaid,
    deleteRun,
    myPayslips,
    compensationPeople,
    tdsEstimates,
    updateTds,
    annexure,
  };
};

export type PayrollService = ReturnType<typeof createPayrollService>;
