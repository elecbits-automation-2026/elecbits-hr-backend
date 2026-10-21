import createError from 'http-errors';
import { localDateOf } from '../../shared/helpers/helpers.js';
import { emiFor, instalment, scheduleFrom } from './loans.math.js';
import type { ActorContext, LoanViewRow, LoansRepository } from './loans.repository.js';
import type {
  CloseLoanInput,
  CreateLoanInput,
  LoanDetailDto,
  LoanDto,
  UpdateLoanInput,
} from './loans.schema.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const num = (v: string | null | undefined) => (v == null ? 0 : Number(v));
const thisMonth = () => localDateOf(new Date()).slice(0, 7);
const nextMonth = (m: string) => {
  const [y, mm] = m.split('-').map(Number) as [number, number];
  return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
};

const balanceOf = (l: LoanViewRow) => round2(num(l.principal) - l.repaidPrincipal);

const toLoan = (l: LoanViewRow): LoanDto => ({
  id: l.id,
  employee: { id: l.employeeId, name: l.employeeName, employeeCode: l.employeeCode },
  kind: l.kind,
  principal: num(l.principal),
  interestRatePct: num(l.interestRatePct),
  months: l.months,
  startMonth: l.startMonth,
  emi: num(l.emi),
  status: l.status,
  note: l.note,
  repaidPrincipal: l.repaidPrincipal,
  repaidInterest: l.repaidInterest,
  balance: l.status === 'active' ? balanceOf(l) : 0,
  instalments: l.instalments,
  createdAt: l.createdAt.toISOString(),
});

/** One loan's share of a payslip's loan deduction. */
export interface LoanPayment {
  loanId: string;
  kind: 'emi' | 'fnf';
  amount: number;
  principal: number;
  interest: number;
  closes: boolean;
}

/**
 * Loans & advances (close-out, user decisions 2026-10-16): payroll records
 * them for confirmed full-time employees (permanent, past probation, not
 * leaving); rate and months are set per loan and stay editable; the EMI is
 * deducted in every run from the start month; at exit the whole balance goes
 * into the F&F. Settling outside payroll closes it with one repayment row.
 */
export const createLoansService = (deps: { repo: LoansRepository }) => {
  const { repo } = deps;

  const list = async () =>
    (await repo.all())
      .map(toLoan)
      .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'));

  const mine = async (employeeId: string) =>
    (await repo.ofEmployee(employeeId)).map(toLoan);

  const detail = async (id: string, onlyFor?: string): Promise<LoanDetailDto> => {
    const l = await repo.one(id);
    if (!l || (onlyFor && l.employeeId !== onlyFor)) {
      throw createError(404, 'Loan not found', { code: 'LOAN_NOT_FOUND' });
    }
    const repaid = await repo.repayments(id);
    const dto = toLoan(l);
    const from = repaid.length
      ? nextMonth(
          repaid
            .map((r) => r.month ?? '')
            .sort()
            .at(-1) || l.startMonth,
        )
      : l.startMonth;
    return {
      ...dto,
      repayments: repaid
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((r) => ({
          month: r.month,
          kind: r.kind,
          amount: num(r.amount),
          principal: num(r.principalPart),
          interest: num(r.interestPart),
          at: r.createdAt.toISOString(),
        })),
      schedule:
        l.status === 'active'
          ? scheduleFrom(dto.balance, dto.interestRatePct, dto.emi, from)
          : [],
    };
  };

  const create = async (input: CreateLoanInput, actor: ActorContext) => {
    const who = await repo.eligibility(input.employeeId);
    if (!who)
      throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
    const today = localDateOf(new Date());
    const confirmed =
      !who.probation_open &&
      (who.confirmation_date === null || who.confirmation_date <= today);
    if (who.status !== 'active' || who.employment_type !== 'permanent' || !confirmed) {
      throw createError(
        422,
        `${who.name} isn't eligible — loans are for confirmed full-time employees who aren't leaving`,
        { code: 'NOT_ELIGIBLE' },
      );
    }
    if (input.startMonth < thisMonth()) {
      throw createError(422, 'Repayments can start this month at the earliest', {
        code: 'PAST_START',
      });
    }
    if (await repo.runLocked(input.startMonth)) {
      throw createError(
        409,
        `Payroll for ${input.startMonth} is already finalized — start later`,
        {
          code: 'RUN_LOCKED',
        },
      );
    }
    const months = input.kind === 'advance' ? 1 : input.months;
    const id = await repo.insert(
      {
        employeeId: input.employeeId,
        kind: input.kind,
        principal: String(input.principal),
        interestRatePct: String(input.interestRatePct),
        months,
        startMonth: input.startMonth,
        emi: String(emiFor(input.principal, input.interestRatePct, months)),
        note: input.note ?? null,
        createdBy: actor.actorEmployeeId,
      },
      actor,
    );
    return detail(id);
  };

  /** New rate and/or months left: the EMI is worked out again on the balance. */
  const update = async (id: string, input: UpdateLoanInput, actor: ActorContext) => {
    const l = await repo.one(id);
    if (!l) throw createError(404, 'Loan not found', { code: 'LOAN_NOT_FOUND' });
    if (l.status !== 'active')
      throw createError(409, 'This loan is closed', { code: 'CLOSED' });
    const rate = input.interestRatePct ?? num(l.interestRatePct);
    const left = input.monthsLeft ?? Math.max(1, l.months - l.instalments);
    await repo.update(
      id,
      {
        interestRatePct: String(rate),
        months: l.instalments + left,
        emi: String(emiFor(balanceOf(l), rate, left)),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
      actor,
    );
    return detail(id);
  };

  const close = async (id: string, input: CloseLoanInput, actor: ActorContext) => {
    const l = await repo.one(id);
    if (!l) throw createError(404, 'Loan not found', { code: 'LOAN_NOT_FOUND' });
    if (!(await repo.closeOutside(id, balanceOf(l), `Closed: ${input.note}`, actor))) {
      throw createError(409, 'This loan is already closed', { code: 'CLOSED' });
    }
    return detail(id);
  };

  /**
   * What each person repays in a run: every active loan's instalment, or —
   * on an F&F slip — the whole balance of every loan.
   */
  const dueFor = async (
    employeeIds: string[],
    month: string,
    settling: Set<string> = new Set(),
  ): Promise<Map<string, { total: number; payments: LoanPayment[] }>> => {
    const out = new Map<string, { total: number; payments: LoanPayment[] }>();
    const regular = employeeIds.filter((id) => !settling.has(id));
    const rows = [
      ...(await repo.dueIn(regular, month)),
      // An F&F takes every active loan, started or not.
      ...(await repo.activeOf([...settling].filter((id) => employeeIds.includes(id)))),
    ];
    for (const l of rows) {
      const balance = balanceOf(l);
      if (balance <= 0) continue;
      const fnf = settling.has(l.employeeId);
      const i = fnf
        ? { amount: balance, interest: 0, principal: balance }
        : instalment(balance, num(l.interestRatePct), num(l.emi));
      if (i.amount <= 0) continue;
      const entry = out.get(l.employeeId) ?? { total: 0, payments: [] };
      entry.total = round2(entry.total + i.amount);
      entry.payments.push({
        loanId: l.id,
        kind: fnf ? 'fnf' : 'emi',
        amount: i.amount,
        principal: i.principal,
        interest: i.interest,
        closes: fnf || i.principal >= balance - 0.004,
      });
      out.set(l.employeeId, entry);
    }
    return out;
  };

  return { list, mine, detail, create, update, close, dueFor };
};

export type LoansService = ReturnType<typeof createLoansService>;
