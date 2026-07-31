import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { ApiError, asyncHandler, guardIdParams } from '../lib/http';
import { authenticate, requireRole } from '../middleware/auth';
import { nextDocNumber } from '../lib/numbering';
import { computeCostSheet } from '../lib/productCosting';
import { loadMethodMap } from '../lib/methods';
import { round } from '../lib/costing';
import { buildBoard } from '../lib/production';
import {
  allocateFifo,
  buildStatement,
  jobworkEventsForOrder,
  receivablesByCurrency,
  type AllocationResult,
  type Bucket,
  type FinanceInvoiceLike,
  type ForexOrderRow,
  type PaymentRow,
  type ReceivableBasis,
} from '../lib/finance';
import { loadFinanceInvoices, receivableBasis } from '../lib/orderBoard';
import { buildWorkforceContext, contractorStatement, workerStatement, workforceTotals, type WorkforceContext } from '../lib/manforce';
import { dayKey } from '../lib/workforce';
import { documentValueOf } from '../lib/pricing';
import { companyState, ensureCompany } from '../lib/company';
import { sheetPdf } from '../lib/docPdf';
import { assertLive, notDeleted, restore, softDelete } from '../lib/softDelete';

const router = Router();
// A route param here is always a database id — see guardIdParams.
guardIdParams(router);
router.use(authenticate);
const canEdit = requireRole('Operator');
const canManage = requireRole('Manager');

// ---------------------------------------------------------------------------
// Material sheets — the live costing explosion for a product × qty.
// Production PROGRESS lives on the order board, never here.
// ---------------------------------------------------------------------------

const sheetInclude = {
  product: { select: { id: true, factoryCode: true, name: true, unit: { select: { code: true } } } },
  order: { select: { id: true, number: true, buyer: { select: { name: true } } } },
  orderLine: { select: { id: true, qty: true, stages: { select: { name: true, vendor: { select: { id: true, name: true } } }, orderBy: { sortOrder: 'asc' as const } } } },
};

/** Explode a product's live costing to per-piece + order-total figures. */
function explode(computed: any, qty: number) {
  if (!computed) return null;
  const groups = (computed.groups || []).map((g: any) => ({
    head: g.head,
    name: g.name,
    method: g.method,
    total: g.total,
    orderTotal: round(g.total * qty),
    lines: (g.lines || []).map((l: any) => ({
      name: l.name,
      unit: l.unit,
      measure: l.measure,
      amount: l.amount,
      orderMeasure: round((l.measure || 0) * qty, 3),
      orderAmount: round((l.amount || 0) * qty),
    })),
  }));
  const s = computed.summary;
  const headTotalsOrder: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.headTotals as Record<string, number>)) headTotalsOrder[k] = round(v * qty);
  return {
    currency: computed.currency ? { code: computed.currency.code, symbol: computed.currency.symbol } : null,
    perPiece: s,
    order: {
      qty,
      headTotals: headTotalsOrder,
      exFactory: round(s.exFactory * qty),
      forwarding: round(s.forwarding * qty),
      fob: round(s.fob * qty),
      nonFob: round(s.nonFob * qty),
    },
    groups,
  };
}

async function explosionFor(productId: number, qty: number) {
  const [methods, product] = await Promise.all([
    loadMethodMap(),
    prisma.product.findUnique({
      where: { id: productId },
      include: { costSheets: { where: { isActive: true }, include: { currency: true, groups: { orderBy: { sortOrder: 'asc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } } } },
    }),
  ]);
  return explode(computeCostSheet(product?.costSheets?.[0], methods), qty);
}

router.get(
  '/operation-sheets',
  asyncHandler(async (req, res) => {
    const where = { ...notDeleted, ...(req.query.orderId ? { orderId: Number(req.query.orderId) } : {}) };
    res.json(await prisma.operationSheet.findMany({ where, include: sheetInclude, orderBy: { createdAt: 'desc' } }));
  })
);

router.get(
  '/operation-sheets/trash',
  canManage,
  asyncHandler(async (_req, res) => {
    res.json(
      await prisma.operationSheet.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, number: true, qty: true, deletedAt: true, product: { select: { factoryCode: true, name: true } } },
        orderBy: { deletedAt: 'desc' },
      })
    );
  })
);

router.get(
  '/operation-sheets/:id',
  asyncHandler(async (req, res) => {
    const sheet = await prisma.operationSheet.findUnique({ where: { id: Number(req.params.id) }, include: sheetInclude });
    if (!sheet) throw new ApiError(404, 'Material sheet not found.');
    if (sheet.deletedAt) throw new ApiError(410, `${sheet.number} is in the trash. Restore it to open it.`);
    res.json({ ...sheet, explosion: await explosionFor(sheet.productId, sheet.qty) });
  })
);

/** The material sheet as a printable working document. */
router.get(
  '/operation-sheets/:id/pdf',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const [sheet, co] = await Promise.all([
      prisma.operationSheet.findUnique({ where: { id }, include: sheetInclude }),
      ensureCompany(),
    ]);
    if (!sheet) throw new ApiError(404, 'Material sheet not found.');
    if (sheet.deletedAt) throw new ApiError(410, `${sheet.number} is in the trash. Restore it to print it.`);
    const explosion = await explosionFor(sheet.productId, sheet.qty);
    if (!explosion) throw new ApiError(400, `${sheet.product.factoryCode} has no active cost sheet, so there is nothing to explode.`);

    const pdf = await sheetPdf({
      number: sheet.number,
      date: sheet.createdAt,
      company: co,
      product: { factoryCode: sheet.product.factoryCode, name: sheet.product.name, unit: sheet.product.unit?.code ?? null },
      orderNumber: sheet.order?.number ?? null,
      buyerName: sheet.order?.buyer?.name ?? null,
      qty: sheet.qty,
      currencyCode: explosion.currency?.code ?? 'INR',
      explosion: explosion as never,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${sheet.number}.pdf"`);
    res.send(pdf);
  })
);

const sheetSchema = z.object({
  productId: z.number().int().optional(),
  orderId: z.number().int().nullable().optional(),
  orderLineId: z.number().int().nullable().optional(),
  qty: z.number().int().positive().optional(),
  notes: z.string().nullable().optional(),
});

/**
 * Find-or-create. A sheet asked for by order line always returns the existing one,
 * so the floor never ends up with two sheets numbered differently for one job.
 */
router.post(
  '/operation-sheets',
  canEdit,
  asyncHandler(async (req, res) => {
    const data = sheetSchema.parse(req.body);
    // A material sheet for a hidden product would explode a costing nobody can open.
    if (data.productId) await assertLive('product', [data.productId], 'a material sheet');

    if (data.orderLineId) {
      const line = await prisma.orderLine.findUnique({ where: { id: data.orderLineId }, include: { sheet: true } });
      if (!line) throw new ApiError(404, 'Order line not found.');
      // A TRASHED sheet must not be handed back as "existing": the page would open a
      // sheet that no list shows, and the line could never get another one because
      // `orderLineId` is unique. Restore it explicitly, or make a fresh one.
      if (line.sheet?.deletedAt) {
        throw new ApiError(409, `${line.sheet.number} for this line is in the trash. Restore it from the material sheets trash, or destroy it first.`);
      }
      if (line.sheet) {
        const full = await prisma.operationSheet.findUnique({ where: { id: line.sheet.id }, include: sheetInclude });
        return res.status(200).json({ ...full!, explosion: await explosionFor(full!.productId, full!.qty), existing: true });
      }
      const number = await nextDocNumber('OP');
      const sheet = await prisma.operationSheet.create({
        data: { number, productId: line.productId, orderId: line.orderId, orderLineId: line.id, qty: data.qty ?? line.qty, notes: data.notes ?? null, createdById: req.user!.sub },
        include: sheetInclude,
      });
      return res.status(201).json({ ...sheet, explosion: await explosionFor(sheet.productId, sheet.qty) });
    }

    if (!data.productId) throw new ApiError(400, 'Pick a product (or an order line) for the sheet.');
    const product = await prisma.product.findUnique({ where: { id: data.productId } });
    if (!product) throw new ApiError(404, 'Product not found.');
    const number = await nextDocNumber('OP');
    const sheet = await prisma.operationSheet.create({
      data: { number, productId: data.productId, orderId: data.orderId ?? null, qty: data.qty ?? 1, notes: data.notes ?? null, createdById: req.user!.sub },
      include: sheetInclude,
    });
    res.status(201).json({ ...sheet, explosion: await explosionFor(sheet.productId, sheet.qty) });
  })
);

router.put(
  '/operation-sheets/:id',
  canEdit,
  asyncHandler(async (req, res) => {
    const data = sheetSchema.parse(req.body);
    const sheet = await prisma.operationSheet.update({
      where: { id: Number(req.params.id) },
      data: {
        ...(data.qty != null ? { qty: data.qty } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      },
      include: sheetInclude,
    });
    res.json({ ...sheet, explosion: await explosionFor(sheet.productId, sheet.qty) });
  })
);


router.post(
  '/operation-sheets/:id/restore',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.operationSheet.findUnique({ where: { id }, select: { deletedAt: true, number: true } });
    if (!existing) throw new ApiError(404, 'Material sheet not found.');
    if (!existing.deletedAt) throw new ApiError(409, `${existing.number} is not in the trash.`);
    await restore('operationSheet', id);
    res.json({ restored: true, number: existing.number });
  })
);

router.delete(
  '/operation-sheets/:id/permanent',
  requireRole('Admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.operationSheet.findUnique({ where: { id }, select: { deletedAt: true, number: true } });
    if (!existing) throw new ApiError(404, 'Material sheet not found.');
    if (!existing.deletedAt) throw new ApiError(409, `${existing.number} is still live. Delete it first.`);
    await prisma.operationSheet.delete({ where: { id } });
    res.status(204).end();
  })
);

