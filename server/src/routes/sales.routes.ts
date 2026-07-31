/**
 * Finished goods and sales: what is finished, how it is packed, what left, what was billed.
 *
 * Three disciplines run through every write here, and undoing any of them reopens a hole:
 *
 * 1. **`lockOrder(tx, orderId)` FIRST.** Packing and shipping are read-validate-write
 *    against derived quantities, exactly like a board clearance — two dispatches could
 *    otherwise both conclude the same cartons are available and both append. Orders are
 *    locked in ID ORDER, because a shipment may touch several and two of them taking the
 *    same locks in opposite orders is a deadlock.
 * 2. **The guards are re-checked inside the transaction.** `shipping.ts`' `guard*` functions
 *    are what the drawer showed the user; they are not the enforcement.
 * 3. **Nothing derivable is stored.** No quantity on hand, no packed count, no invoice
 *    total. `salesBoard.ts` computes them on read.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db';
import { ApiError, asyncHandler, guardIdParams } from '../lib/http';
import { authenticate, requireRole } from '../middleware/auth';
import { nextDocNumber } from '../lib/numbering';
import { round } from '../lib/costing';
import { lockOrder } from '../lib/rowLock';
import { companyState, ensureCompany } from '../lib/company';
import { docKeys, invoiceTitle } from '../lib/pricing';
import { amount, certificateOfOriginPdf, containerAnnexurePdf, invoicePdf, packingListPdf, vgmPdf } from '../lib/docPdf';
import { buildEml } from '../lib/mailDraft';
import { notDeleted, restore, softDelete } from '../lib/softDelete';
import { imageUploader, keepRealImages, uploadDir } from '../lib/imageUpload';
import { syncOrderStatus } from '../lib/orderBoard';
import { like } from '../lib/search';
import {
  cartonsFor,
  containerFit,
  guardCartonFit,
  guardInvoiceQty,
  guardPackQty,
  guardShipQty,
  packedTotals,
  planContainers,
  FINISHED_KINDS,
  FINISHED_REASONS,
  INCOTERMS,
  INVOICE_STATUSES,
  SHIPMENT_STATUSES,
} from '../lib/shipping';
import {
  finishedPosition,
  invoiceInclude,
  invoicedQtyByOrderLine,
  loadInvoice,
  loadShipment,
  packingInclude,
  serializeInvoice,
  serializePacking,
  serializeShipment,
  shipmentInclude,
  shippedQtyByOrderLine,
} from '../lib/salesBoard';

const router = Router();
// A route param here is always a database id — see guardIdParams.
guardIdParams(router);
router.use(authenticate);
/** Operator packs — it is shop-floor work. */
const canPack = requireRole('Operator');
/** Manager+ for dispatch, invoices and anything with money on it. */
const canManage = requireRole('Manager');

/**
 * Move the order on, now that shipping can decide it.
 *
 * `syncOrderStatus` only ever knew about the board. Shipping is the other half, so the
 * shipped figure is passed in — see `impliedOrderStatus`, where a fully shipped order
 * becomes Shipped and a partly shipped one is deliberately left where the board put it.
 */
async function syncShipped(tx: Parameters<typeof lockOrder>[0], orderId: number) {
  const shipped = await shippedQtyByOrderLine(tx as never, orderId);
  const total = [...shipped.values()].reduce((a, n) => a + n, 0);
  await syncOrderStatus(tx as never, orderId, total);
}

/** Every order an operation touches, locked in a stable order so two cannot deadlock. */
async function lockOrders(tx: Parameters<typeof lockOrder>[0], orderIds: (number | null | undefined)[]) {
  const ids = [...new Set(orderIds.filter((n): n is number => typeof n === 'number'))].sort((a, b) => a - b);
  for (const id of ids) {
    if (!(await lockOrder(tx, id))) throw new ApiError(404, `Order #${id} no longer exists.`);
  }
  return ids;
}

// ===========================================================================
// Finished stock
// ===========================================================================

/**
 * What is finished and still here, per product and per order line.
 *
 * Entirely derived — the board's DONE bucket read live, plus the adjustment ledger, less
 * what is packed and shipped. There is nothing to type on this endpoint for a reason.
 */
router.get(
  '/finished/stock',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const pos = await finishedPosition();
    const productIds = [...pos.byProduct.keys()];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, ...notDeleted, ...(q ? { OR: [{ factoryCode: like(q) }, { name: like(q) }] } : {}) },
      select: { id: true, factoryCode: true, name: true, piecesPerCarton: true, unit: { select: { code: true } } },
      orderBy: { factoryCode: 'asc' },
    });

    const lineIds = [...pos.byOrderLine.keys()];
    const lines = await prisma.orderLine.findMany({
      where: { id: { in: lineIds } },
      select: { id: true, productId: true, order: { select: { id: true, number: true, status: true, buyer: { select: { name: true } } } } },
    });

    res.json(
      products.map((p) => {
        const cell = pos.byProduct.get(p.id)!;
        const free = pos.freePool.get(p.id) ?? null;
        return {
          ...cell,
          productId: p.id,
          factoryCode: p.factoryCode,
          name: p.name,
          unit: p.unit?.code ?? 'PCS',
          piecesPerCarton: p.piecesPerCarton,
          freePool: free ? { onHand: free.onHand, availableToPack: free.availableToPack, availableToShip: free.availableToShip } : null,
          orders: lines
            .filter((l) => l.productId === p.id)
            .map((l) => {
              const c = pos.byOrderLine.get(l.id)!;
              return {
                orderLineId: l.id,
                orderId: l.order.id,
                orderNumber: l.order.number,
                orderStatus: l.order.status,
                buyerName: l.order.buyer.name,
                boardDone: c.boardDone,
                adjusted: c.adjusted,
                returned: c.returned,
                packed: c.packed,
                shipped: c.shipped,
                onHand: c.onHand,
                availableToPack: c.availableToPack,
                availableToShip: c.availableToShip,
                overProduced: c.overProduced,
              };
            })
            .filter((o) => o.boardDone > 0 || o.adjusted !== 0 || o.packed > 0 || o.shipped > 0),
        };
      })
    );
  })
);

/** The adjustment ledger — the only part of finished stock anybody types. */
router.get(
  '/finished/txns',
  asyncHandler(async (req, res) => {
    const productId = req.query.productId ? Number(req.query.productId) : undefined;
    const rows = await prisma.finishedTxn.findMany({
      where: productId ? { productId } : undefined,
      include: {
        product: { select: { factoryCode: true, name: true } },
        orderLine: { select: { id: true, order: { select: { id: true, number: true } } } },
      },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: 300,
    });
    res.json(
      rows.map((r) => ({
        id: r.id,
        date: r.date,
        productId: r.productId,
        productCode: r.product.factoryCode,
        productName: r.product.name,
        kind: r.kind,
        qty: r.qty,
        reason: r.reason,
        note: r.note,
        orderLineId: r.orderLineId,
        orderId: r.orderLine?.order.id ?? null,
        orderNumber: r.orderLine?.order.number ?? null,
      }))
    );
  })
);

const adjustmentSchema = z.object({
  productId: z.number().int(),
  kind: z.enum(FINISHED_KINDS),
  /** Always positive. `kind` carries the direction. */
  qty: z.number().int().positive(),
  orderLineId: z.number().int().nullable().optional(),
  shipmentLineId: z.number().int().nullable().optional(),
  reason: z.enum(FINISHED_REASONS).optional(),
  note: z.string().max(500).optional(),
  date: z.coerce.date().optional(),
});

