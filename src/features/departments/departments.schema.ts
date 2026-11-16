import { z } from '../../shared/zod.js';

/**
 * Org units (learner, 2026-11-16): divisions and departments form the home
 * tree; a chapter is a cross-department group joined by membership only.
 */
export const UNIT_KINDS = ['division', 'department', 'chapter'] as const;
export const unitKindSchema = z.enum(UNIT_KINDS);

const personRefSchema = z.object({ employeeId: z.string().uuid(), name: z.string() });

/** Departments form a tree, separate from the reporting line (§2.4). */
export const departmentSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    kind: unitKindSchema,
    parentId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
    /** The open department-head seat (divisions and departments only). */
    head: personRefSchema.extend({ acting: z.boolean() }).nullable(),
    /** A chapter's lead — a name, no powers. */
    lead: personRefSchema.nullable(),
    /** People whose home unit this is (not counting sub-units), leavers excluded. */
    memberCount: z.number().int(),
    /** Extra ("also in" / chapter) members, leavers excluded. */
    extraCount: z.number().int(),
  })
  .openapi('Department');

/** One extra membership — display only; access keeps using the home unit. */
export const membershipSchema = z
  .object({
    id: z.string().uuid(),
    departmentId: z.string().uuid(),
    employeeId: z.string().uuid(),
    employeeName: z.string(),
    isLead: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .openapi('DepartmentMembership');

const nameSchema = z.string().trim().min(1).max(80);

export const createDepartmentSchema = z
  .object({
    name: nameSchema,
    kind: unitKindSchema.default('department'),
    parentId: z.string().uuid().optional(),
  })
  .strict()
  .openapi('CreateDepartment');

/** Rename, move (parentId null = top level) or change kind. */
export const updateDepartmentSchema = z
  .object({
    name: nameSchema.optional(),
    kind: unitKindSchema.optional(),
    parentId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' })
  .openapi('UpdateDepartment');

export const setHeadSchema = z
  .object({
    employeeId: z.string().uuid(),
    acting: z.boolean().default(false),
  })
  .strict()
  .openapi('SetDepartmentHead');

export const addMemberSchema = z
  .object({ employeeId: z.string().uuid() })
  .strict()
  .openapi('AddDepartmentMember');

/** null clears the lead. */
export const setLeadSchema = z
  .object({ employeeId: z.string().uuid().nullable() })
  .strict()
  .openapi('SetChapterLead');

export type UnitKind = z.infer<typeof unitKindSchema>;
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
export type SetHeadInput = z.infer<typeof setHeadSchema>;
export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type SetLeadInput = z.infer<typeof setLeadSchema>;
export type DepartmentDto = z.infer<typeof departmentSchema>;
export type MembershipDto = z.infer<typeof membershipSchema>;
