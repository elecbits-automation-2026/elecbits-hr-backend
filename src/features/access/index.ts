/**
 * Public surface of the access module: batches, grant requests, and the audit
 * log — three filesets in one folder because they share the access domain
 * (§3–§6) and each other's schemas.
 */
export { batchesRoutes } from './batches.routes.js';
export { registerBatchesDocs } from './batches.docs.js';
export { grantRequestsRoutes } from './requests.routes.js';
export { registerGrantRequestsDocs } from './requests.docs.js';
export { auditRoutes } from './audit.routes.js';
export { registerAuditDocs } from './audit.docs.js';
export { createAuthzRepository } from './authz.repository.js';
export { createRmOrHrGate, type HrDoor, type RmOrHrGate } from './rmOrHr.gate.js';
export { reachesIn, type PeopleScope } from './authz.repository.js';
export type { BatchDto } from './batches.schema.js';
export type { GrantRequestDto } from './requests.schema.js';
export type { AuditEntryDto } from './audit.schema.js';
