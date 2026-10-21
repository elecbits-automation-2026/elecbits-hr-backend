import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { batchAssignRights, batchGrants, batches } from '../db/schema/index.js';
import { logger } from '../config/logger.js';
import {
  BASELINE_BATCHES,
  RIGHTS_LEVELS,
  type Action,
  type Scope,
} from '../shared/constants/constants.js';

/**
 * CLI: seed the two baseline batches (design doc §5.3).
 *   npm run db:seed-batches       (after db:migrate + db:seed-modules)
 *
 * Idempotent — batches conflict on their unique name, grants and assign-rights
 * on their unique indexes, so re-running only inserts what is missing.
 *
 *  - Employee : attached automatically to every new hire. Deliberately does
 *    NOT include `hrbp.people read` yet — the employees list is not scope-
 *    filtered, so that grant would expose the whole org (§3.1).
 *  - HRBP     : editor rights on People, plus org-structure read/create.
 *
 * Nobody is attached here: the Owner passes every check by bypass (§6) and
 * hands the first HR person the HRBP batch via POST /batches/:id/assign.
 */
type GrantSeed = { moduleKey: string; actions: readonly Action[]; scope: Scope };

const BATCH_SEED: Array<{ name: string; description: string; grants: GrantSeed[] }> = [
  {
    name: BASELINE_BATCHES.employee,
    description: 'Baseline self-service access every employee holds (§5.3)',
    grants: [{ moduleKey: 'hrbp.org', actions: RIGHTS_LEVELS.viewer, scope: 'org' }],
  },
  {
    name: BASELINE_BATCHES.hrbp,
    description: 'People records and org structure for HR business partners',
    grants: [
      { moduleKey: 'hrbp.people', actions: RIGHTS_LEVELS.editor, scope: 'org' },
      { moduleKey: 'hrbp.org', actions: RIGHTS_LEVELS.contributor, scope: 'org' },
      // `update` on hrbp.leaves is what fills the HR approval slot.
      { moduleKey: 'hrbp.leaves', actions: RIGHTS_LEVELS.editor, scope: 'org' },
      { moduleKey: 'hrbp.attendance', actions: RIGHTS_LEVELS.editor, scope: 'org' },
      // Policy library: manage + the acknowledgement tracker.
      { moduleKey: 'hrbp.policies', actions: RIGHTS_LEVELS.editor, scope: 'org' },
      // Concerns (Batch 4): disputes at level 2 + complaints, and open-door
      // slots. Whistleblower reports are NOT here — that is hrbp.vigil.
      { moduleKey: 'hrbp.grievances', actions: RIGHTS_LEVELS.editor, scope: 'org' },
      // Exits: resignations, terminations, HR clearance (exit module).
      { moduleKey: 'hrbp.exits', actions: RIGHTS_LEVELS.editor, scope: 'org' },
    ],
  },
  {
    name: BASELINE_BATCHES.pr,
    description: 'Payroll: runs + payslips and compensation records (§4.1 PR Manager)',
    grants: [
      // manager (incl. delete) on pr.payroll: deleting a DRAFT run is part of
      // the normal workflow. The compensation child is granted separately —
      // parent grants never cascade (§4.2).
      { moduleKey: 'pr.payroll', actions: RIGHTS_LEVELS.manager, scope: 'org' },
      {
        moduleKey: 'pr.payroll.compensation',
        actions: RIGHTS_LEVELS.editor,
        scope: 'org',
      },
      // Bank details are their own door (Phase 3) — granted alongside.
      {
        moduleKey: 'pr.payroll.bank_details',
        actions: RIGHTS_LEVELS.editor,
        scope: 'org',
      },
    ],
  },
  {
    // The asset manager: whoever holds this IS "OPS" — there is no separate
    // team or named person (user decision 2026-10-15).
    name: BASELINE_BATCHES.ops,
    description: 'Asset manager: register, setup, requests, gate passes, stock',
    grants: [
      { moduleKey: 'ops.assets', actions: RIGHTS_LEVELS.editor, scope: 'org' },
      { moduleKey: 'ops.locations', actions: RIGHTS_LEVELS.editor, scope: 'org' },
      { moduleKey: 'ops.asset_requests', actions: RIGHTS_LEVELS.editor, scope: 'org' },
      { moduleKey: 'ops.gate_passes', actions: RIGHTS_LEVELS.editor, scope: 'org' },
      { moduleKey: 'ops.stock', actions: RIGHTS_LEVELS.editor, scope: 'org' },
    ],
  },
];

/** Insert-then-select: onConflictDoNothing returns no row on a repeat run. */
async function ensureBatch(name: string, description: string): Promise<string> {
  await db.orm.insert(batches).values({ name, description }).onConflictDoNothing();
  const rows = await db.orm.select().from(batches).where(eq(batches.name, name)).limit(1);
  return rows[0]!.id;
}

async function main() {
  const ids = new Map<string, string>();
  let grantCount = 0;

  for (const batch of BATCH_SEED) {
    const batchId = await ensureBatch(batch.name, batch.description);
    ids.set(batch.name, batchId);
    for (const grant of batch.grants) {
      for (const action of grant.actions) {
        await db.orm
          .insert(batchGrants)
          .values({ batchId, moduleKey: grant.moduleKey, action, scope: grant.scope })
          .onConflictDoNothing();
        grantCount += 1;
      }
    }
  }

  // HRBP may attach the Employee batch when creating people (§3.3 / §5.3).
  await db.orm
    .insert(batchAssignRights)
    .values({
      batchId: ids.get(BASELINE_BATCHES.hrbp)!,
      assignableBatchId: ids.get(BASELINE_BATCHES.employee)!,
    })
    .onConflictDoNothing();

  logger.info({ batches: BATCH_SEED.length, grants: grantCount }, 'Batch seed complete');
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'Batch seed failed');
    process.exitCode = 1;
  })
  .finally(() => db.close());
