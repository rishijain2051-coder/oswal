/**
 * The accounting layer: what each party is owed or owes, explained down to the
 * individual movement, and how every payment is spread across the outstanding work.
 *
 * TWO RULES HOLD EVERYWHERE
 *
 * 1. Nothing the system can work out is ever typed in. A buyer's debt is the value
 *    of their orders; a jobwork vendor's earnings are the pieces they cleared times
 *    the rate on that stage. Only material bills and wages are entered by hand,
 *    because nothing else knows them.
 *
 * 2. Allocation is COMPUTED, never stored. Spreading a payment across orders is a
 *    pure function of (what is outstanding, what has been paid), so it is derived on
 *    every read. That means an order changing value, or more jobwork accruing, can
 *    never leave a stale allocation behind — there is nothing to go stale.
 */
import { round } from './costing';
import { buildBoard, clearances, type MoveRow, type StageRow } from './production';
import { documentValueOf, lineNet, type PricedCharge, type PricedLine } from './pricing';

// ---------------------------------------------------------------------------
// FIFO allocation
// ---------------------------------------------------------------------------

/** Something owed, oldest first. `key` identifies it; `orderId` may be null. */
export interface Bucket {
  key: string;
  orderId: number | null;
  label: string;
  date: Date | string;
  /** Total owed on this bucket before any payment is applied. */
  gross: number;
  /**
   * Set instead of `orderId` when the debt is an INVOICE rather than an order — see
   * `AppSetting.receivableBasis`. An invoice may span several orders, so it cannot carry
   * a single `orderId` without lying about which one it is.
   */
  invoiceId?: number | null;
}

export interface PaymentRow {
  id: number;
  date: Date | string;
  amount: number;
  /** The order the payment was aimed at, if any. Honoured before the spill-over. */
  orderId?: number | null;
  /** The invoice it was aimed at, under the invoice basis. Same meaning, same precedence. */
  invoiceId?: number | null;
}

export interface Allocation {
  key: string;
  orderId: number | null;
  label: string;
  amount: number;
}

export interface AllocatedPayment {
  paymentId: number;
  allocations: Allocation[];
  /** Money that had nothing left to settle — sits as credit on account. */
  unallocated: number;
}

export interface AllocationResult {
  payments: AllocatedPayment[];
  /** Per bucket: gross, how much landed on it, and what remains. */
  buckets: (Bucket & { paid: number; balance: number })[];
  /** Total money that could not be applied to anything. */
  credit: number;
}

const byDate = (a: { date: Date | string; id?: number }, b: { date: Date | string; id?: number }) => {
  const d = new Date(a.date).getTime() - new Date(b.date).getTime();
  return d !== 0 ? d : (a.id ?? 0) - (b.id ?? 0);
};

/**
 * Spread payments across buckets oldest-first.
 *
 * A payment that names an order settles that order first — the operator's stated
 * intent wins — and only the surplus flows on to the next oldest thing outstanding.
 * Whatever is still left over is credit on account rather than being forced onto an
 * order that does not owe it.
 */
export function allocateFifo(buckets: Bucket[], payments: PaymentRow[]): AllocationResult {
  const ordered = [...buckets].sort(byDate);
  const remaining = new Map<string, number>(ordered.map((b) => [b.key, b.gross]));
  const paid = new Map<string, number>(ordered.map((b) => [b.key, 0]));

  const results: AllocatedPayment[] = [];
  for (const p of [...payments].sort(byDate)) {
    let left = round(p.amount);
    const allocations: Allocation[] = [];

    const apply = (bucket: Bucket) => {
      if (left <= 0) return;
      const rem = remaining.get(bucket.key) ?? 0;
      if (rem <= 0) return;
      const amount = round(Math.min(rem, left));
      if (amount <= 0) return;
      remaining.set(bucket.key, round(rem - amount));
      paid.set(bucket.key, round((paid.get(bucket.key) ?? 0) + amount));
      left = round(left - amount);
      const existing = allocations.find((a) => a.key === bucket.key);
      if (existing) existing.amount = round(existing.amount + amount);
      else allocations.push({ key: bucket.key, orderId: bucket.orderId, label: bucket.label, amount });
    };

    // What the operator SAID this money was for, settled first.
    //
    // A receipt may name BOTH — recorded against an invoice, which was itself raised against
    // an order — so the invoice is tried first and the order is a fallback rather than an
    // alternative. Treating them as either/or would drop the order aim the moment the Admin
    // switched the basis back to ORDER, silently re-spreading money that had been pointed
    // somewhere deliberately.
    const aimed =
      (p.invoiceId != null ? ordered.find((b) => b.invoiceId === p.invoiceId) : undefined) ??
      (p.orderId != null ? ordered.find((b) => b.orderId === p.orderId) : undefined);
    if (aimed) apply(aimed);
    for (const b of ordered) apply(b);

    results.push({ paymentId: p.id, allocations, unallocated: left });
  }

  return {
    payments: results,
    buckets: ordered.map((b) => ({ ...b, paid: paid.get(b.key) ?? 0, balance: round(b.gross - (paid.get(b.key) ?? 0)) })),
    credit: round(results.reduce((a, r) => a + r.unallocated, 0)),
  };
}

