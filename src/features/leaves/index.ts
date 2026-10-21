/**
 * Leaves — employee-raised requests with dual RM + HRBP approval, yearly
 * balances for capped types, half-day support. Public surface only.
 */
export { leavesRoutes } from './leaves.routes.js';
export { registerLeavesDocs } from './leaves.docs.js';
export type { LeaveRequestDto, LeaveBalanceDto } from './leaves.schema.js';
