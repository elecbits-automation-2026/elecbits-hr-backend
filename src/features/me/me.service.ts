import createError from 'http-errors';
import type {
  MeDto,
  MyAssetDto,
  MyExitDto,
  SalaryDto,
  TeamMemberDto,
  UpdateMeInput,
} from './me.schema.js';
import type { MeRepository } from './me.repository.js';

/** The empty salary view: every field unset until Payroll fills the row. */
const EMPTY_SALARY: SalaryDto = {
  ctc: null,
  payrollCostCenter: null,
  salaryCurrency: 'INR',
  salaryMode: null,
  panNumber: null,
  providentFundAccount: null,
  employeeAdvanceAccount: null,
  bankName: null,
  bankAccountNo: null,
  ifscCode: null,
  basicPercent: null,
  hraPercent: null,
  pfAmount: null,
  tdsAmount: null,
  professionalTaxAmount: null,
  otherDeductionAmount: null,
};

/** Assemble the caller's own view: profile row + batches + owner/superadmin flags. */
export const createMeService = (deps: { repo: MeRepository }) => {
  const { repo } = deps;

  const personRef = async (id: string | null) =>
    id ? ((await repo.findManager(id)) ?? null) : null;

  const getMe = async (employeeId: string): Promise<MeDto> => {
    const employee = await repo.findEmployee(employeeId);
    if (!employee) {
      throw createError(404, 'Employee record not found', { code: 'EMPLOYEE_NOT_FOUND' });
    }
    const [
      batches,
      isOwner,
      isSuperadmin,
      hasReports,
      department,
      baseZone,
      manager,
      expense,
      shift,
      leave,
      selfGoverned,
    ] = await Promise.all([
      repo.listBatchNames(employeeId),
      repo.isOwner(employeeId),
      repo.isSuperadmin(employeeId),
      repo.hasReports(employeeId),
      employee.departmentId ? repo.findDepartment(employee.departmentId) : undefined,
      employee.baseZoneId ? repo.findZone(employee.baseZoneId) : undefined,
      personRef(employee.reportsTo),
      personRef(employee.expenseApprover),
      personRef(employee.shiftRequestApprover),
      personRef(employee.leaveApprover),
      // Same rule as access/selfGovernance.ts: effective RM is the Owner record.
      (employee.leaveApprover ?? employee.reportsTo)
        ? repo.isOwner((employee.leaveApprover ?? employee.reportsTo)!)
        : Promise.resolve(false),
    ]);
    return {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      phone: employee.phone,
      employeeCode: employee.employeeCode,
      level: employee.level,
      status: employee.status,
      departmentId: employee.departmentId,
      reportsTo: employee.reportsTo,
      salutation: employee.salutation,
      firstName: employee.firstName,
      middleName: employee.middleName,
      lastName: employee.lastName,
      gender: employee.gender,
      dateOfBirth: employee.dateOfBirth,
      designation: employee.designation,
      employmentType: employee.employmentType,
      dateOfJoining: employee.dateOfJoining,
      confirmationDate: employee.confirmationDate,
      noticeDays: employee.noticeDays,
      offerDate: employee.offerDate,
      personalEmail: employee.personalEmail,
      preferredContactEmail:
        employee.preferredContactEmail === 'company' ||
        employee.preferredContactEmail === 'personal'
          ? employee.preferredContactEmail
          : null,
      unsubscribed: employee.unsubscribed,
      currentAddress: employee.currentAddress,
      permanentAddress: employee.permanentAddress,
      department: department ?? null,
      baseZone: baseZone ?? null,
      manager,
      expenseApprover: expense,
      shiftRequestApprover: shift,
      leaveApprover: leave,
      batches,
      isOwner,
      isSuperadmin,
      hasReports,
      selfGoverned,
    };
  };

  /** Self-serve edit (D3): identity fields only, then return the fresh view. */
  const updateMe = async (
    employeeId: string,
    actorUserId: string,
    input: UpdateMeInput,
  ): Promise<MeDto> => {
    // The full name follows the parts (ERPNext-style): recompute it whenever
    // any part is in the patch, falling back to the stored parts for the rest.
    let name: string | undefined;
    if ('firstName' in input || 'middleName' in input || 'lastName' in input) {
      const current = await repo.findEmployee(employeeId);
      if (!current) {
        throw createError(404, 'Employee record not found', {
          code: 'EMPLOYEE_NOT_FOUND',
        });
      }
      const pick = (patch: string | null | undefined, stored: string | null) =>
        patch === undefined ? stored : patch;
      name =
        [
          pick(input.firstName, current.firstName),
          pick(input.middleName, current.middleName),
          pick(input.lastName, current.lastName),
        ]
          .filter((p): p is string => Boolean(p && p.trim()))
          .join(' ') || current.name;
    }

    const row = await repo.updateOwnProfile(employeeId, actorUserId, {
      ...input,
      ...(name !== undefined ? { name } : {}),
    });
    if (!row) {
      throw createError(404, 'Employee record not found', { code: 'EMPLOYEE_NOT_FOUND' });
    }
    return getMe(employeeId);
  };

  /** Own salary/bank view — me scope; an absent row reads as "not set yet". */
  const getMySalary = async (employeeId: string): Promise<SalaryDto> => {
    const row = await repo.findSalary(employeeId);
    if (!row) return EMPTY_SALARY;
    return {
      ctc: row.ctc,
      payrollCostCenter: row.payrollCostCenter,
      salaryCurrency: row.salaryCurrency,
      salaryMode: row.salaryMode,
      panNumber: row.panNumber,
      providentFundAccount: row.providentFundAccount,
      employeeAdvanceAccount: row.employeeAdvanceAccount,
      bankName: row.bankName,
      bankAccountNo: row.bankAccountNo,
      ifscCode: row.ifscCode,
      basicPercent: row.basicPercent,
      hraPercent: row.hraPercent,
      pfAmount: row.pfAmount,
      tdsAmount: row.tdsAmount,
      professionalTaxAmount: row.professionalTaxAmount,
      otherDeductionAmount: row.otherDeductionAmount,
    };
  };

  const getMyAssets = async (employeeId: string): Promise<MyAssetDto[]> =>
    repo.listMyAssets(employeeId);

  const getMyExit = async (employeeId: string): Promise<MyExitDto> => {
    const row = await repo.findMyExit(employeeId);
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      noticeStartOn: row.noticeStartOn,
      lastWorkingDay: row.lastWorkingDay,
      interviewAt: row.interviewAt?.toISOString() ?? null,
      settledAt: row.settledAt?.toISOString() ?? null,
    };
  };

  /** The caller's chain, sanitized — see repository note. Me-scope: the
   *  relationship IS the authorization, no grant involved. */
  const getTeam = async (employeeId: string): Promise<TeamMemberDto[]> =>
    (await repo.listTeam(employeeId)).map((m) => ({
      id: m.id,
      name: m.name,
      employeeCode: m.employeeCode,
      email: m.email,
      phone: m.phone,
      designation: m.designation,
      department: m.departmentName,
      baseZone: m.baseZoneName,
      relation:
        m.reportsTo === employeeId ? ('report' as const) : ('approver_only' as const),
      // listTeam filters != inactive, so only these three statuses reach here.
      status: m.status as 'invited' | 'active' | 'exiting',
      level: m.level,
      dateOfJoining: m.dateOfJoining,
    }));

  return { getMe, updateMe, getMySalary, getMyAssets, getMyExit, getTeam };
};

export type MeService = ReturnType<typeof createMeService>;
