/**
 * Payroll — monthly runs (draft → finalized → paid) of CTC-derived payslips
 * with attendance-driven LOP and recurring manual deductions. Public surface.
 */
export { payrollRoutes } from './payroll.routes.js';
export { registerPayrollDocs } from './payroll.docs.js';
export type { PayrollRunDto, PayslipDto, MyPayslipDto } from './payroll.schema.js';
