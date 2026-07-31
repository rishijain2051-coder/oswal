import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db';
import { ApiError, asyncHandler, guardIdParams } from '../lib/http';
import { authenticate, can, canAny, may } from '../middleware/auth';
import { nextDocNumber } from '../lib/numbering';
import { computeCostSheet } from '../lib/productCosting';
import { loadMethodMap } from '../lib/methods';
import { round } from '../lib/costing';
import { buildBoard, expandHops, MOVE_KINDS, validateMove, type MoveRow } from '../lib/production';
import { loadOrder, loadSerializedOrder, materializeStages, orderInclude, resolveStageLineId, serializeOrders, syncOrderStatus } from '../lib/orderBoard';
import { shippedQtyByOrderLine } from '../lib/salesBoard';
import { orderPdf, proformaPdf } from '../lib/docPdf';
import { CHARGE_KINDS, docKeys, documentTotalsOf, isDomestic, lineGross, lineNet } from '../lib/pricing';
import { companyState, ensureCompany, type CompanyProfile } from '../lib/company';
import { assertLive, notDeleted, restore, softDelete } from '../lib/softDelete';
import { lockOrder } from '../lib/rowLock';
import { ATTACHMENT_LABELS, attachmentUploader, keepRealDocuments } from '../lib/documentUpload';
import { DELIVERY_URGENCY, autoSchedule, deliveryStatus } from '../lib/scheduling';
import { buildEml, mailtoUrl, proformaMail } from '../lib/mailDraft';
import { imageUploader, keepRealImages, uploadDir } from '../lib/imageUpload';
import { validateMoveWorkers } from '../lib/workforce';
import { diffFields, logChanges } from '../lib/changeLog';

const router = Router();
// A route param here is always a database id — see guardIdParams.
guardIdParams(router);
router.use(authenticate);

// Hand-over photos share the product-image folder, served at /uploads behind auth.
const uploadPhotos = imageUploader('move-');

export const ORDER_STATUSES = ['Confirmed', 'Production', 'Ready', 'Shipped', 'Closed', 'Cancelled'] as const;
export const PROFORMA_STATUSES = ['Draft', 'Sent', 'Accepted', 'Rejected'] as const;

/**
 * The costed floor for a product, in rupees, on the right basis for the market.
 *
 * An export is quoted at FOB. A domestic sale has no CHA, no forwarder and no ICD, so it
 * is quoted at Non-FOB — the same roll-up with the whole Forwarding head excluded. Both
 * figures already come out of the costing engine; nothing is recalculated here.
 */
async function productFloorInr(productId: number, market: string | null | undefined): Promise<{ value: number; basis: 'FOB' | 'NON_FOB'; gstRatePct: number; hsnCode: string | null }> {
  const [methods, product] = await Promise.all([
    loadMethodMap(),
    prisma.product.findUnique({
      where: { id: productId },
      include: { costSheets: { where: { isActive: true }, include: { groups: { include: { lines: true } } } } },
    }),
  ]);
  const computed = computeCostSheet(product?.costSheets?.[0], methods) as any;
  const domestic = isDomestic(market);
  return {
    value: (domestic ? computed?.summary?.nonFob : computed?.summary?.fob) ?? 0,
    basis: domestic ? 'NON_FOB' : 'FOB',
    gstRatePct: product?.gstRatePct ?? 0,
    hsnCode: product?.hsnCode ?? null,
  };
}

/**
 * Suggested selling price. Domestic buyers are quoted Non-FOB in rupees; overseas
 * buyers FOB converted at the currency's rate. The response also carries the product's
 * tax classification so a domestic line can seed its GST rate in the same round-trip.
 */
router.get(
  '/ops/price',
  canAny('orders.view', 'proformas.view'),
  asyncHandler(async (req, res) => {
    const productId = Number(req.query.productId);
    const currencyId = req.query.currencyId ? Number(req.query.currencyId) : undefined;
    const buyerId = req.query.buyerId ? Number(req.query.buyerId) : undefined;
    const buyer = buyerId ? await prisma.buyer.findUnique({ where: { id: buyerId }, select: { market: true } }) : null;
    const floor = await productFloorInr(productId, buyer?.market);
    const currency = currencyId ? await prisma.currency.findUnique({ where: { id: currencyId } }) : null;
    const rate = currency?.rateToBase ?? 1;
    res.json({
      // Kept as `fobInr` because that is the field the client already reads; `basis`
      // says which roll-up it actually is.
      fobInr: round(floor.value),
      basis: floor.basis,
      rate,
      currencyCode: currency?.code ?? 'INR',
      suggested: round(floor.value / (rate || 1)),
      gstRatePct: floor.gstRatePct,
      hsnCode: floor.hsnCode,
    });
  })
);

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

router.get(
  '/orders',
  can('orders.view'),
  asyncHandler(async (req, res) => {
    const status = req.query.status as string | undefined;
    const orders = await prisma.order.findMany({ where: { ...notDeleted, ...(status ? { status } : {}) }, include: orderInclude, orderBy: { orderDate: 'desc' } });
    res.json(await serializeOrders(orders));
  })
);

/** What is in the order trash. Declared before `/orders/:id` so the literal wins. */
router.get(
  '/orders/trash',
  can('orders.view', 'orders.restore'),
  asyncHandler(async (_req, res) => {
    res.json(
      await prisma.order.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, number: true, status: true, orderDate: true, deletedAt: true, buyer: { select: { name: true } } },
        orderBy: { deletedAt: 'desc' },
      })
    );
  })
);

/**
 * Every live order with its delivery verdict, most urgent first.
 *
 * Registered before `/orders/:id` so the literal path is not swallowed by it.
 */
router.get(
  '/orders/delivery-status',
  can('orders.view', 'orders.schedule.view'),
  asyncHandler(async (_req, res) => {
    const orders = await prisma.order.findMany({
      where: { ...notDeleted, status: { notIn: ['Cancelled'] } },
      select: {
        id: true,
        number: true,
        status: true,
        orderDate: true,
        deliveryDate: true,
        expectedDelivery: true,
        buyer: { select: { id: true, name: true, market: true } },
        currency: { select: { code: true, symbol: true } },
        lines: { select: { qty: true, stages: { orderBy: { sortOrder: 'asc' } }, moves: true } },
      },
      orderBy: [{ deliveryDate: 'asc' }],
    });

    const rows = orders.map((o) => {
      // Progress from the board, exactly as the order page derives it.
      const boards = o.lines.map((l) => buildBoard(l.qty, l.stages as never, l.moves as never));
      const qty = boards.reduce((a, b) => a + b.qty, 0);
      const done = boards.reduce((a, b) => a + b.done, 0);
      const verdict = deliveryStatus({ status: o.status, deliveryDate: o.deliveryDate, expectedDelivery: o.expectedDelivery, qty, done });
      return {
        orderId: o.id,
        number: o.number,
        status: o.status,
        buyerId: o.buyer.id,
        buyerName: o.buyer.name,
        market: o.buyer.market,
        orderDate: o.orderDate,
        deliveryDate: o.deliveryDate,
        expectedDelivery: o.expectedDelivery,
        qty,
        done,
        wip: boards.reduce((a, b) => a + b.wip, 0),
        // Named apart from the order's own `status`, which means something different.
        deliveryStatus: verdict.status,
        percentComplete: verdict.percentComplete,
        daysToDelivery: verdict.daysToDelivery,
        daysLate: verdict.daysLate,
        reason: verdict.reason,
      };
    });

    rows.sort(
      (a, b) => DELIVERY_URGENCY[a.deliveryStatus] - DELIVERY_URGENCY[b.deliveryStatus] || (a.daysToDelivery ?? 9e9) - (b.daysToDelivery ?? 9e9)
    );

    const counts = { LATE: 0, AT_RISK: 0, ON_TRACK: 0, NO_DATE: 0, DELIVERED: 0 } as Record<string, number>;
    for (const r of rows) counts[r.deliveryStatus] = (counts[r.deliveryStatus] ?? 0) + 1;
    res.json({ rows, counts });
  })
);

router.get(
  '/orders/:id',
  can('orders.view'),
  asyncHandler(async (req, res) => {
    res.json(await loadSerializedOrder(Number(req.params.id)));
  })
);

/** A document-level extra cost or discount. Shared by proformas and orders. */
/**
 * A document-level charge or discount. Amounts are stored positive; `kind` carries the sign.
 *
 * Both figures at zero is refused rather than saved. It is worth nothing by definition, and
 * `documentTotalsOf` still produces a row for it — so it printed as a ₹0.00 line on the
 * proforma and the invoice, which is the sort of thing a buyer asks about.
 */
const chargeSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(CHARGE_KINDS).default('CHARGE'),
    amount: z.number().min(0).default(0),
    pct: z.number().min(0).max(100).default(0),
    gstRatePct: z.number().min(0).max(100).default(0),
    isTaxable: z.boolean().default(true),
    note: z.string().nullable().optional(),
  })
  .refine((c) => c.amount > 0 || c.pct > 0, {
    message: 'Give the charge an amount or a percentage — a zero charge would print as a ₹0.00 line.',
    path: ['amount'],
  });

/** Tax and discount fields a product line may carry. Ignored on an export. */
const lineTaxFields = {
  discountPct: z.number().min(0).max(100).default(0),
  discountAmt: z.number().min(0).default(0),
  gstRatePct: z.number().min(0).max(100).default(0),
  hsnCode: z.string().nullable().optional(),
};

const orderLineSchema = z.object({
  id: z.number().int().optional(),
  productId: z.number().int(),
  qty: z.number().int().positive(),
  unitPrice: z.number().min(0),
  ...lineTaxFields,
});

const orderSchema = z.object({
  buyerId: z.number().int(),
  currencyId: z.number().int().nullable().optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  orderDate: z.string().datetime().optional(),
  deliveryDate: z.string().datetime().nullable().optional(),
  incoterms: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  lines: z.array(orderLineSchema).default([]),
  charges: z.array(chargeSchema).default([]),
});

/**
 * The tax and discount columns of an order line, for a create or an update.
 *
 * An export stores ZERO rates rather than trusting the client to have cleared them. The
 * engine already ignores rates on an untaxed document, but a stored 18% would start
 * taxing real money the moment that buyer's market was switched to DOMESTIC.
 */
