import { index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { orgSchema } from './departments.js';
import { employees } from './employees.js';

/**
 * Privacy-notice acceptances (DPDP Act 2023, report M12, 2026-11-23): one row
 * per person per notice VERSION they accepted. Append-only — a new version
 * means a new row, so the history of what each person agreed to, and when,
 * stays provable. The notice text itself is the `privacy.notice` setting.
 */
export const privacyAcceptances = orgSchema.table(
  'privacy_acceptances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    version: text('version').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('privacy_acceptances_employee_version_uq').on(t.employeeId, t.version),
    index('privacy_acceptances_employee_idx').on(t.employeeId),
  ],
);
