/**
 * Clean slate — wipe all operational data and reset numbering to zero.
 *
 *   npm run db:clean
 *
 * The opposite of `db:demo`: same wipe, no rebuild. What counts as operational lives in
 * `wipe.ts`, shared with the demo seed so the two can never disagree.
 *
 * Kept: logins, currencies, units, attributes, cost formulas, stage lines, container
 * types, trades, holidays, workforce settings, statutory components and app settings —
 * that is setup.
 * Gone: products, buyers, suppliers, orders, proformas, stock, workers, contractors,
 * the ledger, the board, attendance, advances, statutory postings, the finished-stock
 * ledger, packed cartons, shipments, containers, invoices, the change log and every
 * uploaded file. All ten doc sequences restart at 001.
 */
import { PrismaClient } from '@prisma/client';
import { resetDocNumbering, wipeOperational } from './wipe';

const prisma = new PrismaClient();

async function main() {
  console.log('Wiping all operational data…');
  const { files } = await wipeOperational(prisma);
  await resetDocNumbering(prisma);

  console.log(`Done — operational data wiped, doc numbering reset to zero.`);
  console.log(`  ${files} uploaded file(s) deleted from server/uploads.`);
  console.log('Config preserved: users, currencies, units, attributes, cost formulas,');
  console.log('  stage lines, container types, trades, holidays, workforce settings,');
  console.log('  statutory components.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
