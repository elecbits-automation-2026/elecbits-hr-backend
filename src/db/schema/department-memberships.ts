import { sql } from 'drizzle-orm';
import { boolean, index, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { departments, orgSchema } from './departments.js';
import { employees } from './employees.js';

/**
 * Extra unit memberships (learner, 2026-11-16): "also in" a department other
 * than the home one, or a member of a chapter. Display only — access,
 * approvals, payroll and hiring all keep using `employees.department_id`.
 * `isLead` marks a chapter's lead (a name, no powers; one per chapter).
 * Removing a membership deletes the row; the audit log keeps the history.
 */
export const departmentMemberships = orgSchema.table(
  'department_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    isLead: boolean('is_lead').notNull().default(false),
    addedBy: uuid('added_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('department_memberships_uq').on(t.departmentId, t.employeeId),
    uniqueIndex('department_memberships_lead_uq')
      .on(t.departmentId)
      .where(sql`${t.isLead}`),
    index('department_memberships_employee_idx').on(t.employeeId),
  ],
);
