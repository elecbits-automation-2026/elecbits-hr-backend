import createError from 'http-errors';
import { env } from '../../config/env.js';
import { REGULARIZE_WINDOW_DAYS } from '../../shared/constants/constants.js';
import {
  hasOrgScope,
  isWeekendDay,
  type WorkWeek,
} from '../../shared/helpers/helpers.js';
import { reachesIn, type AuthzRepository } from '../access/authz.repository.js';
import { createSelfGovernance } from '../access/selfGovernance.js';
import type { SettingValue, SettingsReader } from '../settings/index.js';
import type {
  AttendanceDayDto,
  AttendanceSummaryDto,
  CreateHolidayInput,
  CreateRegularizationInput,
  CreateWfhInput,
  CreateZoneInput,
  DecideInput,
  EmployeeAttendanceDto,
  HrMarkInput,
  MyAttendanceDto,
  PunchZoneDto,
  RegularizationDto,
  WfhRequestDto,
} from './attendance.schema.js';
import type {
  ActorContext,
  AttendanceRepository,
  AttendanceRow,
  Joined,
  RegularizationRow,
  WfhRow,
} from './attendance.repository.js';

const DAY_MS = 86_400_000;

/** YYYY-MM-DD in server-local time (en-CA formats as ISO). */
const localDate = (d = new Date()): string => d.toLocaleDateString('en-CA');

/**
 * Day iteration must stay entirely in UTC: Date.parse('YYYY-MM-DD') is UTC
 * midnight, so formatting or getDay() in server-local time shifts every date
 * west of UTC and DST breaks the fixed DAY_MS stepping.
 */
const utcDate = (t: number): string => new Date(t).toISOString().slice(0, 10);

const monthRange = (month: string): { from: string; to: string } => {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y!, m!, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
};

