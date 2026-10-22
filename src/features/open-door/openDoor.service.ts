import createError from 'http-errors';
import { OPEN_DOOR_HORIZON_DAYS } from '../../shared/constants/constants.js';
import { addDaysIso, localDateOf } from '../../shared/helpers/helpers.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import type {
  ActorContext,
  BookingRow,
  OpenDoorRepository,
  RequestRow,
  SlotRow,
} from './openDoor.repository.js';
import type {
  BookInput,
  CreateRequestInput,
  CreateSlotInput,
  DeclineRequestInput,
  HostDto,
  MarkInput,
  MyBookingDto,
  OfferRequestInput,
  OpenDoorMeDto,
  OwnerSlotDto,
  RequestDto,
  RequestsDto,
  SlotDto,
} from './openDoor.schema.js';

const LINK = '/grievances?tab=open-door';
const REQUESTS_LINK = '/grievances?tab=requests';
const hhmm = (t: string) => t.slice(0, 5);
const nowHhmm = () => new Date().toTimeString().slice(0, 5);

/**
 * What open door needs from concerns for "request a meeting about this
 * case" — injected by the composition root so the dependency stays one-way
 * (open door → concerns), never a cycle.
 */
export interface ConcernMeetings {
  meetingTarget(
    id: string,
    actorId: string,
  ): Promise<{ id: string; code: string; handlers: string[] }>;
  handlersFor(id: string): Promise<string[]>;
  noteMeeting(id: string, body: string, actor: ActorContext): Promise<void>;
}

/**
 * Open door (Batch 4 — a product feature; no policy covers it). HR
 * (hrbp.grievances update) and department heads (level L5–L6, the ladder's
 * "Department Head" and above) publish times they are free to talk; anyone
 * books a seat up to OPEN_DOOR_HORIZON_DAYS ahead, never their own slot.
 * The topic is private to the slot's owner. The owner marks a booking done
 * or no-show once the slot has started; cancelling a slot rings every booker.
 */
