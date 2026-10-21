import { LEVELS } from '../../shared/constants/constants.js';
import { z } from '../../shared/zod.js';

/** A person link resolved for display (RM, approvers): enough to recognize. */
const personRefSchema = z
  .object({ id: z.string().uuid(), name: z.string(), employeeCode: z.string() })
  .nullable();

/**
 * The signed-in employee's own view: profile + the batches they hold. This is
 * what the frontend uses to decide which portal surfaces to show — the Venn
 * overlap (§1) made visible. Salary/bank data is NOT here on purpose: it is
 * me-scoped behind its own endpoint (see `salarySchema`).
 */
export const meSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
    phone: z.string().nullable(),
    employeeCode: z.string(),
    level: z.enum(LEVELS),
    status: z.enum(['invited', 'active', 'exiting', 'inactive']),
    departmentId: z.string().uuid().nullable(),
    reportsTo: z.string().uuid().nullable(),

    // Overview (self-serve identity).
    salutation: z.string().nullable(),
    firstName: z.string().nullable(),
    middleName: z.string().nullable(),
    lastName: z.string().nullable(),
    gender: z.string().nullable(),
    dateOfBirth: z.string().nullable(),

    // Company details (org-controlled).
    designation: z.string().nullable(),
    employmentType: z.string().nullable(),

    // Joining (org-controlled).
    dateOfJoining: z.string().nullable(),
    confirmationDate: z.string().nullable(),
    noticeDays: z.number().int().nullable(),
    offerDate: z.string().nullable(),

    // Contacts & address (self-serve).
    personalEmail: z.string().nullable(),
    preferredContactEmail: z.enum(['company', 'personal']).nullable(),
    unsubscribed: z.boolean(),
    currentAddress: z.string().nullable(),
    permanentAddress: z.string().nullable(),

    // Resolved views of the org links, so the profile can show names
    // instead of UUIDs (§2.1). Null when the link is unset (e.g. the Owner).
    department: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
    baseZone: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
    manager: personRefSchema,
    expenseApprover: personRefSchema,
    shiftRequestApprover: personRefSchema,
    leaveApprover: personRefSchema,

    // Batch names the employee holds (e.g. ["Employee", "HRBP"]).
    batches: z.array(z.string()),
    isOwner: z.boolean(),
    isSuperadmin: z.boolean(),
    // Anyone routes to this person as RM or leave approver — drives the
    // Team-leaves surface (UX only; the backend filters regardless).
    hasReports: z.boolean(),
    /**
     * Reports (via leave approver, else manager) to the administration
     * account — the self-governing top: own requests approve themselves and
     * they set their own goals (access/selfGovernance.ts is the rule).
     */
    selfGoverned: z.boolean(),
  })
  .openapi('Me');

/**
 * One person in the caller's chain — SANITIZED: identity, role and contact
 * only. `relation` says whether they report to the caller or merely name
 * them as leave approver. `status` lets the roster tag invited/exiting
 * people instead of showing an empty attendance chip (team-attendance
 * queries cover ACTIVE employees only).
 */
export const teamMemberSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    employeeCode: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    designation: z.string().nullable(),
    department: z.string().nullable(),
    baseZone: z.string().nullable(),
    relation: z.enum(['report', 'approver_only']),
    status: z.enum(['invited', 'active', 'exiting']),
    // For the person sheet: tenure and the band badge. Still no pay, no personal data.
    level: z.enum(LEVELS),
    dateOfJoining: z.string().nullable(),
  })
  .openapi('TeamMember');

/**
 * Self-serve profile edit (decision D3): personal identity fields only.
 * Code, level, manager, department, designation and every other org-controlled
 * placement field stays with HRBP via /employees — never the person themselves.
 * The full `name` is derived from the name parts whenever any part changes.
 */
