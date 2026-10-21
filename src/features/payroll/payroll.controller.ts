import type { Request, Response } from 'express';
import createError from 'http-errors';
import { isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createAttendanceRepository } from '../attendance/attendance.repository.js';
import { createAttendanceService } from '../attendance/attendance.service.js';
import { createExitsFnf } from '../exits/index.js';
import { createLeavesRepository } from '../leaves/leaves.repository.js';
import { createLeavesService } from '../leaves/leaves.service.js';
import { createSettingsRepository } from '../settings/index.js';
import { createLoansRepository } from './loans.repository.js';
import type { CloseLoanInput, CreateLoanInput, UpdateLoanInput } from './loans.schema.js';
import { createLoansService } from './loans.service.js';
import { createPayrollRepository } from './payroll.repository.js';
import {
  annexureQuerySchema,
  type CreateCorrectionInput,
  type CreateRunInput,
  type FnfRecoveryInput,
  type UpdatePayslipInput,
} from './payroll.schema.js';
import { createPayrollService } from './payroll.service.js';

/**
 * Composition root. Payroll composes the ATTENDANCE service for LOP — the
 * classifier runs in-process, so PR users never need an hrbp.attendance grant —
 * and the LEAVES service for the month-end partial-approval sweep. Both
 * payroll and its attendance read org settings (PT, auto-cover, work hours).
 */
const service = (req: Request) => {
  const settings = createSettingsRepository(req.db);
  return createPayrollService({
    repo: createPayrollRepository(req.db),
    attendance: createAttendanceService({
      repo: createAttendanceRepository(req.db),
      authz: createAuthzRepository(req.db),
      settings,
    }),
    leaves: createLeavesService({
      repo: createLeavesRepository(req.db),
      authz: createAuthzRepository(req.db),
      settings,
    }),
    settings,
    exits: createExitsFnf(req.db),
    authz: createAuthzRepository(req.db),
    loans: createLoansService({ repo: createLoansRepository(req.db) }),
  });
};

const loansService = (req: Request) =>
  createLoansService({ repo: createLoansRepository(req.db) });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

const requireId = (req: Request, param: string): string => {
  const value = req.params[param];
  if (!isUuid(value)) throw createError(400, `Invalid ${param}`);
  return value;
};

/** A generated PDF as a download — never cached (it carries pay). */
const sendPdf = (res: Response, pdf: { file: Buffer; filename: string }): void => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${pdf.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(pdf.file);
};

