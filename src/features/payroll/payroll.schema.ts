import { z } from '../../shared/zod.js';

const RUN_STATUSES = ['draft', 'finalized', 'paid'] as const;

/** A payroll run as the PR console lists it. */
export const payrollRunSchema = z
  .object({
    id: z.string().uuid(),
    month: z.string(), // YYYY-MM
    status: z.enum(RUN_STATUSES),
    payslipCount: z.number().int(),
    netTotal: z.number(),
    createdAt: z.string().datetime(),
    finalizedAt: z.string().nullable(),
    paidAt: z.string().nullable(),
  })
  .openapi('PayrollRun');

/** A payslip — every number is a locked snapshot once the run finalizes. */
export const payslipSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
    }),
    // No `ctc` here (M6): annual compensation stays behind the dedicated
    // pr.payroll.compensation gate; run review only needs the monthly figures.
    currency: z.string(),
    // ERP-sheet model: monthly CTC, prorated over a 30-day base; structure
    // Basic / HRA (per person, default 50 / 25) / LTA 10 / Special =
    // remainder-after-PF. The split is snapshotted at build.
    basicPercent: z.number(),
    hraPercent: z.number(),
    monthlyGross: z.number(),
    basic: z.number(),
    hra: z.number(),
    lta: z.number(),
    specialAllowance: z.number(),
    workingDays: z.number(),
    lopDays: z.number(),
    lopAmount: z.number(),
    // Month-end auto-leave: absence covered from the earned balance;
    // provisional in draft, locked at finalize. lopOverridden = PR took manual
    // control of LOP for this slip, auto-split skipped.
    autoElDays: z.number(),
    autoSlDays: z.number(),
    autoClDays: z.number(),
    lopOverridden: z.boolean(),
    // PF (both sides) and PT are computed by the engine, never typed in.
    pf: z.number(),
    pfEmployer: z.number(),
    tds: z.number(),
    professionalTax: z.number(),
    otherDeduction: z.number(),
    healthInsurance: z.number(),
    cnpsEmployer: z.number(),
    reimbursement: z.number(),
    performanceBonus: z.number(),
    /** Approved R&R awards from the previous month (read-only). */
    recognitionBonus: z.number(),
    otherBonus: z.number(),
    leaveEncashment: z.number(),
    advance: z.number(),
    /** Full & final (exit module): set only on the slip that settles an exit. */
    exitId: z.string().uuid().nullable(),
    encashedElDays: z.number(),
    gratuityYears: z.number().int(),
    gratuity: z.number(),
    noticePay: z.number(),
    noticeRecovery: z.number(),
    sickLopDays: z.number(),
    sickLopDeduction: z.number(),
    fnfRecovery: z.number(),
    /** Loan / advance EMIs this month (the whole balance on an F&F slip). */
    loanEmi: z.number(),
    earningsTotal: z.number(),
    deductionsTotal: z.number(),
    netPay: z.number(),
    /**
     * The approved claims behind `reimbursement` (a draft: approved and
     * unpaid, spent by this month; a published run: the ones it paid).
     */
    reimbursementClaims: z.array(
      z.object({
        id: z.string().uuid(),
        spentOn: z.string(),
        category: z.string(),
        description: z.string(),
        amount: z.number(),
      }),
    ),
    /** Signed total of corrections to earlier slips carried by this one. */
    correction: z.number(),
    /** The corrections behind `correction` (pending ones while a draft). */
    corrections: z.array(
      z.object({
        id: z.string().uuid(),
        sourceMonth: z.string(),
        amount: z.number(),
        reason: z.string(),
      }),
    ),
    /** Corrections recorded AGAINST this slip, and the month that carries each. */
    correctedBy: z.array(
      z.object({
        id: z.string().uuid(),
        amount: z.number(),
        reason: z.string(),
        status: z.enum(['pending', 'applied', 'cancelled']),
        appliedMonth: z.string().nullable(),
      }),
    ),
    /** The PT state the slip was taxed under (null = no PT). */
    ptState: z.string().nullable(),
    /** Net + reimbursement/bonuses/encashment/advance + correction — the sheet's AH. */
    finalPay: z.number(),
  })
  .openapi('Payslip');

/** An employee's own view: the payslip plus which month/stage it belongs to. */
export const myPayslipSchema = payslipSchema
  .extend({ month: z.string(), runStatus: z.enum(RUN_STATUSES) })
  .openapi('MyPayslip');

export const createRunSchema = z
  .object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM') })
  .strict()
  .openapi('CreatePayrollRun');

