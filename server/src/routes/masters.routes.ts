import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { ApiError, asyncHandler, guardIdParams } from '../lib/http';
import { authenticate, requireRole } from '../middleware/auth';
import { ALLOWED_VARS } from '../lib/costing';
import { validateExpr } from '../lib/expr';
import { CHANNELS, MARKETS } from '../lib/pricing';
import { ensureCompany } from '../lib/company';
import { like } from '../lib/search';
import { trashedNote } from '../lib/references';
import { imageUploader, keepRealImages, uploadDir } from '../lib/imageUpload';
import fs from 'node:fs';
import path from 'node:path';

const router = Router();
// A route param here is always a database id — see guardIdParams.
guardIdParams(router);
router.use(authenticate);

// Managers+ may edit master data; everyone may read.
const canEdit = requireRole('Manager');

// ---------------------------------------------------------------------------
// Currencies
// ---------------------------------------------------------------------------

router.get(
  '/currencies',
  asyncHandler(async (_req, res) => {
    res.json(await prisma.currency.findMany({ orderBy: [{ isBase: 'desc' }, { code: 'asc' }] }));
  })
);

const currencySchema = z.object({
  code: z.string().min(1).max(8),
  name: z.string().min(1),
  symbol: z.string().max(8).optional().default(''),
  rateToBase: z.number().positive().default(1),
  isBase: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
});

router.post(
  '/currencies',
  canEdit,
  asyncHandler(async (req, res) => {
    const data = currencySchema.parse(req.body);
    const created = await prisma.$transaction(async (tx) => {
      if (data.isBase) await tx.currency.updateMany({ data: { isBase: false }, where: {} });
      return tx.currency.create({
        data: { ...data, code: data.code.toUpperCase(), rateToBase: data.isBase ? 1 : data.rateToBase },
      });
    });
    res.status(201).json(created);
  })
);

router.patch(
  '/currencies/:id',
  canEdit,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const data = currencySchema.partial().parse(req.body);
    const updated = await prisma.$transaction(async (tx) => {
      if (data.isBase) await tx.currency.updateMany({ data: { isBase: false }, where: { id: { not: id } } });
      return tx.currency.update({
        where: { id },
        data: { ...data, ...(data.code ? { code: data.code.toUpperCase() } : {}), ...(data.isBase ? { rateToBase: 1 } : {}) },
      });
    });
    res.json(updated);
  })
);

router.delete(
  '/currencies/:id',
  canEdit,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const cur = await prisma.currency.findUnique({ where: { id } });
    if (!cur) throw new ApiError(404, 'Currency not found.');
    if (cur.isBase) throw new ApiError(400, 'Cannot delete the base currency.');
    const [orders, proformas, sheets] = await Promise.all([
      prisma.order.count({ where: { currencyId: id } }),
      prisma.proforma.count({ where: { currencyId: id } }),
      prisma.costSheet.count({ where: { currencyId: id } }),
    ]);
    if (orders + proformas + sheets > 0) {
      const bits = [orders && `${orders} order(s)`, proformas && `${proformas} proforma(s)`, sheets && `${sheets} costing sheet(s)`].filter(Boolean).join(', ');
      throw new ApiError(409, `${cur.code} is used by ${bits}.${await trashedNote([
        { model: 'order', where: { currencyId: id } },
        { model: 'proforma', where: { currencyId: id } },
      ])} Deactivate it instead of deleting.`);
    }
    await prisma.currency.delete({ where: { id } });
    res.status(204).end();
  })
);

// Bulk-update exchange rates (used by the ICEGATE export-rate importer).
const bulkRatesSchema = z.object({
  rates: z.array(z.object({ code: z.string().min(1), rateToBase: z.number().positive() })),
});

