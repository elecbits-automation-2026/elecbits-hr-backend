/**
 * Pure payroll statutory math (no DB, no settings reads), so it can be
 * exercised on its own: PF (the ERP sheet's blended wage cap) and ESIC.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * PF (employee AND employer, identical) =
 *   12% × min(basic, 15000) × 16/30 + 12% × min(basic, 25000) × 14/30
 *   — the sheet's wage-cap transition blend, kept verbatim.
 */
export const SHEET_DAY_BASE = 30;
const PF_RATE = 0.12;
const PF_OLD_CAP = 15000;
const PF_OLD_DAYS = 16;
const PF_NEW_CAP = 25000;
const PF_NEW_DAYS = 14;

export const pfOf = (basic: number): number =>
  round2(
    Math.min(basic, PF_OLD_CAP) * (PF_OLD_DAYS / SHEET_DAY_BASE) * PF_RATE +
      Math.min(basic, PF_NEW_CAP) * (PF_NEW_DAYS / SHEET_DAY_BASE) * PF_RATE,
  );

/** The payroll.esic setting. */
export interface EsicPolicy {
  enabled: boolean;
  employeePct: number;
  employerPct: number;
  /** Covered while monthly gross wages are at or under this (₹21,000). */
  wageCeiling: number;
  /** At or under this average daily wage (₹176) the employee share is nil. */
  lowWageDaily: number;
}

/** A slip's ESIC rule: the period's eligibility plus the live rates. */
export interface EsicRule {
  eligible: boolean;
  policy: EsicPolicy;
}

/**
 * The contribution period a payroll month falls in: Apr–Sep starts 1 April,
 * Oct–Mar starts 1 October (Jan–Mar belong to the previous October).
 */
export const esicPeriodStart = (month: string): string => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  if (m >= 4 && m <= 9) return `${y}-04-01`;
  return m >= 10 ? `${y}-10-01` : `${y - 1}-10-01`;
};

/**
 * ESIC wages out of a CTC slice. The employer share sits INSIDE CTC like
 * employer PF (user decision, 2026-11-18), so wages W satisfy
 * W + employer% × W = slice − employer PF, i.e. W = (slice − PF) / (1 + er%).
 */
const wagesOf = (ctcSlice: number, pfEmployer: number, policy: EsicPolicy): number =>
  round2(Math.max(0, ctcSlice - pfEmployer) / (1 + policy.employerPct / 100));

/**
 * Coverage test for a contribution period, on the FULL month (before LOP or
 * proration): covered when gross wages are within the ceiling.
 */
export const esicEligibleFor = (
  ctc: number,
  basicPct: number,
  policy: EsicPolicy,
): boolean => {
  if (!policy.enabled) return false;
  const monthly = round2(ctc / 12);
  const pfEmployer = pfOf(round2((monthly * basicPct) / 100));
  return wagesOf(monthly, pfEmployer, policy) <= policy.wageCeiling;
};

/** Contributions round UP to the next rupee (ESIC rule). */
const upToRupee = (n: number): number => Math.ceil(round2(n));

/**
 * The month's ESIC on wages actually paid (`prorated` already reflects LOP and
 * a mid-month join/leave). Gratuity, encashment and notice pay never reach
 * `prorated`, so they stay out of ESIC wages as the rules require.
 */
export const esicOf = (
  prorated: number,
  pfEmployer: number,
  daysPaid: number,
  rule: EsicRule | null,
): { esicEmployee: number; esicEmployer: number; esicWages: number } => {
  if (!rule || !rule.eligible || !rule.policy.enabled || daysPaid <= 0) {
    return { esicEmployee: 0, esicEmployer: 0, esicWages: 0 };
  }
  const { policy } = rule;
  const esicWages = wagesOf(prorated, pfEmployer, policy);
  if (esicWages <= 0) return { esicEmployee: 0, esicEmployer: 0, esicWages: 0 };
  const lowWage = esicWages / daysPaid <= policy.lowWageDaily;
  return {
    esicEmployee: lowWage ? 0 : upToRupee((esicWages * policy.employeePct) / 100),
    esicEmployer: upToRupee((esicWages * policy.employerPct) / 100),
    esicWages,
  };
};
