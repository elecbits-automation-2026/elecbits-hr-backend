import createError from 'http-errors';
import type { SettingsReader } from '../settings/index.js';
import type { createSeatsService } from '../seats/index.js';
import type {
  ActorContext,
  DepartmentRow,
  DepartmentsRepository,
  MembershipListRow,
  UnitListRow,
} from './departments.repository.js';
import type {
  AddMemberInput,
  CreateDepartmentInput,
  DepartmentDto,
  MembershipDto,
  SetHeadInput,
  SetLeadInput,
  UpdateDepartmentInput,
} from './departments.schema.js';

const toDepartment = (row: UnitListRow): DepartmentDto => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  parentId: row.parent_id,
  createdAt: new Date(row.created_at).toISOString(),
  head:
    row.head_id && row.head_name
      ? { employeeId: row.head_id, name: row.head_name, acting: row.head_acting ?? false }
      : null,
  lead:
    row.lead_id && row.lead_name
      ? { employeeId: row.lead_id, name: row.lead_name }
      : null,
  memberCount: row.member_count,
  extraCount: row.extra_count,
});

const toMembership = (row: MembershipListRow): MembershipDto => ({
  id: row.id,
  departmentId: row.department_id,
  employeeId: row.employee_id,
  employeeName: row.employee_name,
  isLead: row.is_lead,
  createdAt: new Date(row.created_at).toISOString(),
});

const pgCode = (err: unknown): string | undefined => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
};

const notFound = () =>
  createError(404, 'Department not found', { code: 'DEPARTMENT_NOT_FOUND' });

/**
 * Org-unit rules (§2.4, learner 2026-11-16):
 *  - divisions and departments form the home tree; a parent must exist, must
 *    not be a chapter, and a move can never create a loop;
 *  - a chapter has no parent, no home members, no head — only extra members
 *    and an optional lead (a name, no powers);
 *  - extra memberships are display only; names are unique (any case).
 * Department heads go through the seats rules (HR door: the HR department's
 * head stays Admin-only and nobody seats themselves).
 */
