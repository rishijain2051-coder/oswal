/**
 * The seam between the database and the finished-goods / shipping engines.
 *
 * `finished.ts` and `shipping.ts` are pure — they take rows and return figures. This file
 * is what loads those rows and serialises the answers, exactly as `orderBoard.ts` does for
 * `production.ts` and `manforce.ts` does for `workforce.ts`.
 *
 * Every query here filters `deletedAt: null`, because that is the ONLY place deletion is
 * understood. The engines must never learn about it — verify.ts asserts as much.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db';
import { ApiError } from './http';
import { round } from './costing';
import { buildBoard } from './production';
import { documentTotalsOf } from './pricing';
import { finishedOnHand, type FinishedInput, type FinishedPosition } from './finished';
import { cartonCbm, cartonsFor, containerFit, packedTotals, vgm, type LoadTotals } from './shipping';

type Tx = Prisma.TransactionClient | PrismaClient;

// ---------------------------------------------------------------------------
// Loading the finished-stock picture
// ---------------------------------------------------------------------------

/**
 * Everything the finished-stock engine needs, in one read.
 *
 * The board is loaded LIVE — order lines with their stage snapshot and move ledger, run
 * through `buildBoard` — rather than read from any stored total. That is what makes undoing
 * a completion un-do the stock.
 */
export async function loadFinishedInput(tx: Tx = prisma, productIds?: number[]): Promise<FinishedInput> {
  const whereProduct = productIds && productIds.length ? { productId: { in: productIds } } : {};

  const [lines, txns, boughtIn, batches, shipLines] = await Promise.all([
    tx.orderLine.findMany({
      // A trashed or cancelled order's pieces are not stock. Same rule as LIVE_ORDER.
      where: { ...whereProduct, order: { deletedAt: null, status: { not: 'Cancelled' } } },
      select: { id: true, productId: true, qty: true, stages: true, moves: true },
    }),
    tx.finishedTxn.findMany({ where: whereProduct, select: { productId: true, orderLineId: true, kind: true, qty: true } }),
    // Bought-in finished goods arrive as ordinary supplier receipts against a raw item that
    // IS a product — see RawItem.productId. Nothing special, which is the point.
    tx.stockTxn.findMany({
      where: { rawItem: { productId: { not: null } }, ...(productIds?.length ? { rawItem: { productId: { in: productIds } } } : {}) },
      select: { type: true, qty: true, rawItem: { select: { productId: true } } },
    }),
    tx.packingBatch.findMany({ where: whereProduct, select: { productId: true, orderLineId: true, qty: true } }),
    tx.shipmentLine.findMany({
      where: { shipment: { deletedAt: null, status: { not: 'CANCELLED' } }, ...(productIds?.length ? { packingBatch: { productId: { in: productIds } } } : {}) },
      select: { qty: true, packingBatch: { select: { productId: true, orderLineId: true } } },
    }),
  ]);

  return {
    boardDone: lines.map((l) => {
      const board = buildBoard(l.qty, l.stages as never, l.moves as never);
      return { orderLineId: l.id, productId: l.productId, done: board.done, ordered: l.qty };
    }),
    txns,
    boughtIn: boughtIn.map((s) => ({
      productId: s.rawItem.productId as number,
      // OUT of a bought-in finished item is stock leaving by some other route; `type`
      // carries the sign here exactly as `kind` does on FinishedTxn.
      qty: s.type === 'IN' ? s.qty : -s.qty,
    })),
    packed: batches,
    shipped: shipLines.map((l) => ({ productId: l.packingBatch.productId, orderLineId: l.packingBatch.orderLineId, qty: l.qty })),
  };
}

/** The finished-stock position, ready to read. */
export async function finishedPosition(tx: Tx = prisma, productIds?: number[]): Promise<FinishedPosition> {
  return finishedOnHand(await loadFinishedInput(tx, productIds));
}

/** Shipped pieces per order line, for the status rule and the invoice guards. */
export async function shippedQtyByOrderLine(tx: Tx = prisma, orderId?: number): Promise<Map<number, number>> {
  const rows = await tx.shipmentLine.findMany({
    where: {
      shipment: { deletedAt: null, status: { not: 'CANCELLED' } },
      ...(orderId != null ? { packingBatch: { orderLine: { orderId } } } : {}),
    },
    select: { qty: true, packingBatch: { select: { orderLineId: true } } },
  });
  const out = new Map<number, number>();
  for (const r of rows) {
    const id = r.packingBatch.orderLineId;
    if (id == null) continue;
    out.set(id, (out.get(id) ?? 0) + r.qty);
  }
  return out;
}

