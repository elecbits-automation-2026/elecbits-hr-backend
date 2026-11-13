/**
 * The onboarding checklist template (3-phase SOP, adopted from the hr-tool
 * review). Instantiating a journey COPIES these rows, so later template edits
 * never rewrite a journey already underway.
 *
 * `owner` is who the task waits on; a `policyCode` task is completed by
 * acknowledging that policy, never ticked directly. Policy codes are loose
 * links — a journey renders fine while the policy is not published yet.
 */
export interface TemplateTask {
  key: string;
  phase: 'before_start' | 'week_one' | 'first_30';
  title: string;
  owner: 'employee' | 'hr' | 'manager' | 'admin' | 'ops' | 'payroll';
  policyCode?: string;
}

/**
 * Document steps: uploading the file is what completes them, never a bare
 * tick (test pass 2026-11-03 — a tick proved nothing). PDF / JPG / PNG.
 * The task's owner uploads: the joiner their documents, HR the signed offer.
 */
export const FILE_TASK_KEYS = new Set(['offer', 'docs', 'bank', 'bgv']);

/** Steps the records complete on their own — never ticked by hand. */
export const AUTO_TASK_KEYS = new Set(['payroll', 'claim']);

export const ONBOARDING_TEMPLATE: TemplateTask[] = [
  // ── Before you start (joining date −7) ──────────────────────────────────
  {
    key: 'offer',
    phase: 'before_start',
    title: 'Signed offer letter uploaded — HR',
    owner: 'hr',
  },
  {
    key: 'docs',
    phase: 'before_start',
    title: 'ID and address documents submitted',
    owner: 'employee',
  },
  {
    key: 'bank',
    phase: 'before_start',
    title: 'Bank, PAN and UAN details submitted',
    owner: 'employee',
  },
  {
    // OPS is told when the journey starts, decides what the joiner gets
    // (laptop, desktop, mobile, ID card…) and ticks it with what was issued.
    key: 'kit',
    phase: 'before_start',
    title: 'Assets decided and issued — OPS',
    owner: 'ops',
  },
  {
    // Done by itself once a CTC and bank details are on the salary record.
    key: 'payroll',
    phase: 'before_start',
    title: 'Salary and bank details on record — payroll',
    owner: 'payroll',
  },

  // ── Week one (joining date) ─────────────────────────────────────────────
  {
    key: 'welcome',
    phase: 'week_one',
    title: 'Welcome and HR induction done',
    owner: 'hr',
  },
  {
    // Done by itself once the joiner claims their login.
    key: 'claim',
    phase: 'week_one',
    title: 'HRMS account claimed',
    owner: 'employee',
  },
  {
    key: 'coc',
    phase: 'week_one',
    title: 'Code of conduct read and acknowledged',
    owner: 'employee',
    policyCode: 'coc',
  },
  {
    key: 'workspace',
    phase: 'week_one',
    title: 'Workspace, email and tool access ready',
    owner: 'admin',
  },
  {
    key: 'deptintro',
    phase: 'week_one',
    title: 'Introduced to the team and ways of working',
    owner: 'manager',
  },

  // ── First 30 days ───────────────────────────────────────────────────────
  {
    key: 'buddy',
    phase: 'first_30',
    title: 'Buddy / first point of contact assigned',
    owner: 'manager',
  },
  {
    key: 'tools',
    phase: 'first_30',
    title: 'Core tools and processes walkthrough done',
    owner: 'manager',
  },
  {
    key: 'expectations',
    phase: 'first_30',
    title: 'First-quarter expectations agreed',
    owner: 'manager',
  },
  // BGV is a form, usually filled after joining — it never holds up joining or
  // the rest of onboarding (learner, 2026-10-27).
  {
    key: 'bgv',
    phase: 'first_30',
    title: 'Background verification (BGV) form filled',
    owner: 'employee',
  },
  { key: 'checkin', phase: 'first_30', title: '30-day HR check-in held', owner: 'hr' },
];
