import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { ApiError, asyncHandler, guardIdParams } from '../lib/http';
import { authenticate, can, requireOwner } from '../middleware/auth';
import { invalidateAccess } from '../lib/access';
import { hashPassword } from '../lib/auth';

const router = Router();
// A route param here is always a database id — see guardIdParams.
guardIdParams(router);
router.use(authenticate);

const select = {
  id: true,
  name: true,
  email: true,
  isActive: true,
  isOwner: true,
  createdAt: true,
  role: { select: { id: true, name: true, isActive: true } },
} as const;

router.get(
  '/',
  can('users.view'),
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({ select, orderBy: { name: 'asc' } });
    res.json(users);
  })
);

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8, 'Use at least 8 characters.'),
  /** Null is allowed and means no permissions at all until a role is assigned. */
  roleId: z.number().int().nullable().optional(),
});

/** A role has to exist and be usable before somebody is put on it. */
async function checkRole(roleId: number | null | undefined): Promise<void> {
  if (roleId === null || roleId === undefined) return;
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) throw new ApiError(400, 'That role does not exist.');
  if (!role.isActive) throw new ApiError(400, `"${role.name}" is deactivated, so it would grant nothing. Reactivate it first.`);
}

router.post(
  '/',
  can('users.manage'),
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);
    await checkRole(data.roleId);

    const clash = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
    if (clash) throw new ApiError(409, 'Another account already uses that e-mail.');

    const user = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email.toLowerCase(),
        roleId: data.roleId ?? null,
        passwordHash: await hashPassword(data.password),
      },
      select,
    });
    res.status(201).json(user);
  })
);

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  roleId: z.number().int().nullable().optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8, 'Use at least 8 characters.').optional(),
});

/**
 * The last active OWNER must stay an active owner, or nobody can administer the app.
 *
 * This replaces the old "last active Admin" guard and carries more weight than that one did.
 * Under ranks a Manager could still do most things; now a role is whatever somebody made it,
 * and it is entirely possible for every role in the database to lack `roles.manage`. The
 * owner flag is the one thing that cannot be misconfigured into a locked door.
 */
async function guardLastOwner(id: number, next: { isOwner?: boolean; isActive?: boolean }): Promise<void> {
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) throw new ApiError(404, 'User not found.');

  const losing = target.isOwner && target.isActive && (next.isOwner === false || next.isActive === false);
  if (!losing) return;

  const others = await prisma.user.count({ where: { isOwner: true, isActive: true, id: { not: id } } });
  if (others === 0) {
    throw new ApiError(
      409,
      'This is the only owner — make somebody else an owner first, or the app would be left with nobody who can administer it.'
    );
  }
}

router.patch(
  '/:id',
  can('users.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const data = updateSchema.parse(req.body);
    await guardLastOwner(id, { isActive: data.isActive });
    await checkRole(data.roleId);

    // Emails are matched lower-cased on login, so they are stored that way.
    if (data.email) {
      const clash = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
      if (clash && clash.id !== id) throw new ApiError(409, 'Another account already uses that e-mail.');
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.email !== undefined ? { email: data.email.toLowerCase() } : {}),
        ...(data.roleId !== undefined ? { roleId: data.roleId } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.password ? { passwordHash: await hashPassword(data.password) } : {}),
      },
      select,
    });

    // Their next request must see the new role, not the one cached moments ago.
    invalidateAccess(id);
    res.json(user);
  })
);

/**
 * Owner status is granted and removed by an OWNER, never merely by somebody holding
 * `users.manage`. Otherwise the guard above is theatre: anyone who could edit users could
 * make themselves an owner and hold every permission in the catalogue.
 */
router.patch(
  '/:id/owner',
  requireOwner,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { isOwner } = z.object({ isOwner: z.boolean() }).parse(req.body);
    await guardLastOwner(id, { isOwner });

    const user = await prisma.user.update({ where: { id }, data: { isOwner }, select });
    invalidateAccess(id);
    res.json(user);
  })
);

/**
 * Hard delete, for accounts created in error. Anyone who has actually done work is
 * kept and deactivated instead, so the "created by" trail on their products survives.
 */
router.delete(
  '/:id',
  can('users.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.access!.userId) throw new ApiError(400, 'You cannot delete the account you are signed in with.');
    await guardLastOwner(id, { isActive: false });

    const user = await prisma.user.findUnique({ where: { id }, include: { _count: { select: { productsCreated: true } } } });
    if (!user) throw new ApiError(404, 'User not found.');
    if (user._count.productsCreated > 0) {
      throw new ApiError(
        409,
        `${user.name} created ${user._count.productsCreated} product(s) — deactivate the account instead so the record of who made what survives.`
      );
    }
    await prisma.user.delete({ where: { id } });
    invalidateAccess(id);
    res.status(204).end();
  })
);

export default router;
