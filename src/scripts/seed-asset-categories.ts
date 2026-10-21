import { db } from '../db/index.js';
import { assetCategories } from '../db/schema/index.js';
import { logger } from '../config/logger.js';

/**
 * CLI: seed the starter asset categories (OPS asset manager).
 *   npm run db:seed-asset-categories     (after db:migrate)
 *
 * Idempotent — conflicts on the unique name are skipped, so OPS edits made in
 * OPS setup are never overwritten. Lab categories are lent with a due date;
 * only flagged categories may leave a zone on a gate pass (never laptops).
 */
const CATEGORY_SEED: Array<typeof assetCategories.$inferInsert> = [
  { name: 'Laptop', codePrefix: 'LAP', kind: 'equipment', requiresGatePass: false },
  { name: 'Monitor', codePrefix: 'MON', kind: 'equipment', requiresGatePass: false },
  { name: 'Phone', codePrefix: 'PHN', kind: 'equipment', requiresGatePass: false },
  {
    name: 'ID / access card',
    codePrefix: 'IDC',
    kind: 'equipment',
    requiresGatePass: false,
  },
  { name: 'Peripheral', codePrefix: 'PER', kind: 'equipment', requiresGatePass: false },
  { name: 'Furniture', codePrefix: 'FUR', kind: 'equipment', requiresGatePass: false },
  {
    name: 'Network equipment',
    codePrefix: 'NET',
    kind: 'equipment',
    requiresGatePass: false,
  },
  { name: 'Printer', codePrefix: 'PRN', kind: 'equipment', requiresGatePass: false },
  { name: 'Lab equipment', codePrefix: 'LAB', kind: 'lab', requiresGatePass: true },
  { name: 'Dev kit', codePrefix: 'DEV', kind: 'lab', requiresGatePass: true },
  { name: 'Product / sample', codePrefix: 'SMP', kind: 'lab', requiresGatePass: true },
];

async function main() {
  for (const row of CATEGORY_SEED) {
    await db.orm.insert(assetCategories).values(row).onConflictDoNothing();
  }
  logger.info({ count: CATEGORY_SEED.length }, 'Asset category seed complete');
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'Asset category seed failed');
    process.exitCode = 1;
  })
  .finally(() => db.close());
