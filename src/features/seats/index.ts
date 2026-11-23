/** Public surface of the seats module. */
export { seatsRoutes } from './seats.routes.js';
export { registerSeatsDocs } from './seats.docs.js';
export {
  createSeatsRepository,
  endSeatsOfLeaver,
  findSeatHolder,
} from './seats.repository.js';
export { createSeatsService } from './seats.service.js';
export type { SeatDto, SeatKind, SeatsOverviewDto } from './seats.schema.js';
