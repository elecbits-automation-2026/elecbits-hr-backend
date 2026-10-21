import { db } from '../db/index.js';
import { policies } from '../db/schema/index.js';
import { logger } from '../config/logger.js';

/**
 * CLI: seed the Elecbits policy catalog (carried over from the previous HR
 * tool, including its real Drive links and ack decisions).
 *   npm run db:seed-policies
 *
 * Idempotent — `onConflictDoNothing` on the unique `code`, so re-running after
 * HR has edited titles, links or VERSIONS changes nothing; the catalog is only
 * a starting point, the Policies page is the source of truth afterwards.
 *
 * Codes matter: the onboarding template links its policy steps to `coc` and
 * `handbook`, so the master policy seeds under code `handbook` here.
 */
const file = (id: string) => `https://drive.google.com/file/d/${id}/view`;

const POLICY_SEED: Array<typeof policies.$inferInsert> = [
  {
    code: 'coc',
    title: 'Code of Conduct',
    category: 'conduct',
    version: '2026.1',
    ackRequired: true,
    effectiveFrom: '2026-04-01',
    docUrl: file('1tEhuDGkOhP0HKs5uEVAMlUsDyBvmAdDd'),
    summary:
      "How we behave with each other, with customers and with the company's property. Read this one properly — every other policy assumes it.",
  },
  {
    code: 'handbook',
    title: 'EB Master Policy',
    category: 'handbook',
    version: '2026.1',
    ackRequired: true,
    effectiveFrom: '2026-04-01',
    docUrl: file('1DgLOYKlI_pbzMTw9fD2Z-hUiNCU8is-n'),
    summary:
      'The full policy set with a table of contents — leave, travel, expenses, IT, working hours.',
  },
  {
    code: 'rulebook',
    title: 'Employee Rule Book',
    category: 'handbook',
    version: '2026.1',
    ackRequired: true,
    effectiveFrom: '2026-04-01',
    docUrl: file('1HOplT26ygmZ9Vhnjc_wnBA3edCFoj2cM'),
    summary: 'Working hours, attendance, dress, premises and equipment rules.',
  },
  {
    code: 'cgp',
    title: 'CGP — Performance & Appraisal Policy',
    category: 'performance',
    version: '2026.1',
    ackRequired: true,
    effectiveFrom: '2026-04-01',
    docUrl: file('1K8gKCLURFm342GViw_8cEU_0o7dzRt2l'),
    summary: 'How the quarterly performance cycle runs: goals, review, calibration, rating, outcome.',
  },
  {
    code: 'band',
    title: 'Grade & Band Structure Policy',
    category: 'performance',
    version: '2026.1',
    ackRequired: false,
    effectiveFrom: '2026-04-01',
    docUrl: file('1Hd4k7QwBlzYL_ePY4EZ0yCpw1LUaQxyEWjx6aPKmtRA'),
    summary: 'The L1–L6 ladder, what each band is expected to own, and what moves you up one.',
  },
  {
    code: 'leave',
    title: 'Leave Policy',
    category: 'time',
    version: '2026.2',
    ackRequired: true,
    effectiveFrom: '2026-04-01',
    summary: 'CL, SL, EL, comp-off and LOP — quotas, carry-forward, notice and approval.',
  },
  {
    code: 'disc',
    title: 'Disciplinary & Misconduct Policy',
    category: 'conduct',
    version: '2026.1',
    ackRequired: false,
    effectiveFrom: '2026-04-01',
    summary:
      'What counts as misconduct, and the steps from a conversation to a warning to separation.',
  },
  {
    code: 'dispute',
    title: 'Dispute Resolution Framework',
    category: 'conduct',
    version: '2026.1',
    ackRequired: false,
    effectiveFrom: '2026-04-01',
    summary: 'How a disagreement gets heard and settled without it becoming a grievance.',
  },
  {
    code: 'way',
    title: 'The Elecbits Way',
    category: 'culture',
    version: '2026.1',
    ackRequired: false,
    effectiveFrom: '2026-04-01',
    docUrl: file('1sCMJJZyK2mfJtQGkeEg99iFeMS2TZ5dn'),
    summary:
      'The employee handbook — how the company thinks, and what it expects of the people in it.',
  },
  {
    code: 'pip',
    title: 'PIP Process',
    category: 'performance',
    version: '2026.1',
    ackRequired: false,
    effectiveFrom: '2026-04-01',
    summary: 'When a performance improvement plan is opened, what it contains, and how it closes.',
  },
];

async function main() {
  let inserted = 0;
  for (const row of POLICY_SEED) {
    const result = await db.orm.insert(policies).values(row).onConflictDoNothing().returning();
    if (result.length > 0) inserted += 1;
  }
  logger.info({ inserted, total: POLICY_SEED.length }, 'Policy seed complete');
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'Policy seed failed');
    process.exitCode = 1;
  })
  .finally(() => db.close());
