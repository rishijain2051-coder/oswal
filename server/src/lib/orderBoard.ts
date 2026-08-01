/**
 * Shared order-board plumbing: how an order is loaded, serialized with its live
 * production board and money position, and how a line's stage snapshot is created.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db';
import { ApiError } from './http';
import { round } from './costing';
import { buildBoard, impliedOrderStatus, rollUp, type LineBoard, type MoveRow, type StageRow } from './production';
import {
  buildFinanceContext,
  jobworkEvents,
  type FinanceContext,
  type FinanceInvoiceLike,
  type ReceivableBasis,
} from './finance';
import { documentTotalsOf, lineGross, lineNet } from './pricing';
import { companyState } from './company';
import { deliveryStatus, estimateCompletion } from './scheduling';

type Tx = Prisma.TransactionClient | PrismaClient;

export const orderInclude = {
  buyer: true,
  currency: true,
  /** Part of what the order is worth, so the pricing engine must be able to see them. */
  charges: { orderBy: { sortOrder: 'asc' as const } },
  /** PO copies, shipping and customs paperwork hanging off this order. */
  attachments: { orderBy: [{ createdAt: 'desc' as const }] },
  proforma: { select: { id: true, number: true, status: true } },
  ledger: {
    orderBy: [{ date: 'desc' as const }, { id: 'desc' as const }],
    select: { id: true, partyType: true, kind: true, amount: true, currency: true, date: true, ref: true, note: true, partyName: true, supplierId: true, buyerId: true },
  },
  lines: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      product: {
        select: {
          id: true,
          factoryCode: true,
          name: true,
          stageLineId: true,
          unit: { select: { code: true } },
          images: { where: { isPrimary: true }, take: 1, select: { url: true } },
        },
      },
      stageLine: { select: { id: true, code: true, name: true } },
      sheet: { select: { id: true, number: true } },
      stages: { orderBy: { sortOrder: 'asc' as const }, include: { vendor: { select: { id: true, name: true } } } },
      /** The scheduling overlay: when this line SHOULD be at each stage. */
      schedule: { include: { stages: true } },
      moves: {
        orderBy: [{ date: 'desc' as const }, { id: 'desc' as const }],
        include: {
          photos: { orderBy: { sortOrder: 'asc' as const }, select: { id: true, url: true, caption: true } },
          workers: { include: { worker: { select: { id: true, code: true, name: true } } } },
        },
      },
    },
  },
};

export type OrderWithBoard = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

/** Live board for one loaded order line. */
export function boardForLine(line: { qty: number; stages: StageRow[]; moves: MoveRow[] }): LineBoard {
  return buildBoard(line.qty, line.stages as StageRow[], line.moves as MoveRow[]);
}

