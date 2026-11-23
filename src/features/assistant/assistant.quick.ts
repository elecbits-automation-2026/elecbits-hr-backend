/**
 * The offline buttons (phase 2): when the model can't be reached, the three
 * questions people ask every morning still answer — each runs ONE whitelisted
 * read tool directly and the result is written out as plain text here. Which
 * tool runs depends on what the caller is allowed (the org view first for HR,
 * else their own team).
 */

export const QUICK_QUESTIONS = ['out', 'updates', 'cases'] as const;
export type QuickQuestion = (typeof QUICK_QUESTIONS)[number];

/** Candidate tools per question, in order of preference. */
export const QUICK_TOOLS: Record<QuickQuestion, string[]> = {
  out: ['org_who_is_out', 'team_who_is_out'],
  updates: ['org_missing_updates', 'team_missing_updates'],
  cases: ['concern_queue_counts'],
};

export const QUICK_LABEL: Record<QuickQuestion, string> = {
  out: "Who's out today",
  updates: "Who hasn't sent a work update",
  cases: 'Open cases',
};

type Rows<T> = { total: number; rows: T[]; note?: string };

interface TodayPicture {
  date: string;
  dayType: string;
  holiday?: string;
  checkedIn:
    Rows<{ name: string; remote: boolean }> | Array<{ name: string; remote: boolean }>;
  away:
    | Rows<{ name: string; status: string; leaveType: string | null }>
    | Array<{ name: string; status: string; leaveType: string | null }>;
  notCheckedInYet: Rows<string> | string[];
}

const rowsOf = <T>(v: Rows<T> | T[]): { rows: T[]; total: number; more: string } =>
  Array.isArray(v)
    ? { rows: v, total: v.length, more: '' }
    : {
        rows: v.rows,
        total: v.total,
        more: v.total > v.rows.length ? ` (first ${v.rows.length} shown)` : '',
      };

const STATUS: Record<string, string> = {
  leave: 'on leave',
  half_leave: 'half-day leave',
  absent: 'absent',
  wfh: 'working remotely',
};

const UPDATE: Record<string, string> = {
  missed: 'missed',
  late_pending: 'sent late, waiting for approval',
  today: 'not sent yet today',
};

const whoIsOut = (p: TodayPicture): string => {
  const head =
    p.dayType === 'holiday'
      ? `${p.date} — a holiday${p.holiday ? ` (${p.holiday})` : ''}.`
      : p.dayType === 'weekend'
        ? `${p.date} — a weekend.`
        : `${p.date} — a working day.`;
  const away = rowsOf(p.away);
  const inn = rowsOf(p.checkedIn);
  const notYet = rowsOf(p.notCheckedInYet);
  const lines = [head];
  lines.push(
    away.total
      ? `Away (${away.total})${away.more}:\n${away.rows
          .map(
            (r) =>
              `- ${r.name} — ${STATUS[r.status] ?? r.status}${r.leaveType && r.leaveType !== 'leave' ? ` (${r.leaveType})` : ''}`,
          )
          .join('\n')}`
      : 'Nobody is marked away.',
  );
  if (inn.total) {
    lines.push(
      `Checked in (${inn.total})${inn.more}:\n${inn.rows
        .map((r) => `- ${r.name}${r.remote ? ' — remote' : ''}`)
        .join('\n')}`,
    );
  }
  if (notYet.total) {
    lines.push(
      `Not checked in yet (${notYet.total})${notYet.more}: ${notYet.rows.join(', ')}`,
    );
  }
  return lines.join('\n\n');
};

const missingUpdates = (
  r: { date: string } & Rows<{
    name: string;
    update: string;
    department?: string | null;
  }>,
): string =>
  r.total === 0
    ? `${r.date}: everyone has sent their work update.`
    : `${r.date}: ${r.total} without a work update${r.total > r.rows.length ? ` (first ${r.rows.length} shown)` : ''}.\n${r.rows
        .map(
          (x) =>
            `- ${x.name}${x.department ? ` (${x.department})` : ''} — ${UPDATE[x.update] ?? x.update}`,
        )
        .join('\n')}`;

const caseCounts = (
  queues: Array<{ queue: string; open: number; overdue: number; unassigned: number }>,
): string =>
  queues.length === 0
    ? 'You do not handle any concern queues.'
    : queues
        .map(
          (q) =>
            `${q.queue}: ${q.open} open, ${q.overdue} overdue, ${q.unassigned} unassigned`,
        )
        .join('\n');

/** The tool's JSON → the plain text the drawer shows. */
export const quickText = (toolName: string, result: unknown): string => {
  switch (toolName) {
    case 'org_who_is_out':
      return whoIsOut(result as TodayPicture);
    case 'team_who_is_out':
      return whoIsOut((result as { today: TodayPicture }).today);
    case 'org_missing_updates':
    case 'team_missing_updates':
      return missingUpdates(result as Parameters<typeof missingUpdates>[0]);
    case 'concern_queue_counts':
      return caseCounts(result as Parameters<typeof caseCounts>[0]);
    default:
      return JSON.stringify(result);
  }
};