const orderLineTax = (l: z.output<typeof orderLineSchema>, domestic: boolean) => ({
  discountPct: l.discountPct,
  discountAmt: l.discountAmt,
  gstRatePct: domestic ? l.gstRatePct : 0,
  hsnCode: domestic ? l.hsnCode?.trim() || null : null,
});

router.post(
  '/orders',
  can('orders.view', 'orders.create'),
  asyncHandler(async (req, res) => {
    const data = orderSchema.parse(req.body);
    if (data.lines.length === 0) throw new ApiError(400, 'An order needs at least one product line.');
    const buyer = await prisma.buyer.findUnique({ where: { id: data.buyerId }, select: { market: true, state: true } });
    if (!buyer) throw new ApiError(404, 'Buyer not found.');
    const domestic = isDomestic(buyer.market);
    // A product in the trash is invisible everywhere; quoting one would create a live
    // order line pointing at something nobody can see.
    await assertLive('product', data.lines.map((l) => l.productId), 'an order');
    const number = await nextDocNumber(docKeys(buyer.market).order);
    const ourState = await companyState();
    const currency = data.currencyId ? await prisma.currency.findUnique({ where: { id: data.currencyId } }) : null;
    // A domestic sale is priced off Non-FOB IN RUPEES. Left in a foreign currency the
    // suggestion would be divided by that rate and the whole document, GST included,
    // would be denominated in euro — and a rupee receipt could never settle it.
    assertCurrencyForMarket(domestic, currency);

    const created = await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          number,
          buyerId: data.buyerId,
          currencyId: data.currencyId ?? null,
          status: data.status ?? 'Confirmed',
          orderDate: data.orderDate ? new Date(data.orderDate) : new Date(),
          deliveryDate: data.deliveryDate ? new Date(data.deliveryDate) : null,
          incoterms: data.incoterms ?? null,
          notes: data.notes ?? null,
          exchangeRate: currency?.rateToBase ?? null,
          createdById: req.user!.sub,
          // The tax basis, frozen now. Correcting the buyer's address later must not
          // restate what this order is worth.
          taxMarket: buyer.market,
          taxBuyerState: buyer.state,
          taxCompanyState: ourState,
          charges: { create: chargeRows(data.charges, domestic) },
        },
      });
      for (let i = 0; i < data.lines.length; i++) {
        const l = data.lines[i];
        const stageLineId = await resolveStageLineId(tx, l.productId);
        const line = await tx.orderLine.create({ data: { orderId: order.id, productId: l.productId, qty: l.qty, unitPrice: l.unitPrice, ...orderLineTax(l, domestic), sortOrder: i, stageLineId } });
        await materializeStages(tx, line.id, stageLineId);
      }
      return order;
    });

    res.status(201).json(await loadSerializedOrder(created.id));
  })
);

router.put(
  '/orders/:id',
  can('orders.view', 'orders.edit'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const data = orderSchema.parse(req.body);
    if (data.lines.length === 0) throw new ApiError(400, 'An order needs at least one product line.');

    const existing = await prisma.order.findUnique({
      where: { id },
      select: {
        number: true,
        deletedAt: true,
        charges: { select: { name: true, kind: true, amount: true, pct: true, gstRatePct: true, isTaxable: true }, orderBy: { sortOrder: 'asc' } },
        lines: { select: { id: true, unitPrice: true, discountPct: true, discountAmt: true, gstRatePct: true } },
      },
    });
    if (!existing) throw new ApiError(404, 'Order not found.');
    if (existing.deletedAt) throw new ApiError(409, `${existing.number} is in the trash. Restore it before editing it.`);

    // Editing an order and RE-PRICING it are separate permissions, so which one this request
    // needs depends on whether any money moved. A coordinator may fix a quantity or a
    // delivery date on a confirmed order without being able to change what the buyer owes.
    //
    // Compared against what is stored rather than trusted from a flag in the payload: the
    // client always posts the whole order, so every save would otherwise look like a
    // re-price. `differs` is not reused here because that helper works on change-log rows.
    const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
    const priorLine = new Map(existing.lines.map((l) => [l.id, l]));
    const linesRepriced = data.lines.some((l) => {
      // A new line has no prior price, and setting one is pricing.
      if (!l.id) return l.unitPrice !== 0 || l.discountPct !== 0 || l.discountAmt !== 0;
      const prev = priorLine.get(l.id);
      if (!prev) return true;
      return (
        !near(prev.unitPrice, l.unitPrice) ||
        !near(prev.discountPct, l.discountPct) ||
        !near(prev.discountAmt, l.discountAmt) ||
        !near(prev.gstRatePct ?? 0, l.gstRatePct ?? 0)
      );
    });
    // Charges are replaced wholesale on save, so any difference in count or content counts.
    const chargesChanged =
      data.charges.length !== existing.charges.length ||
      data.charges.some((c, i) => {
        const prev = existing.charges[i];
        return (
          !prev ||
          prev.kind !== c.kind ||
          prev.name !== c.name ||
          prev.isTaxable !== c.isTaxable ||
          !near(prev.amount, c.amount) ||
          !near(prev.pct, c.pct) ||
          !near(prev.gstRatePct, c.gstRatePct)
        );
      });

    if ((linesRepriced || chargesChanged) && !may(req, 'orders.pricing')) {
      throw new ApiError(403, 'You do not have permission to do this. Changing a price, a discount or a charge needs "Edit order pricing".');
    }

    const putBuyer = await prisma.buyer.findUnique({ where: { id: data.buyerId }, select: { market: true, state: true } });
    if (!putBuyer) throw new ApiError(404, 'Buyer not found.');
    const domestic = isDomestic(putBuyer.market);
    await assertLive('product', data.lines.map((l) => l.productId), 'an order');
    const putCurrency = data.currencyId ? await prisma.currency.findUnique({ where: { id: data.currencyId } }) : null;
    assertCurrencyForMarket(domestic, putCurrency);
    const putState = await companyState();

    // Lines are matched by id and PATCHED — never wiped and rebuilt — so stage
    // snapshots and movement history survive an edit.
    const keptIds = new Set(data.lines.filter((l) => l.id).map((l) => l.id!));

    await prisma.$transaction(async (tx) => {
      // LOCKED FIRST. Every check below reads the movement ledger and the writes that
      // follow depend on what it found, so a clearance landing in between would make the
      // edit act on a board that no longer exists — a quantity could be lowered past
      // pieces that had just entered production. See lib/rowLock.ts.
      if (!(await lockOrder(tx, id))) throw new ApiError(404, 'Order not found.');

      // Read the lines under the lock rather than before it, which is the whole point:
      // anything fetched earlier is a snapshot from before this route had exclusive use
      // of the order. These rows are also the `prev` values the change log diffs against.
      const lines = await tx.orderLine.findMany({
        where: { orderId: id },
        include: { stages: true, moves: true, product: { select: { factoryCode: true } } },
      });

      for (const line of lines) {
        if (keptIds.has(line.id)) continue;
        if (line.moves.length > 0) {
          throw new ApiError(409, `Cannot remove ${line.product.factoryCode}: it has ${line.moves.length} production movement(s). Undo them first.`);
        }
      }

      for (const incoming of data.lines) {
        if (!incoming.id) continue;
        const line = lines.find((l) => l.id === incoming.id);
        if (!line) throw new ApiError(400, `Line ${incoming.id} does not belong to this order.`);
        const board = buildBoard(line.qty, line.stages as any, line.moves as any);
        const committed = board.wip + board.done;
        if (incoming.qty < committed) {
          throw new ApiError(409, `${line.product.factoryCode}: ${committed} pc(s) are already in production or finished — quantity cannot drop below that.`);
        }
        if (incoming.productId !== line.productId && line.moves.length > 0) {
          throw new ApiError(409, `${line.product.factoryCode}: the product cannot be swapped once production has started.`);
        }
      }

      await tx.order.update({
        where: { id },
        data: {
          buyerId: data.buyerId,
          currencyId: data.currencyId ?? null,
          ...(data.status ? { status: data.status } : {}),
          ...(data.orderDate ? { orderDate: new Date(data.orderDate) } : {}),
          deliveryDate: data.deliveryDate ? new Date(data.deliveryDate) : null,
          incoterms: data.incoterms ?? null,
          notes: data.notes ?? null,
          // The snapshotted rate must move WITH the currency. Left behind, a rupee order
          // edited to USD keeps rate 1 and the forex card books a phantom gain of the
          // whole order value; a USD order edited to GBP keeps the dollar rate forever.
          exchangeRate: putCurrency?.rateToBase ?? null,
          // And the tax basis must follow the buyer, or moving a domestic order from a
          // Rajasthan buyer to a Gujarat one keeps the intra-state snapshot and the PDF
          // prints CGST + SGST on what is now an inter-state sale.
          taxMarket: putBuyer.market,
          taxBuyerState: putBuyer.state,
          taxCompanyState: putState,
        },
      });

      // Charges carry no history and nothing references one by id, so unlike lines they
      // are replaced wholesale.
      await tx.orderCharge.deleteMany({ where: { orderId: id } });
      for (const c of chargeRows(data.charges, domestic)) await tx.orderCharge.create({ data: { orderId: id, ...c } });

      for (const line of lines) {
        if (!keptIds.has(line.id)) await tx.orderLine.delete({ where: { id: line.id } });
      }

      for (let i = 0; i < data.lines.length; i++) {
        const l = data.lines[i];
        if (l.id) {
          const prev = lines.find((x) => x.id === l.id)!;
          await tx.orderLine.update({ where: { id: l.id }, data: { productId: l.productId, qty: l.qty, unitPrice: l.unitPrice, ...orderLineTax(l, domestic), sortOrder: i } });
          await logChanges(
            tx,
            { type: 'Order', id },
            { id: req.user!.sub, name: req.user!.name },
            diffFields('OrderLine', l.id, prev, { unitPrice: l.unitPrice, qty: l.qty, discountPct: l.discountPct, discountAmt: l.discountAmt, gstRatePct: l.gstRatePct }, [
              { field: 'unitPrice', label: 'unit price' },
              { field: 'qty', label: 'quantity' },
              { field: 'discountPct', label: 'discount %' },
              { field: 'discountAmt', label: 'discount amount' },
              { field: 'gstRatePct', label: 'GST rate' },
            ], prev.product.factoryCode)
          );
          if (l.productId !== prev.productId) {
            const stageLineId = await resolveStageLineId(tx, l.productId);
            await tx.orderLine.update({ where: { id: l.id }, data: { stageLineId } });
            await materializeStages(tx, l.id, stageLineId);
          }
        } else {
          const stageLineId = await resolveStageLineId(tx, l.productId);
          const line = await tx.orderLine.create({ data: { orderId: id, productId: l.productId, qty: l.qty, unitPrice: l.unitPrice, ...orderLineTax(l, domestic), sortOrder: i, stageLineId } });
          await materializeStages(tx, line.id, stageLineId);
        }
      }
      await syncOrderStatus(tx, id);
    });

    res.json(await loadSerializedOrder(id));
  })
);

