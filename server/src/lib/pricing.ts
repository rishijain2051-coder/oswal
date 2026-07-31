/**
 * What a proforma or an order is WORTH — pure functions, no database.
 *
 * This is the single authority for a document's money, and it has to be, because three
 * separate places used to add up `qty × unitPrice` independently: the order payload, the
 * FIFO buckets behind receivables, and the dashboard totals. Once a line can carry a
 * discount and a document can carry freight and GST, three copies of that sum would
 * disagree the moment any of them was missed — and the order page and the Payments page
 * would quietly tell the buyer two different things.
 *
 * The rules, in the order they apply:
 *
 * 1. A LINE is `qty × unitPrice`, less its discount percentage, less its flat discount.
 *    Percentage first: "10% off, and another ₹500 off" is how it is said out loud.
 * 2. A CHARGE belongs to the whole document and carries its OWN gst rate rather than
 *    being apportioned across the lines. Freight really is billed that way, and
 *    apportioning would make the tax on one line depend on unrelated lines. A
 *    percentage charge is a percentage of the line subtotal, never of another charge —
 *    otherwise the order they were entered in would change the total.
 * 3. TAX applies per taxable component at that component's own rate. Intra-state it
 *    splits half into CGST and half into SGST; inter-state the whole of it is IGST.
 *    Which of those applies is DERIVED by comparing the buyer's state with the
 *    company's — never typed, so it cannot contradict the addresses on the document.
 * 4. An OVERSEAS document is zero-rated end to end. Every rate on it is ignored rather
 *    than trusted, so a stray 18% left on a line can never tax an export.
 *
 * `client/src/util/pricing.ts` mirrors this file exactly — keep the two identical, the
 * same way costing.ts and expr.ts are mirrored.
 */

export const MARKETS = ['OVERSEAS', 'DOMESTIC'] as const;
export type Market = (typeof MARKETS)[number];

export const CHANNELS = ['B2B', 'B2C'] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHARGE_KINDS = ['CHARGE', 'DISCOUNT'] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

/** Round to paise, nudging magnitude so negatives round symmetrically (as costing does). */
const r2 = (n: number) => (n < 0 ? -Math.round(-n * 100) / 100 : Math.round(n * 100) / 100);

export interface PricedLine {
  qty: number;
  unitPrice: number;
  discountPct?: number | null;
  discountAmt?: number | null;
  gstRatePct?: number | null;
}

export interface PricedCharge {
  name?: string;
  kind?: string | null;
  amount?: number | null;
  pct?: number | null;
  gstRatePct?: number | null;
  isTaxable?: boolean | null;
}

/** Everything the maths needs to know about the two parties. */
export interface TaxContext {
  market: string | null | undefined;
  /** The buyer's state. Compared with the company's to pick the split. */
  buyerState?: string | null;
  /** Our own state, from the Company record. */
  companyState?: string | null;
}

