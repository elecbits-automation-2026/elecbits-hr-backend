import createError from 'http-errors';
import type { AuthzRepository } from '../access/authz.repository.js';
import {
  INTAKE_FIELDS,
  type CreateEmployeeInput,
  type ImportEmployeesInput,
  type ImportResultDto,
  type IncompleteRecordDto,
  type InviteEmployeeInput,
  UpdateEmployeeInput,
  UpdateBankDetailsInput,
  UpdateSalaryInput,
} from './employees.schema.js';
import { env } from '../../config/env.js';
import {
  INVITE_LINK_DAYS,
  LEVELS,
  type Level,
} from '../../shared/constants/constants.js';
import {
  addMonthsIso,
  isCompanyEmail,
  newClaimToken,
} from '../../shared/helpers/helpers.js';
import type { SettingsReader } from '../settings/index.js';
import { toEmployee } from './employees.dto.js';
import type { ActorContext, EmployeesRepository } from './employees.repository.js';

/**
 * Postgres error codes surfaced as clean HTTP errors instead of raw 500s.
 * Drizzle wraps the pg error (DrizzleQueryError), so check `cause` too.
 */
const pgCode = (err: unknown): string | undefined => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
};
const isUniqueViolation = (err: unknown): boolean => pgCode(err) === '23505';
const isFkViolation = (err: unknown): boolean => pgCode(err) === '23503';

/**
 * Business rules for people records (§2). The rules this service owns:
 *  - top-down creation: the RM must already exist (§5.3);
 *  - NO REPORTING CYCLES — hard constraint (§10): walking up from the new RM
 *    must never reach the employee being edited;
 *  - manager-below-report level is a WARNING, not a block (§2.3);
 *  - the Employee batch attaches automatically on creation (§5.3) — wired to
 *    the access feature once its service lands;
 *  - deactivate, never delete (§10) — deactivation happens via the exits flow,
 *    not here;
 *  - new hires get the people.newHireDefaults notice period / probation when
 *    the inviter leaves them blank; claim links live INVITE_LINK_DAYS.
 */
