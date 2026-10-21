import { z } from '../../shared/zod.js';

/** Departments form a tree, separate from the reporting line (§2.4). */
export const departmentSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    parentId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('Department');

export const createDepartmentSchema = z
  .object({
    name: z.string().min(1),
    parentId: z.string().uuid().optional(),
  })
  .strict()
  .openapi('CreateDepartment');

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type DepartmentDto = z.infer<typeof departmentSchema>;
