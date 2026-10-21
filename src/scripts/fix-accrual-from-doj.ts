import { createDbClient } from '../db/client.js';
import { logger } from '../config/logger.js';
import {
  accruedAllocation,
  type CappedLeaveType,
} from '../shared/constants/constants.js';

/**
 * One-off repair (refinement pass): earned and menstrual leave used to accrue
 * from January even for people who joined later in the year. The accrual now
 * counts from the joining month; this rewrites the stored `allocated` of the
 * current year's rows to match. Dry run by default — pass `--apply` to write.
 * Nothing already USED is touched: people whose use now exceeds their
 * corrected balance are listed for HR to decide.
 *
 *   npx tsx src/scripts/fix-accrual-from-doj.ts            # report only
 *   npx tsx src/scripts/fix-accrual-from-doj.ts --apply    # write + audit
 */
const apply = process.argv.includes('--apply');
const db = createDbClient();

const main = async () => {
  const year = new Date().getFullYear();
  const rows = await db.query<{
    id: string;
    employee_id: string;
    name: string;
    type: CappedLeaveType;
    allocated: string;
    opening: string;
    used: string;
    date_of_joining: string | null;
  }>(
    `SELECT b.id, b.employee_id, e.name, b.type::text AS type, b.allocated, b.opening, b.used,
            e.date_of_joining::text AS date_of_joining
       FROM org.leave_balances b JOIN org.employees e ON e.id = b.employee_id
      WHERE b.year = $1 AND b.type IN ('earned', 'menstrual')
      ORDER BY e.name, b.type`,
    [year],
  );

  const changes = rows
    .map((r) => {
      const correct = accruedAllocation(r.type, year, { joinedOn: r.date_of_joining });
      return { ...r, correct, before: Number(r.allocated) };
    })
    .filter((r) => r.before !== r.correct);

  for (const c of changes) {
    const balanceAfter = Number(c.opening) + c.correct - Number(c.used);
    logger.info(
      {
        employee: c.name,
        type: c.type,
        joined: c.date_of_joining,
        allocatedBefore: c.before,
        allocatedAfter: c.correct,
        used: Number(c.used),
        overdrawn: balanceAfter < 0 ? -balanceAfter : 0,
      },
      balanceAfter < 0
        ? 'accrual correction — OVERDRAWN, HR to decide'
        : 'accrual correction',
    );
  }
  logger.info(
    { year, rowsChecked: rows.length, toCorrect: changes.length, apply },
    'summary',
  );

  if (apply && changes.length > 0) {
    await db.transaction(async (tx) => {
      for (const c of changes) {
        await tx.query(`UPDATE org.leave_balances SET allocated = $1 WHERE id = $2`, [
          c.correct,
          c.id,
        ]);
      }
      // System-initiated repair: attributed to the administration account.
      const owner = await tx.query<{ uid: string }>(
        `SELECT u.id AS uid FROM access.org_owner o JOIN public.users u ON u.employee_id = o.employee_id LIMIT 1`,
        [],
      );
      if (owner[0]) {
        await tx.query(
          `INSERT INTO access.audit_log (actor_user_id, action, subject, detail) VALUES ($1, $2, $3, $4)`,
          [
            owner[0].uid,
            'leave.accrual_corrected',
            `leave_balances:${year}`,
            JSON.stringify({
              rows: changes.length,
              reason: 'accrual counts from the joining month',
            }),
          ],
        );
      }
    });
    logger.info({ corrected: changes.length }, 'applied');
  }
};

main()
  .then(() => db.close())
  .then(() => process.exit(0))
  .catch(async (err) => {
    logger.fatal({ err }, 'accrual repair failed');
    await db.close().catch(() => {});
    process.exit(1);
  });
