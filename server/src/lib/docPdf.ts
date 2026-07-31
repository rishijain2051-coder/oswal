/**
 * PDF generation for the proforma invoice, using pdfkit.
 *
 * The built-in Helvetica font can only encode WinAnsi, so all text goes through
 * `safe()` first — that keeps rupee signs, smart quotes and dashes from turning
 * into garbage. Money is printed with the currency CODE (e.g. "USD 1,200.00")
 * rather than a symbol for the same reason, which is also what buyers expect on
 * an export document.
 */
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { companyLines, companyLogoPath, type CompanyProfile } from './company';
import { documentTotals, lineNet, type DocumentTotals, type PricedCharge } from './pricing';

const uploadDir = path.join(__dirname, '..', '..', 'uploads');

const REPLACEMENTS: [RegExp, string][] = [
  [/₹/g, 'INR '],
  [/[‘’‛]/g, "'"],
  [/[“”‟]/g, '"'],
  [/[–—]/g, '-'],
  [/…/g, '...'],
  [/ /g, ' '],
  [/[•●]/g, '*'],
];

/** Make a string safe for pdfkit's standard (WinAnsi) fonts. */
export function safe(input: unknown): string {
  let s = input == null ? '' : String(input);
  for (const [re, to] of REPLACEMENTS) s = s.replace(re, to);
  // Drop anything WinAnsi cannot represent rather than emitting mojibake.
  return s.replace(/[^\n\r\t\x20-\x7e\u00a0-\u00ff]/g, '');
}

