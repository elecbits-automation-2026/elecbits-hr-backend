import type { ErrorRequestHandler, RequestHandler } from 'express';
import createError, { isHttpError } from 'http-errors';
import { logger } from '../config/logger.js';

/**
 * Centralised error handling.
 *
 * `notFound` runs after all routes and turns an unmatched path into a 404 that
 * flows through the same handler as everything else, so every error response
 * has one shape.
 *
 * `errorHandler` is the single place that converts a thrown error into an HTTP
 * response. It understands `http-errors` (anything with a `statusCode` and an
 * `expose` flag) and treats everything else as an unexpected 500 whose message
 * is never leaked.
 *
 * Response shape (stable contract for clients):
 *   { "error": { "message": string, "code": string }, "requestId": string }
 */

const FALLBACK_STATUS = 500;

export const notFound: RequestHandler = (req, _res, next) => {
  next(createError(404, `Cannot ${req.method} ${req.path}`));
};

// Must keep all four args — Express identifies error handlers by arity.
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Headers already flushed (e.g. error mid-stream): defer to Express to abort.
  if (res.headersSent) return next(err);

  const http = isHttpError(err);
  const statusCode = http ? err.statusCode : FALLBACK_STATUS;
  // 4xx messages are safe to surface; 5xx (and unknown errors) are not.
  const expose = http ? err.expose : false;
  const code = errorCode(err, http, statusCode);
  const message = expose && err instanceof Error ? err.message : statusText(statusCode);

  // One structured log line with the full error (stack included). 5xx is an
  // `error`; client mistakes (4xx) are `warn` so they don't page anyone.
  const log = req.log ?? logger;
  const fields = { err, statusCode, code, reqId: req.id };
  if (statusCode >= 500) log.error(fields, 'request failed');
  else log.warn(fields, 'request rejected');

  res.status(statusCode).json({ error: { message, code }, requestId: req.id });
};

/**
 * Use an explicit string `code` only when the error was deliberately built as
 * an http-error — otherwise derive from status. This avoids leaking internal
 * codes (e.g. a `pg` error's `'23505'`) on a 500.
 */
function errorCode(err: unknown, http: boolean, statusCode: number): string {
  if (http && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return statusText(statusCode).toUpperCase().replace(/\s+/g, '_');
}

function statusText(statusCode: number): string {
  return statusCode >= 500 ? 'Internal Server Error' : createError(statusCode).message;
}