export interface TaxRow {
  ratePct: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

export interface ChargeRow {
  name: string;
  kind: ChargeKind;
  /** Signed: positive for a charge, negative for a discount. */
  value: number;
  isTaxable: boolean;
  gstRatePct: number;
}

export interface DocumentTotals {
  /** Sum of the net lines, after their own discounts. */
  subtotal: number;
  /** What the lines were before any line discount, so a document can show what was saved. */
  grossSubtotal: number;
  lineDiscount: number;
  charges: ChargeRow[];
  chargeTotal: number;
  /** Everything GST is charged on. */
  taxableValue: number;
  taxRows: TaxRow[];
  cgst: number;
  sgst: number;
  igst: number;
  taxTotal: number;
  /** Charges explicitly marked not taxable, added after tax. */
  untaxedCharges: number;
  grandTotal: number;
  /** True when CGST+SGST was used, false for IGST. Meaningless overseas. */
  intraState: boolean;
  taxed: boolean;
  /**
   * True when the discounts exceeded the goods. The total is clamped to zero rather
   * than going negative, and callers surface this instead of quietly accepting it.
   */
  overDiscounted: boolean;
  /**
   * GST rates where the taxable amount came out negative — a discount charged at a rate
   * none of the goods use. Not presentable on an invoice, so the UI warns.
   */
  mismatchedChargeRates: number[];
}

export function isDomestic(market: string | null | undefined): boolean {
  return market === 'DOMESTIC';
}

/** Normalised for comparison — "Rajasthan", "rajasthan " and "RAJASTHAN" are one state. */
export function sameState(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const x = norm(a);
  return x !== '' && x === norm(b);
}

/**
 * One line's net value. Percentage first, then the flat amount, and never below zero —
 * a discount larger than the line would otherwise make the document owe the buyer money.
 */
export function lineNet(line: PricedLine): number {
  const gross = (line.qty || 0) * (line.unitPrice || 0);
  const afterPct = gross - gross * ((line.discountPct || 0) / 100);
  return r2(Math.max(0, afterPct - (line.discountAmt || 0)));
}

export function lineGross(line: PricedLine): number {
  return r2((line.qty || 0) * (line.unitPrice || 0));
}

/**
 * A charge's signed value. A percentage is of the line subtotal only, so charges never
 * compound and the order they were entered in cannot change the total.
 */
export function chargeValue(charge: PricedCharge, subtotal: number): number {
  const magnitude = Math.abs(subtotal * ((charge.pct || 0) / 100)) + Math.abs(charge.amount || 0);
  return r2((charge.kind === 'DISCOUNT' ? -1 : 1) * magnitude);
}

/**
 * The whole document, priced.
 *
 * Overseas documents come back with every tax figure at zero and `taxed` false, which is
 * what makes an export zero-rated regardless of what rates the lines happen to carry.
 */
export function documentTotals(lines: PricedLine[], charges: PricedCharge[], ctx: TaxContext): DocumentTotals {
  const grossSubtotal = r2(lines.reduce((a, l) => a + lineGross(l), 0));
  const subtotal = r2(lines.reduce((a, l) => a + lineNet(l), 0));

  const rows: ChargeRow[] = charges.map((c) => ({
    name: c.name ?? 'Charge',
    kind: (c.kind === 'DISCOUNT' ? 'DISCOUNT' : 'CHARGE') as ChargeKind,
    value: chargeValue(c, subtotal),
    isTaxable: c.isTaxable !== false,
    gstRatePct: c.gstRatePct || 0,
  }));
  const chargeTotal = r2(rows.reduce((a, c) => a + c.value, 0));
  const untaxedCharges = r2(rows.filter((c) => !c.isTaxable).reduce((a, c) => a + c.value, 0));
  const taxableCharges = r2(rows.filter((c) => c.isTaxable).reduce((a, c) => a + c.value, 0));

  const taxed = isDomestic(ctx.market);
  // Clamped at zero for the same reason `lineNet` is: a discount larger than the goods
  // would otherwise make the document owe the BUYER money, and a negative order value
  // flows straight into receivables where it silently offsets other buyers' real debts.
  // The excess is reported as `overDiscounted` so a caller can say so rather than
  // pretending the figure is fine.
  const rawTaxable = r2(subtotal + taxableCharges);
  const taxableValue = Math.max(0, rawTaxable);
  const overDiscounted = rawTaxable < 0;

  if (!taxed) {
    return {
      subtotal,
      grossSubtotal,
      lineDiscount: r2(grossSubtotal - subtotal),
      charges: rows,
      chargeTotal,
      taxableValue,
      taxRows: [],
      cgst: 0,
      sgst: 0,
      igst: 0,
      taxTotal: 0,
      untaxedCharges,
      grandTotal: Math.max(0, r2(subtotal + chargeTotal)),
      intraState: false,
      taxed: false,
      overDiscounted,
      mismatchedChargeRates: [],
    };
  }

  const intraState = sameState(ctx.buyerState, ctx.companyState);

  // Group every taxable component by its rate, so a document with 12% and 18% goods
  // shows one row per slab — which is how a GST invoice has to summarise it.
  const byRate = new Map<number, number>();
  const add = (rate: number, value: number) => {
    if (!(rate > 0) || value === 0) return;
    byRate.set(rate, r2((byRate.get(rate) ?? 0) + value));
  };
  // Only when there is something left to tax. If the discounts swallowed the goods the
  // taxable value is already clamped to zero, and slabs computed from the raw figures
  // would charge NEGATIVE tax against a zero total — the two would not reconcile.
  if (!overDiscounted) {
    for (const l of lines) add(l.gstRatePct || 0, lineNet(l));
    for (const c of rows) if (c.isTaxable) add(c.gstRatePct, c.value);
  }
  // A slab can still go negative when a discount carries a rate no line uses (say 18%
  // off 12% goods). That is a data problem, not a maths one — `mismatchedChargeRates`
  // lets the UI point at it — but the tax total must never be negative overall.
  const mismatchedChargeRates = [...byRate.entries()].filter(([, v]) => v < 0).map(([rate]) => rate);

  const taxRows: TaxRow[] = [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ratePct, taxable]) => {
      const total = r2(taxable * (ratePct / 100));
      // Half each intra-state. Splitting the rounded total (rather than rounding each
      // half) keeps CGST + SGST exactly equal to the tax on that slab.
      const half = r2(total / 2);
      return {
        ratePct,
        taxable,
        cgst: intraState ? half : 0,
        sgst: intraState ? r2(total - half) : 0,
        igst: intraState ? 0 : total,
        total,
      };
    });

  const cgst = r2(taxRows.reduce((a, t) => a + t.cgst, 0));
  const sgst = r2(taxRows.reduce((a, t) => a + t.sgst, 0));
  const igst = r2(taxRows.reduce((a, t) => a + t.igst, 0));
  const taxTotal = r2(cgst + sgst + igst);

  return {
    subtotal,
    grossSubtotal,
    lineDiscount: r2(grossSubtotal - subtotal),
    charges: rows,
    chargeTotal,
    taxableValue,
    taxRows,
    cgst,
    sgst,
    igst,
    taxTotal,
    untaxedCharges,
    grandTotal: Math.max(0, r2(subtotal + chargeTotal + taxTotal)),
    intraState,
    taxed: true,
    overDiscounted,
    mismatchedChargeRates,
  };
}