router.post(
  '/currencies/bulk-rates',
  canEdit,
  asyncHandler(async (req, res) => {
    const { rates } = bulkRatesSchema.parse(req.body);
    let updated = 0;
    const unmatched: string[] = [];
    for (const r of rates) {
      const cur = await prisma.currency.findUnique({ where: { code: r.code.toUpperCase() } });
      if (!cur) {
        unmatched.push(r.code);
        continue;
      }
      if (cur.isBase) continue; // base currency stays at 1
      await prisma.currency.update({ where: { id: cur.id }, data: { rateToBase: r.rateToBase } });
      updated++;
    }
    res.json({ updated, unmatched });
  })
);

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

router.get(
  '/units',
  asyncHandler(async (_req, res) => {
    res.json(await prisma.unit.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] }));
  })
);

const unitSchema = z.object({
  code: z.string().min(1).max(12),
  name: z.string().min(1),
  sortOrder: z.number().int().optional().default(0),
  isActive: z.boolean().optional().default(true),
});

router.post(
  '/units',
  canEdit,
  asyncHandler(async (req, res) => {
    const data = unitSchema.parse(req.body);
    res.status(201).json(await prisma.unit.create({ data: { ...data, code: data.code.toUpperCase() } }));
  })
);

router.patch(
  '/units/:id',
  canEdit,
  asyncHandler(async (req, res) => {
    const data = unitSchema.partial().parse(req.body);
    res.json(
      await prisma.unit.update({
        where: { id: Number(req.params.id) },
        data: { ...data, ...(data.code ? { code: data.code.toUpperCase() } : {}) },
      })
    );
  })
);

router.delete(
  '/units/:id',
  canEdit,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const inUse = await prisma.product.count({ where: { unitId: id } });
    if (inUse > 0) throw new ApiError(409, `This unit is used by ${inUse} product(s).${await trashedNote([{ model: 'product', where: { unitId: id } }])} Deactivate it instead of deleting.`);
    await prisma.unit.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Company — who WE are
// ---------------------------------------------------------------------------

/**
 * Singleton (id = 1). `state` is the field with teeth: comparing it against the buyer's
 * is what makes a domestic sale CGST+SGST or IGST, so the split is derived from the two
 * addresses rather than typed on a document.
 */
router.get(
  '/company',
  asyncHandler(async (_req, res) => {
    res.json(await ensureCompany());
  })
);

const companySchema = z.object({
  legalName: z.string().min(1),
  tradeName: z.string().nullable().optional(),
  addressL1: z.string().nullable().optional(),
  addressL2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  pincode: z.string().nullable().optional(),
  country: z.string().min(1).default('India'),
  gstNo: z.string().nullable().optional(),
  panNo: z.string().nullable().optional(),
  iecNo: z.string().nullable().optional(),
  // logoFilename is deliberately NOT here. It is written only by POST /company/logo,
  // which produces the name itself. Accepting it from the client meant an Admin could
  // point it at `../prisma/schema.prisma` and then DELETE /company/logo would unlink
  // that file — and any path would be embedded into every PDF letterhead.
  cinNo: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().optional().or(z.literal('')).nullable(),
  website: z.string().nullable().optional(),
  bankDetails: z.string().nullable().optional(),
});

router.put(
  '/company',
  requireRole('Admin'),
  asyncHandler(async (req, res) => {
    const data = companySchema.parse(req.body);
    await ensureCompany();
    const saved = await prisma.company.update({ where: { id: 1 }, data });
    // Clearing our own state would restate the tax split on every domestic document, so
    // say so rather than letting it happen quietly.
    if (!saved.state) {
      const domestic = await prisma.buyer.count({ where: { market: 'DOMESTIC' } });
      if (domestic > 0) {
        res.json({ ...saved, warning: `Without a state, all ${domestic} domestic buyer(s) will be charged IGST rather than CGST + SGST.` });
        return;
      }
    }
    res.json(saved);
  })
);

/**
 * Letterhead logo. Goes through the same pipeline as product photos — extension
 * allow-list, then the magic bytes are checked and anything that is not really an image
 * is unlinked — because a declared mimetype proves nothing.
 *
 * Only one logo exists at a time, so the previous file is removed on replace rather than
 * left orphaned in uploads.
 */
/**
 * Remove a logo file, and ONLY ever a file directly inside `uploads`.
 *
 * The stored name is produced by the uploader so it is safe today, but an unlink built by
 * joining a database string to a directory is one bad write away from deleting anything on
 * the disk. Refuse anything that is not a bare filename.
 */
async function unlinkLogo(filename: string): Promise<void> {
  const safeName = path.basename(filename);
  if (safeName !== filename || !safeName.startsWith('company-logo-')) return;
  await fs.promises.unlink(path.join(uploadDir, safeName)).catch(() => undefined);
}

const uploadLogo = imageUploader('company-logo-');

router.post(
  '/company/logo',
  requireRole('Admin'),
  uploadLogo.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, 'No file was uploaded.');
    const [kept] = keepRealImages([req.file]);
    const current = await ensureCompany();
    const saved = await prisma.company.update({ where: { id: 1 }, data: { logoFilename: kept.filename } });
    // Only after the new one is committed, so a failed write never leaves us with none.
    if (current.logoFilename && current.logoFilename !== kept.filename) {
      await unlinkLogo(current.logoFilename);
    }
    res.status(201).json(saved);
  })
);

