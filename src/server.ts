import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { db } from './db/index.js';
import { startScheduler, stopScheduler } from './scheduler/scheduler.js';

/**
 * Process entry point: verify the database is reachable, then start the HTTP
 * server. We connect up front (fail fast) rather than letting the pool connect
 * lazily on the first request — a misconfigured DB should stop the boot, not
 * surface as a 503 later.
 */

// Give in-flight work this long to finish on shutdown before we force-exit.
const SHUTDOWN_TIMEOUT_MS = 10_000;

// Keep-alive must outlive a load balancer's idle timeout (ALB default 60s) or
// the LB can reuse a socket the server just closed → intermittent 502s.
// headersTimeout must be a touch higher than keepAliveTimeout.
const KEEP_ALIVE_TIMEOUT_MS = 65_000;
const HEADERS_TIMEOUT_MS = 66_000;
const REQUEST_TIMEOUT_MS = 60_000;

async function start(): Promise<void> {
  // Force a real connection to the database before accepting traffic.
  const ok = await db.healthcheck();

  if (!ok) {
    throw new Error(
      'Database healthcheck failed: unable to establish a connection to the database.',
    );
  }

  try {
    const dbUrl = new URL(env.databaseUrl);
    logger.info(
      { host: dbUrl.hostname, database: dbUrl.pathname.replace(/^\//, '') },
      'Database connection established successfully',
    );
  } catch {
    logger.info('Database connection established successfully');
  }

  const app = createApp();

  const server: Server = app.listen(env.port, () => {
    logger.info(
      { port: env.port },
      `Server started successfully at http://localhost:${env.port}`,
    );
  });

  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  // A listen-time failure (e.g. EADDRINUSE) is an event, not a rejection —
  // catch it here so it doesn't become an unhandled error with no clean log.
  server.on('error', (err) => {
    logger.fatal({ err }, 'HTTP server error');
    process.exit(1);
  });

  startScheduler();
  registerShutdown(server);
}

/** Drain HTTP connections, then the DB pool, on shutdown signals. */
function registerShutdown(server: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return; // ignore repeated SIGTERM/SIGINT
    shuttingDown = true;
    logger.info({ signal }, 'Initiating graceful shutdown of HTTP server');
    stopScheduler();

    // Hard cap: if draining stalls, exit anyway so the orchestrator isn't left
    // to SIGKILL us mid-write.
    const force = setTimeout(() => {
      logger.error(
        { signal, shutdownTimeout: SHUTDOWN_TIMEOUT_MS },
        'Forced shutdown after timeout',
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    force.unref();

    server.close(async (err) => {
      if (err) logger.error({ err }, 'Error closing HTTP server');
      try {
        await db.close();
        logger.info('Database pool closed successfully');
      } catch (closeErr) {
        logger.error({ err: closeErr }, 'Error closing database pool');
      }
      clearTimeout(force);
      logger.info('Graceful shutdown completed – HTTP server closed, DB pool released');
      process.exit(err ? 1 : 0);
    });
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, shutdown);
  }
}

// --- Last-resort process guards ---------------------------------------------
// By the time these fire the process is in an unknown state; log and exit so a
// supervisor restarts us with a clean slate rather than limping along.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

start().catch(async (err) => {
  logger.fatal({ err }, 'Application startup failed');
  await db.close().catch(() => {});
  process.exit(1);
});