export function amount(value: number | null | undefined, code = 'INR', dp = 2): string {
  if (value == null || !isFinite(value)) return '-';
  return `${code} ${value.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '-';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '-';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Absolute path of an uploaded image, if pdfkit can actually embed it. */
function embeddablePath(filename?: string | null): string | null {
  if (!filename) return null;
  if (!/\.(jpe?g|png)$/i.test(filename)) return null; // pdfkit supports JPEG + PNG only
  const p = path.join(uploadDir, filename);
  return fs.existsSync(p) ? p : null;
}

const BROWN = '#4e342e';
const LIGHT = '#efebe9';
const GREY = '#777777';
const BORDER = '#cccccc';

type Doc = PDFKit.PDFDocument;

interface Col {
  key: string;
  title: string;
  width: number;
  align?: 'left' | 'right' | 'center';
}

/**
 * Start collecting the document's bytes. Call this BEFORE drawing so no chunk is
 * missed, then `await finish(doc, collected)` once the last element is drawn —
 * `doc.end()` must not run until the drawing is complete.
 */
function collect(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function finish(doc: Doc, collected: Promise<Buffer>): Promise<Buffer> {
  doc.end();
  return collected;
}

function letterhead(doc: Doc, co: CompanyProfile, title: string, number: string, date: Date | string) {
  const top = doc.y;
  const left = doc.page.margins.left;

  // A logo, when there is one pdfkit can embed, sits left of the name and shifts the
  // text block across. Anything unreadable falls back to the plain text letterhead
  // rather than failing the document.
  const logo = companyLogoPath(co);
  let textX = left;
  if (logo) {
    try {
      doc.image(logo, left, top, { fit: [52, 52] });
      textX = left + 62;
    } catch {
      textX = left;
    }
  }

  doc.font('Helvetica-Bold').fontSize(19).fillColor(BROWN).text(safe(co.legalName), textX, top, { continued: false });
  doc.font('Helvetica').fontSize(8.5).fillColor(GREY);
  for (const line of companyLines(co)) doc.text(safe(line), textX, doc.y);

  const right = doc.page.width - doc.page.margins.right - 200;
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#000000').text(safe(title), right, top, { width: 200, align: 'right' });
  doc.font('Helvetica').fontSize(10).text(safe(number), right, doc.y, { width: 200, align: 'right' });
  doc.fontSize(9).fillColor(GREY).text(fmtDate(date), right, doc.y, { width: 200, align: 'right' });

  doc.fillColor('#000000');
  doc.y = Math.max(doc.y, top + 62) + 10;
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor(BROWN).lineWidth(1.2).stroke();
  doc.y += 12;
}

/** Two facing blocks: party on the left, key/value terms on the right. */
function partyBlock(doc: Doc, heading: string, lines: string[], terms: [string, string][]) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const half = width / 2 - 10;
  const top = doc.y;

  doc.font('Helvetica').fontSize(7.5).fillColor(GREY).text(heading, left, top, { width: half });
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#000000').text(safe(lines[0] ?? '-'), left, doc.y, { width: half });
  doc.font('Helvetica').fontSize(9);
  for (const l of lines.slice(1)) if (l) doc.text(safe(l), left, doc.y, { width: half });
  const leftEnd = doc.y;

  let y = top;
  const rx = left + width - half;
  for (const [k, v] of terms) {
    if (!v) continue;
    doc.font('Helvetica').fontSize(8.5).fillColor(GREY).text(safe(k), rx, y, { width: half * 0.45 });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text(safe(v), rx + half * 0.45, y, { width: half * 0.55, align: 'right' });
    y = Math.max(y + 13, doc.y);
  }

  doc.y = Math.max(leftEnd, y) + 14;
  doc.fillColor('#000000');
}

function tableHeader(doc: Doc, cols: Col[], y: number): number {
  const left = doc.page.margins.left;
  const h = 20;
  const total = cols.reduce((a, c) => a + c.width, 0);
  doc.rect(left, y, total, h).fill(LIGHT);
  let x = left;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BROWN);
  for (const c of cols) {
    doc.text(safe(c.title), x + 5, y + 6, { width: c.width - 10, align: c.align ?? 'left' });
    x += c.width;
  }
  doc.fillColor('#000000');
  return y + h;
}

/**
 * The money stack at the foot of a document: subtotal, each charge, one row per GST slab,
 * then the grand total. Shared by the proforma and the order confirmation, because two
 * copies of this would eventually present the same figures differently.
 *
 * Returns the new `y` so the caller can carry on below it.
 */
function totalsStack(doc: Doc, totals: DocumentTotals, code: string, startY: number, totalW: number, bottomLimit: () => number): number {
  const amtW = 88;
  const labelW = totalW - amtW;
  const left = doc.page.margins.left;
  let y = startY;

  const row = (label: string, value: number, opts: { bold?: boolean; band?: boolean } = {}) => {
    const h = opts.band ? 22 : 16;
    if (y + h > bottomLimit()) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    if (opts.band) doc.rect(left, y, totalW, h).fill(LIGHT);
    doc
      .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(opts.bold ? 10 : 9)
      .fillColor(opts.bold ? BROWN : '#000000');
    doc.text(safe(label), left + 5, y + (opts.band ? 6 : 3), { width: labelW - 10, align: 'right' });
    doc.text(amount(value, code), left + labelW, y + (opts.band ? 6 : 3), { width: amtW - 5, align: 'right' });
    doc.fillColor('#000000');
    y += h;
  };

  const taxed = totals.taxed;
  if (totals.charges.length > 0 || taxed) row('Subtotal', totals.subtotal);
  for (const c of totals.charges) {
    const suffix = taxed && c.isTaxable && c.gstRatePct > 0 ? ` (GST ${c.gstRatePct}%)` : '';
    row(`${c.name}${suffix}`, c.value);
  }
  if (taxed) {
    if (totals.charges.some((c) => c.isTaxable)) row('Taxable value', totals.taxableValue);
    for (const t of totals.taxRows) {
      if (totals.intraState) {
        row(`CGST @ ${t.ratePct / 2}%`, t.cgst);
        row(`SGST @ ${t.ratePct / 2}%`, t.sgst);
      } else {
        row(`IGST @ ${t.ratePct}%`, t.igst);
      }
    }
  }
  row(taxed ? 'GRAND TOTAL' : 'TOTAL', totals.grandTotal, { bold: true, band: true });
  return y;
}

function hline(doc: Doc, y: number, width: number) {
  doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + width, y).strokeColor(BORDER).lineWidth(0.6).stroke();
}

// ---------------------------------------------------------------------------
// Proforma invoice
// ---------------------------------------------------------------------------

export interface ProformaPdfLine {
  description: string;
  qty: number;
  unitPrice: number;
  productCode?: string | null;
  imageFile?: string | null;
  specs?: string | null;
  /** Domestic only — printed as their own columns and used for the tax summary. */
  discountPct?: number | null;
  discountAmt?: number | null;
  gstRatePct?: number | null;
  hsnCode?: string | null;
}

export interface ProformaPdfInput {
  number: string;
  date: Date | string;
  validUntil?: Date | string | null;
  currencyCode: string;
  showImages: boolean;
  buyer: {
    name: string;
    address?: string | null;
    country?: string | null;
    contactName?: string | null;
    email?: string | null;
    phone?: string | null;
    gstNo?: string | null;
    state?: string | null;
    market?: string | null;
    channel?: string | null;
  };
  /** Us, for the letterhead and for the CGST+SGST versus IGST decision. */
  company: CompanyProfile;
  incoterms?: string | null;
  paymentTerms?: string | null;
  deliveryTerms?: string | null;
  bankDetails?: string | null;
  notes?: string | null;
  lines: ProformaPdfLine[];
  /** Freight, packing, a dealer discount — shown under the subtotal. */
  charges?: PricedCharge[] | null;
}

export async function proformaPdf(input: ProformaPdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 46, left: 40, right: 40 } });
  const out = collect(doc);
  const code = input.currencyCode || 'INR';
  const withImages = input.showImages && input.lines.some((l) => embeddablePath(l.imageFile));

  // One call to the pricing engine decides everything below: the subtotal, the charges,
  // whether tax applies at all and how it splits. The PDF never does its own arithmetic,
  // so it cannot print a total the rest of the app disagrees with.
  const totals = documentTotals(input.lines, input.charges ?? [], {
    market: input.buyer.market,
    buyerState: input.buyer.state,
    companyState: input.company.state,
  });
  const taxed = totals.taxed;
  const hasHsn = taxed && input.lines.some((l) => (l.hsnCode ?? '').trim() !== '');
  // A domestic quotation is not a proforma invoice; exports genuinely are.
  const title = taxed ? 'QUOTATION' : 'PROFORMA INVOICE';

  letterhead(doc, input.company, title, input.number, input.date);

  partyBlock(
    doc,
    'BUYER',
    [
      input.buyer.name,
      input.buyer.contactName ? `Attn: ${input.buyer.contactName}` : '',
      ...(input.buyer.address ? input.buyer.address.split('\n') : []),
      [input.buyer.state, input.buyer.country].filter(Boolean).join(', '),
      input.buyer.email ?? '',
      input.buyer.phone ?? '',
      input.buyer.gstNo ? `GSTIN: ${input.buyer.gstNo}` : '',
    ].filter(Boolean) as string[],
    [
      ['Currency', code],
      ['Incoterms', input.incoterms ?? ''],
      // Place of supply is what justifies the CGST/SGST versus IGST choice, so a tax
      // document has to state it.
      ...(taxed ? ([['Place of supply', input.buyer.state ?? '-']] as [string, string][]) : []),
      ['Valid until', input.validUntil ? fmtDate(input.validUntil) : ''],
    ]
  );

  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const imgW = withImages ? 62 : 0;
  const hsnW = hasHsn ? 46 : 0;
  const gstW = taxed ? 34 : 0;
  const cols: Col[] = [
    { key: 'i', title: '#', width: 24 },
    ...(withImages ? [{ key: 'img', title: '', width: imgW } as Col] : []),
    { key: 'desc', title: 'Description', width: usable - 24 - imgW - hsnW - gstW - 44 - 74 - 88 },
    ...(hasHsn ? [{ key: 'hsn', title: 'HSN', width: hsnW } as Col] : []),
    { key: 'qty', title: 'Qty', width: 44, align: 'right' },
    { key: 'rate', title: 'Unit Price', width: 74, align: 'right' },
    ...(taxed ? [{ key: 'gst', title: 'GST', width: gstW, align: 'right' } as Col] : []),
    { key: 'amt', title: 'Amount', width: 88, align: 'right' },
  ];
  const totalW = cols.reduce((a, c) => a + c.width, 0);
  const descCol = cols.find((c) => c.key === 'desc')!;

  let y = tableHeader(doc, cols, doc.y);
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 30;

  input.lines.forEach((l, idx) => {
    const img = withImages ? embeddablePath(l.imageFile) : null;
    // A discount is stated on the line it applies to, or the buyer cannot see why the
    // amount is not qty x price.
    const off = [(l.discountPct ?? 0) > 0 ? `${l.discountPct}% off` : '', (l.discountAmt ?? 0) > 0 ? `less ${amount(l.discountAmt, code)}` : ''].filter(Boolean).join(', ');
    const descText =
      safe(l.description) + (l.productCode ? `\n${safe(l.productCode)}` : '') + (l.specs ? `\n${safe(l.specs)}` : '') + (off ? `\n${safe(off)}` : '');
    doc.font('Helvetica').fontSize(9);
    const textH = doc.heightOfString(descText, { width: descCol.width - 10 });
    const rowH = Math.max(withImages ? 52 : 0, textH + 12);

    if (y + rowH > bottomLimit()) {
      doc.addPage();
      y = tableHeader(doc, cols, doc.page.margins.top);
    }

    // The engine's own line maths, so a printed line can never disagree with the
    // subtotal it feeds.
    const amt = lineNet(l);

    let x = doc.page.margins.left;
    const cell = (c: Col, text: string, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#000000');
      doc.text(text, x + 5, y + 6, { width: c.width - 10, align: c.align ?? 'left' });
    };

    for (const c of cols) {
      if (c.key === 'i') cell(c, String(idx + 1));
      else if (c.key === 'img') {
        if (img) {
          try {
            doc.image(img, x + 5, y + 5, { fit: [c.width - 10, rowH - 10], align: 'center', valign: 'center' });
          } catch {
            /* unreadable image — leave the cell blank rather than fail the PDF */
          }
        }
      } else if (c.key === 'desc') cell(c, descText);
      else if (c.key === 'hsn') cell(c, safe(l.hsnCode ?? ''));
      else if (c.key === 'qty') cell(c, String(l.qty));
      else if (c.key === 'rate') cell(c, amount(l.unitPrice, code));
      else if (c.key === 'gst') cell(c, `${l.gstRatePct ?? 0}%`);
      else cell(c, amount(amt, code), true);
      x += c.width;
    }

    y += rowH;
    hline(doc, y, totalW);
  });

  // Subtotal, each charge, tax per slab, grand total — shared with the order PDF so the
  // two documents present the same money the same way.
  y = totalsStack(doc, totals, code, y, totalW, bottomLimit);
  doc.y = y + 12;

  if (!taxed && input.lines.some((l) => (l.gstRatePct ?? 0) > 0)) {
    // Reassures the buyer, and documents why rates on the lines were ignored.
    doc.font('Helvetica').fontSize(8).fillColor(GREY).text(safe('Export supply - zero rated, no GST charged.'), doc.page.margins.left, doc.y, { width: usable });
    doc.fillColor('#000000');
    doc.y += 8;
  }

  // Terms + bank details
  const half = usable / 2 - 10;
  const termsTop = doc.y;
  const terms: [string, string][] = [
    ['Payment terms', input.paymentTerms ?? ''],
    ['Delivery terms', input.deliveryTerms ?? ''],
    ['Incoterms', input.incoterms ?? ''],
  ];
  doc.font('Helvetica').fontSize(9);
  for (const [k, v] of terms) {
    if (!v) continue;
    doc.font('Helvetica-Bold').fontSize(8.5).text(safe(k), doc.page.margins.left, doc.y, { width: half });
    doc.font('Helvetica').fontSize(9).text(safe(v), doc.page.margins.left, doc.y, { width: half });
    doc.y += 3;
  }
  if (input.notes) {
    doc.font('Helvetica-Bold').fontSize(8.5).text('Notes', doc.page.margins.left, doc.y + 4, { width: half });
    doc.font('Helvetica').fontSize(9).text(safe(input.notes), doc.page.margins.left, doc.y, { width: half });
  }
  const leftEnd = doc.y;

  if (input.bankDetails) {
    const rx = doc.page.margins.left + usable - half;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GREY).text('BANK DETAILS', rx, termsTop, { width: half, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor('#000000').text(safe(input.bankDetails), rx, doc.y, { width: half, align: 'right' });
  }

  doc.y = Math.max(leftEnd, doc.y) + 34;
  if (doc.y > bottomLimit()) doc.addPage();
  doc.font('Helvetica').fontSize(9).text(`For ${safe(input.company.legalName)}`, doc.page.margins.left + usable - 200, doc.y, { width: 200, align: 'right' });
  doc.fillColor(GREY).text('Authorised Signatory', doc.page.margins.left + usable - 200, doc.y + 26, { width: 200, align: 'right' });

  return finish(doc, out);
}

// ---------------------------------------------------------------------------
// Order confirmation
// ---------------------------------------------------------------------------

export interface OrderPdfLine {
  productCode: string;
  description: string;
  qty: number;
  unitPrice: number;
  discountPct?: number | null;
  discountAmt?: number | null;
  gstRatePct?: number | null;
  hsnCode?: string | null;
  /** Which route the piece travels, so the floor can read the card. */
  stageLine?: string | null;
}

export interface OrderPdfInput {
  number: string;
  date: Date | string;
  deliveryDate?: Date | string | null;
  currencyCode: string;
  exchangeRate?: number | null;
  status: string;
  buyer: ProformaPdfInput['buyer'];
  company: CompanyProfile;
  incoterms?: string | null;
  paymentTerms?: string | null;
  notes?: string | null;
  proformaNumber?: string | null;
  lines: OrderPdfLine[];
  charges?: PricedCharge[] | null;
  /** The document's own tax basis, when it has one. */
  taxMarket?: string | null;
  taxBuyerState?: string | null;
  taxCompanyState?: string | null;
}

/**
 * What the factory and the buyer both sign off: the confirmed order.
 *
 * No photos — an order is operational, not a sales document — but each line names its
 * stage line so the sheet works as a job card. The money comes from the same
 * `documentTotals` engine the proforma uses, so a confirmation can never disagree with
 * the quote it came from.
 */
export async function orderPdf(input: OrderPdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 46, left: 40, right: 40 } });
  const out = collect(doc);
  const code = input.currencyCode || 'INR';

  const totals = documentTotals(input.lines, input.charges ?? [], {
    market: input.taxMarket ?? input.buyer.market,
    buyerState: input.taxBuyerState ?? input.buyer.state,
    companyState: input.taxCompanyState ?? input.company.state,
  });
  const taxed = totals.taxed;
  const hasHsn = taxed && input.lines.some((l) => (l.hsnCode ?? '').trim() !== '');

  letterhead(doc, input.company, 'ORDER CONFIRMATION', input.number, input.date);

  partyBlock(
    doc,
    'BUYER',
    [
      input.buyer.name,
      input.buyer.contactName ? `Attn: ${input.buyer.contactName}` : '',
      ...(input.buyer.address ? input.buyer.address.split('\n') : []),
      [input.buyer.state, input.buyer.country].filter(Boolean).join(', '),
      input.buyer.email ?? '',
      input.buyer.gstNo ? `GSTIN: ${input.buyer.gstNo}` : '',
    ].filter(Boolean) as string[],
    [
      ['Status', input.status],
      ['Currency', code],
      ['Delivery date', input.deliveryDate ? fmtDate(input.deliveryDate) : ''],
      ['Incoterms', input.incoterms ?? ''],
      ...(taxed ? ([['Place of supply', input.taxBuyerState ?? input.buyer.state ?? '-']] as [string, string][]) : []),
      ['Against', input.proformaNumber ?? ''],
    ]
  );

  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const hsnW = hasHsn ? 44 : 0;
  const gstW = taxed ? 34 : 0;
  const cols: Col[] = [
    { key: 'i', title: '#', width: 22 },
    { key: 'code', title: 'Code', width: 74 },
    { key: 'desc', title: 'Description', width: usable - 22 - 74 - hsnW - gstW - 40 - 72 - 84 },
    ...(hasHsn ? [{ key: 'hsn', title: 'HSN', width: hsnW } as Col] : []),
    { key: 'qty', title: 'Qty', width: 40, align: 'right' },
    { key: 'rate', title: 'Unit Price', width: 72, align: 'right' },
    ...(taxed ? [{ key: 'gst', title: 'GST', width: gstW, align: 'right' } as Col] : []),
    { key: 'amt', title: 'Amount', width: 84, align: 'right' },
  ];
  const totalW = cols.reduce((a, c) => a + c.width, 0);
  const descCol = cols.find((c) => c.key === 'desc')!;

  let y = tableHeader(doc, cols, doc.y);
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 30;

  input.lines.forEach((l, idx) => {
    const off = [(l.discountPct ?? 0) > 0 ? `${l.discountPct}% off` : '', (l.discountAmt ?? 0) > 0 ? `less ${amount(l.discountAmt, code)}` : ''].filter(Boolean).join(', ');
    const descText = safe(l.description) + (l.stageLine ? `\nRoute: ${safe(l.stageLine)}` : '') + (off ? `\n${safe(off)}` : '');
    doc.font('Helvetica').fontSize(9);
    const rowH = Math.max(20, doc.heightOfString(descText, { width: descCol.width - 10 }) + 12);

    if (y + rowH > bottomLimit()) {
      doc.addPage();
      y = tableHeader(doc, cols, doc.page.margins.top);
    }

    let x = doc.page.margins.left;
    const cell = (c: Col, text: string, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#000000');
      doc.text(text, x + 5, y + 6, { width: c.width - 10, align: c.align ?? 'left' });
    };
    for (const c of cols) {
      if (c.key === 'i') cell(c, String(idx + 1));
      else if (c.key === 'code') cell(c, safe(l.productCode));
      else if (c.key === 'desc') cell(c, descText);
      else if (c.key === 'hsn') cell(c, safe(l.hsnCode ?? ''));
      else if (c.key === 'qty') cell(c, String(l.qty));
      else if (c.key === 'rate') cell(c, amount(l.unitPrice, code));
      else if (c.key === 'gst') cell(c, `${l.gstRatePct ?? 0}%`);
      else cell(c, amount(lineNet(l), code), true);
      x += c.width;
    }
    y += rowH;
    hline(doc, y, totalW);
  });

  y = totalsStack(doc, totals, code, y, totalW, bottomLimit);
  doc.y = y + 12;

  const half = usable / 2 - 10;
  if (input.paymentTerms) {
    doc.font('Helvetica-Bold').fontSize(8.5).text('Payment terms', doc.page.margins.left, doc.y, { width: half });
    doc.font('Helvetica').fontSize(9).text(safe(input.paymentTerms), doc.page.margins.left, doc.y, { width: half });
  }
  if (input.notes) {
    doc.font('Helvetica-Bold').fontSize(8.5).text('Notes', doc.page.margins.left, doc.y + 4, { width: half });
    doc.font('Helvetica').fontSize(9).text(safe(input.notes), doc.page.margins.left, doc.y, { width: half });
  }

  doc.y += 30;
  if (doc.y > bottomLimit()) doc.addPage();
  doc.font('Helvetica').fontSize(9).text(`For ${safe(input.company.legalName)}`, doc.page.margins.left + usable - 200, doc.y, { width: 200, align: 'right' });
  doc.fillColor(GREY).text('Authorised Signatory', doc.page.margins.left + usable - 200, doc.y + 26, { width: 200, align: 'right' });

  return finish(doc, out);
}

// ---------------------------------------------------------------------------
// Material sheet
// ---------------------------------------------------------------------------

export interface SheetPdfInput {
  number: string;
  date: Date | string;
  company: CompanyProfile;
  product: { factoryCode: string; name: string; unit?: string | null };
  orderNumber?: string | null;
  buyerName?: string | null;
  qty: number;
  currencyCode: string;
  explosion: {
    groups: { head: string; name: string; method: string; total: number; orderTotal: number; lines: { name: string; unit?: string | null; measure: number; amount: number; orderMeasure: number; orderAmount: number }[] }[];
    order: { qty: number; headTotals: Record<string, number>; exFactory: number; forwarding: number; fob: number; nonFob: number };
  };
}

/**
 * What to buy and cut for one product × quantity — the costing explosion as a working
 * sheet. Per-piece figures sit beside the order-quantity ones, because the floor needs
 * both: one to check a cut, the other to raise a purchase.
 */
export async function sheetPdf(input: SheetPdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 46, left: 40, right: 40 } });
  const out = collect(doc);
  const code = input.currencyCode || 'INR';

  letterhead(doc, input.company, 'MATERIAL SHEET', input.number, input.date);

  partyBlock(
    doc,
    'PRODUCT',
    [`${input.product.factoryCode} - ${input.product.name}`, input.product.unit ? `Unit: ${input.product.unit}` : ''].filter(Boolean) as string[],
    [
      ['Quantity', `${input.qty}`],
      ['Order', input.orderNumber ?? ''],
      ['Buyer', input.buyerName ?? ''],
    ]
  );

  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cols: Col[] = [
    { key: 'name', title: 'Item', width: usable - 52 - 62 - 68 - 68 - 76 },
    { key: 'unit', title: 'Unit', width: 52 },
    { key: 'measure', title: 'Per pc', width: 62, align: 'right' },
    { key: 'amount', title: 'Rs / pc', width: 68, align: 'right' },
    { key: 'omeasure', title: `For ${input.qty}`, width: 68, align: 'right' },
    { key: 'oamount', title: 'Total', width: 76, align: 'right' },
  ];
  const totalW = cols.reduce((a, c) => a + c.width, 0);
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 30;

  let y = doc.y;
  for (const g of input.explosion.groups) {
    if (g.lines.length === 0) continue;

    if (y + 60 > bottomLimit()) {
      doc.addPage();
      y = doc.page.margins.top;
    }

    // One band per cost group, naming the head and how it is measured.
    doc.font('Helvetica-Bold').fontSize(9).fillColor(BROWN);
    doc.text(`${safe(g.name)}  (${safe(g.head.replace(/_/g, ' '))} - ${safe(g.method)})`, doc.page.margins.left, y);
    doc.fillColor('#000000');
    y = doc.y + 3;
    y = tableHeader(doc, cols, y);

    for (const l of g.lines) {
      if (y + 18 > bottomLimit()) {
        doc.addPage();
        y = tableHeader(doc, cols, doc.page.margins.top);
      }
      let x = doc.page.margins.left;
      const cell = (c: Col, text: string, bold = false) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor('#000000');
        doc.text(text, x + 5, y + 5, { width: c.width - 10, align: c.align ?? 'left' });
      };
      for (const c of cols) {
        if (c.key === 'name') cell(c, safe(l.name));
        else if (c.key === 'unit') cell(c, safe(l.unit ?? ''));
        else if (c.key === 'measure') cell(c, String(l.measure));
        else if (c.key === 'amount') cell(c, amount(l.amount, code, 2));
        else if (c.key === 'omeasure') cell(c, String(l.orderMeasure));
        else cell(c, amount(l.orderAmount, code, 2), true);
        x += c.width;
      }
      y += 18;
      hline(doc, y, totalW);
    }

    // Group subtotal. Needs its own check: the per-line guard above lets `y` finish just
    // under the limit, and an unchecked 18 pt band then prints into the bottom margin.
    if (y + 18 > bottomLimit()) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc.rect(doc.page.margins.left, y, totalW, 18).fill(LIGHT);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BROWN);
    doc.text(`${safe(g.name)} subtotal`, doc.page.margins.left + 5, y + 5, { width: totalW - 170, align: 'right' });
    doc.text(amount(g.total, code), doc.page.margins.left + totalW - 160, y + 5, { width: 76, align: 'right' });
    doc.text(amount(g.orderTotal, code), doc.page.margins.left + totalW - 81, y + 5, { width: 76, align: 'right' });
    doc.fillColor('#000000');
    y += 26;
  }

  // Head totals for the whole sheet.
  if (y + 120 > bottomLimit()) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.font('Helvetica-Bold').fontSize(10).fillColor(BROWN).text('Totals', doc.page.margins.left, y);
  doc.fillColor('#000000');
  y = doc.y + 4;

  const row = (label: string, value: number, bold = false) => {
    if (y + 16 > bottomLimit()) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 9).fillColor(bold ? BROWN : '#000000');
    doc.text(safe(label), doc.page.margins.left + 5, y, { width: totalW - 100, align: 'right' });
    doc.text(amount(value, code), doc.page.margins.left + totalW - 90, y, { width: 85, align: 'right' });
    doc.fillColor('#000000');
    y += bold ? 18 : 15;
  };

  for (const [head, value] of Object.entries(input.explosion.order.headTotals)) {
    if (!value) continue;
    row(head.replace(/_/g, ' '), value);
  }
  row(`Ex-factory for ${input.qty}`, input.explosion.order.exFactory, true);
  if (input.explosion.order.forwarding) row('Forwarding', input.explosion.order.forwarding);
  row(`FOB for ${input.qty}`, input.explosion.order.fob, true);

  doc.y = y + 20;
  doc.font('Helvetica').fontSize(8).fillColor(GREY).text(
    safe('Quantities are the costed explosion, wastage included where the formula allows for it. Check against stock before raising a purchase.'),
    doc.page.margins.left,
    doc.y,
    { width: usable }
  );
  doc.fillColor('#000000');

  return finish(doc, out);
}

// ---------------------------------------------------------------------------
// Commercial / tax invoice
//
// Titled by market — a domestic sale issues a TAX INVOICE under GST, an export a
// COMMERCIAL INVOICE, which is a customs document and carries no tax. Its money comes from
// `documentTotals()` exactly as the proforma's does, so the printed grand total is the same
// figure the order page, the FIFO buckets and the dashboard read.
// ---------------------------------------------------------------------------

export interface InvoicePdfLine {
  description: string;
  qty: number;
  unitPrice: number;
  productCode?: string | null;
  unit?: string | null;
  discountPct?: number | null;
  discountAmt?: number | null;
  gstRatePct?: number | null;
  hsnCode?: string | null;
  orderNumber?: string | null;
}

export interface InvoicePdfInput {
  number: string;
  date: Date | string;
  dueDate?: Date | string | null;
  currencyCode: string;
  company: CompanyProfile;
  buyer: ProformaPdfInput['buyer'];
  incoterms?: string | null;
  paymentTerms?: string | null;
  bankDetails?: string | null;
  notes?: string | null;
  placeOfSupply?: string | null;
  reverseCharge?: boolean;
  irn?: string | null;
  ackNo?: string | null;
  /** Export customs detail, printed only when present. */
  shipment?: {
    number?: string | null;
    shipDate?: Date | string | null;
    shippingBillNo?: string | null;
    portOfLoading?: string | null;
    portOfDischarge?: string | null;
    finalDestination?: string | null;
    vesselOrFlight?: string | null;
    blAwbNo?: string | null;
    transporterName?: string | null;
    vehicleNo?: string | null;
    ewayBillNo?: string | null;
  } | null;
  lines: InvoicePdfLine[];
  charges?: PricedCharge[] | null;
}

export async function invoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 46, left: 40, right: 40 } });
  const out = collect(doc);
  const code = input.currencyCode || 'INR';

  // One call to the pricing engine decides everything: the subtotal, the charges, whether
  // tax applies at all and how it splits. The PDF never does its own arithmetic.
  const totals = documentTotals(input.lines, input.charges ?? [], {
    market: input.buyer.market ?? 'OVERSEAS',
    buyerState: input.buyer.state ?? null,
    companyState: input.company.state ?? null,
  });
  const taxed = totals.taxed;
  const title = taxed ? 'TAX INVOICE' : 'COMMERCIAL INVOICE';

  letterhead(doc, input.company, title, input.number, input.date);

  const s = input.shipment;
  partyBlock(
    doc,
    taxed ? 'BILL TO' : 'BUYER / CONSIGNEE',
    [
      input.buyer.name,
      input.buyer.contactName ? `Attn: ${input.buyer.contactName}` : '',
      ...(input.buyer.address ? input.buyer.address.split('\n') : []),
      [input.buyer.state, input.buyer.country].filter(Boolean).join(', '),
      input.buyer.email ?? '',
      input.buyer.gstNo ? `GSTIN: ${input.buyer.gstNo}` : '',
    ].filter(Boolean) as string[],
    [
      ['Currency', code],
      ['Due date', input.dueDate ? fmtDate(input.dueDate) : ''],
      ['Terms', input.paymentTerms ?? ''],
      ...(!taxed ? ([['Incoterms', input.incoterms ?? '']] as [string, string][]) : []),
      ...(taxed ? ([['Place of supply', input.placeOfSupply ?? '']] as [string, string][]) : []),
      ...(taxed && input.reverseCharge ? ([['Reverse charge', 'Yes']] as [string, string][]) : []),
      ...(taxed && input.irn ? ([['IRN', input.irn]] as [string, string][]) : []),
      ...(taxed && input.ackNo ? ([['Ack no.', input.ackNo]] as [string, string][]) : []),
      ...(s?.number ? ([['Dispatch', s.number]] as [string, string][]) : []),
      ...(s?.shipDate ? ([['Shipped', fmtDate(s.shipDate)]] as [string, string][]) : []),
    ]
  );

  // Customs and carriage detail as its own strip, so it cannot crowd the party block.
  const detail: [string, string][] = taxed
    ? [
        ['Transporter', s?.transporterName ?? ''],
        ['Vehicle', s?.vehicleNo ?? ''],
        ['E-way bill', s?.ewayBillNo ?? ''],
      ]
    : [
        ['Shipping bill', s?.shippingBillNo ?? ''],
        ['Port of loading', s?.portOfLoading ?? ''],
        ['Port of discharge', s?.portOfDischarge ?? ''],
        ['Final destination', s?.finalDestination ?? ''],
        ['Vessel / flight', s?.vesselOrFlight ?? ''],
        ['BL / AWB', s?.blAwbNo ?? ''],
      ];
  const shown = detail.filter(([, v]) => v);
  if (shown.length) {
    const left = doc.page.margins.left;
    const w = doc.page.width - left - doc.page.margins.right;
    const per = w / 3;
    let rowTop = doc.y;
    let col = 0;
    for (const [k, v] of shown) {
      const x = left + (col % 3) * per;
      doc.font('Helvetica').fontSize(7.5).fillColor(GREY).text(safe(k), x, rowTop, { width: per - 8 });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text(safe(v), x, doc.y, { width: per - 8 });
      col++;
      if (col % 3 === 0) rowTop = doc.y + 4;
    }
    doc.y = Math.max(doc.y, rowTop) + 12;
    doc.fillColor('#000000');
  }

  const totalW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cols: Col[] = taxed
    ? [
        { key: 'i', title: '#', width: 22, align: 'right' },
        { key: 'desc', title: 'Description', width: totalW - 22 - 52 - 40 - 38 - 74 - 34 - 84 },
        { key: 'hsn', title: 'HSN', width: 52 },
        { key: 'qty', title: 'Qty', width: 40, align: 'right' },
        { key: 'unit', title: 'Unit', width: 38 },
        { key: 'rate', title: 'Rate', width: 74, align: 'right' },
        { key: 'gst', title: 'GST', width: 34, align: 'right' },
        { key: 'amt', title: 'Amount', width: 84, align: 'right' },
      ]
    : [
        { key: 'i', title: '#', width: 22, align: 'right' },
        { key: 'desc', title: 'Description', width: totalW - 22 - 46 - 40 - 38 - 84 - 92 },
        { key: 'hsn', title: 'HSN', width: 46 },
        { key: 'qty', title: 'Qty', width: 40, align: 'right' },
        { key: 'unit', title: 'Unit', width: 38 },
        { key: 'rate', title: 'Rate', width: 84, align: 'right' },
        { key: 'amt', title: 'Amount', width: 92, align: 'right' },
      ];

  const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 30;
  let y = tableHeader(doc, cols, doc.y);

  input.lines.forEach((l, idx) => {
    const desc = [l.productCode ? `${l.productCode} - ${l.description}` : l.description, l.orderNumber ? `Order ${l.orderNumber}` : '']
      .filter(Boolean)
      .join('\n');
    const rowH = Math.max(24, doc.font('Helvetica').fontSize(9).heightOfString(safe(desc), { width: cols[1].width - 10 }) + 12);
    if (y + rowH > bottomLimit()) {
      doc.addPage();
      y = tableHeader(doc, cols, doc.page.margins.top);
    }
    // The engine's own line maths, so a printed line cannot disagree with the subtotal.
    const amt = lineNet(l);
    let x = doc.page.margins.left;
    const cell = (c: Col, text: string, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#000000');
      doc.text(safe(text), x + 5, y + 6, { width: c.width - 10, align: c.align ?? 'left' });
    };
    for (const c of cols) {
      if (c.key === 'i') cell(c, String(idx + 1));
      else if (c.key === 'desc') cell(c, desc);
      else if (c.key === 'hsn') cell(c, l.hsnCode ?? '');
      else if (c.key === 'qty') cell(c, String(l.qty));
      else if (c.key === 'unit') cell(c, l.unit ?? 'PCS');
      else if (c.key === 'rate') cell(c, amount(l.unitPrice, code));
      else if (c.key === 'gst') cell(c, `${l.gstRatePct ?? 0}%`);
      else cell(c, amount(amt, code), true);
      x += c.width;
    }
    y += rowH;
    hline(doc, y, totalW);
  });

  y = totalsStack(doc, totals, code, y, totalW, bottomLimit);
  doc.y = y + 14;

  if (!taxed) {
    doc.font('Helvetica').fontSize(8).fillColor(GREY);
    doc.text(safe('Supply meant for export - zero rated. No GST is charged on this invoice.'), doc.page.margins.left, doc.y, { width: totalW });
    doc.y += 6;
  }
  for (const [heading, body] of [
    ['BANK DETAILS', input.bankDetails],
    ['NOTES', input.notes],
  ] as [string, string | null | undefined][]) {
    if (!body) continue;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(BROWN).text(heading, doc.page.margins.left, doc.y + 4);
    doc.font('Helvetica').fontSize(8.5).fillColor('#000000').text(safe(body), doc.page.margins.left, doc.y, { width: totalW });
  }

  doc.font('Helvetica').fontSize(8).fillColor(GREY);
  doc.text(safe(`For ${input.company.legalName}`), doc.page.margins.left, doc.y + 26, { width: totalW, align: 'right' });
  doc.text(safe('Authorised signatory'), doc.page.margins.left, doc.y + 4, { width: totalW, align: 'right' });

  return finish(doc, out);
}

// ---------------------------------------------------------------------------
// Packing list, VGM, container annexure, certificate of origin
//
// These carry NO MONEY at all — a shipment is fulfilment, an invoice is money. Every figure
// on them comes from the shipping engine, so a carton count or a CBM here is the same one
// the shipment page showed.
// ---------------------------------------------------------------------------

export interface ShipmentPdfLine {
  productCode?: string | null;
  description: string;
  orderNumber?: string | null;
  buyerName?: string | null;
  shippingMarks?: string | null;
  cartons: number;
  qty: number;
  netKg: number;
  grossKg: number;
  cbm: number;
  containerNo?: string | null;
  hsnCode?: string | null;
}

export interface ShipmentPdfContainer {
  code: string;
  containerNo?: string | null;
  sealNo?: string | null;
  tareWeightKg?: number | null;
  cartons: number;
  netKg: number;
  grossKg: number;
  cbm: number;
  vgmKg: number;
  capacityCbm: number;
  payloadKg: number;
  cbmPct: number;
  kgPct: number;
}

export interface ShipmentPdfInput {
  number: string;
  date: Date | string;
  company: CompanyProfile;
  status: string;
  shippingBillNo?: string | null;
  portOfLoading?: string | null;
  portOfDischarge?: string | null;
  finalDestination?: string | null;
  vesselOrFlight?: string | null;
  blAwbNo?: string | null;
  buyerNames: string[];
  orderNumbers: string[];
  totals: { cartons: number; pieces: number; cbm: number; netKg: number; grossKg: number };
  containers: ShipmentPdfContainer[];
  lines: ShipmentPdfLine[];
  notes?: string | null;
}

/** The shared header for all four shipment documents. */
function shipmentHead(doc: Doc, input: ShipmentPdfInput, title: string) {
  letterhead(doc, input.company, title, input.number, input.date);
  partyBlock(doc, 'CONSIGNEE(S)', input.buyerNames.length ? input.buyerNames : ['-'], [
    ['Orders', input.orderNumbers.join(', ')],
    ['Shipping bill', input.shippingBillNo ?? ''],
    ['Port of loading', input.portOfLoading ?? ''],
    ['Port of discharge', input.portOfDischarge ?? ''],
    ['Final destination', input.finalDestination ?? ''],
    ['Vessel / flight', input.vesselOrFlight ?? ''],
    ['BL / AWB', input.blAwbNo ?? ''],
  ]);
}

const num = (v: number, dp = 2) => (isFinite(v) ? v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '-');

export async function packingListPdf(input: ShipmentPdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 40, bottom: 46, left: 40, right: 40 } });
  const out = collect(doc);
  shipmentHead(doc, input, 'PACKING LIST');

  const totalW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cols: Col[] = [
    { key: 'i', title: '#', width: 22, align: 'right' },
    { key: 'desc', title: 'Description', width: totalW - 22 - 74 - 74 - 46 - 50 - 44 - 64 - 64 - 56 },
    { key: 'order', title: 'Order', width: 74 },
    { key: 'marks', title: 'Marks', width: 74 },
    { key: 'hsn', title: 'HSN', width: 46 },
    { key: 'ctn', title: 'Cartons', width: 50, align: 'right' },
    { key: 'qty', title: 'Pcs', width: 44, align: 'right' },
    { key: 'net', title: 'Net kg', width: 64, align: 'right' },
    { key: 'gross', title: 'Gross kg', width: 64, align: 'right' },
    { key: 'cbm', title: 'CBM', width: 56, align: 'right' },
  ];
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 40;
  let y = tableHeader(doc, cols, doc.y);

  input.lines.forEach((l, idx) => {
    const desc = l.productCode ? `${l.productCode} - ${l.description}` : l.description;
    const rowH = Math.max(20, doc.font('Helvetica').fontSize(8.5).heightOfString(safe(desc), { width: cols[1].width - 10 }) + 10);
    if (y + rowH > bottomLimit()) {
      doc.addPage();
      y = tableHeader(doc, cols, doc.page.margins.top);
    }
    let x = doc.page.margins.left;
    const cell = (c: Col, text: string) => {
      doc.font('Helvetica').fontSize(8.5).fillColor('#000000');
      doc.text(safe(text), x + 5, y + 5, { width: c.width - 10, align: c.align ?? 'left' });
    };
    for (const c of cols) {
      if (c.key === 'i') cell(c, String(idx + 1));
      else if (c.key === 'desc') cell(c, desc);
      else if (c.key === 'order') cell(c, l.orderNumber ?? '');
      else if (c.key === 'marks') cell(c, l.shippingMarks ?? '');
      else if (c.key === 'hsn') cell(c, l.hsnCode ?? '');
      else if (c.key === 'ctn') cell(c, String(l.cartons));
      else if (c.key === 'qty') cell(c, String(l.qty));
      else if (c.key === 'net') cell(c, num(l.netKg));
      else if (c.key === 'gross') cell(c, num(l.grossKg));
      else cell(c, num(l.cbm, 4));
      x += c.width;
    }
    y += rowH;
    hline(doc, y, totalW);
  });

  // The totals row comes from the engine — never a sum of what was printed above.
  if (y + 24 > bottomLimit()) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.rect(doc.page.margins.left, y, totalW, 22).fill(LIGHT);
  let tx = doc.page.margins.left;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(BROWN);
  for (const c of cols) {
    const text =
      c.key === 'desc'
        ? 'TOTAL'
        : c.key === 'ctn'
          ? String(input.totals.cartons)
          : c.key === 'qty'
            ? String(input.totals.pieces)
            : c.key === 'net'
              ? num(input.totals.netKg)
              : c.key === 'gross'
                ? num(input.totals.grossKg)
                : c.key === 'cbm'
                  ? num(input.totals.cbm, 4)
                  : '';
    if (text) doc.text(safe(text), tx + 5, y + 6, { width: c.width - 10, align: c.align ?? 'left' });
    tx += c.width;
  }
  doc.fillColor('#000000');
  doc.y = y + 34;

  if (input.notes) doc.font('Helvetica').fontSize(8.5).text(safe(input.notes), doc.page.margins.left, doc.y, { width: totalW });
  return finish(doc, out);
}

/**
 * Verified gross mass. `vgmKg` is always tare + the derived cargo gross — it is never
 * stored, so this declaration cannot contradict the packing list it travels with.
 */
export async function vgmPdf(input: ShipmentPdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 46, left: 40, right: 40 } });
  const out = collect(doc);
  shipmentHead(doc, input, 'VERIFIED GROSS MASS');

  const totalW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cols: Col[] = [
    { key: 'ctr', title: 'Container', width: 96 },
    { key: 'type', title: 'Type', width: 56 },
    { key: 'seal', title: 'Seal', width: 78 },
    { key: 'ctn', title: 'Cartons', width: 54, align: 'right' },
    { key: 'cargo', title: 'Cargo kg', width: 72, align: 'right' },
    { key: 'tare', title: 'Tare kg', width: 68, align: 'right' },
    { key: 'vgm', title: 'VGM kg', width: totalW - 96 - 56 - 78 - 54 - 72 - 68, align: 'right' },
  ];
  let y = tableHeader(doc, cols, doc.y);

  for (const c of input.containers) {
    let x = doc.page.margins.left;
    const cell = (col: Col, text: string, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#000000');
      doc.text(safe(text), x + 5, y + 6, { width: col.width - 10, align: col.align ?? 'left' });
    };
    for (const col of cols) {
      if (col.key === 'ctr') cell(col, c.containerNo || '(not numbered)');
      else if (col.key === 'type') cell(col, c.code);
      else if (col.key === 'seal') cell(col, c.sealNo ?? '');
      else if (col.key === 'ctn') cell(col, String(c.cartons));
      else if (col.key === 'cargo') cell(col, num(c.grossKg));
      else if (col.key === 'tare') cell(col, num(c.tareWeightKg ?? 0));
      else cell(col, num(c.vgmKg), true);
      x += col.width;
    }
    y += 22;
    hline(doc, y, totalW);
  }
  doc.y = y + 18;

  doc.font('Helvetica').fontSize(8.5).fillColor('#000000');
  doc.text(
    safe(
      'The gross mass above is the container tare plus the derived cargo gross, declared under SOLAS Chapter VI Regulation 2, Method 2 (calculated).'
    ),
    doc.page.margins.left,
    doc.y,
    { width: totalW }
  );
  doc.text(safe(`For ${input.company.legalName}`), doc.page.margins.left, doc.y + 30, { width: totalW, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(GREY).text(safe('Authorised signatory'), doc.page.margins.left, doc.y + 4, { width: totalW, align: 'right' });
  return finish(doc, out);
}

/** What is in each box, container by container. */
export async function containerAnnexurePdf(input: ShipmentPdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 46, left: 40, right: 40 } });
  const out = collect(doc);
  shipmentHead(doc, input, 'CONTAINER ANNEXURE');

  const totalW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 30;

  const groups: { label: string; sub: string; lines: ShipmentPdfLine[] }[] = input.containers.map((c) => ({
    label: `${c.containerNo || '(not numbered)'} - ${c.code}`,
    sub: `${c.cartons} carton(s) - ${num(c.cbm, 3)} CBM${c.capacityCbm > 0 ? ` of ${num(c.capacityCbm, 0)} (${num(c.cbmPct, 0)}%)` : ''} - gross ${num(c.grossKg)} kg - VGM ${num(c.vgmKg)} kg`,
    lines: input.lines.filter((l) => (l.containerNo ?? null) === (c.containerNo ?? null)),
  }));
  // Cartons nobody has put in a box: an LCL part load may stay that way, and leaving them
  // out would make this annexure disagree with the packing list.
  const loose = input.lines.filter((l) => !l.containerNo);
  if (loose.length && !input.containers.some((c) => !c.containerNo)) {
    groups.push({ label: 'NOT IN A CONTAINER', sub: 'Part load / LCL', lines: loose });
  }

  for (const g of groups) {
    if (doc.y + 60 > bottomLimit()) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(BROWN).text(safe(g.label), doc.page.margins.left, doc.y + 6);
    doc.font('Helvetica').fontSize(8).fillColor(GREY).text(safe(g.sub), doc.page.margins.left, doc.y, { width: totalW });
    doc.fillColor('#000000');
    doc.y += 6;

    const cols: Col[] = [
      { key: 'desc', title: 'Description', width: totalW - 80 - 56 - 44 - 70 - 56 },
      { key: 'order', title: 'Order', width: 80 },
      { key: 'marks', title: 'Marks', width: 56 },
      { key: 'ctn', title: 'Ctns', width: 44, align: 'right' },
      { key: 'gross', title: 'Gross kg', width: 70, align: 'right' },
      { key: 'cbm', title: 'CBM', width: 56, align: 'right' },
    ];
    let y = tableHeader(doc, cols, doc.y);
    for (const l of g.lines) {
      if (y + 20 > bottomLimit()) {
        doc.addPage();
        y = tableHeader(doc, cols, doc.page.margins.top);
      }
      let x = doc.page.margins.left;
      const cell = (c: Col, text: string) => {
        doc.font('Helvetica').fontSize(8.5).fillColor('#000000');
        doc.text(safe(text), x + 5, y + 5, { width: c.width - 10, align: c.align ?? 'left' });
      };
      for (const c of cols) {
        if (c.key === 'desc') cell(c, l.productCode ? `${l.productCode} - ${l.description}` : l.description);
        else if (c.key === 'order') cell(c, l.orderNumber ?? '');
        else if (c.key === 'marks') cell(c, l.shippingMarks ?? '');
        else if (c.key === 'ctn') cell(c, String(l.cartons));
        else if (c.key === 'gross') cell(c, num(l.grossKg));
        else cell(c, num(l.cbm, 4));
        x += c.width;
      }
      y += 20;
      hline(doc, y, totalW);
    }
    doc.y = y + 12;
  }
  return finish(doc, out);
}

/** A certificate-of-origin style annexure. Declarative — it carries no money. */
export async function certificateOfOriginPdf(input: ShipmentPdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 46, left: 40, right: 40 } });
  const out = collect(doc);
  shipmentHead(doc, input, 'CERTIFICATE OF ORIGIN');

  const totalW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cols: Col[] = [
    { key: 'i', title: '#', width: 22, align: 'right' },
    { key: 'desc', title: 'Description of goods', width: totalW - 22 - 56 - 50 - 46 - 70 },
    { key: 'hsn', title: 'HSN', width: 56 },
    { key: 'ctn', title: 'Ctns', width: 50, align: 'right' },
    { key: 'qty', title: 'Pcs', width: 46, align: 'right' },
    { key: 'gross', title: 'Gross kg', width: 70, align: 'right' },
  ];
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 90;
  let y = tableHeader(doc, cols, doc.y);

  input.lines.forEach((l, idx) => {
    if (y + 20 > bottomLimit()) {
      doc.addPage();
      y = tableHeader(doc, cols, doc.page.margins.top);
    }
    let x = doc.page.margins.left;
    const cell = (c: Col, text: string) => {
      doc.font('Helvetica').fontSize(8.5).fillColor('#000000');
      doc.text(safe(text), x + 5, y + 5, { width: c.width - 10, align: c.align ?? 'left' });
    };
    for (const c of cols) {
      if (c.key === 'i') cell(c, String(idx + 1));
      else if (c.key === 'desc') cell(c, l.productCode ? `${l.productCode} - ${l.description}` : l.description);
      else if (c.key === 'hsn') cell(c, l.hsnCode ?? '');
      else if (c.key === 'ctn') cell(c, String(l.cartons));
      else if (c.key === 'qty') cell(c, String(l.qty));
      else cell(c, num(l.grossKg));
      x += c.width;
    }
    y += 20;
    hline(doc, y, totalW);
  });

  doc.y = y + 18;
  doc.font('Helvetica').fontSize(9).fillColor('#000000');
  doc.text(
    safe(
      `We hereby certify that the goods described above are of Indian origin, manufactured by ${input.company.legalName}${
        input.company.city ? `, ${input.company.city}` : ''
      }, India, and that the particulars given are true and correct.`
    ),
    doc.page.margins.left,
    doc.y,
    { width: totalW }
  );
  doc.text(safe(`For ${input.company.legalName}`), doc.page.margins.left, doc.y + 34, { width: totalW, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(GREY).text(safe('Authorised signatory'), doc.page.margins.left, doc.y + 4, { width: totalW, align: 'right' });
  return finish(doc, out);
}
