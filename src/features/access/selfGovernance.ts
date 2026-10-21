import type { AuthzRepository } from './authz.repository.js';

/** The two columns that decide who someone's effective RM is. */
export interface ReportingLine {
  reportsTo: string | null;
  leaveApprover: string | null;
}

/**
 * SELF-GOVERNANCE (refinement plan, Phase 2 — the org chart's apex): the 2–3
 * people at the top report to the ADMINISTRATION account, which is a marker
 * meaning "nobody above them", not an approver. Wherever the system asks
 * "who approves this?", their answer is themselves:
 *  - leave, remote work and regularizations are approved the moment they are
 *    raised (balances still charged by the arbiter, everything audited);
 *  - they set their own goals;
 *  - they appear in nobody's team views.
 * One check for every gate: the person's EFFECTIVE RM (leaveApprover ??
 * reportsTo) is the Owner's record. The Owner record itself is the root and
 * is never self-governed — it isn't a person who takes leave.
 */
export const createSelfGovernance = (authz: AuthzRepository) => {
  let owner: Promise<string | null> | null = null;
  const ownerId = () => (owner ??= authz.ownerId());

  return async (person: ReportingLine | null | undefined): Promise<boolean> => {
    if (!person) return false;
    const effectiveRm = person.leaveApprover ?? person.reportsTo;
    if (!effectiveRm) return false;
    return effectiveRm === (await ownerId());
  };
};

export type SelfGovernance = ReturnType<typeof createSelfGovernance>;
