import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db';
import { ApiError, asyncHandler, guardIdParams } from '../lib/http';
import { authenticate, can, may } from '../middleware/auth';
import { computeCostSheet } from '../lib/productCosting';
import { loadMethodMap } from '../lib/methods';
import { live, notDeleted, restore, softDelete } from '../lib/softDelete';
import { diffCostSheet, logChanges } from '../lib/changeLog';
import type { MethodMap } from '../lib/costing';
import { imageUploader, keepRealImages, uploadDir } from '../lib/imageUpload';
import { like } from '../lib/search';
import { trashedNote } from '../lib/references';

const router = Router();
// A route param here is always a database id — see guardIdParams.
guardIdParams(router);
router.use(authenticate);

// Image upload storage — see lib/imageUpload.ts for why contents are checked.
const upload = imageUploader('');

/**
 * A product's costing is the factory's cost base and margin, so it is a separate permission
 * from seeing the product at all — a sales person may need the specification and the photos
 * without the rates behind them.
 *
 * The stripping happens HERE, on the way out, rather than in the client. The cost sheet
 * shares a response with the specification, so filtering it in the browser would still put
 * every rate on the wire for anyone with a login. Same discipline as `redact()` for worker
 * identity in manforce.routes.ts.
 */
function stripCosting<T extends Record<string, any>>(row: T): T {
  const out: Record<string, any> = { ...row, costingHidden: true };
  // Only blank what the row actually has. The LIST rows carry `fob` / `exFactory` /
  // `nonFob` and the DETAIL row carries `costSheet`; adding the missing ones back as null
  // would make the redacted shape differ from the real one by more than its values, and a
  // reader checking `'fob' in product` would draw the wrong conclusion from it.
  for (const key of ['costSheet', 'currency', 'exFactory', 'fob', 'nonFob']) {
    if (key in out) out[key] = null;
  }
  return out as T;
}

const maybeStrip = <T extends Record<string, any>>(req: Parameters<typeof may>[0], rows: T[]): T[] =>
  may(req, 'products.costing.view') ? rows : rows.map(stripCosting);

/**
 * Saving a product REPLACES its cost sheet, so a save that carries one is a costing edit
 * whether or not any rate actually changed — and a save that carries none from somebody
 * without the permission would silently delete the sheet. Both are refused, which is why
 * this checks for the sheet's presence rather than diffing it.
 */