router.delete(
  '/operation-sheets/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.operationSheet.findUnique({ where: { id }, select: { deletedAt: true, number: true } });
    if (!existing) throw new ApiError(404, 'Material sheet not found.');
    if (existing.deletedAt) throw new ApiError(409, `${existing.number} is already in the trash.`);
    const deletedAt = await softDelete('operationSheet', id);
    res.json({ deleted: true, deletedAt, number: existing.number });
  })
);

// ---------------------------------------------------------------------------
// Money — every figure derived from orders and the production board
//
//   buyer receivable = order value           - receipts, spread oldest-first
//   jobwork payable  = board-accrued jobwork - payments, spread oldest-first
//   material / wages = entered bills         - payments, spread oldest-first
//
// Nothing the system can work out is ever typed in, and no allocation is stored:
// spreading a payment is a pure function of what is outstanding, recomputed on
// every read (see lib/finance.ts). A payment bigger than the thing it names flows
// on to the next oldest debt; a surplus with nothing left to settle sits as credit.
// ---------------------------------------------------------------------------

/**
 * What counts as a live order for the money: not cancelled, and not in the trash. Both
 * exclusions happen HERE at the query layer — the pure finance functions know about
 * neither, which is what keeps them simple.
 */
const LIVE_ORDER = { status: { not: 'Cancelled' }, deletedAt: null } as const;

const financeOrderInclude = {
  // market + state are what decide whether this order carries GST and how it splits.
  buyer: { select: { id: true, name: true, code: true, email: true, phone: true, country: true, market: true, channel: true, state: true, gstNo: true } },
  currency: { select: { code: true, symbol: true } },
  charges: { orderBy: { sortOrder: 'asc' as const } },
  lines: {
    include: {
      stages: { include: { vendor: { select: { id: true, name: true } } }, orderBy: { sortOrder: 'asc' as const } },
      moves: true,
      product: { select: { factoryCode: true, name: true } },
    },
  },
};

const financeEntryInclude = {
  supplier: { select: { id: true, name: true, code: true, type: true, phone: true, gstNo: true, paymentTerms: true } },
  buyer: { select: { id: true, name: true, code: true } },
  order: { select: { id: true, number: true } },
  stockTxn: { select: { id: true, qty: true, rate: true, date: true, rawItem: { select: { code: true, name: true, unit: true } } } },
};

/** Everything needed to compute the money position, in one read. */
async function financeData() {
  const [orders, entries, currencies, ourState, basis] = await Promise.all([
    prisma.order.findMany({ where: LIVE_ORDER, include: financeOrderInclude, orderBy: [{ orderDate: 'asc' }, { id: 'asc' }] }),
    // A receipt booked against a trashed order leaves with it. Otherwise that order's
    // bucket vanishes from the FIFO run while the money stays behind, and `allocateFifo`
    // silently re-spreads it across the buyer's OTHER orders — marking an unpaid one
    // settled and dropping the receivable.
    prisma.ledgerEntry.findMany({
      where: { ...notDeleted, OR: [{ orderId: null }, { order: { deletedAt: null } }] },
      include: financeEntryInclude,
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    }),
    prisma.currency.findMany({ select: { code: true, symbol: true, rateToBase: true } }),
    companyState(),
    receivableBasis(),
  ]);
  /**
   * Rupee rate for a currency code. Taken from the currency master rather than from
   * an order, because a receipt can sit in a currency the buyer has no live order in
   * — and falling back to 1 there would value it as if it were rupees.
   */
  const rateOf = (code: string) => currencies.find((c) => c.code === code)?.rateToBase ?? 1;
  const symbolOf = (code: string) => currencies.find((c) => c.code === code)?.symbol ?? '';
  // Invoices are only the debt under the INVOICE basis; under ORDER they change no figure,
  // so a list page should not pay for the join.
  const invoices = basis === 'INVOICE' ? await loadFinanceInvoices([...new Set(orders.map((o) => o.buyerId))]) : [];
  return { orders, entries, rateOf, symbolOf, ourState, basis, invoices };
}

type FinanceOrder = Awaited<ReturnType<typeof financeData>>['orders'][number];
type FinanceEntry = Awaited<ReturnType<typeof financeData>>['entries'][number];

/**
 * What an order is worth, through the one pricing engine — line discounts, document
 * charges and GST included. This is the same call `serializeOrder` and the FIFO buckets
 * make, which is what stops the Payments page and the order page disagreeing.
 */
const orderValue = (o: FinanceOrder, ourState: string | null) => documentValueOf(o as never, ourState);

/** Never let a credit or a mistyped discount offset somebody else's real debt. */
const clamp = (v: number) => round(Math.max(v, 0));

const entriesFor = (entries: FinanceEntry[], partyType: string, kind: 'BILL' | 'PAYMENT', partyId?: number | null, partyName?: string) =>
  entries.filter(
    (e) =>
      e.partyType === partyType &&
      e.kind === kind &&
      (partyId != null ? e.supplierId === partyId || e.buyerId === partyId : true) &&
      (partyName != null ? e.partyName === partyName : true)
  );

const toPaymentRows = (entries: FinanceEntry[]): PaymentRow[] =>
  entries.map((e) => ({ id: e.id, date: e.date, amount: e.amount, orderId: e.orderId, invoiceId: e.invoiceId }));

const sumOf = (entries: { partyType: string; kind: string; amount: number }[], partyType: string, kind: string) =>
  entries.filter((e) => e.partyType === partyType && e.kind === kind).reduce((a, e) => a + e.amount, 0);

/** Attach the computed allocation back onto each payment entry for the API. */
function describePayments(entries: FinanceEntry[], result: AllocationResult) {
  return entries.map((e) => {
    const a = result.payments.find((p) => p.paymentId === e.id);
    return {
      id: e.id,
      date: e.date,
      amount: e.amount,
      currency: e.currency ?? 'INR',
      ref: e.ref,
      note: e.note,
      partyName: e.partyName,
      aimedAtOrder: e.order?.number ?? null,
      allocations: a?.allocations ?? [],
      unallocated: a?.unallocated ?? 0,
    };
  });
}

/**
 * A buyer's position, per currency: their orders are the debts and their receipts
 * settle them oldest-first. Receipts only ever apply to orders in the same currency,
 * so no hidden conversion can creep into a balance.
 */
function buyerPositions(
  orders: FinanceOrder[],
  entries: FinanceEntry[],
  buyerId: number,
  rateOf: (code: string) => number,
  symbolOf: (code: string) => string,
  ourState: string | null,
  basis: ReceivableBasis = 'ORDER',
  invoices: FinanceInvoiceLike[] = []
) {
  const mine = orders.filter((o) => o.buyerId === buyerId);
  // Only an ISSUED invoice is a debt — a draft has not been sent, a cancelled one keeps its
  // number but stops being owed. Same rule as buildFinanceContext, deliberately worded the
  // same way so the two cannot drift.
  const myInvoices = invoices.filter((i) => i.buyerId === buyerId && i.status === 'ISSUED');
  const receipts = entriesFor(entries, 'BUYER', 'PAYMENT', buyerId);
  const debtCodes = basis === 'INVOICE' ? myInvoices.map((i) => i.currency?.code ?? 'INR') : mine.map((o) => o.currency?.code ?? 'INR');
  const currencies = [...new Set([...debtCodes, ...receipts.map((r) => r.currency ?? 'INR')])];

  return currencies.map((code) => {
    const ordersInCcy = mine.filter((o) => (o.currency?.code ?? 'INR') === code);
    const invoicesInCcy = myInvoices.filter((i) => (i.currency?.code ?? 'INR') === code);
    const receiptsInCcy = receipts.filter((r) => (r.currency ?? 'INR') === code);

    /**
     * What is owed, and at what grain. Under ORDER the order is the debt; under INVOICE the
     * invoice is, and it may cover several orders — which is exactly why a caller must not
     * assume one bucket is one order. Use `subjectOf()` below.
     */
    const buckets: Bucket[] =
      basis === 'INVOICE'
        ? invoicesInCcy.map((i) => ({
            key: `invoice-${i.id}`,
            orderId: null,
            invoiceId: i.id,
            label: i.number,
            date: i.invoiceDate,
            gross: documentValueOf(i as never, ourState),
          }))
        : ordersInCcy.map((o) => ({ key: `order-${o.id}`, orderId: o.id, label: o.number, date: o.orderDate, gross: orderValue(o, ourState) }));

    const result = allocateFifo(buckets, toPaymentRows(receiptsInCcy));
    const rate = rateOf(code);

    /**
     * What a bucket is ABOUT, for a page that has to name it. One shape whichever basis is
     * in force, so no caller has to branch — and none of them may reach for
     * `orders.find(o => o.id === b.orderId)!`, which is null on an invoice bucket.
     *
     * `orderId` on an invoice subject is the order its largest line belongs to. It is for
     * linking, not for arithmetic: an invoice spanning two orders is still ONE debt, and
     * splitting it is `attributeToOrders()`'s job inside the finance engine.
     */
    const subjectOf = (b: Bucket) => {
      if (b.invoiceId != null) {
        const inv = invoicesInCcy.find((i) => i.id === b.invoiceId)!;
        const primary = [...inv.lines].sort((a, x) => (x.qty * x.unitPrice) - (a.qty * a.unitPrice))[0]?.orderId ?? null;
        const order = primary != null ? ordersInCcy.find((o) => o.id === primary) : undefined;
        return {
          kind: 'INVOICE' as const,
          id: inv.id,
          number: inv.number,
          date: inv.invoiceDate,
          exchangeRate: inv.exchangeRate ?? 1,
          orderId: primary,
          orderNumber: order?.number ?? null,
          status: inv.status,
          // The invoice's own buyer is the fallback: this buyer may have no live order in
          // this currency at all, and a blank name on a receivables row is a bug nobody
          // would report as one.
          buyer: order?.buyer ?? (inv.buyer?.name ? { name: inv.buyer.name, code: inv.buyer.code ?? '' } : null),
          deliveryDate: order?.deliveryDate ?? null,
        };
      }
      const order = ordersInCcy.find((o) => o.id === b.orderId)!;
      return {
        kind: 'ORDER' as const,
        id: order.id,
        number: order.number,
        date: order.orderDate,
        exchangeRate: order.exchangeRate ?? 1,
        orderId: order.id,
        orderNumber: order.number,
        status: order.status,
        buyer: order.buyer,
        deliveryDate: order.deliveryDate,
      };
    };

    /**
     * Confirmed but not yet billed. Under INVOICE this is deliberately OUTSIDE the buckets
     * above — it is order book, not a receivable. Zero under ORDER, where the order already
     * IS the debt and counting it twice would double the buyer's balance.
     */
    const orderBook =
      basis === 'INVOICE'
        ? round(
            Math.max(
              0,
              ordersInCcy.reduce((a, o) => a + orderValue(o, ourState), 0) -
                invoicesInCcy.reduce((a, i) => a + documentValueOf(i as never, ourState), 0)
            )
          )
        : 0;

    return {
      currency: code,
      symbol: symbolOf(code) || '₹',
      exchangeRate: rate,
      basis,
      invoiced: round(buckets.reduce((a, b) => a + b.gross, 0)),
      received: round(receiptsInCcy.reduce((a, r) => a + r.amount, 0)),
      balance: round(result.buckets.reduce((a, b) => a + b.balance, 0)),
      credit: result.credit,
      orderBook,
      buckets: result.buckets,
      orders: ordersInCcy,
      invoices: invoicesInCcy,
      subjectOf,
      receipts: describePayments(receiptsInCcy, result),
      result,
    };
  });
}