export const updateMeSchema = z
  .object({
    salutation: z.string().max(20).nullable().optional(),
    firstName: z.string().min(1).optional(),
    middleName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    gender: z.string().max(40).nullable().optional(),
    dateOfBirth: z.string().date().nullable().optional(),
    // Exactly a 10-digit mobile number (user decision) — no +91, no spaces.
    phone: z
      .string()
      .regex(/^\d{10}$/, 'Phone must be exactly 10 digits')
      .nullable()
      .optional(),
    personalEmail: z.string().email().nullable().optional(),
    preferredContactEmail: z.enum(['company', 'personal']).nullable().optional(),
    unsubscribed: z.boolean().optional(),
    currentAddress: z.string().max(1000).nullable().optional(),
    permanentAddress: z.string().max(1000).nullable().optional(),
  })
  .strict()
  .openapi('UpdateMe');

/**
 * Salary + bank details — ME SCOPED (§3.1). Served only to the employee
 * themselves (`GET /me/salary`), to `pr.payroll.compensation` holders via
 * /employees/:id/salary, and to the Owner/SuperAdmin bypass. Other HR and the
 * RM never see this shape.
 */
export const salarySchema = z
  .object({
    ctc: z.string().nullable(),
    payrollCostCenter: z.string().nullable(),
    salaryCurrency: z.string(),
    salaryMode: z.string().nullable(),
    panNumber: z.string().nullable(),
    providentFundAccount: z.string().nullable(),
    employeeAdvanceAccount: z.string().nullable(),
    bankName: z.string().nullable(),
    bankAccountNo: z.string().nullable(),
    ifscCode: z.string().nullable(),
    basicPercent: z.string().nullable(),
    hraPercent: z.string().nullable(),
    pfAmount: z.string().nullable(),
    tdsAmount: z.string().nullable(),
    professionalTaxAmount: z.string().nullable(),
    otherDeductionAmount: z.string().nullable(),
  })
  .openapi('EmployeeSalary');

/**
 * Payroll's view of someone's salary: bank name / account / IFSC come back
 * null with `bankDetailsHidden` unless the caller holds
 * pr.payroll.bank_details (Phase 3) — so "hidden" never reads as "not set".
 */
export const payrollSalarySchema = salarySchema
  .extend({
    bankDetailsHidden: z.boolean(),
    /** Annual variable-pay target (payroll view only). */
    variablePay: z.string().nullable(),
  })
  .openapi('PayrollEmployeeSalary');

/** Bank details on their own door — pr.payroll.bank_details. */
export const bankDetailsSchema = z
  .object({
    bankName: z.string().nullable(),
    bankAccountNo: z.string().nullable(),
    ifscCode: z.string().nullable(),
  })
  .openapi('BankDetails');

/** An asset currently in the caller's custody (profile "Assigned Assets"). */
export const myAssetSchema = z
  .object({
    id: z.string().uuid(),
    assetCode: z.string(),
    name: z.string(),
    category: z.string().nullable(),
    status: z.enum([
      'assigned',
      'idle',
      'in_use_shared',
      'needs_repair',
      'scrapped',
      'gifted',
      'lost',
    ]),
  })
  .openapi('MyAsset');

/** The caller's own exit record, if one exists (profile "Employee Exit"). */
export const myExitSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['resignation', 'termination']),
    status: z.enum(['submitted', 'accepted', 'relieved', 'settled', 'withdrawn', 'cancelled']),
    noticeStartOn: z.string(),
    lastWorkingDay: z.string(),
    interviewAt: z.string().datetime().nullable(),
    settledAt: z.string().datetime().nullable(),
  })
  .nullable()
  .openapi('MyExit');

export type MeDto = z.infer<typeof meSchema>;
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
export type TeamMemberDto = z.infer<typeof teamMemberSchema>;
export type SalaryDto = z.infer<typeof salarySchema>;
export type MyAssetDto = z.infer<typeof myAssetSchema>;
export type MyExitDto = z.infer<typeof myExitSchema>;