/** `::ffff:a.b.c.d` (IPv6-mapped IPv4) compares as `a.b.c.d`. */
const normalizeIp = (ip: string): string => ip.replace(/^::ffff:/i, '');

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance (haversine) in meters. */
const distanceMeters = (
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number => {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
};

interface Zone {
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
}

/** "1.3 km" / "420 m" — how far a refused punch was. */
const formatDistance = (m: number): string =>
  m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;

/** The closest zone to a punch and how far away it is (null without zones). */
const nearestZone = (
  coords: { lat: number; lng: number },
  zones: Zone[],
): { zone: Zone; distanceM: number } | null =>
  zones.reduce<{ zone: Zone; distanceM: number } | null>((best, zone) => {
    const distanceM = distanceMeters(coords.lat, coords.lng, zone.lat, zone.lng);
    return !best || distanceM < best.distanceM ? { zone, distanceM } : best;
  }, null);

/**
 * GEO policy (user decision): a punch inside ANY configured zone (offices,
 * warehouse — Admin-managed, each with its own radius) records clean as
 * `office`; outside every zone (or location missing/denied) punching is
 * blocked unless an approved remote-work request covers the day. In at one
 * zone and out at another is fine — both punches run the same check. Local
 * loopback without coords counts as in-zone in development only.
 */
const isInsideAnyZone = (
  coords: { lat: number; lng: number } | null,
  ip: string | undefined,
  zones: Zone[],
): boolean => {
  if (coords) {
    return zones.some(
      (z) => distanceMeters(coords.lat, coords.lng, z.lat, z.lng) <= z.radiusM,
    );
  }
  if (env.nodeEnv === 'development' && ip) {
    const norm = normalizeIp(ip);
    return norm === '127.0.0.1' || norm === '::1';
  }
  return false;
};

/** The env office is the fallback zone until Admin adds the real ones. */
const envZone = (): Zone[] => {
  const { officeLat, officeLng, officeRadiusMeters } = env.attendance;
  return officeLat !== null && officeLng !== null
    ? [{ name: 'Office', lat: officeLat, lng: officeLng, radiusM: officeRadiusMeters }]
    : [];
};

/** Minutes past local midnight for a timestamp, on the punch's own day. */
const minutesOfDay = (at: Date): number => at.getHours() * 60 + at.getMinutes();

const parseHm = (hm: string): number => {
  const [h, m] = hm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * A workday, in minutes-of-day. Each punch zone may set its own hours; the
 * attendance.workHours setting is the default. Grace is org-wide.
 */
interface Schedule {
  startMin: number;
  endMin: number;
  graceMin: number;
}

const scheduleFrom = (hours: SettingValue<'attendance.workHours'>): Schedule => ({
  startMin: parseHm(hours.workStart),
  endMin: parseHm(hours.workEnd),
  graceMin: hours.graceMinutes,
});

/** Punctuality dots (user decision): green on time, amber within grace, red past. */
const checkInTiming = (checkInAt: Date, sched: Schedule): 'ontime' | 'grace' | 'late' => {
  const at = minutesOfDay(checkInAt);
  if (at <= sched.startMin) return 'ontime';
  if (at <= sched.startMin + sched.graceMin) return 'grace';
  return 'late';
};

/** Mirrored for leaving: green at/after workEnd, amber within grace, red earlier. */
const checkOutTiming = (
  checkOutAt: Date,
  sched: Schedule,
): 'ontime' | 'grace' | 'early' => {
  const at = minutesOfDay(checkOutAt);
  if (at >= sched.endMin) return 'ontime';
  if (at >= sched.endMin - sched.graceMin) return 'grace';
  return 'early';
};

type InTiming = 'ontime' | 'grace' | 'late' | 'compensated';
type OutTiming = 'ontime' | 'grace' | 'early' | 'compensated';

/**
 * COMPENSATED (user decision): a shifted but full day — e.g. in at 10:00, out
 * at 19:00 against a 9h schedule — turns BOTH dots purple instead of red.
 * Punctual pairs stay green; days without a check-out can't compensate.
 */
const applyCompensation = (
  punch: { checkInAt: Date; checkOutAt: Date | null },
  sched: Schedule,
  inT: 'ontime' | 'grace' | 'late',
  outT: 'ontime' | 'grace' | 'early',
): { inTiming: InTiming; outTiming: OutTiming } => {
  if (punch.checkOutAt && !(inT === 'ontime' && outT === 'ontime')) {
    const workedMin = (punch.checkOutAt.getTime() - punch.checkInAt.getTime()) / 60_000;
    if (workedMin >= sched.endMin - sched.startMin) {
      return { inTiming: 'compensated', outTiming: 'compensated' };
    }
  }
  return { inTiming: inT, outTiming: outT };
};

const workedHours = (row: AttendanceRow): number | null =>
  row.checkOutAt
    ? Math.round(
        ((row.checkOutAt.getTime() - row.checkInAt.getTime()) / 3_600_000) * 10,
      ) / 10
    : null;

interface ClassifierData {
  holidays: Map<string, string>; // date -> name
  punches: Map<string, AttendanceRow>; // `${employeeId}:${date}` -> row
  leaves: Array<{
    employeeId: string;
    type: string;
    startDate: string;
    endDate: string;
    dayPart: string;
  }>;
  wfh: Array<{ employeeId: string; startDate: string; endDate: string }>;
  schedules: Map<string, Schedule>; // employeeId -> base-zone workday
  fallback: Schedule; // attendance.workHours — no zone hours of their own
  workWeek: WorkWeek; // attendance.workWeek
  hourRules: {
    halfDayBelowHours: number;
    shortDayBelowHours: number;
    effectiveFrom: string;
  };
}

const inRange = (date: string, start: string, end: string) =>
  date >= start && date <= end;

/**
 * Resolve one employee-month into classified days (precedence: holiday →
 * weekend → leave → wfh → punch → absent) + summary counts. Absence is always
 * derived: a past working day with no punch and no leave. Nothing is stored.
 * A leaver's days after their last working day — and a joiner's days
 * before their joining date — are never absence: payroll treats them as not
 * employed, not as missing.
 */
const classifyMonth = (
  employeeId: string,
  month: string,
  data: ClassifierData,
  lastDay: string | null = null,
  firstDay: string | null = null,
): { days: AttendanceDayDto[]; summary: AttendanceSummaryDto } => {
  const { from, to } = monthRange(month);
  const today = localDate();
  const summary: AttendanceSummaryDto = {
    present: 0,
    absent: 0,
    leave: 0,
    wfh: 0,
    holiday: 0,
    weekend: 0,
    lateIns: 0,
    earlyOuts: 0,
  };
  const days: AttendanceDayDto[] = [];

  for (let t = Date.parse(from); ; t += DAY_MS) {
    const date = utcDate(t);
    if (date > to) break;

    const punch = data.punches.get(`${employeeId}:${date}`);
    const onWfh = data.wfh.some(
      (w) => w.employeeId === employeeId && inRange(date, w.startDate, w.endDate),
    );

    const fullLeave = data.leaves.some(
      (l) =>
        l.employeeId === employeeId &&
        l.dayPart === 'full' &&
        inRange(date, l.startDate, l.endDate),
    );
    const sched = data.schedules.get(employeeId) ?? data.fallback;
    // A full-leave day is inert — no punctuality dots even if a historical
    // punch row exists (punching on such days is blocked going forward).
    let inTiming: InTiming | null = null;
    let outTiming: OutTiming | null = null;
    if (punch && !fullLeave) {
      const compensated = applyCompensation(
        punch,
        sched,
        checkInTiming(punch.checkInAt, sched),
        punch.checkOutAt ? checkOutTiming(punch.checkOutAt, sched) : 'ontime',
      );
      inTiming = compensated.inTiming;
      outTiming = punch.checkOutAt ? compensated.outTiming : null;
    }
    const base: Omit<AttendanceDayDto, 'status'> = {
      date,
      checkInAt: punch?.checkInAt.toISOString() ?? null,
      checkOutAt: punch?.checkOutAt?.toISOString() ?? null,
      source: punch?.source ?? null,
      workedHours: punch ? workedHours(punch) : null,
      holidayName: data.holidays.get(date) ?? null,
      leaveType: null,
      checkInTiming: inTiming,
      checkOutTiming: outTiming,
    };
    const holidayName = data.holidays.get(date);
    const leave = data.leaves.find(
      (l) => l.employeeId === employeeId && inRange(date, l.startDate, l.endDate),
    );

    let status: AttendanceDayDto['status'];
    if (holidayName) {
      status = 'holiday';
      summary.holiday += 1;
    } else if (isWeekendDay(date, data.workWeek)) {
      // Sundays + the work week's off Saturdays: a punch is recorded but earns
      // nothing — no hour rules, no punctuality, no worked-hours tracking.
      status = 'weekend';
      summary.weekend += 1;
    } else if (leave) {
      status = leave.dayPart === 'full' ? 'leave' : 'half_leave';
      base.leaveType = leave.type;
      summary.leave += leave.dayPart === 'full' ? 1 : 0.5;
      if (leave.dayPart !== 'full') {
        if (punch) summary.present += 0.5;
        // The non-leave half of a past day with no punch is ABSENCE — it must
        // reach payroll LOP like any other absence (review finding M2).
        else if (date < today) summary.absent += 0.5;
      }
    } else if (onWfh) {
      status = 'wfh';
      summary.wfh += 1;
    } else if (punch) {
      if (!punch.checkOutAt && date < today) {
        // Forgot to check out: auto-closed at midnight as HALF-DAY (user
        // decision) until an approved regularization writes the real times.
        // The absent half flows into payroll LOP automatically.
        status = 'half_day';
        summary.present += 0.5;
        summary.absent += 0.5;
      } else if (
        punch.checkOutAt &&
        date >= data.hourRules.effectiveFrom &&
        (punch.checkOutAt.getTime() - punch.checkInAt.getTime()) / 3_600_000 <
          data.hourRules.halfDayBelowHours
      ) {
        // HOUR RULE (refinement plan, Phase 2): too short to count as a day —
        // a half day, the other half flowing into payroll LOP.
        status = 'half_day';
        summary.present += 0.5;
        summary.absent += 0.5;
      } else {
        status = 'present';
        summary.present += 1;
      }
    } else if (
      date < today &&
      !(lastDay && date > lastDay) &&
      !(firstDay && date < firstDay)
    ) {
      status = 'absent';
      summary.absent += 1;
    } else {
      status = 'none';
    }

    // Punctuality counts only against a scheduled working day actually
    // worked — a voluntary punch on a weekend/holiday/WFH day must not feed
    // the late-in/early-out totals (or the RM streak insight built on them).
    if (status === 'present' || status === 'half_day' || status === 'half_leave') {
      if (inTiming === 'grace' || inTiming === 'late') summary.lateIns += 1;
      if (outTiming === 'grace' || outTiming === 'early') summary.earlyOuts += 1;
    }

    // Off days keep the punch times but track no worked hours.
    days.push({
      ...base,
      status,
      ...(status === 'weekend' || status === 'holiday' ? { workedHours: null } : {}),
    });
  }

  return { days, summary };
};

const toReg = (row: Joined<RegularizationRow>): RegularizationDto => ({
  id: row.id,
  employee: {
    id: row.employeeId,
    name: row.employeeName,
    employeeCode: row.employeeCode,
  },
  date: row.date,
  proposedIn: row.proposedIn.toISOString(),
  proposedOut: row.proposedOut.toISOString(),
  reason: row.reason,
  status: row.status,
  decidedBy: row.decidedBy,
  decisionReason: row.decisionReason,
  createdAt: row.createdAt.toISOString(),
});

const toWfh = (row: Joined<WfhRow>): WfhRequestDto => ({
  id: row.id,
  employee: {
    id: row.employeeId,
    name: row.employeeName,
    employeeCode: row.employeeCode,
  },
  type: row.type,
  startDate: row.startDate,
  endDate: row.endDate,
  reason: row.reason,
  status: row.status,
  rmApprovedBy: row.rmApprovedBy,
  hrApprovedBy: row.hrApprovedBy,
  // Filled by withWfhApproverNames — kept null on paths that skip decoration.
  rmApprovedByName: null,
  hrApprovedByName: null,
  decidedBy: row.decidedBy,
  decisionReason: row.decisionReason,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Attendance rules: web punches behind the geo policy (inside an office zone,
 * or an approved remote request for the day — otherwise 403 OUT_OF_OFFICE_RANGE),
 * computed day classification, RM-only approval for regularizations and WFH.
 * The RM is a relationship (leave_approver ?? reports_to) resolved here, like
 * the leaves feature; when the subject has no RM, hrbp.attendance holders
 * stand in so nobody is unapprovable.
 */
export const createAttendanceService = (deps: {
  repo: AttendanceRepository;
  authz: AuthzRepository;
  settings: SettingsReader;
}) => {
  const { repo, authz, settings } = deps;
  const selfGoverned = createSelfGovernance(authz);

  // --- punches --------------------------------------------------------------

  /** The administration account (Owner-linked) has no attendance of its own. */
  const rejectSystemAccount = async (employeeId: string): Promise<void> => {
    if (await repo.isSystemAccount(employeeId)) {
      throw createError(403, 'The administration account does not track attendance', {
        code: 'SYSTEM_ACCOUNT',
      });
    }
  };

  /** An approved remote-work request covering the date lifts the geo block. */
  const hasApprovedRemote = async (employeeId: string, date: string): Promise<boolean> =>
    (await repo.listApprovedWfh([employeeId], date, date)).length > 0;

  /** Resolve where this punch may happen, or throw the policy error. */
  const resolvePunchSource = async (
    employeeId: string,
    date: string,
    ip: string | undefined,
    coords: { lat: number; lng: number } | null,
  ): Promise<'office' | 'remote'> => {
    if (await hasApprovedRemote(employeeId, date)) return 'remote';
    const stored = await repo.listZones();
    const zones: Zone[] = stored.length
      ? stored.map((z) => ({
          name: z.name,
          lat: Number(z.lat),
          lng: Number(z.lng),
          radiusM: z.radiusM,
        }))
      : envZone();
    if (isInsideAnyZone(coords, ip, zones)) return 'office';
    if (!coords) {
      throw createError(
        403,
        'Location unavailable — enable it, or submit a remote-work request for today',
        { code: 'OUT_OF_OFFICE_RANGE' },
      );
    }
    // Say how far off the punch was, so a wrong zone point or a poor laptop
    // fix is obvious from the message itself (test-pass fix, 2026-10-22).
    const near = nearestZone(coords, zones);
    throw createError(
      403,
      near
        ? `You are ${formatDistance(near.distanceM)} from ${near.zone.name} (allowed ${near.zone.radiusM} m) — move closer, or submit a remote-work request for today`
        : 'You are outside every office zone — submit a remote-work request for today',
      {
        code: 'OUT_OF_OFFICE_RANGE',
        ...(near
          ? {
              nearest: {
                name: near.zone.name,
                distanceM: Math.round(near.distanceM),
                radiusM: near.zone.radiusM,
              },
            }
          : {}),
      },
    );
  };

  const checkIn = async (
    employeeId: string,
    ip: string | undefined,
    coords: { lat: number; lng: number } | null,
  ) => {
    await rejectSystemAccount(employeeId);
    const today = localDate();
    if (await repo.findPunch(employeeId, today)) {
      throw createError(409, 'Already checked in today', { code: 'ALREADY_CHECKED_IN' });
    }
    // A full-day approved leave makes the day inert (user decision) — no
    // punching in; the balance was spent, the day stays leave. Half days keep
    // punching (0.5 leave + 0.5 present). Check-OUT is never blocked, so a
    // leave approved mid-day cannot strand an open punch.
    const todaysLeaves = await repo.listApprovedLeaves([employeeId], today, today);
    if (todaysLeaves.some((l) => l.dayPart === 'full')) {
      throw createError(409, 'You are on approved leave today', {
        code: 'ON_APPROVED_LEAVE',
      });
    }
    const source = await resolvePunchSource(employeeId, today, ip, coords);
    try {
      const row = await repo.insertPunch({
        employeeId,
        date: today,
        checkInAt: new Date(),
        source,
        checkInIp: ip ? normalizeIp(ip) : null,
        checkInLat: coords ? String(coords.lat) : null,
        checkInLng: coords ? String(coords.lng) : null,
      });
      return {
        date: row.date,
        checkInAt: row.checkInAt.toISOString(),
        source: row.source,
      };
    } catch (err) {
      // The findPunch guard above races a concurrent check-in (double-click,
      // second tab) — the unique (employee_id, date) index is the arbiter.
      const code = err as { code?: string; cause?: { code?: string } };
      if (code.code === '23505' || code.cause?.code === '23505') {
        throw createError(409, 'Already checked in today', {
          code: 'ALREADY_CHECKED_IN',
        });
      }
      throw err;
    }
  };

  const checkOut = async (
    employeeId: string,
    ip: string | undefined,
    coords: { lat: number; lng: number } | null,
  ) => {
    const today = localDate();
    const punch = await repo.findPunch(employeeId, today);
    if (!punch) {
      throw createError(409, 'You have not checked in today', { code: 'NOT_CHECKED_IN' });
    }
    if (punch.checkOutAt) {
      throw createError(409, 'Already checked out today', {
        code: 'ALREADY_CHECKED_OUT',
      });
    }
    // Check-OUT is NEVER geo-blocked or geo-judged (user decision): presence
    // was proven at check-in; the out-punch just records time + coordinates.
    const row = (await repo.setPunchOut(
      punch.id,
      new Date(),
      ip ? normalizeIp(ip) : null,
      coords,
    ))!;
    // SHORT DAY (refinement plan, Phase 2): a working day closed under the
    // short-day limit stays a full day, but the person and their manager hear
    // about it. Off days and half-day-short days (already LOP) don't notify.
    const worked = workedHours(row) ?? 0;
    const [policy, holidays, me] = await Promise.all([
      settings.effectiveMany(['attendance.workWeek', 'attendance.hourRules'] as const),
      repo.listHolidays(today, today),
      repo.findEmployeeApprovers(employeeId),
    ]);
    const rules = policy['attendance.hourRules'];
    const workingDay =
      holidays.length === 0 && !isWeekendDay(today, policy['attendance.workWeek']);
    if (
      workingDay &&
      today >= rules.effectiveFrom &&
      worked >= rules.halfDayBelowHours &&
      worked < rules.shortDayBelowHours
    ) {
      const rm = me?.leaveApprover ?? me?.reportsTo ?? null;
      const ownerId = await authz.ownerId();
      const hrs = `${worked.toFixed(1)} h`;
      await repo.notify([employeeId, ...(rm && rm !== ownerId ? [rm] : [])], {
        type: 'attendance.short_day',
        title: `Short day: ${me?.name ?? 'someone'} worked ${hrs} on ${today}`,
        body: `Under the ${rules.shortDayBelowHours} h day. It still counts as a full day.`,
        link: '/attendance',
      });
    }
    return {
      date: row.date,
      checkInAt: row.checkInAt.toISOString(),
      checkOutAt: row.checkOutAt!.toISOString(),
      workedHours: workedHours(row),
    };
  };

  // --- views ----------------------------------------------------------------

  const loadClassifierData = async (
    employeeIds: string[],
    month: string,
  ): Promise<ClassifierData> => {
    const { from, to } = monthRange(month);
    const [holidayRows, punchRows, leaves, wfh, schedRows, policy] = await Promise.all([
      repo.listHolidays(from, to),
      repo.listPunches(employeeIds, from, to),
      repo.listApprovedLeaves(employeeIds, from, to),
      repo.listApprovedWfh(employeeIds, from, to),
      repo.listSchedules(employeeIds),
      settings.effectiveMany([
        'attendance.workHours',
        'attendance.workWeek',
        'attendance.hourRules',
      ] as const),
    ]);
    const fallback = scheduleFrom(policy['attendance.workHours']);
    return {
      holidays: new Map(holidayRows.map((h) => [h.date, h.name])),
      punches: new Map(punchRows.map((p) => [`${p.employeeId}:${p.date}`, p])),
      leaves,
      wfh,
      schedules: new Map(
        schedRows.map((r) => [
          r.employeeId,
          r.workStart && r.workEnd
            ? {
                startMin: parseHm(r.workStart),
                endMin: parseHm(r.workEnd),
                graceMin: fallback.graceMin,
              }
            : fallback,
        ]),
      ),
      fallback,
      workWeek: policy['attendance.workWeek'],
      hourRules: policy['attendance.hourRules'],
    };
  };

  const myMonth = async (employeeId: string, month: string): Promise<MyAttendanceDto> => {
    const [data, joined] = await Promise.all([
      loadClassifierData([employeeId], month),
      repo.joiningDates([employeeId]),
    ]);
    // Days before the joining date are not absences here either (close-out).
    const { days, summary } = classifyMonth(
      employeeId,
      month,
      data,
      null,
      joined.get(employeeId) ?? null,
    );

    const today = localDate();
    let todayState: MyAttendanceDto['today'] = null;
    if (today.startsWith(month)) {
      const punch = data.punches.get(`${employeeId}:${today}`);
      const sched = data.schedules.get(employeeId) ?? data.fallback;
      let inT: InTiming | null = null;
      let outT: OutTiming | null = null;
      if (punch) {
        const compensated = applyCompensation(
          punch,
          sched,
          checkInTiming(punch.checkInAt, sched),
          punch.checkOutAt ? checkOutTiming(punch.checkOutAt, sched) : 'ontime',
        );
        inT = compensated.inTiming;
        outT = punch.checkOutAt ? compensated.outTiming : null;
      }
      todayState = {
        date: today,
        checkedIn: Boolean(punch),
        checkedOut: Boolean(punch?.checkOutAt),
        checkInAt: punch?.checkInAt.toISOString() ?? null,
        checkOutAt: punch?.checkOutAt?.toISOString() ?? null,
        source: punch?.source ?? null,
        checkInTiming: inT,
        checkOutTiming: outT,
      };
    }
    return { month, days, summary, today: todayState };
  };

  /** Classified month views; `lastDays` stops leavers' absence at their last day. */
  const monthFor = async (
    people: Array<{ id: string; name: string; employeeCode: string }>,
    month: string,
    lastDays: Map<string, string> = new Map(),
  ): Promise<EmployeeAttendanceDto[]> => {
    const [data, joined] = await Promise.all([
      loadClassifierData(
        people.map((p) => p.id),
        month,
      ),
      repo.joiningDates(people.map((p) => p.id)),
    ]);
    return people.map((p) => {
      const { days, summary } = classifyMonth(
        p.id,
        month,
        data,
        lastDays.get(p.id) ?? null,
        joined.get(p.id) ?? null,
      );
      return { employee: p, days, summary };
    });
  };

  const teamMonth = async (rmId: string, month: string) => {
    const views = await monthFor(await repo.listReports(rmId), month);
    // Menstrual leave is CONFIDENTIAL (leave policy §9.2): the RM's calendar
    // shows a generic leave day, never the type. HR surfaces stay unmasked.
    return views.map((v) => ({
      ...v,
      days: v.days.map((d) =>
        d.leaveType === 'menstrual' ? { ...d, leaveType: null } : d,
      ),
    }));
  };

  const orgMonth = async (
    month: string,
    zoneId: string | null = null,
    departmentId: string | null = null,
  ) => monthFor(await repo.listActiveEmployees(zoneId, departmentId), month);

  /**
   * Department month export — PR and HRBP only (user decision). Two module
   * keys may open one door, so the gate lives here, not in requireAccess.
   */
  const exportMonthCsv = async (
    callerId: string,
    month: string,
    departmentId: string | null,
    zoneId: string | null,
  ): Promise<string> => {
    const [hr, pr] = await Promise.all([
      authz.resolveAccess(callerId, 'hrbp.attendance', 'read'),
      authz.resolveAccess(callerId, 'pr.payroll', 'read'),
    ]);
    // The export covers whoever the caller's grant reaches (Phase 3): an org
    // payroll grant or org HR grant is everyone, a dept HR grant their
    // department, a team grant their tree. A grant that reaches nobody but
    // the caller does not export (review finding M4).
    const reach = hasOrgScope(pr)
      ? ({ all: true } as const)
      : await authz.reachable(callerId, hr);
    if (!reach.all && reach.ids.size <= 1) {
      throw createError(403, 'Exporting attendance needs HR or Payroll access', {
        code: 'EXPORT_FORBIDDEN',
      });
    }

    const people = (await repo.listActiveWithDepartment(departmentId, zoneId)).filter((p) =>
      reachesIn(reach, p.id),
    );
    const data = await loadClassifierData(
      people.map((p) => p.id),
      month,
    );
    // Quote-escape + neutralize formula injection: a value starting with
    // = + - @ would execute as a formula when the CSV opens in a spreadsheet.
    const esc = (v: string) =>
      `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replaceAll('"', '""')}"`;
    const lines = [
      'Employee code,Name,Department,Working days,Present,Half days,Absent,Leave,Remote,Late ins,Early outs',
    ];
    for (const p of people) {
      const { days, summary } = classifyMonth(p.id, month, data);
      const workingDays = days.length - summary.weekend - summary.holiday;
      const halfDays = days.filter((d) => d.status === 'half_day').length;
      lines.push(
        [
          esc(p.employeeCode),
          esc(p.name),
          esc(p.department ?? '—'),
          workingDays,
          summary.present,
          halfDays,
          summary.absent,
          summary.leave,
          summary.wfh,
          summary.lateIns,
          summary.earlyOuts,
        ].join(','),
      );
    }
    return lines.join('\r\n');
  };

  // --- holidays -------------------------------------------------------------

  const listHolidays = async (year: number) =>
    (await repo.listHolidays(`${year}-01-01`, `${year}-12-31`)).map((h) => ({
      id: h.id,
      date: h.date,
      name: h.name,
    }));

  const addHoliday = async (input: CreateHolidayInput, actor: ActorContext) => {
    try {
      const row = await repo.insertHoliday(input, actor);
      return { id: row.id, date: row.date, name: row.name };
    } catch (err) {
      if (
        (err as { code?: string; cause?: { code?: string } }).code === '23505' ||
        (err as { cause?: { code?: string } }).cause?.code === '23505'
      ) {
        throw createError(409, 'A holiday already exists on this date', {
          code: 'DUPLICATE_HOLIDAY',
        });
      }
      throw err;
    }
  };

  const removeHoliday = async (id: string, actor: ActorContext): Promise<void> => {
    const row = await repo.findHoliday(id);
    if (!row) throw createError(404, 'Holiday not found', { code: 'HOLIDAY_NOT_FOUND' });
    await repo.deleteHoliday(row, actor);
  };

  // --- punch zones (Admin = Owner/SuperAdmin bypass only) --------------------

  /** Zone management is Admin-only (user decision): the access BYPASS, not a grant. */
  const requireAdmin = async (callerId: string): Promise<void> => {
    const access = await authz.resolveAccess(callerId, 'hrbp.attendance', 'update');
    if (!access.bypass) {
      throw createError(403, 'Only the Owner or a SuperAdmin can manage punch zones', {
        code: 'ADMIN_ONLY',
      });
    }
  };

  const toZone = (row: {
    id: string;
    name: string;
    lat: string;
    lng: string;
    radiusM: number;
    workStart: string | null;
    workEnd: string | null;
  }) => ({
    id: row.id,
    name: row.name,
    lat: Number(row.lat),
    lng: Number(row.lng),
    radiusM: row.radiusM,
    workStart: row.workStart,
    workEnd: row.workEnd,
  });

  // Readable by anyone signed in: the invite/create forms pick base locations
  // from it, and coordinates of company sites are not sensitive. Mutations
  // stay Admin-only.
  const listZones = async (): Promise<PunchZoneDto[]> =>
    (await repo.listZones()).map(toZone);

  const addZone = async (
    input: CreateZoneInput,
    actor: ActorContext,
  ): Promise<PunchZoneDto> => {
    await requireAdmin(actor.actorEmployeeId);
    try {
      const row = await repo.insertZone(
        {
          name: input.name,
          lat: String(input.lat),
          lng: String(input.lng),
          radiusM: input.radiusM,
          workStart: input.workStart ?? null,
          workEnd: input.workEnd ?? null,
        },
        actor,
      );
      return toZone(row);
    } catch (err) {
      const code = err as { code?: string; cause?: { code?: string } };
      if (code.code === '23505' || code.cause?.code === '23505') {
        throw createError(409, 'A zone with this name already exists', {
          code: 'DUPLICATE_ZONE',
        });
      }
      throw err;
    }
  };

  const removeZone = async (id: string, actor: ActorContext): Promise<void> => {
    await requireAdmin(actor.actorEmployeeId);
    const row = await repo.findZone(id);
    if (!row) throw createError(404, 'Zone not found', { code: 'ZONE_NOT_FOUND' });
    await repo.deleteZone(row, actor);
  };

  /**
   * HR marks a missed day directly (user decision): "worked 27, marked 26" —
   * the row lands as `regularized`, and a single-day approved leave on that
   * date is revoked with its balance refunded.
   */
  const hrMark = async (input: HrMarkInput, actor: ActorContext) => {
    await rejectSystemAccount(input.employeeId);
    if (input.date > localDate()) {
      throw createError(422, 'Only past or current days can be marked', {
        code: 'FUTURE_DATE',
      });
    }
    if (!(await repo.findEmployeeApprovers(input.employeeId))) {
      throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
    }
    try {
      const row = await repo.hrMarkAttendance(
        {
          employeeId: input.employeeId,
          date: input.date,
          checkInAt: new Date(input.checkInAt),
          checkOutAt: new Date(input.checkOutAt),
        },
        actor,
      );
      return {
        date: row.date,
        checkInAt: row.checkInAt.toISOString(),
        checkOutAt: row.checkOutAt!.toISOString(),
        source: row.source,
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'MULTI_DAY_LEAVE') {
        throw createError(
          409,
          'This date is inside a multi-day approved leave — adjust the leave first',
          { code: 'MULTI_DAY_LEAVE' },
        );
      }
      if (code === 'REFUND_FAILED') {
        throw createError(409, 'Could not refund the attached leave balance', {
          code: 'REFUND_FAILED',
        });
      }
      throw err;
    }
  };

  // --- shared decision guard (RM-only, like the leaves RM slot) -------------

  const ensureApprover = async (
    subjectEmployeeId: string,
    callerId: string,
  ): Promise<void> => {
    if (subjectEmployeeId === callerId) {
      throw createError(403, 'You cannot decide your own request', {
        code: 'NO_SELF_APPROVAL',
      });
    }
    const subject = await repo.findEmployeeApprovers(subjectEmployeeId);
    // A named leave approver JOINS the chain alongside the RM (user decision).
    if (callerId === subject?.leaveApprover || callerId === subject?.reportsTo) return;
    if (!subject?.leaveApprover && !subject?.reportsTo) {
      // No RM (the Owner's reports chain root): hrbp.attendance stands in —
      // a grant that reaches this person (review finding M4, Phase 3).
      if (await authz.reaches(callerId, 'hrbp.attendance', 'update', subjectEmployeeId)) return;
    }
    throw createError(403, 'You are not the approver for this request', {
      code: 'NOT_AN_APPROVER',
    });
  };

  const requirePending = (status: string): void => {
    if (status !== 'pending') {
      throw createError(409, 'This request has already been decided', {
        code: 'ALREADY_DECIDED',
      });
    }
  };

  // --- regularizations ------------------------------------------------------

  const raiseRegularization = async (
    employeeId: string,
    input: CreateRegularizationInput,
    actor: ActorContext,
  ): Promise<RegularizationDto> => {
    await rejectSystemAccount(employeeId);
    const today = localDate();
    if (input.date > today) {
      throw createError(422, 'Only past or current days can be regularized', {
        code: 'FUTURE_DATE',
      });
    }
    // How far back a punch can be corrected — keeps history trustworthy.
    const windowDays = REGULARIZE_WINDOW_DAYS;
    const floor = localDate(new Date(Date.now() - windowDays * DAY_MS));
    if (input.date < floor) {
      throw createError(422, `Only the last ${windowDays} days can be regularized`, {
        code: 'TOO_OLD',
      });
    }
    if (await repo.findPendingRegularizationForDate(employeeId, input.date)) {
      throw createError(409, 'A pending regularization already exists for this date', {
        code: 'DUPLICATE_REGULARIZATION',
      });
    }
    const me = await repo.findEmployeeApprovers(employeeId);
    const values = {
      employeeId,
      date: input.date,
      proposedIn: new Date(input.proposedIn),
      proposedOut: new Date(input.proposedOut),
      reason: input.reason ?? null,
    };
    // SELF-GOVERNED (nobody above them): approved as raised, punch written.
    const row = (await selfGoverned(me))
      ? await repo.insertRegularizationSelfApproved(values, actor)
      : await repo.insertRegularization(values);
    return toReg({
      ...row,
      employeeName: me?.name ?? '',
      employeeCode: me?.employeeCode ?? '',
    });
  };

  const myRegularizations = async (employeeId: string) =>
    (await repo.listRegularizationsByEmployee(employeeId)).map(toReg);

  const teamRegularizations = async (rmId: string) =>
    (await repo.listRegularizationsForRm(rmId)).map(toReg);

  /** DECISION_CONFLICT (someone decided/cancelled first) → retryable 409. */
  const mapDecisionConflict = (err: unknown): never => {
    if ((err as { code?: string }).code === 'DECISION_CONFLICT') {
      throw createError(
        409,
        'This request was just updated by someone else — refresh and retry',
        {
          code: 'DECISION_CONFLICT',
        },
      );
    }
    throw err;
  };

  const decideRegularization = async (
    id: string,
    input: DecideInput,
    actor: ActorContext,
  ): Promise<RegularizationDto> => {
    const row = await repo.findRegularization(id);
    if (!row)
      throw createError(404, 'Regularization not found', { code: 'REG_NOT_FOUND' });
    requirePending(row.status);
    await ensureApprover(row.employeeId, actor.actorEmployeeId);

    const approve = input.decision === 'approve';
    const updated = await repo
      .applyRegularizationDecision(
        row,
        {
          status: approve ? 'approved' : 'declined',
          decidedBy: actor.actorEmployeeId,
          decisionReason: input.reason ?? null,
          decidedAt: new Date(),
        },
        approve,
        {
          action: approve
            ? 'attendance.regularized'
            : 'attendance.regularization_declined',
          detail: { date: row.date },
        },
        actor,
      )
      .catch(mapDecisionConflict);
    const emp = await repo.findEmployeeApprovers(row.employeeId);
    return toReg({
      ...updated,
      employeeName: emp?.name ?? '',
      employeeCode: emp?.employeeCode ?? '',
    });
  };

  const cancelRegularization = async (id: string, actor: ActorContext) => {
    const row = await repo.findRegularization(id);
    if (!row)
      throw createError(404, 'Regularization not found', { code: 'REG_NOT_FOUND' });
    if (row.employeeId !== actor.actorEmployeeId) {
      throw createError(403, 'You can only cancel your own request', {
        code: 'NOT_YOUR_REQUEST',
      });
    }
    const updated = await repo.cancelRegularization(id, actor.actorEmployeeId);
    if (!updated) {
      throw createError(409, 'This request has already been decided', {
        code: 'ALREADY_DECIDED',
      });
    }
    const emp = await repo.findEmployeeApprovers(row.employeeId);
    return toReg({
      ...updated,
      employeeName: emp?.name ?? '',
      employeeCode: emp?.employeeCode ?? '',
    });
  };

  // --- WFH ------------------------------------------------------------------

  const raiseWfh = async (
    employeeId: string,
    input: CreateWfhInput,
    actor: ActorContext,
  ): Promise<WfhRequestDto> => {
    await rejectSystemAccount(employeeId);
    const me = await repo.findEmployeeApprovers(employeeId);
    const values = {
      employeeId,
      type: 'remote' as const,
      startDate: input.startDate,
      endDate: input.endDate,
      reason: input.reason,
    };
    // SELF-GOVERNED (nobody above them): approved as raised, both slots moot.
    const row = (await selfGoverned(me))
      ? await repo.insertWfhSelfApproved(values, actor)
      : await repo.insertWfh(values);
    return toWfh({
      ...row,
      employeeName: me?.name ?? '',
      employeeCode: me?.employeeCode ?? '',
    });
  };

  /** Resolve the names behind the filled approval slots (queues show WHO). */
  const withWfhApproverNames = async (
    dtos: WfhRequestDto[],
  ): Promise<WfhRequestDto[]> => {
    const ids = [
      ...new Set(
        dtos
          .flatMap((d) => [d.rmApprovedBy, d.hrApprovedBy])
          .filter((v): v is string => v !== null),
      ),
    ];
    if (ids.length === 0) return dtos;
    const names = await repo.namesByIds(ids);
    return dtos.map((d) => ({
      ...d,
      rmApprovedByName: d.rmApprovedBy ? (names.get(d.rmApprovedBy) ?? null) : null,
      hrApprovedByName: d.hrApprovedBy ? (names.get(d.hrApprovedBy) ?? null) : null,
    }));
  };

  const myWfh = async (employeeId: string) =>
    withWfhApproverNames((await repo.listWfhByEmployee(employeeId)).map(toWfh));

  const teamWfh = async (rmId: string) =>
    withWfhApproverNames((await repo.listWfhForRm(rmId)).map(toWfh));

  /** The HR inbox for remote requests (route gated on hrbp.attendance read). */
  const wfhQueue = async () =>
    withWfhApproverNames((await repo.listWfhPendingAll()).map(toWfh));

  const WFH_LIVE: ReadonlyArray<WfhRow['status']> = ['pending', 'partially_approved'];

  /**
   * DUAL approval (user decision), mirroring leaves: the effective RM fills
   * the RM slot; any `hrbp.attendance update` holder fills the HR slot; one in
   * is partially_approved, both in is approved; either declining ends it. Only
   * `approved` lifts the punch geo-block or classifies days.
   */
  const decideWfh = async (
    id: string,
    input: DecideInput,
    actor: ActorContext,
  ): Promise<WfhRequestDto> => {
    const caller = actor.actorEmployeeId;
    const row = await repo.findWfh(id);
    if (!row)
      throw createError(404, 'Remote request not found', { code: 'WFH_NOT_FOUND' });
    if (!WFH_LIVE.includes(row.status)) {
      throw createError(409, 'This request has already been decided', {
        code: 'ALREADY_DECIDED',
      });
    }
    if (row.employeeId === caller) {
      throw createError(403, 'You cannot decide your own request', {
        code: 'NO_SELF_APPROVAL',
      });
    }

    const target = await repo.findEmployeeApprovers(row.employeeId);
    // A named leave approver JOINS the chain alongside the RM (user decision).
    const holdsRmSlot = caller === target?.leaveApprover || caller === target?.reportsTo;
    // The HR slot: a hrbp.attendance grant that REACHES this person (M4,
    // Phase 3 — a dept grant decides for its department only).
    const holdsHrSlot = await authz.reaches(caller, 'hrbp.attendance', 'update', row.employeeId);
    if (!holdsRmSlot && !holdsHrSlot) {
      throw createError(403, 'You are not an approver for this request', {
        code: 'NOT_AN_APPROVER',
      });
    }

    if (input.decision === 'decline') {
      const updated = await repo
        .applyWfhDecision(
          id,
          {
            status: 'declined',
            decidedBy: caller,
            decisionReason: input.reason ?? null,
            decidedAt: new Date(),
          },
          {
            action: 'remote.declined',
            detail: { startDate: row.startDate, endDate: row.endDate },
          },
          actor,
          {
            status: row.status,
            rmApprovedBy: row.rmApprovedBy,
            hrApprovedBy: row.hrApprovedBy,
          },
        )
        .catch(mapDecisionConflict);
      const emp = await repo.findEmployeeApprovers(row.employeeId);
      return (
        await withWfhApproverNames([
          toWfh({
            ...updated,
            employeeName: emp?.name ?? '',
            employeeCode: emp?.employeeCode ?? '',
          }),
        ])
      )[0]!;
    }

    const now = new Date();
    const fillsRm = holdsRmSlot && !row.rmApprovedBy;
    const fillsHr = holdsHrSlot && !row.hrApprovedBy;
    if (!fillsRm && !fillsHr) {
      throw createError(409, 'You have already approved this request', {
        code: 'SLOT_ALREADY_DECIDED',
      });
    }
    // No stored waiver: the RM slot is satisfied live — a target with no
    // RM and no leave approver (shouldn't happen for real people) needs HR alone.
    const noRmExists = !target?.leaveApprover && !target?.reportsTo;
    const rmSatisfied = noRmExists || Boolean(row.rmApprovedBy) || fillsRm;
    const hrSatisfied = Boolean(row.hrApprovedBy) || fillsHr;
    const final = rmSatisfied && hrSatisfied;
    const slots = [...(fillsRm ? ['rm'] : []), ...(fillsHr ? ['hr'] : [])];

    const updated = await repo
      .applyWfhDecision(
        id,
        {
          ...(fillsRm ? { rmApprovedBy: caller, rmApprovedAt: now } : {}),
          ...(fillsHr ? { hrApprovedBy: caller, hrApprovedAt: now } : {}),
          status: final ? 'approved' : 'partially_approved',
        },
        {
          action: 'remote.approved',
          detail: { startDate: row.startDate, endDate: row.endDate, slots, final },
        },
        actor,
        {
          status: row.status,
          rmApprovedBy: row.rmApprovedBy,
          hrApprovedBy: row.hrApprovedBy,
        },
      )
      .catch(mapDecisionConflict);
    const emp = await repo.findEmployeeApprovers(row.employeeId);
    return (
      await withWfhApproverNames([
        toWfh({
          ...updated,
          employeeName: emp?.name ?? '',
          employeeCode: emp?.employeeCode ?? '',
        }),
      ])
    )[0]!;
  };

  const cancelWfh = async (id: string, actor: ActorContext) => {
    const row = await repo.findWfh(id);
    if (!row) throw createError(404, 'WFH request not found', { code: 'WFH_NOT_FOUND' });
    if (row.employeeId !== actor.actorEmployeeId) {
      throw createError(403, 'You can only cancel your own request', {
        code: 'NOT_YOUR_REQUEST',
      });
    }
    const updated = await repo.cancelWfh(id, actor.actorEmployeeId);
    if (!updated) {
      throw createError(409, 'This request has already been decided', {
        code: 'ALREADY_DECIDED',
      });
    }
    const emp = await repo.findEmployeeApprovers(row.employeeId);
    return (
      await withWfhApproverNames([
        toWfh({
          ...updated,
          employeeName: emp?.name ?? '',
          employeeCode: emp?.employeeCode ?? '',
        }),
      ])
    )[0]!;
  };

  /**
   * MONTH-END policy (user decision), mirroring leaves: a remote request still
   * `partially_approved` when the month is processed counts as approved, so
   * its days classify as remote instead of absent. Runs from payroll
   * generation/regeneration for the run month.
   */
  /**
   * Finalize's guard (M7): every remote partial TOUCHING the month, not just
   * what the sweep would approve — a month-spanning partial escapes the
   * sweep, so it must block finalize for a human decision instead of its
   * days silently classifying as absent.
   */
  const pendingRemoteMonthEndPartials = async (month: string): Promise<number> => {
    const { from, to } = monthRange(month);
    return (await repo.listPartiallyApprovedWfhOverlapping(from, to)).length;
  };

  const autoApproveRemoteMonthEnd = async (
    month: string,
    actor: ActorContext,
  ): Promise<{ approved: number }> => {
    const { from, to } = monthRange(month);
    let approved = 0;
    for (const row of await repo.listPartiallyApprovedWfhWithin(from, to)) {
      try {
        await repo.applyWfhDecision(
          row.id,
          { status: 'approved', decisionReason: 'auto-approved at month end' },
          {
            action: 'remote.auto_approved',
            detail: { startDate: row.startDate, endDate: row.endDate, month },
          },
          actor,
          {
            status: row.status,
            rmApprovedBy: row.rmApprovedBy,
            hrApprovedBy: row.hrApprovedBy,
          },
        );
        approved += 1;
      } catch (err) {
        // A concurrent decision wins over the sweep; skip, never abort the run.
        if ((err as { code?: string }).code !== 'DECISION_CONFLICT') throw err;
      }
    }
    return { approved };
  };

  return {
    checkIn,
    checkOut,
    myMonth,
    teamMonth,
    orgMonth,
    // Payroll: an explicit people list (active, in notice, and leavers).
    peopleMonth: monthFor,
    listZones,
    addZone,
    removeZone,
    hrMark,
    exportMonthCsv,
    listHolidays,
    addHoliday,
    removeHoliday,
    raiseRegularization,
    myRegularizations,
    teamRegularizations,
    decideRegularization,
    cancelRegularization,
    raiseWfh,
    myWfh,
    teamWfh,
    wfhQueue,
    decideWfh,
    cancelWfh,
    autoApproveRemoteMonthEnd,
    pendingRemoteMonthEndPartials,
  };
};

export type AttendanceService = ReturnType<typeof createAttendanceService>;