function guardCosting(req: Parameters<typeof may>[0], costSheet: unknown): void {
  if (costSheet == null) return;
  if (may(req, 'products.costing.edit')) return;
  throw new ApiError(403, 'You do not have permission to do this. Changing a product\'s rates needs "Edit product costings".');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const num = z.number().nullable().optional();

const lineSchema = z.object({
  name: z.string().min(1),
  qty: z.number().default(1),
  wastagePct: z.number().default(0),
  actualL: num,
  actualW: num,
  actualH: num,
  costL: num,
  costW: num,
  costH: num,
  actualWeight: num,
  unit: z.string().nullable().optional(),
  rate: z.number().default(0),
  sortOrder: z.number().int().optional().default(0),
  /**
   * Which production stage a LABOUR line pays for. Reference only: it seeds the
   * in-house piece rate when an order snapshots its stages (see
   * `labourRatesForProduct`) and has no effect whatsoever on the costing roll-up.
   */
  stageStepId: z.number().int().nullable().optional(),
});

const groupSchema = z.object({
  head: z.string().min(1),
  name: z.string().min(1),
  method: z.string().min(1),
  dimUnit: z.string().nullable().optional(),
  sortOrder: z.number().int().optional().default(0),
  notes: z.string().nullable().optional(),
  lines: z.array(lineSchema).default([]),
});

const costSheetSchema = z.object({
  currencyId: z.number().int().nullable().optional(),
  factoryExpensePct: z.number().default(15),
  marginPct: z.number().default(15),
  notes: z.string().nullable().optional(),
  groups: z.array(groupSchema).default([]),
});

const productSchema = z.object({
  factoryCode: z.string().min(1),
  name: z.string().min(1),
  alias: z.string().nullable().optional(),
  status: z.string().optional().default('Draft'),
  description: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  itemTypeId: z.number().int().nullable().optional(),
  productTypeId: z.number().int().nullable().optional(),
  sizeId: z.number().int().nullable().optional(),
  colourId: z.number().int().nullable().optional(),
  materialId: z.number().int().nullable().optional(),
  finishId: z.number().int().nullable().optional(),
  unitId: z.number().int().nullable().optional(),
  stageLineId: z.number().int().nullable().optional(),
  prodLengthIn: num,
  prodWidthIn: num,
  prodHeightIn: num,
  netWeightKg: num,
  grossWeightKg: num,
  packLengthIn: num,
  packWidthIn: num,
  packHeightIn: num,
  piecesPerCarton: z.number().int().nullable().optional(),
  volumeBeforePackingCbm: num,
  volumeAfterPackingCbm: num,
  /**
   * Tax classification for domestic sales. Seeds the rate and HSN on a domestic
   * proforma or order line; has no effect at all on the costing roll-up or on an export,
   * which is zero-rated.
   */
  hsnCode: z.string().nullable().optional(),
  gstRatePct: z.number().min(0).max(100).optional(),
  buyers: z
    .array(z.object({ buyerId: z.number().int(), buyerCode: z.string().nullable().optional() }))
    .default([]),
  related: z
    .array(z.object({ relatedId: z.number().int(), relation: z.string(), note: z.string().nullable().optional() }))
    .default([]),
  costSheet: costSheetSchema.nullable().optional(),
});

type ProductInput = z.infer<typeof productSchema>;

function scalarData(d: ProductInput) {
  return {
    factoryCode: d.factoryCode.trim(),
    name: d.name.trim(),
    alias: d.alias ?? null,
    status: d.status ?? 'Draft',
    description: d.description ?? null,
    notes: d.notes ?? null,
    itemTypeId: d.itemTypeId ?? null,
    productTypeId: d.productTypeId ?? null,
    sizeId: d.sizeId ?? null,
    colourId: d.colourId ?? null,
    materialId: d.materialId ?? null,
    finishId: d.finishId ?? null,
    unitId: d.unitId ?? null,
    stageLineId: d.stageLineId ?? null,
    prodLengthIn: d.prodLengthIn ?? null,
    prodWidthIn: d.prodWidthIn ?? null,
    prodHeightIn: d.prodHeightIn ?? null,
    netWeightKg: d.netWeightKg ?? null,
    grossWeightKg: d.grossWeightKg ?? null,
    packLengthIn: d.packLengthIn ?? null,
    packWidthIn: d.packWidthIn ?? null,
    packHeightIn: d.packHeightIn ?? null,
    piecesPerCarton: d.piecesPerCarton ?? null,
    volumeBeforePackingCbm: d.volumeBeforePackingCbm ?? null,
    volumeAfterPackingCbm: d.volumeAfterPackingCbm ?? null,
    hsnCode: d.hsnCode?.trim() || null,
    gstRatePct: d.gstRatePct ?? 18,
  };
}

function lineData(ln: z.infer<typeof lineSchema>) {
  return {
    name: ln.name,
    qty: ln.qty,
    wastagePct: ln.wastagePct,
    actualL: ln.actualL ?? null,
    actualW: ln.actualW ?? null,
    actualH: ln.actualH ?? null,
    costL: ln.costL ?? null,
    costW: ln.costW ?? null,
    costH: ln.costH ?? null,
    actualWeight: ln.actualWeight ?? null,
    unit: ln.unit ?? null,
    rate: ln.rate,
    sortOrder: ln.sortOrder ?? 0,
    stageStepId: ln.stageStepId ?? null,
  };
}

/**
 * A labour line may only point at a stage of the route the product actually travels.
 *
 * Otherwise the mapping is meaningless — an order snapshots the stages of its own
 * stage line, so a rate hung off some other line's step would never be found and the
 * stage would silently pay nothing.
 */
async function checkStageSteps(data: z.infer<typeof productSchema>) {
  const wanted = [...new Set((data.costSheet?.groups ?? []).flatMap((g) => g.lines.map((l) => l.stageStepId).filter((v): v is number => v != null)))];
  if (wanted.length === 0) return;
  if (!data.stageLineId) throw new ApiError(400, 'Assign a stage line to the product before mapping labour to its stages.');

  const steps = await prisma.stageLineStep.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true, stageLineId: true } });
  for (const id of wanted) {
    const step = steps.find((s) => s.id === id);
    if (!step) throw new ApiError(404, 'A labour line points at a production stage that no longer exists.');
    if (step.stageLineId !== data.stageLineId) throw new ApiError(400, `"${step.name}" is not a stage of this product's stage line.`);
  }
  for (const g of data.costSheet?.groups ?? []) {
    if (g.head === 'LABOUR') continue;
    if (g.lines.some((l) => l.stageStepId != null)) throw new ApiError(400, `Only labour lines can be mapped to a production stage — "${g.name}" is ${g.head.toLowerCase().replace('_', ' ')}.`);
  }
}

