import type { z } from 'zod';
import type { users } from '../../db/schema/index.js';
import type { sessionSchema } from './auth.schema.js';

export type UserRow = typeof users.$inferSelect;
export type SessionDto = z.infer<typeof sessionSchema>;

/** A session plus the raw refresh token the controller puts in the cookie. */
export interface IssuedSession {
  session: SessionDto;
  refresh: { token: string; expiresAt: Date };
}