export const createDepartmentsService = (deps: {
  repo: DepartmentsRepository;
  seats: ReturnType<typeof createSeatsService>;
  settings: SettingsReader;
}) => {
  const { repo, seats, settings } = deps;

  const list = async () => (await repo.list()).map(toDepartment);
  const memberships = async () => (await repo.listMemberships()).map(toMembership);
  const one = async (id: string) => {
    const row = (await repo.list()).find((d) => d.id === id);
    if (!row) throw notFound();
    return toDepartment(row);
  };

  const mustFind = async (id: string): Promise<DepartmentRow> => {
    const row = await repo.findById(id);
    if (!row) throw notFound();
    return row;
  };

  /** A home-tree parent: exists and is not a chapter. */
  const assertParent = async (parentId: string) => {
    const parent = await repo.findById(parentId);
    if (!parent) {
      throw createError(422, 'Parent department does not exist', {
        code: 'PARENT_NOT_FOUND',
      });
    }
    if (parent.kind === 'chapter') {
      throw createError(422, 'Nothing sits under a chapter', {
        code: 'PARENT_IS_CHAPTER',
      });
    }
  };

  const duplicateName = (err: unknown) =>
    pgCode(err) === '23505'
      ? createError(409, 'A unit with this name already exists', {
          code: 'DUPLICATE_NAME',
        })
      : err;

  const create = async (input: CreateDepartmentInput, actor: ActorContext) => {
    if (input.kind === 'chapter' && input.parentId) {
      throw createError(422, 'A chapter sits outside the tree — no parent', {
        code: 'CHAPTER_NO_PARENT',
      });
    }
    if (input.parentId) await assertParent(input.parentId);
    try {
      const row = await repo.insert(
        { name: input.name, kind: input.kind, parentId: input.parentId ?? null },
        actor,
      );
      return one(row.id);
    } catch (err) {
      throw duplicateName(err);
    }
  };

  const update = async (
    id: string,
    input: UpdateDepartmentInput,
    actor: ActorContext,
  ) => {
    const before = await mustFind(id);
    const kind = input.kind ?? before.kind;
    const parentId = input.parentId !== undefined ? input.parentId : before.parentId;

    if (kind === 'chapter') {
      if (parentId) {
        throw createError(422, 'A chapter sits outside the tree — no parent', {
          code: 'CHAPTER_NO_PARENT',
        });
      }
      if (before.kind !== 'chapter') {
        const usage = await repo.usage(id);
        if (usage.children > 0 || usage.members > 0 || usage.heads > 0) {
          throw createError(
            409,
            'Only an empty unit can become a chapter — move its people and sub-units out and clear its head first',
            { code: 'UNIT_IN_USE' },
          );
        }
      }
    }

    if (input.parentId !== undefined && input.parentId !== null) {
      await assertParent(input.parentId);
      // No loops: the new parent can't be this unit or anything below it.
      const parents = new Map((await repo.list()).map((d) => [d.id, d.parent_id]));
      for (let at: string | null = input.parentId; at; at = parents.get(at) ?? null) {
        if (at === id) {
          throw createError(
            422,
            'A unit cannot sit under itself or one of its own sub-units',
            {
              code: 'DEPARTMENT_LOOP',
            },
          );
        }
      }
    }

    try {
      await repo.update(
        id,
        {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        },
        before,
        actor,
      );
    } catch (err) {
      throw duplicateName(err);
    }
    return one(id);
  };

  const hrDepartmentId = async () =>
    (await settings.effective('hiring.hrDepartment')).departmentId;

  const setHead = async (id: string, input: SetHeadInput, actor: ActorContext) => {
    await mustFind(id);
    await seats.assignHead(id, input, actor, await hrDepartmentId());
    return one(id);
  };

  const clearHead = async (id: string, actor: ActorContext) => {
    await mustFind(id);
    await seats.vacateHead(id, actor, await hrDepartmentId());
    return one(id);
  };

  const addMember = async (id: string, input: AddMemberInput, actor: ActorContext) => {
    await mustFind(id);
    const person = await repo.employee(input.employeeId);
    if (!person || person.status === 'inactive') {
      throw createError(422, 'Only a current employee can be added', {
        code: 'EMPLOYEE_NOT_CURRENT',
      });
    }
    if (person.department_id === id) {
      throw createError(409, `This is already ${person.name}'s home unit`, {
        code: 'ALREADY_HOME',
      });
    }
    try {
      await repo.addMember(id, input.employeeId, actor);
    } catch (err) {
      if (pgCode(err) === '23505') {
        throw createError(409, `${person.name} is already a member`, {
          code: 'ALREADY_MEMBER',
        });
      }
      throw err;
    }
    return one(id);
  };

  const removeMember = async (membershipId: string, actor: ActorContext) => {
    const membership = await repo.findMembership(membershipId);
    if (!membership) {
      throw createError(404, 'Membership not found', { code: 'MEMBERSHIP_NOT_FOUND' });
    }
    await repo.removeMember(membership, actor);
    return one(membership.departmentId);
  };

  const setLead = async (id: string, input: SetLeadInput, actor: ActorContext) => {
    const unit = await mustFind(id);
    if (unit.kind !== 'chapter') {
      throw createError(422, 'Only a chapter has a lead — departments have a head', {
        code: 'NOT_A_CHAPTER',
      });
    }
    if (input.employeeId) {
      const person = await repo.employee(input.employeeId);
      if (!person || person.status === 'inactive') {
        throw createError(422, 'Only a current employee can lead a chapter', {
          code: 'EMPLOYEE_NOT_CURRENT',
        });
      }
    }
    await repo.setLead(id, input.employeeId, actor);
    return one(id);
  };

  return {
    list,
    memberships,
    create,
    update,
    setHead,
    clearHead,
    addMember,
    removeMember,
    setLead,
  };
};

export type DepartmentsService = ReturnType<typeof createDepartmentsService>;