router.delete(
  '/company/logo',
  requireRole('Admin'),
  asyncHandler(async (_req, res) => {
    const current = await ensureCompany();
    if (!current.logoFilename) throw new ApiError(404, 'There is no logo to remove.');
    const saved = await prisma.company.update({ where: { id: 1 }, data: { logoFilename: null } });
    await unlinkLogo(current.logoFilename);
    res.json(saved);
  })
);

// ---------------------------------------------------------------------------
// Container types
//
// Admin-defined DATA, like cost formulas and stage lines — a new box size is a row, not a
// release. `isActive`, never `deletedAt`: master data already has a way to hide a row.
// ---------------------------------------------------------------------------

router.get(
  '/container-types',
  asyncHandler(async (req, res) => {
    const activeOnly = String(req.query.activeOnly ?? '') === '1';
    res.json(
      await prisma.containerType.findMany({
        where: activeOnly ? { isActive: true } : undefined,
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      })
    );
  })
);

const containerTypeSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(80),
  /**
   * Zero means "not a container" — an LCL part load — and `containerFit` treats it as having
   * no limit to exceed rather than as a box that everything overflows.
   */
  capacityCbm: z.number().nonnegative().default(0),
  payloadKg: z.number().nonnegative().default(0),
  sortOrder: z.number().int().optional().default(0),
  isActive: z.boolean().optional().default(true),
});

router.post(
  '/container-types',
  requireRole('Manager'),
  asyncHandler(async (req, res) => {
    const data = containerTypeSchema.parse(req.body);
    res.status(201).json(await prisma.containerType.create({ data: { ...data, code: data.code.toUpperCase() } }));
  })
);

router.put(
  '/container-types/:id',
  requireRole('Manager'),
  asyncHandler(async (req, res) => {
    const data = containerTypeSchema.partial().parse(req.body);
    res.json(
      await prisma.containerType.update({
        where: { id: Number(req.params.id) },
        data: { ...data, ...(data.code ? { code: data.code.toUpperCase() } : {}) },
      })
    );
  })
);

