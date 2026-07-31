/**
 * Who the signed-in user is and what they may do.
 *
 * Permissions are resolved from the DATABASE ON EVERY REQUEST, not read out of the token.
 * That is the whole point: a token lives up to twelve hours and renews itself quietly while
 * somebody works, so a role baked into it would mean revoking access did nothing until the
 * next working day. Resolving live means a change takes effect on the user's next click.
 *
 * It also closes a hole the old rank-in-token model had: a DEACTIVATED ACCOUNT's token kept
 * working until it expired, because nothing looked the user up again. `resolveAccess`
 * returns null for an inactive or deleted account, so `authenticate` now rejects it.
 *
 * The cost is one query per request, which a page load multiplies by however many calls it
 * makes — hence the cache below. It is a cache with an explicit invalidation, not a timeout
 * people have to wait out: every route that changes a role or a user calls
 * `invalidateAccess`, and the TTL is only a backstop for a change made outside the app
 * (directly in the database, say).
 */
import { prisma } from '../db';
import { PERMISSION_KEYS } from './permissions';

export interface Access {
  userId: number;
  name: string;
  email: string;
  /** Holds every permission in the catalogue, outside the role system. */
  isOwner: boolean;
  roleId: number | null;
  roleName: string | null;
  /** Resolved keys. For an owner this is the whole catalogue. */
  keys: ReadonlySet<string>;
}

/**
 * Long enough to spare a page load a query per call, short enough that a change made
 * straight in the database is not confusing for long. In-app changes do not wait for it —
 * they call `invalidateAccess`.
 */
const TTL_MS = 10_000;

const cache = new Map<number, { access: Access | null; at: number }>();

/**
 * Forget what we know about a user's permissions. Called with a user id when that user
 * changed, and with nothing when a ROLE changed — a role is held by many people and
 * working out which would mean the query the cache exists to avoid.
 */
export function invalidateAccess(userId?: number): void {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}

/** Every key in the catalogue, as the set an owner is treated as holding. */
const ALL_KEYS: ReadonlySet<string> = new Set(PERMISSION_KEYS);

export async function resolveAccess(userId: number): Promise<Access | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.access;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: { include: { permissions: true } } },
  });

  let access: Access | null = null;
  if (user && user.isActive) {
    // An inactive role grants nothing. It is how a role is retired without deleting it and
    // without silently leaving its holders with the permissions it used to carry.
    const granted = user.role?.isActive ? user.role.permissions.map((p) => p.key) : [];
    access = {
      userId: user.id,
      name: user.name,
      email: user.email,
      isOwner: user.isOwner,
      roleId: user.roleId,
      roleName: user.role?.name ?? null,
      // Keys that are no longer in the catalogue are dropped here as well as on save: a
      // permission removed from the code must stop granting anything immediately, even
      // though its row may still be sitting in the database.
      keys: user.isOwner ? ALL_KEYS : new Set(granted.filter((k) => ALL_KEYS.has(k))),
    };
  }

  cache.set(userId, { access, at: Date.now() });
  return access;
}

/** Does this access hold every one of these keys? An owner always does. */
export function holdsAll(access: Access | undefined, keys: readonly string[]): boolean {
  if (!access) return false;
  if (access.isOwner) return true;
  return keys.every((k) => access.keys.has(k));
}

/** Does this access hold at least one of these keys? */
export function holdsAny(access: Access | undefined, keys: readonly string[]): boolean {
  if (!access) return false;
  if (access.isOwner) return true;
  return keys.some((k) => access.keys.has(k));
}