/**
 * Set a status a HUMAN owns — only `Closed` or `Cancelled`.
 *
 * Confirmed / Production / Ready / Shipped are DERIVED from the board and the shipments
 * (see `impliedOrderStatus`), so setting one by hand is meaningless: the next clearance or
 * dispatch would overwrite it. The route refuses them with a message that says where they
 * come from, rather than letting a dropdown offer a choice that does not stick. To leave a
 * terminal state, use `POST /orders/:id/reopen`.
 */
router.patch(
  '/orders/:id/status',
  can('orders.view', 'orders.status'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { status } = z.object({ status: z.enum(['Closed', 'Cancelled'] as const) }).parse(req.body);
    const order = await prisma.order.findUnique({ where: { id }, select: { status: true, number: true, deletedAt: true } });
    if (!order) throw new ApiError(404, 'Order not found.');
    if (order.deletedAt) throw new ApiError(409, `${order.number} is in the trash. Restore it first.`);
    if (order.status === status) return res.json(await loadSerializedOrder(id));
    await prisma.order.update({ where: { id }, data: { status } });
    res.json(await loadSerializedOrder(id));
  })
);

/**
 * Leave a terminal state (`Closed` / `Cancelled`) and let the board and shipments decide
 * the status again — the mirror of `POST /proformas/:id/reopen`.
 *
 * Reopening writes `Confirmed` and then re-derives, passing the shipped quantity so a still
 * fully-shipped order returns to `Shipped` rather than falling back to `Ready`.
 */
router.post(
  '/orders/:id/reopen',
  can('orders.view', 'orders.reopen'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const order = await prisma.order.findUnique({ where: { id }, select: { status: true, number: true, deletedAt: true } });
    if (!order) throw new ApiError(404, 'Order not found.');
    if (order.deletedAt) throw new ApiError(409, `${order.number} is in the trash. Restore it first.`);
    if (order.status !== 'Closed' && order.status !== 'Cancelled') {
      throw new ApiError(409, `${order.number} is not closed or cancelled — its status already follows the board.`);
    }
    await prisma.$transaction(async (tx) => {
      // Back to a non-terminal state so `impliedOrderStatus` will restate it, then re-derive
      // with the shipped figure so a fully-shipped order returns to Shipped.
      await tx.order.update({ where: { id }, data: { status: 'Confirmed' } });
      const shipped = await shippedQtyByOrderLine(tx, id);
      const total = [...shipped.values()].reduce((a, n) => a + n, 0);
      await syncOrderStatus(tx, id, total);
    });
    res.json(await loadSerializedOrder(id));
  })
);


router.post(
  '/orders/:id/restore',
  can('orders.view', 'orders.restore'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.order.findUnique({ where: { id }, select: { deletedAt: true, number: true } });
    if (!existing) throw new ApiError(404, 'Order not found.');
    if (!existing.deletedAt) throw new ApiError(409, `${existing.number} is not in the trash.`);
    await restore('order', id);
    res.json({ restored: true, number: existing.number });
  })
);

/** Destroy for good. Admin only, only from the trash, no waiting period. */
router.delete(
  '/orders/:id/permanent',
  can('orders.view', 'orders.restore', 'orders.purge'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.order.findUnique({ where: { id }, select: { deletedAt: true, number: true } });
    if (!existing) throw new ApiError(404, 'Order not found.');
    if (!existing.deletedAt) throw new ApiError(409, `${existing.number} is still live. Delete it first, then destroy it from the trash.`);

    // Attachments and hand-over photos cascade as ROWS but not as FILES, so gather the
    // names before the delete — otherwise 250 MB of paperwork is orphaned on disk with
    // nothing left pointing at it.
    const [attachments, photos] = await Promise.all([
      prisma.orderAttachment.findMany({ where: { orderId: id }, select: { filename: true } }),
      prisma.stageMovePhoto.findMany({ where: { move: { orderLine: { orderId: id } } }, select: { filename: true } }),
    ]);
    await prisma.order.delete({ where: { id } });
    for (const f of [...attachments, ...photos]) {
      await fs.promises.unlink(path.join(uploadDir, f.filename)).catch(() => undefined);
    }
    res.status(204).end();
  })
);

/**
 * Move an order to the trash. Its production history, charges and ledger rows all
 * survive; it simply leaves every list and the money picture — the same way a cancelled
 * order does — and can be restored intact.
 */
router.delete(
  '/orders/:id',
  can('orders.view', 'orders.delete'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.order.findUnique({ where: { id }, select: { deletedAt: true, number: true } });
    if (!existing) throw new ApiError(404, 'Order not found.');
    if (existing.deletedAt) throw new ApiError(409, `${existing.number} is already in the trash.`);
    const deletedAt = await softDelete('order', id);
    res.json({ deleted: true, deletedAt, number: existing.number, note: 'Moved to the trash. It has left the money totals and can be restored.' });
  })
);

// ---------------------------------------------------------------------------
// Production routing for one order line
// ---------------------------------------------------------------------------

/**
 * Who does what, stage by stage. There is no "outsourced till N" any more: each
 * stage independently belongs to us (vendorId null) or to a vendor, so any pattern
 * works — 1-3 in-house, 4 outsourced, 5-6 in-house included.
 */
const routingSchema = z.object({
  stageLineId: z.number().int().nullable().optional(),
  stages: z
    .array(
      z.object({
        id: z.number().int(),
        vendorId: z.number().int().nullable().optional(),
        jobworkRate: z.number().min(0).optional(),
        /** ₹ per piece for in-house workers. Zero is normal — that stage is day-wage. */
        labourRate: z.number().min(0).optional(),
        note: z.string().nullable().optional(),
      })
    )
    .optional(),
});

router.patch(
  '/order-lines/:id/routing',
  can('orders.view', 'board.view', 'board.routing'),
  asyncHandler(async (req, res) => {
    const lineId = Number(req.params.id);
    const data = routingSchema.parse(req.body);
    const line = await prisma.orderLine.findUnique({ where: { id: lineId }, include: { stages: true } });
    if (!line) throw new ApiError(404, 'Order line not found.');

    // Deciding WHERE a stage is done and deciding WHAT IT PAYS are separate permissions: a
    // supervisor may send stage 4 to a vendor without also setting the vendor's rate. Which
    // one a request needs depends on the payload, so it is checked here.
    const touchesRates = (data.stages ?? []).some((s) => s.jobworkRate !== undefined || s.labourRate !== undefined);
    if (touchesRates && !may(req, 'board.rates')) {
      throw new ApiError(403, 'You do not have permission to do this. Changing a jobwork or labour rate needs "Set jobwork and labour rates".');
    }

    if (data.stageLineId != null) {
      const sl = await prisma.stageLine.findUnique({ where: { id: data.stageLineId }, include: { _count: { select: { steps: true } } } });
      if (!sl) throw new ApiError(404, 'Stage line not found.');
      if (sl._count.steps === 0) throw new ApiError(400, `Stage line ${sl.code} has no stages yet.`);
    }

    // A stage handed to a vendor needs a real jobwork supplier and a rate, or the
    // bill for it silently reads zero.
    const vendorIds = [...new Set((data.stages ?? []).map((s) => s.vendorId).filter((v): v is number => v != null))];
    const vendors = vendorIds.length ? await prisma.supplier.findMany({ where: { id: { in: vendorIds } } }) : [];
    for (const id of vendorIds) {
      const v = vendors.find((x) => x.id === id);
      if (!v) throw new ApiError(404, 'Jobwork vendor not found.');
      if (v.type === 'MATERIAL') throw new ApiError(400, `${v.name} is a material supplier, not a jobwork vendor.`);
      if (!v.isActive) throw new ApiError(400, `${v.name} is marked inactive.`);
    }
    for (const s of data.stages ?? []) {
      const current = line.stages.find((x) => x.id === s.id);
      if (!current) throw new ApiError(400, 'A stage in the payload does not belong to this order line.');
      const vendorId = s.vendorId !== undefined ? s.vendorId : current.vendorId;
      const rate = s.jobworkRate !== undefined ? s.jobworkRate : current.jobworkRate;
      if (vendorId && rate <= 0) throw new ApiError(400, `Set a jobwork rate for "${current.name}" — an outsourced stage with a zero rate would bill nothing.`);

      // Handing a stage to a vendor means workers are no longer paid for it, so any
      // piece rate that had already been earned there must not be silently rewritten.
      const labourRate = s.labourRate !== undefined ? s.labourRate : current.labourRate;
      if (vendorId && labourRate > 0) throw new ApiError(400, `"${current.name}" is going to a vendor, so clear its in-house piece rate first — the vendor is paid for it now, not the workers.`);
      if (s.labourRate !== undefined && s.labourRate !== current.labourRate) {
        const earned = await prisma.stageMoveWorker.count({ where: { move: { fromStageId: s.id } } });
        if (earned > 0 && s.labourRate <= 0) {
          throw new ApiError(409, `Workers have already been paid for ${earned} piece movement(s) at "${current.name}". Clearing its rate would wipe what they earned.`);
        }
      }
    }

    await prisma.$transaction(async (tx) => {
      if (data.stageLineId !== undefined && data.stageLineId !== line.stageLineId) {
        await tx.orderLine.update({ where: { id: lineId }, data: { stageLineId: data.stageLineId } });
        await materializeStages(tx, lineId, data.stageLineId);
        return; // the old stage rows are gone, so per-stage edits no longer apply
      }
      for (const s of data.stages ?? []) {
        const prev = line.stages.find((x) => x.id === s.id)!;
        await tx.orderLineStage.update({
          where: { id: s.id },
          data: {
            ...(s.vendorId !== undefined ? { vendorId: s.vendorId } : {}),
            ...(s.jobworkRate !== undefined ? { jobworkRate: s.jobworkRate } : {}),
            ...(s.labourRate !== undefined ? { labourRate: s.labourRate } : {}),
            ...(s.note !== undefined ? { note: s.note } : {}),
          },
        });
        // Who does a stage and what it pays are both money decisions worth a record.
        await logChanges(
          tx,
          { type: 'Order', id: line.orderId },
          { id: req.user!.sub, name: req.user!.name },
          diffFields(
            'OrderLineStage',
            s.id,
            { jobworkRate: prev.jobworkRate, labourRate: prev.labourRate, vendorId: prev.vendorId },
            { ...(s.jobworkRate !== undefined ? { jobworkRate: s.jobworkRate } : {}), ...(s.labourRate !== undefined ? { labourRate: s.labourRate } : {}), ...(s.vendorId !== undefined ? { vendorId: s.vendorId } : {}) },
            [
              { field: 'jobworkRate', label: 'jobwork rate' },
              { field: 'labourRate', label: 'in-house piece rate' },
              { field: 'vendorId', label: 'done by (vendor id)' },
            ],
            prev.name
          )
        );
      }
    });

    res.json(await loadSerializedOrder(line.orderId));
  })
);



