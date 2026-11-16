import { sql } from 'drizzle-orm';
import {
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { unitKindEnum } from './enums.js';

/** The `org` schema: departments, employees, exits (design doc §11.1). */
export const orgSchema = pgSchema('org');

/**
 * Departments form a tree (a department can have a parent), separate from the
 * reporting line (§2.4). This is what gives `dept` scope a meaning distinct
 * from `team`. One primary (home) department per employee
 * (`employees.department_id`) — a division or a department, never a chapter.
 * A chapter is a cross-department group with no parent; people join it only
 * through `department_memberships` (learner, 2026-11-16), display only.
 */
export const departments = orgSchema.table(
  'departments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: unitKindEnum('kind').notNull().default('department'),
    parentId: uuid('parent_id').references((): AnyPgColumn => departments.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('departments_name_uq').on(sql`lower(${t.name})`)],
);