// ---------------------------------------------------------------------------
// One shared money picture
//
// Both the Payments screens and an individual order read their figures from here,
// so a receipt that FIFO moved onto another order can never show one number in one
// place and a different number in another.
// ---------------------------------------------------------------------------

export interface FinanceOrderLike {
  id: number;
  number: string;
  buyerId: number;
  status: string;
  orderDate: Date | string;
  exchangeRate: number | null;
  currency?: { code: string; symbol: string } | null;
  /** Lines carry their discounts and GST rate, because the debt is the taxed total. */
  lines: PricedLine[];
  /** Freight, packing, a dealer discount — part of what is owed. */
  charges?: PricedCharge[] | null;
  /** Market and state decide whether GST applies and how it splits. */
  buyer?: { market?: string | null; state?: string | null } | null;
  /** The basis frozen at creation. Preferred over the live buyer — see pricing.ts. */
  taxMarket?: string | null;
  taxBuyerState?: string | null;
  taxCompanyState?: string | null;
}

export interface FinanceEntryLike {
  id: number;
  partyType: string;
  kind: string;
  amount: number;
  currency?: string | null;
  date: Date | string;
  orderId?: number | null;
  invoiceId?: number | null;
  supplierId?: number | null;
  buyerId?: number | null;
  partyName: string;
}

/**
 * An invoice as the money layer sees it. Satisfies `DocumentLike`, so `documentValueOf()`
 * prices it with no change to pricing.ts — which is the point of the invoice storing no
 * total of its own.
 */
export interface FinanceInvoiceLike {
  id: number;
  number: string;
  buyerId: number;
  status: string;
  invoiceDate: Date | string;
  exchangeRate: number | null;
  currency?: { code: string; symbol: string } | null;
  /**
   * Lines carry `orderId` so a receipt can be attributed back to the orders an invoice
   * covers. The loader fills it in from `InvoiceLine.orderLineId`.
   */
  lines: (PricedLine & { orderId?: number | null })[];
  charges?: PricedCharge[] | null;
  /**
   * `name`/`code` are carried so a page can name the party even when the buyer has no live
   * order in this invoice's currency — otherwise a receivables row for a buyer whose only
   * orders sit in another currency would render with a blank name.
   */
  buyer?: { market?: string | null; state?: string | null; name?: string; code?: string } | null;
  taxMarket?: string | null;
  taxBuyerState?: string | null;
  taxCompanyState?: string | null;
}

export const RECEIVABLE_BASES = ['ORDER', 'INVOICE'] as const;
export type ReceivableBasis = (typeof RECEIVABLE_BASES)[number];

export interface FinanceContext {
  /** Allocated receipts per order, in that order's own currency. */
  received: Map<number, number>;
  /** Buyer money that had no outstanding order left to settle, keyed `buyerId:CCY`. */
  buyerCredit: Map<string, { buyerId: number; currency: string; amount: number }>;
  /** Jobwork accrued per order, from the board. */
  jobworkAccrued: Map<number, number>;
  /** Jobwork payments allocated back to the orders that earned them. */
  jobworkPaid: Map<number, number>;
  /** Manually billed material / wages per order, and payments allocated to them. */
  materialBilled: Map<number, number>;
  materialPaid: Map<number, number>;
  wagesBilled: Map<number, number>;
  wagesPaid: Map<number, number>;
  /**
   * Our own state, carried here so everything reading this context prices tax the same
   * way. Loaded once per request alongside the rest of it.
   */
  companyState: string | null;