// ---------------------------------------------------------------------------
// Scheduling and delivery tracking — an overlay on the board
// ---------------------------------------------------------------------------


/** The schedule for one order, with the live board comparison attached per line. */
router.get(
  '/orders/:id/schedule',
  can('orders.view', 'orders.schedule.view'),
  asyncHandler(async (req, res) => {
    const o = await loadSerializedOrder(Number(req.params.id));
    res.json({
      orderId: o.id,
      number: o.number,
      deliveryDate: o.deliveryDate,
      expectedDelivery: o.expectedDelivery,
      delivery: o.delivery,
      lines: o.lines.map((l: any) => ({
        orderLineId: l.id,
        product: l.product,
        qty: l.qty,
        stages: l.board.stages.map((s: any) => ({ orderLineStageId: s.id, name: s.name, sortOrder: s.sortOrder, at: s.at, cleared: s.cleared })),
        schedule: l.schedule,
      })),
    });
  })
);

const scheduleSchema = z.object({
  expectedDelivery: z.string().datetime().nullable().optional(),
  lines: z
    .array(
      z.object({
        orderLineId: z.number().int(),
        estimatedDone: z.string().datetime().nullable().optional(),
        stages: z
          .array(
            z.object({
              orderLineStageId: z.number().int(),
              estimatedStart: z.string().datetime().nullable().optional(),
              estimatedEnd: z.string().datetime().nullable().optional(),
            })
          )
          .default([]),
      })
    )
    .default([]),
});

/** Create or replace the schedule for an order's lines. */
router.put(
  '/orders/:id/schedule',
  can('orders.view', 'orders.schedule.view', 'orders.schedule.edit'),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const data = scheduleSchema.parse(req.body);
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { lines: { select: { id: true, stages: { select: { id: true } } } } } });
    if (!order) throw new ApiError(404, 'Order not found.');

    for (const l of data.lines) {
      const line = order.lines.find((x) => x.id === l.orderLineId);
      if (!line) throw new ApiError(400, `Line ${l.orderLineId} does not belong to this order.`);
      // A stage id from another line would silently schedule the wrong work.
      for (const st of l.stages) {
        if (!line.stages.some((x) => x.id === st.orderLineStageId)) {
          throw new ApiError(400, 'A stage in the schedule does not belong to that order line.');
        }
      }
    }

    await prisma.$transaction(async (tx) => {
      if (data.expectedDelivery !== undefined) {
        await tx.order.update({ where: { id: orderId }, data: { expectedDelivery: data.expectedDelivery ? new Date(data.expectedDelivery) : null } });
      }
      for (const l of data.lines) {
        const schedule = await tx.orderLineSchedule.upsert({
          where: { orderLineId: l.orderLineId },
          update: { estimatedDone: l.estimatedDone ? new Date(l.estimatedDone) : null },
          create: { orderLineId: l.orderLineId, orderId, estimatedDone: l.estimatedDone ? new Date(l.estimatedDone) : null, createdById: req.user!.sub },
        });
        // Replaced wholesale: a schedule carries no history worth patching.
        await tx.stageSchedule.deleteMany({ where: { scheduleId: schedule.id } });
        for (const st of l.stages) {
          if (!st.estimatedStart && !st.estimatedEnd) continue;
          await tx.stageSchedule.create({
            data: {
              scheduleId: schedule.id,
              orderLineStageId: st.orderLineStageId,
              estimatedStart: st.estimatedStart ? new Date(st.estimatedStart) : null,
              estimatedEnd: st.estimatedEnd ? new Date(st.estimatedEnd) : null,
            },
          });
        }
      }
    });

    res.json(await loadSerializedOrder(orderId));
  })
);

/**
 * Fill in a schedule automatically, working from today to the delivery date and using
 * each step's `defaultDays` from its stage line. A starting point to adjust, not a
 * commitment.
 */
router.post(
  '/orders/:id/auto-schedule',
  can('orders.view', 'orders.schedule.view', 'orders.schedule.edit'),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const body = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }).parse(req.body ?? {});
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { lines: { include: { stages: { orderBy: { sortOrder: 'asc' } }, stageLine: { include: { steps: { orderBy: { sortOrder: 'asc' } } } } } } },
    });
    if (!order) throw new ApiError(404, 'Order not found.');

    const to = body.to ? new Date(body.to) : order.deliveryDate ?? order.expectedDelivery;
    if (!to) throw new ApiError(400, 'This order has no delivery date, so there is nothing to schedule backwards from. Set one first, or pass a target date.');
    const from = body.from ? new Date(body.from) : new Date();

    await prisma.$transaction(async (tx) => {
      for (const line of order.lines) {
        if (line.stages.length === 0) continue;
        // Durations come from the master stage line, matched to the order's snapshot by
        // position — the snapshot is a copy of those steps, in order.
        // Matched on sortOrder, then name — never array position. The snapshot exists so
        // that editing the master line cannot rewrite a live order, and inserting a step
        // into that line would otherwise shift every duration by one.
        const masterFor = (s: { name: string; sortOrder: number }) =>
          line.stageLine?.steps.find((x) => x.sortOrder === s.sortOrder) ?? line.stageLine?.steps.find((x) => x.name === s.name) ?? null;
        const plan = autoSchedule(
          line.stages.map((s) => ({ orderLineStageId: s.id, name: s.name, sortOrder: s.sortOrder, defaultDays: masterFor(s)?.defaultDays ?? null })),
          from,
          to
        );
        const schedule = await tx.orderLineSchedule.upsert({
          where: { orderLineId: line.id },
          update: { estimatedDone: plan.length ? plan[plan.length - 1].estimatedEnd : null },
          create: { orderLineId: line.id, orderId, estimatedDone: plan.length ? plan[plan.length - 1].estimatedEnd : null, createdById: req.user!.sub },
        });
        await tx.stageSchedule.deleteMany({ where: { scheduleId: schedule.id } });
        for (const st of plan) {
          await tx.stageSchedule.create({ data: { scheduleId: schedule.id, orderLineStageId: st.orderLineStageId, estimatedStart: st.estimatedStart, estimatedEnd: st.estimatedEnd } });
        }
      }
      if (!order.expectedDelivery) await tx.order.update({ where: { id: orderId }, data: { expectedDelivery: to } });
    });

    res.json(await loadSerializedOrder(orderId));
  })
);

/**
 * The order as a printable confirmation / job card. Same letterhead and the same money
 * engine as the proforma, so the two documents always agree.
 */
router.get(
  '/orders/:id/pdf',
  can('orders.view', 'orders.documents'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const [o, co] = await Promise.all([loadSerializedOrder(id), ensureCompany()]);
    const pdf = await orderPdf({
      number: o.number,
      date: o.orderDate,
      deliveryDate: o.deliveryDate,
      currencyCode: o.currency?.code ?? 'INR',
      exchangeRate: o.exchangeRate,
      status: o.status,
      buyer: o.buyer as never,
      company: co,
      incoterms: o.incoterms,
      notes: o.notes,
      proformaNumber: o.proforma?.number ?? null,
      taxMarket: o.taxMarket,
      taxBuyerState: o.taxBuyerState,
      taxCompanyState: o.taxCompanyState,
      charges: o.charges,
      lines: o.lines.map((l: any) => ({
        productCode: l.product.factoryCode,
        description: l.product.name,
        qty: l.qty,
        unitPrice: l.unitPrice,
        discountPct: l.discountPct,
        discountAmt: l.discountAmt,
        gstRatePct: l.gstRatePct,
        hsnCode: l.hsnCode,
        stageLine: l.stageLine ? `${l.stageLine.code} - ${l.stageLine.name}` : null,
      })),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${o.number}.pdf"`);
    res.send(pdf);
  })
);

// ---------------------------------------------------------------------------
// Order attachments — PO copies, shipping and customs paperwork
// ---------------------------------------------------------------------------

const uploadAttachments = attachmentUploader('order-');

router.get(
  '/orders/:id/attachments',
  can('orders.view', 'orders.attachments.view'),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } });
    if (!order) throw new ApiError(404, 'Order not found.');
    res.json(await prisma.orderAttachment.findMany({ where: { orderId }, orderBy: [{ createdAt: 'desc' }] }));
  })
);

/**
 * Attach one or more files. Validated by extension AND magic bytes — a declared
 * mimetype proves nothing — and anything whose contents contradict its name is unlinked
 * before a row can point at it.
 */
