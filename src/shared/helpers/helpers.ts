/** Small dependency-free helpers shared across features. */

import { createHash, randomBytes } from 'node:crypto';
import { SCOPES, type Scope } from '../constants/constants.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate a path param before it reaches a query (avoids a 500 on bad input). */
export const isUuid = (value: string | undefined): value is string =>
  value !== undefined && UUID_RE.test(value);

/** Case-insensitive check that an email belongs to the company domain (§5.4). */
export const isCompanyEmail = (email: string, domain: string): boolean =>
  email.toLowerCase().endsWith(`@${domain.toLowerCase()}`);

/** The widest of several grant scopes, by SCOPES order (me < ... < org). */
export const widestScope = (scopes: Scope[]): Scope =>
  scopes.reduce((widest, s) => (SCOPES.indexOf(s) > SCOPES.indexOf(widest) ? s : widest));

/**
 * "Is this an HR-sized grant" (dept or org), as opposed to a manager-sized
 * one — a ROLE question, used where the rule is about who the caller is
 * (e.g. an HRBP's own leave skipping the HR slot). Whether a grant reaches a
 * particular person is `authz.reaches` (Phase 3 scope filtering).
 */
export const hasBroadScope = (scopes: Scope[]): boolean =>
  scopes.includes('org') || scopes.includes('dept');

/** Company-wide operations and configuration need an org grant (Phase 3). */
export const hasOrgScope = (access: { bypass: boolean; scopes: Scope[] }): boolean =>
  access.bypass || access.scopes.includes('org');

/** The org's Saturday pattern (settings attendance.workWeek). */
export type SaturdayPattern = 'all_working' | 'all_off' | 'first_third_off';

/** The work week: the Saturday pattern and the date it applies from. */
export interface WorkWeek {
  saturdays: SaturdayPattern;
  /** YYYY-MM-DD; before it every Saturday stays a weekend (the old week). */
  effectiveFrom?: string;
}

/**
 * Is a YYYY-MM-DD date a weekend under the org work week (refinement plan,
 * Phase 2)? Sundays always; Saturdays per the pattern — first_third_off means
 * the 1st and 3rd Saturdays of the month are off, the rest are working days.
 * Before the week's `effectiveFrom` every Saturday is a weekend, so a past
 * month never grows new absences when the pattern changes. Pure and
 * UTC-safe, so the classifier, leave day-counting and every calendar agree.
 */
export const isWeekendDay = (isoDate: string, week: WorkWeek): boolean => {
  const date = isoDate.slice(0, 10);
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  if (dow === 0) return true;
  if (dow !== 6) return false;
  if (week.effectiveFrom && date < week.effectiveFrom) return true;
  const saturdays = week.saturdays;
  if (saturdays === 'all_off') return true;
  if (saturdays === 'all_working') return false;
  const nth = Math.ceil(d.getUTCDate() / 7);
  return nth === 1 || nth === 3;
};

/**
 * YYYY-MM-DD plus whole months, in UTC, clamped to the target month's last
 * day (31 Jan + 1 month = 28/29 Feb) — e.g. joining date + probation.
 */
export const addMonthsIso = (iso: string, months: number): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const first = new Date(Date.UTC(y!, m! - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  first.setUTCDate(Math.min(d!, lastDay));
  return first.toISOString().slice(0, 10);
};

/** sha256 hex of a claim token — only the hash is ever stored (§5.4). */
export const hashClaimToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/**
 * Mint a single-use claim token: the raw token is shown ONCE to the inviter
 * (inside the claim link); the DB keeps only its hash + expiry. The lifetime
 * is INVITE_LINK_DAYS, passed by the caller.
 */
export const newClaimToken = (
  ttlDays: number,
): { token: string; hash: string; expiresAt: Date } => {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    hash: hashClaimToken(token),
    expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
  };
};

/** Server-local YYYY-MM-DD (the server runs in the company timezone). */
export const localDateOf = (d: Date): string => d.toLocaleDateString('en-CA');

/** A YYYY-MM-DD date moved by whole days (noon anchor avoids DST edges). */
export const addDaysIso = (iso: string, n: number): string =>
  localDateOf(new Date(Date.parse(`${iso}T12:00:00`) + n * 86_400_000));

const isWorkingDay = (d: string, workWeek: WorkWeek, holidays: Set<string>) =>
  !isWeekendDay(d, workWeek) && !holidays.has(d);

/** Working days in (from, to] — weekends per the work week and holidays don't count. */
export const workingDaysBetween = (
  from: string,
  to: string,
  workWeek: WorkWeek,
  holidays: Set<string>,
): number => {
  let n = 0;
  for (let d = addDaysIso(from, 1); d <= to; d = addDaysIso(d, 1)) {
    if (isWorkingDay(d, workWeek, holidays)) n += 1;
  }
  return n;
};

/** The date `n` working days after `from` (policy deadlines: "within 7 working days"). */
export const addWorkingDays = (
  from: string,
  n: number,
  workWeek: WorkWeek,
  holidays: Set<string>,
): string => {
  let d = from;
  let left = n;
  while (left > 0) {
    d = addDaysIso(d, 1);
    if (isWorkingDay(d, workWeek, holidays)) left -= 1;
  }
  return d;
};