function costSheetCreate(cs: z.infer<typeof costSheetSchema>) {
  return {
    version: 1,
    isActive: true,
    currencyId: cs.currencyId ?? null,
    factoryExpensePct: cs.factoryExpensePct,
    marginPct: cs.marginPct,
    notes: cs.notes ?? null,
    groups: {
      create: cs.groups.map((g) => ({
        head: g.head,
        name: g.name,
        method: g.method,
        dimUnit: g.dimUnit ?? null,
        sortOrder: g.sortOrder ?? 0,
        notes: g.notes ?? null,
        lines: { create: g.lines.map(lineData) },
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Includes / serialization
// ---------------------------------------------------------------------------

const activeSheetInclude = {
  where: { isActive: true },
  include: {
    currency: true,
    groups: { orderBy: { sortOrder: 'asc' as const }, include: { lines: { orderBy: { sortOrder: 'asc' as const } } } },
  },
};

const listInclude = {
  productType: true,
  size: true,
  colour: true,
  material: true,
  unit: true,
  buyers: { include: { buyer: true } },
  images: { where: { isPrimary: true }, take: 1 },
  costSheets: activeSheetInclude,
};

const fullInclude = {
  itemType: true,
  productType: true,
  size: true,
  colour: true,
  material: true,
  finish: true,
  unit: true,
  stageLine: { select: { id: true, code: true, name: true, steps: { orderBy: { sortOrder: 'asc' as const }, select: { id: true, name: true, sortOrder: true } } } },
  createdBy: { select: { id: true, name: true } },
  buyers: { include: { buyer: true } },
  images: { orderBy: [{ isPrimary: 'desc' as const }, { sortOrder: 'asc' as const }] },
  relatedFrom: {
    include: {
      related: {
        select: { id: true, factoryCode: true, name: true, images: { where: { isPrimary: true }, take: 1 } },
      },
    },
  },
  costSheets: activeSheetInclude,
};

function summarize(product: any, methods: MethodMap) {
  const sheet = product.costSheets?.[0];
  const computed = computeCostSheet(sheet, methods) as any;
  return {
    id: product.id,
    factoryCode: product.factoryCode,
    name: product.name,
    alias: product.alias,
    status: product.status,
    productType: product.productType?.value ?? null,
    size: product.size?.value ?? null,
    colour: product.colour?.value ?? null,
    material: product.material?.value ?? null,
    unit: product.unit?.code ?? null,
    buyers: (product.buyers || []).map((b: any) => ({ name: b.buyer.name, code: b.buyer.code, buyerCode: b.buyerCode })),
    primaryImage: product.images?.[0]?.url ?? null,
    currency: computed?.currency ? { code: computed.currency.code, symbol: computed.currency.symbol } : null,
    exFactory: computed?.summary.exFactory ?? null,
    fob: computed?.summary.fob ?? null,
    nonFob: computed?.summary.nonFob ?? null,
    updatedAt: product.updatedAt,
  };
}

function serializeFull(product: any, methods: MethodMap) {
  const sheet = product.costSheets?.[0];
  return {
    ...product,
    costSheet: computeCostSheet(sheet, methods),
    costSheets: undefined,
    related: (product.relatedFrom || []).map((r: any) => ({
      id: r.id,
      relatedId: r.relatedId,
      relation: r.relation,
      note: r.note,
      product: {
        id: r.related.id,
        factoryCode: r.related.factoryCode,
        name: r.related.name,
        primaryImage: r.related.images?.[0]?.url ?? null,
      },
    })),
    relatedFrom: undefined,
  };
}

// ---------------------------------------------------------------------------
// List + filters
// ---------------------------------------------------------------------------

router.get(
  '/',
  can('products.view'),
  asyncHandler(async (req, res) => {
    const q = (req.query.q as string | undefined)?.trim();
    const numParam = (v: unknown) => (v != null && v !== '' ? Number(v) : undefined);
    const where: any = {};
    if (q) where.OR = [{ factoryCode: like(q) }, { name: like(q) }, { alias: like(q) }];
    if (req.query.status) where.status = req.query.status;
    const filters: Array<[string, string]> = [
      ['productTypeId', 'productTypeId'],
      ['sizeId', 'sizeId'],
      ['colourId', 'colourId'],
      ['materialId', 'materialId'],
      ['finishId', 'finishId'],
    ];
    for (const [param, field] of filters) {
      const val = numParam(req.query[param]);
      if (val !== undefined) where[field] = val;
    }
    const buyerId = numParam(req.query.buyerId);
    if (buyerId !== undefined) where.buyers = { some: { buyerId } };

    const [methods, products] = await Promise.all([
      loadMethodMap(),
      prisma.product.findMany({ where: live(where), include: listInclude, orderBy: { updatedAt: 'desc' } }),
    ]);
    res.json(maybeStrip(req, products.map((p) => summarize(p, methods))));
  })
);

// Executive-summary view (same data, compact) for the Product Catalogue.
router.get(
  '/catalogue',
  can('products.view'),
  asyncHandler(async (req, res) => {
    const [methods, products] = await Promise.all([
      loadMethodMap(),
      prisma.product.findMany({ where: notDeleted, include: listInclude, orderBy: { factoryCode: 'asc' } }),
    ]);
    res.json(maybeStrip(req, products.map((p) => summarize(p, methods))));
  })
);

// ---------------------------------------------------------------------------
// Single product (full detail + computed costing)
// ---------------------------------------------------------------------------

/** What is in the trash. Declared before `/:id` so the literal path wins. */
router.get(
  '/trash',
  can('products.view', 'products.restore'),
  asyncHandler(async (_req, res) => {
    res.json(
      await prisma.product.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, factoryCode: true, name: true, status: true, deletedAt: true },
        orderBy: { deletedAt: 'desc' },
      })
    );
  })
);

router.get(
  '/:id',
  can('products.view'),
  asyncHandler(async (req, res) => {
    const [methods, product] = await Promise.all([
      loadMethodMap(),
      prisma.product.findUnique({ where: { id: Number(req.params.id) }, include: fullInclude }),
    ]);
    if (!product) throw new ApiError(404, 'Product not found.');
    // Reachable from a bookmark or a stale tab. Say it is in the trash rather than
    // rendering a page whose Save would silently resurrect it.
    if (product.deletedAt) throw new ApiError(410, `${product.factoryCode} is in the trash. Restore it to open it.`);
    res.json(maybeStrip(req, [serializeFull(product, methods)])[0]);
  })
);

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

router.post(
  '/',
  can('products.view', 'products.create'),
  asyncHandler(async (req, res) => {
    const data = productSchema.parse(req.body);
    guardCosting(req, data.costSheet);
    await checkStageSteps(data);
    const product = await prisma.product.create({
      data: {
        ...scalarData(data),
        createdById: req.user!.sub,
        buyers: { create: data.buyers.map((b) => ({ buyerId: b.buyerId, buyerCode: b.buyerCode ?? null })) },
        relatedFrom: {
          create: data.related.map((r) => ({ relatedId: r.relatedId, relation: r.relation, note: r.note ?? null })),
        },
        costSheets: data.costSheet ? { create: [costSheetCreate(data.costSheet)] } : undefined,
      },
      include: fullInclude,
    });
    res.status(201).json(serializeFull(product, await loadMethodMap()));
  })
);

// ---------------------------------------------------------------------------
// Update (replaces buyers / related / cost sheet)
// ---------------------------------------------------------------------------

router.put(
  '/:id',
  can('products.view', 'products.edit'),
  asyncHandler(async (req, res) => {
    // A trashed product must not be edited back to life through a stale tab.
    {
      const existing = await prisma.product.findUnique({ where: { id: Number(req.params.id) }, select: { deletedAt: true, factoryCode: true } });
      if (!existing) throw new ApiError(404, 'Product not found.');
      if (existing.deletedAt) throw new ApiError(409, `${existing.factoryCode} is in the trash. Restore it before editing it.`);
    }
    const id = Number(req.params.id);
    const data = productSchema.parse(req.body);
    guardCosting(req, data.costSheet);
    await checkStageSteps(data);

    // Read the old costing BEFORE the sheet is replaced, or its rates are gone and
    // "what was this before?" becomes unanswerable.
    const previous = await prisma.costSheet.findFirst({
      where: { productId: id, isActive: true },
      select: { factoryExpensePct: true, marginPct: true, groups: { select: { head: true, name: true, lines: { select: { name: true, rate: true, qty: true, wastagePct: true, unit: true } } } } },
    });

    await prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id }, data: scalarData(data) });

      await tx.productBuyer.deleteMany({ where: { productId: id } });
      for (const b of data.buyers) {
        await tx.productBuyer.create({ data: { productId: id, buyerId: b.buyerId, buyerCode: b.buyerCode ?? null } });
      }

      await tx.relatedProduct.deleteMany({ where: { productId: id } });
      for (const r of data.related) {
        await tx.relatedProduct.create({ data: { productId: id, relatedId: r.relatedId, relation: r.relation, note: r.note ?? null } });
      }

      await tx.costSheet.deleteMany({ where: { productId: id } });
      if (data.costSheet) {
        await tx.costSheet.create({ data: { productId: id, ...costSheetCreate(data.costSheet) } });
      }

      await logChanges(tx, { type: 'Product', id }, { id: req.user!.sub, name: req.user!.name }, diffCostSheet(previous, data.costSheet ?? null));
    });

    const product = await prisma.product.findUnique({ where: { id }, include: fullInclude });
    res.json(serializeFull(product, await loadMethodMap()));
  })
);

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/** What a product's references are, for the messages below. */
async function productReferences(id: number) {
  const [orderLines, proformaLines, sheets] = await Promise.all([
    prisma.orderLine.count({ where: { productId: id } }),
    prisma.proformaLine.count({ where: { productId: id } }),
    prisma.operationSheet.count({ where: { productId: id } }),
  ]);
  const bits = [orderLines && `${orderLines} order line(s)`, proformaLines && `${proformaLines} proforma line(s)`, sheets && `${sheets} material sheet(s)`].filter(Boolean).join(', ');
  return { count: orderLines + proformaLines + sheets, bits };
}


