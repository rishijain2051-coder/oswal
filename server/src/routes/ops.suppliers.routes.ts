import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { ApiError, asyncHandler, guardIdParams } from '../lib/http';
import { authenticate, can, canAny } from '../middleware/auth';
import { round } from '../lib/costing';
import { like } from '../lib/search';
import { trashedNote } from '../lib/references';

const router = Router();
// A route param here is always a database id — see guardIdParams.
guardIdParams(router);
router.use(authenticate);

// ---------------------------------------------------------------------------
// Suppliers (material + jobwork vendors)
// ---------------------------------------------------------------------------

router.get(
  '/suppliers',
  canAny('suppliers.view', 'board.routing'),
  asyncHandler(async (req, res) => {
    const q = (req.query.q as string | undefined)?.trim();
    const type = req.query.type as string | undefined;
    const where: any = {};
    if (type) where.type = type === 'JOBWORK' ? { in: ['JOBWORK', 'BOTH'] } : type === 'MATERIAL' ? { in: ['MATERIAL', 'BOTH'] } : type;
    if (q) where.OR = [{ name: like(q) }, { code: like(q) }];
    res.json(await prisma.supplier.findMany({ where, orderBy: { name: 'asc' } }));
  })
);

const supplierSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['MATERIAL', 'JOBWORK', 'BOTH']).default('MATERIAL'),
  contactName: z.string().nullable().optional(),
  email: z.string().email().or(z.literal('')).nullable().optional(),
  phone: z.string().nullable().optional(),
  gstNo: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  paymentTerms: z.string().nullable().optional(),
  isActive: z.boolean().optional().default(true),
});

router.post(
  '/suppliers',
  can('suppliers.view', 'suppliers.manage'),
  asyncHandler(async (req, res) => {
    const data = supplierSchema.parse(req.body);
    res.status(201).json(await prisma.supplier.create({ data: { ...data, code: data.code.toUpperCase() } }));
  })
);

router.patch(
  '/suppliers/:id',
  can('suppliers.view', 'suppliers.manage'),
  asyncHandler(async (req, res) => {
    const data = supplierSchema.partial().parse(req.body);
    res.json(await prisma.supplier.update({ where: { id: Number(req.params.id) }, data: { ...data, ...(data.code ? { code: data.code.toUpperCase() } : {}) } }));
  })
);

/**
 * Refused while anything still points at them. Without this the optional relations
 * would quietly null out — un-outsourcing live stages and wiping the jobwork they
 * had earned — which is a silent loss of money owed.
 */
router.delete(
  '/suppliers/:id',
  can('suppliers.view', 'suppliers.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const supplier = await prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new ApiError(404, 'Supplier not found.');
    const [stages, ledger, stock] = await Promise.all([
      prisma.orderLineStage.count({ where: { vendorId: id } }),
      prisma.ledgerEntry.count({ where: { supplierId: id } }),
      prisma.stockTxn.count({ where: { supplierId: id } }),
    ]);
    if (stages + ledger + stock > 0) {
      const bits = [stages && `${stages} production stage(s)`, ledger && `${ledger} money entry/entries`, stock && `${stock} stock movement(s)`].filter(Boolean).join(', ');
      throw new ApiError(409, `${supplier.name} is still referenced by ${bits}.${await trashedNote([{ model: 'ledgerEntry', where: { supplierId: id } }])} Deactivate them instead of deleting.`);
    }
    await prisma.supplier.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Raw items + stock balances
// ---------------------------------------------------------------------------

async function balances(): Promise<Record<number, { inQty: number; outQty: number }>> {
  const grouped = await prisma.stockTxn.groupBy({ by: ['rawItemId', 'type'], _sum: { qty: true } });
  const map: Record<number, { inQty: number; outQty: number }> = {};
  for (const g of grouped) {
    map[g.rawItemId] = map[g.rawItemId] || { inQty: 0, outQty: 0 };
    if (g.type === 'IN') map[g.rawItemId].inQty = g._sum.qty || 0;
    else map[g.rawItemId].outQty = g._sum.qty || 0;
  }
  return map;
}

/**
 * Attach the derived stock figures. Every route that returns a raw item goes through
 * this, so a created or edited item comes back in the same shape the list does — a bare
 * Prisma row would be missing `balance` and `low`, which the client declares as always
 * present.
 */
function decorateRawItem<T extends { id: number; openingQty: number; reorderLevel: number }>(it: T, bal: Awaited<ReturnType<typeof balances>>) {
  const b = bal[it.id] || { inQty: 0, outQty: 0 };
  const balance = round(it.openingQty + b.inQty - b.outQty, 3);
  return { ...it, inQty: round(b.inQty, 3), outQty: round(b.outQty, 3), balance, low: balance <= it.reorderLevel };
}

router.get(
  '/raw-items',
  canAny('rawitems.view', 'stock.view', 'sheets.view'),
  asyncHandler(async (_req, res) => {
    const [items, bal] = await Promise.all([prisma.rawItem.findMany({ orderBy: { name: 'asc' } }), balances()]);
    res.json(items.map((it) => decorateRawItem(it, bal)));
  })
);

const rawItemSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  category: z.string().nullable().optional(),
  unit: z.string().min(1).default('PCS'),
  reorderLevel: z.number().min(0).default(0),
  openingQty: z.number().default(0),
  isActive: z.boolean().optional().default(true),
});

