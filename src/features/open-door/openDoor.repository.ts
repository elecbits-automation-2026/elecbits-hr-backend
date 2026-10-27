import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
} from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import {
  auditLog,
  concerns,
  employees,
  openDoorBookings,
  openDoorRequests,
  openDoorSlots,
  orgOwner,
} from '../../db/schema/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';

export type SlotRow = typeof openDoorSlots.$inferSelect;
export type BookingRow = typeof openDoorBookings.$inferSelect;
export type RequestRow = typeof openDoorRequests.$inferSelect;

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

const LIVE: BookingRow['status'][] = ['booked', 'done'];

/** The only place the open-door feature touches the database. */
export const createOpenDoorRepository = (db: DbClient) => ({
  findEmployee: async (id: string) =>
    (
      await db.orm
        .select({ id: employees.id, name: employees.name, level: employees.level })
        .from(employees)
        .where(eq(employees.id, id))
        .limit(1)
    )[0],

  namesByIds: async (ids: string[]): Promise<Map<string, string>> => {
    if (ids.length === 0) return new Map();
    const rows = await db.orm
      .select({ id: employees.id, name: employees.name })
      .from(employees)
      .where(inArray(employees.id, ids));
    return new Map(rows.map((r) => [r.id, r.name]));
  },

  findSlot: async (id: string): Promise<SlotRow | undefined> =>
    (
      await db.orm.select().from(openDoorSlots).where(eq(openDoorSlots.id, id)).limit(1)
    )[0],

  findBooking: async (id: string): Promise<BookingRow | undefined> =>
    (
      await db.orm
        .select()
        .from(openDoorBookings)
        .where(eq(openDoorBookings.id, id))
        .limit(1)
    )[0],

  /** Live slots between two dates, oldest first. */
  slotsBetween: (from: string, to: string): Promise<SlotRow[]> =>
    db.orm
      .select()
      .from(openDoorSlots)
      .where(
        and(
          gte(openDoorSlots.date, from),
          lte(openDoorSlots.date, to),
          isNull(openDoorSlots.cancelledAt),
        ),
      )
      .orderBy(asc(openDoorSlots.date), asc(openDoorSlots.startTime)),

  /** An owner's slots from a date on (cancelled included, so they see history). */
  ownerSlots: (ownerId: string, from: string): Promise<SlotRow[]> =>
    db.orm
      .select()
      .from(openDoorSlots)
      .where(and(eq(openDoorSlots.ownerId, ownerId), gte(openDoorSlots.date, from)))
      .orderBy(asc(openDoorSlots.date), asc(openDoorSlots.startTime)),

  bookingsFor: async (slotIds: string[]): Promise<BookingRow[]> => {
    if (slotIds.length === 0) return [];
    return db.orm
      .select()
      .from(openDoorBookings)
      .where(inArray(openDoorBookings.slotId, slotIds));
  },

  bookingsOf: (employeeId: string): Promise<BookingRow[]> =>
    db.orm
      .select()
      .from(openDoorBookings)
      .where(eq(openDoorBookings.employeeId, employeeId)),

  insertSlot: async (
    values: typeof openDoorSlots.$inferInsert,
    actor: ActorContext,
  ): Promise<SlotRow> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm.insert(openDoorSlots).values(values).returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'open_door.slot_created',
        subject: `open_door_slots:${rows[0]!.id}`,
        detail: JSON.stringify({ date: values.date }),
      });
      return rows[0]!;
    }),

  /** Cancel a slot: its bookings are cancelled and their people told. */
  cancelSlot: async (
    slot: SlotRow,
    actor: ActorContext,
    event: NotificationEvent,
  ): Promise<void> =>
    db.transaction(async (tx) => {
      await tx.orm
        .update(openDoorSlots)
        .set({ cancelledAt: new Date() })
        .where(and(eq(openDoorSlots.id, slot.id), isNull(openDoorSlots.cancelledAt)));
      const affected = await tx.orm
        .update(openDoorBookings)
        .set({ status: 'cancelled' })
        .where(
          and(
            eq(openDoorBookings.slotId, slot.id),
            eq(openDoorBookings.status, 'booked'),
          ),
        )
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'open_door.slot_cancelled',
        subject: `open_door_slots:${slot.id}`,
        detail: JSON.stringify({ bookingsCancelled: affected.length }),
      });
      await insertNotifications(
        tx,
        affected.map((b) => b.employeeId),
        event,
      );
    }),

  /**
   * Book a seat. The slot row is locked so two people can't take the last
   * seat; a booking the person cancelled earlier is revived instead of
   * duplicated. Returns null when the slot is full.
   */
  book: async (
    slotId: string,
    employeeId: string,
    topic: string | null,
    actor: ActorContext,
    bell: { to: string[]; event: NotificationEvent },
  ): Promise<BookingRow | null> =>
    db.transaction(async (tx) => {
      const locked = await tx.query<{ capacity: number }>(
        `SELECT capacity FROM org.open_door_slots WHERE id = $1 AND cancelled_at IS NULL FOR UPDATE`,
        [slotId],
      );
      if (!locked[0]) return null;
      const taken = await tx.orm
        .select({ id: openDoorBookings.id })
        .from(openDoorBookings)
        .where(
          and(
            eq(openDoorBookings.slotId, slotId),
            inArray(openDoorBookings.status, LIVE),
          ),
        );
      if (taken.length >= locked[0].capacity) return null;
      const rows = await tx.orm
        .insert(openDoorBookings)
        .values({ slotId, employeeId, topic, status: 'booked' })
        .onConflictDoUpdate({
          target: [openDoorBookings.slotId, openDoorBookings.employeeId],
          set: { status: 'booked', topic, createdAt: new Date() },
        })
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'open_door.booked',
        subject: `open_door_slots:${slotId}`,
        detail: JSON.stringify({ bookingId: rows[0]!.id }),
      });
      await insertNotifications(tx, bell.to, bell.event);
      return rows[0]!;
    }),

  // ── Session requests ──────────────────────────────────────────────────────

  /**
   * Active people at L5–L6 or in `ids` — the hosts a request may go to. The
   * Owner-linked administration account is not a person, so never a host.
   */
  hostCandidates: (ids: string[]) =>
    db.orm
      .select({
        id: employees.id,
        name: employees.name,
        designation: employees.designation,
      })
      .from(employees)
      .leftJoin(orgOwner, eq(orgOwner.employeeId, employees.id))
      .where(
        and(
          eq(employees.status, 'active'),
          isNull(orgOwner.employeeId),
          ids.length
            ? or(inArray(employees.level, ['L5', 'L6']), inArray(employees.id, ids))
            : inArray(employees.level, ['L5', 'L6']),
        ),
      )
      .orderBy(asc(employees.name)),

  /** Case codes for concern-linked requests (the code only — never the body). */
  concernCodes: async (ids: string[]): Promise<Map<string, string>> => {
    if (ids.length === 0) return new Map();
    const rows = await db.orm
      .select({ id: concerns.id, code: concerns.code })
      .from(concerns)
      .where(inArray(concerns.id, ids));
    return new Map(rows.map((r) => [r.id, r.code]));
  },

  findRequest: async (id: string): Promise<RequestRow | undefined> =>
    (
      await db.orm
        .select()
        .from(openDoorRequests)
        .where(eq(openDoorRequests.id, id))
        .limit(1)
    )[0],

  /** Requests the person made, newest first. */
  requestsOf: (employeeId: string): Promise<RequestRow[]> =>
    db.orm
      .select()
      .from(openDoorRequests)
      .where(eq(openDoorRequests.employeeId, employeeId))
      .orderBy(desc(openDoorRequests.createdAt)),

  /** Requests addressed to a host, plus every concern request (handlers are resolved by the service). */
  requestsToAnswer: (hostId: string): Promise<RequestRow[]> =>
    db.orm
      .select()
      .from(openDoorRequests)
      .where(
        or(eq(openDoorRequests.hostId, hostId), isNotNull(openDoorRequests.concernId)),
      )
      .orderBy(desc(openDoorRequests.createdAt)),

  /** Still waiting for an answer — the reminder job. */
  openRequests: (): Promise<RequestRow[]> =>
    db.orm
      .select()
      .from(openDoorRequests)
      .where(eq(openDoorRequests.status, 'requested'))
      .orderBy(asc(openDoorRequests.createdAt)),

  insertRequest: async (
    values: typeof openDoorRequests.$inferInsert,
    actor: ActorContext,
    bell: { to: string[]; event: NotificationEvent },
  ): Promise<RequestRow> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm.insert(openDoorRequests).values(values).returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'open_door.requested',
        subject: `open_door_requests:${rows[0]!.id}`,
        detail: JSON.stringify({ concern: values.concernId ?? null }),
      });
      await insertNotifications(tx, bell.to, bell.event);
      return rows[0]!;
    }),

  /**
   * The host's offer, all or nothing: a 1-seat slot owned by the host, the
   * requester booked into it, the request marked offered. Null when the
   * request was answered or withdrawn meanwhile.
   */
  offer: async (
    request: RequestRow,
    slot: {
      ownerId: string;
      date: string;
      startTime: string;
      endTime: string;
      note: string | null;
    },
    actor: ActorContext,
    bell: { to: string[]; event: NotificationEvent },
  ): Promise<RequestRow | null> =>
    db.transaction(async (tx) => {
      const claimed = await tx.orm
        .update(openDoorRequests)
        .set({
          status: 'offered',
          decidedBy: actor.actorEmployeeId,
          decidedAt: new Date(),
        })
        .where(
          and(
            eq(openDoorRequests.id, request.id),
            eq(openDoorRequests.status, 'requested'),
          ),
        )
        .returning();
      if (!claimed[0]) return null;
      const slots = await tx.orm
        .insert(openDoorSlots)
        .values({ ...slot, capacity: 1 })
        .returning();
      await tx.orm.insert(openDoorBookings).values({
        slotId: slots[0]!.id,
        employeeId: request.employeeId,
        topic: request.topic,
        status: 'booked',
      });
      const rows = await tx.orm
        .update(openDoorRequests)
        .set({ slotId: slots[0]!.id })
        .where(eq(openDoorRequests.id, request.id))
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'open_door.request_offered',
        subject: `open_door_requests:${request.id}`,
        detail: JSON.stringify({ slotId: slots[0]!.id }),
      });
      await insertNotifications(tx, bell.to, bell.event);
      return rows[0]!;
    }),

  /** requested → declined / cancelled; null when it already moved on. */
  closeRequest: async (
    id: string,
    to: 'declined' | 'cancelled',
    reason: string | null,
    actor: ActorContext,
    bell: { to: string[]; event: NotificationEvent },
  ): Promise<RequestRow | null> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(openDoorRequests)
        .set({
          status: to,
          declineReason: reason,
          decidedBy: actor.actorEmployeeId,
          decidedAt: new Date(),
        })
        .where(and(eq(openDoorRequests.id, id), eq(openDoorRequests.status, 'requested')))
        .returning();
      if (!rows[0]) return null;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: `open_door.request_${to}`,
        subject: `open_door_requests:${id}`,
        detail: null,
      });
      await insertNotifications(tx, bell.to, bell.event);
      return rows[0];
    }),

  setBookingStatus: async (
    id: string,
    from: BookingRow['status'],
    to: BookingRow['status'],
    actor: ActorContext,
    bell?: { to: string[]; event: NotificationEvent },
  ): Promise<BookingRow | undefined> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(openDoorBookings)
        .set({ status: to })
        .where(and(eq(openDoorBookings.id, id), eq(openDoorBookings.status, from)))
        .returning();
      if (!rows[0]) return undefined;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: `open_door.booking_${to}`,
        subject: `open_door_slots:${rows[0].slotId}`,
        detail: JSON.stringify({ bookingId: id }),
      });
      if (bell) await insertNotifications(tx, bell.to, bell.event);
      return rows[0];
    }),
});

export type OpenDoorRepository = ReturnType<typeof createOpenDoorRepository>;