/**
 * What the buyer owes for a document — the one figure receivables, the order page and
 * the dashboard must all agree on. Everything else here exists to explain it.
 */
export function documentValue(lines: PricedLine[], charges: PricedCharge[], ctx: TaxContext): number {
  return documentTotals(lines, charges, ctx).grandTotal;
}

/** A proforma or an order as the money layer sees it. */
export interface DocumentLike {
  lines: PricedLine[];
  charges?: PricedCharge[] | null;
  buyer?: { market?: string | null; state?: string | null } | null;
  /**
   * The tax basis as it stood when the document was created. PREFERRED over the live
   * buyer, so correcting an address later cannot restate a document already issued —
   * the same reason `exchangeRate` is snapshotted. The live buyer remains the fallback
   * for rows written before these columns existed.
   */
  taxMarket?: string | null;
  taxBuyerState?: string | null;
  taxCompanyState?: string | null;
}

/**
 * Which basis to price a document on: its own snapshot when it has one, otherwise the
 * live buyer and the current company state.
 */
export function taxContextOf(doc: DocumentLike, companyState?: string | null): TaxContext {
  return {
    market: doc.taxMarket ?? doc.buyer?.market ?? 'OVERSEAS',
    buyerState: doc.taxBuyerState ?? doc.buyer?.state ?? null,
    companyState: doc.taxCompanyState ?? companyState ?? null,
  };
}

/**
 * What one document is worth. THE entry point for everything outside this file — the
 * order payload, the FIFO buckets and the dashboard all call this, so none of them can
 * drift from the others.
 *
 * A missing buyer or market is treated as overseas, i.e. untaxed. That is the safe way
 * round: it can only ever understate a total, never invent tax on an export.
 */
export function documentValueOf(doc: DocumentLike, companyState?: string | null): number {
  return documentValue(doc.lines ?? [], doc.charges ?? [], taxContextOf(doc, companyState));
}

/** The full breakdown for one document, for a page or a PDF that must explain itself. */
export function documentTotalsOf(doc: DocumentLike, companyState?: string | null): DocumentTotals {
  return documentTotals(doc.lines ?? [], doc.charges ?? [], taxContextOf(doc, companyState));
}

/** Which document series a market uses. Overseas keeps the numbers it always had. */
export function docKeys(market: string | null | undefined): { proforma: string; order: string; invoice: string } {
  return isDomestic(market) ? { proforma: 'DPI', order: 'DORD', invoice: 'DINV' } : { proforma: 'PI', order: 'ORD', invoice: 'INV' };
}

/** What the paperwork is called, which differs by market. */
export function documentTitle(market: string | null | undefined): string {
  return isDomestic(market) ? 'QUOTATION' : 'PROFORMA INVOICE';
}

/**
 * What the BILL is called. A domestic sale issues a tax invoice under GST; an export issues
 * a commercial invoice, which is a customs document and carries no tax.
 */
export function invoiceTitle(market: string | null | undefined): string {
  return isDomestic(market) ? 'TAX INVOICE' : 'COMMERCIAL INVOICE';
}
