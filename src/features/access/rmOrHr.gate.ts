import createError from 'http-errors';
import type { Action } from '../../shared/constants/constants.js';
import { reachesIn } from './authz.repository.js';
import type { AuthzRepository } from './authz.repository.js';

/** The HR door a particular read or write opens with, e.g. hrbp.leaves read. */
export interface HrDoor {
  moduleKey: string;
  action: Action;
}

/**
 * THE person-sheet gate (refinement plan, Phase 0): may the caller see or
 * act on this person's sheet? Yes when the caller is the person's EFFECTIVE
 * RM (leaveApprover ?? reportsTo) or holds the given HR module at a scope
 * that REACHES this person (Phase 3: a dept grant opens their department, a
 * team grant their reporting tree, a `me` grant nobody else — review finding
 * M4; Owner/SuperAdmin bypass). Inactive records are not found. Each caller
 * names its own HR door, so leave data stays behind hrbp.leaves and goals
 * behind hrbp.people.
 */
export const createRmOrHrGate = (authz: AuthzRepository) => {
  return async (
    actorEmployeeId: string,
    targetId: string,
    hrDoor: HrDoor,
    deniedMessage = "Only this person's RM or HR can see this",
  ): Promise<void> => {
    const target = await authz.findReportingLine(targetId);
    if (!target || target.status === 'inactive') {
      throw createError(404, 'Employee record not found', { code: 'EMPLOYEE_NOT_FOUND' });
    }
    if (actorEmployeeId === (target.leaveApprover ?? target.reportsTo)) return;
    const access = await authz.resolveAccess(
      actorEmployeeId,
      hrDoor.moduleKey,
      hrDoor.action,
    );
    if (!reachesIn(await authz.reachable(actorEmployeeId, access), targetId)) {
      throw createError(403, deniedMessage, { code: 'NOT_AN_APPROVER' });
    }
  };
};

export type RmOrHrGate = ReturnType<typeof createRmOrHrGate>;
