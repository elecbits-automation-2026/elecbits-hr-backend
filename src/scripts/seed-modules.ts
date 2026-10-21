import { db } from '../db/index.js';
import { modules } from '../db/schema/index.js';
import { logger } from '../config/logger.js';

/**
 * CLI: seed the grantable module tree (design doc §4.2).
 *   npm run db:seed-modules
 *
 * Idempotent — `onConflictDoNothing` on the primary key, so re-running after a
 * new module is added only inserts the new rows. The exact module list per
 * portal is still an open question (§14.4); this is the working set, parents
 * before children so the FK on parent_key resolves.
 */
const MODULE_SEED: Array<{ key: string; name: string; parentKey?: string }> = [
  // TA — Talent Acquisition
  { key: 'ta.hiring', name: 'Hiring' },

  // HRBP — people records, org structure, policies, grievances
  { key: 'hrbp.people', name: 'People' },
  { key: 'hrbp.org', name: 'Org structure' },
  { key: 'hrbp.policies', name: 'Policies & conduct' },
  // POSH/ICC cases are deliberately never stored (§12) — this module only
  // covers the non-statutory grievance flow.
  { key: 'hrbp.grievances', name: 'Grievances & open door' },
  // Whistleblower cases (Batch 4): the vigil team only — plain HR access
  // never opens them. Granted by Admin; no baseline batch holds it.
  { key: 'hrbp.vigil', name: 'Whistleblower cases' },
  { key: 'hrbp.exits', name: 'Exits' },
  // Leave requests: the HR half of the dual approval (RM is a relationship,
  // not a grant — the leaves service checks reports_to/leave_approver itself).
  { key: 'hrbp.leaves', name: 'Leaves' },
  // Attendance: org view + holiday management; punches themselves are me-scope.
  { key: 'hrbp.attendance', name: 'Attendance' },

  // PR — Payroll, with the sensitive children split out so a grant on
  // pr.payroll can never silently expose bank details (§4.2).
  { key: 'pr.payroll', name: 'Payroll' },
  { key: 'pr.payroll.compensation', name: 'Compensation', parentKey: 'pr.payroll' },
  { key: 'pr.payroll.bank_details', name: 'Bank details', parentKey: 'pr.payroll' },
  { key: 'pr.payroll.compliance', name: 'Compliance', parentKey: 'pr.payroll' },

  // OPS — asset management (§7)
  { key: 'ops.assets', name: 'Assets' },
  { key: 'ops.asset_requests', name: 'Asset requests' },
  { key: 'ops.gate_passes', name: 'Gate passes' },
  // Key kept from the skeleton; locations are now the punch zones, so it
  // opens OPS setup (asset categories, joiner kits).
  { key: 'ops.locations', name: 'OPS setup' },
  { key: 'ops.stock', name: 'Stock & consumables' },

  // Access administration (Owner / SuperAdmin surface)
  { key: 'access.batches', name: 'Access batches' },
  { key: 'access.requests', name: 'Grant requests' },
  { key: 'access.audit', name: 'Audit log' },
  // Org-tunable settings (refinement Phase 0). No batch carries it by
  // default — Owner/SuperAdmin bypass, grantable to HR per key-area later.
  { key: 'access.settings', name: 'Org settings' },
];

async function main() {
  for (const row of MODULE_SEED) {
    await db.orm
      .insert(modules)
      .values({ key: row.key, name: row.name, parentKey: row.parentKey })
      .onConflictDoNothing();
  }
  logger.info({ count: MODULE_SEED.length }, 'Module seed complete');
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'Module seed failed');
    process.exitCode = 1;
  })
  .finally(() => db.close());
