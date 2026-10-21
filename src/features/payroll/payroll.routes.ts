import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAccess } from '../../middleware/authorize.js';
import { validateBody } from '../../middleware/validateBody.js';
import { closeLoanSchema, createLoanSchema, updateLoanSchema } from './loans.schema.js';
import { payrollController } from './payroll.controller.js';
import {
  createCorrectionSchema,
  createRunSchema,
  fnfRecoveryInputSchema,
  updatePayslipSchema,
  updateTdsSchema,
} from './payroll.schema.js';

/**
 * Payroll — mounted at /api/v1/payroll. Runs and payslips gate on the PARENT
 * pr.payroll module; the salary row keeps its own pr.payroll.compensation
 * gate (grants never cascade, §4.2). An employee's own published payslips are
 * me-scope, like /me/salary.
 *
 *   GET    /payslips/mine        -> own payslips (finalized/paid runs only)
 *   GET    /payslips/mine/:payslipId/pdf -> own published slip as a PDF (me scope)
 *   GET    /runs                 -> runs list          (pr.payroll read)
 *   POST   /runs                 -> generate a draft   (pr.payroll create)
 *   GET    /runs/:id             -> run + payslips     (pr.payroll read)
 *   POST   /runs/:id/regenerate  -> draft only         (pr.payroll update)
 *   PATCH  /runs/:id/payslips/:payslipId -> draft only (pr.payroll update)
 *   GET    /runs/:id/payslips/:payslipId/pdf -> any slip as a PDF, drafts watermarked (pr.payroll read)
 *   POST   /runs/:id/finalize    -> draft -> finalized (pr.payroll update)
 *   POST   /runs/:id/mark-paid   -> finalized -> paid  (pr.payroll update)
 *   DELETE /runs/:id             -> draft only         (pr.payroll delete)
 *   GET    /corrections          -> post-finalize corrections (pr.payroll read)
 *   POST   /payslips/:payslipId/corrections -> correct a PUBLISHED slip;
 *                                    rides on the next run (pr.payroll update)
 *   POST   /corrections/:id/cancel -> pending only      (pr.payroll update)
 *   GET    /loans, /loans/:id         -> the loan register (pr.payroll.compensation read)
 *   POST   /loans                     -> record a loan / advance (… update)
 *   PATCH  /loans/:id                 -> new rate / months left (… update)
 *   POST   /loans/:id/close           -> settled outside payroll (… update)
 *   GET    /loans/mine[/:id]          -> own loans + schedule (me scope)
 *   GET    /exits/:exitId/recoveries  -> F&F recovery lines (pr.payroll read)
 *   POST   /exits/:exitId/recoveries  -> add one            (pr.payroll update)
 *   DELETE /exits/:exitId/recoveries/:recoveryId            (pr.payroll update)
 *   GET    /exits/:exitId/statement   -> the settled F&F as a PDF
 *                                        (payroll, or HR in reach — service-gated)
 */
export const payrollRoutes = Router();

payrollRoutes.use(authenticate);

payrollRoutes.get('/payslips/mine', payrollController.myPayslips);
payrollRoutes.get('/payslips/mine/:payslipId/pdf', payrollController.myPayslipPdf);

// Loans & advances (close-out): payroll records them; amounts per person, so
// the compensation child gates the register. Own loans are me-scope.
payrollRoutes.get('/loans/mine', payrollController.myLoans);
payrollRoutes.get('/loans/mine/:loanId', payrollController.myLoan);
payrollRoutes.get(
  '/loans',
  requireAccess('pr.payroll.compensation', 'read', { orgOnly: true }),
  payrollController.loans,
);
payrollRoutes.get(
  '/loans/:loanId',
  requireAccess('pr.payroll.compensation', 'read', { orgOnly: true }),
  payrollController.loan,
);
payrollRoutes.post(
  '/loans',
  requireAccess('pr.payroll.compensation', 'update', { orgOnly: true }),
  validateBody(createLoanSchema),
  payrollController.createLoan,
);
payrollRoutes.patch(
  '/loans/:loanId',
  requireAccess('pr.payroll.compensation', 'update', { orgOnly: true }),
  validateBody(updateLoanSchema),
  payrollController.updateLoan,
);
payrollRoutes.post(
  '/loans/:loanId/close',
  requireAccess('pr.payroll.compensation', 'update', { orgOnly: true }),
  validateBody(closeLoanSchema),
  payrollController.closeLoan,
);