/** Attach boards, totals and the money position to an order payload for the API. */
export function serializeOrder(o: OrderWithBoard, ctx: FinanceContext) {
  const lines = o.lines.map((l) => {
    const board = boardForLine(l as any);
    const vendors = board.stages.filter((s) => s.vendorId).map((s) => ({ id: s.vendorId!, name: s.vendor?.name ?? `Vendor #${s.vendorId}`, stage: s.name, sortOrder: s.sortOrder }));
    const distinctVendors = Array.from(new Map(vendors.map((v) => [v.id, { id: v.id, name: v.name }])).values());
    return {
      ...l,
      product: { ...l.product, primaryImage: l.product.images?.[0]?.url ?? null, images: undefined },
      /** Net of this line's own discount — what it actually contributes to the total. */
      amount: lineNet(l as never),
      grossAmount: lineGross(l as never),
      needsStageLine: l.stages.length === 0,
      /** Where the work happens: purely derived from who owns each stage. */
      outsourcedStages: vendors,
      vendors: distinctVendors,
      mode: distinctVendors.length === 0 ? 'INHOUSE' : vendors.length === board.stages.length ? 'OUTSOURCED' : 'MIXED',
      board,
      /**
       * Planned versus actual. Derived on every read from the board and today's date, so
       * it can never be stale — and it produces no quantities, so the board's own
       * invariant is untouched.
       */
      schedule: l.schedule
        ? estimateCompletion(
            l.qty,
            board.stages.map((st) => {
              const planned = l.schedule!.stages.find((x) => x.orderLineStageId === st.id);
              return {
                orderLineStageId: st.id,
                name: st.name,
                sortOrder: st.sortOrder,
                estimatedStart: planned?.estimatedStart ?? null,
                estimatedEnd: planned?.estimatedEnd ?? null,
                at: st.at,
                cleared: st.cleared,
              };
            }),
            new Date(),
            // The board's own finished count, so this and `delivery` cannot disagree.
            board.done
          )
        : null,
      history: l.moves.map((m) => ({
        id: m.id,
        kind: m.kind,
        fromStageId: m.fromStageId,
        toStageId: m.toStageId,
        fromStage: m.fromStageId != null ? l.stages.find((s) => s.id === m.fromStageId)?.name ?? null : null,
        toStage: m.toStageId != null ? l.stages.find((s) => s.id === m.toStageId)?.name ?? null : null,
        qty: m.qty,
        date: m.date,
        note: m.note,
        photos: m.photos,
        /** Who did this piece of work, and how much of it each of them did. */
        workers: m.workers.map((w) => ({ workerId: w.workerId, code: w.worker.code, name: w.worker.name, pieces: w.pieces })),
        /** In-house labour this movement earned, at the stage's current rate. */
        labourValue: round(m.workers.reduce((a, w) => a + w.pieces, 0) * (l.stages.find((s) => s.id === m.fromStageId)?.labourRate ?? 0)),
      })),
      moves: undefined,
    };
  });

  const summary = rollUp(lines.map((l) => l.board));

  // Jobwork accrued so far, merged across every line of the order.
  const jobwork = new Map<number, { vendorId: number; vendorName: string; pieces: number; amount: number; stages: string[] }>();
  for (const l of lines) {
    for (const j of l.board.jobwork) {
      const row = jobwork.get(j.vendorId) ?? { vendorId: j.vendorId, vendorName: j.vendorName, pieces: 0, amount: 0, stages: [] };
      row.pieces += j.pieces;
      row.amount = round(row.amount + j.amount);
      for (const s of j.stages) if (!row.stages.includes(s)) row.stages.push(s);
      jobwork.set(j.vendorId, row);
    }
  }
  const jobworkList = Array.from(jobwork.values());

  // The one pricing engine, so this agrees with the FIFO buckets behind receivables and
  // with the dashboard. `total` stays the grand total — what the buyer owes — because
  // every existing caller reads it as exactly that.
  const totals = documentTotalsOf(o as never, ctx.companyState);
  const total = totals.grandTotal;
  return {
    ...o,
    lines,
    /** Will this make its date? Derived from the board's progress, never stored. */
    delivery: deliveryStatus({
      status: o.status,
      deliveryDate: o.deliveryDate,
      expectedDelivery: o.expectedDelivery,
      qty: summary.ordered,
      done: summary.done,
    }),
    total,
    /** Subtotal, charges, and the CGST/SGST/IGST breakdown behind `total`. */
    totals,
    summary,
    jobwork: jobworkList,
    money: orderMoney(o, total, ctx),
  };
}

/**
 * Build the shared money context for a set of orders. Loads every order of the
 * buyers involved plus the whole ledger, because a payment on one order can settle
 * another — you cannot work out one order's position in isolation.
 */
