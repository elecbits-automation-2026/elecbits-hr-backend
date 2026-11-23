import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { reachesIn } from '../access/authz.repository.js';
import {
  HIRING_PRIORITIES,
  ROUNDS,
  createRequisitionSchema,
} from '../hiring/hiring.schema.js';
import { createGoalSchema } from '../performance/performance.schema.js';
import { createRecognitionSchema } from '../recognitions/recognitions.schema.js';
import { TRAINING_STREAMS, assignTrainingSchema } from '../trainings/trainings.schema.js';
import type { ActionablePerson } from './assistant.repository.js';
import {
  isEither,
  matchPeople,
  today,
  tool,
  type AnyTool,
  type Caller,
} from './assistant.tools.js';

/**
 * The HR Assistant's action tools (phase 2). A tool call here WRITES NOTHING:
 * it checks the inputs, resolves names to ids among the people the caller
 * could act on in the app, validates the payload with the existing
 * endpoint's own Zod schema, and hands back a PROPOSAL. The drawer shows it
 * as a card; Confirm calls the existing REST endpoint with the user's own
 * session, so the write path and every access check are the app's own.
 * `draft_note` is the same idea for text: shown as a card, never stored.
 */

export type ProposalAction =
  'add_goal' | 'assign_training' | 'nominate' | 'raise_opening';

/** A card the drawer renders next to the answer (an SSE event as-is). */
export type AssistantCard =
  | {
      type: 'proposal';
      id: string;
      action: ProposalAction;
      title: string;
      /** Human-readable summary, one fact per line. */
      lines: string[];
      /** The existing endpoint Confirm calls, e.g. "POST /api/v1/goals". */
      endpoint: string;
      /** Exactly the body that endpoint takes (validated with its schema). */
      payload: Record<string, unknown>;
      /** Where the result shows up in the app. */
      link: string;
      linkLabel: string;
    }
  | { type: 'note'; id: string; title: string; kind: string; content: string };

/** What an action tool returns: a card for the drawer, a message for the model. */
export interface CardResult {
  card: AssistantCard;
  forModel: unknown;
}

export const isCardResult = (x: unknown): x is CardResult =>
  typeof x === 'object' && x !== null && 'card' in x && 'forModel' in x;

/** The model is told plainly that nothing happened yet. */
const PROPOSED =
  'NOT saved yet. It is shown to the user as a card with Confirm and Cancel. Tell them you have set it up and they should confirm it below. Never say it is done, added, assigned, nominated or raised.';

const propose = (
  action: ProposalAction,
  title: string,
  lines: string[],
  endpoint: string,
  payload: Record<string, unknown>,
  link: string,
  linkLabel: string,
): CardResult => ({
  card: {
    type: 'proposal',
    id: randomUUID(),
    action,
    title,
    lines,
    endpoint,
    // JSON round trip: optional keys left undefined drop out (the schemas are strict).
    payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
    link,
    linkLabel,
  },
  forModel: { proposed: title, summary: lines, status: PROPOSED },
});

/** A refusal the model relays (nothing is shown as a card). */
const notProposed = (reason: string, extra: Record<string, unknown> = {}) => ({
  notProposed: reason,
  ...extra,
});

const issues = (err: z.ZodError) => err.issues.map((i) => i.message).join('; ');

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

const labelOf = (p: { name: string; department?: string | null }) =>
  p.department ? `${p.name} (${p.department})` : p.name;

/**
 * One typed name → one person in the pool, or a reason. Never picks between
 * two matches: acting on the wrong person's record is worse than a question.
 */
const resolveIn = <T extends { name: string; department?: string | null }>(
  pool: T[],
  typed: string,
): { person: T } | { error: string; matches?: string[] } => {
  const found = matchPeople(pool, typed);
  if (found.length === 0) {
    return { error: `No one called "${typed}" whom you can do this for` };
  }
  const exact = found.filter((p) => p.name.toLowerCase() === typed.trim().toLowerCase());
  if (exact.length === 1) return { person: exact[0]! };
  if (found.length > 1) {
    return {
      error: `"${typed}" matches more than one person — ask the user which one; do not choose`,
      matches: found.slice(0, 8).map(labelOf),
    };
  }
  return { person: found[0]! };
};

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('YYYY-MM-DD');