router.post(
  '/orders/:id/attachments',
  can('orders.view', 'orders.attachments.view', 'orders.attachments.manage'),
  uploadAttachments.array('files', 10),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];

    // multer has ALREADY written every byte to disk by the time this handler runs, so any
    // refusal from here on must unlink them — otherwise `POST /orders/99999/attachments`
    // with ten 25 MB files leaves 250 MB orphaned, repeatably.
    const discard = async () => {
      for (const f of files) await fs.promises.unlink(f.path).catch(() => undefined);
    };
    const refuse = async (status: number, message: string) => {
      await discard();
      throw new ApiError(status, message);
    };

    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, number: true, deletedAt: true } });
    if (!order) await refuse(404, 'Order not found.');
    if (order!.deletedAt) await refuse(409, `${order!.number} is in the trash. Restore it before attaching files.`);

    const parsed = z
      .object({ label: z.enum(ATTACHMENT_LABELS).optional(), note: z.string().nullable().optional() })
      .safeParse({ label: req.body?.label || undefined, note: req.body?.note ?? null });
    if (!parsed.success) await refuse(400, 'That attachment label is not one we recognise.');
    const body = parsed.data!;

    // Validated last, because it unlinks the files it rejects itself.
    const kept = keepRealDocuments(files);
    const dropped = files.length - kept.length;

    await prisma.orderAttachment.createMany({
      data: kept.map((f) => ({
        orderId,
        filename: f.filename,
        originalName: f.originalname,
        url: `/uploads/${f.filename}`,
        label: body.label ?? 'OTHER',
        note: body.note ?? null,
        sizeBytes: f.size,
        uploadedById: req.user!.sub,
      })),
    });

    // #25: say what was dropped rather than silently returning only the survivors.
    res.status(201).json({
      attachments: await prisma.orderAttachment.findMany({ where: { orderId }, orderBy: [{ createdAt: 'desc' }] }),
      added: kept.length,
      skipped: dropped,
    });
  })
);

/**
 * Stream one attachment back.
 *
 * Scoped to the order in the path, so one order's id cannot fetch another's file, and
 * routed through the API rather than `/uploads` so the download carries the original
 * filename and the bearer token the client already sends.
 */
router.get(
  '/orders/:id/attachments/:attachmentId',
  can('orders.view', 'orders.attachments.view'),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const id = Number(req.params.attachmentId);
    const att = await prisma.orderAttachment.findFirst({ where: { id, orderId } });
    if (!att) throw new ApiError(404, 'Attachment not found on that order.');
    const full = path.join(uploadDir, att.filename);
    if (!fs.existsSync(full)) throw new ApiError(410, `${att.originalName ?? att.filename} is no longer on disk.`);
    // Never inline: these are arbitrary documents, so they download rather than render.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${(att.originalName ?? att.filename).replace(/[^\w.\- ]/g, '_')}"`);
    fs.createReadStream(full).pipe(res);
  })
);

/** Rename or re-label an attachment without re-uploading it. */
router.patch(
  '/orders/:id/attachments/:attachmentId',
  can('orders.view', 'orders.attachments.view', 'orders.attachments.manage'),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const id = Number(req.params.attachmentId);
    // Scoped to the order in the path, so one order's id cannot touch another's file.
    const existing = await prisma.orderAttachment.findFirst({ where: { id, orderId } });
    if (!existing) throw new ApiError(404, 'Attachment not found on that order.');
    const data = z.object({ label: z.enum(ATTACHMENT_LABELS).optional(), note: z.string().nullable().optional() }).parse(req.body ?? {});
    res.json(await prisma.orderAttachment.update({ where: { id }, data }));
  })
);

/**
 * Remove an attachment. A hard delete: a file is not operational data with a history,
 * and leaving orphaned bytes in `uploads` would be worse than losing the row.
 */
router.delete(
  '/orders/:id/attachments/:attachmentId',
  can('orders.view', 'orders.attachments.view', 'orders.attachments.manage'),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const id = Number(req.params.attachmentId);
    const existing = await prisma.orderAttachment.findFirst({ where: { id, orderId } });
    if (!existing) throw new ApiError(404, 'Attachment not found on that order.');
    await prisma.orderAttachment.delete({ where: { id } });
    fs.promises.unlink(path.join(uploadDir, existing.filename)).catch(() => undefined);
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Stage movements (the board) — each hand-over carries a comment and photos
// ---------------------------------------------------------------------------

const moveSchema = z.object({
  orderLineId: z.number().int(),
  kind: z.enum(MOVE_KINDS),
  fromStageId: z.number().int().nullable().optional(),
  toStageId: z.number().int().nullable().optional(),
  qty: z.number().int().positive(),
  note: z.string().nullable().optional(),
  /**
   * Who did the work, with a piece count each. Optional — the board never needed it.
   * When given, the counts must add up to `qty`, so in-house labour stays exactly
   * attributable and still reconciles with the stage's cleared figure.
   */
  workers: z.array(z.object({ workerId: z.number().int(), pieces: z.number().int().positive() })).optional(),
});

const movesBodySchema = z.object({
  moves: z.array(moveSchema).min(1),
  date: z.string().datetime().optional(),
  /** Hand-over comment applied to every hop this submission records. */
  comment: z.string().nullable().optional(),
});

/**
 * Record one or more piece movements.
 *
 * A forward clearance that spans several stages is expanded into one hop per stage
 * (see `expandHops`), so clearing 1 -> 4 in a single action still leaves every
 * stage's cleared count — and its jobwork — exact. Several lines may be cleared in
 * one submission; each is validated against a running board so two moves on the
 * same line are checked cumulatively.
 */
router.post(
  '/orders/:id/moves',
  can('orders.view', 'board.view', 'board.move'),
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const body = movesBodySchema.parse(req.body);
    const date = body.date ? new Date(body.date) : new Date();
    const comment = body.comment?.trim() || null;

    // Two things in a submission need more than `board.move`, and which they are depends on
    // the payload rather than the route — so they are checked here rather than as middleware.
    //
    // A REJECT is a quality judgement that also earns money a second time when the work is
    // redone, and naming workers is what creates piece-rate wages. Both are held separately
    // from moving pieces forward, so a shop-floor login can record progress without being
    // able to fail a batch or to decide who gets paid for it.
    if (body.moves.some((m) => m.kind === 'REJECT') && !may(req, 'board.reject')) {
      throw new ApiError(403, 'You do not have permission to do this. Sending pieces back for rework needs "Send pieces back for rework".');
    }
    if (body.moves.some((m) => m.workers?.length) && !may(req, 'board.workers')) {
      throw new ApiError(403, 'You do not have permission to do this. Naming the workers who did the work needs "Name who did the work".');
    }

    // The board is read, validated and written inside ONE transaction, and the order is
    // LOCKED before any of it. Doing the check outside left a window where two
    // simultaneous clearances of the same pieces both passed validation and both wrote,
    // driving a stage negative — and on Postgres the transaction alone does not close it,
    // because two READ COMMITTED reads of the ledger see the same board. See lib/rowLock.
    const result = await prisma.$transaction(async (tx) => {
      if (!(await lockOrder(tx, orderId))) throw new ApiError(404, 'Order not found.');

      const orderRow = await tx.order.findUnique({ where: { id: orderId }, select: { status: true, number: true, deletedAt: true } });
      if (!orderRow) throw new ApiError(404, 'Order not found.');
      if (orderRow.status === 'Cancelled') throw new ApiError(409, 'This order is cancelled — reopen it before moving pieces.');
      // Pieces cannot move on an order that has left every list and every total. `lockOrder`
      // is the primary gate for this now and refuses a trashed order before we get here;
      // this stays as the in-transaction re-check, so removing the lock cannot reopen it.
      if (orderRow.deletedAt) throw new ApiError(409, `${orderRow.number} is in the trash. Restore it before moving pieces.`);
      const lines = await tx.orderLine.findMany({
        where: { orderId },
        include: { stages: { include: { vendor: { select: { id: true, name: true } } }, orderBy: { sortOrder: 'asc' } }, moves: true, product: { select: { factoryCode: true } } },
      });
      const lineById = new Map(lines.map((l) => [l.id, l]));

      // Anyone named on a movement must actually be on the books.
      const namedIds = [...new Set(body.moves.flatMap((m) => m.workers?.map((w) => w.workerId) ?? []))];
      const namedWorkers = namedIds.length ? await tx.worker.findMany({ where: { id: { in: namedIds } }, select: { id: true, name: true, isActive: true } }) : [];

      const simulated = new Map<number, MoveRow[]>();
      const planned: { orderLineId: number; kind: string; fromStageId: number | null; toStageId: number | null; qty: number; note: string | null; workers?: { workerId: number; pieces: number }[] }[] = [];

      for (const m of body.moves) {
        const line = lineById.get(m.orderLineId);
        if (!line) throw new ApiError(400, 'A movement refers to a line that is not on this order.');
        if (line.stages.length === 0) throw new ApiError(400, `${line.product.factoryCode} has no stage line yet — assign one before moving pieces.`);

        const extra = simulated.get(m.orderLineId) ?? [];
        const boardBefore = buildBoard(line.qty, line.stages as any, [...(line.moves as any as MoveRow[]), ...extra]);
        const err = validateMove(boardBefore, { kind: m.kind, fromStageId: m.fromStageId ?? null, toStageId: m.toStageId ?? null, qty: m.qty });
        if (err) throw new ApiError(400, `${line.product.factoryCode} — ${err}`);

        // Break a multi-stage clearance into single hops, then check each one in turn.
        const hops = expandHops(boardBefore, { kind: m.kind, fromStageId: m.fromStageId ?? null, toStageId: m.toStageId ?? null, qty: m.qty });

        const workers = m.workers?.length ? m.workers : undefined;
        if (workers) {
          // Only a clearance is work done. A release, a rejection or a return moves
          // pieces without anyone having finished anything.
          if (m.kind !== 'ADVANCE' && m.kind !== 'COMPLETE') throw new ApiError(400, 'Workers can only be named on a clearance — advancing pieces forward or finishing them.');
          // Each hop is a different stage's work, so a clearance spanning several
          // stages cannot say who did which. Clear them one stage at a time.
          if (hops.length > 1) throw new ApiError(400, `That clearance crosses ${hops.length} stages, so it cannot say who did which. Clear one stage at a time to record the workers.`);
          const stage = line.stages.find((s) => s.id === (m.fromStageId ?? null));
          if (!stage) throw new ApiError(400, 'Pick the stage the work was done at before naming who did it.');
          for (const w of workers) {
            const found = namedWorkers.find((x) => x.id === w.workerId);
            if (!found) throw new ApiError(404, `Worker #${w.workerId} not found.`);
            if (!found.isActive) throw new ApiError(400, `${found.name} is no longer active — reactivate them before recording their work.`);
          }
          const workerErr = validateMoveWorkers(m.qty, workers, stage);
          if (workerErr) throw new ApiError(400, `${line.product.factoryCode} — ${workerErr}`);
        }

        for (const hop of hops) {
          const board = buildBoard(line.qty, line.stages as any, [...(line.moves as any as MoveRow[]), ...extra]);
          const hopErr = validateMove(board, hop);
          if (hopErr) throw new ApiError(400, `${line.product.factoryCode} — ${hopErr}`);
          planned.push({ orderLineId: m.orderLineId, kind: hop.kind, fromStageId: hop.fromStageId, toStageId: hop.toStageId, qty: hop.qty, note: m.note?.trim() || comment, workers });
          extra.push({ id: -1, kind: hop.kind, fromStageId: hop.fromStageId, toStageId: hop.toStageId, qty: hop.qty });
        }
        simulated.set(m.orderLineId, extra);
      }

      const ids: number[] = [];
      for (const p of planned) {
        const created = await tx.stageMove.create({
          data: {
            orderLineId: p.orderLineId,
            kind: p.kind,
            fromStageId: p.fromStageId,
            toStageId: p.toStageId,
            qty: p.qty,
            date,
            note: p.note,
            createdById: req.user!.sub,
            ...(p.workers ? { workers: { create: p.workers.map((w) => ({ workerId: w.workerId, pieces: w.pieces })) } } : {}),
          },
        });
        ids.push(created.id);
      }
      const newStatus = await syncOrderStatus(tx, orderId);
      return { ids, newStatus };
    });

    res.status(201).json({
      ...(await loadSerializedOrder(orderId)),
      createdMoves: result.ids.length,
      moveIds: result.ids,
      /** Attach hand-over photos here — the hop the pieces actually landed on. */
      photoMoveId: result.ids[result.ids.length - 1] ?? null,
      statusChangedTo: result.newStatus,
    });
  })
);