export async function financeContextFor(orders: { buyerId: number }[]): Promise<FinanceContext> {
  const buyerIds = [...new Set(orders.map((o) => o.buyerId))];
  const [related, entries, ourState, basis] = await Promise.all([
    prisma.order.findMany({
      // Soft-deleted orders leave the money picture exactly as cancelled ones do, and
      // for the same reason: the query excludes them, the pure functions stay ignorant.
      where: { deletedAt: null, OR: [{ buyerId: { in: buyerIds } }, { ledger: { some: {} } }] },
      select: {
        id: true,
        number: true,
        buyerId: true,
        status: true,
        orderDate: true,
        exchangeRate: true,
        currency: { select: { code: true, symbol: true } },
        // What the order is WORTH needs the discounts, the tax rates, the charges and
        // the buyer's market — a narrower select here would feed the pricing engine
        // undefined and quietly under-bill every domestic order.
        buyer: { select: { market: true, state: true } },
        // The snapshot is what prices the document; the buyer is only the fallback.
        taxMarket: true,
        taxBuyerState: true,
        taxCompanyState: true,
        charges: { orderBy: { sortOrder: 'asc' as const } },
        lines: {
          select: {
            id: true,
            qty: true,
            unitPrice: true,
            discountPct: true,
            discountAmt: true,
            gstRatePct: true,
            stages: { include: { vendor: { select: { id: true, name: true } } }, orderBy: { sortOrder: 'asc' } },
            moves: true,
            product: { select: { factoryCode: true, name: true } },
          },
        },
      },
    }),
    // Receipts aimed at a trashed order leave with it, exactly as in `financeData` — or
    // FIFO would re-spread that money onto the buyer's other orders.
    prisma.ledgerEntry.findMany({
      where: { deletedAt: null, OR: [{ orderId: null }, { order: { deletedAt: null } }] },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    }),
    companyState(),
    receivableBasis(),
  ]);

  /**
   * Invoices are loaded under BOTH bases.
   *
   * They used to be fetched only under INVOICE, on the reasoning that under ORDER they
   * "change no figure" — which was true of allocation and false of everything else. They also
   * feed `ctx.invoicedValue`, which `orderMoney` reports as `billed`: how much of an order's
   * value has actually gone onto an invoice. Skipping the load did not make that figure
   * cheap, it made it permanently ZERO, on the default setting, for every order in the app.
   *
   * Allocation is unaffected: `buildFinanceContext` only lets invoices widen the buyer set
   * under INVOICE, precisely so this load cannot move a balance.
   */
  const invoices = await loadFinanceInvoices(buyerIds);

  // Jobwork accrued per vendor per order, straight off each board.
  const jobwork = new Map<number, Map<number, number>>();
  for (const o of related) {
    for (const l of o.lines) {
      for (const e of jobworkEvents({ id: o.id, number: o.number }, l as never)) {
        const perOrder = jobwork.get(e.vendorId) ?? new Map<number, number>();
        perOrder.set(o.id, round((perOrder.get(o.id) ?? 0) + e.amount));
        jobwork.set(e.vendorId, perOrder);
      }
    }
  }
  return buildFinanceContext(related as never, entries as never, jobwork, ourState, { basis, invoices });
}

/**
 * The Admin's answer to "when does a buyer start owing us money?".
 *
 * Read through here rather than inline, so there is one place that decides what an absent
 * or unrecognised value means: ORDER, which is how the app has always worked.
 */
export async function receivableBasis(): Promise<ReceivableBasis> {
  const s = await prisma.appSetting.findUnique({ where: { id: 1 }, select: { receivableBasis: true } });
  return s?.receivableBasis === 'INVOICE' ? 'INVOICE' : 'ORDER';
}

/**
 * Live invoices for a set of buyers, shaped for the money engine.
 *
 * `orderId` is resolved onto each line from its order line, because that is what lets a
 * receipt against a multi-order invoice be attributed back to the orders it covers.
 */
export async function loadFinanceInvoices(buyerIds: number[]): Promise<FinanceInvoiceLike[]> {
  const rows = await prisma.invoice.findMany({
    // Same rule as orders: a trashed invoice leaves the money picture the way a cancelled
    // one does, because the query excludes it.
    where: { deletedAt: null, buyerId: { in: buyerIds } },
    select: {
      id: true,
      number: true,
      buyerId: true,
      status: true,
      invoiceDate: true,
      exchangeRate: true,
      currency: { select: { code: true, symbol: true } },
      buyer: { select: { market: true, state: true, name: true, code: true } },
      taxMarket: true,
      taxBuyerState: true,
      taxCompanyState: true,
      charges: { orderBy: { sortOrder: 'asc' as const } },
      lines: {
        select: {
          qty: true,
          unitPrice: true,
          discountPct: true,
          discountAmt: true,
          gstRatePct: true,
          orderLine: { select: { orderId: true } },
        },
      },
    },
  });
  return rows.map((i) => ({
    ...i,
    lines: i.lines.map((l) => ({
      qty: l.qty,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct,
      discountAmt: l.discountAmt,
      gstRatePct: l.gstRatePct,
      orderId: l.orderLine?.orderId ?? null,
    })),
  }));
}

