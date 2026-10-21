import type { DbClient } from '../../db/client.js';
import type { Action, Scope } from '../constants/constants.js';

/**
 * Request-scoped context set by the middleware chain:
 *  - `req.db`     : the shared DbClient (dbConnection middleware)
 *  - `req.auth`   : the verified caller (authenticate middleware)
 *  - `req.access` : the resolved access decision (requireAccess middleware)
 *
 * `req.log` / `req.id` come from pino-http's own type augmentation.
 */
export interface AuthContext {
  /** The signed-in identity (public.users.id). */
  userId: string;
  /** The employee record that identity claimed (org.employees.id). */
  employeeId: string;
  email: string;
}

/**
 * The outcome of the requireAccess check, stashed for repositories to filter
 * rows by (§3.1). `scope` is the WIDEST scope among the caller's matching
 * grants; `bypass` marks Owner/SuperAdmin, who pass every check (§6).
 */
export interface AccessContext {
  moduleKey: string;
  action: Action;
  scope: Scope;
  /** Every scope the caller holds this grant at (union = what they reach). */
  scopes: Scope[];
  bypass: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      db: DbClient;
      auth?: AuthContext;
      access?: AccessContext;
    }
  }
}
