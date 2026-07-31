import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/http';
import { verifyToken, type JwtPayload } from '../lib/auth';
import { holdsAll, holdsAny, resolveAccess, type Access } from '../lib/access';
import { permissionDef } from '../lib/permissions';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
      /** Resolved live from the database by `authenticate` — never from the token. */
      access?: Access;
    }
  }
}

/** Name of the httpOnly cookie that lets `<img>` requests reach /uploads. */
export const SESSION_COOKIE = 'oswal_session';

function bearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

/**
 * Require a valid session, and attach both the token payload and the LIVE permission set.
 *
 * The database lookup is not optional decoration. The token proves only that somebody
 * signed in at some point in the last twelve hours; whether the account still exists, is
 * still active, and still holds any given permission are all questions only the database can
 * answer. `resolveAccess` caches briefly so a page load does not pay for this per call.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) return next(new ApiError(401, 'Not authenticated'));
  try {
    req.user = verifyToken(token);
  } catch {
    return next(new ApiError(401, 'Invalid or expired session. Please sign in again.'));
  }
  try {
    const access = await resolveAccess(req.user.sub);
    if (!access) return next(new ApiError(401, 'Account not found or disabled. Please sign in again.'));
    req.access = access;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Same check for uploaded files, but a cookie is accepted as well as a header.
 * A browser loading `<img src="/uploads/…">` cannot attach an Authorization header,
 * so login issues an httpOnly session cookie purely for this path.
 */
export async function authenticateUpload(req: Request, _res: Response, next: NextFunction) {
  const token = bearer(req) ?? (req.cookies?.[SESSION_COOKIE] as string | undefined);
  if (!token) return next(new ApiError(401, 'Not authenticated'));
  try {
    req.user = verifyToken(token);
  } catch {
    return next(new ApiError(401, 'Invalid or expired session. Please sign in again.'));
  }
  try {
    const access = await resolveAccess(req.user.sub);
    if (!access) return next(new ApiError(401, 'Account not found or disabled. Please sign in again.'));
    req.access = access;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * A refusal that names the permission in the words the Roles screen uses, so the message a
 * user reports ("I can't do X") is the same phrase whoever grants permissions is looking at.
 */
function refuse(keys: readonly string[]): ApiError {
  const labels = keys.map((k) => permissionDef(k)?.label ?? k);
  const which = labels.length === 1 ? `"${labels[0]}"` : labels.map((l) => `"${l}"`).join(' and ');
  return new ApiError(403, `You do not have permission to do this. It needs ${which}.`);
}

/**
 * Require EVERY listed permission.
 *
 * Routes state every key they need, including the view permission behind an edit. The
 * catalogue's `requires` closes a role over its prerequisites when it is SAVED, which makes
 * the two agree in practice — but a route must not lean on that, or enforcement would depend
 * on the shape of the catalogue rather than on what the route actually does.
 */
export function can(...keys: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (holdsAll(req.access, keys)) return next();
    next(refuse(keys));
  };
}

/** Require AT LEAST ONE of the listed permissions — for a route two different jobs reach. */
export function canAny(...keys: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (holdsAny(req.access, keys)) return next();
    next(refuse(keys));
  };
}

/**
 * Ask inside a handler, for the cases where a permission changes WHAT IS RETURNED rather
 * than whether the call is allowed — worker identity fields, money columns on a shared
 * response. Redaction has to happen server-side; filtering in the client would still put
 * the data on the wire.
 */
export function may(req: Request, ...keys: string[]): boolean {
  return holdsAll(req.access, keys);
}

/** Owner-only. Reserved for the few things that must survive any role misconfiguration. */
export function requireOwner(req: Request, _res: Response, next: NextFunction) {
  if (req.access?.isOwner) return next();
  next(new ApiError(403, 'Only an owner can do this.'));
}
