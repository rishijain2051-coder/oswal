/**
 * Roles, and the catalogue of permissions they are built from.
 *
 * The app ships NO roles. There is no built-in rank, no "Manager" hiding in a constant —
 * every role in the system was created here by somebody. What the app does ship is the
 * catalogue (`lib/permissions.ts`), which is code, because a permission is only real if a
 * route enforces it.
 *
 * Two refusals keep the app from being locked shut, and both are here rather than in the
 * client, where they would be advice rather than a rule:
 *
 * 1. You cannot take `roles.manage` away from the role you yourself hold. Permissions are
 *    resolved live, so the request after that one would already be refused — including the
 *    request to put it back.
 * 2. A role somebody still holds cannot be deleted. The app reports how many people hold it,
 *    following the convention the other delete routes use, rather than letting a foreign key
 *    surface as a 500.
 *
 * An owner bypasses both, because an owner bypasses the whole role system. That is what
 * makes the first rule safe rather than merely hopeful.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { ApiError, asyncHandler, guardIdParams } from '../lib/http';
import { authenticate, can } from '../middleware/auth';
import { invalidateAccess } from '../lib/access';
import { PERMISSIONS, isPermissionKey, permissionsByModule, withRequired } from '../lib/permissions';

const router = Router();
guardIdParams(router);
router.use(authenticate);

/**
 * The catalogue itself. Behind `roles.view` rather than open to any signed-in user: it is a
 * complete description of what the application can do and how it is guarded, which is not
 * something every login needs. Served rather than mirrored into the client so there is
 * exactly one copy of the prose and it cannot drift.
 */
router.get(
  '/permissions',
  can('roles.view'),
  asyncHandler(async (_req, res) => {
    res.json({ modules: permissionsByModule(), permissions: PERMISSIONS });
  })
);

const withCounts = {
  include: { permissions: { select: { key: true } }, _count: { select: { users: true } } },
} as const;

type RoleRow = {
  id: number;
  name: string;
  description: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  permissions: { key: string }[];
  _count: { users: number };
};

const toApi = (r: RoleRow) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  isActive: r.isActive,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  users: r._count.users,
  // Keys no longer in the catalogue are hidden here as they are ignored at resolution — a
  // permission removed from the code must not linger in the UI as a checkbox for nothing.
  permissions: r.permissions.map((p) => p.key).filter(isPermissionKey).sort(),
});

router.get(
  '/',
  can('roles.view'),
  asyncHandler(async (_req, res) => {
    const roles = await prisma.role.findMany({ ...withCounts, orderBy: { name: 'asc' } });
    res.json(roles.map(toApi));
  })
);

router.get(
  '/:id',
  can('roles.view'),
  asyncHandler(async (req, res) => {
    const role = await prisma.role.findUnique({ where: { id: Number(req.params.id) }, ...withCounts });
    if (!role) throw new ApiError(404, 'Role not found.');
    res.json(toApi(role));
  })
);

const roleSchema = z.object({
  name: z.string().min(1, 'Give the role a name.').max(60),
  description: z.string().max(500).optional(),
  isActive: z.boolean().optional(),
  permissions: z.array(z.string()).optional(),
});

/**
 * Unknown keys are REFUSED rather than silently dropped. A typo in a key would otherwise
 * save as a role that grants less than the screen said it did, which is the kind of quiet
 * failure permissions must not have.
 */
function checkKeys(keys: string[]): string[] {
  const unknown = keys.filter((k) => !isPermissionKey(k));
  if (unknown.length) throw new ApiError(400, `Unknown permission(s): ${unknown.join(', ')}.`);
  // Closing over `requires` happens on the way IN, once, so what is stored is what is
  // enforced. Doing it at check time instead would make enforcement depend on the shape of
  // the catalogue rather than on the route's own stated requirements.
  return withRequired(keys);
}

router.post(
  '/',
  can('roles.manage'),
  asyncHandler(async (req, res) => {
    const data = roleSchema.parse(req.body);
    const keys = checkKeys(data.permissions ?? []);

    const clash = await prisma.role.findUnique({ where: { name: data.name } });
    if (clash) throw new ApiError(409, `A role called "${data.name}" already exists.`);

    const role = await prisma.role.create({
      data: {
        name: data.name,
        description: data.description ?? '',
        isActive: data.isActive ?? true,
        permissions: { create: keys.map((key) => ({ key })) },
      },
      ...withCounts,
    });
    res.status(201).json(toApi(role));
  })
);

router.put(
  '/:id',
  can('roles.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const data = roleSchema.parse(req.body);
    const keys = checkKeys(data.permissions ?? []);

    const existing = await prisma.role.findUnique({ where: { id }, include: { permissions: true } });
    if (!existing) throw new ApiError(404, 'Role not found.');

    if (data.name !== existing.name) {
      const clash = await prisma.role.findUnique({ where: { name: data.name } });
      if (clash) throw new ApiError(409, `A role called "${data.name}" already exists.`);
    }

    // The lockout guard. An owner is exempt because their permissions do not come from a
    // role at all, so they can always repair a role that locked everybody else out.
    const isMine = req.access!.roleId === id;
    if (isMine && !req.access!.isOwner) {
      const losing = existing.permissions.some((p) => p.key === 'roles.manage') && !keys.includes('roles.manage');
      if (losing) {
        throw new ApiError(
          409,
          'This is your own role, and removing "Create and change roles" from it would leave you unable to put it back. Ask an owner, or grant another role this permission first.'
        );
      }
      if (data.isActive === false) {
        throw new ApiError(409, 'This is your own role — deactivating it would sign you out of everything.');
      }
    }

    // Replace rather than diff: the set is small and a replace cannot leave a stale row.
    const role = await prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      return tx.role.update({
        data: {
          name: data.name,
          description: data.description ?? '',
          isActive: data.isActive ?? true,
          permissions: { create: keys.map((key) => ({ key })) },
        },
        where: { id },
        ...withCounts,
      });
    });

    // A role is held by many people, so everybody's cached permissions go.
    invalidateAccess();
    res.json(toApi(role));
  })
);

router.delete(
  '/:id',
  can('roles.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const role = await prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) throw new ApiError(404, 'Role not found.');

    if (role._count.users > 0) {
      throw new ApiError(
        409,
        `${role._count.users} user(s) still hold "${role.name}". Move them to another role first, or deactivate this one instead of deleting it.`
      );
    }

    // The permission rows go with it — see onDelete: Cascade on RolePermission.
    await prisma.role.delete({ where: { id } });
    invalidateAccess();
    res.status(204).end();
  })
);

export default router;
