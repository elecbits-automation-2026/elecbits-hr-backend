import { z } from '../../shared/zod.js';

/** Seats HR assigns. The TA head seat is retired (Admin gives each hiring line to a TA RM). */
export const SEATS = ['dept_head', 'vp_hr_head'] as const;

const seatKindSchema = z.enum(SEATS);

/** One open seat and who holds it. */
export const seatSchema = z
  .object({
    id: z.string().uuid(),
    seat: seatKindSchema,
    departmentId: z.string().uuid().nullable(),
    departmentName: z.string().nullable(),
    employeeId: z.string().uuid(),
    employeeName: z.string(),
    acting: z.boolean(),
    startedAt: z.string().datetime(),
  })
  .openapi('Seat');

/** A seat nobody holds — a department without a head, or an empty company seat. */
export const vacantSeatSchema = z
  .object({
    seat: seatKindSchema,
    departmentId: z.string().uuid().nullable(),
    departmentName: z.string().nullable(),
  })
  .openapi('VacantSeat');

export const seatsOverviewSchema = z
  .object({
    seats: z.array(seatSchema),
    vacant: z.array(vacantSeatSchema),
    /** The Admin account — the UI leaves it out of the picker. */
    ownerEmployeeId: z.string().uuid().nullable(),
  })
  .openapi('SeatsOverview');

// A department head needs its department; the company-wide seats must not have one.
const deptRule = (v: { seat: string; departmentId?: string }) =>
  (v.seat === 'dept_head') === (v.departmentId !== undefined);
const deptRuleMessage = {
  message: 'departmentId is required for dept_head and not allowed for other seats',
  path: ['departmentId'],
};

export const assignSeatSchema = z
  .object({
    seat: seatKindSchema,
    departmentId: z.string().uuid().optional(),
    employeeId: z.string().uuid(),
    acting: z.boolean().default(false),
  })
  .strict()
  .refine(deptRule, deptRuleMessage)
  .openapi('AssignSeat');

export const vacateSeatSchema = z
  .object({
    seat: seatKindSchema,
    departmentId: z.string().uuid().optional(),
  })
  .strict()
  .refine(deptRule, deptRuleMessage)
  .openapi('VacateSeat');

export type SeatKind = z.infer<typeof seatKindSchema>;
export type SeatDto = z.infer<typeof seatSchema>;
export type SeatsOverviewDto = z.infer<typeof seatsOverviewSchema>;
export type AssignSeatInput = z.infer<typeof assignSeatSchema>;
export type VacateSeatInput = z.infer<typeof vacateSeatSchema>;
