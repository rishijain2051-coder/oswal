/**
 * E-mail draft generation.
 *
 * WHY A .eml FILE: the `mailto:` URI scheme has no attachment field — no browser
 * or mail client will attach a file from a link, by design. So to hand the user a
 * ready-to-send message WITH the PI PDF already attached, we build a real RFC 5322
 * message and let them open it in their default mail app. The `X-Unsent: 1` header
 * is what makes Outlook / Windows Mail open it as an editable draft in the compose
 * window instead of as a received message.
 *
 * A plain `mailto:` link (subject + body, no attachment) is still offered
 * alongside it for people who send from webmail.
 */
import { type CompanyProfile } from './company';

const CRLF = '\r\n';

/** RFC 2047 encoded-word, only when the value actually needs it. */
function encodeHeader(value: string): string {
  const v = value.replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  // Chunk on raw bytes so a multi-byte character is never split across words.
  const bytes = Buffer.from(v, 'utf8');
  const words: string[] = [];
  const maxBytes = 42; // base64-expands to <= 56 chars, well inside the 75-char limit
  for (let i = 0; i < bytes.length; ) {
    let end = Math.min(i + maxBytes, bytes.length);
    // Do not split in the middle of a UTF-8 sequence.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    words.push(`=?UTF-8?B?${bytes.subarray(i, end).toString('base64')}?=`);
    i = end;
  }
  return words.join(`${CRLF} `);
}

