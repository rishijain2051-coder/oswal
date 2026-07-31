import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { env } from '../env';
import { ApiError, asyncHandler, guardIdParams } from '../lib/http';
import { hashPassword, signToken, verifyPassword } from '../lib/auth';
import { resolveAccess } from '../lib/access';
import { authenticate, SESSION_COOKIE } from '../middleware/auth';

const router = Router();
// A route param here is always a database id — see guardIdParams.
guardIdParams(router);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * Small in-memory throttle on password attempts, keyed by IP + e-mail. Enough to
 * make guessing an admin password impractical without dragging in a dependency;
 * a single-process local deployment needs nothing more.
 */
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; first: number }>();

function throttle(key: string) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, first: now });
    return;
  }
  rec.count++;
  if (rec.count > MAX_ATTEMPTS) {
    const mins = Math.ceil((ATTEMPT_WINDOW_MS - (now - rec.first)) / 60000);
    throw new ApiError(429, `Too many sign-in attempts. Try again in ${mins} minute(s).`);
  }
}
const clearThrottle = (key: string) => attempts.delete(key);

// Occasional sweep so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (now - v.first > ATTEMPT_WINDOW_MS) attempts.delete(k);
}, ATTEMPT_WINDOW_MS).unref();

/** Issue the token and mirror it into an httpOnly cookie for /uploads. */
function grant(res: Response, user: { id: number; name: string; email: string }) {
  const token = signToken({ sub: user.id, name: user.name, email: user.email });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProd,
    maxAge: 12 * 60 * 60 * 1000,
    path: '/',
  });
  return token;
}

/**
 * What the client is told about itself. The permission LIST is sent so the UI can hide what
 * a user cannot do — but it is only ever a hint: every route checks for itself, because a
 * list sent to a browser is a list the browser can edit.
 *
 * Resolved through `resolveAccess` rather than read off the user row, so the token endpoint
 * and the permission checks can never disagree about what somebody holds.
 */
async function identity(userId: number) {
  const access = await resolveAccess(userId);
  if (!access) throw new ApiError(401, 'Account not found or disabled.');
  return {
    id: access.userId,
    name: access.name,
    email: access.email,
    isOwner: access.isOwner,
    role: access.roleId ? { id: access.roleId, name: access.roleName } : null,
    permissions: [...access.keys].sort(),
  };
}

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const key = `${req.ip}:${email.toLowerCase()}`;
    throttle(key);

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !user.isActive) throw new ApiError(401, 'Invalid email or password.');
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw new ApiError(401, 'Invalid email or password.');

    clearThrottle(key);
    const token = grant(res, user);
    res.json({ token, user: await identity(user.id) });
  })
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await identity(req.access!.userId));
  })
);

/**
 * Renew a session that is still valid. The client calls this quietly while someone
 * is working, so a long shift on the factory floor is never interrupted by an
 * expiry — and a token stolen from a closed session still dies on schedule.
 */
router.post(
  '/refresh',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user!.sub } });
    if (!user || !user.isActive) throw new ApiError(401, 'Account not found or disabled.');
    const token = grant(res, user);
    res.json({ token, user: await identity(user.id) });
  })
);

router.post(
  '/logout',
  asyncHandler(async (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  })
);

/** Anyone may rotate their own password, without needing an Admin. */
router.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = z
      .object({ currentPassword: z.string().min(1), newPassword: z.string().min(8, 'Use at least 8 characters.') })
      .parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: req.user!.sub } });
    if (!user || !user.isActive) throw new ApiError(401, 'Account not found or disabled.');
    if (!(await verifyPassword(currentPassword, user.passwordHash))) throw new ApiError(400, 'Current password is incorrect.');
    if (await verifyPassword(newPassword, user.passwordHash)) throw new ApiError(400, 'The new password must be different.');

    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } });
    const token = grant(res, user);
    res.json({ token, changed: true });
  })
);

export default router;