router.post(
  '/finished/txns',
  canManage,
  asyncHandler(async (req, res) => {
    const data = adjustmentSchema.parse(req.body);

    const created = await prisma.$transaction(async (tx) => {
      // An adjustment against a line changes that order's derived stock, so it takes the
      // same turn a clearance does.
      let orderId: number | null = null;
      if (data.orderLineId != null) {
        const line = await tx.orderLine.findUnique({ where: { id: data.orderLineId }, select: { orderId: true, productId: true } });
        if (!line) throw new ApiError(404, 'That order line no longer exists.');
        if (line.productId !== data.productId) throw new ApiError(409, 'That order line is for a different product.');
        orderId = line.orderId;
        await lockOrders(tx, [orderId]);
      }

      // Taking stock out must not drive it below what has already been packed or shipped —
      // re-read UNDER the lock, because the figure the user saw may be stale.
      if (data.kind === 'ADJUST_OUT') {
        const pos = await finishedPosition(tx, [data.productId]);
        const cell = data.orderLineId != null ? pos.byOrderLine.get(data.orderLineId) : pos.freePool.get(data.productId);
        const onHand = cell?.onHand ?? 0;
        if (data.qty > onHand) {
          throw new ApiError(409, onHand <= 0 ? 'There is nothing on hand to take out.' : `Only ${onHand} pc(s) are on hand.`);
        }
      }

      const row = await tx.finishedTxn.create({
        data: {
          productId: data.productId,
          kind: data.kind,
          qty: data.qty,
          orderLineId: data.orderLineId ?? null,
          shipmentLineId: data.shipmentLineId ?? null,
          reason: data.reason ?? null,
          note: data.note ?? null,
          date: data.date ?? new Date(),
          createdById: req.user?.sub ?? null,
        },
      });
      if (orderId != null) await syncShipped(tx, orderId);
      return row;
    });

    res.status(201).json(created);
  })
);

router.delete(
  '/finished/txns/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await prisma.$transaction(async (tx) => {
      const row = await tx.finishedTxn.findUnique({ where: { id }, select: { id: true, kind: true, qty: true, productId: true, orderLineId: true, orderLine: { select: { orderId: true } } } });
      if (!row) throw new ApiError(404, 'That movement no longer exists.');
      const orderId = row.orderLine?.orderId ?? null;
      if (orderId != null) await lockOrders(tx, [orderId]);

      // Removing a receipt takes stock away, so the same floor applies as an ADJUST_OUT.
      if (row.kind !== 'ADJUST_OUT') {
        const pos = await finishedPosition(tx, [row.productId]);
        const cell = row.orderLineId != null ? pos.byOrderLine.get(row.orderLineId) : pos.freePool.get(row.productId);
        const onHand = cell?.onHand ?? 0;
        if (onHand - row.qty < 0) {
          throw new ApiError(409, `Removing this would leave ${onHand - row.qty} pc(s) on hand. Reverse what has been packed or shipped first.`);
        }
      }
      await tx.finishedTxn.delete({ where: { id } });
      if (orderId != null) await syncShipped(tx, orderId);
    });
    res.status(204).end();
  })
);

// ===========================================================================
// Packing
// ===========================================================================

/** What is finished and still unpacked, ready to box. */
router.get(
  '/packing/queue',
  asyncHandler(async (_req, res) => {
    const pos = await finishedPosition();
    const lineIds = [...pos.byOrderLine.keys()];
    const lines = await prisma.orderLine.findMany({
      where: { id: { in: lineIds }, order: { ...notDeleted, status: { notIn: ['Cancelled'] } } },
      select: {
        id: true,
        qty: true,
        productId: true,
        product: { select: { factoryCode: true, name: true, piecesPerCarton: true, packLengthIn: true, packWidthIn: true, packHeightIn: true, netWeightKg: true, grossWeightKg: true, volumeAfterPackingCbm: true } },
        order: { select: { id: true, number: true, status: true, deliveryDate: true, buyer: { select: { id: true, name: true, market: true } } } },
      },
    });

    res.json(
      lines
        .map((l) => {
          const c = pos.byOrderLine.get(l.id)!;
          const count = cartonsFor(c.availableToPack, l.product.piecesPerCarton);
          return {
            orderLineId: l.id,
            orderId: l.order.id,
            orderNumber: l.order.number,
            orderStatus: l.order.status,
            deliveryDate: l.order.deliveryDate,
            buyerId: l.order.buyer.id,
            buyerName: l.order.buyer.name,
            market: l.order.buyer.market,
            productId: l.productId,
            productCode: l.product.factoryCode,
            productName: l.product.name,
            ordered: l.qty,
            finished: c.boardDone + c.adjusted + c.returned,
            packed: c.packed,
            shipped: c.shipped,
            availableToPack: c.availableToPack,
            availableToShip: c.availableToShip,
            /** Pre-fill for the drawer: what the master says, and what it would make. */
            piecesPerCarton: l.product.piecesPerCarton,
            impliedCartons: count.total,
            lastCartonPieces: count.lastPieces,
            packLengthIn: l.product.packLengthIn,
            packWidthIn: l.product.packWidthIn,
            packHeightIn: l.product.packHeightIn,
            netWeightKg: l.product.netWeightKg,
            grossWeightKg: l.product.grossWeightKg,
            cbmPerPiece: l.product.volumeAfterPackingCbm,
          };
        })
        .filter((r) => r.availableToPack > 0 || r.packed > 0)
        .sort((a, b) => (a.deliveryDate && b.deliveryDate ? new Date(a.deliveryDate).getTime() - new Date(b.deliveryDate).getTime() : 0))
    );
  })
);

router.get(
  '/packing',
  asyncHandler(async (req, res) => {
    const orderId = req.query.orderId ? Number(req.query.orderId) : undefined;
    const unshipped = String(req.query.unshipped ?? '') === '1';
    const rows = await prisma.packingBatch.findMany({
      where: orderId != null ? { orderLine: { orderId } } : undefined,
      include: packingInclude,
      orderBy: [{ packedOn: 'desc' }, { id: 'desc' }],
    });
    const out = rows.map(serializePacking);
    res.json(unshipped ? out.filter((b) => b.availableCartons > 0) : out);
  })
);

/**
 * One batch to pack. `cartonCount` is DERIVED from the quantity unless the packer overrides
 * it, and the dims/weights are snapshotted so a packing list already printed cannot change
 * when somebody later corrects the product master.
 */
const packLineSchema = z.object({
  productId: z.number().int(),
  orderLineId: z.number().int().nullable().optional(),
  qty: z.number().int().positive(),
  cartonCount: z.number().int().positive().optional(),
  piecesPerCarton: z.number().int().positive().optional(),
  packLengthIn: z.number().nonnegative().nullable().optional(),
  packWidthIn: z.number().nonnegative().nullable().optional(),
  packHeightIn: z.number().nonnegative().nullable().optional(),
  netWeightKg: z.number().nonnegative().nullable().optional(),
  grossWeightKg: z.number().nonnegative().nullable().optional(),
  cbmPerCartonOverride: z.number().positive().nullable().optional(),
  shippingMarks: z.string().max(300).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  packedOn: z.coerce.date().optional(),
});

/** One submission may pack several lines — the same shape the board's bulk drawer posts. */
const packSchema = z.object({ batches: z.array(packLineSchema).min(1) });

router.post(
  '/packing',
  canPack,
  asyncHandler(async (req, res) => {
    const { batches } = packSchema.parse(req.body);

    const created = await prisma.$transaction(async (tx) => {
      const lineRows = await tx.orderLine.findMany({
        where: { id: { in: batches.map((b) => b.orderLineId).filter((n): n is number => typeof n === 'number') } },
        select: { id: true, orderId: true, productId: true },
      });
      await lockOrders(tx, lineRows.map((l) => l.orderId));

      // Re-read what is packable UNDER the lock. The drawer's figure may be stale by now.
      const pos = await finishedPosition(tx, [...new Set(batches.map((b) => b.productId))]);
      const out = [];

      for (const b of batches) {
        const line = b.orderLineId != null ? lineRows.find((l) => l.id === b.orderLineId) : undefined;
        if (b.orderLineId != null) {
          if (!line) throw new ApiError(404, 'That order line no longer exists.');
          if (line.productId !== b.productId) throw new ApiError(409, 'That order line is for a different product.');
        }
        const cell = b.orderLineId != null ? pos.byOrderLine.get(b.orderLineId) : pos.freePool.get(b.productId);
        const refusal = guardPackQty(cell?.availableToPack ?? 0, b.qty);
        if (refusal) throw new ApiError(409, refusal);

        const product = await tx.product.findUnique({
          where: { id: b.productId },
          select: { piecesPerCarton: true, packLengthIn: true, packWidthIn: true, packHeightIn: true, netWeightKg: true, grossWeightKg: true, volumeAfterPackingCbm: true },
        });
        if (!product) throw new ApiError(404, 'That product no longer exists.');

        const per = b.piecesPerCarton ?? product.piecesPerCarton ?? 1;
        const cartons = b.cartonCount ?? cartonsFor(b.qty, per).total;
        const fitRefusal = guardCartonFit(cartons, per, b.qty);
        if (fitRefusal) throw new ApiError(409, fitRefusal);

        // Which dimensions apply: whatever the packer typed, else the master's.
        const dims = {
          packLengthIn: b.packLengthIn ?? product.packLengthIn,
          packWidthIn: b.packWidthIn ?? product.packWidthIn,
          packHeightIn: b.packHeightIn ?? product.packHeightIn,
        };
        /**
         * Clearing `cbmPerPiece` is how a caller hands authority to the dimensions — see
         * `cartonCbm`. The packer changing a dimension or the pieces per carton means the
         * master's per-piece volume described a DIFFERENT box, so it is dropped rather than
         * carried forward to contradict the measurements beside it.
         */
        const dimsChanged =
          (b.packLengthIn != null && b.packLengthIn !== product.packLengthIn) ||
          (b.packWidthIn != null && b.packWidthIn !== product.packWidthIn) ||
          (b.packHeightIn != null && b.packHeightIn !== product.packHeightIn) ||
          (b.piecesPerCarton != null && b.piecesPerCarton !== product.piecesPerCarton);

        const row = await tx.packingBatch.create({
          data: {
            productId: b.productId,
            orderLineId: b.orderLineId ?? null,
            qty: b.qty,
            cartonCount: cartons,
            piecesPerCarton: per,
            ...dims,
            netWeightKg: b.netWeightKg ?? product.netWeightKg,
            grossWeightKg: b.grossWeightKg ?? product.grossWeightKg,
            cbmPerPiece: dimsChanged ? null : product.volumeAfterPackingCbm,
            cbmPerCartonOverride: b.cbmPerCartonOverride ?? null,
            shippingMarks: b.shippingMarks ?? null,
            note: b.note ?? null,
            packedOn: b.packedOn ?? new Date(),
            createdById: req.user?.sub ?? null,
          },
          include: packingInclude,
        });
        out.push(serializePacking(row));
      }
      return out;
    });

    res.status(201).json(created);
  })
);

