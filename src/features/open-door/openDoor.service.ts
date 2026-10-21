import createError from 'http-errors';
import { OPEN_DOOR_HORIZON_DAYS } from '../../shared/constants/constants.js';
import { addDaysIso, localDateOf } from '../../shared/helpers/helpers.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import type {
  ActorContext,
  BookingRow,
  OpenDoorRepository,
  SlotRow,
} from './openDoor.repository.js';
import type {
  BookInput,
  CreateSlotInput,
  MarkInput,
  MyBookingDto,
  OpenDoorMeDto,
  OwnerSlotDto,
  SlotDto,
} from './openDoor.schema.js';

const LINK = '/open-door';
const hhmm = (t: string) => t.slice(0, 5);
const nowHhmm = () => new Date().toTimeString().slice(0, 5);

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
}) => {
  const { repo, authz } = deps;
  const today = () => localDateOf(new Date());

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

  return { slots, me, createSlot, cancelSlot, book, cancelBooking, mark, canPublish };
};

export type OpenDoorService = ReturnType<typeof createOpenDoorService>;
