import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  batches,
  departments,
  employeeBatches,
  employeeSalary,
  employees,
  users,
} from '../db/schema/index.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { BASELINE_BATCHES, type Level } from '../shared/constants/constants.js';

/**
 * CLI: seed a TEST roster for exercising payroll, attendance and leaves.
 *   npm run db:seed-test-employees      (after db:migrate + both other seeds)
 *
 * Idempotent — everyone conflicts on their unique email, so re-running only
 * fills gaps. Every account is created CLAIMED (status active + users row) so
 * you can sign straight in. Test-only: refuses to run in production.
 *
 * Roster shape: one PR specialist (PR batch), one manager with three reports
 * (team views), mixed levels/employment types, one person WITHOUT a CTC so
 * payroll's "skipped" list has something to show. The Owner keeps no CTC for
 * the same reason.
 */
const TEST_PASSWORD = 'test1234';
const BCRYPT_ROUNDS = 12;

interface SeedPerson {
  email: string;
  firstName: string;
  lastName: string;
  level: Level;
  designation: string;
  employmentType: 'intern' | 'permanent' | 'contract';
  department: string;
  /** Email of the RM; must be seeded earlier in the list (or pre-exist). */
  reportsToEmail: string;
  extraBatches: string[];
  dateOfJoining: string;
  /** End of probation; omitted = not tracked. */
  confirmationDate?: string;
  noticeDays?: number;
  salary?: {
    ctc: string;
    pf?: string;
    tds?: string;
    professionalTax?: string;
    basicPercent?: string;
  };
}