/** Unpack. Refused once any of its cartons are on a live shipment. */
router.delete(
  '/packing/:id',
  canPack,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await prisma.$transaction(async (tx) => {
      const batch = await tx.packingBatch.findUnique({
        where: { id },
        select: { id: true, orderLine: { select: { orderId: true } }, lines: { select: { shipment: { select: { number: true, deletedAt: true, status: true } } } } },
      });
      if (!batch) throw new ApiError(404, 'That packing batch no longer exists.');
      const orderId = batch.orderLine?.orderId ?? null;
      if (orderId != null) await lockOrders(tx, [orderId]);

      const live = batch.lines.filter((l) => !l.shipment?.deletedAt && l.shipment?.status !== 'CANCELLED');
      if (live.length) {
        const names = [...new Set(live.map((l) => l.shipment?.number).filter(Boolean))].join(', ');
        throw new ApiError(409, `These cartons are on ${names}. Take them off the shipment first.`);
      }
      await tx.packingBatch.delete({ where: { id } });
      if (orderId != null) await syncShipped(tx, orderId);
    });
    res.status(204).end();
  })
);

// ===========================================================================
// Shipments
// ===========================================================================

/** In the trash. Declared before `/shipments/:id` so the literal path wins. */
router.get(
  '/shipments/trash',
  canManage,
  asyncHandler(async (_req, res) => {
    res.json(
      await prisma.shipment.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, number: true, status: true, shipDate: true, deletedAt: true },
        orderBy: { deletedAt: 'desc' },
      })
    );
  })
);

/**
 * Packed cartons a dispatch may draw on, per order line.
 *
 * Registered before `/shipments/:id` for the same reason.
 */
router.get(
  '/shipments/candidates',
  canManage,
  asyncHandler(async (req, res) => {
    const buyerId = req.query.buyerId ? Number(req.query.buyerId) : undefined;
    /**
     * When editing, the shipment being edited must be discounted: its own cartons are not
     * "already gone" from its point of view. Without this its batches look fully shipped,
     * vanish from its own picker, and the shipment cannot be edited at all.
     */
    const forShipment = req.query.shipmentId ? Number(req.query.shipmentId) : undefined;
    const batches = await prisma.packingBatch.findMany({
      where: buyerId != null ? { orderLine: { order: { buyerId, ...notDeleted, status: { notIn: ['Cancelled'] } } } } : { orderLine: { order: { ...notDeleted, status: { notIn: ['Cancelled'] } } } },
      include: packingInclude,
      orderBy: [{ packedOn: 'asc' }, { id: 'asc' }],
    });
    res.json(batches.map((b) => serializePacking(b, forShipment)).filter((b) => b.availableCartons > 0));
  })
);

router.get(
  '/shipments',
  canManage,
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : undefined;
    const rows = await prisma.shipment.findMany({
      where: { ...notDeleted, ...(status && status !== 'All' ? { status } : {}) },
      include: shipmentInclude,
      orderBy: [{ shipDate: 'desc' }, { id: 'desc' }],
    });
    res.json(rows.map(serializeShipment));
  })
);

router.get(
  '/shipments/:id',
  canManage,
  asyncHandler(async (req, res) => {
    res.json(serializeShipment(await loadShipment(Number(req.params.id))));
  })
);

