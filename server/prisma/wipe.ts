/**
 * The one list of what counts as operational data.
 *
 * Both the demo seed (which rebuilds a factory) and `db:clean` (which leaves an empty
 * one) clear exactly the same tables, so the two can never drift apart. If you add a
 * model, add it here — a table left out keeps rows that point at records by id, and
 * they resurface attached to whichever new record is later given that id.
 *
 * Configuration is deliberately NOT touched: logins, ROLES AND THEIR PERMISSIONS,
 * currencies, units, attributes, cost formulas, stage lines, trades, holidays, workforce
 * settings and statutory components are setup, not data.
 *
 * `Role` and `RolePermission` are the newest members of that list and the easiest to add
 * here by mistake, because the rule above says "if you add a model, add it here". They are
 * an exception for the same reason `User` is: wiping them would sign the factory out of its
 * own ERP, and the only account left able to repair it would be an owner. A role is who may
 * do what, which survives a data wipe exactly as a login does.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';

const UPLOADS = path.join(__dirname, '..', 'uploads');

export async function wipeOperational(prisma: PrismaClient): Promise<{ files: number }> {
  // Change-log rows point at records by id. Left behind, they would resurface on
  // whichever new product or order happens to be given the same id.
  await prisma.changeLog.deleteMany();

  // The workforce goes next: its rows reference movements and the ledger, and a
  // worker left behind would carry attendance for a factory that no longer exists.
  await prisma.statutoryPostingLine.deleteMany();
  await prisma.statutoryPosting.deleteMany();
  await prisma.workerDeduction.deleteMany();
  await prisma.workerAdvance.deleteMany();
  await prisma.attendance.deleteMany();
  await prisma.workerStatutory.deleteMany();
  await prisma.workerDocument.deleteMany();
  await prisma.stageMoveWorker.deleteMany();
  await prisma.worker.deleteMany();
  await prisma.contractor.deleteMany();

  await prisma.stageMovePhoto.deleteMany();
  await prisma.stageMove.deleteMany();
  await prisma.orderLineStage.deleteMany();
  await prisma.operationSheet.deleteMany();
  await prisma.ledgerEntry.deleteMany();

  // The sales side. AFTER the ledger, because a buyer receipt may name the invoice it was
  // aimed at (`LedgerEntry.invoiceId`) and the invoice cannot go while a row points at it.
  // Children before parents inside the block, so the rest of the list stays
  // order-independent.
  await prisma.invoiceCharge.deleteMany();
  await prisma.invoiceLine.deleteMany();
  await prisma.invoice.deleteMany();
  // Finished-stock movements name the shipment line a return reverses, so they go BEFORE
  // the shipment lines — relying on a SetNull referential action here would work but would
  // leave the order of this list load-bearing in a way the comment above promises it is not.
  await prisma.finishedTxn.deleteMany();
  await prisma.shipmentLine.deleteMany();
  await prisma.shipmentContainer.deleteMany();
  await prisma.shipment.deleteMany();
  // Last of the sales block: a shipment line REQUIRES its packing batch.
  await prisma.packingBatch.deleteMany();
  // The scheduling overlay and the attachments hang off orders; clear them before the
  // orders themselves so this list stays order-independent.
  await prisma.stageSchedule.deleteMany();
  await prisma.orderLineSchedule.deleteMany();
  await prisma.orderAttachment.deleteMany();
  // Charges before their documents: they cascade, but deleting children first keeps
  // this list order-independent rather than relying on a referential action.
  await prisma.orderCharge.deleteMany();
  await prisma.orderLine.deleteMany();
  await prisma.order.deleteMany();
  await prisma.proformaCharge.deleteMany();
  await prisma.proformaLine.deleteMany();
  await prisma.proforma.deleteMany();

  await prisma.stockTxn.deleteMany();
  await prisma.rawItem.deleteMany();

  await prisma.productImage.deleteMany();
  await prisma.costLine.deleteMany();
  await prisma.costGroup.deleteMany();
  await prisma.costSheet.deleteMany();
  await prisma.productBuyer.deleteMany();
  await prisma.relatedProduct.deleteMany();
  await prisma.product.deleteMany();

  await prisma.buyer.deleteMany();
  await prisma.supplier.deleteMany();

  return { files: wipeUploads() };
}

/**
 * Files that survive a wipe because the record pointing at them survives too.
 *
 * The company logo is CONFIGURATION — `cleanSlate` deliberately keeps the Company row —
 * so deleting the file would leave `logoFilename` pointing at nothing and every document
 * would print a broken letterhead after `db:clean`. Anything whose owning row is wiped
 * (product images, hand-over photos, worker documents, order attachments) must go.
 */
const KEEP = [/^\.gitkeep$/, /^company-logo-/i];

/** True when a file in `uploads` must survive a wipe. Asserted in verify.ts. */
export function survivesWipe(filename: string): boolean {
  return KEEP.some((re) => re.test(filename));
}

/**
 * Product images, hand-over photos, worker documents and order attachments all share this
 * directory, and all of them belong to rows that a wipe removes.
 *
 * NOTE: this is a filesystem path, so it is wiped regardless of which database
 * DATABASE_URL points at. Returns the number of files removed so a caller can say so
 * out loud rather than deleting a user's photos silently.
 */
export function wipeUploads(): number {
  if (!fs.existsSync(UPLOADS)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(UPLOADS)) {
    if (KEEP.some((re) => re.test(f))) continue;
    fs.unlinkSync(path.join(UPLOADS, f));
    n++;
  }
  return n;
}

/**
 * Restart every document sequence. Only `db:clean` does this: the demo seed mints real
 * numbers for the orders it creates, so resetting mid-rebuild would hand out duplicates.
 */
export async function resetDocNumbering(prisma: PrismaClient) {
  await prisma.docSequence.updateMany({ data: { lastNo: 0 } });
}
