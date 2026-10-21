import createError from 'http-errors';
import type { CreateDepartmentInput, DepartmentDto } from './departments.schema.js';
import type { DepartmentRow, DepartmentsRepository } from './departments.repository.js';

const toDepartment = (row: DepartmentRow): DepartmentDto => ({
  id: row.id,
  name: row.name,
  parentId: row.parentId,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Department tree rules (§2.4): a parent must exist; `dept` scope reaches
 * sub-departments too (decision #21), which the SQL `org.dept_within` powers.
 */
export const createDepartmentsService = (deps: { repo: DepartmentsRepository }) => {
  const { repo } = deps;

  const list = async () => (await repo.list()).map(toDepartment);

  const create = async (input: CreateDepartmentInput) => {
    if (input.parentId && !(await repo.findById(input.parentId))) {
      throw createError(422, 'Parent department does not exist', {
        code: 'PARENT_NOT_FOUND',
      });
    }
    return toDepartment(await repo.insert(input));
  };

  return { list, create };
};

export type DepartmentsService = ReturnType<typeof createDepartmentsService>;
