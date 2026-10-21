import { pgSchema, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

/** The `org` schema: departments, employees, exits (design doc §11.1). */
export const orgSchema = pgSchema('org');

/**
 * Departments form a tree (a department can have a parent), separate from the
 * reporting line (§2.4). This is what gives `dept` scope a meaning distinct
 * from `team`. Current assumption: one primary department per employee (open
 * question §14.1 — a join table would replace `employees.department_id`).
 */
export const departments = orgSchema.table('departments', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  parentId: uuid('parent_id').references((): AnyPgColumn => departments.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