// --- hand-over photos ------------------------------------------------------

router.post(
  '/moves/:id/photos',
  can('orders.view', 'board.view', 'board.photos'),
  uploadPhotos.array('photos', 10),
  asyncHandler(async (req, res) => {
    const moveId = Number(req.params.id);
    const move = await prisma.stageMove.findUnique({ where: { id: moveId }, include: { photos: true, orderLine: { select: { orderId: true } } } });
    if (!move) throw new ApiError(404, 'Movement not found.');
    const files = keepRealImages((req.files as Express.Multer.File[]) ?? []);

    let order = move.photos.length;
    for (const file of files) {
      await prisma.stageMovePhoto.create({
        data: { moveId, filename: file.filename, originalName: file.originalname, url: `/uploads/${file.filename}`, sortOrder: order++ },
      });
    }
    res.status(201).json(await loadSerializedOrder(move.orderLine.orderId));
  })
);

router.delete(
  '/moves/:moveId/photos/:photoId',
  can('orders.view', 'board.view', 'board.photos'),
  asyncHandler(async (req, res) => {
    // Scoped to the move in the path, so one movement's id cannot be used to delete
    // another's photo.
    const photo = await prisma.stageMovePhoto.findFirst({ where: { id: Number(req.params.photoId), moveId: Number(req.params.moveId) } });
    if (!photo) throw new ApiError(404, 'Photo not found on that movement.');
    await prisma.stageMovePhoto.delete({ where: { id: photo.id } });
    fs.promises.unlink(path.join(uploadDir, photo.filename)).catch(() => undefined);
    res.status(204).end();
  })
);

/** Edit the hand-over comment after the fact. */
router.patch(
  '/moves/:id',
  can('orders.view', 'board.view', 'board.move'),
  asyncHandler(async (req, res) => {
    const { note } = z.object({ note: z.string().nullable() }).parse(req.body);
    const move = await prisma.stageMove.findUnique({ where: { id: Number(req.params.id) }, include: { orderLine: { select: { orderId: true } } } });
    if (!move) throw new ApiError(404, 'Movement not found.');
    await prisma.stageMove.update({ where: { id: move.id }, data: { note: note?.trim() || null } });
    res.json(await loadSerializedOrder(move.orderLine.orderId));
  })
);

/** Undo the most recent movement on a line — anything older must be undone first. */
router.delete(
  '/moves/:id',
  can('orders.view', 'board.view', 'board.undo'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const move = await prisma.stageMove.findUnique({ where: { id }, include: { orderLine: { select: { id: true, orderId: true } } } });
    if (!move) throw new ApiError(404, 'Movement not found.');

    const photos = await prisma.stageMovePhoto.findMany({ where: { moveId: id } });
    // Re-checked inside the transaction, behind the order's lock, so two simultaneous
    // undos cannot both win and so an undo cannot race a clearance: without the lock,
    // reading "the newest movement is #5" and deleting it can interleave with #6 being
    // appended, leaving a line whose history has a hole in the middle of it.
    await prisma.$transaction(async (tx) => {
      if (!(await lockOrder(tx, move.orderLine.orderId))) throw new ApiError(404, 'Order not found.');
      const still = await tx.stageMove.findUnique({ where: { id }, select: { id: true } });
      if (!still) throw new ApiError(409, 'That movement has already been undone.');
      const latest = await tx.stageMove.findFirst({ where: { orderLineId: move.orderLineId }, orderBy: { id: 'desc' } });
      if (latest && latest.id !== id) throw new ApiError(409, 'Only the most recent movement on a line can be undone. Undo the later ones first.');
      await tx.stageMove.delete({ where: { id } }); // photos cascade with it
      await syncOrderStatus(tx, move.orderLine.orderId);
    });
    for (const p of photos) fs.promises.unlink(path.join(uploadDir, p.filename)).catch(() => undefined);
    res.json(await loadSerializedOrder(move.orderLine.orderId));
  })
);

// ---------------------------------------------------------------------------
// Proformas
// ---------------------------------------------------------------------------

const proformaInclude = {
  buyer: true,
  currency: true,
  charges: { orderBy: { sortOrder: 'asc' as const } },
  lines: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      product: {
        select: {
          id: true,
          factoryCode: true,
          name: true,
          size: { select: { value: true } },
          colour: { select: { value: true } },
          material: { select: { value: true } },
          finish: { select: { value: true } },
          prodLengthIn: true,
          prodWidthIn: true,
          prodHeightIn: true,
          images: { orderBy: [{ isPrimary: 'desc' as const }, { sortOrder: 'asc' as const }], select: { id: true, url: true, filename: true, isPrimary: true, caption: true } },
        },
      },
      image: { select: { id: true, url: true, filename: true } },
    },
  },
  order: { select: { id: true, number: true } },
};

type ProformaLoaded = Awaited<ReturnType<typeof loadProforma>>;

async function loadProforma(id: number, allowTrashed = false) {
  const p = await prisma.proforma.findUnique({ where: { id }, include: proformaInclude });
  if (!p) throw new ApiError(404, 'Proforma not found.');
  // The mutating routes each need to say something specific about the trash, so they pass
  // `allowTrashed` and check for themselves; a plain read refuses here.
  if (p.deletedAt && !allowTrashed) throw new ApiError(410, `${p.number} is in the trash. Restore it to open it.`);
  return p;
}

/** The photo a PI line should print: the explicit pick, else the product primary. */
function lineImage(l: any): { id: number; url: string; filename: string } | null {
  if (l.image) return l.image;
  const primary = l.product?.images?.[0];
  return primary ? { id: primary.id, url: primary.url, filename: primary.filename } : null;
}

function specsOf(p: any): string | null {
  if (!p) return null;
  const dims = [p.prodLengthIn, p.prodWidthIn, p.prodHeightIn].every((v: any) => v != null) ? `${p.prodLengthIn}x${p.prodWidthIn}x${p.prodHeightIn} in` : null;
  const bits = [dims, p.size?.value, p.colour?.value, p.material?.value, p.finish?.value].filter(Boolean);
  return bits.length ? bits.join(' · ') : null;
}

function serializeProforma(p: ProformaLoaded, ourState: string | null = null) {
  const lines = p.lines.map((l) => ({ ...l, image: lineImage(l), specs: specsOf(l.product), amount: lineNet(l), grossAmount: lineGross(l) }));
  // One call to the pricing engine, exactly as an order does it, so a quote and the
  // order it becomes can never be worth different amounts.
  const totals = documentTotalsOf(p as never, ourState);
  return {
    ...p,
    lines,
    total: totals.grandTotal,
    /** Subtotal, charges and the CGST/SGST/IGST breakdown behind `total`. */
    totals,
    canEdit: !p.order && p.status !== 'Accepted',
  };
}

/**
 * Load and serialize in one go. Every route goes through this so none of them can
 * forget the company state the tax split depends on.
 */
async function serializedProforma(id: number) {
  const [p, ourState] = await Promise.all([loadProforma(id), companyState()]);
  return serializeProforma(p, ourState);
}

router.get(
  '/proformas',
  can('proformas.view'),
  asyncHandler(async (req, res) => {
    const status = req.query.status as string | undefined;
    const [list, ourState] = await Promise.all([
      prisma.proforma.findMany({ where: { ...notDeleted, ...(status ? { status } : {}) }, include: proformaInclude, orderBy: [{ date: 'desc' }, { id: 'desc' }] }),
      companyState(),
    ]);
    res.json(list.map((p) => serializeProforma(p, ourState)));
  })
);

router.get(
  '/proformas/trash',
  can('proformas.view', 'proformas.restore'),
  asyncHandler(async (_req, res) => {
    res.json(
      await prisma.proforma.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, number: true, status: true, date: true, deletedAt: true, buyer: { select: { name: true } } },
        orderBy: { deletedAt: 'desc' },
      })
    );
  })
);

router.get(
  '/proformas/:id',
  can('proformas.view'),
  asyncHandler(async (req, res) => {
    res.json(await serializedProforma(Number(req.params.id)));
  })
);

