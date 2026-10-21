import { z } from '../../shared/zod.js';

/** Zod schemas for the auth feature (design doc §5). */

/** Company-email sign-in (§5.4). Domain restriction enforced in the service. */
export const loginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
  })
  .strict()
  .openapi('Login');

/**
 * An employee claims the record HRBP already created for them (§5.4): first
 * sign-in sets their password and links a `users` row to the employee row.
 */
export const claimRecordSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    // The single-use invite token from the claim link — proof the claimer was
    // actually invited, not merely aware of a colleague's email address.
    token: z.string().min(16),
  })
  .strict()
  .openapi('ClaimRecord');

/**
 * The one-time org claim (§5.2): only OWNER_CLAIM_EMAIL may do this, and only
 * while no Owner exists. After the first claim the path is permanently closed.
 */
export const claimOrgSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().min(1),
  })
  .strict()
  .openapi('ClaimOrg');

/** A short-lived access token; grants are never embedded in it (§10). */
export const sessionSchema = z
  .object({
    accessToken: z.string(),
    user: z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      employeeId: z.string().uuid(),
    }),
  })
  .openapi('Session');

export type LoginInput = z.infer<typeof loginSchema>;
export type ClaimRecordInput = z.infer<typeof claimRecordSchema>;
export type ClaimOrgInput = z.infer<typeof claimOrgSchema>;