/**
 * Draft-only overrides — exactly what a human types on the ERP sheet. PF and
 * PT are computed, never accepted; totals always recompute server-side.
 */
export const updatePayslipSchema = z
  .object({
    lopDays: z.number().min(0).max(30).optional(),
    tds: z.number().min(0).optional(),
    otherDeduction: z.number().min(0).optional(),
    healthInsurance: z.number().min(0).optional(),
    cnpsEmployer: z.number().min(0).optional(),
    performanceBonus: z.number().min(0).optional(),
    otherBonus: z.number().min(0).optional(),
    leaveEncashment: z.number().min(0).optional(),
    advance: z.number().min(0).optional(),
  })
  .strict()
  .openapi('UpdatePayslip');

/**
 * Who payroll can put on payroll: every invited / active / exiting person
 * (not the Owner-linked account). Invited joiners are included on purpose —
 * salary is set up before day one. No pay fields; the salary door is separate.
 */
export const compensationPersonSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    employeeCode: z.string(),
    status: z.enum(['invited', 'active', 'exiting']),
  })
  .openapi('CompensationPerson');

/**
 * One row of the TDS calculator (ERP sheet, "TDS" tab): new-regime slabs with
 * 4% cess on FY-prorated CTC less the standard deduction, employer PF and
 * CNPS. Exposes annual CTC, so the endpoint sits behind
 * `pr.payroll.compensation`.
 */
export const tdsEstimateSchema = z
  .object({
    employee: z.object({ id: z.string().uuid(), name: z.string(), employeeCode: z.string() }),
    ctc: z.number(),
    dateOfJoining: z.string().nullable(),
    fyClose: z.string(),
    /** (fyClose − DOJ)/30, capped at 12 — the sheet's "Months". */
    fyMonths: z.number(),
    payrollMonthsRemaining: z.number().int(),
    cnpsPercent: z.number(),
    fyCtc: z.number(),
    cnpsAmount: z.number(),
    stdDeduction: z.number(),
    employerPfAnnual: z.number(),
    /** Annual variable-pay target on the salary row (0 when unset). */
    variablePay: z.number(),
    /** Its FY share (same months as CTC) — part of taxable income. */
    fyVariablePay: z.number(),
    taxableIncome: z.number(),
    /** Surcharge above ₹50L (10% / 15% / 25%, marginal relief) before cess. */
    surcharge: z.number(),
    /** (Slab tax + surcharge) × 1.04 cess; zero up to the 12L rebate line. */
    totalTax: z.number(),
    tdsPerMonth: z.number(),
    /** TDS already in published slips this FY. */
    tdsAlreadyDeducted: z.number(),
    /** (totalTax − already) ÷ months left in the FY — the sheet's "Revised TDS". */
    revisedTdsPerMonth: z.number(),
    /** What drafts currently pick up (employee_salary.tds_amount). */
    currentTdsAmount: z.number(),
  })
  .openapi('TdsEstimate');

export const updateTdsSchema = z
  .object({
    tdsAmount: z.number().min(0).optional(),
    cnpsPercent: z.number().min(0).max(100).optional(),
  })
  .strict()
  .refine((v) => v.tdsAmount !== undefined || v.cnpsPercent !== undefined, {
    message: 'Nothing to update',
  })
  .openapi('UpdateTds');

/**
 * Salary annexure (offer breakup) — the payroll review doc's target flow §9:
 * "the offer matches the payslip". Unlike the ERP sheet's Annexure tab
 * (PF capped at ₹3,000 — the doc's #1 HIGH finding), this breakup is computed
 * by the SAME engine as the payslip (blended PF, PT, full-year TDS with
 * marginal relief), so nothing promised in an offer disagrees with month one.
 */
export const annexureQuerySchema = z
  .object({
    /** ANNUAL CTC in ₹. */
    ctc: z.coerce.number().min(1_000).max(1_000_000_000),
    /** The PT state (payroll.ptStates) the person is based in; none = no PT. */
    ptState: z.string().trim().max(60).optional(),
    /** ANNUAL variable-pay target in ₹ — joins taxable income. */
    variablePay: z.coerce.number().min(0).max(1_000_000_000).default(0),
    healthInsurance: z.coerce.number().min(0).max(100_000).default(541),
    cnpsPercent: z.coerce.number().min(0).max(100).default(0),
    /** The structure split; Basic + HRA + LTA (10) must stay within 100. */
    basicPercent: z.coerce.number().min(1).max(90).default(50),
    hraPercent: z.coerce.number().min(0).max(89).default(25),
  })
  .refine((q) => q.basicPercent + q.hraPercent + 10 <= 100, {
    message: 'Basic + HRA + LTA (10%) cannot exceed 100%',
    path: ['hraPercent'],
  })
  .openapi('AnnexureQuery');