router.post(
  '/:id/restore',
  can('products.view', 'products.restore'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.product.findUnique({ where: { id }, select: { deletedAt: true, factoryCode: true } });
    if (!existing) throw new ApiError(404, 'Product not found.');
    if (!existing.deletedAt) throw new ApiError(409, `${existing.factoryCode} is not in the trash.`);
    await restore('product', id);
    res.json({ restored: true, factoryCode: existing.factoryCode });
  })
);

/**
 * Destroy for good. Admin only, and only from the trash. There is deliberately no
 * waiting period and no automatic purge — nothing disappears because time passed.
 */
router.delete(
  '/:id/permanent',
  can('products.view', 'products.restore', 'products.purge'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.product.findUnique({ where: { id }, select: { deletedAt: true, factoryCode: true } });
    if (!existing) throw new ApiError(404, 'Product not found.');
    if (!existing.deletedAt) throw new ApiError(409, `${existing.factoryCode} is still live. Delete it first, then destroy it from the trash.`);

    // Now the foreign keys really bite, so name them instead of letting one 500.
    const refs = await productReferences(id);
    if (refs.count > 0) {
      // Those references may themselves be in the trash — an order you deleted still owns
      // its lines, and they still point here. Say so, or the message names records the
      // user cannot find anywhere.
      const hidden = await trashedNote([
        { model: 'operationSheet', where: { productId: id } },
        { model: 'order', where: { lines: { some: { productId: id } } } },
        { model: 'proforma', where: { lines: { some: { productId: id } } } },
      ]);
      throw new ApiError(409, `${existing.factoryCode} cannot be destroyed: ${refs.bits} still reference it.${hidden} It can stay in the trash indefinitely.`);
    }

    const images = await prisma.productImage.findMany({ where: { productId: id } });
    await prisma.product.delete({ where: { id } });
    for (const img of images) {
      const file = path.join(uploadDir, img.filename);
      fs.promises.unlink(file).catch(() => undefined);
    }
    res.status(204).end();
  })
);