/**
 * The money position of one order. Every figure comes from the shared finance
 * context, which allocates payments FIFO across everything outstanding — so a
 * receipt that rolled onto another order shows the same number here as it does on
 * the Payments page. Never recompute this from `order.ledger` alone: rows booked to
 * an order are only where a payment was *aimed*, not where it landed.
 */
export function orderMoney(
  o: { id: number; currency?: { code: string; symbol: string } | null; exchangeRate?: number | null; status: string },
  total: number,
  ctx: FinanceContext
) {
  const at = (m: Map<number, number>) => round(m.get(o.id) ?? 0);

  const cancelled = o.status === 'Cancelled';
  /** What the order is worth. Unchanged meaning under either basis. */
  const invoiced = cancelled ? 0 : total;
  /** How much of that has actually been billed on an invoice. */
  const billed = cancelled ? 0 : at(ctx.invoicedValue);
  /**
   * Confirmed but not yet billed. Empty under the ORDER basis, where the order already IS
   * the receivable — see `ctx.orderBook`, which is only populated under INVOICE precisely so
   * a page cannot show the same money as both owed and coming.
   */
  const orderBook = cancelled ? 0 : at(ctx.orderBook);
  /**
   * The debt. Under ORDER (the default) it is the order's own value, exactly as it always
   * was. Under INVOICE only billed goods are owed for, and the rest is order book.
   */
  const debt = ctx.basis === 'INVOICE' ? billed : invoiced;
  const received = at(ctx.received);
  const jobworkAccrued = at(ctx.jobworkAccrued);
  const jobworkPaid = at(ctx.jobworkPaid);
  const materialBilled = at(ctx.materialBilled);
  const materialPaid = at(ctx.materialPaid);
  const wagesBilled = at(ctx.wagesBilled);
  const wagesPaid = at(ctx.wagesPaid);

  const rate = o.exchangeRate ?? 1;
  return {
    currency: o.currency?.code ?? 'INR',
    symbol: o.currency?.symbol ?? '₹',
    exchangeRate: rate,
    invoiced: round(invoiced),
    received: round(received),
    receivable: round(debt - received),
    /** Order value in rupees, at the rate snapshotted when the order was made. */
    invoicedInr: round(invoiced * rate),
    receivableInr: round((debt - received) * rate),
    /** Which question the receivable above answers. See AppSetting.receivableBasis. */
    receivableBasis: ctx.basis,
    /** Raised on invoices, and still only ordered. Both shown; only one is a debt. */
    billed: round(billed),
    billedInr: round(billed * rate),
    orderBook: round(orderBook),
    orderBookInr: round(orderBook * rate),
    jobworkAccrued,
    jobworkPaid: round(jobworkPaid),
    jobworkDue: round(jobworkAccrued - jobworkPaid),
    materialBilled: round(materialBilled),
    materialPaid: round(materialPaid),
    materialDue: round(materialBilled - materialPaid),
    wagesBilled: round(wagesBilled),
    wagesPaid: round(wagesPaid),
    wagesDue: round(wagesBilled - wagesPaid),
    payableInr: round(jobworkAccrued - jobworkPaid + (materialBilled - materialPaid) + (wagesBilled - wagesPaid)),
  };
}

export async function loadOrder(id: number) {
  const o = await prisma.order.findUnique({ where: { id }, include: orderInclude });
  if (!o) throw new ApiError(404, 'Order not found.');
  // Everything that opens or acts on an order comes through here, so one check keeps a
  // trashed order out of the detail page, the board, the schedule and the PDF alike.
  if (o.deletedAt) throw new ApiError(410, `${o.number} is in the trash. Restore it to open it.`);
  return o;
}