/**
 * A jobwork vendor's position. The debts are the earnings accrued per order — the
 * pieces they cleared times the rate on that stage — dated by the first movement on
 * that order, so payments settle the oldest work first.
 */
function jobworkPosition(orders: FinanceOrder[], entries: FinanceEntry[], vendorId: number) {
  const events = orders.flatMap((o) => jobworkEventsForOrder(o as any)).filter((e) => e.vendorId === vendorId);
  const perOrder = new Map<number, { orderId: number; orderNumber: string; date: Date | string; gross: number; pieces: number }>();
  for (const e of events) {
    const row = perOrder.get(e.orderId) ?? { orderId: e.orderId, orderNumber: e.orderNumber, date: e.date, gross: 0, pieces: 0 };
    row.gross = round(row.gross + e.amount);
    row.pieces += e.pieces;
    if (new Date(e.date) < new Date(row.date)) row.date = e.date;
    perOrder.set(e.orderId, row);
  }
  const buckets: Bucket[] = [...perOrder.values()].map((r) => ({ key: `order-${r.orderId}`, orderId: r.orderId, label: r.orderNumber, date: r.date, gross: r.gross }));
  const payments = entriesFor(entries, 'JOBWORK', 'PAYMENT', vendorId);
  const result = allocateFifo(buckets, toPaymentRows(payments));
  return { events, buckets: result.buckets, perOrder: [...perOrder.values()], payments: describePayments(payments, result), result };
}

/**
 * A material supplier's (or worker's) position. Here the debts are the bills we
 * entered, because nothing else knows what they charged.
 */
function billedPosition(entries: FinanceEntry[], partyType: 'SUPPLIER' | 'WORKER', partyId: number | null, partyName?: string) {
  const bills = entriesFor(entries, partyType, 'BILL', partyId, partyName);
  const buckets: Bucket[] = bills.map((b) => ({
    key: `bill-${b.id}`,
    orderId: b.orderId,
    label: b.ref || (b.stockTxn ? `${b.stockTxn.rawItem.name} receipt` : `Bill #${b.id}`),
    date: b.date,
    gross: b.amount,
  }));
  const payments = entriesFor(entries, partyType, 'PAYMENT', partyId, partyName);
  const result = allocateFifo(buckets, toPaymentRows(payments));
  return { bills, buckets: result.buckets, payments: describePayments(payments, result), result };
}

// --- receivables ------------------------------------------------------------

router.get(
  '/finance/receivables',
  asyncHandler(async (_req, res) => {
    const { orders, entries, rateOf, symbolOf, ourState, basis, invoices } = await financeData();
    const buyerIds = [...new Set(orders.map((o) => o.buyerId))];

    const rows: any[] = [];
    const credits: any[] = [];
    let orderBookInr = 0;
    for (const buyerId of buyerIds) {
      for (const pos of buyerPositions(orders, entries, buyerId, rateOf, symbolOf, ourState, basis, invoices)) {
        const buyer = pos.orders[0]?.buyer;
        orderBookInr = round(orderBookInr + pos.orderBook * pos.exchangeRate);
        for (const b of pos.buckets) {
          // What this debt is about — an order or an invoice, one shape either way.
          const s = pos.subjectOf(b);
          // Matched on the bucket KEY, not on an order id: an invoice bucket carries no
          // order id, and two orders could otherwise collide on a null.
          const settled = pos.receipts.filter((r) => r.allocations.some((a) => a.key === b.key));
          rows.push({
            docKind: s.kind,
            docId: s.id,
            docNumber: s.number,
            orderId: s.orderId,
            orderNumber: s.orderNumber,
            buyerId,
            buyerName: buyer?.name ?? s.buyer?.name ?? '',
            status: s.status,
            orderDate: s.date,
            deliveryDate: s.deliveryDate,
            currency: pos.currency,
            symbol: pos.symbol,
            exchangeRate: s.exchangeRate,
            invoiced: b.gross,
            received: b.paid,
            balance: b.balance,
            balanceInr: round(b.balance * s.exchangeRate),
            // The same money three ways: the buyer's currency, rupees at the rate the
            // document was booked at, and rupees at today's rate. The gap between the last
            // two is unrealised forex — nothing is booked until the money arrives.
            invoicedFcy: b.gross,
            receivedFcy: b.paid,
            receivableFcy: b.balance,
            snapshotRate: s.exchangeRate,
            currentRate: rateOf(pos.currency),
            invoicedInr: round(b.gross * s.exchangeRate),
            receivableInr: round(b.balance * s.exchangeRate),
            receivableAtCurrentRate: round(b.balance * rateOf(pos.currency)),
            forexGainLoss: round(b.balance * rateOf(pos.currency) - b.balance * s.exchangeRate),
            receiptCount: settled.length,
            receipts: settled.map((r) => ({
              id: r.id,
              date: r.date,
              ref: r.ref,
              amount: r.allocations.find((a) => a.key === b.key)!.amount,
              fullAmount: r.amount,
              spreadAcross: r.allocations.length,
              aimedAtOrder: r.aimedAtOrder,
            })),
          });
        }
        if (pos.credit > 0 && buyer) {
          credits.push({ buyerId, buyerName: buyer.name, currency: pos.currency, symbol: pos.symbol, amount: pos.credit });
        }
      }
    }

    rows.sort((a, b) => new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime());
    // Built from the very rows above, so the summary bar and the table cannot disagree.
    const forex = receivablesByCurrency(rows as ForexOrderRow[], symbolOf);
    // Under the invoice basis, confirmed-but-unbilled value is shown BESIDE the receivable
    // rather than inside it. Zero under the order basis, where the order is already the debt.
    res.json({ rows, credits, forex, basis, orderBookInr });
  })
);

// --- payables ---------------------------------------------------------------

/**
 * What is outstanding, grouped by currency and valued at both the booked and the live
 * rate. Powers the summary bar on Payments and the dashboard widget.
 */
router.get(
  '/finance/receivables/summary',
  asyncHandler(async (_req, res) => {
    const { orders, entries, rateOf, symbolOf, ourState, basis, invoices } = await financeData();
    const rows: ForexOrderRow[] = [];
    for (const buyerId of [...new Set(orders.map((o) => o.buyerId))]) {
      for (const pos of buyerPositions(orders, entries, buyerId, rateOf, symbolOf, ourState, basis, invoices)) {
        for (const b of pos.buckets) {
          const s = pos.subjectOf(b);
          const snapshotRate = s.exchangeRate;
          const currentRate = rateOf(pos.currency);
          rows.push({
            orderId: s.id,
            currency: pos.currency,
            invoicedFcy: b.gross,
            receivedFcy: b.paid,
            receivableFcy: b.balance,
            snapshotRate,
            currentRate,
            receivableInr: round(b.balance * snapshotRate),
            receivableAtCurrentRate: round(b.balance * currentRate),
            forexGainLoss: round(b.balance * currentRate - b.balance * snapshotRate),
          });
        }
      }
    }
    res.json(receivablesByCurrency(rows, symbolOf));
  })
);