/** May the caller set goals / assign trainings for this person? (hrbp.people update reach) */
const hrWrites = (c: Caller, p: ActionablePerson) =>
  c.hrPeopleWrite !== null && reachesIn(c.hrPeopleWrite, p.id);

/** The trainings page's first guess at a stream from the title (keyword tagging). */
const guessStream = (title: string): (typeof TRAINING_STREAMS)[number] => {
  const t = title.toLowerCase();
  if (
    /posh|safety|compliance|esd|fire|policy|code of conduct|data protection|security/.test(
      t,
    )
  ) {
    return 'compliance';
  }
  if (/lead|manag|communicat|present|negotiat|mentor|coach|feedback/.test(t))
    return 'leadership';
  if (/onboard|elecbits|product|process|induction|company|culture|tool/.test(t))
    return 'company';
  return 'functional';
};

const STREAM_LABEL: Record<(typeof TRAINING_STREAMS)[number], string> = {
  compliance: 'Compliance',
  leadership: 'Leadership & professional',
  company: 'Company knowledge',
  functional: 'Functional & technical',
};

const ROUND_LABEL: Record<(typeof ROUNDS)[number], string> = {
  hr: 'Screening (HR)',
  technical: 'Technical',
  practical: 'Practical',
  managerial: 'Managerial',
  hr_final: 'HR final',
};

const EMPLOYMENT_TYPES = ['Full-time', 'Internship', 'Contract', 'Part-time'] as const;

