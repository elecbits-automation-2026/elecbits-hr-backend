import createError from 'http-errors';
import { BAND_LADDER, LEVELS, type Level } from '../../shared/constants/constants.js';
import { addMonthsIso } from '../../shared/helpers/helpers.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import { attainmentOf, quarterOf } from '../performance/index.js';
import type { SettingsReader } from '../settings/index.js';
import type {
  ActorContext,
  CareerRepository,
  CareerTrackRow,
  LevelChangeRow,
  TrackNoteRow,
} from './career.repository.js';
import type {
  AddTrackNoteInput,
  BandDto,
  CareerTrackDto,
  CloseTrackInput,
  LevelChangeDto,
  MyCareerDto,
  OpenTrackInput,
  PersonCareerDto,
  TeamCareerRowDto,
  TrackNoteDto,
} from './career.schema.js';

const DAY_MS = 86_400_000;

const LADDER: BandDto[] = LEVELS.map((code) => ({ code, ...BAND_LADDER[code] }));

const toTrack = (row: CareerTrackRow, openedByName: string | null): CareerTrackDto => ({
  id: row.id,
  employeeId: row.employeeId,
  bandCode: row.bandCode,
  targetBand: row.targetBand,
  note: row.note,
  openedByName,
  status: row.status,
  closeReason: row.closeReason,
  closedAt: row.closedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

const toChange = (row: LevelChangeRow, names: Map<string, string>): LevelChangeDto => ({
  from: row.fromLevel,
  to: row.toLevel,
  at: row.createdAt.toISOString(),
  byName: row.changedBy ? (names.get(row.changedBy) ?? null) : null,
  trackId: row.trackId,
});

const toNote = (row: TrackNoteRow, names: Map<string, string>): TrackNoteDto => ({
  id: row.id,
  body: row.body,
  authorName: names.get(row.authorId) ?? null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Career rules (adopted from the hr-tool review, tightened in Phase 2.5):
 *  - the ladder's wording is a constant (BAND_LADDER); the band itself is
 *    employees.level, so a promotion is an HR level edit — which writes the
 *    promotion-history row and closes a track it fulfils as met;
 *  - a track is an OPEN CONVERSATION toward the band DIRECTLY above — one per
 *    person (partial unique index is the arbiter); the employee may request
 *    their own once they meet the career.selfRequest minimums, the RM or
 *    broad HR opens (no minimums), writes notes on and closes it; the
 *    employee reads the notes and never closes their own;
 *  - evidence is derived from the record (punches, recognitions, notes, goal
 *    attainment) — nothing on the card can be typed into.
 */
export const createCareerService = (deps: {
  repo: CareerRepository;
  authz: AuthzRepository;
  settings: SettingsReader;
}) => {
  const { repo, authz, settings } = deps;

  /** The effective RM, or HR whose grant reaches them — who runs a roadmap. */
  const requireRmOrHr = async (
    actorId: string,
    target: { id: string; leaveApprover: string | null; reportsTo: string | null } | undefined,
    message: string,
  ): Promise<void> => {
    const effectiveRm = target ? (target.leaveApprover ?? target.reportsTo) : null;
    const hr =
      target !== undefined && (await authz.reaches(actorId, 'hrbp.people', 'update', target.id));
    if (actorId !== effectiveRm && !hr) {
      throw createError(403, message, { code: 'NOT_AN_APPROVER' });
    }
  };

  const trackWithName = async (
    row: CareerTrackRow | undefined,
  ): Promise<CareerTrackDto | null> => {
    if (!row) return null;
    const names = await repo.namesByIds([row.openedBy]);
    return toTrack(row, names.get(row.openedBy) ?? null);
  };

  /** History + the open track's notes, names resolved in one read. */
  const historyAndNotes = async (
    employeeId: string,
    track: CareerTrackRow | undefined,
  ) => {
    const [changes, notes] = await Promise.all([
      repo.levelChanges(employeeId),
      track ? repo.listNotes(track.id) : Promise.resolve([] as TrackNoteRow[]),
    ]);
    const names = await repo.namesByIds([
      ...changes.flatMap((c) => (c.changedBy ? [c.changedBy] : [])),
      ...notes.map((n) => n.authorId),
    ]);
    return {
      history: changes.map((c) => toChange(c, names)),
      notes: notes.map((n) => toNote(n, names)),
      lastChangeAt: changes.at(-1)?.createdAt ?? null,
    };
  };

  const attainmentIn = async (employeeId: string, cycleName: string) =>
    attainmentOf(await repo.goalsInCycle(employeeId, cycleName));

  /**
   * The career.selfRequest minimums, as plain-language blockers. Tenure in
   * band runs from the last level change, else the joining date (no date at
   * all = not checked — HR has to fill the record in, not the employee).
   */
  const selfRequestCheck = async (
    me: { id: string; level: Level; dateOfJoining: string | null },
    lastChangeAt: Date | null,
    hasOpenTrack: boolean,
  ): Promise<MyCareerDto['selfRequest']> => {
    const rules = await settings.effective('career.selfRequest');
    const today = new Date();
    const thisQuarter = quarterOf(today);
    const lastQuarter = quarterOf(new Date(Date.parse(thisQuarter.startDate) - DAY_MS));
    const [lastAttainment, lastClosed] = await Promise.all([
      attainmentIn(me.id, lastQuarter.name),
      repo.lastClosedTrack(me.id),
    ]);
    const inBandSince = lastChangeAt?.toISOString().slice(0, 10) ?? me.dateOfJoining;
    const blockers: string[] = [];

    if (!BAND_LADDER[me.level].next) blockers.push('You are at the top of the ladder.');
    if (hasOpenTrack) blockers.push('A conversation is already open.');
    if (inBandSince && rules.minMonthsInBand > 0) {
      const eligibleOn = addMonthsIso(inBandSince, rules.minMonthsInBand);
      if (eligibleOn > today.toISOString().slice(0, 10)) {
        blockers.push(
          `${rules.minMonthsInBand} months in your current band are needed — you can ask from ${eligibleOn}.`,
        );
      }
    }
    // No goals last quarter = nothing to judge, not a failure: missing goals
    // are the RM's to set, and must not lock the employee out.
    if (
      rules.minAttainment !== null &&
      lastAttainment !== null &&
      lastAttainment < rules.minAttainment
    ) {
      blockers.push(
        `${lastQuarter.name} goal attainment was ${lastAttainment}% — ${rules.minAttainment}% is needed.`,
      );
    }
    if (lastClosed?.closedAt && rules.cooldownDays > 0) {
      const until = new Date(lastClosed.closedAt.getTime() + rules.cooldownDays * DAY_MS);
      if (until > today) {
        blockers.push(
          `Your last conversation closed recently — you can ask again from ${until.toISOString().slice(0, 10)}.`,
        );
      }
    }
    return {
      allowed: blockers.length === 0,
      blockers,
      inBandSince: inBandSince ?? null,
      lastQuarter: { name: lastQuarter.name, attainment: lastAttainment },
    };
  };

  const mine = async (actor: ActorContext): Promise<MyCareerDto> => {
    const me = await repo.findEmployee(actor.actorEmployeeId);
    if (!me)
      throw createError(404, 'Employee record not found', { code: 'EMPLOYEE_NOT_FOUND' });
    const from = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
    const quarter = quarterOf();
    const [punchedDays30, recog, appreciationNotes, track, attainment] =
      await Promise.all([
        repo.punchedDaysSince(me.id, from),
        repo.approvedRecognitionsFor([me.id]),
        repo.appreciationNotesCount(me.id),
        repo.findOpenTrack(me.id),
        attainmentIn(me.id, quarter.name),
      ]);
    const { history, notes, lastChangeAt } = await historyAndNotes(me.id, track);
    return {
      ladder: LADDER,
      current: me.level,
      next: BAND_LADDER[me.level].next,
      evidence: {
        punchedDays30,
        recognitions: recog.get(me.id)?.count ?? 0,
        appreciationNotes,
        quarter: { name: quarter.name, attainment },
      },
      track: await trackWithName(track),
      notes,
      history,
      selfRequest: await selfRequestCheck(me, lastChangeAt, Boolean(track)),
    };
  };

  const openTrack = async (
    input: { employeeId: string; targetBand?: Level; note?: string },
    actor: ActorContext,
  ): Promise<CareerTrackDto> => {
    const target = await repo.findEmployee(input.employeeId);
    if (!target || target.status === 'inactive') {
      throw createError(404, 'Employee record not found', { code: 'EMPLOYEE_NOT_FOUND' });
    }
    const next = BAND_LADDER[target.level].next;
    if (!next) {
      throw createError(422, 'There is no band above this one', {
        code: 'TOP_OF_LADDER',
      });
    }
    // One step at a time: a roadmap is about the band directly above.
    if (input.targetBand && input.targetBand !== next) {
      throw createError(422, `A roadmap can only aim at the next band (${next})`, {
        code: 'TARGET_TOO_FAR',
      });
    }
    try {
      const row = await repo.insertTrack(
        {
          employeeId: target.id,
          bandCode: target.level,
          targetBand: next,
          note: input.note ?? null,
        },
        actor,
      );
      return (await trackWithName(row))!;
    } catch (err) {
      const code = err as { code?: string; cause?: { code?: string } };
      if (code.code === '23505' || code.cause?.code === '23505') {
        throw createError(409, 'A conversation is already open for this person', {
          code: 'TRACK_EXISTS',
        });
      }
      throw err;
    }
  };

  /** The employee asks for the conversation themselves — minimums apply. */
  const request = async (actor: ActorContext): Promise<CareerTrackDto> => {
    const me = await repo.findEmployee(actor.actorEmployeeId);
    if (!me)
      throw createError(404, 'Employee record not found', { code: 'EMPLOYEE_NOT_FOUND' });
    const [track, changes] = await Promise.all([
      repo.findOpenTrack(me.id),
      repo.levelChanges(me.id),
    ]);
    const check = await selfRequestCheck(
      me,
      changes.at(-1)?.createdAt ?? null,
      Boolean(track),
    );
    if (track) {
      throw createError(409, 'A conversation is already open for this person', {
        code: 'TRACK_EXISTS',
      });
    }
    if (!check.allowed) {
      throw createError(422, check.blockers.join(' '), {
        code: 'SELF_REQUEST_NOT_MET',
        blockers: check.blockers,
      });
    }
    return openTrack({ employeeId: me.id, note: 'Requested by the employee' }, actor);
  };

  /** RM-or-HR opens a track for one of their people — never for themselves. */
  const openForReport = async (
    input: OpenTrackInput,
    actor: ActorContext,
  ): Promise<CareerTrackDto> => {
    if (input.employeeId === actor.actorEmployeeId) {
      throw createError(403, 'Use the request button for your own roadmap', {
        code: 'SELF_TRACK',
      });
    }
    const target = await repo.findEmployee(input.employeeId);
    await requireRmOrHr(
      actor.actorEmployeeId,
      target,
      "Only this person's RM or HR opens their roadmap",
    );
    return openTrack(input, actor);
  };

  const closeTrack = async (
    id: string,
    input: CloseTrackInput,
    actor: ActorContext,
  ): Promise<CareerTrackDto> => {
    const row = await repo.findTrackById(id);
    if (!row) throw createError(404, 'Track not found', { code: 'TRACK_NOT_FOUND' });
    if (row.status !== 'open') {
      throw createError(409, 'This conversation is already closed', {
        code: 'ALREADY_CLOSED',
      });
    }
    if (row.employeeId === actor.actorEmployeeId) {
      throw createError(
        403,
        'The conversation is closed by your manager or HR, not by you',
        {
          code: 'SELF_CLOSE',
        },
      );
    }
    const target = await repo.findEmployee(row.employeeId);
    await requireRmOrHr(
      actor.actorEmployeeId,
      target,
      "Only this person's RM or HR closes their roadmap",
    );
    const updated = await repo.closeTrack(
      id,
      { status: input.outcome, closeReason: input.reason ?? null },
      actor,
    );
    if (!updated) {
      throw createError(409, 'This conversation is already closed', {
        code: 'ALREADY_CLOSED',
      });
    }
    return (await trackWithName(updated))!;
  };

  /** RM-or-HR adds to the conversation; the employee is notified, never writes. */
  const addNote = async (
    trackId: string,
    input: AddTrackNoteInput,
    actor: ActorContext,
  ): Promise<TrackNoteDto> => {
    const row = await repo.findTrackById(trackId);
    if (!row) throw createError(404, 'Track not found', { code: 'TRACK_NOT_FOUND' });
    if (row.employeeId === actor.actorEmployeeId) {
      throw createError(403, 'Notes on your roadmap are written by your manager or HR', {
        code: 'SELF_NOTE',
      });
    }
    const target = await repo.findEmployee(row.employeeId);
    await requireRmOrHr(
      actor.actorEmployeeId,
      target,
      "Only this person's RM or HR writes on their roadmap",
    );
    if (row.status !== 'open') {
      throw createError(409, 'This conversation is closed', { code: 'ALREADY_CLOSED' });
    }
    const note = await repo.insertNote(
      { trackId, employeeId: row.employeeId, body: input.body },
      actor,
    );
    const names = await repo.namesByIds([note.authorId]);
    return toNote(note, names);
  };

  /** One person's career for their RM or HR — the person sheet's Growth block. */
  const person = async (
    employeeId: string,
    actor: ActorContext,
  ): Promise<PersonCareerDto> => {
    const target = await repo.findEmployee(employeeId);
    if (!target || target.status === 'inactive') {
      throw createError(404, 'Employee record not found', { code: 'EMPLOYEE_NOT_FOUND' });
    }
    if (employeeId !== actor.actorEmployeeId) {
      await requireRmOrHr(
        actor.actorEmployeeId,
        target,
        "Only this person's RM or HR can see their roadmap",
      );
    }
    const track = await repo.findOpenTrack(employeeId);
    const { history, notes } = await historyAndNotes(employeeId, track);
    return {
      current: target.level,
      next: BAND_LADDER[target.level].next,
      track: await trackWithName(track),
      notes,
      history,
    };
  };

  /** The RM's growth view: chain grouped by band + "due a conversation". */
  const team = async (actor: ActorContext): Promise<TeamCareerRowDto[]> => {
    const chain = await repo.listChain(actor.actorEmployeeId);
    const ids = chain.map((p) => p.id);
    const [recog, tracks] = await Promise.all([
      repo.approvedRecognitionsFor(ids),
      repo.openTracksFor(ids),
    ]);
    return Promise.all(
      chain.map(async (p) => ({
        employee: { id: p.id, name: p.name, employeeCode: p.employeeCode },
        level: p.level,
        recognitions: recog.get(p.id)?.count ?? 0,
        lastRecognizedAt: recog.get(p.id)?.lastAt?.toISOString() ?? null,
        track: await trackWithName(tracks.get(p.id)),
      })),
    );
  };

  return { mine, request, openForReport, closeTrack, addNote, person, team };
};

export type CareerService = ReturnType<typeof createCareerService>;
