import type { RequestHandler } from 'express';
import { db } from '../db/index.js';

/**
 * DB connection middleware.
 *
 * Attaches the shared DbClient to every request as `req.db`. Downstream layers
 * (controllers → services → repositories) take the handle off the request
 * instead of importing the singleton, which keeps them decoupled from the
 * concrete connection and gives us one place to later swap in a request-scoped
 * client (e.g. a transaction bound to the request).
 *
 * The pool itself is lazy/persistent — `pg` opens connections on first use and
 * reuses them — so this does no per-request connect work.
 */
export const dbConnection: RequestHandler = (req, _res, next) => {
  req.db = db;
  next();
};
