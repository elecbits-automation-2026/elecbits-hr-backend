import type { Request, RequestHandler } from 'express';
import createError from 'http-errors';
import {
  createAuthzRepository,
  type PeopleScope,
} from '../features/access/authz.repository.js';
import type { Action } from '../shared/constants/constants.js';
import { widestScope } from '../shared/helpers/helpers.js';

/**
 * Authorization middleware — the HTTP face of the single decision point
 * `access.can(module, action, target)` from the design doc (§11.3).
 *
 * Effective access is the UNION of everything the caller holds (batches +
 * individual grants); there are no deny rules (§3.2). Owner and SuperAdmin
 * pass every check. Scope (`me`/`team_direct`/`team`/`dept`/`org`) is applied
 * by the features when they list or act on people rows (`peopleScopeOf`) —
 * this middleware answers "may this caller perform (module, action) at all".
 * Company-wide operations and configuration pass `{ orgOnly: true }`: only an
 * org grant (or the bypass) opens them (refinement plan, Phase 3).
 *
 * Grants are resolved server-side on every request, never from the token, so
 * revocation takes effect immediately (§9/§10).
 */
export const requireAccess = (
  moduleKey: string,
  action: Action,
  options: { orgOnly?: boolean } = {},
): RequestHandler => {
  return async (req, _res, next) => {
    if (!req.auth) {
      return next(
        createError(401, 'Authentication required', { code: 'UNAUTHENTICATED' }),
      );
    }

    try {
      const { bypass, scopes } = await createAuthzRepository(req.db).resolveAccess(
        req.auth.employeeId,
        moduleKey,
        action,
      );

      if (bypass) {
        req.access = { moduleKey, action, scope: 'org', scopes: ['org'], bypass: true };
        return next();
      }
      if (scopes.length > 0 && (!options.orgOnly || scopes.includes('org'))) {
        req.access = {
          moduleKey,
          action,
          scope: widestScope(scopes),
          scopes,
          bypass: false,
        };
        return next();
      }

      req.log.info(
        { moduleKey, action, employeeId: req.auth.employeeId },
        'access denied',
      );
      next(
        scopes.length > 0
          ? createError(403, 'This needs an org-wide grant — yours is narrower', {
              code: 'ORG_SCOPE_REQUIRED',
            })
          : createError(403, 'You do not have access to this action', {
              code: 'FORBIDDEN',
            }),
      );
    } catch (err) {
      next(err);
    }
  };
};

/**
 * Whose rows this request may see or act on, from the grant requireAccess
 * resolved — feed it to the repository filter. Must run after requireAccess.
 */
export const peopleScopeOf = (req: Request): Promise<PeopleScope> => {
  if (!req.access || !req.auth) {
    throw createError(500, 'peopleScopeOf called without requireAccess');
  }
  return createAuthzRepository(req.db).reachable(req.auth.employeeId, {
    bypass: req.access.bypass,
    scopes: req.access.scopes,
  });
};

/** Keep only the rows whose person this request's grant reaches. */
export const keepReachable = async <T>(
  req: Request,
  rows: T[],
  personOf: (row: T) => string,
): Promise<T[]> => {
  const scope = await peopleScopeOf(req);
  return scope.all ? rows : rows.filter((r) => scope.ids.has(personOf(r)));
};

/**
 * Refuse a person outside this request's reach: `hide` answers 404 (reads —
 * never confirm the record exists), `forbid` answers 403 (actions).
 */
export const assertReaches = async (
  req: Request,
  employeeId: string,
  how: 'hide' | 'forbid' = 'forbid',
): Promise<void> => {
  const scope = await peopleScopeOf(req);
  if (scope.all || scope.ids.has(employeeId)) return;
  throw how === 'hide'
    ? createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' })
    : createError(403, 'This person is outside the people your access covers', {
        code: 'OUT_OF_SCOPE',
      });
};
