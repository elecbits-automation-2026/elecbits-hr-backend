import { pino } from 'pino';
import { env } from './env.js';

/**
 * Application logger (pino).
 *
 *  - Production: structured single-line JSON to stdout — what CloudWatch (and
 *    any log shipper) wants once the app is deployed.
 *  - Development: human-readable, colourised output via pino-pretty.
 *
 * Sensitive fields are redacted everywhere so tokens/passwords never hit a log.
 * Import this `logger` directly for app-level logs; per-request logs come off
 * `req.log` (set by the requestLogger middleware), which inherits this config.
 */
export const logger = pino({
  level: env.logLevel,
  base: { service: 'elecbits-hr-backend', env: env.nodeEnv },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // Emit the level name ("info") rather than the numeric code.
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      'password_hash',
      '*.password_hash',
      'token',
      '*.token',
    ],
    censor: '[redacted]',
  },
  ...(env.isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname,service,env',
          },
        },
      }),
});

export type Logger = typeof logger;