export const createEmployeesService = (deps: {
  repo: EmployeesRepository;
  settings: SettingsReader;
  authz: AuthzRepository;
}) => {
  const { repo, settings, authz } = deps;

  /** Which intake details a record still lacks (empty = complete). */
  const missingIntake = (row: {
    dateOfJoining: string | null;
    departmentId: string | null;
    designation: string | null;
  }) =>
    INTAKE_FIELDS.filter((f) => row[f] === null || row[f] === undefined || row[f] === '');

  /** HR's incomplete-records strip (refinement plan, Phase 1). */
  /** toEmployee plus the department's name. */
  const withDepartment = async () => {
    const names = await repo.departmentNames();
    return (row: { departmentId: string | null }) =>
      row.departmentId ? (names.get(row.departmentId) ?? null) : null;
  };

  const incomplete = async (): Promise<IncompleteRecordDto[]> => {
    const rows = await repo.listIncomplete();
    const dept = await withDepartment();
    return rows.map((row) => ({
      employee: { ...toEmployee(row), departmentName: dept(row) },
      missing: missingIntake(row),
    }));
  };

  const newHirePolicy = () =>
    settings.effectiveMany(['people.newHireDefaults'] as const);

  const list = async () => {
    const rows = await repo.list();
    const dept = await withDepartment();
    return rows.map((row) => ({ ...toEmployee(row), departmentName: dept(row) }));
  };

  const getById = async (id: string) => {
    const row = await repo.findById(id);
    if (!row)
      throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
    const dept = await withDepartment();
    return { ...toEmployee(row), departmentName: dept(row) };
  };

  /** The full name follows the parts — empty/missing parts just drop out. */
  const composeName = (
    first: string | null | undefined,
    middle: string | null | undefined,
    last: string | null | undefined,
  ): string =>
    [first, middle, last].filter((p): p is string => Boolean(p && p.trim())).join(' ');

  const create = async (input: CreateEmployeeInput, actor: ActorContext) => {
    const rm = await repo.findById(input.reportsTo);
    if (!rm) {
      // Top-down creation (§5.3): a manager always exists before their reports.
      throw createError(422, 'Reporting manager does not exist', {
        code: 'RM_NOT_FOUND',
      });
    }
    const policy = await newHirePolicy();
    const defaults = policy['people.newHireDefaults'];
    // Claim security: the record is claimable only with this single-use token,
    // handed to the inviter ONCE (we store only its hash).
    const claim = newClaimToken(INVITE_LINK_DAYS);
    try {
      const { row, employeeBatchAttached } = await repo.insertWithOnboarding(
        {
          ...input,
          // Org defaults fill only what the inviter left blank.
          noticeDays: input.noticeDays ?? defaults.noticeDays ?? undefined,
          confirmationDate:
            input.confirmationDate ??
            (input.dateOfJoining && defaults.probationMonths !== null
              ? addMonthsIso(input.dateOfJoining, defaults.probationMonths)
              : undefined),
          name: composeName(input.firstName, input.middleName, input.lastName),
          claimTokenHash: claim.hash,
          claimTokenExpiresAt: claim.expiresAt,
        },
        actor,
      );
      return {
        employee: toEmployee(row),
        employeeBatchAttached,
        claim: { token: claim.token, expiresAt: claim.expiresAt.toISOString() },
      };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw createError(
          409,
          'An employee with this email or employee code already exists',
          {
            code: 'DUPLICATE_EMPLOYEE',
          },
        );
      }
      throw err;
    }
  };

  /** The Admin invite door (D1–D4): access-first counterpart to `create`. */
  const invite = async (input: InviteEmployeeInput, actor: ActorContext) => {
    const rm = await repo.findById(input.reportsTo);
    if (!rm) {
      throw createError(422, 'Reporting manager does not exist', {
        code: 'RM_NOT_FOUND',
      });
    }
    const policy = await newHirePolicy();
    const claim = newClaimToken(INVITE_LINK_DAYS);
    try {
      // New-hire defaults: the notice period always; probation only when the
      // invite carries a joining date to count from.
      const defaults = policy['people.newHireDefaults'];
      // An invite that leaves intake details blank pings HR to fill them in.
      const missing = missingIntake({
        dateOfJoining: input.dateOfJoining ?? null,
        departmentId: input.departmentId ?? null,
        designation: input.designation ?? null,
      });
      const hr =
        missing.length > 0 ? await authz.listBroadHolders('hrbp.people', 'update') : [];
      const labels: Record<(typeof INTAKE_FIELDS)[number], string> = {
        dateOfJoining: 'joining date',
        departmentId: 'department',
        designation: 'designation',
      };
      const { row, employeeBatchAttached } = await repo.insertInvited(
        {
          ...input,
          notify:
            hr.length > 0
              ? {
                  recipientIds: hr,
                  event: {
                    type: 'people.incomplete_record',
                    title: `Complete ${input.name}'s record`,
                    body: `Invited without: ${missing.map((f) => labels[f]).join(', ')}.`,
                    link: '/hr/people',
                  },
                }
              : undefined,
          noticeDays: defaults.noticeDays,
          confirmationDate:
            input.dateOfJoining && defaults.probationMonths !== null
              ? addMonthsIso(input.dateOfJoining, defaults.probationMonths)
              : null,
          claimTokenHash: claim.hash,
          claimTokenExpiresAt: claim.expiresAt,
        },
        actor,
      );
      return {
        employee: toEmployee(row),
        employeeBatchAttached,
        claim: { token: claim.token, expiresAt: claim.expiresAt.toISOString() },
      };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw createError(409, 'An employee with this email already exists', {
          code: 'DUPLICATE_EMPLOYEE',
        });
      }
      if (isFkViolation(err)) {
        throw createError(422, 'A selected batch or department does not exist', {
          code: 'BATCH_NOT_FOUND',
        });
      }
      throw err;
    }
  };

  const update = async (id: string, input: UpdateEmployeeInput, actor: ActorContext) => {
    // Recompute the full name whenever any part is in the patch, falling back
    // to the stored parts for the rest.
    let name: string | undefined;
    if ('firstName' in input || 'middleName' in input || 'lastName' in input) {
      const current = await repo.findById(id);
      if (!current)
        throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
      // `in`, not ??: an explicit null in the patch CLEARS that part, so it
      // must drop out of the composed name rather than echo the stored value.
      name =
        composeName(
          'firstName' in input ? input.firstName : current.firstName,
          'middleName' in input ? input.middleName : current.middleName,
          'lastName' in input ? input.lastName : current.lastName,
        ) || current.name;
    }
    // A personal workday is a pair: both times, or both cleared (null).
    if ('workStart' in input || 'workEnd' in input) {
      const start = input.workStart ?? null;
      const end = input.workEnd ?? null;
      if (
        (start === null) !== (end === null) ||
        !('workStart' in input && 'workEnd' in input)
      ) {
        throw createError(422, 'Set both work start and work end, or clear both', {
          code: 'WORK_HOURS_PAIR',
        });
      }
      if (start !== null && end !== null && start >= end) {
        throw createError(422, 'Work start must be before work end', {
          code: 'WORK_HOURS_ORDER',
        });
      }
    }
    if (input.status !== undefined) {
      // Status moves HR may make: deactivate (any live record but your own and
      // the administration account) and reactivate (inactive -> active only —
      // `invited` becomes active by claiming, never by an edit).
      const current = await repo.findById(id);
      if (!current)
        throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
      if (input.status === 'inactive' && current.status !== 'inactive') {
        // A working person leaves through an exit, so notice, clearances,
        // the team hand-over and the F&F always apply (close-out). Only an
        // invited record that never joined is switched off directly.
        if (current.status === 'active' || current.status === 'exiting') {
          throw createError(
            409,
            'Start an exit (HR → Exits) to deactivate someone who works here — it runs the clearances and the full & final',
            { code: 'USE_EXIT' },
          );
        }
        if (id === actor.actorEmployeeId) {
          throw createError(403, 'You cannot deactivate your own record', {
            code: 'SELF_DEACTIVATION',
          });
        }
        if (await repo.isOwnerAccount(id)) {
          throw createError(403, 'The administration account cannot be deactivated', {
            code: 'SYSTEM_ACCOUNT',
          });
        }
      }
      if (
        input.status === 'active' &&
        current.status !== 'active' &&
        current.status !== 'inactive'
      ) {
        throw createError(
          422,
          current.status === 'invited'
            ? 'An invited record becomes active when the person claims it'
            : 'Only a deactivated record can be reactivated',
          { code: 'INVALID_STATUS_CHANGE' },
        );
      }
    }
    if (input.reportsTo) {
      // No reporting cycles (§2.2, §10): the chain up from the new RM must
      // never reach the employee being edited. The chain includes its start,
      // so reporting to yourself is caught by the same walk.
      if (await repo.isInReportingChain(input.reportsTo, id)) {
        throw createError(422, 'This change would create a reporting cycle', {
          code: 'REPORTING_CYCLE',
        });
      }
    }
    try {
      const row = await repo.update(
        id,
        { ...input, ...(name !== undefined ? { name } : {}) },
        actor,
      );
      if (!row)
        throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
      return toEmployee(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw createError(
          409,
          'An employee with this email or employee code already exists',
          {
            code: 'DUPLICATE_EMPLOYEE',
          },
        );
      }
      throw err;
    }
  };

  /** An absent salary row reads as "not set yet", never a 404. */
  const toSalary = (row?: Awaited<ReturnType<EmployeesRepository['findSalary']>>) => ({
    ctc: row?.ctc ?? null,
    payrollCostCenter: row?.payrollCostCenter ?? null,
    salaryCurrency: row?.salaryCurrency ?? 'INR',
    salaryMode: row?.salaryMode ?? null,
    panNumber: row?.panNumber ?? null,
    providentFundAccount: row?.providentFundAccount ?? null,
    employeeAdvanceAccount: row?.employeeAdvanceAccount ?? null,
    bankName: row?.bankName ?? null,
    bankAccountNo: row?.bankAccountNo ?? null,
    ifscCode: row?.ifscCode ?? null,
    basicPercent: row?.basicPercent ?? null,
    hraPercent: row?.hraPercent ?? null,
    pfAmount: row?.pfAmount ?? null,
    tdsAmount: row?.tdsAmount ?? null,
    professionalTaxAmount: row?.professionalTaxAmount ?? null,
    otherDeductionAmount: row?.otherDeductionAmount ?? null,
    cnpsPercent: row?.cnpsPercent ?? null,
    variablePay: row?.variablePay ?? null,
  });

  /**
   * Payroll's view of someone's salary — routes gate on
   * pr.payroll.compensation; the bank fields also need pr.payroll.bank_details.
   */
  const getSalary = async (id: string, canSeeBank: boolean) => {
    if (!(await repo.findById(id))) {
      throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
    }
    return withBankGate(toSalary(await repo.findSalary(id)), canSeeBank);
  };

  const withBankGate = <
    T extends { bankName: unknown; bankAccountNo: unknown; ifscCode: unknown },
  >(
    salary: T,
    canSeeBank: boolean,
  ) =>
    canSeeBank
      ? { ...salary, bankDetailsHidden: false }
      : {
          ...salary,
          bankName: null,
          bankAccountNo: null,
          ifscCode: null,
          bankDetailsHidden: true,
        };

  /** Bank details alone — the pr.payroll.bank_details door. */
  const getBankDetails = async (id: string) => {
    if (!(await repo.findById(id))) {
      throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
    }
    const s = toSalary(await repo.findSalary(id));
    return { bankName: s.bankName, bankAccountNo: s.bankAccountNo, ifscCode: s.ifscCode };
  };

  const updateBankDetails = async (
    id: string,
    input: UpdateBankDetailsInput,
    actor: ActorContext,
  ) => {
    if (!(await repo.findById(id))) {
      throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
    }
    const s = toSalary(
      await repo.upsertSalary(
        id,
        {
          ...input,
          ...(input.ifscCode ? { ifscCode: input.ifscCode.toUpperCase() } : {}),
        },
        actor,
      ),
    );
    return { bankName: s.bankName, bankAccountNo: s.bankAccountNo, ifscCode: s.ifscCode };
  };

  const updateSalary = async (
    id: string,
    input: UpdateSalaryInput,
    actor: ActorContext,
    { canSeeBank, canEditBank }: { canSeeBank: boolean; canEditBank: boolean },
  ) => {
    if (!(await repo.findById(id))) {
      throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
    }
    const touchesBank = ['bankName', 'bankAccountNo', 'ifscCode'].some((k) => k in input);
    if (touchesBank && !canEditBank) {
      throw createError(403, 'Changing bank details needs bank-details access', {
        code: 'BANK_DETAILS_FORBIDDEN',
      });
    }
    if ('basicPercent' in input || 'hraPercent' in input) {
      // Basic + HRA + LTA (10%) must leave room for the special allowance.
      const current = toSalary(await repo.findSalary(id));
      const basic = Number(
        ('basicPercent' in input ? input.basicPercent : current.basicPercent) ?? 50,
      );
      const hra = Number(('hraPercent' in input ? input.hraPercent : current.hraPercent) ?? 25);
      if (basic <= 0 || basic + hra + 10 > 100) {
        throw createError(422, 'Basic + HRA + LTA (10%) cannot exceed 100%', {
          code: 'BAD_SALARY_SPLIT',
        });
      }
    }
    return withBankGate(toSalary(await repo.upsertSalary(id, input, actor)), canSeeBank);
  };

  /**
   * Reissue a claim link for a record that was never claimed — covers expired
   * tokens and records created before claim security existed. 409 once a
   * users row exists: a claimed account can only be recovered by an admin
   * password flow, never by re-claiming.
   */
  const issueClaimLink = async (id: string, actor: ActorContext) => {
    if (!(await repo.findById(id))) {
      throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
    }
    if (await repo.isClaimed(id)) {
      throw createError(
        409,
        'This record is already claimed — the invite link is gone for good',
        {
          code: 'ALREADY_CLAIMED',
        },
      );
    }
    const claim = newClaimToken(INVITE_LINK_DAYS);
    await repo.setClaimToken(id, claim.hash, claim.expiresAt, actor);
    return { token: claim.token, expiresAt: claim.expiresAt.toISOString() };
  };

  /**
   * Bulk CSV import (refinement plan, Phase 1), hrbp.people create:
   *  - every row is validated and EVERY problem reported per line (email
   *    format/domain, duplicates in the file or the database, manager email
   *    unknown/inactive/self/looping, level, joining date, department name,
   *    designation length);
   *  - a manager may be an existing live record or another row in the file —
   *    rows are inserted managers-first;
   *  - ZERO permissions carried: rows land invited with only the Employee
   *    batch, new-hire defaults applied, one transaction for the whole file
   *    (any failure writes nothing);
   *  - the claim tokens come back once, for HR to export as CSV.
   */
  const importEmployees = async (
    input: ImportEmployeesInput,
    actor: ActorContext,
  ): Promise<ImportResultDto> => {
    const rows = input.rows.map((r, i) => ({
      line: i + 1,
      email: r.email.trim().toLowerCase(),
      name: r.name.trim(),
      managerEmail: r.managerEmail.trim().toLowerCase(),
      level: r.level.trim().toUpperCase(),
      dateOfJoining: r.dateOfJoining?.trim() || null,
      department: r.department?.trim() || null,
      designation: r.designation?.trim() || null,
      errors: [] as string[],
    }));
    const fileEmails = new Set<string>();
    const [existing, deptIds] = await Promise.all([
      repo.findByEmails([
        ...new Set([...rows.map((r) => r.email), ...rows.map((r) => r.managerEmail)]),
      ]),
      repo.departmentIdsByName(),
    ]);
    const existingByEmail = new Map(existing.map((e) => [e.email.toLowerCase(), e]));
    const inFile = new Map(rows.map((r) => [r.email, r]));

    for (const r of rows) {
      const err = (m: string) => r.errors.push(m);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) err('Email is missing or invalid');
      else if (!isCompanyEmail(r.email, env.auth.companyEmailDomain))
        err(`Email must be @${env.auth.companyEmailDomain}`);
      if (fileEmails.has(r.email)) err('Email appears earlier in this file');
      fileEmails.add(r.email);
      if (existingByEmail.has(r.email)) err('An employee with this email already exists');
      if (!r.name) err('Name is missing');
      if (!(LEVELS as readonly string[]).includes(r.level))
        err(`Level must be one of ${LEVELS.join(', ')}`);
      if (!r.managerEmail) err('Manager email is missing');
      else if (r.managerEmail === r.email) err('Someone cannot be their own manager');
      else {
        const known = existingByEmail.get(r.managerEmail);
        if (known && known.status === 'inactive') err('The manager is no longer active');
        else if (!known && !inFile.has(r.managerEmail))
          err(`No employee or row with manager email ${r.managerEmail}`);
      }
      if (
        r.dateOfJoining &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(r.dateOfJoining) ||
          Number.isNaN(Date.parse(r.dateOfJoining)))
      )
        err('Joining date must be YYYY-MM-DD');
      if (r.department && !deptIds.has(r.department.toLowerCase()))
        err(`Unknown department "${r.department}"`);
      if (r.designation && r.designation.length > 120)
        err('Designation is longer than 120 characters');
    }

    // Managers first: a row is ready once its manager exists or was placed.
    const ordered: typeof rows = [];
    const placed = new Set<string>();
    let pending = rows.filter((r) => r.errors.length === 0);
    while (pending.length > 0) {
      const ready = pending.filter(
        (r) => existingByEmail.has(r.managerEmail) || placed.has(r.managerEmail),
      );
      if (ready.length === 0) {
        for (const r of pending)
          r.errors.push('Manager chain loops back or depends on a row with errors');
        break;
      }
      for (const r of ready) {
        ordered.push(r);
        placed.add(r.email);
      }
      pending = pending.filter((r) => !placed.has(r.email));
    }

    const report = rows.map(({ line, email, name, errors }) => ({
      line,
      email,
      name,
      errors,
    }));
    const valid = rows.every((r) => r.errors.length === 0);
    if (input.dryRun || !valid) {
      return { dryRun: input.dryRun, valid, rows: report, created: [] };
    }

    const policy = await newHirePolicy();
    const defaults = policy['people.newHireDefaults'];
    const tokens = new Map<string, { token: string; expiresAt: Date }>();
    const created = await repo.importInvited(
      ordered.map((r) => {
        const claim = newClaimToken(INVITE_LINK_DAYS);
        tokens.set(r.email, { token: claim.token, expiresAt: claim.expiresAt });
        const known = existingByEmail.get(r.managerEmail);
        return {
          manager: known ? { id: known.id } : { email: r.managerEmail },
          input: {
            email: r.email,
            name: r.name,
            level: r.level as Level,
            batchIds: [],
            ...(r.dateOfJoining ? { dateOfJoining: r.dateOfJoining } : {}),
            ...(r.department
              ? { departmentId: deptIds.get(r.department.toLowerCase())! }
              : {}),
            ...(r.designation ? { designation: r.designation } : {}),
            noticeDays: defaults.noticeDays,
            confirmationDate:
              r.dateOfJoining && defaults.probationMonths !== null
                ? addMonthsIso(r.dateOfJoining, defaults.probationMonths)
                : null,
            claimTokenHash: claim.hash,
            claimTokenExpiresAt: claim.expiresAt,
          },
        };
      }),
      actor,
    );
    return {
      dryRun: false,
      valid: true,
      rows: report,
      created: created.map((row) => ({
        name: row.name,
        email: row.email,
        employeeCode: row.employeeCode,
        claimToken: tokens.get(row.email)!.token,
        claimExpiresAt: tokens.get(row.email)!.expiresAt.toISOString(),
      })),
    };
  };

  return {
    list,
    incomplete,
    importEmployees,
    getById,
    create,
    invite,
    update,
    getSalary,
    updateSalary,
    getBankDetails,
    updateBankDetails,
    issueClaimLink,
  };
};

export type EmployeesService = ReturnType<typeof createEmployeesService>;
