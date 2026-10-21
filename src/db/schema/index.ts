/**
 * Barrel for the Drizzle schema — the single import surface for `DbClient` and
 * drizzle-kit (drizzle.config.ts points here). Tables live in three Postgres
 * schemas mirroring the design doc §11.1: `org`, `access`, `ops`, plus the
 * sign-in `users` table in `public`.
 */
export * from './enums.js';
export * from './identity.js';
export * from './departments.js';
export * from './employees.js';
export * from './compensation.js';
export * from './access.js';
export * from './grant-requests.js';
export * from './ops.js';
export * from './exits.js';
export * from './probation.js';
export * from './pip.js';
export * from './leaves.js';
export * from './attendance.js';
export * from './payroll.js';
export * from './reimbursements.js';
export * from './concerns.js';
export * from './feedback.js';
export * from './policies.js';
export * from './onboarding.js';
export * from './recognitions.js';
export * from './career.js';
export * from './performance.js';
export * from './settings.js';
export * from './notifications.js';