export const createOpenDoorService = (deps: {
  repo: OpenDoorRepository;
  authz: AuthzRepository;
  concerns?: ConcernMeetings;
}) => {
  const { repo, authz } = deps;
  const today = () => localDateOf(new Date());
  const concerns = (): ConcernMeetings => {
    if (!deps.concerns) throw new Error('open door built without the concerns port');
    return deps.concerns;
  };

  const canPublish = async (employeeId: string): Promise<boolean> => {
    const me = await repo.findEmployee(employeeId);
    if (me && (me.level === 'L5' || me.level === 'L6')) return true;
    const access = await authz.resolveAccess(employeeId, 'hrbp.grievances', 'update');
    return access.bypass || access.scopes.length > 0;
  };

  const started = (s: SlotRow) =>
    s.date < today() || (s.date === today() && hhmm(s.startTime) <= nowHhmm());

  const toSlot = (
    s: SlotRow,
    names: Map<string, string>,
    bookings: BookingRow[],
    viewerId: string,
  ): SlotDto => {
    const mine = bookings.find(
      (b) => b.slotId === s.id && b.employeeId === viewerId && b.status !== 'cancelled',
    );
    return {
      id: s.id,
      owner: { id: s.ownerId, name: names.get(s.ownerId) ?? '' },
      date: s.date,
      startTime: hhmm(s.startTime),
      endTime: hhmm(s.endTime),
      capacity: s.capacity,
      booked: bookings.filter(
        (b) => b.slotId === s.id && (b.status === 'booked' || b.status === 'done'),
      ).length,
      note: s.note,
      cancelled: s.cancelledAt !== null,
      myBookingId: mine?.id ?? null,
    };
  };

  /** Bookable slots from today to the horizon (own slots excluded). */
  const slots = async (viewerId: string): Promise<SlotDto[]> => {
    const horizon = OPEN_DOOR_HORIZON_DAYS;
    const rows = (await repo.slotsBetween(today(), addDaysIso(today(), horizon))).filter(
      (s) => s.ownerId !== viewerId && !started(s),
    );
    const [names, bookings] = await Promise.all([
      repo.namesByIds([...new Set(rows.map((s) => s.ownerId))]),
      repo.bookingsFor(rows.map((s) => s.id)),
    ]);
    return rows.map((s) => toSlot(s, names, bookings, viewerId));
  };

  const me = async (viewerId: string): Promise<OpenDoorMeDto> => {
    const horizon = OPEN_DOOR_HORIZON_DAYS;
    const [publish, mineRaw, ownRaw] = await Promise.all([
      canPublish(viewerId),
      repo.bookingsOf(viewerId),
      repo.ownerSlots(viewerId, addDaysIso(today(), -14)),
    ]);
    const mySlotIds = [...new Set(mineRaw.map((b) => b.slotId))];
    const mySlots = (await Promise.all(mySlotIds.map((id) => repo.findSlot(id)))).filter(
      (s): s is SlotRow => !!s,
    );
    const allSlots = [...mySlots, ...ownRaw];
    const allBookings = await repo.bookingsFor(allSlots.map((s) => s.id));
    const names = await repo.namesByIds([
      ...new Set([
        ...allSlots.map((s) => s.ownerId),
        ...allBookings.map((b) => b.employeeId),
      ]),
    ]);
    const bookings: MyBookingDto[] = mineRaw
      .map((b) => {
        const s = mySlots.find((x) => x.id === b.slotId)!;
        return {
          id: b.id,
          status: b.status,
          topic: b.topic,
          slot: toSlot(s, names, allBookings, viewerId),
        };
      })
      .sort((a, b) =>
        `${a.slot.date}${a.slot.startTime}`.localeCompare(
          `${b.slot.date}${b.slot.startTime}`,
        ),
      );
    const slotsOut: OwnerSlotDto[] = ownRaw.map((s) => ({
      ...toSlot(s, names, allBookings, viewerId),
      bookings: allBookings
        .filter((b) => b.slotId === s.id)
        .map((b) => ({
          id: b.id,
          employee: { id: b.employeeId, name: names.get(b.employeeId) ?? '' },
          topic: b.topic,
          status: b.status,
        })),
    }));
    return { canPublish: publish, horizonDays: horizon, bookings, slots: slotsOut };
  };

  const createSlot = async (input: CreateSlotInput, actor: ActorContext) => {
    if (!(await canPublish(actor.actorEmployeeId))) {
      throw createError(403, 'Open-door slots are published by HR and department heads', {
        code: 'NOT_A_PUBLISHER',
      });
    }
    if (
      input.date < today() ||
      (input.date === today() && input.startTime <= nowHhmm())
    ) {
      throw createError(422, 'Pick a time in the future', { code: 'PAST_SLOT' });
    }
    await repo.insertSlot(
      {
        ownerId: actor.actorEmployeeId,
        date: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
        capacity: input.capacity ?? 1,
        note: input.note ?? null,
      },
      actor,
    );
    return me(actor.actorEmployeeId);
  };

  const cancelSlot = async (id: string, actor: ActorContext) => {
    const s = await repo.findSlot(id);
    if (!s || s.ownerId !== actor.actorEmployeeId) {
      throw createError(404, 'Slot not found', { code: 'SLOT_NOT_FOUND' });
    }
    if (s.cancelledAt)
      throw createError(409, 'Already cancelled', { code: 'SLOT_CANCELLED' });
    const owner = await repo.findEmployee(s.ownerId);
    await repo.cancelSlot(s, actor, {
      type: 'open_door.cancelled',
      title: `${owner ? `${owner.name}'s` : 'An'} open-door slot on ${s.date} at ${hhmm(s.startTime)} was cancelled — your booking is off`,
      link: LINK,
    });
    return me(actor.actorEmployeeId);
  };

  const book = async (slotId: string, input: BookInput, actor: ActorContext) => {
    const s = await repo.findSlot(slotId);
    if (!s || s.cancelledAt)
      throw createError(404, 'Slot not found', { code: 'SLOT_NOT_FOUND' });
    if (s.ownerId === actor.actorEmployeeId) {
      throw createError(422, 'That is your own slot', { code: 'OWN_SLOT' });
    }
    const horizon = OPEN_DOOR_HORIZON_DAYS;
    if (started(s) || s.date > addDaysIso(today(), horizon)) {
      throw createError(422, 'That slot is not bookable', { code: 'NOT_BOOKABLE' });
    }
    const me = await repo.findEmployee(actor.actorEmployeeId);
    const booked = await repo.book(
      slotId,
      actor.actorEmployeeId,
      input.topic ?? null,
      actor,
      {
        to: [s.ownerId],
        event: {
          type: 'open_door.booked',
          title: `${me?.name ?? 'Someone'} booked your open-door slot on ${s.date} at ${hhmm(s.startTime)}`,
          link: LINK,
        },
      },
    );
    if (!booked) throw createError(409, 'That slot is full', { code: 'SLOT_FULL' });
    return deps.repo.findBooking(booked.id);
  };

  const cancelBooking = async (id: string, actor: ActorContext) => {
    const b = await repo.findBooking(id);
    if (!b || b.employeeId !== actor.actorEmployeeId) {
      throw createError(404, 'Booking not found', { code: 'BOOKING_NOT_FOUND' });
    }
    const s = await repo.findSlot(b.slotId);
    if (!s || started(s))
      throw createError(409, 'The slot has started', { code: 'SLOT_STARTED' });
    const row = await repo.setBookingStatus(id, 'booked', 'cancelled', actor, {
      to: [s.ownerId],
      event: {
        type: 'open_door.cancelled',
        title: `A booking for your open-door slot on ${s.date} at ${hhmm(s.startTime)} was cancelled`,
        link: LINK,
      },
    });
    if (!row)
      throw createError(409, 'Already cancelled or done', { code: 'BOOKING_CLOSED' });
    return me(actor.actorEmployeeId);
  };

  const mark = async (id: string, input: MarkInput, actor: ActorContext) => {
    const b = await repo.findBooking(id);
    const s = b ? await repo.findSlot(b.slotId) : undefined;
    if (!b || !s || s.ownerId !== actor.actorEmployeeId) {
      throw createError(404, 'Booking not found', { code: 'BOOKING_NOT_FOUND' });
    }
    if (!started(s))
      throw createError(409, 'The slot has not started yet', { code: 'NOT_STARTED' });
    const row = await repo.setBookingStatus(id, 'booked', input.status, actor);
    if (!row) throw createError(409, 'Already marked', { code: 'BOOKING_CLOSED' });
    return me(actor.actorEmployeeId);
  };

  // ── Session requests (test-pass fix 2026-10-22) ──────────────────────────
  // When no published slot suits, ask: a chosen host, or — for your own named
  // concern — whoever handles the case now. The answer is an offered time (a
  // 1-seat slot booked for you) or a decline with a reason.

  /** Who a request may go to: department heads (L5–L6) and HR holding hrbp.grievances. */
  const hosts = async (viewerId: string): Promise<HostDto[]> => {
    const hr = await authz.listBroadHolders('hrbp.grievances', 'update');
    return (await repo.hostCandidates(hr)).filter((h) => h.id !== viewerId);
  };

  /** Who answers a request: its host, or the case's current handlers. */
  const answerersOf = async (r: RequestRow): Promise<string[]> =>
    r.hostId ? [r.hostId] : r.concernId ? concerns().handlersFor(r.concernId) : [];

  const requests = async (viewerId: string): Promise<RequestsDto> => {
    const [mineRaw, toAnswerRaw] = await Promise.all([
      repo.requestsOf(viewerId),
      repo.requestsToAnswer(viewerId),
    ]);
    // Concern requests reach this viewer only if they handle that case now.
    const handlerCache = new Map<string, string[]>();
    const incomingRaw: RequestRow[] = [];
    for (const r of toAnswerRaw) {
      if (r.employeeId === viewerId) continue;
      if (r.hostId === viewerId) {
        incomingRaw.push(r);
        continue;
      }
      if (!r.concernId || !deps.concerns) continue;
      if (!handlerCache.has(r.concernId)) {
        handlerCache.set(r.concernId, await deps.concerns.handlersFor(r.concernId));
      }
      if (handlerCache.get(r.concernId)!.includes(viewerId)) incomingRaw.push(r);
    }
    const all = [...mineRaw, ...incomingRaw];
    const slotIds = all.map((r) => r.slotId).filter((id): id is string => !!id);
    const [slotRows, codes] = await Promise.all([
      Promise.all(slotIds.map((id) => repo.findSlot(id))),
      repo.concernCodes([
        ...new Set(all.map((r) => r.concernId).filter((id): id is string => !!id)),
      ]),
    ]);
    const slotsById = new Map(
      slotRows.filter((s): s is SlotRow => !!s).map((s) => [s.id, s]),
    );
    const bookings = await repo.bookingsFor([...slotsById.keys()]);
    const names = await repo.namesByIds([
      ...new Set(
        all
          .flatMap((r) => [r.employeeId, r.hostId, r.decidedBy])
          .concat([...slotsById.values()].map((s) => s.ownerId))
          .filter((id): id is string => !!id),
      ),
    ]);
    const person = (id: string | null) => (id ? { id, name: names.get(id) ?? '' } : null);
    const toDto = (r: RequestRow): RequestDto => {
      const s = r.slotId ? slotsById.get(r.slotId) : undefined;
      return {
        id: r.id,
        employee: person(r.employeeId)!,
        host: person(r.hostId),
        concern: r.concernId
          ? { id: r.concernId, code: codes.get(r.concernId) ?? '' }
          : null,
        preferredFrom: r.preferredFrom,
        preferredTo: r.preferredTo,
        topic: r.topic,
        status: r.status,
        slot: s ? toSlot(s, names, bookings, r.employeeId) : null,
        declineReason: r.declineReason,
        decidedBy: person(r.decidedBy),
        createdAt: r.createdAt.toISOString(),
      };
    };
    return { mine: mineRaw.map(toDto), incoming: incomingRaw.map(toDto) };
  };

  const createRequest = async (input: CreateRequestInput, actor: ActorContext) => {
    const t = today();
    if (input.preferredFrom < t) {
      throw createError(422, 'Pick dates from today on', { code: 'PAST_RANGE' });
    }
    if (input.preferredTo > addDaysIso(t, OPEN_DOOR_HORIZON_DAYS)) {
      throw createError(
        422,
        `Ask for a time within the next ${OPEN_DOOR_HORIZON_DAYS} days`,
        { code: 'BEYOND_HORIZON' },
      );
    }
    const pending = (await repo.requestsOf(actor.actorEmployeeId)).find(
      (r) =>
        r.status === 'requested' &&
        ((input.hostId && r.hostId === input.hostId) ||
          (input.concernId && r.concernId === input.concernId)),
    );
    if (pending) {
      throw createError(409, 'You already have a request waiting there', {
        code: 'REQUEST_PENDING',
      });
    }
    const who = (await repo.findEmployee(actor.actorEmployeeId))?.name ?? 'Someone';
    const range = `${input.preferredFrom} → ${input.preferredTo}`;
    if (input.hostId) {
      if (input.hostId === actor.actorEmployeeId) {
        throw createError(422, 'You cannot ask yourself', { code: 'OWN_REQUEST' });
      }
      if (!(await canPublish(input.hostId))) {
        throw createError(422, 'Sessions are held by HR and department heads', {
          code: 'NOT_A_HOST',
        });
      }
      await repo.insertRequest(
        {
          employeeId: actor.actorEmployeeId,
          hostId: input.hostId,
          preferredFrom: input.preferredFrom,
          preferredTo: input.preferredTo,
          topic: input.topic ?? null,
        },
        actor,
        {
          to: [input.hostId],
          event: {
            type: 'open_door.requested',
            title: `${who} asked you for an open-door session (${range})`,
            link: REQUESTS_LINK,
          },
        },
      );
    } else {
      const target = await concerns().meetingTarget(
        input.concernId!,
        actor.actorEmployeeId,
      );
      if (target.handlers.length === 0) {
        throw createError(422, 'Nobody is handling this case yet — try again shortly', {
          code: 'NO_HANDLER',
        });
      }
      await repo.insertRequest(
        {
          employeeId: actor.actorEmployeeId,
          concernId: target.id,
          preferredFrom: input.preferredFrom,
          preferredTo: input.preferredTo,
          topic: input.topic ?? null,
        },
        actor,
        {
          to: target.handlers,
          event: {
            type: 'open_door.requested',
            title: `A meeting was requested on ${target.code} (${range})`,
            link: REQUESTS_LINK,
          },
        },
      );
      await concerns().noteMeeting(
        target.id,
        `The raiser asked for a meeting (${range}).`,
        actor,
      );
    }
    return requests(actor.actorEmployeeId);
  };

  /** A request the caller may answer, still waiting. */
  const toAnswer = async (id: string, actorId: string): Promise<RequestRow> => {
    const r = await repo.findRequest(id);
    if (!r || !(await answerersOf(r)).includes(actorId)) {
      throw createError(404, 'Request not found', { code: 'REQUEST_NOT_FOUND' });
    }
    if (r.status !== 'requested') {
      throw createError(409, 'This request was already answered', {
        code: 'REQUEST_CLOSED',
      });
    }
    return r;
  };

  const offerRequest = async (
    id: string,
    input: OfferRequestInput,
    actor: ActorContext,
  ) => {
    const r = await toAnswer(id, actor.actorEmployeeId);
    if (
      input.date < today() ||
      (input.date === today() && input.startTime <= nowHhmm())
    ) {
      throw createError(422, 'Pick a time in the future', { code: 'PAST_SLOT' });
    }
    const host = (await repo.findEmployee(actor.actorEmployeeId))?.name ?? 'Your host';
    const when = `${input.date} at ${input.startTime}`;
    const done = await repo.offer(
      r,
      {
        ownerId: actor.actorEmployeeId,
        date: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
        note: input.note ?? null,
      },
      actor,
      {
        to: [r.employeeId],
        event: {
          type: 'open_door.offered',
          title: `${host} set your open-door session for ${when}`,
          link: REQUESTS_LINK,
        },
      },
    );
    if (!done) {
      throw createError(409, 'This request was already answered', {
        code: 'REQUEST_CLOSED',
      });
    }
    if (r.concernId) {
      await concerns().noteMeeting(
        r.concernId,
        `Meeting set with ${host} on ${when}–${input.endTime}.`,
        actor,
      );
    }
    return requests(actor.actorEmployeeId);
  };

  const declineRequest = async (
    id: string,
    input: DeclineRequestInput,
    actor: ActorContext,
  ) => {
    const r = await toAnswer(id, actor.actorEmployeeId);
    const done = await repo.closeRequest(id, 'declined', input.reason, actor, {
      to: [r.employeeId],
      event: {
        type: 'open_door.declined',
        title: 'Your open-door request was declined',
        body: input.reason,
        link: REQUESTS_LINK,
      },
    });
    if (!done) {
      throw createError(409, 'This request was already answered', {
        code: 'REQUEST_CLOSED',
      });
    }
    if (r.concernId) {
      await concerns().noteMeeting(
        r.concernId,
        `Meeting request declined: ${input.reason}`,
        actor,
      );
    }
    return requests(actor.actorEmployeeId);
  };

  const cancelRequest = async (id: string, actor: ActorContext) => {
    const r = await repo.findRequest(id);
    if (!r || r.employeeId !== actor.actorEmployeeId) {
      throw createError(404, 'Request not found', { code: 'REQUEST_NOT_FOUND' });
    }
    const done = await repo.closeRequest(id, 'cancelled', null, actor, {
      to: await answerersOf(r),
      event: {
        type: 'open_door.cancelled',
        title: 'An open-door request to you was withdrawn',
        link: REQUESTS_LINK,
      },
    });
    if (!done) {
      throw createError(409, 'This request was already answered', {
        code: 'REQUEST_CLOSED',
      });
    }
    return requests(actor.actorEmployeeId);
  };

  /** Waiting requests with who should answer — the open-door-requests job. */
  const unanswered = async () => {
    const out: Array<{ request: RequestRow; answerers: string[] }> = [];
    for (const r of await repo.openRequests()) {
      out.push({ request: r, answerers: await answerersOf(r) });
    }
    return out;
  };

  return {
    slots,
    me,
    createSlot,
    cancelSlot,
    book,
    cancelBooking,
    mark,
    canPublish,
    hosts,
    requests,
    createRequest,
    offerRequest,
    declineRequest,
    cancelRequest,
    unanswered,
  };
};

export type OpenDoorService = ReturnType<typeof createOpenDoorService>;