/** Report what references it rather than letting a foreign key surface as a 500. */
router.delete(
  '/container-types/:id',
  requireRole('Admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.containerType.findUnique({ where: { id } });
    if (!existing) throw new ApiError(404, 'Container type not found.');
    const used = await prisma.shipmentContainer.count({ where: { containerTypeId: id } });
    if (used > 0) {
      throw new ApiError(409, `${existing.code} is on ${used} container(s) already. Mark it inactive instead — the shipments that used it must keep their capacities.`);
    }
    await prisma.containerType.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Buyers
// ---------------------------------------------------------------------------

router.get(
  '/buyers',
  asyncHandler(async (req, res) => {
    const q = (req.query.q as string | undefined)?.trim();
    res.json(
      await prisma.buyer.findMany({
        where: q ? { OR: [{ name: like(q) }, { code: like(q) }] } : undefined,
        orderBy: { name: 'asc' },
      })
    );
  })
);

const buyerSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  country: z.string().optional().nullable(),
  contactName: z.string().optional().nullable(),
  email: z.string().email().optional().or(z.literal('')).nullable(),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
  /**
   * Who they are and where they are — two independent settings, so all four
   * combinations work. They decide the price basis (FOB vs Non-FOB), the document
   * series and whether GST applies.
   */
  channel: z.enum(CHANNELS).optional().default('B2B'),
  market: z.enum(MARKETS).optional().default('OVERSEAS'),
  gstNo: z.string().optional().nullable(),
  /** Compared with the company's state to pick CGST+SGST versus IGST. */
  state: z.string().optional().nullable(),
});

/**
 * A domestic buyer with no state cannot be taxed correctly — `sameState` treats an
 * unknown state as a non-match, so they would silently be charged IGST. Refuse rather
 * than let a wrong tax split reach a document.
 */
function checkBuyerTax(data: Partial<z.output<typeof buyerSchema>>, existing?: { market: string; state: string | null }) {
  const market = data.market ?? existing?.market ?? 'OVERSEAS';
  if (market !== 'DOMESTIC') return;
  const state = data.state !== undefined ? data.state : existing?.state;
  if (!state || !state.trim()) {
    throw new ApiError(400, 'A domestic buyer needs a state — it decides whether the sale is CGST + SGST or IGST.');
  }
}

router.post(
  '/buyers',
  canEdit,
  asyncHandler(async (req, res) => {
    const data = buyerSchema.parse(req.body);
    checkBuyerTax(data);
    res.status(201).json(await prisma.buyer.create({ data: { ...data, code: data.code.toUpperCase() } }));
  })
);

router.patch(
  '/buyers/:id',
  canEdit,
  asyncHandler(async (req, res) => {
    const data = buyerSchema.partial().parse(req.body);
    const id = Number(req.params.id);
    const existing = await prisma.buyer.findUnique({ where: { id }, select: { market: true, state: true } });
    if (!existing) throw new ApiError(404, 'Buyer not found.');
    checkBuyerTax(data, existing);
    res.json(
      await prisma.buyer.update({
        where: { id },
        data: { ...data, ...(data.code ? { code: data.code.toUpperCase() } : {}) },
      })
    );
  })
);

router.delete(
  '/buyers/:id',
  canEdit,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const buyer = await prisma.buyer.findUnique({ where: { id } });
    if (!buyer) throw new ApiError(404, 'Buyer not found.');
    const [orders, proformas, products, ledger] = await Promise.all([
      prisma.order.count({ where: { buyerId: id } }),
      prisma.proforma.count({ where: { buyerId: id } }),
      prisma.productBuyer.count({ where: { buyerId: id } }),
      prisma.ledgerEntry.count({ where: { buyerId: id } }),
    ]);
    if (orders + proformas + products + ledger > 0) {
      const bits = [orders && `${orders} order(s)`, proformas && `${proformas} proforma(s)`, products && `${products} product link(s)`, ledger && `${ledger} money entry/entries`].filter(Boolean).join(', ');
      throw new ApiError(409, `${buyer.name} has ${bits}.${await trashedNote([
        { model: 'order', where: { buyerId: id } },
        { model: 'proforma', where: { buyerId: id } },
        { model: 'ledgerEntry', where: { buyerId: id } },
      ])} Deactivate them instead of deleting.`);
    }
    await prisma.buyer.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Attribute values (product type / size / colour / material / finish / item type)
// ---------------------------------------------------------------------------

router.get(
  '/attributes',
  asyncHandler(async (req, res) => {
    const type = req.query.type as string | undefined;
    res.json(
      await prisma.attributeValue.findMany({
        where: type ? { type } : undefined,
        orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }, { value: 'asc' }],
      })
    );
  })
);