/**
 * Move a product to the trash. Nothing is destroyed, so the "in use" check is now
 * ADVISORY rather than blocking: the orders and sheets that reference it keep working
 * untouched, the product simply stops appearing in the catalogue, and it can be
 * restored with one click.
 */
router.delete(
  '/:id',
  can('products.view', 'products.delete'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const product = await prisma.product.findUnique({ where: { id }, select: { factoryCode: true, name: true, deletedAt: true } });
    if (!product) throw new ApiError(404, 'Product not found.');
    if (product.deletedAt) throw new ApiError(409, `${product.factoryCode} is already in the trash.`);

    const refs = await productReferences(id);
    const deletedAt = await softDelete('product', id);
    res.json({
      deleted: true,
      deletedAt,
      factoryCode: product.factoryCode,
      inUse: refs.count > 0,
      note: refs.count > 0 ? `Moved to the trash. ${refs.bits} still reference it — those records are unaffected.` : 'Moved to the trash.',
    });
  })
);

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

router.post(
  '/:id/images',
  can('products.view', 'products.photos'),
  upload.array('images', 20),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const product = await prisma.product.findUnique({ where: { id }, include: { images: true } });
    if (!product) throw new ApiError(404, 'Product not found.');
    // Contents are checked, not just the declared mimetype.
    const files = keepRealImages((req.files as Express.Multer.File[]) || []);

    let hasPrimary = product.images.some((i) => i.isPrimary);
    let order = product.images.length;
    const created = [];
    for (const file of files) {
      const isPrimary = !hasPrimary;
      hasPrimary = true;
      created.push(
        await prisma.productImage.create({
          data: {
            productId: id,
            filename: file.filename,
            originalName: file.originalname,
            url: `/uploads/${file.filename}`,
            isPrimary,
            sortOrder: order++,
          },
        })
      );
    }
    res.status(201).json(created);
  })
);

