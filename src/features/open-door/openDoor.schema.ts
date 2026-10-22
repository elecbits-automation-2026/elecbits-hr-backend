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

// ── Session requests (test-pass fix 2026-10-22) ────────────────────────────

/** Ask a host for a session (hostId), or the handlers of your named concern (concernId). */
export const createRequestSchema = z
  .object({
    hostId: z.string().uuid().optional(),
    concernId: z.string().uuid().optional(),
    preferredFrom: z.string().date(),
    preferredTo: z.string().date(),
    /** Private to the host(s). */
    topic: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((v) => (v.hostId ? 1 : 0) + (v.concernId ? 1 : 0) === 1, {
    message: 'Ask either a host or about a concern',
    path: ['hostId'],
  })
  .refine((v) => v.preferredTo >= v.preferredFrom, {
    message: 'The range ends before it starts',
    path: ['preferredTo'],
  })
  .openapi('CreateOpenDoorRequest');

/** The host's answer: a time inside (ideally) the asked range. */
export const offerRequestSchema = z
  .object({
    date: z.string().date(),
    startTime: HHMM,
    endTime: HHMM,
    note: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((v) => v.endTime > v.startTime, {
    message: 'End after start',
    path: ['endTime'],
  })
  .openapi('OfferOpenDoorRequest');

export const declineRequestSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict()
  .openapi('DeclineOpenDoorRequest');

export const hostSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    designation: z.string().nullable(),
  })
  .openapi('OpenDoorHost');

export const requestSchema = z
  .object({
    id: z.string().uuid(),
    employee: owner,
    /** Null for a concern request — whoever handles the case answers. */
    host: owner.nullable(),
    concern: z.object({ id: z.string().uuid(), code: z.string() }).nullable(),
    preferredFrom: z.string(),
    preferredTo: z.string(),
    /** Only the requester and the host(s) see it. */
    topic: z.string().nullable(),
    status: z.enum(['requested', 'offered', 'declined', 'cancelled']),
    /** The offered time, once offered. */
    slot: slotSchema.nullable(),
    declineReason: z.string().nullable(),
    decidedBy: owner.nullable(),
    createdAt: z.string(),
  })
  .openapi('OpenDoorRequest');

export const requestsSchema = z
  .object({
    /** What the caller asked for. */
    mine: z.array(requestSchema),
    /** What the caller is asked to answer (as host, or as a concern handler). */
    incoming: z.array(requestSchema),
  })
  .openapi('OpenDoorRequests');

export type CreateRequestInput = z.infer<typeof createRequestSchema>;
export type OfferRequestInput = z.infer<typeof offerRequestSchema>;
export type DeclineRequestInput = z.infer<typeof declineRequestSchema>;
export type HostDto = z.infer<typeof hostSchema>;
export type RequestDto = z.infer<typeof requestSchema>;
export type RequestsDto = z.infer<typeof requestsSchema>;

export type CreateSlotInput = z.infer<typeof createSlotSchema>;
export type BookInput = z.infer<typeof bookSchema>;
export type MarkInput = z.infer<typeof markSchema>;
export type SlotDto = z.infer<typeof slotSchema>;
export type OwnerSlotDto = z.infer<typeof ownerSlotSchema>;
export type MyBookingDto = z.infer<typeof myBookingSchema>;
export type OpenDoorMeDto = z.infer<typeof meSchema>;