  /**
   * What made the buyer owe money — see `AppSetting.receivableBasis`. Carried on the
   * context so every reader answers the same question; a route that decided for itself
   * would put the order page and the Payments page on different bases.
   */
  basis: ReceivableBasis;

  /**
   * Under the INVOICE basis: what FIFO actually settled, per invoice.
   *
   * THIS IS THE AUTHORITY. A party balance, a statement row or a receivables figure is
   * computed from these, never from `received` below — because an invoice may span several
   * orders, and splitting it back across them is an attribution, not an allocation.
   */
  invoiceReceived: Map<number, number>;

  /** Per order: how much of its value has been invoiced. */
  invoicedValue: Map<number, number>;

  /**
   * Per order: value confirmed but not yet invoiced. Under the INVOICE basis this is NOT a
   * receivable and is deliberately kept out of the buckets — it is the order book, shown
   * beside the receivable rather than inside it. Zero under the ORDER basis, where the
   * order itself is already the debt.
   */
  orderBook: Map<number, number>;
}

const bump = (m: Map<number, number>, k: number, v: number) => m.set(k, round((m.get(k) ?? 0) + v));

/**
 * A finite number, or zero. `round()` deliberately passes NaN and Infinity through so a
 * broken calculation is visible rather than silently plausible — which is right for the
 * costing engine, but in a SUMMED report one bad row would take every other row with it.
 */
const fin = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Split what an invoice has been paid across the orders it bills, weighted by what each
 * order's lines are worth.
 *
 * This is an ATTRIBUTION, not an allocation. The allocation happened once, against the
 * invoice; this only says which order to colour on a page. It is weighted by `lineNet()` —
 * the same function that prices the line — and the rounding remainder is given to the
 * largest share, so the parts always add back to exactly what was settled. verify.ts
 * asserts that identity, because a split that loses a paisa would make an order page
 * disagree with the Payments page by that paisa forever.
 */
function attributeToOrders(inv: FinanceInvoiceLike, settled: number): Map<number, number> {
  const out = new Map<number, number>();
  if (settled <= 0) return out;

  const weights = new Map<number, number>();
  for (const l of inv.lines) {
    if (l.orderId == null) continue;
    weights.set(l.orderId, round((weights.get(l.orderId) ?? 0) + lineNet(l)));
  }
  const ids = [...weights.keys()];
  if (ids.length === 0) return out;
  if (ids.length === 1) {
    out.set(ids[0], round(settled));
    return out;
  }

  const total = ids.reduce((a, id) => a + (weights.get(id) ?? 0), 0);
  if (total <= 0) {
    // Every line fully discounted, yet money arrived. Rather than divide by zero, give it
    // all to one order — an even split would be no more truthful and harder to explain.
    out.set(ids[0], round(settled));
    return out;
  }

  let running = 0;
  for (const id of ids) {
    const share = round((settled * (weights.get(id) ?? 0)) / total);
    out.set(id, share);
    running = round(running + share);
  }
  // The remainder goes to the biggest share, so the parts sum to the whole exactly.
  const drift = round(settled - running);
  if (drift !== 0) {
    const biggest = ids.reduce((a, b) => ((weights.get(b) ?? 0) > (weights.get(a) ?? 0) ? b : a));
    out.set(biggest, round((out.get(biggest) ?? 0) + drift));
  }
  return out;
}

/**
 * Allocate every payment across everything outstanding, once, and index the result
 * by order. `jobworkPerOrder` comes from the board (pieces cleared × rate).
 *
 * `opts.basis` decides what a buyer's debt IS: their orders (as it always has been) or
 * their invoices. It is applied HERE and nowhere else — a route that branched on it
 * separately would be a second source of truth, and the order page and the Payments page
 * would disagree the moment one of them was missed.
 */
