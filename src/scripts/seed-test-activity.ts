import { eq, inArray } from 'drizzle-orm';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { db } from '../db/index.js';
import { attendance, goals, reviewCycles, workUpdates } from '../db/schema/index.js';
import { createAuthzRepository } from '../features/access/authz.repository.js';
import { createAttendanceRepository } from '../features/attendance/attendance.repository.js';
import { createAttendanceService } from '../features/attendance/attendance.service.js';
import { createCareerRepository } from '../features/career/career.repository.js';
import { createCareerService } from '../features/career/career.service.js';
import { createFeedbackRepository } from '../features/feedback/feedback.repository.js';
import { createFeedbackService } from '../features/feedback/feedback.service.js';
import { createLeavesRepository } from '../features/leaves/leaves.repository.js';
import { createLeavesService } from '../features/leaves/leaves.service.js';
import { createPerformanceRepository } from '../features/performance/performance.repository.js';
import { createPerformanceService } from '../features/performance/performance.service.js';
import { createPoliciesRepository } from '../features/policies/policies.repository.js';
import { createPoliciesService } from '../features/policies/policies.service.js';
import { createQuarterReportsRepository } from '../features/quarter-reports/quarterReports.repository.js';
import { createQuarterReportsService } from '../features/quarter-reports/quarterReports.service.js';
import { createRecognitionsRepository } from '../features/recognitions/recognitions.repository.js';
import { createRecognitionsService } from '../features/recognitions/recognitions.service.js';
import { createReimbursementsRepository } from '../features/reimbursements/reimbursements.repository.js';
import { createReimbursementsService } from '../features/reimbursements/reimbursements.service.js';
import { createSettingsRepository } from '../features/settings/index.js';

/**
 * CLI: fill the test roster with ~3½ months of believable activity so every
 * screen has something to show.
 *   npm run db:seed-test-activity      (after db:seed-test-employees)
 *
 * What it writes, for every active person (not the Owner, not before their
 * joining date), 1 Jul 2026 → yesterday:
 *  - punches on working days (on time, late, half days, a few absences, a few
 *    missed check-outs) and daily work updates (some missed, two late entries
 *    waiting on the RM);
 *  - leaves (past sick / compassionate / menstrual, future earned / vacation;
 *    approved, partly approved, pending, declined) and remote work;
 *  - 2026-Q3 goals, then closes Q3 so quarter reports exist; 2026-Q4 goals
 *    with progress (Q4 stays open for you to close);
 *  - career roadmaps + notes, feedback notes, R&R nominations, reimbursement
 *    claims, policy acknowledgements.
 *
 * Requests, approvals, goals and the rest go through the real services, so
 * balances, approval slots, bells and audit rows are exactly what the app
 * would write. Only what the services can't backdate — old punches, old work
 * updates and the past quarter's goals — is inserted directly.
 *
 * ONE-SHOT: punches carry check_in_ip = 'seed'; if any exist the script stops
 * (pass --force to add another layer anyway). Test-only: refuses production.
 */

const START = '2026-07-01';
const SEED_IP = 'seed';
const HR_CODE = 'EB-0013'; // Meera — HRBP
const HR2_CODE = 'EB-0019'; // Fatima — second HRBP (decides when Meera can't)
const PAYROLL_CODE = 'EB-0008'; // Priya Nair — PR
const FEMALE = new Set([
  'EB-0003',
  'EB-0008',
  'EB-0010',
  'EB-0012',
  'EB-0013',
  'EB-0016',
  'EB-0019',
  'EB-0020',
]);

type Actor = { actorUserId: string; actorEmployeeId: string };

interface Person {
  id: string;
  code: string;
  name: string;
  level: string;
  dept: string | null;
  doj: string | null;
  confirmation: string | null;
  rmId: string | null;
  userId: string;
}

// --- small helpers ---------------------------------------------------------

