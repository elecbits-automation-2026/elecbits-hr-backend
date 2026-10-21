import { LEVELS } from '../../shared/constants/constants.js';
import { z } from '../../shared/zod.js';

/**
 * Zod schemas for the employees feature — requests validated at the boundary,
 * responses tagged with `.openapi()` so the docs generate from the same source.
 */

/** How HR classifies the engagement — the dropdown HRBP picks from. */
export const EMPLOYMENT_TYPES = ['intern', 'permanent', 'contract'] as const;

/** An employee as the API returns it (§2.1). */
export const employeeSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    firstName: z.string().nullable(),
    middleName: z.string().nullable(),
    lastName: z.string().nullable(),
    phone: z.string().nullable(),
    employeeCode: z.string(),
    email: z.string().email(),
    departmentId: z.string().uuid().nullable(),
    /** The department's name, alongside its id (Phase 4: department on every surface). */
    departmentName: z.string().nullable().optional(),
    level: z.enum(LEVELS),
    // RM is a relationship, not a level (§2.2).
    reportsTo: z.string().uuid().nullable(),
    status: z.enum(['invited', 'active', 'exiting', 'inactive']),
    baseZoneId: z.string().uuid().nullable(),
    designation: z.string().nullable(),
    employmentType: z.string().nullable(),
    dateOfJoining: z.string().nullable(),
    offerDate: z.string().nullable(),
    confirmationDate: z.string().nullable(),
    noticeDays: z.number().int().nullable(),
    /** Personal workday (HH:mm) overriding the zone; null = zone/org hours. */
    workStart: z.string().nullable(),
    workEnd: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('Employee');

/**
 * HRBP creates records top-down (§5.3): the RM must already exist. The Employee
 * batch attaches automatically on creation (within HRBP's assignable list).
 * The full `name` is derived server-side from first + middle + last.
 */
export const createEmployeeSchema = z
  .object({
    firstName: z.string().min(1),
    middleName: z.string().optional(),
    lastName: z.string().optional(),
    // Exactly a 10-digit mobile number (user decision) — no +91, no spaces.
    phone: z
      .string()
      .regex(/^\d{10}$/, 'Phone must be exactly 10 digits')
      .optional(),
    employeeCode: z.string().min(1),
    email: z.string().email(),
    departmentId: z.string().uuid().optional(),
    // Where the person is based (a punch zone) — drives their work schedule
    // and lets HR filter attendance by location.
    baseZoneId: z.string().uuid().optional(),
    level: z.enum(LEVELS),
    reportsTo: z.string().uuid(),
    // HR sets the placement + terms; only active/inactive is HR-settable —
    // `invited` and `exiting` belong to the claim and exits flows.
    status: z.enum(['active', 'inactive']).optional(),
    designation: z.string().optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    dateOfJoining: z.string().date().optional(),
    offerDate: z.string().date().optional(),
    confirmationDate: z.string().date().optional(),
    noticeDays: z.number().int().min(0).optional(),
    // Personal workday, overriding the base zone's hours.
    workStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm').nullable().optional(),
    workEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm').nullable().optional(),
  })
  .strict()
  .openapi('CreateEmployee');

/** Partial update; RM changes go through here too (no-cycle check in service). */
export const updateEmployeeSchema = createEmployeeSchema
  .partial()
  .openapi('UpdateEmployee');

/**
 * The Admin invite door (access-first, decisions D1–D4): admin gives who and
 * what they may do; the employee code is auto-generated and the person fills
 * their own details in Profile after claiming. The HRBP create door above
 * stays record-first with every field supplied.
 */
