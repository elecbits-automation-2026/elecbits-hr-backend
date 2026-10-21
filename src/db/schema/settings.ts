import { jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orgSchema } from './departments.js';
import { employees } from './employees.js';

/**
 * Org-wide tunable settings (refinement plan, Phase 0 — X4): one row per
 * known key, value as JSON. The KNOWN keys, their shapes and their defaults
 * live in code (`features/settings/settings.registry.ts`) — the table stores
 * only overrides, so a missing row means "the default applies" and a fresh
 * database behaves exactly like today. Structural policy (leave quotas,
 * payroll engine percentages) deliberately stays in code, not here.
 */
export const orgSettings = orgSchema.table('org_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').references(() => employees.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
