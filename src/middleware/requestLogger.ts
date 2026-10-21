import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import { logger } from '../config/logger.js';

/**
 * HTTP request logging.
 *
 * Wraps every request with pino-http: assigns/propagates a request id, attaches
 * a child logger as `req.log`, and emits one structured line per completed
 * request with method, path, status, and latency. Log level is derived from the
 * outcome so 5xx/errors surface as `error` and 4xx as `warn`.
 */
export const requestLogger = pinoHttp({
  logger,

  // Reuse an inbound X-Request-Id if present, else mint one, and echo it back
  // on the response for client/trace correlation.
  genReqId: (req, res) => {
    const incoming = req.headers['x-request-id'];
    const id = (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },

  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },

  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  customErrorMessage: (req, _res, err) =>
    `${req.method} ${req.url} failed: ${err.message}`,
});
