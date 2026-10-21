import type { Request, Response } from 'express';
import { assertReaches, keepReachable } from '../../middleware/authorize.js';
import createError from 'http-errors';
import { hasOrgScope, isUuid } from '../../shared/helpers/helpers.js';
import { createAuthzRepository } from '../access/authz.repository.js';
import { createSettingsRepository } from '../settings/index.js';
import { createEmployeesRepository } from './employees.repository.js';
import type {
  CreateEmployeeInput,
  ImportEmployeesInput,
  InviteEmployeeInput,
  UpdateBankDetailsInput,
  UpdateEmployeeInput,
  UpdateSalaryInput,
} from './employees.schema.js';
import { createEmployeesService } from './employees.service.js';

/** Composition root: request-scoped repository + org settings (new-hire defaults). */
const service = (req: Request) =>
  createEmployeesService({
    repo: createEmployeesRepository(req.db),
    settings: createSettingsRepository(req.db),
    authz: createAuthzRepository(req.db),
  });

/** Does the caller hold pr.payroll.bank_details (org) for this action? */
const holdsBank = async (req: Request, action: 'read' | 'update'): Promise<boolean> =>
  hasOrgScope(
    await createAuthzRepository(req.db).resolveAccess(
      req.auth!.employeeId,
      'pr.payroll.bank_details',
      action,
    ),
  );

/** HTTP layer only: read validated input, call the service, shape the response. */
export const employeesController = {
  list: async (req: Request, res: Response): Promise<void> => {
    res.json(await keepReachable(req, await service(req).list(), (e) => e.id));
  },

  importEmployees: async (req: Request, res: Response): Promise<void> => {
    const input: ImportEmployeesInput = req.body;
    const result = await service(req).importEmployees(input, {
      actorUserId: req.auth!.userId,
      actorEmployeeId: req.auth!.employeeId,
    });
    if (!result.dryRun) {
      req.log.info({ created: result.created.length }, 'employees imported');
    }
    // A rejected real run answers 422 with the same per-line report.
    res.status(!result.dryRun && !result.valid ? 422 : 200).json(result);
  },

  incomplete: async (req: Request, res: Response): Promise<void> => {
    res.json(
      await keepReachable(req, await service(req).incomplete(), (r) => r.employee.id),
    );
  },

  getById: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid employee id');
    await assertReaches(req, id, 'hide');
    res.json(await service(req).getById(id));
  },

  create: async (req: Request, res: Response): Promise<void> => {
    const input: CreateEmployeeInput = req.body;
    const { employee, employeeBatchAttached, claim } = await service(req).create(input, {
      actorUserId: req.auth!.userId,
      actorEmployeeId: req.auth!.employeeId,
    });
    if (!employeeBatchAttached) {
      // Seed gap, not a request failure — onboarding proceeded without it.
      req.log.warn(
        { employeeId: employee.id },
        'Employee batch missing; run db:seed-batches',
      );
    }
    req.log.info({ employeeId: employee.id }, 'employee created');
    // `claim.token` appears ONCE, here — only its hash is stored.
    res.status(201).json({ ...employee, claim });
  },

  invite: async (req: Request, res: Response): Promise<void> => {
    const input: InviteEmployeeInput = req.body;
    const { employee, employeeBatchAttached, claim } = await service(req).invite(input, {
      actorUserId: req.auth!.userId,
      actorEmployeeId: req.auth!.employeeId,
    });
    if (!employeeBatchAttached) {
      req.log.warn(
        { employeeId: employee.id },
        'Employee batch missing; run db:seed-batches',
      );
    }
    req.log.info({ employeeId: employee.id }, 'employee invited');
    res.status(201).json({ ...employee, claim });
  },

  claimLink: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid employee id');
    await assertReaches(req, id);
    const claim = await service(req).issueClaimLink(id, {
      actorUserId: req.auth!.userId,
      actorEmployeeId: req.auth!.employeeId,
    });
    req.log.info({ employeeId: id }, 'claim link reissued');
    res.json(claim);
  },

  update: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid employee id');
    await assertReaches(req, id);
    const input: UpdateEmployeeInput = req.body;
    res.json(
      await service(req).update(id, input, {
        actorUserId: req.auth!.userId,
        actorEmployeeId: req.auth!.employeeId,
      }),
    );
  },

  getSalary: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid employee id');
    res.json(await service(req).getSalary(id, await holdsBank(req, 'read')));
  },

  updateSalary: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid employee id');
    const input: UpdateSalaryInput = req.body;
    const [canSeeBank, canEditBank] = await Promise.all([
      holdsBank(req, 'read'),
      holdsBank(req, 'update'),
    ]);
    const salary = await service(req).updateSalary(
      id,
      input,
      { actorUserId: req.auth!.userId, actorEmployeeId: req.auth!.employeeId },
      { canSeeBank, canEditBank },
    );
    req.log.info({ employeeId: id }, 'salary updated');
    res.json(salary);
  },

  getBankDetails: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid employee id');
    res.json(await service(req).getBankDetails(id));
  },

  updateBankDetails: async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    if (!isUuid(id)) throw createError(400, 'Invalid employee id');
    const input: UpdateBankDetailsInput = req.body;
    const bank = await service(req).updateBankDetails(id, input, {
      actorUserId: req.auth!.userId,
      actorEmployeeId: req.auth!.employeeId,
    });
    req.log.info({ employeeId: id }, 'bank details updated');
    res.json(bank);
  },
};