// Full & final: payroll's recovery lines on an exit, and the settled statement.
payrollRoutes.get(
  '/exits/:exitId/recoveries',
  requireAccess('pr.payroll', 'read', { orgOnly: true }),
  payrollController.exitRecoveries,
);
payrollRoutes.post(
  '/exits/:exitId/recoveries',
  requireAccess('pr.payroll', 'update', { orgOnly: true }),
  validateBody(fnfRecoveryInputSchema),
  payrollController.addExitRecovery,
);
payrollRoutes.delete(
  '/exits/:exitId/recoveries/:recoveryId',
  requireAccess('pr.payroll', 'update', { orgOnly: true }),
  payrollController.removeExitRecovery,
);
payrollRoutes.get('/exits/:exitId/statement', payrollController.exitStatementPdf);

// TDS calculator (ERP sheet's TDS tab). It shows annual CTCs, so BOTH doors
// sit behind the compensation child module — a plain pr.payroll grant never
// silently exposes pay (§4.2).
payrollRoutes.get(
  '/tds',
  requireAccess('pr.payroll.compensation', 'read', { orgOnly: true }),
  payrollController.tdsEstimates,
);
payrollRoutes.patch(
  '/tds/:employeeId',
  requireAccess('pr.payroll.compensation', 'update', { orgOnly: true }),
  validateBody(updateTdsSchema),
  payrollController.updateTds,
);

// Salary annexure (offer breakup) — same engine as the payslip, so the offer
// matches month one. Pure calculator over query params (?ctc=&ptState=&variablePay=…);
// it prices a CTC, so it sits behind the compensation child too.
payrollRoutes.get(
  '/annexure',
  requireAccess('pr.payroll.compensation', 'read', { orgOnly: true }),
  payrollController.annexure,
);

payrollRoutes.get(
  '/runs',
  requireAccess('pr.payroll', 'read', { orgOnly: true }),
  payrollController.listRuns,
);
payrollRoutes.post(
  '/runs',
  requireAccess('pr.payroll', 'create', { orgOnly: true }),
  validateBody(createRunSchema),
  payrollController.generate,
);
payrollRoutes.get(
  '/runs/:id',
  requireAccess('pr.payroll', 'read', { orgOnly: true }),
  payrollController.getRun,
);
payrollRoutes.post(
  '/runs/:id/regenerate',
  requireAccess('pr.payroll', 'update', { orgOnly: true }),
  payrollController.regenerate,
);
payrollRoutes.patch(
  '/runs/:id/payslips/:payslipId',
  requireAccess('pr.payroll', 'update', { orgOnly: true }),
  validateBody(updatePayslipSchema),
  payrollController.updatePayslip,
);
payrollRoutes.post(
  '/runs/:id/finalize',
  requireAccess('pr.payroll', 'update', { orgOnly: true }),
  payrollController.finalize,
);
payrollRoutes.post(
  '/runs/:id/mark-paid',
  requireAccess('pr.payroll', 'update', { orgOnly: true }),
  payrollController.markPaid,
);
payrollRoutes.delete(
  '/runs/:id',
  requireAccess('pr.payroll', 'delete', { orgOnly: true }),
  payrollController.deleteRun,
);

payrollRoutes.get(
  '/corrections',
  requireAccess('pr.payroll', 'read', { orgOnly: true }),
  payrollController.listCorrections,
);
payrollRoutes.post(
  '/payslips/:payslipId/corrections',
  requireAccess('pr.payroll', 'update', { orgOnly: true }),
  validateBody(createCorrectionSchema),
  payrollController.addCorrection,
);
payrollRoutes.post(
  '/corrections/:id/cancel',
  requireAccess('pr.payroll', 'update', { orgOnly: true }),
  payrollController.cancelCorrection,
);
payrollRoutes.get(
  '/runs/:id/payslips/:payslipId/pdf',
  requireAccess('pr.payroll', 'read', { orgOnly: true }),
  payrollController.runPayslipPdf,
);