const containerSchema = z.object({
  id: z.number().int().optional(),
  containerTypeId: z.number().int(),
  containerNo: z.string().max(40).nullable().optional(),
  sealNo: z.string().max(40).nullable().optional(),
  tareWeightKg: z.number().nonnegative().nullable().optional(),
  note: z.string().max(300).nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const shipLineSchema = z.object({
  id: z.number().int().optional(),
  packingBatchId: z.number().int(),
  /** Index into the containers array, for a line whose container is being created too. */
  containerIndex: z.number().int().nullable().optional(),
  containerId: z.number().int().nullable().optional(),
  cartons: z.number().int().positive(),
  qty: z.number().int().positive(),
  sortOrder: z.number().int().optional(),
});

const shipmentSchema = z.object({
  status: z.enum(SHIPMENT_STATUSES).optional(),
  shipDate: z.coerce.date().nullable().optional(),
  shippingBillNo: z.string().max(40).nullable().optional(),
  shippingBillDate: z.coerce.date().nullable().optional(),
  portOfLoading: z.string().max(120).nullable().optional(),
  portOfDischarge: z.string().max(120).nullable().optional(),
  finalDestination: z.string().max(120).nullable().optional(),
  vesselOrFlight: z.string().max(120).nullable().optional(),
  blAwbNo: z.string().max(60).nullable().optional(),
  blAwbDate: z.coerce.date().nullable().optional(),
  transporterName: z.string().max(120).nullable().optional(),
  transporterGstin: z.string().max(20).nullable().optional(),
  vehicleNo: z.string().max(30).nullable().optional(),
  ewayBillNo: z.string().max(40).nullable().optional(),
  ewayBillDate: z.coerce.date().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  containers: z.array(containerSchema).optional(),
  lines: z.array(shipLineSchema).min(1),
});

const headerOf = (d: z.infer<typeof shipmentSchema>) => ({
  status: d.status,
  shipDate: d.shipDate ?? null,
  shippingBillNo: d.shippingBillNo ?? null,
  shippingBillDate: d.shippingBillDate ?? null,
  portOfLoading: d.portOfLoading ?? null,
  portOfDischarge: d.portOfDischarge ?? null,
  finalDestination: d.finalDestination ?? null,
  vesselOrFlight: d.vesselOrFlight ?? null,
  blAwbNo: d.blAwbNo ?? null,
  blAwbDate: d.blAwbDate ?? null,
  transporterName: d.transporterName ?? null,
  transporterGstin: d.transporterGstin ?? null,
  vehicleNo: d.vehicleNo ?? null,
  ewayBillNo: d.ewayBillNo ?? null,
  ewayBillDate: d.ewayBillDate ?? null,
  notes: d.notes ?? null,
});

/**
 * Validate a set of shipment lines against what is actually packed and unshipped.
 *
 * `excludeShipmentId` is what makes an EDIT work: the shipment's own current lines must not
 * count against it, or raising a line from 4 to 5 would be refused because 4 are "already
 * gone" — on the very shipment being edited.
 */
async function assertShippable(
  tx: Parameters<typeof lockOrder>[0],
  lines: { packingBatchId: number; cartons: number; qty: number }[],
  excludeShipmentId?: number
) {
  const batches = await (tx as never as typeof prisma).packingBatch.findMany({
    where: { id: { in: [...new Set(lines.map((l) => l.packingBatchId))] } },
    include: packingInclude,
  });

  for (const l of lines) {
    const batch = batches.find((b) => b.id === l.packingBatchId);
    if (!batch) throw new ApiError(404, 'One of those packing batches no longer exists.');

    const taken = batch.lines
      .filter((x) => x.shipmentId !== excludeShipmentId && !x.shipment?.deletedAt && x.shipment?.status !== 'CANCELLED')
      .reduce((a, x) => ({ cartons: a.cartons + x.cartons, qty: a.qty + x.qty }), { cartons: 0, qty: 0 });

    const availableCartons = batch.cartonCount - taken.cartons;
    const availableQty = batch.qty - taken.qty;

    if (l.cartons > availableCartons) {
      throw new ApiError(409, availableCartons <= 0 ? 'Every carton of that batch has already shipped.' : `Only ${availableCartons} carton(s) of that batch are still here.`);
    }
    const refusal = guardShipQty(availableQty, l.qty);
    if (refusal) throw new ApiError(409, refusal);
    const fit = guardCartonFit(l.cartons, batch.piecesPerCarton, l.qty);
    if (fit) throw new ApiError(409, fit);
  }
  return batches;
}

router.post(
  '/shipments',
  canManage,
  asyncHandler(async (req, res) => {
    const data = shipmentSchema.parse(req.body);

    const created = await prisma.$transaction(async (tx) => {
      const batches = await tx.packingBatch.findMany({
        where: { id: { in: data.lines.map((l) => l.packingBatchId) } },
        select: { id: true, orderLine: { select: { orderId: true } } },
      });
      // Lock every order this dispatch touches, in id order, BEFORE reading anything.
      const orderIds = await lockOrders(tx, batches.map((b) => b.orderLine?.orderId));
      await assertShippable(tx, data.lines);

      const number = await nextDocNumber('SHP', tx);
      const shipment = await tx.shipment.create({ data: { ...headerOf(data), status: data.status ?? 'PLANNED', number, createdById: req.user?.sub ?? null } });

      const containerIds: number[] = [];
      for (const [i, c] of (data.containers ?? []).entries()) {
        const row = await tx.shipmentContainer.create({
          data: { shipmentId: shipment.id, containerTypeId: c.containerTypeId, containerNo: c.containerNo ?? null, sealNo: c.sealNo ?? null, tareWeightKg: c.tareWeightKg ?? null, note: c.note ?? null, sortOrder: c.sortOrder ?? i },
        });
        containerIds.push(row.id);
      }

      for (const [i, l] of data.lines.entries()) {
        await tx.shipmentLine.create({
          data: {
            shipmentId: shipment.id,
            packingBatchId: l.packingBatchId,
            containerId: l.containerIndex != null ? (containerIds[l.containerIndex] ?? null) : (l.containerId ?? null),
            cartons: l.cartons,
            qty: l.qty,
            sortOrder: l.sortOrder ?? i,
          },
        });
      }

      for (const id of orderIds) await syncShipped(tx, id);
      return tx.shipment.findUniqueOrThrow({ where: { id: shipment.id }, include: shipmentInclude });
    });

    res.status(201).json(serializeShipment(created));
  })
);

/**
 * Edit a shipment. Lines are PATCHED by id rather than wiped and rebuilt, so an invoice line
 * pointing at one keeps pointing at it — the same discipline `PUT /orders/:id` follows.
 */
router.put(
  '/shipments/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const data = shipmentSchema.parse(req.body);

    const saved = await prisma.$transaction(async (tx) => {
      const existing = await tx.shipment.findUnique({ where: { id }, include: { lines: { select: { id: true, packingBatchId: true } }, containers: { select: { id: true } }, invoices: { where: { deletedAt: null, status: { not: 'CANCELLED' } }, select: { number: true, status: true } } } });
      if (!existing) throw new ApiError(404, 'Shipment not found.');
      if (existing.deletedAt) throw new ApiError(409, `${existing.number} is in the trash. Restore it before editing it.`);

      const issued = existing.invoices.filter((v) => v.status === 'ISSUED');
      if (issued.length) {
        throw new ApiError(409, `${issued.map((v) => v.number).join(', ')} has been raised against this shipment. Cancel the invoice before changing what shipped.`);
      }

      const batches = await tx.packingBatch.findMany({
        where: { id: { in: [...data.lines.map((l) => l.packingBatchId), ...existing.lines.map((l) => l.packingBatchId)] } },
        select: { id: true, orderLine: { select: { orderId: true } } },
      });
      const orderIds = await lockOrders(tx, batches.map((b) => b.orderLine?.orderId));
      // The shipment's own lines must not count against it — see assertShippable.
      await assertShippable(tx, data.lines, id);

      await tx.shipment.update({ where: { id }, data: headerOf(data) });

      // --- containers: patch, add, remove ------------------------------------
      const keepContainers = (data.containers ?? []).filter((c) => c.id != null).map((c) => c.id as number);
      const newContainerIds: number[] = [];
      for (const [i, c] of (data.containers ?? []).entries()) {
        if (c.id != null) {
          await tx.shipmentContainer.update({ where: { id: c.id }, data: { containerTypeId: c.containerTypeId, containerNo: c.containerNo ?? null, sealNo: c.sealNo ?? null, tareWeightKg: c.tareWeightKg ?? null, note: c.note ?? null, sortOrder: c.sortOrder ?? i } });
          newContainerIds[i] = c.id;
        } else {
          const row = await tx.shipmentContainer.create({ data: { shipmentId: id, containerTypeId: c.containerTypeId, containerNo: c.containerNo ?? null, sealNo: c.sealNo ?? null, tareWeightKg: c.tareWeightKg ?? null, note: c.note ?? null, sortOrder: c.sortOrder ?? i } });
          newContainerIds[i] = row.id;
        }
      }

      // --- lines: patch, add, remove -----------------------------------------
      const keepLines: number[] = [];
      for (const [i, l] of data.lines.entries()) {
        const containerId = l.containerIndex != null ? (newContainerIds[l.containerIndex] ?? null) : (l.containerId ?? null);
        if (l.id != null) {
          await tx.shipmentLine.update({ where: { id: l.id }, data: { packingBatchId: l.packingBatchId, containerId, cartons: l.cartons, qty: l.qty, sortOrder: l.sortOrder ?? i } });
          keepLines.push(l.id);
        } else {
          const row = await tx.shipmentLine.create({ data: { shipmentId: id, packingBatchId: l.packingBatchId, containerId, cartons: l.cartons, qty: l.qty, sortOrder: l.sortOrder ?? i } });
          keepLines.push(row.id);
        }
      }
      await tx.shipmentLine.deleteMany({ where: { shipmentId: id, id: { notIn: keepLines.length ? keepLines : [0] } } });
      // Containers last: a line references one, so an emptied box can only go once its
      // lines have been repointed or removed above.
      await tx.shipmentContainer.deleteMany({ where: { shipmentId: id, id: { notIn: keepContainers.concat(newContainerIds).length ? newContainerIds : [0] } } });

      for (const oid of orderIds) await syncShipped(tx, oid);
      return tx.shipment.findUniqueOrThrow({ where: { id }, include: shipmentInclude });
    });

    res.json(serializeShipment(saved));
  })
);

/** Mark it gone (or back). The order status follows from this, not from a dropdown. */
router.patch(
  '/shipments/:id/status',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { status, shipDate } = z.object({ status: z.enum(SHIPMENT_STATUSES), shipDate: z.coerce.date().nullable().optional() }).parse(req.body);

    const saved = await prisma.$transaction(async (tx) => {
      const existing = await tx.shipment.findUnique({ where: { id }, include: { lines: { select: { packingBatch: { select: { orderLine: { select: { orderId: true } } } } } }, invoices: { where: { deletedAt: null, status: 'ISSUED' }, select: { number: true } } } });
      if (!existing) throw new ApiError(404, 'Shipment not found.');
      if (existing.deletedAt) throw new ApiError(409, `${existing.number} is in the trash.`);
      if (status === 'CANCELLED' && existing.invoices.length) {
        throw new ApiError(409, `${existing.invoices.map((v) => v.number).join(', ')} has been raised against this shipment. Cancel the invoice first.`);
      }
      const orderIds = await lockOrders(tx, existing.lines.map((l) => l.packingBatch.orderLine?.orderId));
      const row = await tx.shipment.update({ where: { id }, data: { status, ...(shipDate !== undefined ? { shipDate } : status === 'SHIPPED' && !existing.shipDate ? { shipDate: new Date() } : {}) } });
      for (const oid of orderIds) await syncShipped(tx, oid);
      return row;
    });
    res.json({ id: saved.id, number: saved.number, status: saved.status, shipDate: saved.shipDate });
  })
);