const attrSchema = z.object({
  type: z.string().min(1),
  value: z.string().min(1),
  code: z.string().optional().nullable(),
  sortOrder: z.number().int().optional().default(0),
  isActive: z.boolean().optional().default(true),
});

router.post(
  '/attributes',
  canEdit,
  asyncHandler(async (req, res) => {
    const data = attrSchema.parse(req.body);
    res.status(201).json(await prisma.attributeValue.create({ data: { ...data, type: data.type.toUpperCase() } }));
  })
);

router.patch(
  '/attributes/:id',
  canEdit,
  asyncHandler(async (req, res) => {
    const data = attrSchema.partial().parse(req.body);
    res.json(await prisma.attributeValue.update({ where: { id: Number(req.params.id) }, data }));
  })
);

router.delete(
  '/attributes/:id',
  canEdit,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const attr = await prisma.attributeValue.findUnique({ where: { id } });
    if (!attr) throw new ApiError(404, 'Value not found.');
    const inUse = await prisma.product.count({
      where: { OR: [{ itemTypeId: id }, { productTypeId: id }, { sizeId: id }, { colourId: id }, { materialId: id }, { finishId: id }] },
    });
    if (inUse > 0)
      throw new ApiError(
        409,
        `"${attr.value}" is used by ${inUse} product(s).${await trashedNote([
          { model: 'product', where: { OR: [{ itemTypeId: id }, { productTypeId: id }, { sizeId: id }, { colourId: id }, { materialId: id }, { finishId: id }] } },
        ])} Deactivate it instead of deleting.`
      );
    await prisma.attributeValue.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Stage lines — named production routes (products are assigned one)
// ---------------------------------------------------------------------------

const stageLineInclude = { steps: { orderBy: { sortOrder: 'asc' as const } }, _count: { select: { products: true, orderLines: true } } };

router.get(
  '/stage-lines',
  asyncHandler(async (_req, res) => {
    res.json(await prisma.stageLine.findMany({ include: stageLineInclude, orderBy: [{ isDefault: 'desc' }, { code: 'asc' }] }));
  })
);

/** Normalise a step, whichever form it arrived in. */
function stepRow(step: string | { name: string; defaultDays?: number | null }) {
  return typeof step === 'string' ? { name: step.trim(), defaultDays: null } : { name: step.name.trim(), defaultDays: step.defaultDays ?? null };
}

const stageLineSchema = z.object({
  code: z.string().min(1).max(16),
  name: z.string().min(1),
  isDefault: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
  notes: z.string().nullable().optional(),
  /**
   * Accepts either a bare name or `{ name, defaultDays }`. The plain-string form is kept
   * so existing callers and the seeds keep working unchanged.
   */
  steps: z
    .array(z.union([z.string().min(1), z.object({ name: z.string().min(1), defaultDays: z.number().int().min(0).nullable().optional() })]))
    .min(1, 'A stage line needs at least one stage.'),
});

router.post(
  '/stage-lines',
  canEdit,
  asyncHandler(async (req, res) => {
    const data = stageLineSchema.parse(req.body);
    const created = await prisma.$transaction(async (tx) => {
      if (data.isDefault) await tx.stageLine.updateMany({ data: { isDefault: false }, where: {} });
      return tx.stageLine.create({
        data: {
          code: data.code.toUpperCase(),
          name: data.name,
          isDefault: data.isDefault,
          isActive: data.isActive,
          notes: data.notes ?? null,
          steps: { create: data.steps.map((st, i) => ({ ...stepRow(st), sortOrder: i })) },
        },
        include: stageLineInclude,
      });
    });
    res.status(201).json(created);
  })
);

/**
 * Editing a stage line never disturbs live orders: each order line keeps its own
 * snapshot of the steps (OrderLineStage), so masters stay freely editable.
 */
router.patch(
  '/stage-lines/:id',
  canEdit,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const data = stageLineSchema.partial().parse(req.body);
    if (data.steps && data.steps.length === 0) throw new ApiError(400, 'A stage line needs at least one stage.');
    const updated = await prisma.$transaction(async (tx) => {
      if (data.isDefault) await tx.stageLine.updateMany({ data: { isDefault: false }, where: { id: { not: id } } });
      await tx.stageLine.update({
        where: { id },
        data: {
          ...(data.code ? { code: data.code.toUpperCase() } : {}),
          ...(data.name ? { name: data.name } : {}),
          ...(data.isDefault !== undefined ? { isDefault: data.isDefault } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
        },
      });
      if (data.steps) {
        await tx.stageLineStep.deleteMany({ where: { stageLineId: id } });
        for (let i = 0; i < data.steps.length; i++) await tx.stageLineStep.create({ data: { stageLineId: id, ...stepRow(data.steps[i]), sortOrder: i } });
      }
      return tx.stageLine.findUnique({ where: { id }, include: stageLineInclude });
    });
    res.json(updated);
  })
);