router.get(
  '/finance/payables',
  asyncHandler(async (_req, res) => {
    const { orders, entries, rateOf, symbolOf, ourState } = await financeData();

    const rows: any[] = [];

    // Jobwork vendors — everyone who owns a stage that has cleared pieces.
    const allEvents = orders.flatMap((o) => jobworkEventsForOrder(o as any));
    for (const vendorId of [...new Set(allEvents.map((e) => e.vendorId))]) {
      const pos = jobworkPosition(orders, entries, vendorId);
      const name = allEvents.find((e) => e.vendorId === vendorId)!.vendorName;
      const accrued = round(pos.buckets.reduce((a, b) => a + b.gross, 0));
      const paid = round(pos.buckets.reduce((a, b) => a + b.paid, 0));
      rows.push({
        partyType: 'JOBWORK',
        // Without this the Payments page falls back to looking the vendor up by name,
        // and the statement route refuses it — the id is right here.
        partyId: vendorId,
        supplierId: vendorId,
        partyName: name,
        accrued,
        paid,
        balance: round(accrued - paid),
        credit: pos.result.credit,
        pieces: pos.events.reduce((a, e) => a + e.pieces, 0),
        events: pos.events.length,
        jobs: pos.perOrder.map((r) => {
          const bucket = pos.buckets.find((b) => b.orderId === r.orderId)!;
          return {
            orderId: r.orderId,
            orderNumber: r.orderNumber,
            pieces: r.pieces,
            amount: r.gross,
            paid: bucket.paid,
            balance: bucket.balance,
            stages: [...new Set(pos.events.filter((e) => e.orderId === r.orderId).map((e) => e.stage))],
            product: [...new Set(pos.events.filter((e) => e.orderId === r.orderId).map((e) => `${e.productCode} — ${e.productName}`))].join(', '),
          };
        }),
      });
    }

    // Material suppliers — from the bills we entered.
    const billed = entries.filter((e) => e.partyType === 'SUPPLIER' && (e.kind === 'BILL' || e.kind === 'PAYMENT'));
    const keys = [...new Set(billed.map((e) => `${e.partyType}:${e.supplierId ?? e.partyName}`))];
    for (const key of keys) {
      const [partyType, idOrName] = key.split(':') as ['SUPPLIER', string];
      const supplierId = /^\d+$/.test(idOrName) ? Number(idOrName) : null;
      const partyName = supplierId == null ? idOrName : undefined;
      const pos = billedPosition(entries, partyType, supplierId, partyName);
      const accrued = round(pos.buckets.reduce((a, b) => a + b.gross, 0));
      const paid = round(pos.buckets.reduce((a, b) => a + b.paid, 0));
      const label = supplierId != null ? pos.bills[0]?.supplier?.name ?? pos.payments[0]?.partyName ?? `#${supplierId}` : idOrName;
      rows.push({
        partyType,
        partyId: supplierId,
        supplierId,
        partyName: label,
        accrued,
        paid,
        balance: round(accrued - paid),
        credit: pos.result.credit,
        pieces: 0,
        events: pos.bills.length,
        jobs: pos.buckets.map((b) => ({
          orderId: b.orderId,
          orderNumber: b.label,
          pieces: 0,
          amount: b.gross,
          paid: b.paid,
          balance: b.balance,
          stages: [],
          product: '',
        })),
      });
    }

    // The workforce. Wages are derived, so there is nothing to bill — see
    // lib/workforce.ts. A gang member is not listed here: their money is inside
    // their contractor's balance, and listing both would double the payable.
    for (const row of workforcePayables(await buildWorkforceContext())) rows.push(row);

    res.json(rows.sort((a, b) => b.balance - a.balance));
  })
);

/**
 * Workers, contractors and statutory dues as payable rows.
 *
 * Shaped exactly like the vendor rows above so the Payments page needs no special
 * case: `jobs` carries the breakdown that explains the balance.
 */
function workforcePayables(ctx: WorkforceContext) {
  const rows: any[] = [];

  for (const account of ctx.directWorkers) {
    const p = account.position;
    if (p.earned === 0 && p.paid === 0 && p.advanced === 0) continue;
    rows.push({
      partyType: 'WORKER',
      partyId: account.worker.id,
      supplierId: null,
      partyName: account.worker.name,
      code: account.worker.code,
      accrued: p.earned,
      paid: round(p.paid + p.advanced),
      balance: p.balance,
      credit: round(Math.max(-p.balance, 0)),
      pieces: p.earnedPieces,
      events: account.earnings.length,
      dueNow: p.dueNow,
      advanceOutstanding: p.advanceOutstanding,
      jobs: [
        { orderId: null, orderNumber: 'Earned', pieces: p.earnedPieces, amount: p.earned, paid: 0, balance: p.earned, stages: [], product: `${p.earnedDays} day(s)${p.overtimeEarned ? ` · OT ₹${p.overtimeEarned}` : ''}` },
        ...(p.deducted ? [{ orderId: null, orderNumber: 'Deductions', pieces: 0, amount: -p.deducted, paid: 0, balance: -p.deducted, stages: [], product: 'Charged to the worker' }] : []),
        ...(p.statutoryDeducted ? [{ orderId: null, orderNumber: 'Statutory', pieces: 0, amount: -p.statutoryDeducted, paid: 0, balance: -p.statutoryDeducted, stages: [], product: 'Employee share, posted' }] : []),
        ...(p.advanced ? [{ orderId: null, orderNumber: 'Advances', pieces: 0, amount: -p.advanced, paid: 0, balance: -p.advanceOutstanding, stages: [], product: `₹${p.advanceRecovered} recovered so far` }] : []),
      ],
    });
  }

  for (const c of ctx.contractors) {
    if (c.workers.length === 0 && c.paid === 0) continue;
    rows.push({
      partyType: 'CONTRACTOR',
      partyId: c.contractor.id,
      supplierId: null,
      partyName: c.contractor.name,
      code: c.contractor.code,
      accrued: c.accrued,
      paid: c.paid,
      balance: c.balance,
      credit: round(Math.max(-c.balance, 0)),
      pieces: c.workers.reduce((a, w) => a + w.position.earnedPieces, 0),
      events: c.workers.length,
      jobs: c.workers.map((w) => ({
        orderId: null,
        orderNumber: w.worker.name,
        pieces: w.position.earnedPieces,
        amount: w.position.earned,
        paid: 0,
        balance: round(w.position.earned - w.position.deducted - w.position.statutoryDeducted - w.position.advanced),
        stages: [],
        product: `${w.position.earnedDays} day(s)`,
      })),
    });
  }

  for (const s of ctx.statutory) {
    if (s.accrued === 0 && s.paid === 0) continue;
    rows.push({
      partyType: 'STATUTORY',
      partyId: s.componentId,
      supplierId: null,
      partyName: `${s.code}${s.payeeName ? ` — ${s.payeeName}` : ''}`,
      code: s.code,
      accrued: s.accrued,
      paid: s.paid,
      // A provision is a cost, not yet a debt to anyone, so it never reads as payable.
      balance: s.isProvision ? 0 : s.balance,
      credit: 0,
      pieces: 0,
      events: s.workers,
      isProvision: s.isProvision,
      jobs: [
        { orderId: null, orderNumber: 'Employee share', pieces: 0, amount: s.employee, paid: 0, balance: s.employee, stages: [], product: 'Deducted from wages' },
        { orderId: null, orderNumber: 'Employer share', pieces: 0, amount: s.employer, paid: 0, balance: s.employer, stages: [], product: "The factory's own cost" },
      ],
    });
  }

  // Wages typed against a name before Manforce existed. Nothing is lost while they
  // wait to be migrated onto real worker records.
  for (const u of ctx.unlinked) {
    rows.push({
      partyType: 'WORKER',
      partyId: null,
      supplierId: null,
      partyName: u.partyName,
      accrued: u.billed,
      paid: u.paid,
      balance: u.balance,
      credit: round(Math.max(-u.balance, 0)),
      pieces: 0,
      events: 0,
      unlinked: true,
      jobs: [],
    });
  }

  return rows;
}

/**
 * A workforce party's statement, in the same shape as a vendor's.
 *
 * There is no FIFO allocation here and deliberately so: a worker is ONE running
 * account, not a set of dated debts, so a payment has nothing to be spread across —
 * it simply reduces the balance. `dueNow` and `advanceOutstanding` are reported
 * alongside the balance, and the three always reconcile (see lib/workforce.ts).
 */