const DAY = 86_400_000;
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const today = () => new Date().toLocaleDateString('en-CA');
const at = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+05:30`);
const hm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Deterministic per-person randomness, so a re-run on a fresh DB looks the same. */
const rng = (key: string) => {
  let h = 2166136261;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
};
const pick = <T>(r: () => number, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)]!;

/** First weekday on or after `d`. */
const nextWeekday = (d: string) => {
  let x = d;
  while (weekday(x) === 0 || weekday(x) === 6) x = addDays(x, 1);
  return x;
};

const tally: Record<string, number> = {};
const count = (k: string, n = 1) => (tally[k] = (tally[k] ?? 0) + n);
const failures: string[] = [];
/** Run one step; a refusal from a business rule is logged and skipped, never fatal. */
const attempt = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
  try {
    return await fn();
  } catch (err) {
    const e = err as { message?: string; code?: string };
    failures.push(`${label}: ${e.code ?? ''} ${e.message ?? String(err)}`.trim());
    return null;
  }
};

// --- content pools ---------------------------------------------------------

const GOALS: Record<
  string,
  Array<[string, 'fundamental' | 'corporate' | 'general', string]>
> = {
  Engineering: [
    ['Ship the BMS firmware v2.3 release', 'fundamental', 'release tagged, 0 P1 bugs'],
    ['Cut board bring-up time', 'fundamental', 'under 2 days per board'],
    ['Write test fixtures for the motor controller', 'fundamental', '90% path coverage'],
    ['Document the CAN protocol layer', 'corporate', 'wiki page reviewed'],
    ['Mentor one intern through a module', 'general', 'module merged'],
    ['Reduce flaky CI runs', 'corporate', 'under 2% reruns'],
  ],
  Sales: [
    ['Close new enterprise accounts', 'fundamental', '3 signed POs'],
    ['Grow the pipeline', 'fundamental', '₹1.2 Cr qualified'],
    ['Customer demos with the design team', 'corporate', '8 demos'],
    ['Update the pricing playbook', 'general', 'playbook v2 shared'],
  ],
  'People Operations': [
    ['Close open positions on time', 'fundamental', 'time-to-hire under 30 days'],
    ['Roll out the HRMS to all teams', 'fundamental', '100% claimed logins'],
    ['Policy acknowledgements complete', 'corporate', '95% signed'],
    ['Run the quarterly engagement pulse', 'general', 'response rate 80%'],
  ],
  Operations: [
    ['Asset register fully tagged', 'fundamental', 'every item has a code'],
    ['Lab consumables never run out', 'fundamental', 'zero stock-outs'],
    ['Gate-pass returns on time', 'corporate', '95% on time'],
  ],
  Hardware: [
    ['Prototype the sensor board rev C', 'fundamental', 'rev C passes EVT'],
    ['Cut BOM cost', 'fundamental', '8% lower'],
    ['Supplier qualification for connectors', 'corporate', '2 new suppliers'],
    ['Lab safety checklist', 'general', 'monthly audit done'],
  ],
};
const goalPool = (dept: string | null) => GOALS[dept ?? ''] ?? GOALS.Engineering!;

const UPDATES: Record<string, string[]> = {
  Engineering: [
    'Debugged the SPI timing issue on the dev board; fix is in review.',
    'Wrote unit tests for the charge-state machine and fixed two edge cases.',
    'Paired on the bootloader update; flashed and verified 6 boards.',
    'Reviewed two PRs and updated the CAN message map.',
    'Profiled the ADC loop — cut 12% CPU; documented the change.',
    'Bring-up of the new motor driver board; found a footprint issue.',
  ],
  Sales: [
    'Two discovery calls with EV OEMs; sent the capability deck.',
    'Followed up on the pending PO; legal review is next.',
    'Demo with the design team for a battery-pack client.',
    'Updated CRM and the forecast for the month.',
  ],
  'People Operations': [
    'Screened 6 profiles and scheduled 3 interviews.',
    'Onboarding for the new joiner; laptop and access requested.',
    'Followed up on policy acknowledgements with two teams.',
    'Payroll inputs checked for the month; two queries closed.',
  ],
  Operations: [
    'Tagged 14 lab assets and updated the register.',
    'Restocked solder and flux; logged the stock movement.',
    'Processed two gate passes and checked returns.',
  ],
  Hardware: [
    'Reworked the sensor board layout after the DFM review.',
    'Ran thermal tests on rev B; logged results.',
    'Supplier call on connector lead times.',
  ],
};
const updatePool = (dept: string | null) => UPDATES[dept ?? ''] ?? UPDATES.Engineering!;

/** Goal attainment profile per person — gives the quarter reports a spread (E3 … below 50). */
const PROFILE: Record<string, [number, number]> = {
  'EB-0011': [25, 45], // Vikram — below 50 → PIP candidate
  'EB-0004': [35, 55], // Ravi — borderline
  'EB-0012': [60, 78], // Neha
  'EB-0016': [55, 75], // Divya
  'EB-0010': [85, 100], // Asha — E3
  'EB-0017': [80, 98], // Arjun — E3, may ask for a promotion conversation
};

async function main() {
  if (env.nodeEnv === 'production') {
    throw new Error('seed-test-activity is test data — refusing to run in production');
  }
  const force = process.argv.includes('--force');
  const seeded = await db.query<{ n: number }>(
    `select count(*)::int n from org.attendance where check_in_ip = $1`,
    [SEED_IP],
  );
  if ((seeded[0]?.n ?? 0) > 0 && !force) {
    logger.warn(
      'Activity already seeded (punches marked "seed" exist) — pass --force to add more',
    );
    return;
  }
  const END = addDays(today(), -1);

  // --- people ---------------------------------------------------------------
  const rows = await db.query<{
    id: string;
    code: string;
    name: string;
    level: string;
    dept: string | null;
    doj: string | null;
    confirmation: string | null;
    rm: string | null;
    user_id: string;
    gender: string | null;
  }>(
    `select e.id, e.employee_code code, e.name, e.level, d.name dept,
            e.date_of_joining::text doj, e.confirmation_date::text confirmation,
            coalesce(e.leave_approver, e.reports_to) rm, u.id user_id, e.gender
       from org.employees e
       join public.users u on u.employee_id = e.id
       left join org.departments d on d.id = e.department_id
       left join access.org_owner o on o.employee_id = e.id
      where e.status = 'active' and o.employee_id is null
      order by e.employee_code`,
  );
  const owner = await db.query<{ id: string }>(
    `select employee_id id from access.org_owner`,
  );
  const ownerId = owner[0]?.id ?? null;
  const people: Person[] = rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    level: r.level,
    dept: r.dept,
    doj: r.doj,
    confirmation: r.confirmation,
    rmId: r.rm,
    userId: r.user_id,
  }));
  const byCode = new Map(people.map((p) => [p.code, p]));
  const byId = new Map(people.map((p) => [p.id, p]));
  const actor = (p: Person): Actor => ({ actorUserId: p.userId, actorEmployeeId: p.id });
  const hr = byCode.get(HR_CODE)!;
  const hr2 = byCode.get(HR2_CODE)!;
  const payroll = byCode.get(PAYROLL_CODE)!;
  /** The RM who decides for p, or null when p is self-governed (RM = the Owner). */
  const rmOf = (p: Person) =>
    p.rmId && p.rmId !== ownerId ? (byId.get(p.rmId) ?? null) : null;
  const hrFor = (p: Person) => (p.id === hr.id ? hr2 : hr);
  const onProbation = (p: Person) => p.confirmation !== null && p.confirmation > today();
  const startFor = (p: Person) => (p.doj && p.doj > START ? p.doj : START);

  // Menstrual leave is gender-gated — fill gender where it was never set.
  for (const r of rows) {
    if (r.gender) continue;
    await db.query(`update org.employees set gender = $1 where id = $2`, [
      FEMALE.has(r.code) ? 'Female' : 'Male',
      r.id,
    ]);
    count('gender set');
  }

  // --- services ---------------------------------------------------------------
  const authz = createAuthzRepository(db);
  const settings = createSettingsRepository(db);
  const attendanceSvc = createAttendanceService({
    repo: createAttendanceRepository(db),
    authz,
    settings,
  });
  const leaves = createLeavesService({
    repo: createLeavesRepository(db),
    authz,
    settings,
  });
  const perf = createPerformanceService({
    repo: createPerformanceRepository(db),
    authz,
    settings,
  });
  const quarters = createQuarterReportsService({
    repo: createQuarterReportsRepository(db),
    attendance: attendanceSvc,
  });
  const career = createCareerService({
    repo: createCareerRepository(db),
    authz,
    settings,
  });
  const feedback = createFeedbackService({ repo: createFeedbackRepository(db), authz });
  const awards = createRecognitionsService({
    repo: createRecognitionsRepository(db),
    authz,
    settings,
  });
  const claims = createReimbursementsService({
    repo: createReimbursementsRepository(db),
    authz,
  });
  const policies = createPoliciesService({ repo: createPoliciesRepository(db) });

  // --- 1. leaves ------------------------------------------------------------------
  /** Approve every slot: the RM first, then HR (self-governed ones are born approved). */
  const approveLeave = async (id: string, p: Person, rmOnly = false) => {
    const rm = rmOf(p);
    if (rm)
      await attempt(`leave rm ${p.code}`, () =>
        leaves.decide(id, { decision: 'approve' }, actor(rm)),
      );
    if (!rmOnly) {
      await attempt(`leave hr ${p.code}`, () =>
        leaves.decide(id, { decision: 'approve' }, actor(hrFor(p))),
      );
    }
  };
  const raiseLeave = async (
    p: Person,
    type:
      'sick' | 'earned' | 'unpaid' | 'menstrual' | 'vacation_family' | 'compassionate',
    startDate: string,
    endDate: string,
    reason: string,
  ) =>
    attempt(`leave ${type} ${p.code} ${startDate}`, () =>
      leaves.raise(p.id, { type, startDate, endDate, dayPart: 'full', reason }, actor(p)),
    );

  for (const [i, p] of people.entries()) {
    const from = startFor(p);
    // A past sick day, approved (September, or after joining).
    const sickDay = nextWeekday(
      from > '2026-09-08' ? addDays(from, 3) : addDays('2026-09-08', i % 8),
    );
    if (sickDay < END) {
      const l = await raiseLeave(p, 'sick', sickDay, sickDay, 'Fever, resting at home.');
      if (l) {
        await approveLeave(l.id, p);
        count('leave sick approved');
      }
    }
    if (onProbation(p)) {
      // Probation: only sick leave — one waiting on the RM.
      const d = nextWeekday(addDays(END, -4));
      if (d > from) {
        const l = await raiseLeave(p, 'sick', d, d, 'Migraine since morning.');
        if (l) count('leave sick pending');
      }
      continue;
    }
    if (i % 4 === 0 && from < '2026-08-10') {
      const d = nextWeekday(addDays('2026-08-10', i % 5));
      const l = await raiseLeave(p, 'compassionate', d, d, 'Family bereavement.');
      if (l) {
        await approveLeave(l.id, p);
        count('leave compassionate approved');
      }
    }
    if (FEMALE.has(p.code)) {
      const d = nextWeekday(addDays('2026-10-07', i % 3));
      if (d > from) {
        const l = await raiseLeave(p, 'menstrual', d, d, '');
        if (l) {
          await approveLeave(l.id, p);
          count('leave menstrual approved');
        }
      }
    }
    // A past sick request still waiting on the RM (team leave queue).
    if (i % 4 === 1) {
      const d = nextWeekday(addDays(END, -5));
      const l = await raiseLeave(p, 'sick', d, d, 'Stomach upset.');
      if (l) count('leave sick pending');
    }
    // An unpaid day declined with a reason.
    if (i % 5 === 1) {
      const d = nextWeekday(addDays(today(), 14));
      const l = await raiseLeave(p, 'unpaid', d, d, 'Personal work.');
      const rm = rmOf(p) ?? hrFor(p);
      if (l)
        await attempt(`decline ${p.code}`, () =>
          leaves.decide(
            l.id,
            { decision: 'decline', reason: 'Release week — please pick another day.' },
            actor(rm),
          ),
        );
      if (l) count('leave unpaid declined');
    }
    // Planned earned leave in November: approved / RM-only / pending, by turn.
    const ns = nextWeekday(addDays('2026-11-09', (i % 3) * 7));
    const l = await raiseLeave(
      p,
      'earned',
      ns,
      addDays(ns, 1),
      'Planned break — travelling home.',
    );
    if (l) {
      if (i % 3 === 0) {
        await approveLeave(l.id, p);
        count('leave earned approved');
      } else if (i % 3 === 1) {
        await approveLeave(l.id, p, true);
        count('leave earned partly approved');
      } else count('leave earned pending');
    }
    if (i % 4 === 2) {
      const d = nextWeekday('2026-12-07');
      const v = await raiseLeave(
        p,
        'vacation_family',
        d,
        addDays(d, 2),
        'Sister’s wedding.',
      );
      if (v) count('leave vacation pending');
    }
  }

  // --- 2. remote work ---------------------------------------------------------------
  for (const [i, p] of people.entries()) {
    if (i % 2 === 0) {
      const s = nextWeekday(addDays('2026-09-14', i % 5));
      if (s > startFor(p)) {
        const w = await attempt(`remote ${p.code}`, () =>
          attendanceSvc.raiseWfh(
            p.id,
            {
              startDate: s,
              endDate: s,
              reason: 'Client visit at their plant for integration testing.',
            },
            actor(p),
          ),
        );
        if (w) {
          const rm = rmOf(p);
          if (rm)
            await attempt(`remote rm ${p.code}`, () =>
              attendanceSvc.decideWfh(w.id, { decision: 'approve' }, actor(rm)),
            );
          await attempt(`remote hr ${p.code}`, () =>
            attendanceSvc.decideWfh(w.id, { decision: 'approve' }, actor(hrFor(p))),
          );
          count('remote approved');
        }
      }
    }
    if (i % 3 === 0) {
      const s = nextWeekday(addDays(today(), 6));
      const w = await attempt(`remote future ${p.code}`, () =>
        attendanceSvc.raiseWfh(
          p.id,
          {
            startDate: s,
            endDate: s,
            reason: 'Waiting at home for an internet installation.',
          },
          actor(p),
        ),
      );
      if (w) count('remote pending');
    }
  }

  // --- 3. Q3 goals (past quarter — inserted directly) ---------------------------------------
  const q3Name = '2026-Q3';
  await db.orm
    .insert(reviewCycles)
    .values({ name: q3Name, startDate: '2026-07-01', endDate: '2026-09-30' })
    .onConflictDoNothing();
  const q3 = (
    await db.orm.select().from(reviewCycles).where(eq(reviewCycles.name, q3Name))
  )[0]!;
  const q3Goals = new Map<string, string[]>();
  if (!q3.closedAt) {
    for (const p of people) {
      if (p.doj && p.doj > '2026-09-15') continue;
      const r = rng(`q3-${p.code}`);
      const [lo, hi] = PROFILE[p.code] ?? (r() < 0.5 ? [65, 85] : [75, 95]);
      const pool = goalPool(p.dept);
      const chosen = [
        pool[0]!,
        pool[1]!,
        pool.find((g) => g[1] === 'corporate')!,
        pool.find((g) => g[1] === 'general') ?? pool[2]!,
      ];
      const weights = [30, 30, 20, 20];
      const inserted = await db.orm
        .insert(goals)
        .values(
          chosen.map(([title, category, target], k) => ({
            employeeId: p.id,
            cycleId: q3.id,
            title,
            category,
            target,
            weight: String(weights[k]),
            progress: Math.round(lo + r() * (hi - lo)),
            dueOn: '2026-09-30',
            createdBy: rmOf(p)?.id ?? p.id,
            createdAt: new Date('2026-07-03T10:00:00+05:30'),
          })),
        )
        .returning({ id: goals.id });
      q3Goals.set(
        p.id,
        inserted.map((g) => g.id),
      );
      count('goals Q3', inserted.length);
    }
  }

  // --- 4. Q4 goals through the service (the open quarter) ---------------------------------
  const q4Goals = new Map<string, string[]>();
  for (const p of people) {
    const setter = rmOf(p) ?? p; // self-governed people set their own
    const r = rng(`q4-${p.code}`);
    const pool = goalPool(p.dept);
    const chosen = [
      pool[pool.length > 4 ? 2 : 0]!,
      pool[1]!,
      pool.find((g) => g[1] === 'corporate')!,
    ];
    const ids: string[] = [];
    for (const [k, [title, category, target]] of chosen.entries()) {
      const g = await attempt(`goal ${p.code}`, () =>
        perf.createGoal(
          { employeeId: p.id, title, category, target, weight: [40, 30, 30][k]! },
          actor(setter),
        ),
      );
      if (!g) continue;
      ids.push(g.id);
      count('goals Q4');
      await attempt(`progress ${p.code}`, () =>
        perf.updateProgress(g.id, { progress: Math.round(10 + r() * 50) }, actor(p)),
      );
    }
    q4Goals.set(p.id, ids);
  }

  // --- 5. punches + work updates (history — inserted directly) -----------------------------
  const holidays = new Set(
    (await db.query<{ d: string }>(`select date::text d from org.holidays`)).map(
      (h) => h.d,
    ),
  );
  const ids = people.map((p) => p.id);
  const away = await db.query<{ employee_id: string; s: string; e: string }>(
    `select employee_id, start_date::text s, end_date::text e from org.leave_requests
      where employee_id = any($1) and status in ('approved','partially_approved','pending')`,
    [ids],
  );
  const remote = await db.query<{ employee_id: string; s: string; e: string }>(
    `select employee_id, start_date::text s, end_date::text e from org.wfh_requests
      where employee_id = any($1) and status = 'approved'`,
    [ids],
  );
  const existing = new Set(
    (
      await db.orm
        .select({ e: attendance.employeeId, d: attendance.date })
        .from(attendance)
        .where(inArray(attendance.employeeId, ids))
    ).map((a) => `${a.e}:${a.d}`),
  );
  const covers = (list: typeof away, p: Person, d: string) =>
    list.some((x) => x.employee_id === p.id && x.s <= d && d <= x.e);
  const zone = (
    await db.query<{ lat: string; lng: string }>(
      `select lat, lng from org.punch_zones limit 1`,
    )
  )[0];
  const lateEntryFor = new Set(['EB-0010', 'EB-0012']); // two late updates waiting on Rahul

  for (const p of people) {
    const r = rng(`days-${p.code}`);
    const punches: (typeof attendance.$inferInsert)[] = [];
    const notes: (typeof workUpdates.$inferInsert)[] = [];
    let lateDone = false;
    for (let d = startFor(p); d <= END; d = addDays(d, 1)) {
      const wd = weekday(d);
      // Before 1 Nov every Saturday is off (attendance.workWeek); Sundays always.
      if (wd === 0 || wd === 6 || holidays.has(d)) continue;
      if (covers(away, p, d)) continue;
      // A day punched by hand earlier keeps its punch but still gets an update.
      const hadPunch = existing.has(`${p.id}:${d}`);
      const isRemote = covers(remote, p, d);
      const x = r();
      if (!hadPunch && !isRemote && x < 0.04) continue; // absent — payroll auto-cover / LOP
      if (!hadPunch) {
        let inAt: Date;
        let outAt: Date | null;
        if (isRemote) {
          inAt = at(d, hm(560 + Math.floor(r() * 15)));
          outAt = at(d, hm(1110 + Math.floor(r() * 20)));
        } else if (x < 0.1) {
          inAt = at(d, hm(605 + Math.floor(r() * 45))); // late …
          outAt = at(d, hm(1140 + Math.floor(r() * 30))); // … but stayed the full day
        } else if (x < 0.14) {
          inAt = at(d, hm(565 + Math.floor(r() * 15)));
          outAt = at(d, hm(790 + Math.floor(r() * 20))); // half day
        } else if (x < 0.16 && d < '2026-10-01') {
          inAt = at(d, hm(560 + Math.floor(r() * 20)));
          outAt = null; // forgot to check out
        } else {
          inAt = at(d, hm(550 + Math.floor(r() * 30)));
          outAt = at(d, hm(1110 + Math.floor(r() * 40)));
        }
        punches.push({
          employeeId: p.id,
          date: d,
          checkInAt: inAt,
          checkOutAt: outAt,
          source: isRemote ? 'remote' : 'office',
          checkInIp: SEED_IP,
          checkInLat: isRemote ? null : (zone?.lat ?? null),
          checkInLng: isRemote ? null : (zone?.lng ?? null),
        });
      }

      // The day's work update: most days on time, some missed.
      const tagFrom = d < '2026-10-01' ? q3Goals.get(p.id) : q4Goals.get(p.id);
      const tags = tagFrom && tagFrom.length > 0 ? [pick(r, tagFrom)] : null;
      const recentMiss = d >= addDays(END, -9) && d <= addDays(END, -4);
      if (lateEntryFor.has(p.code) && !lateDone && recentMiss) {
        notes.push({
          employeeId: p.id,
          date: d,
          note: `${pick(r, updatePool(p.dept))} (filled in late)`,
          goalIds: tags,
          lateStatus: 'pending',
          createdAt: at(addDays(d, 2), '10:15'),
          updatedAt: at(addDays(d, 2), '10:15'),
        });
        lateDone = true;
        continue;
      }
      if (r() < 0.08) continue; // missed update
      notes.push({
        employeeId: p.id,
        date: d,
        note: pick(r, updatePool(p.dept)),
        goalIds: tags,
        createdAt: at(d, '18:40'),
        updatedAt: at(d, '18:40'),
      });
    }
    if (punches.length > 0) {
      await db.orm.insert(attendance).values(punches).onConflictDoNothing();
      count('punches', punches.length);
    }
    if (notes.length > 0) {
      await db.orm.insert(workUpdates).values(notes).onConflictDoNothing();
      count('work updates', notes.length);
    }
  }

  // --- 6. close Q3 → quarter reports -------------------------------------------------------------
  if (!q3.closedAt) {
    const closed = await attempt('close Q3', () =>
      quarters.close(q3Name, false, actor(hr)),
    );
    if (closed) count('quarter closed');
  }

  // --- 7. career roadmaps ---------------------------------------------------------------------------
  const rahul = byCode.get('EB-0009');
  const sanjay = byCode.get('EB-0015');
  const kiran = byCode.get('EB-0014');
  const asha = byCode.get('EB-0010');
  const arjun = byCode.get('EB-0017');
  const neha = byCode.get('EB-0012');
  const vikram = byCode.get('EB-0011');
  const divya = byCode.get('EB-0016');
  const rohan = byCode.get('EB-0018');
  const pooja = byCode.get('EB-0020');
  const fatima = byCode.get('EB-0019');

  const note = async (trackId: string, by: Person, body: string) => {
    const n = await attempt(`track note`, () =>
      career.addNote(trackId, { body }, actor(by)),
    );
    if (n) count('career notes');
  };
  if (arjun && rahul) {
    const t = await attempt('career request Arjun', () => career.request(actor(arjun)));
    if (t) {
      count('career tracks');
      await note(
        t.id,
        rahul,
        'Strong Q3. For L4: own the motor-controller roadmap end to end and review two juniors’ work each sprint.',
      );
    }
  }
  if (asha && rahul) {
    const t = await attempt('career Asha', () =>
      career.openForReport(
        { employeeId: asha.id, note: 'Ready to grow into L3 — owning a subsystem.' },
        actor(rahul),
      ),
    );
    if (t) {
      count('career tracks');
      await note(
        t.id,
        rahul,
        'Take over the BMS test fixtures and present the design review in November.',
      );
      await note(
        t.id,
        hr,
        'Band expectations for L3 shared; check-in again at the end of Q4.',
      );
    }
  }
  if (pooja) {
    const t = await attempt('career Pooja', () =>
      career.openForReport(
        { employeeId: pooja.id, note: 'Path to L4 — lead the hiring calendar.' },
        actor(hr),
      ),
    );
    if (t) {
      count('career tracks');
      await note(t.id, hr, 'Own the campus-hiring plan for 2027 as the stretch goal.');
    }
  }
  if (sanjay) {
    const t = await attempt('career Sanjay', () =>
      career.openForReport(
        { employeeId: sanjay.id, note: 'Department-head conversation for Sales.' },
        actor(hr),
      ),
    );
    if (t) count('career tracks');
  }
  if (fatima) {
    const t = await attempt('career Fatima', () =>
      career.openForReport(
        { employeeId: fatima.id, note: 'Explore an L4 HRBP role.' },
        actor(hr),
      ),
    );
    if (t) {
      count('career tracks');
      await attempt('close Fatima track', () =>
        career.closeTrack(
          t.id,
          { outcome: 'closed', reason: 'Revisit after the next appraisal cycle.' },
          actor(hr),
        ),
      );
    }
  }
  if (neha && rahul) {
    const open = await db.query<{ id: string }>(
      `select id from org.career_tracks where employee_id = $1 and status = 'open'`,
      [neha.id],
    );
    if (open[0])
      await note(
        open[0].id,
        rahul,
        'Good progress on the test platform — keep the weekly demos going.',
      );
  }

  // --- 8. feedback notes -------------------------------------------------------------------------------
  const notesToSend: Array<
    [Person | undefined, Person | undefined, 'appreciation' | 'concern', string]
  > = [
    [
      rahul,
      asha,
      'appreciation',
      'Great job unblocking the firmware release last week — the fixture work saved us days.',
    ],
    [
      rahul,
      vikram,
      'concern',
      'Several updates were missed this month and two goals are behind. Let’s sit down on Friday and plan.',
    ],
    [
      rahul,
      arjun,
      'appreciation',
      'Thanks for mentoring the intern through the CAN module.',
    ],
    [
      sanjay,
      divya,
      'appreciation',
      'The client demo went really well — they asked for a follow-up.',
    ],
    [
      kiran,
      rohan,
      'appreciation',
      'Lab tagging is moving fast, thank you for the careful work.',
    ],
    [hr, pooja, 'appreciation', 'Closed two positions ahead of time — well done.'],
  ];
  for (const [from, to, type, body] of notesToSend) {
    if (!from || !to) continue;
    const n = await attempt(`feedback ${to.code}`, () =>
      feedback.send({ employeeId: to.id, type, body }, actor(from)),
    );
    if (n) count('feedback notes');
  }

  // --- 9. R&R ---------------------------------------------------------------------------------------------
  const nominate = async (
    by: Person | undefined,
    to: Array<Person | undefined>,
    type: string,
    citation: string,
  ) => {
    const list = to.filter((x): x is Person => Boolean(x));
    if (!by || list.length === 0) return null;
    const n = await attempt(`nominate ${type}`, () =>
      awards.nominate({ employeeIds: list.map((x) => x.id), type, citation }, actor(by)),
    );
    if (n) count('nominations');
    return n;
  };
  const spot = await nominate(
    rahul,
    [asha],
    'spot',
    'Stayed late two nights to fix the BMS charge-state bug before the client demo, then wrote the regression tests so it can’t come back.',
  );
  if (spot)
    await attempt('approve spot', () =>
      awards.decide(spot.id, { decision: 'approve' }, actor(hr)),
    );
  const own = await nominate(
    rahul,
    [arjun],
    'owner',
    'Took full ownership of the motor-controller rework: planned it, split it across the team and shipped it a week early.',
  );
  if (own)
    await attempt('approve owner', () =>
      awards.decide(own.id, { decision: 'approve' }, actor(hr)),
    );
  await nominate(
    sanjay,
    [divya],
    'customer',
    'Turned a frustrated customer around with a same-day site visit and a clear fix plan; they renewed for another year.',
  );
  await nominate(
    rahul,
    [asha, vikram, arjun],
    'team',
    'The firmware team shipped v2.3 with zero P1 bugs and cut board bring-up time in half this quarter.',
  );
  const innov = await nominate(
    hr,
    [pooja],
    'innov',
    'Built a simple scoring sheet for screening that cut our time-to-hire by a week across three roles.',
  );
  if (innov && fatima)
    await attempt('approve innov', () =>
      awards.decide(innov.id, { decision: 'approve' }, actor(fatima)),
    );
  const decl = await nominate(
    kiran,
    [rohan],
    'spot',
    'Tagged the whole lab inventory in his first two weeks and found three items missing from the register.',
  );
  if (decl)
    await attempt('decline spot', () =>
      awards.decide(
        decl.id,
        {
          decision: 'decline',
          reason: 'Lovely work — let’s recognise it at the month-end review instead.',
        },
        actor(hr),
      ),
    );

  // --- 10. reimbursements ----------------------------------------------------------------------------------
  const claim = async (
    p: Person | undefined,
    input: {
      spentOn: string;
      category: 'travel' | 'food' | 'internet_phone' | 'equipment' | 'other';
      description: string;
      amount: number;
    },
    steps: Array<'rm' | 'payroll' | 'decline'>,
  ) => {
    if (!p) return;
    const c = await attempt(`claim ${p.code}`, () =>
      claims.create({ ...input, receiptNote: 'Receipt with HR' }, actor(p)),
    );
    if (!c) return;
    count('claims');
    for (const s of steps) {
      const rm = rmOf(p);
      if (s === 'rm' && rm)
        await attempt(`claim rm ${p.code}`, () =>
          claims.decide(c.id, { decision: 'approve' }, actor(rm)),
        );
      if (s === 'payroll')
        await attempt(`claim payroll ${p.code}`, () =>
          claims.decide(c.id, { decision: 'approve' }, actor(payroll)),
        );
      if (s === 'decline')
        await attempt(`claim decline ${p.code}`, () =>
          claims.decide(
            c.id,
            { decision: 'decline', reason: 'Not a business expense — personal travel.' },
            actor(rm ?? payroll),
          ),
        );
    }
  };
  await claim(
    asha,
    {
      spentOn: '2026-10-09',
      category: 'travel',
      description: 'Cab to the vendor for the board pickup',
      amount: 1450,
    },
    ['rm', 'payroll'],
  );
  await claim(
    vikram,
    {
      spentOn: '2026-10-13',
      category: 'food',
      description: 'Team dinner during the release crunch',
      amount: 620,
    },
    ['rm'],
  );
  await claim(
    neha,
    {
      spentOn: '2026-10-15',
      category: 'internet_phone',
      description: 'Mobile data top-up for on-call week',
      amount: 799,
    },
    [],
  );
  await claim(
    arjun,
    {
      spentOn: '2026-10-05',
      category: 'travel',
      description: 'Weekend trip cab',
      amount: 3200,
    },
    ['decline'],
  );
  await claim(
    divya,
    {
      spentOn: '2026-10-08',
      category: 'travel',
      description: 'Client site visit — train tickets',
      amount: 2100,
    },
    ['rm', 'payroll'],
  );
  await claim(
    rahul,
    {
      spentOn: '2026-10-12',
      category: 'equipment',
      description: 'USB logic analyser for the lab',
      amount: 1800,
    },
    [],
  );
  await claim(
    pooja,
    {
      spentOn: '2026-10-14',
      category: 'food',
      description: 'Lunch with a candidate panel',
      amount: 450,
    },
    [],
  );

  // --- 11. policy acknowledgements --------------------------------------------------------------------------
  const live = await db.query<{ id: string }>(
    `select p.id from org.policies p
      where p.retired_at is null
        and exists (select 1 from org.policy_documents d where d.policy_id = p.id)`,
  );
  for (const p of people) {
    const r = rng(`ack-${p.code}`);
    for (const pol of live) {
      if (r() < 0.25) continue; // leave some unsigned for the tracker
      const a = await attempt(`ack ${p.code}`, () =>
        policies.acknowledge(pol.id, actor(p)),
      );
      if (a) count('policy acks');
    }
  }

  logger.info({ ...tally }, 'Test activity seed complete');
  const notable = failures.filter(
    (f) =>
      !/ALREADY_ACKNOWLEDGED|OVERLAPPING_LEAVE|SLOT_ALREADY_DECIDED|ALREADY_DECIDED/.test(
        f,
      ),
  );
  if (notable.length > 0)
    logger.warn({ skipped: notable }, 'Some steps were refused by business rules');
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'Test activity seed failed');
    process.exitCode = 1;
  })
  .finally(() => db.close());