router.post(
  '/shipments/:id/restore',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.shipment.findUnique({ where: { id }, select: { deletedAt: true, number: true, lines: { select: { packingBatch: { select: { orderLine: { select: { orderId: true } } } } } } } });
    if (!existing) throw new ApiError(404, 'Shipment not found.');
    if (!existing.deletedAt) throw new ApiError(409, `${existing.number} is not in the trash.`);
    await prisma.$transaction(async (tx) => {
      const orderIds = await lockOrders(tx, existing.lines.map((l) => l.packingBatch.orderLine?.orderId));
      await restore('shipment', id, tx);
      for (const oid of orderIds) await syncShipped(tx, oid);
    });
    res.json({ restored: true, number: existing.number });
  })
);

/** Destroy for good. Admin only, only from the trash. */
router.delete(
  '/shipments/:id/permanent',
  requireRole('Admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.shipment.findUnique({ where: { id }, select: { deletedAt: true, number: true, invoices: { select: { number: true } } } });
    if (!existing) throw new ApiError(404, 'Shipment not found.');
    if (!existing.deletedAt) throw new ApiError(409, `${existing.number} is still live. Delete it first, then destroy it from the trash.`);
    if (existing.invoices.length) {
      throw new ApiError(409, `${existing.invoices.map((v) => v.number).join(', ')} still references this shipment. Destroy the invoice first.`);
    }
    await prisma.shipment.delete({ where: { id } });
    res.status(204).end();
  })
);

/** To the trash. Refused while an invoice references it — cancel the invoice first. */
router.delete(
  '/shipments/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.shipment.findUnique({
        where: { id },
        select: { deletedAt: true, number: true, lines: { select: { packingBatch: { select: { orderLine: { select: { orderId: true } } } } } }, invoices: { where: { deletedAt: null, status: { not: 'CANCELLED' } }, select: { number: true } } },
      });
      if (!existing) throw new ApiError(404, 'Shipment not found.');
      if (existing.deletedAt) throw new ApiError(409, `${existing.number} is already in the trash.`);
      if (existing.invoices.length) {
        throw new ApiError(409, `${existing.invoices.map((v) => v.number).join(', ')} has been raised against this shipment. Cancel the invoice before removing the dispatch.`);
      }
      const orderIds = await lockOrders(tx, existing.lines.map((l) => l.packingBatch.orderLine?.orderId));
      const deletedAt = await softDelete('shipment', id, tx);
      // The cartons are back on the floor and the order is no longer fully shipped.
      for (const oid of orderIds) await syncShipped(tx, oid);
      return { deletedAt, number: existing.number };
    });
    res.json({ deleted: true, ...result, note: 'Moved to the trash. The cartons are available again and the order status has been restated.' });
  })
);

/** Suggest a container plan. Advisory: the packer moves cartons afterwards. */
router.post(
  '/shipments/plan',
  canManage,
  asyncHandler(async (req, res) => {
    const { lines } = z.object({ lines: z.array(z.object({ packingBatchId: z.number().int(), cartons: z.number().int().positive(), qty: z.number().int().positive() })).min(1) }).parse(req.body);
    const [batches, types] = await Promise.all([
      prisma.packingBatch.findMany({ where: { id: { in: lines.map((l) => l.packingBatchId) } }, include: packingInclude }),
      prisma.containerType.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
    ]);

    // One entry per physical carton, so the planner can move boxes rather than batches.
    const cartons: { cbm: number; grossKg: number; packingBatchId: number }[] = [];
    for (const l of lines) {
      const b = batches.find((x) => x.id === l.packingBatchId);
      if (!b) throw new ApiError(404, 'One of those packing batches no longer exists.');
      const s = serializePacking(b);
      const perCartonPieces = Math.max(1, Math.round(l.qty / l.cartons));
      for (let i = 0; i < l.cartons; i++) cartons.push({ cbm: s.cbmPerCarton, grossKg: round((b.grossWeightKg ?? 0) * perCartonPieces), packingBatchId: b.id });
    }

    const plan = planContainers(cartons, types.map((t) => ({ id: t.id, code: t.code, capacityCbm: t.capacityCbm, payloadKg: t.payloadKg })));
    res.json({
      totals: packedTotals(batches.map((b) => {
        const l = lines.find((x) => x.packingBatchId === b.id)!;
        return { ...b, cartonsTaken: l.cartons, piecesTaken: l.qty };
      })),
      containers: plan.map((p) => ({ containerTypeId: p.containerTypeId, code: p.code, cartons: p.cartonIndexes.length, fit: p.fit, batchIds: [...new Set(p.cartonIndexes.map((i) => cartons[i].packingBatchId))] })),
    });
  })
);

// ===========================================================================
// Invoices
// ===========================================================================

router.get(
  '/invoices/trash',
  canManage,
  asyncHandler(async (_req, res) => {
    res.json(
      await prisma.invoice.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, number: true, status: true, invoiceDate: true, deletedAt: true, buyer: { select: { name: true } } },
        orderBy: { deletedAt: 'desc' },
      })
    );
  })
);

router.get(
  '/invoices',
  canManage,
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : undefined;
    const [rows, ourState] = await Promise.all([
      prisma.invoice.findMany({
        where: { ...notDeleted, ...(status && status !== 'All' ? { status } : {}) },
        include: invoiceInclude,
        orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }],
      }),
      // A WRITE (it upserts), so it is read before anything else — never inside a transaction.
      companyState(),
    ]);
    res.json(rows.map((i) => serializeInvoice(i, ourState)));
  })
);

router.get(
  '/invoices/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const ourState = await companyState();
    res.json(serializeInvoice(await loadInvoice(Number(req.params.id)), ourState));
  })
);

/**
 * Raise an invoice for a shipment.
 *
 * The lines COPY their price inputs from the order line — the same thing accepting a
 * proforma does when it copies charges onto the order. Nothing is typed, and the invoice
 * stores no total, so `documentTotalsOf()` remains the only thing that says what it is
 * worth.
 *
 * A shipment may be co-loaded for several buyers, and an invoice is one buyer's document, so
 * the buyer is a required argument and only that buyer's lines are billed.
 */