async function workforceStatementResponse(partyType: 'WORKER' | 'CONTRACTOR' | 'STATUTORY', partyId: number, entries: FinanceEntry[]) {
  const ctx = await buildWorkforceContext();
  const asPayment = (e: { id: number; date: Date | string; amount: number; ref?: string | null; note?: string | null; partyName?: string }) => ({
    id: e.id,
    date: e.date,
    amount: e.amount,
    currency: 'INR',
    ref: e.ref ?? null,
    note: e.note ?? null,
    partyName: e.partyName ?? '',
    aimedAtOrder: null,
    allocations: [],
    unallocated: 0,
  });

  if (partyType === 'WORKER') {
    const account = ctx.accounts.get(partyId);
    if (!account) throw new ApiError(404, 'Worker not found.');
    const w = account.worker;
    const p = account.position;

    const perOrder = new Map<number, { orderId: number; orderNumber: string; pieces: number; gross: number }>();
    for (const e of account.earnings) {
      if (e.kind !== 'PIECE' || e.orderId == null) continue;
      const row = perOrder.get(e.orderId) ?? { orderId: e.orderId, orderNumber: e.orderNumber ?? `#${e.orderId}`, pieces: 0, gross: 0 };
      row.pieces += e.pieces;
      row.gross = round(row.gross + e.amount);
      perOrder.set(e.orderId, row);
    }

    return {
      party: { partyType, partyId, name: w.name, code: w.code, phone: null, gstNo: null, paymentTerms: w.contractor ? `Paid through ${w.contractor.name}` : null },
      currency: 'INR',
      summary: { accrued: p.earned, paid: round(p.paid + p.advanced), balance: p.balance, credit: round(Math.max(-p.balance, 0)), pieces: p.earnedPieces, events: account.earnings.length },
      perOrder: [...perOrder.values()].map((r) => ({ orderId: r.orderId, orderNumber: r.orderNumber, pieces: r.pieces, gross: r.gross, paid: 0, balance: r.gross })),
      workforce: {
        payType: w.payType,
        trade: w.trade?.name ?? null,
        contractor: w.contractor?.name ?? null,
        dueNow: p.dueNow,
        deducted: p.deducted,
        statutoryDeducted: p.statutoryDeducted,
        earnedDays: p.earnedDays,
        overtimeEarned: p.overtimeEarned,
        advanced: p.advanced,
        advanceRecovered: p.advanceRecovered,
        advanceOutstanding: p.advanceOutstanding,
        advances: account.advances.map((a) => {
          const state = p.advanceStates.find((s) => s.advanceId === a.id);
          return { id: a.id, date: a.date, amount: a.amount, recoveryPerMonth: a.recoveryPerMonth, note: a.note ?? null, recovered: state?.recovered ?? 0, outstanding: state?.outstanding ?? a.amount };
        }),
      },
      payments: account.payments.map((x) => asPayment({ ...x, partyName: w.name })),
      statement: workerStatement(account),
    };
  }

  if (partyType === 'CONTRACTOR') {
    const account = ctx.contractors.find((c) => c.contractor.id === partyId);
    if (!account) throw new ApiError(404, 'Contractor not found.');
    const payments = entries.filter((e) => e.partyType === 'CONTRACTOR' && e.kind === 'PAYMENT' && e.contractorId === partyId);
    return {
      party: { partyType, partyId, name: account.contractor.name, code: account.contractor.code, phone: account.contractor.phone, gstNo: account.contractor.gstNo, paymentTerms: account.contractor.paymentTerms },
      currency: 'INR',
      summary: {
        accrued: account.accrued,
        paid: account.paid,
        balance: account.balance,
        credit: round(Math.max(-account.balance, 0)),
        pieces: account.workers.reduce((a, w) => a + w.position.earnedPieces, 0),
        events: account.workers.length,
      },
      perOrder: account.workers.map((w) => ({
        orderId: null,
        orderNumber: `${w.worker.code} — ${w.worker.name}`,
        pieces: w.position.earnedPieces,
        gross: w.position.earned,
        paid: 0,
        balance: round(w.position.earned - w.position.deducted - w.position.statutoryDeducted - w.position.advanced),
      })),
      workforce: {
        gang: account.workers.length,
        deducted: account.deducted,
        statutoryDeducted: account.statutoryDeducted,
        advanced: account.advanced,
        workers: account.workers.map((w) => ({ id: w.worker.id, code: w.worker.code, name: w.worker.name, payType: w.worker.payType, earned: w.position.earned, days: w.position.earnedDays, pieces: w.position.earnedPieces })),
      },
      payments: payments.map(asPayment),
      statement: contractorStatement(account, payments),
    };
  }

  // STATUTORY — one component, everything posted against it.
  const due = ctx.statutory.find((s) => s.componentId === partyId);
  const component = ctx.components.find((c) => c.id === partyId);
  if (!due || !component) throw new ApiError(404, 'Statutory component not found.');
  const lines = await prisma.statutoryPostingLine.findMany({
    where: { componentId: partyId },
    include: { posting: { select: { id: true, number: true, periodFrom: true, periodTo: true, postedOn: true } }, worker: { select: { code: true, name: true } } },
    orderBy: { id: 'asc' },
  });
  const payments = entries.filter((e) => e.partyType === 'STATUTORY' && e.kind === 'PAYMENT' && e.statutoryComponentId === partyId);

  const byPosting = new Map<number, { number: string; postedOn: Date; from: Date; to: Date; employee: number; employer: number; workers: number }>();
  for (const l of lines) {
    const row = byPosting.get(l.postingId) ?? { number: l.posting.number, postedOn: l.posting.postedOn, from: l.posting.periodFrom, to: l.posting.periodTo, employee: 0, employer: 0, workers: 0 };
    row.employee = round(row.employee + l.employeeAmt);
    row.employer = round(row.employer + l.employerAmt);
    row.workers += 1;
    byPosting.set(l.postingId, row);
  }

  return {
    party: { partyType, partyId, name: `${due.code} — ${due.name}`, code: due.code, phone: null, gstNo: null, paymentTerms: due.payeeName || null },
    currency: 'INR',
    summary: { accrued: due.accrued, paid: due.paid, balance: due.isProvision ? 0 : due.balance, credit: 0, pieces: 0, events: byPosting.size },
    perOrder: [...byPosting.entries()].map(([id, r]) => ({ orderId: null, orderNumber: r.number, pieces: r.workers, gross: round(r.employee + r.employer), paid: 0, balance: round(r.employee + r.employer), postingId: id })),
    workforce: {
      isProvision: due.isProvision,
      employee: due.employee,
      employer: due.employer,
      payeeName: due.payeeName,
      workersCovered: due.workers,
      lines: lines.map((l) => ({ id: l.id, posting: l.posting.number, workerCode: l.worker.code, workerName: l.worker.name, wages: l.wages, employeeAmt: l.employeeAmt, employerAmt: l.employerAmt, postedOn: l.posting.postedOn })),
    },
    payments: payments.map(asPayment),
    statement: buildStatement([
      ...[...byPosting.values()].map((r) => ({
        date: r.postedOn,
        type: 'BILL' as const,
        // dayKey reads the LOCAL date. toISOString() would show the day before for a
        // period stored at local midnight anywhere east of UTC.
        description: `${due.code} posted for ${dayKey(r.from)} — ${dayKey(r.to)}`,
        ref: r.number,
        orderNumber: null,
        charge: round(r.employee + r.employer),
        settle: 0,
        detail: `${r.workers} worker(s) · employee ₹${r.employee} + employer ₹${r.employer}`,
      })),
      ...payments.map((p) => ({ date: p.date, type: 'PAYMENT' as const, description: p.note || 'Paid to the authority', ref: p.ref, orderNumber: null, charge: 0, settle: p.amount, detail: null })),
    ]),
  };
}

// --- summary ----------------------------------------------------------------

/** Headline money totals, shared by the summary endpoint and the dashboard. */
async function financeTotals() {
  {
    const [{ orders, entries, rateOf, symbolOf, ourState, basis, invoices }, workforce] = await Promise.all([financeData(), buildWorkforceContext()]);

    let invoicedInr = 0;
    let receivableInr = 0;
    let buyerCreditInr = 0;
    let orderBookInr = 0;
    for (const buyerId of [...new Set(orders.map((o) => o.buyerId))]) {
      for (const pos of buyerPositions(orders, entries, buyerId, rateOf, symbolOf, ourState, basis, invoices)) {
        orderBookInr += pos.orderBook * pos.exchangeRate;
        // Per DOCUMENT, at the rate that document was booked at — not the first order's rate
        // applied to the whole currency. Two USD orders booked at 82 and 84 were being
        // valued as if both were 82, so the dashboard disagreed with /finance/receivables
        // and with the exposure card, which both convert bucket by bucket.
        for (const b of pos.buckets) {
          const orderRate = pos.subjectOf(b).exchangeRate || rateOf(pos.currency);
          invoicedInr += b.gross * orderRate;
          // Clamped exactly as payables are below: one buyer's credit — or a mistyped
          // discount that drove an order negative — must not offset another buyer's
          // genuine debt in the company-wide figure.
          receivableInr += clamp(b.balance) * orderRate;
        }
        // Credit has no order behind it, so it can only be valued at the live rate.
        buyerCreditInr += pos.credit * rateOf(pos.currency);
      }
    }

    const allEvents = orders.flatMap((o) => jobworkEventsForOrder(o as any));
    const jobworkAccrued = round(allEvents.reduce((a, e) => a + e.amount, 0));
    const jobworkPaid = sumOf(entries, 'JOBWORK', 'PAYMENT');
    const materialBilled = sumOf(entries, 'SUPPLIER', 'BILL');
    const materialPaid = sumOf(entries, 'SUPPLIER', 'PAYMENT');

    // Wages are DERIVED now — attendance and board clearances, not typed bills. The
    // unlinked figures are the last of the hand-typed rows, still awaiting migration.
    const wf = workforceTotals(workforce);
    const unlinkedBilled = round(workforce.unlinked.reduce((a, u) => a + u.billed, 0));
    const unlinkedPaid = round(workforce.unlinked.reduce((a, u) => a + u.paid, 0));
    const wagesBilled = round(wf.wagesAccrued + unlinkedBilled);
    const wagesPaid = round(wf.wagesPaid + unlinkedPaid);

    // Overpayment to a party is money on account, not a negative debt.
    const jobworkDue = clamp(jobworkAccrued - jobworkPaid);
    const materialDue = clamp(materialBilled - materialPaid);
    // Clamped per worker inside workforceTotals, so one worker's advance cannot
    // quietly cancel out what is owed to another.
    const wagesDue = round(wf.workerDue + clamp(unlinkedBilled - unlinkedPaid));

    return {
      headcount: wf.headcount,
      contractorCount: wf.contractorCount,
      contractorDue: wf.contractorDue,
      statutoryDue: wf.statutoryDue,
      statutoryProvision: wf.statutoryProvision,
      advanceOutstanding: wf.advanceOutstanding,
      invoicedInr: round(invoicedInr),
      receivedInr: round(invoicedInr - receivableInr),
      receivableInr: round(receivableInr),
      buyerCreditInr: round(buyerCreditInr),
      /** Which question `receivableInr` answers — see AppSetting.receivableBasis. */
      receivableBasis: basis,
      /** Confirmed but not yet billed. Beside the receivable, never inside it. */
      orderBookInr: round(orderBookInr),
      jobworkAccrued,
      jobworkPaid: round(jobworkPaid),
      jobworkDue,
      materialBilled: round(materialBilled),
      materialPaid: round(materialPaid),
      materialDue,
      wagesBilled: round(wagesBilled),
      wagesPaid: round(wagesPaid),
      wagesDue,
      payableInr: round(jobworkDue + materialDue + wagesDue + wf.contractorDue + wf.statutoryDue),
      jobworkEvents: allEvents.length,
    };
  }
}

