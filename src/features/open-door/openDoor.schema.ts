import { z } from '../../shared/zod.js';

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm');

export const createSlotSchema = z
  .object({
    date: z.string().date(),
    startTime: HHMM,
    endTime: HHMM,
    capacity: z.number().int().min(1).max(20).optional(),
    note: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((v) => v.endTime > v.startTime, {
    message: 'End after start',
    path: ['endTime'],
  })
  .openapi('CreateOpenDoorSlot');

export const bookSchema = z
  .object({
    /** Private to the slot's owner. */
    topic: z.string().trim().max(500).optional(),
  })
  .strict()
  .openapi('BookOpenDoorSlot');

export const markSchema = z
  .object({ status: z.enum(['done', 'no_show']) })
  .strict()
  .openapi('MarkOpenDoorBooking');

const owner = z.object({ id: z.string().uuid(), name: z.string() });

export const slotSchema = z
  .object({
    id: z.string().uuid(),
    owner,
    date: z.string(),
    startTime: z.string(),
    endTime: z.string(),
    capacity: z.number().int(),
    booked: z.number().int(),
    note: z.string().nullable(),
    cancelled: z.boolean(),
    /** The caller's own booking on this slot, if any. */
    myBookingId: z.string().uuid().nullable(),
  })
  .openapi('OpenDoorSlot');

export const ownerSlotSchema = slotSchema
  .extend({
    bookings: z.array(
      z.object({
        id: z.string().uuid(),
        employee: owner,
        topic: z.string().nullable(),
        status: z.enum(['booked', 'done', 'cancelled', 'no_show']),
      }),
    ),
  })
  .openapi('OpenDoorOwnerSlot');

export const myBookingSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(['booked', 'done', 'cancelled', 'no_show']),
    topic: z.string().nullable(),
    slot: slotSchema,
  })
  .openapi('OpenDoorBooking');

export const meSchema = z
  .object({
    canPublish: z.boolean(),
    horizonDays: z.number().int(),
    bookings: z.array(myBookingSchema),
    slots: z.array(ownerSlotSchema),
  })
  .openapi('OpenDoorMe');

export type CreateSlotInput = z.infer<typeof createSlotSchema>;
export type BookInput = z.infer<typeof bookSchema>;
export type MarkInput = z.infer<typeof markSchema>;
export type SlotDto = z.infer<typeof slotSchema>;
export type OwnerSlotDto = z.infer<typeof ownerSlotSchema>;
export type MyBookingDto = z.infer<typeof myBookingSchema>;
export type OpenDoorMeDto = z.infer<typeof meSchema>;