export async function loadSerializedOrder(id: number) {
  const o = await loadOrder(id);
  return serializeOrder(o, await financeContextFor([o]));
}

/** Serialize many orders sharing one money context, so the list stays consistent. */
export async function serializeOrders(orders: OrderWithBoard[]) {
  const ctx = await financeContextFor(orders);
  return orders.map((o) => serializeOrder(o, ctx));
}

/**
 * Move the order status along if the board — and the shipments — say so.
 *
 * `Confirmed -> Production -> Ready` comes from the board. `Shipped` comes from the
 * dispatches, and is only considered when the caller passes `shipped`: a board-only caller
 * behaves exactly as it always did, so a clearance cannot un-ship an order by omission.
 * `Closed` and `Cancelled` remain human decisions and are never touched.
 */
export async function syncOrderStatus(tx: Tx, orderId: number, shipped?: number): Promise<string | null> {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { lines: { include: { stages: true, moves: true } } } });
  if (!order) return null;
  const summary = rollUp(order.lines.map((l) => boardForLine(l as any)));
  const next = impliedOrderStatus(order.status, summary, shipped);
  if (!next) return null;
  await tx.order.update({ where: { id: orderId }, data: { status: next } });
  return next;
}

/** The stage line a product should use: its own, else the master default. */
export async function resolveStageLineId(tx: Tx, productId: number): Promise<number | null> {
  const product = await tx.product.findUnique({ where: { id: productId }, select: { stageLineId: true } });
  if (product?.stageLineId) return product.stageLineId;
  const fallback = await tx.stageLine.findFirst({ where: { isDefault: true, isActive: true }, select: { id: true } });
  return fallback?.id ?? null;
}

/**
 * The in-house piece rate each step of a stage line is worth for a product, taken
 * from the LABOUR lines of its live cost sheet.
 *
 * The costed figure is a REFERENCE — it seeds the rate on a new order and nothing
 * more, because what a worker is actually paid is agreed per order. A step with
 * several labour lines mapped to it sums them; a step with none is worth zero, which
 * simply means that stage is day-wage work.
 */
export async function labourRatesForProduct(tx: Tx, productId: number): Promise<Map<number, number>> {
  const lines = await tx.costLine.findMany({
    where: { stageStepId: { not: null }, group: { head: 'LABOUR', costSheet: { productId, isActive: true } } },
    select: { stageStepId: true, qty: true, rate: true },
  });
  const map = new Map<number, number>();
  for (const l of lines) {
    if (l.stageStepId == null) continue;
    map.set(l.stageStepId, round((map.get(l.stageStepId) ?? 0) + l.qty * l.rate));
  }
  return map;
}

/**
 * Create (or recreate) an order line's stage snapshot from its stage line. Stages
 * start in-house, with the piece rate defaulted from the product's costed labour;
 * who does what — and what they are really paid — is set per stage afterwards.
 *
 * Refuses to wipe stages once pieces have started moving — history is sacred.
 */
export async function materializeStages(tx: Tx, orderLineId: number, stageLineId: number | null): Promise<number> {
  const moveCount = await tx.stageMove.count({ where: { orderLineId } });
  if (moveCount > 0) {
    throw new ApiError(409, 'This line already has production movements — undo them before changing its stage line.');
  }
  await tx.orderLineStage.deleteMany({ where: { orderLineId } });
  if (!stageLineId) return 0;

  const line = await tx.orderLine.findUnique({ where: { id: orderLineId }, select: { productId: true } });
  const rates = line ? await labourRatesForProduct(tx, line.productId) : new Map<number, number>();

  const steps = await tx.stageLineStep.findMany({ where: { stageLineId }, orderBy: { sortOrder: 'asc' } });
  for (let i = 0; i < steps.length; i++) {
    await tx.orderLineStage.create({ data: { orderLineId, name: steps[i].name, sortOrder: i, labourRate: rates.get(steps[i].id) ?? 0 } });
  }
  return steps.length;
}