export const inviteEmployeeSchema = z
  .object({
    email: z.string().email(),
    name: z.string().min(1),
    reportsTo: z.string().uuid(),
    baseZoneId: z.string().uuid().optional(),
    level: z.enum(LEVELS),
    // Batches to pre-attach on top of the automatic Employee batch.
    batchIds: z.array(z.string().uuid()),
    // Optional intake details (refinement plan, Phase 1): a known joining date
    // lets the onboarding journey and the probation default apply from day one.
    dateOfJoining: z.string().date().optional(),
    departmentId: z.string().uuid().optional(),
    designation: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .openapi('InviteEmployee');

/**
 * Payroll's write door for salary + bank details (me-scoped data, §3.1).
 * CTC travels as a string to keep numeric(14,2) precision intact.
 * The bank fields additionally need pr.payroll.bank_details (Phase 3) — a
 * compensation-only caller sending them gets 403 BANK_DETAILS_FORBIDDEN.
 */
export const updateSalarySchema = z
  .object({
    ctc: z
      .string()
      .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Must be a number with at most 2 decimals')
      .nullable()
      .optional(),
    payrollCostCenter: z.string().nullable().optional(),
    salaryCurrency: z.string().min(3).max(3).optional(),
    salaryMode: z.string().nullable().optional(),
    panNumber: z.string().nullable().optional(),
    providentFundAccount: z.string().nullable().optional(),
    employeeAdvanceAccount: z.string().nullable().optional(),
    bankName: z.string().nullable().optional(),
    bankAccountNo: z.string().nullable().optional(),
    ifscCode: z.string().nullable().optional(),
    // Salary structure: % of monthly gross; special allowance is the rest.
    basicPercent: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/)
      .nullable()
      .optional(),
    hraPercent: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/)
      .nullable()
      .optional(),
    // Recurring monthly deductions, copied into each draft payslip.
    pfAmount: z
      .string()
      .regex(/^\d{1,10}(\.\d{1,2})?$/)
      .nullable()
      .optional(),
    tdsAmount: z
      .string()
      .regex(/^\d{1,10}(\.\d{1,2})?$/)
      .nullable()
      .optional(),
    professionalTaxAmount: z
      .string()
      .regex(/^\d{1,10}(\.\d{1,2})?$/)
      .nullable()
      .optional(),
    otherDeductionAmount: z
      .string()
      .regex(/^\d{1,10}(\.\d{1,2})?$/)
      .nullable()
      .optional(),
    // CNPS contribution % of the basic share — feeds the TDS calculator.
    cnpsPercent: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/)
      .nullable()
      .optional(),
    // Annual variable-pay target — joins taxable income in the TDS projection.
    variablePay: z
      .string()
      .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Must be a number with at most 2 decimals')
      .nullable()
      .optional(),
  })
  .strict()
  .openapi('UpdateEmployeeSalary');

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
/** HR's incomplete-records strip: a live record + which intake details it lacks. */
export const INTAKE_FIELDS = ['dateOfJoining', 'departmentId', 'designation'] as const;
export const incompleteRecordSchema = z
  .object({
    employee: employeeSchema,
    missing: z.array(z.enum(INTAKE_FIELDS)),
  })
  .openapi('IncompleteRecord');

/**
 * Bulk import (refinement plan, Phase 1): rows as parsed from HR's CSV, all
 * strings — the SERVICE validates and reports per line, so one bad cell
 * never hides the others. Max 500 rows per file.
 */
export const importRowSchema = z.object({
  email: z.string().max(200),
  name: z.string().max(200),
  managerEmail: z.string().max(200),
  level: z.string().max(10),
  dateOfJoining: z.string().max(20).optional(),
  department: z.string().max(200).optional(),
  designation: z.string().max(200).optional(),
});
export const importEmployeesSchema = z
  .object({
    /** true = validate only (nothing is written). */
    dryRun: z.boolean(),
    rows: z.array(importRowSchema).min(1).max(500),
  })
  .strict()
  .openapi('ImportEmployees');

export const importResultSchema = z
  .object({
    dryRun: z.boolean(),
    /** True when every row passed — only then does a real run write anything. */
    valid: z.boolean(),
    rows: z.array(
      z.object({
        /** 1-based position in the uploaded rows (excluding the header). */
        line: z.number().int(),
        email: z.string(),
        name: z.string(),
        errors: z.array(z.string()),
      }),
    ),
    /** Real run only: who was created, with their one-time claim link token. */
    created: z.array(
      z.object({
        name: z.string(),
        email: z.string(),
        employeeCode: z.string(),
        claimToken: z.string(),
        claimExpiresAt: z.string().datetime(),
      }),
    ),
  })
  .openapi('ImportEmployeesResult');

export type InviteEmployeeInput = z.infer<typeof inviteEmployeeSchema>;
export type ImportEmployeesInput = z.infer<typeof importEmployeesSchema>;
export type ImportResultDto = z.infer<typeof importResultSchema>;
export type IncompleteRecordDto = z.infer<typeof incompleteRecordSchema>;
export type UpdateSalaryInput = z.infer<typeof updateSalarySchema>;

/** Bank details on their own door (pr.payroll.bank_details update). */
export const updateBankDetailsSchema = z
  .object({
    bankName: z.string().trim().max(120).nullable().optional(),
    bankAccountNo: z
      .string()
      .trim()
      .regex(/^[0-9A-Za-z]{6,34}$/, 'Account number: 6–34 letters or digits')
      .nullable()
      .optional(),
    ifscCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, 'IFSC: 4 letters, 0, then 6 letters or digits')
      .nullable()
      .optional(),
  })
  .strict()
  .openapi('UpdateBankDetails');

export type UpdateBankDetailsInput = z.infer<typeof updateBankDetailsSchema>;