router.post(
  '/invoices/from-shipment/:shipmentId',
  canManage,
  asyncHandler(async (req, res) => {
    const shipmentId = Number(req.params.shipmentId);
    const { buyerId, invoiceDate, incoterms } = z
      .object({ buyerId: z.number().int(), invoiceDate: z.coerce.date().optional(), incoterms: z.enum(INCOTERMS).optional() })
      .parse(req.body);

    // Read before the transaction: companyState() upserts, and a nested write would deadlock.
    const ourState = await companyState();

    const created = await prisma.$transaction(async (tx) => {
      const shipment = await tx.shipment.findUnique({ where: { id: shipmentId }, include: shipmentInclude });
      if (!shipment) throw new ApiError(404, 'Shipment not found.');
      if (shipment.deletedAt) throw new ApiError(409, `${shipment.number} is in the trash.`);
      if (shipment.status === 'CANCELLED') throw new ApiError(409, `${shipment.number} has been cancelled.`);
      if (shipment.status === 'PLANNED') throw new ApiError(409, `${shipment.number} has not shipped yet. Nothing can be billed until it has.`);

      const mine = shipment.lines.filter((l) => l.packingBatch.orderLine?.order.buyerId === buyerId);
      if (!mine.length) throw new ApiError(409, 'Nothing on that shipment belongs to this buyer.');

      const orderIds = await lockOrders(tx, mine.map((l) => l.packingBatch.orderLine?.orderId));
      // What may still be billed is TOTAL shipped − TOTAL invoiced, per order line. An order
      // line shipped in parts can be billed one dispatch at a time up to what has gone out;
      // comparing a single dispatch's quantity against the order line's whole invoiced total
      // (the old bug) refused a genuinely unbilled shipment once any other part was invoiced.
      const shippedByLine = await shippedQtyByOrderLine(tx);
      const invoicedByLine = await invoicedQtyByOrderLine(tx);
      // Accumulates as lines are added, so two lines of one invoice that bill the same order
      // line cannot both pass the same stale snapshot.
      const billingNow = new Map<number, number>();

      const buyer = await tx.buyer.findUnique({ where: { id: buyerId } });
      if (!buyer) throw new ApiError(404, 'Buyer not found.');
      if (buyer.market === 'DOMESTIC' && !buyer.state) {
        throw new ApiError(409, `${buyer.name} has no state set, so CGST+SGST versus IGST cannot be decided. Set it on the buyer first.`);
      }

      const first = mine[0].packingBatch.orderLine!.order;
      const order = await tx.order.findUniqueOrThrow({ where: { id: first.id }, select: { currencyId: true, exchangeRate: true, incoterms: true } });

      const number = await nextDocNumber(docKeys(buyer.market).invoice, tx);
      const invoice = await tx.invoice.create({
        data: {
          number,
          status: 'DRAFT',
          buyerId,
          currencyId: order.currencyId,
          exchangeRate: order.exchangeRate,
          invoiceDate: invoiceDate ?? new Date(),
          shipmentId,
          incoterms: incoterms ?? order.incoterms,
          // Snapshot the tax basis, exactly as an order does. Read live, correcting an
          // address later would reprint an issued invoice with a different split.
          taxMarket: buyer.market,
          taxBuyerState: buyer.state,
          taxCompanyState: ourState,
          placeOfSupply: buyer.market === 'DOMESTIC' ? buyer.state : null,
          createdById: req.user?.sub ?? null,
        },
      });

      for (const [i, l] of mine.entries()) {
        const ol = l.packingBatch.orderLine!;
        const line = await tx.orderLine.findUniqueOrThrow({
          where: { id: ol.id },
          select: { productId: true, unitPrice: true, discountPct: true, discountAmt: true, gstRatePct: true, hsnCode: true, product: { select: { hsnCode: true, gstRatePct: true } } },
        });

        const shipped = shippedByLine.get(ol.id) ?? 0;
        const already = (invoicedByLine.get(ol.id) ?? 0) + (billingNow.get(ol.id) ?? 0);
        const refusal = guardInvoiceQty(shipped, already, l.qty);
        if (refusal) throw new ApiError(409, refusal);
        billingNow.set(ol.id, (billingNow.get(ol.id) ?? 0) + l.qty);

        await tx.invoiceLine.create({
          data: {
            invoiceId: invoice.id,
            productId: line.productId,
            /**
             * REQUIRED in practice even though the column is nullable: the per-order
             * attribution of a receipt is built from it, so an invoice line without one
             * would show money against the invoice while every order read zero. See the
             * check in `assertInvoiceAttributable` below, which refuses to ISSUE such an
             * invoice at all.
             */
            orderLineId: ol.id,
            shipmentLineId: l.id,
            qty: l.qty,
            // COPIES, not references — the document is frozen against a later correction.
            unitPrice: line.unitPrice,
            discountPct: line.discountPct,
            discountAmt: line.discountAmt,
            gstRatePct: line.gstRatePct || line.product.gstRatePct || 0,
            hsnCode: line.hsnCode ?? line.product.hsnCode,
            sortOrder: i,
          },
        });
      }

      for (const oid of orderIds) await syncShipped(tx, oid);
      return tx.invoice.findUniqueOrThrow({ where: { id: invoice.id }, include: invoiceInclude });
    });

    res.status(201).json(serializeInvoice(created, ourState));
  })
);

const invoiceChargeSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().min(1).max(80),
  kind: z.enum(['CHARGE', 'DISCOUNT']).default('CHARGE'),
  amount: z.number().nonnegative().default(0),
  pct: z.number().nonnegative().default(0),
  gstRatePct: z.number().nonnegative().default(0),
  isTaxable: z.boolean().default(true),
  note: z.string().max(200).nullable().optional(),
  sortOrder: z.number().int().optional(),
});

/**
 * Edit an invoice. Quantities and prices are NOT editable here — they came from the shipment
 * and the order, and there is deliberately no field for them.
 */
const invoiceUpdateSchema = z.object({
  invoiceDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  incoterms: z.enum(INCOTERMS).nullable().optional(),
  placeOfSupply: z.string().max(80).nullable().optional(),
  reverseCharge: z.boolean().optional(),
  irn: z.string().max(80).nullable().optional(),
  ackNo: z.string().max(40).nullable().optional(),
  ackDate: z.coerce.date().nullable().optional(),
  paymentTerms: z.string().max(200).nullable().optional(),
  bankDetails: z.string().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  charges: z.array(invoiceChargeSchema).optional(),
});

router.put(
  '/invoices/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const data = invoiceUpdateSchema.parse(req.body);
    const ourState = await companyState();

    const saved = await prisma.$transaction(async (tx) => {
      const existing = await tx.invoice.findUnique({ where: { id }, select: { deletedAt: true, number: true, status: true } });
      if (!existing) throw new ApiError(404, 'Invoice not found.');
      if (existing.deletedAt) throw new ApiError(409, `${existing.number} is in the trash. Restore it before editing it.`);
      if (existing.status === 'CANCELLED') throw new ApiError(409, `${existing.number} has been cancelled and cannot be edited.`);

      const { charges, ...header } = data;
      await tx.invoice.update({ where: { id }, data: header });

      if (charges) {
        const keep: number[] = [];
        for (const [i, c] of charges.entries()) {
          const row = c.id != null
            ? await tx.invoiceCharge.update({ where: { id: c.id }, data: { ...c, sortOrder: c.sortOrder ?? i, note: c.note ?? null } })
            : await tx.invoiceCharge.create({ data: { ...c, id: undefined, invoiceId: id, sortOrder: c.sortOrder ?? i, note: c.note ?? null } });
          keep.push(row.id);
        }
        await tx.invoiceCharge.deleteMany({ where: { invoiceId: id, id: { notIn: keep.length ? keep : [0] } } });
      }
      return tx.invoice.findUniqueOrThrow({ where: { id }, include: invoiceInclude });
    });

    res.json(serializeInvoice(saved, ourState));
  })
);

/**
 * Refuse to issue an invoice whose lines do not name their order.
 *
 * `InvoiceLine.orderLineId` is nullable because a draft may be assembled in stages, but the
 * per-order attribution under the INVOICE receivable basis is built from it. An issued
 * invoice missing it would settle against `invoiceReceived` while every order it covers read
 * zero received — the two pages disagreeing, silently, with nothing to point at.
 */
function assertInvoiceAttributable(lines: { id: number; orderLineId: number | null }[], number: string) {
  const orphans = lines.filter((l) => l.orderLineId == null);
  if (!orphans.length) return;
  throw new ApiError(
    409,
    `${number} has ${orphans.length} line(s) that do not name an order, so money received against it could not be attributed to anything. Rebuild the invoice from its shipment.`
  );
}

/** Issue it. Only from here does it become a debt. */
router.patch(
  '/invoices/:id/status',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { status } = z.object({ status: z.enum(INVOICE_STATUSES) }).parse(req.body);

    const saved = await prisma.$transaction(async (tx) => {
      const existing = await tx.invoice.findUnique({ where: { id }, select: { deletedAt: true, number: true, status: true, shipmentId: true, lines: { select: { id: true, orderLineId: true } } } });
      if (!existing) throw new ApiError(404, 'Invoice not found.');
      if (existing.deletedAt) throw new ApiError(409, `${existing.number} is in the trash.`);
      // Idempotent: asking for the status it already has is a no-op, not an error.
      if (existing.status === status) return { id, number: existing.number, status: existing.status };

      if (status === 'ISSUED') {
        if (!existing.lines.length) throw new ApiError(409, `${existing.number} has no lines to bill.`);
        if (existing.shipmentId == null) throw new ApiError(409, `${existing.number} names no shipment, so there is nothing to say has gone out.`);
        assertInvoiceAttributable(existing.lines, existing.number);
      }
      if (status === 'DRAFT' && existing.status === 'CANCELLED') {
        throw new ApiError(409, `${existing.number} has been cancelled. Its number is kept on purpose; raise a fresh invoice instead.`);
      }
      return tx.invoice.update({ where: { id }, data: { status } });
    });

    res.json({ id: saved.id, number: saved.number, status: saved.status });
  })
);

const uploadQr = imageUploader('invoice-qr-');

