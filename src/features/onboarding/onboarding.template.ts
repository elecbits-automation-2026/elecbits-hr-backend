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

export const ONBOARDING_TEMPLATE: TemplateTask[] = [
  // ── Before you start (joining date −7) ──────────────────────────────────
  {
    key: 'offer',
    phase: 'before_start',
    title: 'Offer letter issued and accepted',
    owner: 'hr',
  },
  {
    key: 'bgv',
    phase: 'before_start',
    title: 'Background verification cleared',
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
    // Done by itself once the asset register shows the designation's kit held.
    key: 'kit',
    phase: 'before_start',
    title: 'Joiner kit issued (laptop, ID card, …) — OPS',
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
    key: 'claim',
    phase: 'week_one',
    title: 'HRMS account claimed and profile completed',
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
    key: 'handbook',
    phase: 'week_one',
    title: 'Employee handbook read and acknowledged',
    owner: 'employee',
    policyCode: 'handbook',
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
  { key: 'checkin', phase: 'first_30', title: '30-day HR check-in held', owner: 'hr' },
];