export function buildFinanceContext(
  orders: FinanceOrderLike[],
  entries: FinanceEntryLike[],
  jobworkPerOrder: Map<number, Map<number, number>>,
  /** Our own state, for the CGST+SGST vs IGST decision on domestic orders. */
  companyState?: string | null,
  opts?: { basis?: ReceivableBasis; invoices?: FinanceInvoiceLike[] }
): FinanceContext {
  const basis: ReceivableBasis = opts?.basis === 'INVOICE' ? 'INVOICE' : 'ORDER';
  const ctx: FinanceContext = {
    received: new Map(),
    buyerCredit: new Map(),
    jobworkAccrued: new Map(),
    jobworkPaid: new Map(),
    materialBilled: new Map(),
    materialPaid: new Map(),
    wagesBilled: new Map(),
    wagesPaid: new Map(),
    companyState: companyState ?? null,
    basis,
    invoiceReceived: new Map(),
    invoicedValue: new Map(),
    orderBook: new Map(),
  };
  const live = orders.filter((o) => o.status !== 'Cancelled');
  /**
   * Only an ISSUED invoice is money owed.
   *
   * A DRAFT has not been sent to anybody, so it can be neither a debt nor a reduction of
   * the order book — counting it would make a receivable appear the moment somebody started
   * typing. A CANCELLED one keeps its number, because a gap in an invoice series is a
   * compliance problem, but stops being a debt exactly as a cancelled order does.
   */
  const liveInvoices = (opts?.invoices ?? []).filter((i) => i.status === 'ISSUED');

  // --- what has been invoiced, and what is still only ordered ---------------
  for (const inv of liveInvoices) {
    for (const l of inv.lines) {
      if (l.orderId == null) continue;
      bump(ctx.invoicedValue, l.orderId, lineNet(l));
    }
  }
  /**
   * Order book is only meaningful under the INVOICE basis, so it stays EMPTY under ORDER.
   *
   * Under ORDER the order already IS the receivable, and a map that also reported it as
   * "not yet billed" would invite a page to show the same money twice — once as owed and
   * once as coming. One map, one meaning.
   */
  if (basis === 'INVOICE') {
    for (const o of live) {
      const worth = documentValueOf(o, companyState);
      const invoiced = ctx.invoicedValue.get(o.id) ?? 0;
      ctx.orderBook.set(o.id, round(Math.max(0, worth - invoiced)));
    }
  }

  // --- buyers: their orders (or their invoices) are the debts, per currency --
  //
  // Invoices widen this set ONLY under the INVOICE basis, where they are the debt. Under
  // ORDER they are loaded purely to fill `invoicedValue` above, and letting them add a buyer
  // here would change allocation: a buyer with receipts but no live order would arrive with
  // no buckets, and every one of their payments would be reported as credit on account.
  const buyerIds = [
    ...new Set([...live.map((o) => o.buyerId), ...(basis === 'INVOICE' ? liveInvoices.map((i) => i.buyerId) : [])]),
  ];
  for (const buyerId of buyerIds) {
    const mine = live.filter((o) => o.buyerId === buyerId);
    const myInvoices = liveInvoices.filter((i) => i.buyerId === buyerId);
    const receipts = entries.filter((e) => e.partyType === 'BUYER' && e.kind === 'PAYMENT' && e.buyerId === buyerId);
    const debtCodes = basis === 'INVOICE' ? myInvoices.map((i) => i.currency?.code ?? 'INR') : mine.map((o) => o.currency?.code ?? 'INR');
    const codes = [...new Set([...debtCodes, ...receipts.map((r) => r.currency ?? 'INR')])];
    for (const code of codes) {
      const inCcy = receipts.filter((r) => (r.currency ?? 'INR') === code);
      const payments = inCcy.map((e) => ({ id: e.id, date: e.date, amount: e.amount, orderId: e.orderId, invoiceId: e.invoiceId }));

      if (basis === 'INVOICE') {
        const invoicesInCcy = myInvoices.filter((i) => (i.currency?.code ?? 'INR') === code);
        const buckets: Bucket[] = invoicesInCcy.map((i) => ({
          key: `invoice-${i.id}`,
          orderId: null,
          invoiceId: i.id,
          label: i.number,
          date: i.invoiceDate,
          // Through the same pricing engine as an order, so an invoice and the order behind
          // it can never be worth different amounts for the same goods.
          gross: documentValueOf(i, companyState),
        }));
        const result = allocateFifo(buckets, payments);
        for (const b of result.buckets) {
          if (b.invoiceId == null) continue;
          ctx.invoiceReceived.set(b.invoiceId, b.paid);
          const inv = invoicesInCcy.find((i) => i.id === b.invoiceId);
          if (!inv) continue;
          for (const [orderId, amount] of attributeToOrders(inv, b.paid)) bump(ctx.received, orderId, amount);
        }
        if (result.credit > 0) ctx.buyerCredit.set(`${buyerId}:${code}`, { buyerId, currency: code, amount: result.credit });
        continue;
      }

      const ordersInCcy = mine.filter((o) => (o.currency?.code ?? 'INR') === code);
      const buckets: Bucket[] = ordersInCcy.map((o) => ({
        key: `order-${o.id}`,
        orderId: o.id,
        label: o.number,
        date: o.orderDate,
        // The whole debt, through the one pricing engine: line discounts, document
        // charges and GST included. Summing qty x price here would leave the Payments
        // page disagreeing with the order it is settling.
        gross: documentValueOf(o, companyState),
      }));
      const result = allocateFifo(buckets, payments);
      for (const b of result.buckets) if (b.orderId != null) ctx.received.set(b.orderId, b.paid);
      if (result.credit > 0) ctx.buyerCredit.set(`${buyerId}:${code}`, { buyerId, currency: code, amount: result.credit });
    }
  }

  // --- jobwork: accrual from the board, payments allocated oldest job first --
  for (const [vendorId, perOrder] of jobworkPerOrder) {
    for (const [orderId, amount] of perOrder) bump(ctx.jobworkAccrued, orderId, amount);
    const buckets: Bucket[] = [...perOrder.entries()]
      .map(([orderId, gross]) => {
        const o = live.find((x) => x.id === orderId);
        return { key: `order-${orderId}`, orderId, label: o?.number ?? `#${orderId}`, date: o?.orderDate ?? new Date(0), gross };
      })
      .filter((b) => b.gross > 0);
    const payments = entries.filter((e) => e.partyType === 'JOBWORK' && e.kind === 'PAYMENT' && e.supplierId === vendorId);
    const result = allocateFifo(buckets, payments.map((e) => ({ id: e.id, date: e.date, amount: e.amount, orderId: e.orderId })));
    for (const b of result.buckets) if (b.orderId != null) bump(ctx.jobworkPaid, b.orderId, b.paid);
  }

  // --- material and wages: the bills are the debts --------------------------
  for (const type of ['SUPPLIER', 'WORKER'] as const) {
    const billed = type === 'SUPPLIER' ? ctx.materialBilled : ctx.wagesBilled;
    const paid = type === 'SUPPLIER' ? ctx.materialPaid : ctx.wagesPaid;
    const rows = entries.filter((e) => e.partyType === type);
    for (const key of [...new Set(rows.map((e) => `${e.supplierId ?? e.partyName}`))]) {
      const mine = rows.filter((e) => `${e.supplierId ?? e.partyName}` === key);
      const bills = mine.filter((e) => e.kind === 'BILL');
      for (const b of bills) if (b.orderId != null) bump(billed, b.orderId, b.amount);
      const buckets: Bucket[] = bills.map((b) => ({ key: `bill-${b.id}`, orderId: b.orderId ?? null, label: `Bill #${b.id}`, date: b.date, gross: b.amount }));
      const result = allocateFifo(buckets, mine.filter((e) => e.kind === 'PAYMENT').map((e) => ({ id: e.id, date: e.date, amount: e.amount, orderId: e.orderId })));
      for (const b of result.buckets) if (b.orderId != null) bump(paid, b.orderId, b.paid);
    }
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// Jobwork earned, movement by movement
// ---------------------------------------------------------------------------

export interface JobworkEvent {
  moveId: number;
  date: Date | string;
  orderId: number;
  orderNumber: string;
  orderLineId: number;
  productCode: string;
  productName: string;
  stage: string;
  stageSortOrder: number;
  vendorId: number;
  vendorName: string;
  pieces: number;
  rate: number;
  amount: number;
  note?: string | null;
  /** True when these pieces had been rejected earlier and were re-done. */
  rework: boolean;
}

interface LineForEvents {
  id: number;
  qty: number;
  product: { factoryCode: string; name: string };
  stages: (StageRow & { name: string; sortOrder: number })[];
  moves: (MoveRow & { note?: string | null })[];
}

/**
 * Every clearance out of an outsourced stage, as a dated earning.
 *
 * A vendor is paid for work done, so pieces that come back for rework and are
 * cleared again earn again — which is why this counts movements rather than
 * distinct pieces, and why the totals agree with the board's `cleared` figure.
 *
 * The rate used is the one currently on the stage. Rates are set before work is
 * handed over (an outsourced stage with no rate is refused), so this stays honest;
 * changing a rate afterwards restates the earnings for that stage.
 */
export function jobworkEvents(order: { id: number; number: string }, line: LineForEvents): JobworkEvent[] {
  const events: JobworkEvent[] = [];
  for (const { move: m, stage, rework } of clearances(line.stages, line.moves)) {
    if (!stage.vendorId) continue;
    events.push({
      moveId: m.id,
      date: m.date!,
      orderId: order.id,
      orderNumber: order.number,
      orderLineId: line.id,
      productCode: line.product.factoryCode,
      productName: line.product.name,
      stage: stage.name,
      stageSortOrder: stage.sortOrder,
      vendorId: stage.vendorId,
      vendorName: stage.vendor?.name ?? `Vendor #${stage.vendorId}`,
      pieces: m.qty,
      rate: stage.jobworkRate ?? 0,
      amount: round(m.qty * (stage.jobworkRate ?? 0)),
      note: m.note ?? null,
      rework,
    });
  }
  return events;
}

/** Convenience: the jobwork a whole order generated, as dated events. */
export function jobworkEventsForOrder(order: { id: number; number: string; lines: LineForEvents[] }): JobworkEvent[] {
  return order.lines.flatMap((l) => jobworkEvents(order, l));
}

/** Board-derived jobwork total for a line, used to cross-check the events. */
export function jobworkTotalForLine(line: LineForEvents): number {
  const board = buildBoard(line.qty, line.stages as StageRow[], line.moves as MoveRow[]);
  return round(board.jobwork.reduce((a, j) => a + j.amount, 0));
}

// ---------------------------------------------------------------------------
// Running statements
// ---------------------------------------------------------------------------

export interface StatementRow {
  /** Stable identity for the row, so the UI never keys off an array index. */
  key: string;
  date: Date | string;
  type: 'ACCRUAL' | 'BILL' | 'INVOICE' | 'PAYMENT' | 'RECEIPT';
  description: string;
  ref?: string | null;
  orderNumber?: string | null;
  /** Increases what is owed. */
  charge: number;
  /** Reduces what is owed. */
  settle: number;
  balance: number;
  detail?: string | null;
}

/** Merge charges and settlements into one dated statement with a running balance. */
export function buildStatement(rows: Omit<StatementRow, 'balance' | 'key'>[]): StatementRow[] {
  let balance = 0;
  return [...rows]
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .map((r, i) => {
      balance = round(balance + r.charge - r.settle);
      return { ...r, key: `${r.type}-${i}-${new Date(r.date).getTime()}`, balance };
    });
}

// ---------------------------------------------------------------------------
// Multi-currency receivables and the forex position
// ---------------------------------------------------------------------------

/** One order's receivable, in the buyer's currency and in rupees two ways. */
export interface ForexOrderRow {
  orderId: number;
  currency: string;
  /** In the buyer's own currency. */
  invoicedFcy: number;
  receivedFcy: number;
  receivableFcy: number;
  /** The rate snapshotted when the order was created. */
  snapshotRate: number;
  /** Today's rate from the currency master. */
  currentRate: number;
  /** Rupees at the rate we booked the order at. */
  receivableInr: number;
  /** Rupees if it were settled at today's rate. */
  receivableAtCurrentRate: number;
  /**
   * Positive means the rupee value of what we are owed has RISEN since the order was
   * booked (the foreign currency strengthened) — a gain when it is collected. Negative
   * is the reverse. Unrealised either way: nothing is booked until money arrives.
   */
  forexGainLoss: number;
}

export interface ForexCurrencyRow {
  currency: string;
  symbol: string;
  totalFcy: number;
  totalInrAtSnapshot: number;
  totalInrAtCurrent: number;
  forexGainLoss: number;
  orderCount: number;
  /** What the outstanding orders average out to, for comparison with the live rate. */
  averageSnapshotRate: number;
  currentRate: number;
}

export interface ForexSummary {
  byCurrency: ForexCurrencyRow[];
  totalInrAtSnapshot: number;
  totalInrAtCurrent: number;
  netForexGainLoss: number;
  /** True when anything is outstanding in a currency other than rupees. */
  hasForeignExposure: boolean;
}

/**
 * Group what is outstanding by currency and value it twice: at the rate each order was
 * booked at, and at today's.
 *
 * Pure — it takes the already-allocated per-order figures and the live rates, so it
 * cannot disagree with the FIFO result it is built from. Rupee orders are included for
 * completeness but can never show a gain or loss, because their rate is 1 by definition.
 */
export function receivablesByCurrency(rows: ForexOrderRow[], symbolOf: (code: string) => string): ForexSummary {
  const byCode = new Map<string, ForexCurrencyRow & { rateWeight: number }>();

  for (const raw of rows) {
    // Rates reach here from `Order.exchangeRate` and the currency master, and the master
    // is filled in by a human pasting the ICEGATE table. One bad parse would otherwise
    // turn the WHOLE net position into NaN — every currency, not just the broken one —
    // because `round()` passes non-finite values straight through. Treat a nonsense
    // figure as zero for this order rather than poisoning the report.
    const r = {
      ...raw,
      receivableFcy: fin(raw.receivableFcy),
      snapshotRate: fin(raw.snapshotRate),
      currentRate: fin(raw.currentRate),
      receivableInr: fin(raw.receivableInr),
      receivableAtCurrentRate: fin(raw.receivableAtCurrentRate),
    };
    // Nothing outstanding is nothing to report — a settled order is not exposure.
    if (r.receivableFcy <= 0) continue;
    const row =
      byCode.get(r.currency) ??
      byCode
        .set(r.currency, {
          currency: r.currency,
          symbol: symbolOf(r.currency),
          totalFcy: 0,
          totalInrAtSnapshot: 0,
          totalInrAtCurrent: 0,
          forexGainLoss: 0,
          orderCount: 0,
          averageSnapshotRate: 0,
          currentRate: r.currentRate,
          rateWeight: 0,
        })
        .get(r.currency)!;

    row.totalFcy = round(row.totalFcy + r.receivableFcy);
    row.totalInrAtSnapshot = round(row.totalInrAtSnapshot + r.receivableInr);
    row.totalInrAtCurrent = round(row.totalInrAtCurrent + r.receivableAtCurrentRate);
    row.orderCount += 1;
    // Weighted by what is outstanding, so a large old order moves the average more than
    // a small recent one — which is what makes it comparable with the live rate.
    row.rateWeight = round(row.rateWeight + r.receivableFcy * r.snapshotRate);
  }

  const byCurrency = [...byCode.values()]
    .map(({ rateWeight, ...row }) => ({
      ...row,
      averageSnapshotRate: row.totalFcy > 0 ? round(rateWeight / row.totalFcy, 4) : 0,
      forexGainLoss: round(row.totalInrAtCurrent - row.totalInrAtSnapshot),
    }))
    .sort((a, b) => b.totalInrAtCurrent - a.totalInrAtCurrent);

  const totalInrAtSnapshot = round(byCurrency.reduce((a, c) => a + c.totalInrAtSnapshot, 0));
  const totalInrAtCurrent = round(byCurrency.reduce((a, c) => a + c.totalInrAtCurrent, 0));

  return {
    byCurrency,
    totalInrAtSnapshot,
    totalInrAtCurrent,
    netForexGainLoss: round(totalInrAtCurrent - totalInrAtSnapshot),
    hasForeignExposure: byCurrency.some((c) => c.currency !== 'INR' && c.totalFcy > 0),
  };
}
