import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/http';
import { verifyToken, type JwtPayload } from '../lib/auth';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export const ROLES = ['Viewer', 'Operator', 'Manager', 'Admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_RANK: Record<string, number> = {
  Viewer: 1,
  Operator: 2,
  Manager: 3,
  Admin: 4,
};

/** Name of the httpOnly cookie that lets `<img>` requests reach /uploads. */
export const SESSION_COOKIE = 'oswal_session';

/** Require a valid bearer token; attaches req.user. */
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) return next(new ApiError(401, 'Not authenticated'));
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    next(new ApiError(401, 'Invalid or expired session. Please sign in again.'));
  }
}

/**
 * Same check for uploaded files, but a cookie is accepted as well as a header.
 * A browser loading `<img src="/uploads/…">` cannot attach an Authorization header,
 * so login issues an httpOnly session cookie purely for this path.
 */
export function authenticateUpload(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = (header?.startsWith('Bearer ') ? header.slice(7) : undefined) ?? (req.cookies?.[SESSION_COOKIE] as string | undefined);
  if (!token) return next(new ApiError(401, 'Not authenticated'));
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    next(new ApiError(401, 'Invalid or expired session. Please sign in again.'));
  }
}

/** Require the current user to have at least the given role rank. */
export function requireRole(minRole: Role) {
  const min = ROLE_RANK[minRole] ?? 99;
  return (req: Request, _res: Response, next: NextFunction) => {
    const rank = ROLE_RANK[req.user?.role ?? ''] ?? 0;
    if (rank < min) return next(new ApiError(403, 'You do not have permission to perform this action.'));
    next();
  };
}