/**
 * A domestic document must be in rupees, and an export must not be.
 *
 * Non-FOB is a rupee figure; `/ops/price` divides it by the currency rate, so a domestic
 * quote left in euro would be priced at a ninetieth of its value AND have its GST
 * denominated in euro. FIFO also partitions receipts by currency, so a rupee NEFT could
 * never settle it.
 */
function assertCurrencyForMarket(domestic: boolean, currency: { code: string; isBase: boolean } | null) {
  const code = currency?.code ?? 'INR';
  if (domestic && code !== 'INR') {
    throw new ApiError(400, `A domestic sale is priced in rupees — ${code} cannot be used. Switch the currency to INR.`);
  }
  if (!domestic && code === 'INR') {
    throw new ApiError(400, 'An export is priced in the buyer\'s currency. Pick the currency this buyer is invoiced in.');
  }
}

const proformaSchema = z.object({
  buyerId: z.number().int(),
  currencyId: z.number().int().nullable().optional(),
  date: z.string().datetime().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  paymentTerms: z.string().nullable().optional(),
  deliveryTerms: z.string().nullable().optional(),
  incoterms: z.string().nullable().optional(),
  bankDetails: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  showImages: z.boolean().optional(),
  lines: z
    .array(
      z.object({
        productId: z.number().int().nullable().optional(),
        imageId: z.number().int().nullable().optional(),
        description: z.string().min(1),
        qty: z.number().int().positive(),
        unitPrice: z.number().min(0),
        ...lineTaxFields,
      })
    )
    .default([]),
  charges: z.array(chargeSchema).default([]),
});

/** Charge rows for a create/update. Magnitudes are stored positive; `kind` holds sign. */
type ChargeInput = z.output<typeof chargeSchema>;
function chargeRows(charges: ChargeInput[], domestic = true) {
  return charges.map((c, i) => ({
    name: c.name.trim(),
    kind: c.kind,
    amount: Math.abs(c.amount),
    pct: Math.abs(c.pct),
    // Zero on an export, and zero on an untaxable row, so a stored rate can never
    // start taxing something later.
    gstRatePct: domestic && c.isTaxable ? c.gstRatePct : 0,
    isTaxable: c.isTaxable,
    note: c.note ?? null,
    sortOrder: i,
  }));
}

/**
 * Line rows for a create/update, tax fields included. An export stores zero rates for
 * the same reason `orderLineTax` does.
 */
function proformaLineRows(lines: z.infer<typeof proformaSchema>['lines'], domestic: boolean) {
  return lines.map((l, i) => ({
    productId: l.productId ?? null,
    imageId: l.imageId ?? null,
    description: l.description,
    qty: l.qty,
    unitPrice: l.unitPrice,
    discountPct: l.discountPct,
    discountAmt: l.discountAmt,
    gstRatePct: domestic ? l.gstRatePct : 0,
    hsnCode: domestic ? l.hsnCode?.trim() || null : null,
    sortOrder: i,
  }));
}

function proformaData(d: z.infer<typeof proformaSchema>, currencyRate: number | null) {
  return {
    buyerId: d.buyerId,
    currencyId: d.currencyId ?? null,
    date: d.date ? new Date(d.date) : new Date(),
    validUntil: d.validUntil ? new Date(d.validUntil) : null,
    paymentTerms: d.paymentTerms ?? null,
    deliveryTerms: d.deliveryTerms ?? null,
    incoterms: d.incoterms ?? null,
    bankDetails: d.bankDetails ?? null,
    notes: d.notes ?? null,
    showImages: d.showImages ?? true,
    exchangeRate: currencyRate,
  };
}

router.post(
  '/proformas',
  can('proformas.view', 'proformas.create'),
  asyncHandler(async (req, res) => {
    const data = proformaSchema.parse(req.body);
    if (data.lines.length === 0) throw new ApiError(400, 'A proforma needs at least one line.');
    // A domestic buyer gets its own series, so export and domestic paperwork are
    // numbered independently.
    const buyer = await prisma.buyer.findUnique({ where: { id: data.buyerId }, select: { market: true, state: true } });
    if (!buyer) throw new ApiError(404, 'Buyer not found.');
    const domestic = isDomestic(buyer.market);
    await assertLive('product', data.lines.map((l) => l.productId).filter((v): v is number => v != null), 'a proforma');
    const number = await nextDocNumber(docKeys(buyer.market).proforma);
    const createState = await companyState();
    const currency = data.currencyId ? await prisma.currency.findUnique({ where: { id: data.currencyId } }) : null;
    assertCurrencyForMarket(domestic, currency);
    const p = await prisma.proforma.create({
      data: {
        number,
        ...proformaData(data, currency?.rateToBase ?? null),
        status: 'Draft',
        createdById: req.user!.sub,
        // Frozen at creation, like the exchange rate.
        taxMarket: buyer.market,
        taxBuyerState: buyer.state,
        taxCompanyState: createState,
        lines: { create: proformaLineRows(data.lines, domestic) },
        charges: { create: chargeRows(data.charges, domestic) },
      },
    });
    res.status(201).json(await serializedProforma(p.id));
  })
);

router.put(
  '/proformas/:id',
  can('proformas.view', 'proformas.edit'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const data = proformaSchema.parse(req.body);
    if (data.lines.length === 0) throw new ApiError(400, 'A proforma needs at least one line.');
    const current = await loadProforma(id, true);
    if (current.deletedAt) throw new ApiError(409, `${current.number} is in the trash. Restore it before editing it.`);
    if (current.order) throw new ApiError(409, `${current.number} became order ${current.order.number} — it can no longer be edited.`);
    if (current.status === 'Accepted') throw new ApiError(409, 'An accepted proforma cannot be edited.');

    const putBuyer = await prisma.buyer.findUnique({ where: { id: data.buyerId }, select: { market: true, state: true } });
    if (!putBuyer) throw new ApiError(404, 'Buyer not found.');
    const domestic = isDomestic(putBuyer.market);
    await assertLive('product', data.lines.map((l) => l.productId).filter((v): v is number => v != null), 'a proforma');
    const currency = data.currencyId ? await prisma.currency.findUnique({ where: { id: data.currencyId } }) : null;
    assertCurrencyForMarket(domestic, currency);
    // Read BEFORE the transaction: `companyState()` upserts the singleton, so calling it
    // inside `$transaction` runs a write on a second connection while this one holds its
    // locks — which is how it deadlocked and timed out after 5 s.
    const pfState = await companyState();
    await prisma.$transaction(async (tx) => {
      await tx.proforma.update({
        where: { id },
        data: {
          ...proformaData(data, currency?.rateToBase ?? null),
          // Re-snapshotted for the same reason as an order: editing the buyer must not
          // leave a stale tax basis behind.
          taxMarket: putBuyer.market,
          taxBuyerState: putBuyer.state,
          taxCompanyState: pfState,
        },
      });
      // Charges are replaced wholesale; nothing downstream references one by id.
      await tx.proformaCharge.deleteMany({ where: { proformaId: id } });
      for (const c of chargeRows(data.charges, domestic)) await tx.proformaCharge.create({ data: { proformaId: id, ...c } });
      await tx.proformaLine.deleteMany({ where: { proformaId: id } });
      const rows = proformaLineRows(data.lines, domestic);
      for (let i = 0; i < data.lines.length; i++) {
        const l = data.lines[i];
        await tx.proformaLine.create({ data: { proformaId: id, ...rows[i] } });
        // Lines are replaced wholesale, so match the old ones by description.
        const prev = current.lines.find((x) => x.description === l.description);
        if (prev) {
          await logChanges(
            tx,
            { type: 'Proforma', id },
            { id: req.user!.sub, name: req.user!.name },
            diffFields(
              'ProformaLine',
              prev.id,
              prev,
              { unitPrice: l.unitPrice, qty: l.qty, discountPct: l.discountPct, discountAmt: l.discountAmt, gstRatePct: l.gstRatePct },
              [
                { field: 'unitPrice', label: 'unit price' },
                { field: 'qty', label: 'quantity' },
                { field: 'discountPct', label: 'discount %' },
                { field: 'discountAmt', label: 'discount amount' },
                { field: 'gstRatePct', label: 'GST rate' },
              ],
              l.description
            )
          );
        }
      }
    });
    res.json(await serializedProforma(id));
  })
);

/** Mark as sent. Accepting is a separate, order-creating step. */
router.post(
  '/proformas/:id/send',
  can('proformas.view', 'proformas.send'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const p = await loadProforma(id, true);
    if (p.deletedAt) throw new ApiError(409, `${p.number} is in the trash. Restore it first.`);
    if (p.status === 'Accepted') throw new ApiError(409, 'This proforma is already accepted.');
    await prisma.proforma.update({ where: { id }, data: { status: 'Sent', sentAt: p.sentAt ?? new Date(), decidedAt: null, rejectReason: null } });
    res.json(await serializedProforma(id));
  })
);

/** Back to draft, e.g. to fix a price before re-sending. */
router.post(
  '/proformas/:id/reopen',
  can('proformas.view', 'proformas.reopen'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const p = await loadProforma(id, true);
    if (p.deletedAt) throw new ApiError(409, `${p.number} is in the trash. Restore it first.`);
    if (p.order) throw new ApiError(409, `${p.number} already became order ${p.order.number}.`);
    await prisma.proforma.update({ where: { id }, data: { status: 'Draft', decidedAt: null, rejectReason: null } });
    res.json(await serializedProforma(id));
  })
);

/** Rejected — record it and stop. Nothing downstream happens. */
router.post(
  '/proformas/:id/reject',
  can('proformas.view', 'proformas.reject'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const reason = z.object({ reason: z.string().nullable().optional() }).parse(req.body ?? {}).reason ?? null;
    const p = await loadProforma(id, true);
    if (p.deletedAt) throw new ApiError(409, `${p.number} is in the trash. Restore it first.`);
    if (p.order) throw new ApiError(409, `${p.number} already became order ${p.order.number} — it cannot be rejected.`);
    await prisma.proforma.update({ where: { id }, data: { status: 'Rejected', decidedAt: new Date(), rejectReason: reason } });
    res.json(await serializedProforma(id));
  })
);

/**
 * Accepted — this is the moment an order is born. The client must confirm first;
 * the server enforces the one-order-per-proforma rule.
 */