const ROSTER: SeedPerson[] = [
  {
    email: 'priya.pr@elecbits.in',
    firstName: 'Priya',
    lastName: 'Nair',
    level: 'L3',
    designation: 'Payroll Specialist',
    employmentType: 'permanent',
    department: 'People Operations',
    reportsToEmail: env.auth.ownerClaimEmail,
    extraBatches: [BASELINE_BATCHES.pr],
    dateOfJoining: '2026-02-02',
    salary: { ctc: '1500000', pf: '1800', tds: '8000', professionalTax: '200' },
  },
  {
    email: 'rahul.manager@elecbits.in',
    firstName: 'Rahul',
    lastName: 'Verma',
    level: 'L4',
    designation: 'Engineering Manager',
    employmentType: 'permanent',
    department: 'Engineering',
    reportsToEmail: env.auth.ownerClaimEmail,
    extraBatches: [],
    dateOfJoining: '2025-11-10',
    salary: { ctc: '2400000', pf: '1800', tds: '20000', professionalTax: '200' },
  },
  {
    email: 'asha.eng@elecbits.in',
    firstName: 'Asha',
    lastName: 'Gupta',
    level: 'L2',
    designation: 'Hardware Engineer',
    employmentType: 'permanent',
    department: 'Engineering',
    reportsToEmail: 'rahul.manager@elecbits.in',
    extraBatches: [],
    dateOfJoining: '2026-03-16',
    salary: { ctc: '1000000', pf: '1800', tds: '4000', professionalTax: '200' },
  },
  {
    email: 'vikram.eng@elecbits.in',
    firstName: 'Vikram',
    lastName: 'Singh',
    level: 'L2',
    designation: 'Firmware Engineer',
    employmentType: 'contract',
    department: 'Engineering',
    reportsToEmail: 'rahul.manager@elecbits.in',
    extraBatches: [],
    dateOfJoining: '2026-06-01',
    // Contract: different structure split, no PF.
    salary: { ctc: '800000', tds: '2000', basicPercent: '60' },
  },
  {
    // HRBP portal: policies manage/tracker, onboarding queue, leave HR slot.
    email: 'meera.hrbp@elecbits.in',
    firstName: 'Meera',
    lastName: 'Iyer',
    level: 'L4',
    designation: 'HR Business Partner',
    employmentType: 'permanent',
    department: 'People Operations',
    reportsToEmail: env.auth.ownerClaimEmail,
    extraBatches: [BASELINE_BATCHES.hrbp],
    dateOfJoining: '2026-01-12',
    salary: { ctc: '1600000', pf: '1800', tds: '9000', professionalTax: '200' },
  },
  {
    // No salary block: payroll generation should list Neha under "skipped".
    email: 'neha.intern@elecbits.in',
    firstName: 'Neha',
    lastName: 'Joshi',
    level: 'L1',
    designation: 'Engineering Intern',
    employmentType: 'intern',
    department: 'Engineering',
    reportsToEmail: 'rahul.manager@elecbits.in',
    extraBatches: [],
    dateOfJoining: '2026-08-03',
  },
  {
    // OPS portal: the asset manager (register, requests, gate passes, stock).
    email: 'kiran.ops@elecbits.in',
    firstName: 'Kiran',
    lastName: 'Rao',
    level: 'L3',
    designation: 'Operations Executive',
    employmentType: 'permanent',
    department: 'People Operations',
    reportsToEmail: env.auth.ownerClaimEmail,
    extraBatches: [BASELINE_BATCHES.ops],
    dateOfJoining: '2026-04-06',
    salary: { ctc: '900000', pf: '1800', tds: '3000', professionalTax: '200' },
  },
  // ── Added 2026-10-16: a second team, a long-service engineer, a probationer,
  // a recent joiner, a second HR and a TA person for the coming portal.
  {
    // Second RM in another department (Sales team views, dept scope).
    email: 'sanjay.sales@elecbits.in',
    firstName: 'Sanjay',
    lastName: 'Kulkarni',
    level: 'L4',
    designation: 'Sales Manager',
    employmentType: 'permanent',
    department: 'Sales',
    reportsToEmail: env.auth.ownerClaimEmail,
    extraBatches: [],
    dateOfJoining: '2025-07-01',
    confirmationDate: '2025-09-01',
    noticeDays: 60,
    salary: { ctc: '2000000', pf: '1800', tds: '15000', professionalTax: '200' },
  },
  {
    // On probation: 2 months end 2026-10-27 — the probation job rings Sanjay
    // a week before; good for the probation and leave-gate checklist steps.
    email: 'divya.sales@elecbits.in',
    firstName: 'Divya',
    lastName: 'Menon',
    level: 'L2',
    designation: 'Sales Executive',
    employmentType: 'permanent',
    department: 'Sales',
    reportsToEmail: 'sanjay.sales@elecbits.in',
    extraBatches: [],
    dateOfJoining: '2026-08-27',
    confirmationDate: '2026-10-27',
    noticeDays: 30,
    salary: { ctc: '700000', pf: '1800', tds: '0', professionalTax: '200' },
  },
  {
    // 2+ years' service: gratuity in an F&F, loan-eligible, 30 days' notice.
    email: 'arjun.eng@elecbits.in',
    firstName: 'Arjun',
    lastName: 'Das',
    level: 'L3',
    designation: 'Senior Embedded Engineer',
    employmentType: 'permanent',
    department: 'Engineering',
    reportsToEmail: 'rahul.manager@elecbits.in',
    extraBatches: [],
    dateOfJoining: '2024-05-20',
    confirmationDate: '2024-07-20',
    noticeDays: 30,
    salary: {
      ctc: '1400000',
      pf: '1800',
      tds: '7000',
      professionalTax: '200',
      basicPercent: '40',
    },
  },
  {
    // Recent joiner (onboarding window, first-month pay); reports to OPS.
    email: 'rohan.lab@elecbits.in',
    firstName: 'Rohan',
    lastName: 'Mehta',
    level: 'L1',
    designation: 'Lab Technician',
    employmentType: 'permanent',
    department: 'Operations',
    reportsToEmail: 'kiran.ops@elecbits.in',
    extraBatches: [],
    dateOfJoining: '2026-10-06',
    confirmationDate: '2026-12-06',
    noticeDays: 30,
    salary: { ctc: '450000', pf: '1800', tds: '0', professionalTax: '200' },
  },
  {
    // Second HRBP holder: checks that HR can't decide their own requests.
    email: 'fatima.hr@elecbits.in',
    firstName: 'Fatima',
    lastName: 'Sheikh',
    level: 'L3',
    designation: 'HR Generalist',
    employmentType: 'permanent',
    department: 'People Operations',
    reportsToEmail: 'meera.hrbp@elecbits.in',
    extraBatches: [BASELINE_BATCHES.hrbp],
    dateOfJoining: '2025-12-01',
    confirmationDate: '2026-02-01',
    noticeDays: 30,
    salary: { ctc: '1100000', pf: '1800', tds: '4500', professionalTax: '200' },
  },
  {
    // For the TA (hiring) portal — no TA batch exists yet; plain employee now.
    email: 'pooja.ta@elecbits.in',
    firstName: 'Pooja',
    lastName: 'Reddy',
    level: 'L3',
    designation: 'Talent Acquisition Specialist',
    employmentType: 'permanent',
    department: 'People Operations',
    reportsToEmail: 'meera.hrbp@elecbits.in',
    extraBatches: [],
    dateOfJoining: '2026-03-02',
    confirmationDate: '2026-05-02',
    noticeDays: 30,
    salary: { ctc: '1000000', pf: '1800', tds: '4000', professionalTax: '200' },
  },
];

/** Give the existing HRBP account a CTC too, so its payslip exercises the flow. */
const HRBP_EMAIL = 'hr@elecbits.in';
const HRBP_SALARY = { ctc: '1800000', pf: '1800', tds: '12000', professionalTax: '200' };