router.get(
  '/finance/summary',
  asyncHandler(async (_req, res) => {
    res.json(await financeTotals());
  })
);

// --- the parties index ------------------------------------------------------

router.get(
  '/finance/parties',
  asyncHandler(async (_req, res) => {
    const { orders, entries, rateOf, symbolOf, ourState, basis, invoices } = await financeData();
    const out: any[] = [];

    for (const buyerId of [...new Set(orders.map((o) => o.buyerId))]) {
      const positions = buyerPositions(orders, entries, buyerId, rateOf, symbolOf, ourState, basis, invoices);
      const buyer = positions.find((p) => p.orders.length)?.orders[0].buyer;
      if (!buyer) continue;
      out.push({
        partyType: 'BUYER',
        partyId: buyerId,
        name: buyer.name,
        code: buyer.code,
        // Bucket by bucket, at each document's own rate — see financeTotals().
        owesUs: round(
          positions.reduce((a, p) => a + p.buckets.reduce((b, k) => b + Math.max(k.balance, 0) * (p.subjectOf(k).exchangeRate || rateOf(p.currency)), 0), 0)
        ),
        weOwe: 0,
        credit: round(positions.reduce((a, p) => a + p.credit * rateOf(p.currency), 0)),
        orders: positions.reduce((a, p) => a + p.orders.length, 0),
      });
    }

    const allEvents = orders.flatMap((o) => jobworkEventsForOrder(o as any));
    for (const vendorId of [...new Set(allEvents.map((e) => e.vendorId))]) {
      const pos = jobworkPosition(orders, entries, vendorId);
      const accrued = round(pos.buckets.reduce((a, b) => a + b.gross, 0));
      const paid = round(pos.buckets.reduce((a, b) => a + b.paid, 0));
      out.push({
        partyType: 'JOBWORK',
        partyId: vendorId,
        name: allEvents.find((e) => e.vendorId === vendorId)!.vendorName,
        code: null,
        owesUs: 0,
        weOwe: round(accrued - paid),
        credit: pos.result.credit,
        orders: pos.perOrder.length,
      });
    }

    const billed = entries.filter((e) => e.partyType === 'SUPPLIER');
    for (const key of [...new Set(billed.map((e) => `${e.partyType}:${e.supplierId ?? e.partyName}`))]) {
      const [partyType, idOrName] = key.split(':') as ['SUPPLIER', string];
      const supplierId = /^\d+$/.test(idOrName) ? Number(idOrName) : null;
      const pos = billedPosition(entries, partyType, supplierId, supplierId == null ? idOrName : undefined);
      const accrued = round(pos.buckets.reduce((a, b) => a + b.gross, 0));
      const paid = round(pos.buckets.reduce((a, b) => a + b.paid, 0));
      out.push({
        partyType,
        partyId: supplierId,
        name: supplierId != null ? pos.bills[0]?.supplier?.name ?? pos.payments[0]?.partyName ?? `#${supplierId}` : idOrName,
        code: pos.bills[0]?.supplier?.code ?? null,
        owesUs: 0,
        weOwe: round(accrued - paid),
        credit: pos.result.credit,
        orders: pos.bills.length,
      });
    }

    for (const row of workforcePayables(await buildWorkforceContext())) {
      out.push({
        partyType: row.partyType,
        partyId: row.partyId,
        name: row.partyName,
        code: row.code ?? null,
        // A worker carrying an advance owes the factory, which is the one case where
        // a payable party can appear on the receivable side.
        owesUs: round(Math.max(-row.balance, 0)),
        weOwe: round(Math.max(row.balance, 0)),
        credit: 0,
        orders: row.events,
      });
    }

    res.json(out.sort((a, b) => b.weOwe + b.owesUs - (a.weOwe + a.owesUs)));
  })
);

// --- one party, in full -----------------------------------------------------

/**
 * Everything about one party: a running statement, the per-order breakdown, the
 * detail behind every charge, and how each payment was spread.
 */
