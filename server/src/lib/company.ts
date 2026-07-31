/**
 * Who WE are — the seller's own record, used on documents and for tax.
 *
 * This used to be read straight from `.env`. It is now a singleton row (id = 1) editable
 * in Master Data → Company, because one of its fields has real teeth: comparing `state`
 * with the buyer's is what decides CGST+SGST versus IGST, so the tax split is DERIVED
 * from the two addresses rather than typed. A value that decides money belongs in the
 * database with the rest of the configuration, not in an environment variable.
 *
 * The env values survive as the defaults the record is seeded with, so an existing
 * deployment keeps the letterhead it already had.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db';
import { uploadDir } from './imageUpload';

type Tx = Prisma.TransactionClient | PrismaClient;

/** Seed defaults. Only ever used to CREATE the record, never to override it. */
export const companyDefaults = {
  legalName: process.env.COMPANY_NAME || 'Saraswati Export',
  tradeName: process.env.COMPANY_TAGLINE || 'Furniture & Hardware Exporter',
  addressL1: process.env.COMPANY_ADDRESS || 'Jodhpur, Rajasthan, India',
  city: process.env.COMPANY_CITY || 'Jodhpur',
  state: process.env.COMPANY_STATE || 'Rajasthan',
  country: 'India',
  gstNo: process.env.COMPANY_GST || '',
  iecNo: process.env.COMPANY_IEC || '',
  panNo: process.env.COMPANY_PAN || '',
  email: process.env.COMPANY_EMAIL || '',
  phone: process.env.COMPANY_PHONE || '',
  website: process.env.COMPANY_WEBSITE || '',
};

export type CompanyProfile = Awaited<ReturnType<typeof ensureCompany>>;

/** Load the record, creating it from the env defaults the first time it is asked for. */
export async function ensureCompany(tx: Tx = prisma) {
  return tx.company.upsert({ where: { id: 1 }, update: {}, create: { id: 1, ...companyDefaults } });
}

/**
 * Our own state, for the tax split. Null when it has not been filled in, and
 * `sameState()` treats null as NOT a match — so an unconfigured company charges IGST
 * rather than silently under-collecting CGST+SGST on an inter-state sale.
 */
export async function companyState(tx: Tx = prisma): Promise<string | null> {
  return (await ensureCompany(tx)).state ?? null;
}

/** Absolute path of the letterhead logo, when one is set and still on disk. */
export function companyLogoPath(c: CompanyProfile): string | null {
  if (!c.logoFilename) return null;
  // Never trust the stored string as a path. Only the basename is used, so a value like
  // `../prisma/schema.prisma` can only ever resolve inside `uploads` — belt and braces beside
  // keeping the field out of the API schema.
  const safeName = path.basename(c.logoFilename);
  if (safeName !== c.logoFilename) return null;
  // pdfkit embeds JPEG and PNG only; anything else was accepted for the UI but cannot
  // be drawn, so the PDF simply falls back to the text letterhead.
  if (!/\.(jpe?g|png)$/i.test(safeName)) return null;
  const full = path.join(uploadDir, safeName);
  return fs.existsSync(full) ? full : null;
}

/** What to print under the company name on a document. */
export function companyLines(c: CompanyProfile): string[] {
  const place = [c.city, c.state, c.pincode].filter(Boolean).join(', ');
  return [
    c.tradeName,
    c.addressL1,
    c.addressL2,
    [place, c.country].filter(Boolean).join(' · '),
    c.gstNo && `GSTIN: ${c.gstNo}`,
    c.iecNo && `IEC: ${c.iecNo}`,
    [c.phone, c.email].filter(Boolean).join('  ·  '),
  ].filter(Boolean) as string[];
}
