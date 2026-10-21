import type { ZodType } from 'zod';
import { z } from '../shared/zod.js';

/**
 * Small helpers shared by the per-feature OpenAPI registrations. Request and
 * response schemas are plain Zod, so the docs are generated from the same
 * schemas used at runtime — nothing is hand-written twice.
 */

/** The standard error envelope returned by the central error handler. */
export const apiErrorSchema = z
  .object({
    error: z.object({
      message: z.string(),
      code: z.string(),
    }),
    requestId: z.string(),
  })
  .openapi('ErrorResponse');

/** A JSON request body for `registerPath({ request: { body } })`. */
export const jsonBody = (schema: ZodType) => ({
  required: true,
  content: { 'application/json': { schema } },
});

/** A JSON response entry for `registerPath({ responses })`. */
export const jsonResponse = (description: string, schema: ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});

/** An error response (uses the shared envelope, emitted as a `$ref`). */
export const errorResponse = (description: string) =>
  jsonResponse(description, apiErrorSchema);