const imagePatchSchema = z.object({
  isPrimary: z.boolean().optional(),
  caption: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

router.patch(
  '/:id/images/:imageId',
  can('products.view', 'products.photos'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const imageId = Number(req.params.imageId);
    const data = imagePatchSchema.parse(req.body);
    const updated = await prisma.$transaction(async (tx) => {
      if (data.isPrimary) await tx.productImage.updateMany({ where: { productId: id }, data: { isPrimary: false } });
      return tx.productImage.update({
        where: { id: imageId },
        data: {
          ...(data.isPrimary !== undefined ? { isPrimary: data.isPrimary } : {}),
          ...(data.caption !== undefined ? { caption: data.caption } : {}),
          ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
        },
      });
    });
    res.json(updated);
  })
);

router.delete(
  '/:id/images/:imageId',
  can('products.view', 'products.photos'),
  asyncHandler(async (req, res) => {
    const imageId = Number(req.params.imageId);
    const img = await prisma.productImage.findUnique({ where: { id: imageId } });
    if (!img) throw new ApiError(404, 'Image not found.');
    await prisma.productImage.delete({ where: { id: imageId } });
    fs.promises.unlink(path.join(uploadDir, img.filename)).catch(() => undefined);
    // If we removed the primary, promote the next image.
    if (img.isPrimary) {
      const next = await prisma.productImage.findFirst({ where: { productId: img.productId }, orderBy: { sortOrder: 'asc' } });
      if (next) await prisma.productImage.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
    res.status(204).end();
  })
);

export default router;
