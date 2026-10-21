import type { RequestHandler } from 'express';
import createError from 'http-errors';
import type { ZodType } from 'zod';

/**
 * Body-validation middleware.
 *
 * Parses `req.body` against a Zod schema, replaces it with the parsed (coerced
 * and normalised) value, and forwards a 400 to the central errorHandler when
 * validation fails. Register it before the controller on a route:
 *
 *   router.post('/', validateBody(createEmployeeSchema), controller.create);
 */
export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      return next(createError(400, message || 'Invalid request body'));
    }
    req.body = result.data;
    next();
  };
}