router.get(
  '/finance/statement',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        partyType: z.enum(['BUYER', 'JOBWORK', 'SUPPLIER', 'WORKER', 'CONTRACTOR', 'STATUTORY']),
        partyId: z.coerce.number().int().optional(),
        partyName: z.string().optional(),
      })
      .parse(req.query);
    const { orders, entries, rateOf, symbolOf, ourState, basis, invoices } = await financeData();

    // A worker named by id is derived from attendance and the board. One named only
    // by a typed name is pre-Manforce history and still reads from the ledger below.
    if ((q.partyType === 'WORKER' && q.partyId) || q.partyType === 'CONTRACTOR' || q.partyType === 'STATUTORY') {
      return res.json(await workforceStatementResponse(q.partyType, q.partyId!, entries));
    }

    if (q.partyType === 'BUYER') {
      if (!q.partyId) throw new ApiError(400, 'Which buyer?');
      const positions = buyerPositions(orders, entries, q.partyId, rateOf, symbolOf, ourState, basis, invoices);
      const buyer = positions.find((p) => p.orders.length)?.orders[0].buyer ?? (await prisma.buyer.findUnique({ where: { id: q.partyId } }));
      if (!buyer) throw new ApiError(404, 'Buyer not found.');

      const currencies = positions.map((pos) => ({
        currency: pos.currency,
        symbol: pos.symbol,
        basis: pos.basis,
        invoiced: pos.invoiced,
        received: pos.received,
        balance: pos.balance,
        credit: pos.credit,
        /** Order book sits below the closing balance as a memo, never inside it. */
        orderBook: pos.orderBook,
        orders: pos.buckets.map((b) => {
          const s = pos.subjectOf(b);
          return { docKind: s.kind, orderId: s.orderId, orderNumber: s.number, date: s.date, status: s.status, gross: b.gross, paid: b.paid, balance: b.balance };
        }),
        receipts: pos.receipts,
        statement: buildStatement([
          ...pos.buckets.map((b) => {
            const s = pos.subjectOf(b);
            const order = s.orderId != null ? pos.orders.find((o) => o.id === s.orderId) : undefined;
            const items = order ? `${order.lines.length} item(s), ${order.lines.reduce((a, l) => a + l.qty, 0)} pcs` : null;
            return {
              date: s.date,
              type: 'INVOICE' as const,
              description: s.kind === 'INVOICE' ? `Invoice ${s.number}` : `Order ${s.number}`,
              ref: s.number,
              orderNumber: s.orderNumber,
              charge: b.gross,
              settle: 0,
              detail: items,
            };
          }),
          // A statement only settles what was actually applied; money with nothing
          // left to settle is credit on account, not a reduction of a debt.
          ...pos.receipts.map((r) => {
            const applied = round(r.allocations.reduce((a, x) => a + x.amount, 0));
            return {
              date: r.date,
              type: 'RECEIPT' as const,
              description: r.allocations.length ? `Receipt applied to ${r.allocations.map((a) => a.label).join(', ')}` : 'Receipt held on account',
              ref: r.ref,
              orderNumber: r.allocations[0]?.label ?? null,
              charge: 0,
              settle: applied,
              detail: r.unallocated > 0 ? `Received ${r.amount.toFixed(2)} · ${r.unallocated.toFixed(2)} held on account` : null,
            };
          }),
        ]),
      }));

      return res.json({ party: { partyType: 'BUYER', partyId: buyer.id, name: buyer.name, code: (buyer as any).code, email: (buyer as any).email ?? null, phone: (buyer as any).phone ?? null }, currencies });
    }

    if (q.partyType === 'JOBWORK') {
      if (!q.partyId) throw new ApiError(400, 'Which vendor?');
      const vendor = await prisma.supplier.findUnique({ where: { id: q.partyId } });
      if (!vendor) throw new ApiError(404, 'Vendor not found.');
      const pos = jobworkPosition(orders, entries, q.partyId);
      const accrued = round(pos.buckets.reduce((a, b) => a + b.gross, 0));
      const paid = round(pos.buckets.reduce((a, b) => a + b.paid, 0));

      return res.json({
        party: { partyType: 'JOBWORK', partyId: vendor.id, name: vendor.name, code: vendor.code, phone: vendor.phone, gstNo: vendor.gstNo, paymentTerms: vendor.paymentTerms },
        currency: 'INR',
        summary: { accrued, paid, balance: round(accrued - paid), credit: pos.result.credit, pieces: pos.events.reduce((a, e) => a + e.pieces, 0), events: pos.events.length },
        perOrder: pos.buckets.map((b) => {
          const row = pos.perOrder.find((r) => r.orderId === b.orderId)!;
          return { orderId: b.orderId, orderNumber: b.label, pieces: row.pieces, gross: b.gross, paid: b.paid, balance: b.balance };
        }),
        events: pos.events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
        payments: pos.payments,
        statement: buildStatement([
          ...pos.events.map((e) => ({
            date: e.date,
            type: 'ACCRUAL' as const,
            description: `${e.pieces} pcs cleared ${e.stage} — ${e.productCode}`,
            ref: e.orderNumber,
            orderNumber: e.orderNumber,
            charge: e.amount,
            settle: 0,
            detail: `${e.pieces} × ₹${e.rate}/pc${e.rework ? ' · re-done after rejection' : ''}${e.note ? ` · ${e.note}` : ''}`,
          })),
          ...pos.payments.map((p) => {
            const applied = round(p.allocations.reduce((a, x) => a + x.amount, 0));
            return {
              date: p.date,
              type: 'PAYMENT' as const,
              description: p.allocations.length ? `Payment applied to ${p.allocations.map((a) => a.label).join(', ')}` : 'Paid in advance — nothing outstanding',
              ref: p.ref,
              orderNumber: p.allocations[0]?.label ?? null,
              charge: 0,
              settle: applied,
              detail: p.unallocated > 0 ? `Paid ₹${p.amount.toFixed(2)} · ₹${p.unallocated.toFixed(2)} sits in advance` : null,
            };
          }),
        ]),
      });
    }

    // SUPPLIER / WORKER
    const supplierId = q.partyId ?? null;
    const pos = billedPosition(entries, q.partyType, supplierId, supplierId == null ? q.partyName : undefined);
    const supplier = supplierId != null ? await prisma.supplier.findUnique({ where: { id: supplierId } }) : null;
    const accrued = round(pos.buckets.reduce((a, b) => a + b.gross, 0));
    const paid = round(pos.buckets.reduce((a, b) => a + b.paid, 0));

    // Deliveries recorded in stock that nobody has billed yet.
    const receipts =
      q.partyType === 'SUPPLIER' && supplierId != null
        ? await prisma.stockTxn.findMany({
            where: { supplierId, type: 'IN' },
            include: { rawItem: { select: { code: true, name: true, unit: true } }, bill: { select: { id: true, amount: true, ref: true } } },
            orderBy: [{ date: 'desc' }, { id: 'desc' }],
          })
        : [];

    res.json({
      party: {
        partyType: q.partyType,
        partyId: supplierId,
        name: supplier?.name ?? q.partyName ?? '—',
        code: supplier?.code ?? null,
        phone: supplier?.phone ?? null,
        gstNo: supplier?.gstNo ?? null,
        paymentTerms: supplier?.paymentTerms ?? null,
      },
      currency: 'INR',
      summary: { accrued, paid, balance: round(accrued - paid), credit: pos.result.credit, pieces: 0, events: pos.bills.length },
      perOrder: pos.buckets.map((b) => ({ orderId: b.orderId, orderNumber: b.label, pieces: 0, gross: b.gross, paid: b.paid, balance: b.balance })),
      bills: pos.bills.map((b) => ({
        id: b.id,
        date: b.date,
        amount: b.amount,
        ref: b.ref,
        note: b.note,
        orderNumber: b.order?.number ?? null,
        stockTxn: b.stockTxn ? { id: b.stockTxn.id, item: `${b.stockTxn.rawItem.code} — ${b.stockTxn.rawItem.name}`, qty: b.stockTxn.qty, unit: b.stockTxn.rawItem.unit, rate: b.stockTxn.rate } : null,
      })),
      payments: pos.payments,
      supplied: receipts.map((r) => ({
        id: r.id,
        date: r.date,
        item: `${r.rawItem.code} — ${r.rawItem.name}`,
        qty: r.qty,
        unit: r.rawItem.unit,
        rate: r.rate,
        value: round(r.qty * r.rate),
        note: r.note,
        billed: !!r.bill,
        billId: r.bill?.id ?? null,
      })),
      unbilledValue: round(receipts.filter((r) => !r.bill).reduce((a, r) => a + r.qty * r.rate, 0)),
      statement: buildStatement([
        ...pos.bills.map((b) => ({
          date: b.date,
          type: 'BILL' as const,
          description: b.stockTxn ? `Bill — ${b.stockTxn.rawItem.name} ${b.stockTxn.qty} ${b.stockTxn.rawItem.unit}` : b.note || 'Bill',
          ref: b.ref,
          orderNumber: b.order?.number ?? null,
          charge: b.amount,
          settle: 0,
          detail: b.stockTxn ? `${b.stockTxn.qty} × ₹${b.stockTxn.rate}` : null,
        })),
        ...pos.payments.map((p) => {
          const applied = round(p.allocations.reduce((a, x) => a + x.amount, 0));
          return {
            date: p.date,
            type: 'PAYMENT' as const,
            description: p.allocations.length ? `Payment applied to ${p.allocations.map((a) => a.label).join(', ')}` : 'Paid in advance — nothing outstanding',
            ref: p.ref,
            orderNumber: null,
            charge: 0,
            settle: applied,
            detail: p.unallocated > 0 ? `Paid ₹${p.amount.toFixed(2)} · ₹${p.unallocated.toFixed(2)} sits in advance` : null,
          };
        }),
      ]),
    });
  })
);

router.get(
  '/payments',
  asyncHandler(async (req, res) => {
    const where: any = {};
    if (req.query.partyType) where.partyType = req.query.partyType;
    if (req.query.supplierId) where.supplierId = Number(req.query.supplierId);
    if (req.query.buyerId) where.buyerId = Number(req.query.buyerId);
    if (req.query.workerId) where.workerId = Number(req.query.workerId);
    if (req.query.contractorId) where.contractorId = Number(req.query.contractorId);
    if (req.query.orderId) where.orderId = Number(req.query.orderId);
    // Trash rows are read through /payments/trash, never the live list.
    where.deletedAt = null;
    res.json(
      await prisma.ledgerEntry.findMany({
        where,
        include: {
          supplier: { select: { name: true } },
          buyer: { select: { name: true } },
          order: { select: { id: true, number: true } },
          worker: { select: { id: true, code: true, name: true } },
          contractor: { select: { id: true, code: true, name: true } },
          component: { select: { id: true, code: true, name: true } },
        },
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        take: 300,
      })
    );
  })
);