export const salaryAnnexureSchema = z
  .object({
    ctcAnnual: z.number(),
    ctcMonthly: z.number(),
    basic: z.number(),
    hra: z.number(),
    lta: z.number(),
    /** Balancing figure — Basic+HRA+LTA+Special+PF(ER) always sums to CTC. */
    specialAllowance: z.number(),
    /** CTC monthly − employer PF. */
    grossSalary: z.number(),
    pfEmployee: z.number(),
    pfEmployer: z.number(),
    professionalTax: z.number(),
    healthInsurance: z.number(),
    cnpsEmployer: z.number(),
    variablePayAnnual: z.number(),
    taxableIncome: z.number(),
    surchargeAnnual: z.number(),
    totalTaxAnnual: z.number(),
    tdsPerMonth: z.number(),
    /** After PF both sides, PT, TDS, health insurance and CNPS — the bank figure, NOT the sheet's pre-tax "Net Take Home". */
    netTakeHome: z.number(),
  })
  .openapi('SalaryAnnexure');

/** POST /runs result: the run, its payslips, and who had no CTC to pay from. */
export const generateRunResultSchema = z
  .object({
    run: payrollRunSchema,
    payslips: z.array(payslipSchema),
    skipped: z.array(
      z.object({ id: z.string().uuid(), name: z.string(), employeeCode: z.string() }),
    ),
  })
  .openapi('GeneratePayrollRunResult');

/** A post-finalize correction as the PR console lists it. */
export const payslipCorrectionSchema = z
  .object({
    id: z.string().uuid(),
    employee: z.object({ id: z.string().uuid(), name: z.string(), employeeCode: z.string() }),
    sourcePayslipId: z.string().uuid(),
    sourceMonth: z.string(),
    amount: z.number(),
    reason: z.string(),
    status: z.enum(['pending', 'applied', 'cancelled']),
    appliedMonth: z.string().nullable(),
    createdByName: z.string(),
    createdAt: z.string().datetime(),
  })
  .openapi('PayslipCorrection');

export const createCorrectionSchema = z
  .object({
    /** + pays the employee more, − recovers an overpayment. Never zero. */
    amount: z
      .number()
      .refine((n) => n !== 0, 'A correction cannot be zero')
      .refine((n) => Math.abs(n) <= 10_000_000, 'Amount is out of range'),
    reason: z.string().trim().min(10).max(500),
  })
  .strict()
  .openapi('CreatePayslipCorrection');

export type PayrollRunDto = z.infer<typeof payrollRunSchema>;
export type PayslipCorrectionDto = z.infer<typeof payslipCorrectionSchema>;
export type CreateCorrectionInput = z.infer<typeof createCorrectionSchema>;
export type PayslipDto = z.infer<typeof payslipSchema>;
export type MyPayslipDto = z.infer<typeof myPayslipSchema>;
export type CreateRunInput = z.infer<typeof createRunSchema>;
export type UpdatePayslipInput = z.infer<typeof updatePayslipSchema>;
export type TdsEstimateDto = z.infer<typeof tdsEstimateSchema>;
export type CompensationPersonDto = z.infer<typeof compensationPersonSchema>;
export type UpdateTdsInput = z.infer<typeof updateTdsSchema>;
export type AnnexureQuery = z.infer<typeof annexureQuerySchema>;
export type SalaryAnnexureDto = z.infer<typeof salaryAnnexureSchema>;
export type GenerateRunResultDto = z.infer<typeof generateRunResultSchema>;

/** A recovery line payroll types into someone's F&F (no loan register yet). */
export const fnfRecoveryInputSchema = z
  .object({
    label: z.string().trim().min(2).max(120),
    amount: z.number().positive().max(10_000_000),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .openapi('FnfRecoveryInput');

export const fnfRecoverySchema = z
  .object({
    id: z.string().uuid(),
    label: z.string(),
    amount: z.number(),
    note: z.string().nullable(),
  })
  .openapi('FnfRecovery');

export type FnfRecoveryInput = z.infer<typeof fnfRecoveryInputSchema>;
export type FnfRecoveryDto = z.infer<typeof fnfRecoverySchema>;
