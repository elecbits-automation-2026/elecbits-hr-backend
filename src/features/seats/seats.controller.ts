import type { Request, Response } from 'express';
import { createSeatsRepository } from './seats.repository.js';
import type { AssignSeatInput, VacateSeatInput } from './seats.schema.js';
import { createSeatsService } from './seats.service.js';

const service = (req: Request) =>
  createSeatsService({ repo: createSeatsRepository(req.db) });

const actor = (req: Request) => ({
  actorUserId: req.auth!.userId,
  actorEmployeeId: req.auth!.employeeId,
});

export const seatsController = {
  overview: async (req: Request, res: Response): Promise<void> => {
    res.json(await service(req).overview(actor(req)));
  },

  assign: async (req: Request, res: Response): Promise<void> => {
    const input: AssignSeatInput = req.body;
    const seat = await service(req).assign(input, actor(req));
    req.log.info({ seatId: seat.id, seat: seat.seat }, 'seat assigned');
    res.json(seat);
  },

  vacate: async (req: Request, res: Response): Promise<void> => {
    const input: VacateSeatInput = req.body;
    await service(req).vacate(input, actor(req));
    req.log.info({ seat: input.seat }, 'seat vacated');
    res.status(204).end();
  },
};