/** The e-invoice QR, through the same magic-byte pipeline as every other image. */
router.post(
  '/invoices/:id/qr',
  canManage,
  uploadQr.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, 'No file was uploaded.');
    const [kept] = keepRealImages([req.file]);
    const id = Number(req.params.id);
    const current = await prisma.invoice.findUnique({ where: { id }, select: { qrFilename: true } });
    if (!current) throw new ApiError(404, 'Invoice not found.');
    await prisma.invoice.update({ where: { id }, data: { qrFilename: kept.filename } });
    // Only once the new one is committed, so a failed write never leaves us with none.
    if (current.qrFilename && current.qrFilename !== kept.filename) {
      await fs.promises.unlink(path.join(uploadDir, current.qrFilename)).catch(() => undefined);
    }
    res.status(201).json({ qrFilename: kept.filename, qrUrl: `/uploads/${kept.filename}` });
  })
);

router.post(
  '/invoices/:id/restore',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.invoice.findUnique({ where: { id }, select: { deletedAt: true, number: true } });
    if (!existing) throw new ApiError(404, 'Invoice not found.');
    if (!existing.deletedAt) throw new ApiError(409, `${existing.number} is not in the trash.`);
    await restore('invoice', id);
    res.json({ restored: true, number: existing.number });
  })
);

router.delete(
  '/invoices/:id/permanent',
  requireRole('Admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.invoice.findUnique({ where: { id }, select: { deletedAt: true, number: true, qrFilename: true, ledger: { select: { id: true } } } });
    if (!existing) throw new ApiError(404, 'Invoice not found.');
    if (!existing.deletedAt) throw new ApiError(409, `${existing.number} is still live. Delete it first, then destroy it from the trash.`);
    if (existing.ledger.length) {
      throw new ApiError(409, `${existing.ledger.length} receipt(s) still name ${existing.number}. Re-aim or remove them first.`);
    }
    await prisma.invoice.delete({ where: { id } });
    if (existing.qrFilename) await fs.promises.unlink(path.join(uploadDir, existing.qrFilename)).catch(() => undefined);
    res.status(204).end();
  })
);

router.delete(
  '/invoices/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.invoice.findUnique({ where: { id }, select: { deletedAt: true, number: true } });
    if (!existing) throw new ApiError(404, 'Invoice not found.');
    if (existing.deletedAt) throw new ApiError(409, `${existing.number} is already in the trash.`);
    const deletedAt = await softDelete('invoice', id);
    res.json({ deleted: true, deletedAt, number: existing.number, note: 'Moved to the trash. It has left the money totals and can be restored.' });
  })
);

// ===========================================================================
// Documents
//
// Every figure on these comes from an engine: the invoice's money from
// `documentTotals()`, the cartons and CBM from the shipping engine. Nothing is added up
// here, so a printed document cannot contradict the page it was printed from.
// ===========================================================================

/** Turn a serialised shipment into what the four shipment documents need. */
function shipmentPdfInput(s: ReturnType<typeof serializeShipment>, co: Awaited<ReturnType<typeof ensureCompany>>) {
  return {
    number: s.number,
    date: s.shipDate ?? s.createdAt,
    company: co,
    status: s.status,
    shippingBillNo: s.shippingBillNo,
    portOfLoading: s.portOfLoading,
    portOfDischarge: s.portOfDischarge,
    finalDestination: s.finalDestination,
    vesselOrFlight: s.vesselOrFlight,
    blAwbNo: s.blAwbNo,
    buyerNames: [...new Set(s.orders.map((o) => o.buyerName))],
    orderNumbers: s.orders.map((o) => o.number),
    totals: s.totals,
    containers: s.containers.map((c) => ({
      code: c.code,
      containerNo: c.containerNo,
      sealNo: c.sealNo,
      tareWeightKg: c.tareWeightKg,
      cartons: c.load.cartons,
      netKg: c.load.netKg,
      grossKg: c.load.grossKg,
      cbm: c.load.cbm,
      vgmKg: c.vgmKg,
      capacityCbm: c.capacityCbm,
      payloadKg: c.payloadKg,
      cbmPct: c.fit.cbmPct,
      kgPct: c.fit.kgPct,
    })),
    lines: s.lines.map((l) => ({
      productCode: l.productCode,
      description: l.productName,
      orderNumber: l.orderNumber,
      buyerName: l.buyerName,
      shippingMarks: l.shippingMarks,
      hsnCode: l.hsnCode,
      cartons: l.cartons,
      qty: l.qty,
      netKg: l.netKg,
      grossKg: l.grossKg,
      cbm: l.cbm,
      containerNo: s.containers.find((c) => c.id === l.containerId)?.containerNo ?? null,
    })),
    notes: s.notes,
  };
}

const sendPdf = (res: Response, pdf: Buffer, filename: string) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(pdf);
};

router.get(
  '/shipments/:id/packing-list',
  canManage,
  asyncHandler(async (req, res) => {
    const s = serializeShipment(await loadShipment(Number(req.params.id)));
    sendPdf(res, await packingListPdf(shipmentPdfInput(s, await ensureCompany())), `${s.number}-packing-list.pdf`);
  })
);

router.get(
  '/shipments/:id/vgm',
  canManage,
  asyncHandler(async (req, res) => {
    const s = serializeShipment(await loadShipment(Number(req.params.id)));
    if (!s.containers.length) throw new ApiError(409, `${s.number} has no containers yet, so there is no gross mass to declare.`);
    sendPdf(res, await vgmPdf(shipmentPdfInput(s, await ensureCompany())), `${s.number}-vgm.pdf`);
  })
);

router.get(
  '/shipments/:id/annexure',
  canManage,
  asyncHandler(async (req, res) => {
    const s = serializeShipment(await loadShipment(Number(req.params.id)));
    sendPdf(res, await containerAnnexurePdf(shipmentPdfInput(s, await ensureCompany())), `${s.number}-annexure.pdf`);
  })
);

router.get(
  '/shipments/:id/coo',
  canManage,
  asyncHandler(async (req, res) => {
    const s = serializeShipment(await loadShipment(Number(req.params.id)));
    sendPdf(res, await certificateOfOriginPdf(shipmentPdfInput(s, await ensureCompany())), `${s.number}-coo.pdf`);
  })
);

/** The invoice, as the buyer receives it. */
async function invoicePdfInput(id: number) {
  const [ourState, co] = await Promise.all([companyState(), ensureCompany()]);
  const inv = serializeInvoice(await loadInvoice(id), ourState);
  return {
    inv,
    input: {
      number: inv.number,
      date: inv.invoiceDate,
      dueDate: inv.dueDate,
      currencyCode: inv.currency?.code ?? 'INR',
      company: co,
      buyer: {
        name: inv.buyer.name,
        address: inv.buyer.address,
        country: inv.buyer.country,
        contactName: inv.buyer.contactName,
        email: inv.buyer.email,
        phone: inv.buyer.phone,
        gstNo: inv.buyer.gstNo,
        // The SNAPSHOT decides the tax, not the live buyer — an address corrected later
        // must not reprint an issued invoice with a different split.
        state: inv.taxBuyerState ?? inv.buyer.state,
        market: inv.taxMarket ?? inv.buyer.market,
        channel: inv.buyer.channel,
      },
      incoterms: inv.incoterms,
      paymentTerms: inv.paymentTerms,
      bankDetails: inv.bankDetails,
      notes: inv.notes,
      placeOfSupply: inv.placeOfSupply,
      reverseCharge: inv.reverseCharge,
      irn: inv.irn,
      ackNo: inv.ackNo,
      shipment: inv.shipment,
      lines: inv.lines.map((l) => ({
        description: l.productName,
        productCode: l.productCode,
        unit: l.unit,
        orderNumber: l.orderNumber,
        qty: l.qty,
        unitPrice: l.unitPrice,
        discountPct: l.discountPct,
        discountAmt: l.discountAmt,
        gstRatePct: l.gstRatePct,
        hsnCode: l.hsnCode,
      })),
      charges: inv.charges,
    },
  };
}

router.get(
  '/invoices/:id/pdf',
  canManage,
  asyncHandler(async (req, res) => {
    const { inv, input } = await invoicePdfInput(Number(req.params.id));
    sendPdf(res, await invoicePdf(input), `${inv.number}.pdf`);
  })
);