export const ACTION_TOOLS: AnyTool[] = [
  tool({
    name: 'add_goal',
    label: 'Goal proposal',
    description:
      "PROPOSE a goal for one person in this quarter (it is not saved: the user confirms it on a card). Only for the caller's own reports or people within their HR access, never the caller themself. The result shows the person's current weight total so you can say whether weights still add to 100.",
    input: z.object({
      person: z.string().trim().min(2).max(80).describe('a name; partial is fine'),
      title: z
        .string()
        .trim()
        .min(3)
        .max(200)
        .describe('the goal in one line, written as an outcome'),
      category: z
        .enum(['fundamental', 'corporate', 'general'])
        .optional()
        .describe('defaults to fundamental'),
      metric: z.string().trim().max(200).optional().describe('what is measured'),
      target: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe('the number or state that counts as met'),
      weight: z.number().min(0.5).max(100).describe('weight in percent'),
      dueOn: isoDate.optional().describe("YYYY-MM-DD; defaults to the quarter's end"),
    }),
    allowed: (c) => c.manager || c.hrPeopleWrite !== null,
    run: async (c, input, s) => {
      const pool = (await s.actionablePeople(c.employeeId)).filter(
        (p) => p.effectiveRm || hrWrites(c, p),
      );
      const r = resolveIn(pool, input.person);
      if ('error' in r)
        return notProposed(r.error, r.matches ? { matches: r.matches } : {});
      const p = r.person;
      // The same RM-or-HR gate (hrbp.people update) createGoal runs; throws if not.
      const sheet = await s.performance.teamMemberGoals(p.id, {
        actorUserId: c.userId,
        actorEmployeeId: c.employeeId,
      });
      const parsed = createGoalSchema.safeParse({
        employeeId: p.id,
        title: input.title,
        category: input.category,
        metric: input.metric,
        target: input.target,
        weight: input.weight,
        dueOn: input.dueOn,
      });
      if (!parsed.success) return notProposed(issues(parsed.error));
      if (
        input.dueOn &&
        (input.dueOn < sheet.cycle.startDate || input.dueOn > sheet.cycle.endDate)
      ) {
        return notProposed(
          `The due date must fall inside ${sheet.cycle.name} (${sheet.cycle.startDate} to ${sheet.cycle.endDate})`,
        );
      }
      const after = Math.round((sheet.weightTotal + input.weight) * 10) / 10;
      return propose(
        'add_goal',
        `New goal for ${p.name}`,
        [
          `For: ${labelOf(p)}`,
          `Goal: ${input.title}`,
          `Category: ${input.category ?? 'fundamental'}`,
          ...(input.metric ? [`Measure: ${input.metric}`] : []),
          ...(input.target ? [`Target: ${input.target}`] : []),
          `Weight: ${input.weight}% (their goals then total ${after}%)`,
          `Due: ${fmtDate(input.dueOn ?? sheet.cycle.endDate)} · ${sheet.cycle.name}`,
        ],
        'POST /api/v1/goals',
        parsed.data,
        p.effectiveRm ? '/performance' : '/hr/people',
        p.effectiveRm ? 'Performance' : 'People',
      );
    },
  }),

  tool({
    name: 'assign_training',
    label: 'Training proposal',
    description:
      'PROPOSE assigning a training to one or more people (not saved: the user confirms it on a card). Managers: their own reports; HR: anyone within their HR access. Never the caller themself. Someone who already has an open training with the same title is skipped on confirm.',
    input: z.object({
      people: z
        .array(z.string().trim().min(2).max(80))
        .min(1)
        .max(20)
        .describe('names; partial is fine'),
      title: z.string().trim().min(3).max(120).describe('what they are to learn'),
      stream: z
        .enum(TRAINING_STREAMS)
        .optional()
        .describe(
          'compliance | leadership | company | functional; guessed from the title if left out',
        ),
      description: z.string().trim().max(1000).optional(),
      link: z
        .string()
        .trim()
        .url()
        .max(500)
        .optional()
        .describe('a course or resource URL'),
      dueOn: isoDate.optional(),
    }),
    allowed: (c) => c.manager || c.hrPeopleWrite !== null,
    run: async (c, input, s) => {
      if (input.dueOn && input.dueOn < today()) {
        return notProposed('The due date has already passed');
      }
      const pool = (await s.actionablePeople(c.employeeId)).filter(
        (p) => !p.isOwner && (p.team || hrWrites(c, p)),
      );
      const chosen: ActionablePerson[] = [];
      for (const typed of input.people) {
        const r = resolveIn(pool, typed);
        if ('error' in r)
          return notProposed(r.error, r.matches ? { matches: r.matches } : {});
        if (!chosen.some((x) => x.id === r.person.id)) chosen.push(r.person);
      }
      const stream = input.stream ?? guessStream(input.title);
      const parsed = assignTrainingSchema.safeParse({
        employeeIds: chosen.map((p) => p.id),
        title: input.title,
        stream,
        description: input.description,
        link: input.link,
        dueOn: input.dueOn,
      });
      if (!parsed.success) return notProposed(issues(parsed.error));
      const allTeam = chosen.every((p) => p.team);
      return propose(
        'assign_training',
        chosen.length === 1
          ? `Training for ${chosen[0]!.name}`
          : `Training for ${chosen.length} people`,
        [
          `For: ${chosen.map(labelOf).join(', ')}`,
          `Training: ${input.title}`,
          `Stream: ${STREAM_LABEL[stream]}`,
          ...(input.description ? [`Details: ${input.description}`] : []),
          ...(input.link ? [`Link: ${input.link}`] : []),
          `Due: ${input.dueOn ? fmtDate(input.dueOn) : 'no due date'}`,
        ],
        'POST /api/v1/trainings',
        parsed.data,
        allTeam ? '/growth?tab=trainings' : '/hr/trainings',
        'Trainings',
      );
    },
  }),

  tool({
    name: 'nominate',
    label: 'Nomination proposal',
    description:
      "PROPOSE an R&R nomination in the caller's name (not saved: the user confirms it on a card). Managers nominate their own reports; org-wide HR also the top people who have no manager. A team award may name several people. The citation must say what the person actually did, in the user's own words — never invent one; if the user hasn't said, ask.",
    input: z.object({
      people: z
        .array(z.string().trim().min(2).max(80))
        .min(1)
        .max(25)
        .describe('who is being recognised; names, partial is fine'),
      award: z.string().trim().min(2).max(60).describe("the award's name or key"),
      citation: z
        .string()
        .trim()
        .max(500)
        .describe(
          'what they did, specific enough that a stranger would understand why it mattered',
        ),
    }),
    allowed: (c) => c.manager || c.hrPeopleWriteOrg,
    run: async (c, input, s) => {
      const actor = { actorUserId: c.userId, actorEmployeeId: c.employeeId };
      const [directory, catalog] = await Promise.all([
        s.recognitions.directory(actor),
        s.recognitions.awardCatalog(),
      ]);
      const want = input.award.toLowerCase();
      const award =
        catalog.find((a) => a.key === want || a.name.toLowerCase() === want) ??
        catalog.find((a) => a.name.toLowerCase().includes(want));
      if (!award) {
        return notProposed('That award is not in the catalog — ask which one', {
          awards: catalog.map((a) => `${a.name}${a.team ? ' (team award)' : ''}`),
        });
      }
      const chosen: Array<{ id: string; name: string }> = [];
      for (const typed of input.people) {
        const r = resolveIn(directory, typed);
        if ('error' in r)
          return notProposed(r.error, r.matches ? { matches: r.matches } : {});
        if (!chosen.some((x) => x.id === r.person.id)) chosen.push(r.person);
      }
      if (!award.team && chosen.length !== 1) {
        return notProposed(`${award.name} goes to one person`);
      }
      const parsed = createRecognitionSchema.safeParse({
        employeeIds: chosen.map((p) => p.id),
        type: award.key,
        citation: input.citation,
      });
      if (!parsed.success) {
        return notProposed(
          `${issues(parsed.error)}. Ask the user what the person actually did; do not write it for them`,
        );
      }
      return propose(
        'nominate',
        `Nominate ${chosen.length === 1 ? chosen[0]!.name : `${chosen.length} people`} for ${award.name}`,
        [
          `For: ${chosen.map((p) => p.name).join(', ')}`,
          `Award: ${award.name}`,
          `Citation: ${input.citation}`,
          'Nominated in your name; HR gives the final approval.',
        ],
        'POST /api/v1/recognitions',
        parsed.data,
        '/recognition',
        'Recognition',
      );
    },
  }),

  tool({
    name: 'raise_opening',
    label: 'Hiring line proposal',
    description:
      "Department heads only: PROPOSE a new line in their department's hiring plan for the quarter being planned (not saved: the user confirms it on a card; it is then a DRAFT they submit from the Hiring plan page). Needs the reason, target joining date and location from the user — ask if they haven't said; never invent them.",
    input: z.object({
      department: z
        .string()
        .trim()
        .max(80)
        .optional()
        .describe('which of their departments; may be left out if they head one'),
      roleTitle: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .describe('the role as it will be advertised'),
      quantity: z.number().int().min(1).max(50).default(1).describe('how many heads'),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe('why the hire is needed (backfill, new project, growth…)'),
      targetJoiningOn: isoDate.describe('target joining date, YYYY-MM-DD'),
      location: z.string().trim().min(1).max(120),
      reportingManager: z
        .string()
        .trim()
        .max(80)
        .optional()
        .describe('who the hire reports to; leave out for the caller'),
      priority: z.enum(HIRING_PRIORITIES).default('normal'),
      employmentType: z.enum(EMPLOYMENT_TYPES).default('Full-time'),
      rounds: z
        .array(z.enum(['technical', 'practical', 'managerial', 'hr_final']))
        .max(4)
        .optional()
        .describe('interview rounds after the screening call (always included)'),
      notes: z.string().trim().max(4000).optional(),
    }),
    allowed: (c) => c.deptHead,
    run: async (c, input, s) => {
      const me = await s.hiring.me(c.employeeId);
      if (me.headOf.length === 0) return notProposed('You do not head a department');
      let dept = me.headOf[0]!;
      if (input.department) {
        const want = input.department.toLowerCase();
        const hits = me.headOf.filter((d) =>
          d.departmentName.toLowerCase().includes(want),
        );
        if (hits.length !== 1) {
          return notProposed('Ask which department — these are the ones you head', {
            departments: me.headOf.map((d) => d.departmentName),
          });
        }
        dept = hits[0]!;
      } else if (me.headOf.length > 1) {
        return notProposed('Ask which department — these are the ones you head', {
          departments: me.headOf.map((d) => d.departmentName),
        });
      }
      let manager = { id: c.employeeId, name: 'you' };
      if (input.reportingManager) {
        const pool = (await s.actionablePeople(c.employeeId)).filter(
          (p) => p.status === 'active' && !p.isOwner,
        );
        const r = resolveIn(pool, input.reportingManager);
        if ('error' in r)
          return notProposed(r.error, r.matches ? { matches: r.matches } : {});
        manager = r.person;
      }
      const later = [...new Set(input.rounds ?? [])];
      const rounds = (['hr', ...later] as Array<(typeof ROUNDS)[number]>).map(
        (round) => ({
          round,
          interviewerId: null,
        }),
      );
      const parsed = createRequisitionSchema.safeParse({
        departmentId: dept.departmentId,
        quarter: me.planQuarter,
        roleTitle: input.roleTitle,
        quantity: input.quantity,
        notes: input.notes,
        reason: input.reason,
        targetJoiningOn: input.targetJoiningOn,
        location: input.location,
        reportingManagerId: manager.id,
        priority: input.priority,
        employmentType: input.employmentType,
        rounds,
      });
      if (!parsed.success) return notProposed(issues(parsed.error));
      return propose(
        'raise_opening',
        `Hiring line: ${input.roleTitle} × ${input.quantity}`,
        [
          `Department: ${dept.departmentName} · ${me.planQuarter} plan`,
          `Role: ${input.roleTitle} × ${input.quantity} (${input.employmentType})`,
          `Reason: ${input.reason}`,
          `Target joining: ${fmtDate(input.targetJoiningOn)} · ${input.location}`,
          `Reports to: ${manager.name}`,
          `Priority: ${input.priority}`,
          `Rounds: ${rounds.map((r) => ROUND_LABEL[r.round]).join(', ')} (interviewers are picked on the Hiring plan page)`,
          `Saved as a DRAFT — submit it from Hiring plan before ${fmtDate(me.planDeadline)}.`,
        ],
        'POST /api/v1/hiring/requisitions',
        parsed.data,
        '/hiring/plan',
        'Hiring plan',
      );
    },
  }),

  tool({
    name: 'draft_note',
    label: 'Draft',
    description:
      'Write a draft document and show it to the user as a card they can copy: an offer-note outline, a PIP framing, a policy summary in plain words, or similar. Use this whenever asked to draft, write or frame something, instead of putting the text in your reply. Build it only from facts tool results gave you; leave a [placeholder] for anything you were not given. Never include pay, CTC or salary figures — leave "[compensation — from Payroll]". It is NOT saved anywhere and is not a record.',
    input: z.object({
      title: z.string().trim().min(2).max(120),
      kind: z.enum([
        'offer note',
        'PIP framing',
        'policy summary',
        'review note',
        'other',
      ]),
      content: z
        .string()
        .trim()
        .min(20)
        .max(8000)
        .describe('the whole document in plain text, ready to copy'),
    }),
    allowed: isEither,
    // Chats are not stored: the audit row keeps what kind of note, never its text.
    audit: ({ title, kind }) => ({ title, kind }),
    run: async (_c, input) => ({
      card: {
        type: 'note',
        id: randomUUID(),
        title: input.title,
        kind: input.kind,
        content: input.content,
      },
      forModel: {
        shown:
          'The draft is shown to the user as a card with a Copy button. It is not saved and not a record.',
        instruction:
          'Do not repeat the text. In one or two lines, say what you drafted and what placeholders they need to fill.',
      },
    }),
  }),
];