router.post(
  '/proformas/:id/accept',
  can('proformas.view', 'proformas.accept'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = z.object({ deliveryDate: z.string().datetime().nullable().optional() }).parse(req.body ?? {});
    const p = await prisma.proforma.findUnique({
      where: { id },
      include: { lines: true, charges: true, order: true, buyer: { select: { market: true, state: true } } },
    });
    if (!p) throw new ApiError(404, 'Proforma not found.');
    // Accepting a trashed quote would mint a real order number pointing at an invisible
    // PI, and the PI could then never be deleted ("became order …") — a dead end.
    if (p.deletedAt) throw new ApiError(409, `${p.number} is in the trash. Restore it before accepting it.`);
    if (p.order) throw new ApiError(409, `Already accepted — order ${p.order.number} exists.`);

    const productLines = p.lines.filter((l) => l.productId != null);
    if (productLines.length === 0) throw new ApiError(400, 'None of the proforma lines is linked to a product, so no order can be created. Link products first.');

    // A charge belongs to the whole document, so it can only ride onto the order if
    // every line came across. Dropping an unlinked line would otherwise leave freight
    // being charged on goods that are no longer there.
    if (p.charges.length > 0 && productLines.length !== p.lines.length) {
      throw new ApiError(
        400,
        `${p.number} carries document charges but ${p.lines.length - productLines.length} of its line(s) are not linked to a product. Link every line first, or the order would be worth a different amount than was quoted.`
      );
    }

    const number = await nextDocNumber(docKeys(p.taxMarket ?? p.buyer.market).order);
    // Read outside the transaction below: companyState() upserts the singleton, and a
    // nested write would deadlock until the 5 s timeout.
    const acceptState = p.taxCompanyState ?? (await companyState());
    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          number,
          buyerId: p.buyerId,
          currencyId: p.currencyId,
          status: 'Confirmed',
          exchangeRate: p.exchangeRate,
          incoterms: p.incoterms,
          deliveryDate: body.deliveryDate ? new Date(body.deliveryDate) : null,
          notes: p.notes,
          proformaId: p.id,
          createdById: req.user!.sub,
          // Inherited from the quote, not re-derived: the order must be taxed exactly as
          // the buyer was quoted, even if their address changed in between.
          taxMarket: p.taxMarket ?? p.buyer.market,
          taxBuyerState: p.taxBuyerState ?? p.buyer.state,
          taxCompanyState: acceptState,
          // Copied, not referenced: the order must stay worth what was quoted even if
          // the proforma is later revised.
          charges: {
            create: p.charges.map((c, i) => ({
              name: c.name,
              kind: c.kind,
              amount: c.amount,
              pct: c.pct,
              gstRatePct: c.gstRatePct,
              isTaxable: c.isTaxable,
              note: c.note,
              sortOrder: i,
            })),
          },
        },
      });
      for (let i = 0; i < productLines.length; i++) {
        const l = productLines[i];
        const stageLineId = await resolveStageLineId(tx, l.productId!);
        const line = await tx.orderLine.create({
          data: {
            orderId: created.id,
            productId: l.productId!,
            qty: l.qty,
            unitPrice: l.unitPrice,
            // The quoted discount and tax rate come across too, or the order would be
            // worth more than the buyer agreed to.
            discountPct: l.discountPct,
            discountAmt: l.discountAmt,
            gstRatePct: l.gstRatePct,
            hsnCode: l.hsnCode,
            sortOrder: i,
            stageLineId,
          },
        });
        await materializeStages(tx, line.id, stageLineId);
      }
      await tx.proforma.update({ where: { id }, data: { status: 'Accepted', decidedAt: new Date(), rejectReason: null } });
      return created;
    });

    const skipped = p.lines.length - productLines.length;
    res.status(201).json({ order: await loadSerializedOrder(order.id), skippedLines: skipped });
  })
);


router.post(
  '/proformas/:id/restore',
  can('proformas.view', 'proformas.restore'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.proforma.findUnique({ where: { id }, select: { deletedAt: true, number: true } });
    if (!existing) throw new ApiError(404, 'Proforma not found.');
    if (!existing.deletedAt) throw new ApiError(409, `${existing.number} is not in the trash.`);
    await restore('proforma', id);
    res.json({ restored: true, number: existing.number });
  })
);

router.delete(
  '/proformas/:id/permanent',
  can('proformas.view', 'proformas.restore', 'proformas.purge'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const p = await prisma.proforma.findUnique({ where: { id }, include: { order: { select: { number: true } } } });
    if (!p) throw new ApiError(404, 'Proforma not found.');
    if (!p.deletedAt) throw new ApiError(409, `${p.number} is still live. Delete it first, then destroy it from the trash.`);
    if (p.order) throw new ApiError(409, `${p.number} became order ${p.order.number}, which still points at it. Destroy the order first.`);
    await prisma.proforma.delete({ where: { id } });
    res.status(204).end();
  })
);

/**
 * Move a proforma to the trash. Refused once it has become an order, because the order
 * references it — the order would be left pointing at something invisible.
 */
router.delete(
  '/proformas/:id',
  can('proformas.view', 'proformas.delete'),
  asyncHandler(async (req, res) => {
    const p = await prisma.proforma.findUnique({ where: { id: Number(req.params.id) }, include: { order: { select: { number: true, deletedAt: true } } } });
    if (!p) throw new ApiError(404, 'Proforma not found.');
    if (p.deletedAt) throw new ApiError(409, `${p.number} is already in the trash.`);
    if (p.order) {
      // The order may itself be in the trash, in which case "delete it first" is wrong
      // advice — it has been deleted, and it still points here.
      throw new ApiError(
        409,
        p.order.deletedAt
          ? `${p.number} became order ${p.order.number}, which is in the trash and still points at it. Destroy that order for good first, or restore it.`
          : `${p.number} became order ${p.order.number} — delete the order first.`
      );
    }
    const deletedAt = await softDelete('proforma', p.id);
    res.json({ deleted: true, deletedAt, number: p.number, note: 'Moved to the trash and can be restored.' });
  })
);

// --- PI document: PDF + e-mail draft ---------------------------------------

function pdfInputFor(s: ReturnType<typeof serializeProforma>, co: CompanyProfile) {
  return {
    number: s.number,
    date: s.date,
    validUntil: s.validUntil,
    currencyCode: s.currency?.code ?? 'INR',
    showImages: s.showImages,
    buyer: s.buyer,
    company: co,
    incoterms: s.incoterms,
    paymentTerms: s.paymentTerms,
    // A domestic buyer remits in rupees to the same account, so the bank block is
    // useful either way; fall back to the company's own if the document has none.
    bankDetails: s.bankDetails || co.bankDetails,
    deliveryTerms: s.deliveryTerms,
    notes: s.notes,
    charges: s.charges,
    lines: s.lines.map((l: any) => ({
      description: l.description,
      qty: l.qty,
      unitPrice: l.unitPrice,
      productCode: l.product?.factoryCode ?? null,
      specs: l.specs,
      imageFile: l.image?.filename ?? null,
      discountPct: l.discountPct,
      discountAmt: l.discountAmt,
      gstRatePct: l.gstRatePct,
      hsnCode: l.hsnCode,
    })),
  };
}

router.get(
  '/proformas/:id/pdf',
  can('proformas.view', 'proformas.documents'),
  asyncHandler(async (req, res) => {
    const s = await serializedProforma(Number(req.params.id));
    const pdf = await proformaPdf(pdfInputFor(s, await ensureCompany()));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${s.number}.pdf"`);
    res.send(pdf);
  })
);

function mailInputFor(s: ReturnType<typeof serializeProforma>, co: CompanyProfile, senderName?: string | null) {
  return {
    company: co,
    number: s.number,
    date: s.date,
    validUntil: s.validUntil,
    currencyCode: s.currency?.code ?? 'INR',
    total: s.total,
    incoterms: s.incoterms,
    paymentTerms: s.paymentTerms,
    deliveryTerms: s.deliveryTerms,
    buyer: s.buyer,
    // The NET amount, so the body cannot contradict the attached PDF.
    lines: s.lines.map((l: any) => ({ description: l.description, qty: l.qty, unitPrice: l.unitPrice, amount: l.amount })),
    totals: s.totals,
    senderName: senderName ?? null,
  };
}

/** Everything the UI needs to offer both send routes. */
router.get(
  '/proformas/:id/mail',
  can('proformas.view', 'proformas.documents', 'proformas.email'),
  asyncHandler(async (req, res) => {
    const s = await serializedProforma(Number(req.params.id));
    const me = await prisma.user.findUnique({ where: { id: req.user!.sub }, select: { name: true } });
    const to = s.buyer.email ? [s.buyer.email] : [];
    const mail = proformaMail(mailInputFor(s, await ensureCompany(), me?.name));
    res.json({
      to,
      hasEmail: to.length > 0,
      buyerName: s.buyer.name,
      contactName: s.buyer.contactName ?? null,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      mailto: to.length ? mailtoUrl(to, mail.subject, mail.text) : null,
      filename: `${s.number}.pdf`,
      // mailto: cannot carry an attachment — the .eml route is how the PDF rides along.
      attachmentSupported: false,
    });
  })
);

/** A ready-to-send draft (To/Subject/Body + the PI PDF attached) as an .eml file. */
router.get(
  '/proformas/:id/email.eml',
  can('proformas.view', 'proformas.documents', 'proformas.email'),
  asyncHandler(async (req, res) => {
    const s = await serializedProforma(Number(req.params.id));
    const me = await prisma.user.findUnique({ where: { id: req.user!.sub }, select: { name: true } });
    if (!s.buyer.email) throw new ApiError(400, `${s.buyer.name} has no e-mail address. Add one in Master Data → Buyers.`);
    const co = await ensureCompany();
    const mail = proformaMail(mailInputFor(s, co, me?.name));
    const pdf = await proformaPdf(pdfInputFor(s, co));
    const eml = buildEml({
      to: [s.buyer.email],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      attachments: [{ filename: `${s.number}.pdf`, contentType: 'application/pdf', content: pdf }],
    });
    res.setHeader('Content-Type', 'message/rfc822');
    res.setHeader('Content-Disposition', `attachment; filename="${s.number}.eml"`);
    res.send(Buffer.from(eml, 'utf8'));
  })
);

export default router;
