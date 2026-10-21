import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import {
  auditLog,
  employees,
  openDoorBookings,
  openDoorSlots,
} from '../../db/schema/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';

export type SlotRow = typeof openDoorSlots.$inferSelect;
export type BookingRow = typeof openDoorBookings.$inferSelect;

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
