import createError from 'http-errors';
import type { ActorContext, OpenSeat, SeatsRepository } from './seats.repository.js';
import type {
  AssignSeatInput,
  PastSeatDto,
  SeatDto,
  SeatsOverviewDto,
  VacateSeatInput,
} from './seats.schema.js';

const toSeat = (s: OpenSeat): SeatDto => ({
  id: s.id,
  seat: s.seat,
  departmentId: s.department_id,
  departmentName: s.department_name,
  employeeId: s.employee_id,
  employeeName: s.employee_name,
  acting: s.acting,
  startedAt: new Date(s.started_at).toISOString(),
});

/**
 * Seat rules (TA design): only the Admin (Owner) account sees and assigns
 * seats (learner, 2026-10-26) — nothing comes from level or designation. One
 * holder per seat; a person may hold several (e.g. head two departments).
 * Only active people can hold a seat, and never the Admin account itself.
 */
export const createSeatsService = (deps: { repo: SeatsRepository }) => {
  const { repo } = deps;

  const assertAdmin = async (actor: ActorContext) => {
    if (actor.actorEmployeeId !== (await repo.ownerEmployeeId())) {
      throw createError(403, 'Only the Admin account manages seats', { code: 'OWNER_ONLY' });
    }
  };

  const overview = async (actor: ActorContext): Promise<SeatsOverviewDto> => {
    await assertAdmin(actor);
    const open = await repo.listOpen();
    const headed = new Set(
      open.filter((s) => s.seat === 'dept_head').map((s) => s.department_id),
    );
    const vacant: SeatsOverviewDto['vacant'] = (await repo.departments())
      .filter((d) => !headed.has(d.id))
      .map((d) => ({ seat: 'dept_head', departmentId: d.id, departmentName: d.name }));
    for (const seat of ['vp_hr_head'] as const) {
      if (!open.some((s) => s.seat === seat)) {
        vacant.push({ seat, departmentId: null, departmentName: null });
      }
    }
    return {
      seats: open.map(toSeat),
      vacant,
      ownerEmployeeId: await repo.ownerEmployeeId(),
    };
  };

  /** Seat a holder — the shared rules behind both doors (Seats page, Departments page). */
  const seat = async (input: AssignSeatInput, actor: ActorContext): Promise<SeatDto> => {
    const departmentId = input.departmentId ?? null;
    if (departmentId) {
      const kind = await repo.departmentKind(departmentId);
      if (!kind) {
        throw createError(422, 'Department does not exist', {
          code: 'DEPARTMENT_NOT_FOUND',
        });
      }
      // A chapter has a lead (a name, no powers), never a head seat.
      if (kind === 'chapter') {
        throw createError(422, 'A chapter has a lead, not a head', {
          code: 'CHAPTER_HAS_NO_HEAD',
        });
      }
    }
    // Admin is the company account, not a person — it can't head or approve anything.
    if (input.employeeId === (await repo.ownerEmployeeId())) {
      throw createError(422, 'The Admin account cannot hold a seat', {
        code: 'OWNER_CANNOT_HOLD_SEAT',
      });
    }
    const status = await repo.employeeStatus(input.employeeId);
    if (!status)
      throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
    if (status !== 'active') {
      throw createError(422, 'Only an active employee can hold a seat', {
        code: 'EMPLOYEE_NOT_ACTIVE',
      });
    }
    const current = await repo.findOpen(input.seat, departmentId);
    if (
      current &&
      current.employeeId === input.employeeId &&
      current.acting === input.acting
    ) {
      throw createError(409, 'This person already holds the seat', {
        code: 'ALREADY_HOLDS',
      });
    }
    try {
      const row = await repo.assign(
        {
          seat: input.seat,
          departmentId,
          employeeId: input.employeeId,
          acting: input.acting,
        },
        actor,
      );
      return toSeat((await repo.listOpen()).find((s) => s.id === row.id)!);
    } catch (err) {
      // Two tabs assigning the same seat at once — the unique index decides.
      const code = err as { code?: string; cause?: { code?: string } };
      if (code.code === '23505' || code.cause?.code === '23505') {
        throw createError(409, 'The seat changed meanwhile — reload and try again', {
          code: 'SEAT_CHANGED',
        });
      }
      throw err;
    }
  };

  const assign = async (input: AssignSeatInput, actor: ActorContext): Promise<SeatDto> => {
    await assertAdmin(actor);
    return seat(input, actor);
  };

  const vacate = async (input: VacateSeatInput, actor: ActorContext): Promise<void> => {
    await assertAdmin(actor);
    if (!(await repo.vacate(input.seat, input.departmentId ?? null, actor))) {
      throw createError(404, 'Nobody holds this seat', { code: 'SEAT_EMPTY' });
    }
  };

  /**
   * The HR door (Departments page, learner 2026-11-16): HR sets department
   * heads too, but the HR department's head — the HR approver on hiring lines
   * and offers — stays Admin-only, and nobody seats themselves.
   */
  const assertHrMayHead = async (
    departmentId: string,
    employeeId: string | null,
    actor: ActorContext,
    hrDepartmentId: string | null,
  ) => {
    if (actor.actorEmployeeId === (await repo.ownerEmployeeId())) return;
    if (departmentId === hrDepartmentId) {
      throw createError(403, "Only the Admin account sets the HR department's head", {
        code: 'HR_HEAD_ADMIN_ONLY',
      });
    }
    if (employeeId && employeeId === actor.actorEmployeeId) {
      throw createError(403, 'You cannot make yourself a department head', {
        code: 'SELF_SEAT',
      });
    }
  };

  const assignHead = async (
    departmentId: string,
    input: { employeeId: string; acting: boolean },
    actor: ActorContext,
    hrDepartmentId: string | null,
  ): Promise<SeatDto> => {
    await assertHrMayHead(departmentId, input.employeeId, actor, hrDepartmentId);
    return seat({ seat: 'dept_head', departmentId, ...input }, actor);
  };

  const vacateHead = async (
    departmentId: string,
    actor: ActorContext,
    hrDepartmentId: string | null,
  ): Promise<void> => {
    await assertHrMayHead(departmentId, null, actor, hrDepartmentId);
    if (!(await repo.vacate('dept_head', departmentId, actor))) {
      throw createError(404, 'This department has no head', { code: 'SEAT_EMPTY' });
    }
  };

  /** Who held each seat before (ended rows are kept, never deleted). */
  const history = async (actor: ActorContext): Promise<PastSeatDto[]> => {
    await assertAdmin(actor);
    return (await repo.listEnded()).map((s) => ({
      ...toSeat(s),
      endedAt: new Date(s.ended_at).toISOString(),
      endedReason: s.ended_reason,
      endedByName: s.ended_by_name,
    }));
  };

  return { overview, assign, vacate, history, assignHead, vacateHead };
};

export type SeatsService = ReturnType<typeof createSeatsService>;