router.post(
  '/raw-items',
  can('rawitems.view', 'rawitems.manage'),
  asyncHandler(async (req, res) => {
    const data = rawItemSchema.parse(req.body);
    const created = await prisma.rawItem.create({ data: { ...data, code: data.code.toUpperCase() } });
    res.status(201).json(decorateRawItem(created, await balances()));
  })
);

router.patch(
  '/raw-items/:id',
  can('rawitems.view', 'rawitems.manage'),
  asyncHandler(async (req, res) => {
    const data = rawItemSchema.partial().parse(req.body);
    const updated = await prisma.rawItem.update({ where: { id: Number(req.params.id) }, data: { ...data, ...(data.code ? { code: data.code.toUpperCase() } : {}) } });
    res.json(decorateRawItem(updated, await balances()));
  })
);

/** Refused once it has movements — deleting would cascade the stock history away. */
router.delete(
  '/raw-items/:id',
  can('rawitems.view', 'rawitems.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const item = await prisma.rawItem.findUnique({ where: { id } });
    if (!item) throw new ApiError(404, 'Item not found.');
    const txns = await prisma.stockTxn.count({ where: { rawItemId: id } });
    if (txns > 0) throw new ApiError(409, `${item.name} has ${txns} stock movement(s). Deactivate it instead of deleting.`);
    await prisma.rawItem.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Stock transactions (inward / outward)
// ---------------------------------------------------------------------------

router.get(
  '/stock/txns',
  can('stock.view'),
  asyncHandler(async (req, res) => {
    const rawItemId = req.query.rawItemId ? Number(req.query.rawItemId) : undefined;
    res.json(
      await prisma.stockTxn.findMany({
        where: rawItemId ? { rawItemId } : undefined,
        include: { rawItem: true, supplier: true },
        orderBy: { date: 'desc' },
        take: 200,
      })
    );
  })
);

const stockTxnSchema = z.object({
  rawItemId: z.number().int(),
  type: z.enum(['IN', 'OUT']),
  qty: z.number().positive(),
  rate: z.number().min(0).optional().default(0),
  supplierId: z.number().int().nullable().optional(),
  orderRef: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  date: z.string().datetime().optional(),
});

router.post(
  '/stock/txns',
  can('stock.view', 'stock.manage'),
  asyncHandler(async (req, res) => {
    const data = stockTxnSchema.parse(req.body);

    const item = await prisma.rawItem.findUnique({ where: { id: data.rawItemId } });
    if (!item) throw new ApiError(404, 'Raw item not found.');
    if (data.supplierId != null) {
      const supplier = await prisma.supplier.findUnique({ where: { id: data.supplierId } });
      if (!supplier) throw new ApiError(404, 'Supplier not found.');
    }

    // Stock may not be issued below zero — a negative balance is never real, and it
    // would quietly poison the low-stock alerts and every valuation built on them.
    if (data.type === 'OUT') {
      const bal = (await balances())[item.id] ?? { inQty: 0, outQty: 0 };
      const available = round(item.openingQty + bal.inQty - bal.outQty, 3);
      if (data.qty > available) throw new ApiError(409, `Only ${available} ${item.unit} of ${item.name} in stock — cannot issue ${data.qty}.`);
    }

    const txn = await prisma.stockTxn.create({
      data: {
        rawItemId: data.rawItemId,
        type: data.type,
        qty: data.qty,
        rate: data.rate ?? 0,
        supplierId: data.supplierId ?? null,
        orderRef: data.orderRef ?? null,
        note: data.note ?? null,
        date: data.date ? new Date(data.date) : new Date(),
        createdById: req.user!.sub,
      },
      include: { rawItem: true, supplier: true },
    });
    res.status(201).json(txn);
  })
);

router.delete(
  '/stock/txns/:id',
  can('stock.view', 'stock.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const txn = await prisma.stockTxn.findUnique({ where: { id }, include: { bill: { select: { id: true, ref: true } }, rawItem: { select: { name: true, unit: true } } } });
    if (!txn) throw new ApiError(404, 'Stock movement not found.');
    if (txn.bill) throw new ApiError(409, `This receipt is billed (${txn.bill.ref ?? `#${txn.bill.id}`}). Delete the bill first, or the money would be left pointing at nothing.`);

    // Removing an inward receipt must not push the balance negative either.
    if (txn.type === 'IN') {
      const bal = (await balances())[txn.rawItemId] ?? { inQty: 0, outQty: 0 };
      const item = await prisma.rawItem.findUnique({ where: { id: txn.rawItemId } });
      const after = round((item?.openingQty ?? 0) + bal.inQty - txn.qty - bal.outQty, 3);
      if (after < 0) throw new ApiError(409, `Removing this receipt would leave ${after} ${txn.rawItem.unit} of ${txn.rawItem.name}. Reverse the issues first.`);
    }
    await prisma.stockTxn.delete({ where: { id } });
    res.status(204).end();
  })
);

export default router;