router.delete(
  '/stage-lines/:id',
  canEdit,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const line = await prisma.stageLine.findUnique({ where: { id }, include: { _count: { select: { products: true, orderLines: true } } } });
    if (!line) throw new ApiError(404, 'Stage line not found.');
    const { products, orderLines } = line._count;
    if (products + orderLines > 0) {
      throw new ApiError(409, `${line.code} is used by ${products} product(s) and ${orderLines} order line(s). Deactivate it instead of deleting.`);
    }
    await prisma.stageLine.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Cost methods (user-editable costing formulas)
// ---------------------------------------------------------------------------

router.get(
  '/methods',
  asyncHandler(async (_req, res) => {
    res.json(await prisma.costMethod.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] }));
  })
);

const methodSchema = z.object({
  code: z.string().min(1).max(16),
  label: z.string().min(1),
  measureUnit: z.string().min(1).default('UNIT'),
  expression: z.string().min(1),
  usesL: z.boolean().optional().default(false),
  usesW: z.boolean().optional().default(false),
  usesH: z.boolean().optional().default(false),
  usesWeight: z.boolean().optional().default(false),
  usesWastage: z.boolean().optional().default(true),
  dimUnit: z.string().optional().nullable(),
  sortOrder: z.number().int().optional().default(0),
  isActive: z.boolean().optional().default(true),
});

function checkExpr(expr?: string) {
  if (expr === undefined) return;
  const err = validateExpr(expr, ALLOWED_VARS);
  if (err) throw new ApiError(400, `Invalid formula: ${err}. Allowed variables: ${ALLOWED_VARS.join(', ')}.`);
}

router.post(
  '/methods',
  canEdit,
  asyncHandler(async (req, res) => {
    const data = methodSchema.parse(req.body);
    checkExpr(data.expression);
    res.status(201).json(await prisma.costMethod.create({ data: { ...data, code: data.code.toUpperCase() } }));
  })
);

router.patch(
  '/methods/:id',
  canEdit,
  asyncHandler(async (req, res) => {
    const data = methodSchema.partial().parse(req.body);
    checkExpr(data.expression);
    res.json(
      await prisma.costMethod.update({
        where: { id: Number(req.params.id) },
        data: { ...data, ...(data.code ? { code: data.code.toUpperCase() } : {}) },
      })
    );
  })
);

router.delete(
  '/methods/:id',
  canEdit,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const method = await prisma.costMethod.findUnique({ where: { id } });
    if (!method) throw new ApiError(404, 'Method not found.');
    if (method.isBuiltIn) throw new ApiError(400, 'Built-in methods cannot be deleted (you can edit or deactivate them).');
    const inUse = await prisma.costGroup.count({ where: { method: method.code } });
    if (inUse > 0) throw new ApiError(409, `This method is used by ${inUse} cost group(s). Deactivate it instead.`);
    await prisma.costMethod.delete({ where: { id } });
    res.status(204).end();
  })
);

export default router;