async function findEmployeeByEmail(email: string) {
  const rows = await db.orm
    .select()
    .from(employees)
    .where(eq(employees.email, email))
    .limit(1);
  return rows[0];
}

async function ensureDepartment(name: string): Promise<string> {
  const existing = await db.orm
    .select()
    .from(departments)
    .where(eq(departments.name, name))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const rows = await db.orm.insert(departments).values({ name }).returning();
  return rows[0]!.id;
}

async function nextEmployeeCode(): Promise<string> {
  const rows = await db.query<{ max: number }>(
    `SELECT COALESCE(MAX(SUBSTRING(employee_code FROM 4)::int), 0) AS max
       FROM org.employees WHERE employee_code ~ '^EB-[0-9]+$'`,
  );
  return `EB-${String((rows[0]?.max ?? 0) + 1).padStart(4, '0')}`;
}

async function attachBatch(employeeId: string, batchName: string, grantedBy: string) {
  const rows = await db.orm
    .select({ id: batches.id })
    .from(batches)
    .where(eq(batches.name, batchName))
    .limit(1);
  if (!rows[0]) {
    logger.warn({ batchName }, 'Batch missing — run db:seed-batches first');
    return;
  }
  await db.orm
    .insert(employeeBatches)
    .values({ employeeId, batchId: rows[0].id, grantedBy })
    .onConflictDoNothing();
}

async function upsertSalary(
  employeeId: string,
  salary: NonNullable<SeedPerson['salary']>,
) {
  await db.orm
    .insert(employeeSalary)
    .values({
      employeeId,
      ctc: salary.ctc,
      pfAmount: salary.pf ?? null,
      tdsAmount: salary.tds ?? null,
      professionalTaxAmount: salary.professionalTax ?? null,
      basicPercent: salary.basicPercent ?? null,
      salaryMode: 'Bank',
    })
    .onConflictDoNothing();
}

async function main() {
  if (env.nodeEnv === 'production') {
    throw new Error('seed-test-employees is test data — refusing to run in production');
  }

  const owner = await findEmployeeByEmail(env.auth.ownerClaimEmail.toLowerCase());
  if (!owner)
    throw new Error('Owner not found — claim the org before seeding test people');

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, BCRYPT_ROUNDS);
  let created = 0;

  for (const person of ROSTER) {
    let employee = await findEmployeeByEmail(person.email);
    if (!employee) {
      const rm = await findEmployeeByEmail(person.reportsToEmail);
      const rows = await db.orm
        .insert(employees)
        .values({
          name: `${person.firstName} ${person.lastName}`,
          firstName: person.firstName,
          lastName: person.lastName,
          email: person.email,
          employeeCode: await nextEmployeeCode(),
          level: person.level,
          reportsTo: rm?.id ?? owner.id,
          departmentId: await ensureDepartment(person.department),
          designation: person.designation,
          employmentType: person.employmentType,
          dateOfJoining: person.dateOfJoining,
          confirmationDate: person.confirmationDate ?? null,
          noticeDays: person.noticeDays ?? null,
          status: 'active',
        })
        .onConflictDoNothing()
        .returning();
      employee = rows[0] ?? (await findEmployeeByEmail(person.email));
      if (rows[0]) created += 1;
    }
    if (!employee) continue;

    await db.orm
      .insert(users)
      .values({ email: person.email, passwordHash, employeeId: employee.id })
      .onConflictDoNothing();

    await attachBatch(employee.id, BASELINE_BATCHES.employee, owner.id);
    for (const batchName of person.extraBatches) {
      await attachBatch(employee.id, batchName, owner.id);
    }
    if (person.salary) await upsertSalary(employee.id, person.salary);
  }

  const hrbp = await findEmployeeByEmail(HRBP_EMAIL);
  if (hrbp) await upsertSalary(hrbp.id, HRBP_SALARY);

  // One APPROVER-ONLY relationship (leave_approver without reports_to), so
  // My Team's "approver only" tag and the approval fallback are testable:
  // Priya approves Neha's leaves while Neha still reports to Rahul.
  const priya = await findEmployeeByEmail('priya.pr@elecbits.in');
  const neha = await findEmployeeByEmail('neha.intern@elecbits.in');
  if (priya && neha && !neha.leaveApprover) {
    await db.orm
      .update(employees)
      .set({ leaveApprover: priya.id, updatedAt: new Date() })
      .where(eq(employees.id, neha.id));
  }

  logger.info({ roster: ROSTER.length, created }, 'Test employee seed complete');
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'Test employee seed failed');
    process.exitCode = 1;
  })
  .finally(() => db.close());