/**
 * The invoice as an editable e-mail draft.
 *
 * `mailto:` cannot carry an attachment — the URI scheme has no field for one and no client
 * accepts it — so Send offers both: a mailto link for the text, and this .eml carrying the
 * PDF as a base64 MIME part. `X-Unsent: 1` makes Outlook open it as a draft rather than a
 * received message. Do not "fix" this by trying to attach via mailto.
 */
router.get(
  '/invoices/:id/mail.eml',
  canManage,
  asyncHandler(async (req, res) => {
    const { inv, input } = await invoicePdfInput(Number(req.params.id));
    const pdf = await invoicePdf(input);
    const title = invoiceTitle(inv.taxMarket ?? inv.buyer.market);
    const total = amount(inv.totals.grandTotal, inv.currency?.code ?? 'INR');
    const text = [
      `Dear ${inv.buyer.contactName || inv.buyer.name},`,
      '',
      `Please find attached our ${title.toLowerCase()} ${inv.number} for ${total}.`,
      ...(inv.shipment?.number ? [`Dispatched under ${inv.shipment.number}.`] : []),
      ...(inv.paymentTerms ? [`Payment terms: ${inv.paymentTerms}.`] : []),
      '',
      'Kind regards,',
      req.user?.name ?? '',
    ]
      .filter((l) => l !== undefined)
      .join('\n');

    const eml = buildEml({
      to: inv.buyer.email ? [inv.buyer.email] : [],
      subject: `${title} ${inv.number}`,
      text,
      html: `<p>${text.replace(/\n/g, '<br/>')}</p>`,
      attachments: [{ filename: `${inv.number}.pdf`, contentType: 'application/pdf', content: pdf }],
    });
    res.setHeader('Content-Type', 'message/rfc822');
    res.setHeader('Content-Disposition', `attachment; filename="${inv.number}.eml"`);
    res.send(eml);
  })
);

// ===========================================================================
// One order's whole fulfilment picture
// ===========================================================================

/**
 * Everything that happened to an order AFTER the board finished with it.
 *
 * The order is the record a person opens to ask about a job, so it has to be able to answer
 * the question in one read: what is finished, what is boxed, what left, what was billed, in
 * which container, under which invoice. Without this the answer was spread over four list
 * pages that each had to be filtered by hand.
 *
 * Every figure is DERIVED — `finishedPosition` off the live board, the packing and shipment
 * totals through the shipping engine, the invoice money through `documentTotalsOf`. This
 * endpoint stores and sums nothing of its own, so it cannot contradict the pages it
 * summarises.
 *
 * It is deliberately NOT folded into `serializeOrder`: that runs once per row of the orders
 * list, and loading the finished position for every order to draw a list would be several
 * board walks per row.
 */
router.get(
  '/orders/:id/fulfilment',
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, number: true, buyerId: true, lines: { select: { id: true, qty: true, productId: true, product: { select: { factoryCode: true, name: true } } }, orderBy: { sortOrder: 'asc' } } },
    });
    if (!order) throw new ApiError(404, 'Order not found.');

    const [pos, shipped, invoiced, batches, shipments, invoices, ourState] = await Promise.all([
      finishedPosition(prisma, [...new Set(order.lines.map((l) => l.productId))]),
      shippedQtyByOrderLine(prisma, orderId),
      invoicedQtyByOrderLine(prisma, orderId),
      prisma.packingBatch.findMany({ where: { orderLine: { orderId } }, include: packingInclude, orderBy: [{ packedOn: 'desc' }, { id: 'desc' }] }),
      // A shipment is reachable from the order through the batches it is carrying — there is
      // no direct link, because one container may hold several orders' goods.
      prisma.shipment.findMany({
        where: { ...notDeleted, lines: { some: { packingBatch: { orderLine: { orderId } } } } },
        include: shipmentInclude,
        orderBy: [{ shipDate: 'desc' }, { id: 'desc' }],
      }),
      prisma.invoice.findMany({
        where: { ...notDeleted, lines: { some: { orderLine: { orderId } } } },
        include: invoiceInclude,
        orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }],
      }),
      companyState(),
    ]);

    const lines = order.lines.map((l) => {
      const c = pos.byOrderLine.get(l.id);
      return {
        orderLineId: l.id,
        productId: l.productId,
        productCode: l.product.factoryCode,
        productName: l.product.name,
        ordered: l.qty,
        boardDone: c?.boardDone ?? 0,
        adjusted: c?.adjusted ?? 0,
        returned: c?.returned ?? 0,
        packed: c?.packed ?? 0,
        shipped: shipped.get(l.id) ?? 0,
        /** Cancelled invoices excluded — see `invoicedQtyByOrderLine`. */
        invoiced: invoiced.get(l.id) ?? 0,
        onHand: c?.onHand ?? 0,
        availableToPack: c?.availableToPack ?? 0,
        availableToShip: c?.availableToShip ?? 0,
        overProduced: c?.overProduced ?? 0,
      };
    });

    const sum = (pick: (l: (typeof lines)[number]) => number) => lines.reduce((a, l) => a + pick(l), 0);

    res.json({
      orderId: order.id,
      number: order.number,
      lines,
      totals: {
        ordered: sum((l) => l.ordered),
        finished: sum((l) => l.boardDone + l.adjusted + l.returned),
        packed: sum((l) => l.packed),
        shipped: sum((l) => l.shipped),
        invoiced: sum((l) => l.invoiced),
        availableToPack: sum((l) => l.availableToPack),
        availableToShip: sum((l) => l.availableToShip),
      },
      batches: batches.map((b) => serializePacking(b)),
      /**
       * A co-loaded shipment is returned whole, with `mine` naming the part that belongs to
       * this order — the container fit is a property of the box, not of one order's share of
       * it, so trimming the lines would make the capacity bar lie.
       */
      shipments: shipments.map((s) => {
        const full = serializeShipment(s);
        const mine = full.lines.filter((l) => l.orderId === orderId);
        return {
          ...full,
          mine: { cartons: mine.reduce((a, l) => a + l.cartons, 0), pieces: mine.reduce((a, l) => a + l.qty, 0) },
          coLoaded: full.orders.length > 1,
        };
      }),
      invoices: invoices.map((i) => {
        const full = serializeInvoice(i, ourState);
        return { ...full, mine: { pieces: full.lines.filter((l) => l.orderId === orderId).reduce((a, l) => a + l.qty, 0) }, spansOrders: full.orders.length > 1 };
      }),
    });
  })
);

// ===========================================================================
// The module dashboard
// ===========================================================================

router.get(
  '/sales/dashboard',
  asyncHandler(async (_req, res) => {
    const [pos, shipments, invoices, ourState] = await Promise.all([
      finishedPosition(),
      prisma.shipment.findMany({ where: notDeleted, include: shipmentInclude }),
      prisma.invoice.findMany({ where: { ...notDeleted, status: { not: 'CANCELLED' } }, include: invoiceInclude }),
      companyState(),
    ]);

    const cells = [...pos.byProduct.values()];
    const live = shipments.filter((s) => s.status !== 'CANCELLED').map(serializeShipment);
    const priced = invoices.map((i) => serializeInvoice(i, ourState));

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    res.json({
      finishedOnHand: cells.reduce((a, c) => a + c.onHand, 0),
      readyToPack: cells.reduce((a, c) => a + c.availableToPack, 0),
      packedAwaitingShipment: cells.reduce((a, c) => a + c.availableToShip, 0),
      cartonsAwaitingShipment: live.reduce((a, s) => a + s.unassigned.cartons, 0),
      shipmentsThisMonth: live.filter((s) => s.shipDate && new Date(s.shipDate) >= monthStart).length,
      shipmentsPlanned: live.filter((s) => s.status === 'PLANNED').length,
      shipmentsInTransit: live.filter((s) => s.status === 'SHIPPED').length,
      /** Gone but not billed — the row somebody actually has to act on. */
      shippedNotInvoiced: live.filter((s) => s.status !== 'PLANNED' && !s.invoices.some((v) => v.status === 'ISSUED')).length,
      invoicesDraft: priced.filter((i) => i.status === 'DRAFT').length,
      invoicesIssued: priced.filter((i) => i.status === 'ISSUED').length,
      invoicedInr: round(priced.filter((i) => i.status === 'ISSUED').reduce((a, i) => a + i.totals.grandTotal * (i.exchangeRate ?? 1), 0)),
    });
  })
);

export default router;