function base64Lines(buf: Buffer): string {
  return (buf.toString('base64').match(/.{1,76}/g) ?? []).join(CRLF);
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface MailDraft {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html: string;
  attachments?: MailAttachment[];
}

/** Build an .eml message: multipart/mixed > (multipart/alternative, attachments). */
export function buildEml(m: MailDraft): string {
  const stamp = Date.now().toString(36);
  const outer = `----=_oswal_mixed_${stamp}`;
  const inner = `----=_oswal_alt_${stamp}`;
  const atts = m.attachments ?? [];

  const head: string[] = [];
  if (m.to.length) head.push(`To: ${m.to.map(encodeHeader).join(', ')}`);
  if (m.cc?.length) head.push(`Cc: ${m.cc.map(encodeHeader).join(', ')}`);
  head.push(`Subject: ${encodeHeader(m.subject)}`);
  head.push(`Date: ${new Date().toUTCString()}`);
  head.push('X-Unsent: 1'); // open as an editable draft, not as a received mail
  head.push('MIME-Version: 1.0');
  head.push(`Content-Type: multipart/mixed; boundary="${outer}"`);

  const body: string[] = [];
  body.push(`--${outer}`);
  body.push(`Content-Type: multipart/alternative; boundary="${inner}"`, '');
  body.push(`--${inner}`);
  body.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64Lines(Buffer.from(m.text, 'utf8')));
  body.push(`--${inner}`);
  body.push('Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64Lines(Buffer.from(m.html, 'utf8')));
  body.push(`--${inner}--`, '');

  for (const a of atts) {
    body.push(`--${outer}`);
    body.push(`Content-Type: ${a.contentType}; name="${a.filename}"`);
    body.push('Content-Transfer-Encoding: base64');
    body.push(`Content-Disposition: attachment; filename="${a.filename}"`, '');
    body.push(base64Lines(a.content), '');
  }

  body.push(`--${outer}--`, '');
  return [...head, '', ...body].join(CRLF);
}

/** A `mailto:` URL (subject + body only — attachments are impossible here). */
export function mailtoUrl(to: string[], subject: string, text: string, cc?: string[]): string {
  const params = new URLSearchParams();
  params.set('subject', subject);
  params.set('body', text);
  if (cc?.length) params.set('cc', cc.join(','));
  return `mailto:${to.join(',')}?${params.toString().replace(/\+/g, '%20')}`;
}

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '';
  const date = new Date(d);
  return isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const money = (v: number, code: string) => `${code} ${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface ProformaMailInput {
  number: string;
  date: Date | string;
  validUntil?: Date | string | null;
  currencyCode: string;
  total: number;
  incoterms?: string | null;
  paymentTerms?: string | null;
  deliveryTerms?: string | null;
  buyer: { name: string; contactName?: string | null; email?: string | null; market?: string | null };
  /**
   * `amount` is the line NET, straight from the pricing engine. The body must never
   * recompute qty x unitPrice: on a discounted or taxed document that prints a figure
   * the attached PDF contradicts, in the same message.
   */
  lines: { description: string; qty: number; unitPrice: number; amount: number }[];
  /** Subtotal, charges and the tax split, so the body explains its own total. */
  totals?: { subtotal: number; chargeTotal: number; taxTotal: number; cgst: number; sgst: number; igst: number; taxed: boolean; intraState: boolean } | null;
  senderName?: string | null;
  /** Us — the sign-off and the subject line. */
  company: CompanyProfile;
}

/** Subject + plain-text + HTML body for "here is your proforma invoice". */
export function proformaMail(p: ProformaMailInput): { subject: string; text: string; html: string } {
  const code = p.currencyCode || 'INR';
  const greeting = p.buyer.contactName ? `Dear ${p.buyer.contactName},` : `Dear Sir / Madam,`;
  const facts: [string, string][] = [
    [`${p.buyer.market === 'DOMESTIC' ? 'Quotation' : 'Proforma'} No.`, p.number],
    ['Date', fmtDate(p.date)],
    ['Items', String(p.lines.length)],
    ['Total value', money(p.total, code)],
    ['Valid until', p.validUntil ? fmtDate(p.validUntil) : ''],
    ['Incoterms', p.incoterms ?? ''],
    ['Payment terms', p.paymentTerms ?? ''],
    ['Delivery terms', p.deliveryTerms ?? ''],
  ].filter(([, v]) => !!v) as [string, string][];

  // A domestic buyer gets a quotation, not a proforma invoice.
  const docLabel = p.buyer.market === 'DOMESTIC' ? 'Quotation' : 'Proforma Invoice';
  const subject = `${docLabel} ${p.number} — ${p.company.legalName}`;
  const signOff = [p.senderName || '', p.company.legalName, p.company.phone, p.company.email, p.company.website].filter(Boolean);

  // Rows between the lines and the total, so the difference is never unexplained.
  const t = p.totals;
  const summaryLines: [string, string][] = [];
  if (t && (t.chargeTotal !== 0 || t.taxed)) {
    summaryLines.push(['Subtotal', money(t.subtotal, code)]);
    if (t.chargeTotal !== 0) summaryLines.push(['Charges / discounts', money(t.chargeTotal, code)]);
    if (t.taxed && t.taxTotal !== 0) {
      if (t.intraState) {
        summaryLines.push(['CGST', money(t.cgst, code)]);
        summaryLines.push(['SGST', money(t.sgst, code)]);
      } else {
        summaryLines.push(['IGST', money(t.igst, code)]);
      }
    }
  }

  const pad = Math.max(...facts.map(([k]) => k.length));
  const text = [
    greeting,
    '',
    `Please find attached our ${docLabel.toLowerCase()} ${p.number} for your kind review.`,
    '',
    ...facts.map(([k, v]) => `  ${k.padEnd(pad)}  :  ${v}`),
    '',
    'Item summary:',
    ...p.lines.map((l, i) => `  ${i + 1}. ${l.description} — ${l.qty} pcs @ ${money(l.unitPrice, code)} = ${money(l.amount, code)}`),
    ...summaryLines.map(([k, v]) => `     ${k.padStart(22)}  :  ${v}`),
    '',
    'Kindly confirm your acceptance so that we may schedule production and share the delivery plan.',
    '',
    'Warm regards,',
    ...signOff,
  ].join('\n');

  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">
<p>${esc(greeting)}</p>
<p>Please find attached our ${esc(docLabel.toLowerCase())} <b>${esc(p.number)}</b> for your kind review.</p>
<table cellpadding="4" cellspacing="0" style="font-size:13px;border-collapse:collapse">
${facts.map(([k, v]) => `<tr><td style="color:#777">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}
</table>
<p style="margin-bottom:4px"><b>Item summary</b></p>
<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#ddd;font-size:13px">
<tr style="background:#efebe9"><th align="left">#</th><th align="left">Description</th><th align="right">Qty</th><th align="right">Unit price</th><th align="right">Amount</th></tr>
${p.lines
  .map(
    (l, i) =>
      `<tr><td>${i + 1}</td><td>${esc(l.description)}</td><td align="right">${l.qty}</td><td align="right">${esc(money(l.unitPrice, code))}</td><td align="right"><b>${esc(
        money(l.amount, code)
      )}</b></td></tr>`
  )
  .join('')}
${summaryLines.map(([k, v]) => `<tr><td colspan="4" align="right" style="color:#777">${esc(k)}</td><td align="right">${esc(v)}</td></tr>`).join('')}
<tr><td colspan="4" align="right"><b>Total</b></td><td align="right"><b>${esc(money(p.total, code))}</b></td></tr>
</table>
<p>Kindly confirm your acceptance so that we may schedule production and share the delivery plan.</p>
<p style="margin-bottom:0">Warm regards,<br>${signOff.map(esc).join('<br>')}</p>
</body></html>`;

  return { subject, text, html };
}
