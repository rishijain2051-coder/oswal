import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { ApiError, asyncHandler, guardIdParams } from '../lib/http';
import { authenticate, requireRole, ROLES } from '../middleware/auth';
import { hashPassword } from '../lib/auth';

const router = Router();
// A route param here is always a database id — see guardIdParams.
guardIdParams(router);
router.use(authenticate, requireRole('Admin'));

const select = { id: true, name: true, email: true, role: true, isActive: true, createdAt: true } as const;

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({ select, orderBy: { name: 'asc' } });
    res.json(users);
  })
);

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(ROLES),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);
    const user = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email.toLowerCase(),
        role: data.role,
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
  role: z.enum(ROLES).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(6).optional(),
});

/** The last active Admin must stay an active Admin, or nobody can administer. */
async function guardLastAdmin(id: number, next: { role?: string; isActive?: boolean }) {
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) throw new ApiError(404, 'User not found.');
  const losingAdmin = target.role === 'Admin' && target.isActive && ((next.role !== undefined && next.role !== 'Admin') || next.isActive === false);
  if (!losingAdmin) return;
  const others = await prisma.user.count({ where: { role: 'Admin', isActive: true, id: { not: id } } });
  if (others === 0) throw new ApiError(409, 'This is the only active Admin — promote someone else first.');
}

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const data = updateSchema.parse(req.body);
    await guardLastAdmin(id, { role: data.role, isActive: data.isActive });

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
        ...(data.role !== undefined ? { role: data.role } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.password ? { passwordHash: await hashPassword(data.password) } : {}),
      },
      select,
    });
    res.json(user);
  })
);

/**
 * Hard delete, for accounts created in error. Anyone who has actually done work is
 * kept and deactivated instead, so the "created by" trail on their products survives.
 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user!.sub) throw new ApiError(400, 'You cannot delete the account you are signed in with.');
    await guardLastAdmin(id, { isActive: false });

    const user = await prisma.user.findUnique({ where: { id }, include: { _count: { select: { productsCreated: true } } } });
    if (!user) throw new ApiError(404, 'User not found.');
    if (user._count.productsCreated > 0) {
      throw new ApiError(409, `${user.name} created ${user._count.productsCreated} product(s) — deactivate the account instead so the record of who made what survives.`);
    }
    await prisma.user.delete({ where: { id } });
    res.status(204).end();
  })
);

export default router;