/** HTTP layer only: read validated input, call the service, shape the response. */
export const payrollController = {
  // ── Loans & advances (close-out) ──
  loans: async (req: Request, res: Response): Promise<void> => {
    res.json(await loansService(req).list());
  },
  myLoans: async (req: Request, res: Response): Promise<void> => {
    res.json(await loansService(req).mine(req.auth!.employeeId));
  },
  loan: async (req: Request, res: Response): Promise<void> => {
    res.json(await loansService(req).detail(requireId(req, 'loanId')));
  },
  myLoan: async (req: Request, res: Response): Promise<void> => {
    res.json(await loansService(req).detail(requireId(req, 'loanId'), req.auth!.employeeId));
  },
  createLoan: async (req: Request, res: Response): Promise<void> => {
    const input: CreateLoanInput = req.body;
    const loan = await loansService(req).create(input, actor(req));
    req.log.info({ loanId: loan.id, kind: loan.kind }, 'loan recorded');
    res.status(201).json(loan);
  },
  updateLoan: async (req: Request, res: Response): Promise<void> => {
    const input: UpdateLoanInput = req.body;
    res.json(await loansService(req).update(requireId(req, 'loanId'), input, actor(req)));
  },
  closeLoan: async (req: Request, res: Response): Promise<void> => {
    const input: CloseLoanInput = req.body;
    res.json(await loansService(req).close(requireId(req, 'loanId'), input, actor(req)));
  },

  // ── Full & final (exit module) ──
  exitRecoveries: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).recoveries(requireId(req, 'exitId')));
  },
  addExitRecovery: async (req: Request, res: Response): Promise<void> => {
    const input: FnfRecoveryInput = req.body;
    res.status(201).json(await service(req).addRecovery(requireId(req, 'exitId'), input, actor(req)));
  },
  removeExitRecovery: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await service(req).removeRecovery(
        requireId(req, 'exitId'),
        requireId(req, 'recoveryId'),
        actor(req),
      ),
    );
  },
  exitStatementPdf: async (req: Request, res: Response): Promise<void> => {
    sendPdf(res, await service(req).exitStatementPdf(requireId(req, 'exitId'), req.auth!.employeeId));
  },

  myPayslipPdf: async (req: Request, res: Response): Promise<void> => {
    sendPdf(
      res,
      await service(req).myPayslipPdf(req.auth!.employeeId, requireId(req, 'payslipId')),
    );
  },

  runPayslipPdf: async (req: Request, res: Response): Promise<void> => {
    sendPdf(
      res,
      await service(req).runPayslipPdf(requireId(req, 'id'), requireId(req, 'payslipId')),
    );
  },

  listCorrections: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).listCorrections());
  },

  addCorrection: async (req: Request, res: Response): Promise<void> => {
    const input: CreateCorrectionInput = req.body;
    const row = await service(req).addCorrection(requireId(req, 'payslipId'), input, actor(req));
    req.log.info({ correction: row.id, sourceMonth: row.sourceMonth }, 'payslip correction added');
    res.status(201).json(row);
  },

  cancelCorrection: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).cancelCorrection(requireId(req, 'id'), actor(req)));
  },

  listRuns: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).listRuns());
  },

  getRun: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).getRun(requireId(req, 'id')));
  },

  generate: async (req: Request, res: Response): Promise<void> => {
    const input: CreateRunInput = req.body;
    const result = await service(req).generate(input, actor(req));
    req.log.info(
      {
        month: input.month,
        payslips: result.payslips.length,
        skipped: result.skipped.length,
      },
      'payroll run generated',
    );
    res.status(201).json(result);
  },

  regenerate: async (req: Request, res: Response): Promise<void> => {
    const result = await service(req).regenerate(requireId(req, 'id'), actor(req));
    req.log.info({ runId: req.params.id }, 'payroll run regenerated');
    res.json(result);
  },

  updatePayslip: async (req: Request, res: Response): Promise<void> => {
    const input: UpdatePayslipInput = req.body;
    const slip = await service(req).updatePayslip(
      requireId(req, 'id'),
      requireId(req, 'payslipId'),
      input,
      actor(req),
    );
    req.log.info({ payslipId: slip.id }, 'payslip updated');
    res.json(slip);
  },

  finalize: async (req: Request, res: Response): Promise<void> => {
    const run = await service(req).finalize(requireId(req, 'id'), actor(req));
    req.log.info({ runId: run.id, month: run.month }, 'payroll run finalized');
    res.json(run);
  },

  markPaid: async (req: Request, res: Response): Promise<void> => {
    const run = await service(req).markPaid(requireId(req, 'id'), actor(req));
    req.log.info({ runId: run.id, month: run.month }, 'payroll run paid');
    res.json(run);
  },

  deleteRun: async (req: Request, res: Response): Promise<void> => {
    await service(req).deleteRun(requireId(req, 'id'), actor(req));
    req.log.info({ runId: req.params.id }, 'payroll run deleted');
    res.status(204).end();
  },

  myPayslips: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).myPayslips(req.auth!.employeeId));
  },

  tdsEstimates: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).tdsEstimates());
  },

  annexure: async (req: Request, res: Response): Promise<void> => {
    const parsed = annexureQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw createError(
        400,
        parsed.error.issues[0]?.message ?? 'Invalid annexure inputs',
      );
    }
    res.json(await service(req).annexure(parsed.data));
  },

  updateTds: async (req: Request, res: Response): Promise<void> => {
    const { employeeId } = req.params;
    if (!isUuid(employeeId)) throw createError(400, 'Invalid employee id');
    const row = await service(req).updateTds(employeeId, req.body, actor(req));
    req.log.info({ employeeId }, 'tds settings updated');
    res.json(row);
  },
};
