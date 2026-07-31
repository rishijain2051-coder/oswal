import type { IRouter, NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

/** Application error with an HTTP status code. */
export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Wrap an async route handler so thrown/rejected errors reach the error middleware. */
export const asyncHandler =
  <T extends Request>(fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };

/**
 * Every route param in this API is a database id, so every one of them must be a positive
 * integer.
 *
 * This is registered per-router rather than checked in each handler because there are well
 * over a hundred `Number(req.params.id)` call sites, and one of them will always be missed.
 * `Number('abc')` is `NaN`, and Prisma answers `where: { id: NaN }` with an internal
 * validation error — so `/orders/abc` came back as a 500 "internal server error" instead of
 * a plain 400. `router.param` fires before the handler, so a bad id never reaches Prisma,
 * and a route added later inherits the guard for free.
 *
 * Express scopes param callbacks to the router they are declared on, which is why this takes
 * the router rather than living on the app. Literal paths registered before a `/:id` route —
 * `/orders/trash`, `/orders/delivery-status` — match the literal first and never reach here.
 */
const ID_PARAMS = ['id', 'attachmentId', 'imageId', 'shipmentId', 'photoId', 'moveId'] as const;

export function guardIdParams(router: IRouter): void {
  for (const name of ID_PARAMS) {
    router.param(name, (_req, _res, next, value) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) return next(new ApiError(400, `“${value}” is not a valid id.`));
      next();
    });
  }
}

/** Central error handler. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  // Prisma unique-constraint violation
  if (typeof err === 'object' && err && (err as any).code === 'P2002') {
    const target = (err as any).meta?.target;
    return res.status(409).json({ error: `A record with this ${Array.isArray(target) ? target.join(', ') : target} already exists.` });
  }
  // body-parser's own error for a body over the limit. Its default message is
  // "request entity too large", which tells a factory user nothing they can act on.
  if (typeof err === 'object' && err && (err as any).type === 'entity.too.large') {
    return res.status(413).json({
      error: 'That request is too large to send in one go. Split it — save the sheet in parts, or upload the images separately.',
    });
  }
  console.error('[unhandled error]', err);
  const message = err instanceof Error ? err.message : 'Internal server error';
  return res.status(500).json({ error: message });
}