/**
 * Invoiced pieces per ORDER LINE — what the raise-invoice guard compares against.
 *
 * Keyed on `orderLineId`, which the route always sets and `assertInvoiceAttributable`
 * refuses to issue without, rather than on `shipmentLineId`, which is advisory. The guard
 * compares this against the TOTAL shipped for the order line (see `shippedQtyByOrderLine`),
 * so an order line shipped in parts can be billed one dispatch at a time up to what has
 * actually gone out — while the total invoiced can never exceed the total shipped.
 */
export async function invoicedQtyByOrderLine(tx: Tx = prisma, orderId?: number): Promise<Map<number, number>> {
  const rows = await tx.invoiceLine.findMany({
    // A cancelled invoice has stopped billing anything, so its pieces are billable again.
    where: {
      invoice: { deletedAt: null, status: { not: 'CANCELLED' } },
      ...(orderId != null ? { orderLine: { orderId } } : {}),
    },
    select: { qty: true, orderLineId: true },
  });
  const out = new Map<number, number>();
  for (const r of rows) {
    if (r.orderLineId == null) continue;
    out.set(r.orderLineId, (out.get(r.orderLineId) ?? 0) + r.qty);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------

export const shipmentInclude = {
  containers: { include: { containerType: true }, orderBy: { sortOrder: 'asc' as const } },
  lines: {
    include: {
      packingBatch: {
        include: {
          product: { select: { id: true, factoryCode: true, name: true, hsnCode: true } },
          orderLine: { select: { id: true, orderId: true, order: { select: { id: true, number: true, buyerId: true, incoterms: true, buyer: { select: { id: true, name: true, market: true, state: true, gstNo: true } } } } } },
        },
      },
    },
    orderBy: { sortOrder: 'asc' as const },
  },
  invoices: { where: { deletedAt: null }, select: { id: true, number: true, status: true } },
} satisfies Prisma.ShipmentInclude;

export type ShipmentWithLines = Prisma.ShipmentGetPayload<{ include: typeof shipmentInclude }>;

/** The batch as the shipping engine wants it, plus how much of it this line takes. */
const specOf = (b: ShipmentWithLines['lines'][number]['packingBatch'], cartons: number, pieces: number) => ({
  packLengthIn: b.packLengthIn,
  packWidthIn: b.packWidthIn,
  packHeightIn: b.packHeightIn,
  piecesPerCarton: b.piecesPerCarton,
  netWeightKg: b.netWeightKg,
  grossWeightKg: b.grossWeightKg,
  cbmPerPiece: b.cbmPerPiece,
  cbmPerCartonOverride: b.cbmPerCartonOverride,
  qty: b.qty,
  cartonCount: b.cartonCount,
  cartonsTaken: cartons,
  piecesTaken: pieces,
});

/**
 * A shipment as the API returns it. Every figure — cartons, CBM, weight, how full each box
 * is — is derived here through the shipping engine. None of it is stored.
 */
export function serializeShipment(s: ShipmentWithLines) {
  const specs = s.lines.map((l) => specOf(l.packingBatch, l.cartons, l.qty));
  const totals = packedTotals(specs);

  const containers = s.containers.map((c) => {
    const mine = s.lines.filter((l) => l.containerId === c.id).map((l) => specOf(l.packingBatch, l.cartons, l.qty));
    const load = packedTotals(mine);
    const fit = containerFit(load, { capacityCbm: c.containerType.capacityCbm, payloadKg: c.containerType.payloadKg }, c.tareWeightKg ?? 0);
    return {
      id: c.id,
      containerTypeId: c.containerTypeId,
      code: c.containerType.code,
      name: c.containerType.name,
      capacityCbm: c.containerType.capacityCbm,
      payloadKg: c.containerType.payloadKg,
      containerNo: c.containerNo,
      sealNo: c.sealNo,
      tareWeightKg: c.tareWeightKg,
      note: c.note,
      load,
      fit,
      /** Never stored: tare plus the derived cargo gross, so it cannot contradict the list. */
      vgmKg: vgm(c.tareWeightKg, load.grossKg),
    };
  });

  // Cartons nobody has put in a box yet — an LCL part load may stay this way.
  const unassigned = packedTotals(s.lines.filter((l) => l.containerId == null).map((l) => specOf(l.packingBatch, l.cartons, l.qty)));

  /** Which orders and buyers this box is carrying. A container may be co-loaded. */
  const orders = new Map<number, { orderId: number; number: string; buyerId: number; buyerName: string; market: string | null; pieces: number; cartons: number }>();
  for (const l of s.lines) {
    const o = l.packingBatch.orderLine?.order;
    if (!o) continue;
    const row = orders.get(o.id) ?? { orderId: o.id, number: o.number, buyerId: o.buyerId, buyerName: o.buyer.name, market: o.buyer.market, pieces: 0, cartons: 0 };
    row.pieces += l.qty;
    row.cartons += l.cartons;
    orders.set(o.id, row);
  }

  return {
    id: s.id,
    number: s.number,
    status: s.status,
    shipDate: s.shipDate,
    shippingBillNo: s.shippingBillNo,
    shippingBillDate: s.shippingBillDate,
    portOfLoading: s.portOfLoading,
    portOfDischarge: s.portOfDischarge,
    finalDestination: s.finalDestination,
    vesselOrFlight: s.vesselOrFlight,
    blAwbNo: s.blAwbNo,
    blAwbDate: s.blAwbDate,
    transporterName: s.transporterName,
    transporterGstin: s.transporterGstin,
    vehicleNo: s.vehicleNo,
    ewayBillNo: s.ewayBillNo,
    ewayBillDate: s.ewayBillDate,
    notes: s.notes,
    deletedAt: s.deletedAt,
    createdAt: s.createdAt,
    totals,
    unassigned,
    containers,
    orders: [...orders.values()],
    /** Every market represented, so a page knows which paperwork applies. */
    markets: [...new Set([...orders.values()].map((o) => o.market ?? 'OVERSEAS'))],
    invoices: s.invoices,
    lines: s.lines.map((l) => {
      const b = l.packingBatch;
      const volume = cartonCbm(b);
      return {
        id: l.id,
        packingBatchId: l.packingBatchId,
        containerId: l.containerId,
        cartons: l.cartons,
        qty: l.qty,
        productId: b.productId,
        productCode: b.product.factoryCode,
        productName: b.product.name,
        hsnCode: b.product.hsnCode,
        orderLineId: b.orderLineId,
        orderId: b.orderLine?.orderId ?? null,
        orderNumber: b.orderLine?.order.number ?? null,
        buyerName: b.orderLine?.order.buyer.name ?? null,
        shippingMarks: b.shippingMarks,
        piecesPerCarton: b.piecesPerCarton,
        cbmPerCarton: volume.value,
        cbmSource: volume.source,
        cbmMismatchPct: volume.mismatchPct,
        netKg: round((b.netWeightKg ?? 0) * l.qty),
        grossKg: round((b.grossWeightKg ?? 0) * l.qty),
        cbm: round(volume.value * l.cartons, 4),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

export const packingInclude = {
  product: { select: { id: true, factoryCode: true, name: true, hsnCode: true } },
  orderLine: { select: { id: true, orderId: true, order: { select: { id: true, number: true, buyer: { select: { id: true, name: true } } } } } },
  lines: { select: { id: true, cartons: true, qty: true, shipmentId: true, shipment: { select: { number: true, status: true, deletedAt: true } } } },
} satisfies Prisma.PackingBatchInclude;

export type PackingWithLines = Prisma.PackingBatchGetPayload<{ include: typeof packingInclude }>;

/**
 * `excludeShipmentId` is what makes EDITING a shipment work: its own cartons must not count
 * as already gone, or the batch it is carrying looks fully shipped and disappears from its
 * own picker. Exactly the same allowance `assertShippable` makes on the write side.
 */
export function serializePacking(b: PackingWithLines, excludeShipmentId?: number) {
  const volume = cartonCbm(b);
  const count = cartonsFor(b.qty, b.piecesPerCarton);
  const taken = b.lines.filter((l) => l.shipmentId !== excludeShipmentId && !l.shipment?.deletedAt && l.shipment?.status !== 'CANCELLED');
  const shippedCartons = taken.reduce((a, l) => a + l.cartons, 0);
  const shippedQty = taken.reduce((a, l) => a + l.qty, 0);
  return {
    id: b.id,
    productId: b.productId,
    productCode: b.product.factoryCode,
    productName: b.product.name,
    orderLineId: b.orderLineId,
    orderId: b.orderLine?.orderId ?? null,
    orderNumber: b.orderLine?.order.number ?? null,
    buyerName: b.orderLine?.order.buyer.name ?? null,
    qty: b.qty,
    cartonCount: b.cartonCount,
    piecesPerCarton: b.piecesPerCarton,
    /** What the quantity WOULD make, so a page can show a short last box. */
    impliedCartons: count.total,
    lastCartonPieces: count.lastPieces,
    packLengthIn: b.packLengthIn,
    packWidthIn: b.packWidthIn,
    packHeightIn: b.packHeightIn,
    netWeightKg: b.netWeightKg,
    grossWeightKg: b.grossWeightKg,
    cbmPerPiece: b.cbmPerPiece,
    cbmPerCartonOverride: b.cbmPerCartonOverride,
    cbmPerCarton: volume.value,
    cbmSource: volume.source,
    cbmMismatchPct: volume.mismatchPct,
    totalCbm: round(volume.value * b.cartonCount, 4),
    totalNetKg: round((b.netWeightKg ?? 0) * b.qty),
    totalGrossKg: round((b.grossWeightKg ?? 0) * b.qty),
    shippingMarks: b.shippingMarks,
    note: b.note,
    packedOn: b.packedOn,
    shippedCartons,
    shippedQty,
    /** Cartons still here. A batch with none left cannot be unpacked. */
    availableCartons: b.cartonCount - shippedCartons,
    shipments: b.lines.filter((l) => !l.shipment?.deletedAt).map((l) => ({ shipmentId: l.shipmentId, number: l.shipment?.number ?? null, cartons: l.cartons, qty: l.qty })),
  };
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export const invoiceInclude = {
  buyer: true,
  currency: true,
  shipment: { select: { id: true, number: true, status: true, shipDate: true, shippingBillNo: true, portOfLoading: true, portOfDischarge: true, finalDestination: true, blAwbNo: true, vesselOrFlight: true, transporterName: true, vehicleNo: true, ewayBillNo: true } },
  charges: { orderBy: { sortOrder: 'asc' as const } },
  lines: {
    include: {
      product: { select: { id: true, factoryCode: true, name: true, hsnCode: true, unit: { select: { code: true } } } },
      orderLine: { select: { id: true, orderId: true, order: { select: { id: true, number: true } } } },
    },
    orderBy: { sortOrder: 'asc' as const },
  },
} satisfies Prisma.InvoiceInclude;

export type InvoiceWithLines = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>;

/**
 * An invoice as the API returns it.
 *
 * Its money comes from `documentTotalsOf()` — the ONE pricing engine that also values a
 * proforma, an order, the FIFO buckets and the dashboard. Nothing is added up here, and the
 * invoice stores no total, so it cannot print a figure the rest of the app disagrees with.
 */
export function serializeInvoice(i: InvoiceWithLines, companyState: string | null) {
  const totals = documentTotalsOf(i as never, companyState);
  return {
    id: i.id,
    number: i.number,
    status: i.status,
    buyerId: i.buyerId,
    buyer: i.buyer,
    currency: i.currency,
    exchangeRate: i.exchangeRate,
    invoiceDate: i.invoiceDate,
    dueDate: i.dueDate,
    shipmentId: i.shipmentId,
    shipment: i.shipment,
    incoterms: i.incoterms,
    taxMarket: i.taxMarket,
    taxBuyerState: i.taxBuyerState,
    taxCompanyState: i.taxCompanyState,
    placeOfSupply: i.placeOfSupply,
    reverseCharge: i.reverseCharge,
    irn: i.irn,
    ackNo: i.ackNo,
    ackDate: i.ackDate,
    qrFilename: i.qrFilename,
    qrUrl: i.qrFilename ? `/uploads/${i.qrFilename}` : null,
    paymentTerms: i.paymentTerms,
    bankDetails: i.bankDetails,
    notes: i.notes,
    deletedAt: i.deletedAt,
    createdAt: i.createdAt,
    charges: i.charges,
    totals,
    /** Which orders this invoice bills. One invoice may span several. */
    orders: [...new Map(i.lines.filter((l) => l.orderLine).map((l) => [l.orderLine!.orderId, { orderId: l.orderLine!.orderId, number: l.orderLine!.order.number }])).values()],
    lines: i.lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      productCode: l.product.factoryCode,
      productName: l.product.name,
      unit: l.product.unit?.code ?? 'PCS',
      orderLineId: l.orderLineId,
      orderId: l.orderLine?.orderId ?? null,
      orderNumber: l.orderLine?.order.number ?? null,
      shipmentLineId: l.shipmentLineId,
      qty: l.qty,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct,
      discountAmt: l.discountAmt,
      gstRatePct: l.gstRatePct,
      hsnCode: l.hsnCode,
      description: l.description,
    })),
  };
}

/** Load one shipment or explain why not, mirroring `loadOrder`. */
export async function loadShipment(id: number, allowTrashed = false): Promise<ShipmentWithLines> {
  const s = await prisma.shipment.findUnique({ where: { id }, include: shipmentInclude });
  if (!s) throw new ApiError(404, 'Shipment not found.');
  if (s.deletedAt && !allowTrashed) throw new ApiError(410, `${s.number} is in the trash. Restore it to open it.`);
  return s;
}

export async function loadInvoice(id: number, allowTrashed = false): Promise<InvoiceWithLines> {
  const i = await prisma.invoice.findUnique({ where: { id }, include: invoiceInclude });
  if (!i) throw new ApiError(404, 'Invoice not found.');
  if (i.deletedAt && !allowTrashed) throw new ApiError(410, `${i.number} is in the trash. Restore it to open it.`);
  return i;
}

/** A shipment's own load totals, for a route that only needs the numbers. */
export function shipmentTotals(s: ShipmentWithLines): LoadTotals {
  return packedTotals(s.lines.map((l) => specOf(l.packingBatch, l.cartons, l.qty)));
}