const ledgerSchema = z.object({
  partyType: z.enum(['SUPPLIER', 'JOBWORK', 'BUYER', 'WORKER', 'CONTRACTOR', 'STATUTORY']),
  supplierId: z.number().int().nullable().optional(),
  buyerId: z.number().int().nullable().optional(),
  workerId: z.number().int().nullable().optional(),
  contractorId: z.number().int().nullable().optional(),
  statutoryComponentId: z.number().int().nullable().optional(),
  orderId: z.number().int().nullable().optional(),
  stockTxnId: z.number().int().nullable().optional(),
  partyName: z.string().min(1),
  kind: z.enum(['BILL', 'PAYMENT']),
  amount: z.number().positive(),
  currency: z.string().optional().default('INR'),
  date: z.string().datetime().optional(),
  ref: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

router.post(
  '/payments',
  canManage,
  asyncHandler(async (req, res) => {
    const data = ledgerSchema.parse(req.body);

    // Money aimed at an order in the trash would be excluded from that order's FIFO
    // buckets and quietly become credit on account — so refuse it instead.
    if (data.orderId) await assertLive('order', [data.orderId], 'a payment');

    // Amounts the system already derives must not also be typed in, or they double up.
    if (data.partyType === 'BUYER' && data.kind === 'BILL') {
      throw new ApiError(400, 'What a buyer owes comes from their order value — record only the receipts here.');
    }
    if (data.partyType === 'JOBWORK' && data.kind === 'BILL') {
      throw new ApiError(400, 'Jobwork owed is calculated from the pieces each vendor cleared — record only the payments here.');
    }
    if (data.partyType === 'WORKER' && data.kind === 'BILL') {
      throw new ApiError(400, 'Wages are calculated from attendance and the pieces each worker cleared — record only the payments here.');
    }
    if (data.partyType === 'CONTRACTOR' && data.kind === 'BILL') {
      throw new ApiError(400, "A contractor's earnings are calculated from their gang's work — record only the payments here.");
    }
    if (data.partyType === 'STATUTORY' && data.kind === 'BILL') {
      throw new ApiError(400, 'Statutory liability is created by posting it in Manforce — record only the payments here.');
    }
    if (data.partyType === 'BUYER' && !data.buyerId) throw new ApiError(400, 'Which buyer is this receipt from?');

    // The party must exist and match the row's type, or the entry lands in a ledger
    // nobody is looking at.
    if (data.partyType === 'BUYER') {
      if (!(await prisma.buyer.findUnique({ where: { id: data.buyerId! } }))) throw new ApiError(404, 'Buyer not found.');
      if (data.supplierId) throw new ApiError(400, 'A buyer receipt cannot also name a supplier.');
    } else if (data.partyType === 'WORKER') {
      if (data.supplierId || data.buyerId) throw new ApiError(400, 'Wages are recorded against a worker, not a supplier or buyer.');
      if (data.workerId) {
        const worker = await prisma.worker.findUnique({ where: { id: data.workerId }, include: { contractor: { select: { name: true } } } });
        if (!worker) throw new ApiError(404, 'Worker not found.');
        // Paying a gang member directly would leave the contractor's balance saying
        // the money is still owed, so the two would disagree about the same wages.
        if (worker.contractorId) throw new ApiError(400, `${worker.name} is in ${worker.contractor?.name ?? 'a contractor'}'s gang — pay the contractor, not the worker.`);
      }
    } else if (data.partyType === 'CONTRACTOR') {
      if (data.supplierId || data.buyerId) throw new ApiError(400, 'A contractor payment cannot also name a supplier or buyer.');
      if (!data.contractorId) throw new ApiError(400, 'Which contractor is this payment for?');
      if (!(await prisma.contractor.findUnique({ where: { id: data.contractorId } }))) throw new ApiError(404, 'Contractor not found.');
    } else if (data.partyType === 'STATUTORY') {
      if (!data.statutoryComponentId) throw new ApiError(400, 'Which levy does this payment settle?');
      const component = await prisma.statutoryComponent.findUnique({ where: { id: data.statutoryComponentId } });
      if (!component) throw new ApiError(404, 'Statutory component not found.');
      if (component.isProvision) throw new ApiError(400, `${component.code} is a provision, not a payable — it becomes one when it is declared.`);
    } else {
      if (!data.supplierId) throw new ApiError(400, `Which ${data.partyType === 'JOBWORK' ? 'jobwork vendor' : 'supplier'} is this for?`);
      const s = await prisma.supplier.findUnique({ where: { id: data.supplierId } });
      if (!s) throw new ApiError(404, 'Supplier not found.');
      if (data.partyType === 'JOBWORK' && s.type === 'MATERIAL') throw new ApiError(400, `${s.name} is a material supplier, not a jobwork vendor.`);
      if (data.partyType === 'SUPPLIER' && s.type === 'JOBWORK') throw new ApiError(400, `${s.name} is a jobwork vendor — record their work under Jobwork.`);
      if (data.buyerId) throw new ApiError(400, 'A supplier entry cannot also name a buyer.');
    }

    // Everything except a buyer receipt is settled in rupees. Accepting another
    // currency here would silently mix units inside the payable totals.
    let currency = data.partyType === 'BUYER' ? data.currency ?? 'INR' : 'INR';
    if (data.partyType === 'BUYER') {
      // A receipt settles orders in its own currency, so pin it to one. The order
      // named here is a starting point only — a surplus rolls on to older orders.
      const buyerId = data.buyerId!;
      if (data.orderId) {
        const order = await prisma.order.findUnique({ where: { id: data.orderId }, include: { currency: true } });
        if (!order) throw new ApiError(404, 'Order not found.');
        if (order.buyerId !== buyerId) throw new ApiError(400, 'That order belongs to a different buyer.');
        currency = order.currency?.code ?? 'INR';
      } else {
        const latest = await prisma.order.findFirst({ where: { buyerId, ...LIVE_ORDER }, include: { currency: true }, orderBy: [{ orderDate: 'desc' }, { id: 'desc' }] });
        if (!latest) throw new ApiError(400, 'This buyer has no live order for the receipt to settle.');
        currency = latest.currency?.code ?? 'INR';
      }
    }

    if (data.stockTxnId) {
      const txn = await prisma.stockTxn.findUnique({ where: { id: data.stockTxnId }, include: { bill: true } });
      if (!txn) throw new ApiError(404, 'Stock receipt not found.');
      if (txn.bill) throw new ApiError(409, 'That stock receipt is already billed.');
      if (data.kind !== 'BILL') throw new ApiError(400, 'A stock receipt is billed, not paid — record the payment separately.');
    }

    res.status(201).json(
      await prisma.ledgerEntry.create({
        data: {
          partyType: data.partyType,
          supplierId: data.supplierId ?? null,
          buyerId: data.buyerId ?? null,
          workerId: data.workerId ?? null,
          contractorId: data.contractorId ?? null,
          statutoryComponentId: data.statutoryComponentId ?? null,
          orderId: data.orderId ?? null,
          stockTxnId: data.stockTxnId ?? null,
          partyName: data.partyName,
          kind: data.kind,
          amount: data.amount,
          currency,
          date: data.date ? new Date(data.date) : new Date(),
          ref: data.ref ?? null,
          note: data.note ?? null,
          createdById: req.user!.sub,
        },
      })
    );
  })
);

router.get(
  '/payments/trash',
  canManage,
  asyncHandler(async (_req, res) => {
    res.json(
      await prisma.ledgerEntry.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, partyType: true, partyName: true, kind: true, amount: true, currency: true, date: true, ref: true, deletedAt: true },
        orderBy: { deletedAt: 'desc' },
      })
    );
  })
);

router.delete(
  '/payments/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const entry = await prisma.ledgerEntry.findUnique({ where: { id }, include: { advance: { select: { id: true } } } });
    if (!entry) throw new ApiError(404, 'Entry not found.');
    // The cash and the recovery terms are two halves of one advance; removing only
    // the cash would leave an advance being recovered that was never handed over.
    if (entry.advance) throw new ApiError(409, 'This payment is an advance — delete the advance itself in Manforce and the payment goes with it.');
    if (entry.deletedAt) throw new ApiError(409, 'That entry is already in the trash.');
    // Soft: the row survives so a mis-keyed receipt can be brought back, and it leaves
    // every allocation the moment it is hidden because the query excludes it.
    const deletedAt = await softDelete('ledgerEntry', id);
    res.json({ deleted: true, deletedAt, note: 'Moved to the trash. It has left every balance and can be restored.' });
  })
);


router.post(
  '/payments/:id/restore',
  canManage,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.ledgerEntry.findUnique({ where: { id }, select: { deletedAt: true } });
    if (!existing) throw new ApiError(404, 'Entry not found.');
    if (!existing.deletedAt) throw new ApiError(409, 'That entry is not in the trash.');
    await restore('ledgerEntry', id);
    res.json({ restored: true });
  })
);

router.delete(
  '/payments/:id/permanent',
  requireRole('Admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.ledgerEntry.findUnique({ where: { id }, select: { deletedAt: true } });
    if (!existing) throw new ApiError(404, 'Entry not found.');
    if (!existing.deletedAt) throw new ApiError(409, 'That entry is still live. Delete it first.');
    await prisma.ledgerEntry.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

router.get(
  '/ops/dashboard',
  asyncHandler(async (_req, res) => {
    const [openOrders, awaitingDecision, recentProformas, rawItems, stockGrouped, liveLines, financials] = await Promise.all([
      prisma.order.findMany({ where: { ...notDeleted, status: { notIn: ['Shipped', 'Closed', 'Cancelled'] } }, select: { id: true } }),
      prisma.proforma.count({ where: { ...notDeleted, status: 'Sent' } }),
      prisma.proforma.findMany({ where: notDeleted, include: { buyer: { select: { name: true } } }, orderBy: [{ date: 'desc' }, { id: 'desc' }], take: 6 }),
      prisma.rawItem.findMany(),
      prisma.stockTxn.groupBy({ by: ['rawItemId', 'type'], _sum: { qty: true } }),
      prisma.orderLine.findMany({
        where: { order: LIVE_ORDER },
        include: { stages: { include: { vendor: { select: { id: true, name: true } } }, orderBy: { sortOrder: 'asc' } }, moves: true },
      }),
      // One source of truth for the money, shared with the Payments page.
      financeTotals(),
    ]);

    let inProduction = 0;
    let atVendors = 0;
    let pendingPieces = 0;
    let finishedPieces = 0;
    const vendorLoad = new Map<number, { vendorId: number; vendorName: string; pieces: number }>();
    for (const l of liveLines) {
      const board = buildBoard(l.qty, l.stages as any, l.moves as any);
      inProduction += board.wip;
      pendingPieces += board.pending;
      finishedPieces += board.done;
      for (const s of board.stages) {
        if (s.vendorId && s.at > 0) {
          atVendors += s.at;
          const row = vendorLoad.get(s.vendorId) ?? { vendorId: s.vendorId, vendorName: s.vendor?.name ?? `Vendor #${s.vendorId}`, pieces: 0 };
          row.pieces += s.at;
          vendorLoad.set(s.vendorId, row);
        }
      }
    }

    const bal: Record<number, { i: number; o: number }> = {};
    for (const g of stockGrouped) {
      bal[g.rawItemId] = bal[g.rawItemId] || { i: 0, o: 0 };
      if (g.type === 'IN') bal[g.rawItemId].i = g._sum.qty || 0;
      else bal[g.rawItemId].o = g._sum.qty || 0;
    }
    const lowStock = rawItems
      .map((it) => ({ id: it.id, name: it.name, unit: it.unit, balance: round(it.openingQty + (bal[it.id]?.i || 0) - (bal[it.id]?.o || 0), 3), reorderLevel: it.reorderLevel }))
      .filter((it) => it.balance <= it.reorderLevel);

    res.json({
      pendingOrders: openOrders.length,
      awaitingDecision,
      inProduction,
      atVendors,
      pendingPieces,
      finishedPieces,
      jobworkAccrued: financials.jobworkAccrued,
      receivable: financials.receivableInr,
      payable: financials.payableInr,
      buyerCredit: financials.buyerCreditInr,
      headcount: financials.headcount,
      wagesDue: financials.wagesDue,
      contractorDue: financials.contractorDue,
      statutoryDue: financials.statutoryDue,
      vendorLoad: Array.from(vendorLoad.values()).sort((a, b) => b.pieces - a.pieces),
      recentProformas: recentProformas.map((p) => ({ id: p.id, number: p.number, buyer: p.buyer.name, status: p.status, date: p.date })),
      lowStock,
    });
  })
);

export default router;
