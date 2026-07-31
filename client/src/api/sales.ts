/**
 * Finished goods and sales — the client's view of it.
 *
 * Two things here are load-bearing:
 *
 * 1. **`invalidateSales` invalidates the OPERATIONS keys too.** Shipping decides an order's
 *    status and invoicing moves the receivable, so a sales write changes the operations
 *    picture. Refresh only one and the order page and the shipment page will disagree.
 * 2. **Documents go through `fetchDocument`**, never a hand-built URL: it sends the bearer
 *    token, opens a new tab with a popup-blocked fallback, and unwraps a server error that
 *    arrived as a Blob.
 *
 * All measuring logic lives in `client/src/util/shipping.ts`, the mirror of the server
 * engine — nothing in this file works out a carton count or a CBM.
 */
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api } from './client';
import { fetchDocument, OPS_KEYS, type DocCharge, type DocumentTotals } from './ops';
import type { Buyer, Currency } from './types';

const get = async <T>(url: string, params?: Record<string, unknown>) => (await api.get<T>(url, { params })).data;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ContainerType {
  id: number;
  code: string;
  name: string;
  capacityCbm: number;
  payloadKg: number;
  isActive: boolean;
  sortOrder: number;
}

/** One product's finished position, and the order lines behind it. */
export interface FinishedStockRow {
  productId: number;
  factoryCode: string;
  name: string;
  unit: string;
  piecesPerCarton: number | null;
  boardDone: number;
  adjusted: number;
  boughtIn: number;
  returned: number;
  packed: number;
  shipped: number;
  onHand: number;
  availableToPack: number;
  availableToShip: number;
  overProduced: number;
  freePool: { onHand: number; availableToPack: number; availableToShip: number } | null;
  orders: {
    orderLineId: number;
    orderId: number;
    orderNumber: string;
    orderStatus: string;
    buyerName: string;
    boardDone: number;
    adjusted: number;
    returned: number;
    packed: number;
    shipped: number;
    onHand: number;
    availableToPack: number;
    availableToShip: number;
    overProduced: number;
  }[];
}

export interface FinishedTxn {
  id: number;
  date: string;
  productId: number;
  productCode: string;
  productName: string;
  kind: 'ADJUST_IN' | 'ADJUST_OUT' | 'RETURN_IN';
  qty: number;
  reason: string | null;
  note: string | null;
  orderLineId: number | null;
  orderId: number | null;
  orderNumber: string | null;
}

export interface PackQueueRow {
  orderLineId: number;
  orderId: number;
  orderNumber: string;
  orderStatus: string;
  deliveryDate: string | null;
  buyerId: number;
  buyerName: string;
  market: string | null;
  productId: number;
  productCode: string;
  productName: string;
  ordered: number;
  finished: number;
  packed: number;
  shipped: number;
  availableToPack: number;
  availableToShip: number;
  piecesPerCarton: number | null;
  impliedCartons: number;
  lastCartonPieces: number;
  packLengthIn: number | null;
  packWidthIn: number | null;
  packHeightIn: number | null;
  netWeightKg: number | null;
  grossWeightKg: number | null;
  cbmPerPiece: number | null;
}

export interface PackingBatch {
  id: number;
  productId: number;
  productCode: string;
  productName: string;
  orderLineId: number | null;
  orderId: number | null;
  orderNumber: string | null;
  buyerName: string | null;
  qty: number;
  cartonCount: number;
  piecesPerCarton: number;
  impliedCartons: number;
  lastCartonPieces: number;
  packLengthIn: number | null;
  packWidthIn: number | null;
  packHeightIn: number | null;
  netWeightKg: number | null;
  grossWeightKg: number | null;
  cbmPerPiece: number | null;
  cbmPerCartonOverride: number | null;
  cbmPerCarton: number;
  /** Where the volume came from — a page shows this so a figure is always explained. */
  cbmSource: 'OVERRIDE' | 'STORED' | 'DERIVED';
  cbmMismatchPct: number;
  totalCbm: number;
  totalNetKg: number;
  totalGrossKg: number;
  shippingMarks: string | null;
  note: string | null;
  packedOn: string;
  shippedCartons: number;
  shippedQty: number;
  availableCartons: number;
  shipments: { shipmentId: number; number: string | null; cartons: number; qty: number }[];
}

export interface LoadTotals {
  cartons: number;
  pieces: number;
  cbm: number;
  netKg: number;
  grossKg: number;
}

export interface ShipmentContainer {
  id: number;
  containerTypeId: number;
  code: string;
  name: string;
  capacityCbm: number;
  payloadKg: number;
  containerNo: string | null;
  sealNo: string | null;
  tareWeightKg: number | null;
  note: string | null;
  load: LoadTotals;
  fit: { usedCbm: number; usedKg: number; cbmPct: number; kgPct: number; overCbm: boolean; overKg: boolean; fits: boolean };
  vgmKg: number;
}

export interface ShipmentLine {
  id: number;
  packingBatchId: number;
  containerId: number | null;
  cartons: number;
  qty: number;
  productId: number;
  productCode: string;
  productName: string;
  hsnCode: string | null;
  orderLineId: number | null;
  orderId: number | null;
  orderNumber: string | null;
  buyerName: string | null;
  shippingMarks: string | null;
  piecesPerCarton: number;
  cbmPerCarton: number;
  cbmSource: string;
  cbmMismatchPct: number;
  netKg: number;
  grossKg: number;
  cbm: number;
}

export interface Shipment {
  id: number;
  number: string;
  status: string;
  shipDate: string | null;
  shippingBillNo: string | null;
  shippingBillDate: string | null;
  portOfLoading: string | null;
  portOfDischarge: string | null;
  finalDestination: string | null;
  vesselOrFlight: string | null;
  blAwbNo: string | null;
  blAwbDate: string | null;
  transporterName: string | null;
  transporterGstin: string | null;
  vehicleNo: string | null;
  ewayBillNo: string | null;
  ewayBillDate: string | null;
  notes: string | null;
  deletedAt: string | null;
  createdAt: string;
  totals: LoadTotals;
  unassigned: LoadTotals;
  containers: ShipmentContainer[];
  /** A container may be co-loaded, so this is a list. */
  orders: { orderId: number; number: string; buyerId: number; buyerName: string; market: string | null; pieces: number; cartons: number }[];
  markets: string[];
  invoices: { id: number; number: string; status: string }[];
  lines: ShipmentLine[];
}

export interface InvoiceLine {
  id: number;
  productId: number;
  productCode: string;
  productName: string;
  unit: string;
  orderLineId: number | null;
  orderId: number | null;
  orderNumber: string | null;
  shipmentLineId: number | null;
  qty: number;
  unitPrice: number;
  discountPct: number;
  discountAmt: number;
  gstRatePct: number;
  hsnCode: string | null;
  description: string | null;
}

export interface Invoice {
  id: number;
  number: string;
  status: 'DRAFT' | 'ISSUED' | 'CANCELLED';
  buyerId: number;
  buyer: Buyer;
  currency: Currency | null;
  exchangeRate: number | null;
  invoiceDate: string;
  dueDate: string | null;
  shipmentId: number | null;
  shipment: {
    id: number;
    number: string;
    status: string;
    shipDate: string | null;
    shippingBillNo: string | null;
    portOfLoading: string | null;
    portOfDischarge: string | null;
    finalDestination: string | null;
    blAwbNo: string | null;
    vesselOrFlight: string | null;
    transporterName: string | null;
    vehicleNo: string | null;
    ewayBillNo: string | null;
  } | null;
  incoterms: string | null;
  taxMarket: string | null;
  taxBuyerState: string | null;
  taxCompanyState: string | null;
  placeOfSupply: string | null;
  reverseCharge: boolean;
  irn: string | null;
  ackNo: string | null;
  ackDate: string | null;
  qrFilename: string | null;
  qrUrl: string | null;
  paymentTerms: string | null;
  bankDetails: string | null;
  notes: string | null;
  deletedAt: string | null;
  createdAt: string;
  charges: DocCharge[];
  /** From the ONE pricing engine — `DocumentTotals` renders this unchanged. */
  totals: DocumentTotals;
  orders: { orderId: number; number: string }[];
  lines: InvoiceLine[];
}

/**
 * Everything that happened to one order after the board finished with it.
 *
 * The order page is the hub, so it asks ONE question and gets the whole answer — per-line
 * finished/packed/shipped/invoiced, the cartons, the containers they went in, and the
 * invoices that billed them. Every figure is derived server-side; nothing here is summed
 * again on the client, or the order page would start disagreeing with the shipment page.
 */
export interface OrderFulfilment {
  orderId: number;
  number: string;
  lines: {
    orderLineId: number;
    productId: number;
    productCode: string;
    productName: string;
    ordered: number;
    boardDone: number;
    adjusted: number;
    returned: number;
    packed: number;
    shipped: number;
    invoiced: number;
    onHand: number;
    availableToPack: number;
    availableToShip: number;
    overProduced: number;
  }[];
  totals: {
    ordered: number;
    finished: number;
    packed: number;
    shipped: number;
    invoiced: number;
    availableToPack: number;
    availableToShip: number;
  };
  batches: PackingBatch[];
  /** `mine` is this order's share of a possibly co-loaded box. */
  shipments: (Shipment & { mine: { cartons: number; pieces: number }; coLoaded: boolean })[];
  invoices: (Invoice & { mine: { pieces: number }; spansOrders: boolean })[];
}

export interface SalesDashboard {
  finishedOnHand: number;
  readyToPack: number;
  packedAwaitingShipment: number;
  cartonsAwaitingShipment: number;
  shipmentsThisMonth: number;
  shipmentsPlanned: number;
  shipmentsInTransit: number;
  shippedNotInvoiced: number;
  invoicesDraft: number;
  invoicesIssued: number;
  /** Null without `money.view` or `invoices.view` — the COUNTS above are a dispatch fact,
   *  but what the invoices are worth is money. */
  invoicedInr: number | null;
}

// ---------------------------------------------------------------------------
// Colours and labels
// ---------------------------------------------------------------------------

export const SHIPMENT_STATUS_COLOR: Record<string, string> = {
  PLANNED: 'default',
  LOADED: 'blue',
  SHIPPED: 'processing',
  DELIVERED: 'green',
  CANCELLED: 'red',
};

export const INVOICE_STATUS_COLOR: Record<string, string> = {
  DRAFT: 'default',
  ISSUED: 'green',
  CANCELLED: 'red',
};

export const STOCK_REASON_TEXT: Record<string, string> = {
  OPENING: 'Opening balance',
  DAMAGE: 'Damaged',
  PHYSICAL_COUNT: 'Physical count',
  RETURN: 'Returned by buyer',
};

export const FINISHED_KIND_TEXT: Record<string, string> = {
  ADJUST_IN: 'Added',
  ADJUST_OUT: 'Taken out',
  RETURN_IN: 'Returned',
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const useContainerTypes = (activeOnly = false) =>
  useQuery({ queryKey: ['container-types', activeOnly], queryFn: () => get<ContainerType[]>('/container-types', activeOnly ? { activeOnly: 1 } : {}) });

export const useFinishedStock = (q?: string) =>
  useQuery({ queryKey: ['finished-stock', q ?? ''], queryFn: () => get<FinishedStockRow[]>('/finished/stock', q ? { q } : {}) });

export const useFinishedTxns = (productId?: number) =>
  useQuery({ queryKey: ['finished-txns', productId ?? 'all'], queryFn: () => get<FinishedTxn[]>('/finished/txns', productId ? { productId } : {}) });

export const usePackQueue = () => useQuery({ queryKey: ['pack-queue'], queryFn: () => get<PackQueueRow[]>('/packing/queue') });

export const usePackingBatches = (params: { orderId?: number; unshipped?: boolean } = {}) =>
  useQuery({
    queryKey: ['packing-batches', params],
    queryFn: () => get<PackingBatch[]>('/packing', { orderId: params.orderId, unshipped: params.unshipped ? 1 : undefined }),
  });

export const useShipments = (status?: string) =>
  useQuery({ queryKey: ['shipments', status ?? 'all'], queryFn: () => get<Shipment[]>('/shipments', status && status !== 'All' ? { status } : {}) });

export const useShipment = (id?: number | string) =>
  useQuery({ enabled: id != null && id !== 'new', queryKey: ['shipment', id], queryFn: () => get<Shipment>(`/shipments/${id}`) });

/**
 * Packed cartons a dispatch may draw on.
 *
 * `forShipmentId` discounts that shipment's own cartons — when editing, they are not
 * "already gone" from its point of view, and without it the batches it carries vanish from
 * its own picker.
 */
export const useShipmentCandidates = (buyerId?: number, forShipmentId?: number) =>
  useQuery({
    enabled: buyerId != null,
    queryKey: ['shipment-candidates', buyerId, forShipmentId ?? null],
    queryFn: () => get<PackingBatch[]>('/shipments/candidates', { buyerId, shipmentId: forShipmentId }),
  });

export const useInvoices = (status?: string) =>
  useQuery({ queryKey: ['invoices', status ?? 'all'], queryFn: () => get<Invoice[]>('/invoices', status && status !== 'All' ? { status } : {}) });

export const useInvoice = (id?: number | string) =>
  useQuery({ enabled: id != null && id !== 'new', queryKey: ['invoice', id], queryFn: () => get<Invoice>(`/invoices/${id}`) });

export const useSalesDashboard = () => useQuery({ queryKey: ['sales-dashboard'], queryFn: () => get<SalesDashboard>('/sales/dashboard') });

/** One order's whole fulfilment picture, for the order page. */
export const useOrderFulfilment = (orderId?: number | string) =>
  useQuery({
    enabled: orderId != null && orderId !== 'new',
    queryKey: ['order-fulfilment', String(orderId)],
    queryFn: () => get<OrderFulfilment>(`/orders/${orderId}/fulfilment`),
  });

/** Every key a sales write can move. */
export const SALES_KEYS = [
  ['finished-stock'],
  ['finished-txns'],
  ['pack-queue'],
  ['packing-batches'],
  ['shipments'],
  ['shipment'],
  ['shipment-candidates'],
  ['invoices'],
  ['invoice'],
  ['sales-dashboard'],
  ['order-fulfilment'],
];

/**
 * Refresh everything a sales write touches — INCLUDING the operations keys.
 *
 * Shipping decides the order's status and an invoice moves the receivable, so leaving the
 * operations cache behind makes the order page contradict the shipment page. One function,
 * because this is the easiest thing in the module to get wrong.
 */
export function invalidateSales(qc: QueryClient) {
  for (const k of [...SALES_KEYS, ...OPS_KEYS]) qc.invalidateQueries({ queryKey: k });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface PackBatchInput {
  productId: number;
  orderLineId?: number | null;
  qty: number;
  cartonCount?: number;
  piecesPerCarton?: number;
  packLengthIn?: number | null;
  packWidthIn?: number | null;
  packHeightIn?: number | null;
  netWeightKg?: number | null;
  grossWeightKg?: number | null;
  cbmPerCartonOverride?: number | null;
  shippingMarks?: string | null;
  note?: string | null;
}

export const packBatches = async (batches: PackBatchInput[]) => (await api.post<PackingBatch[]>('/packing', { batches })).data;
export const unpackBatch = async (id: number) => api.delete(`/packing/${id}`);

export const addFinishedTxn = async (body: {
  productId: number;
  kind: 'ADJUST_IN' | 'ADJUST_OUT' | 'RETURN_IN';
  qty: number;
  orderLineId?: number | null;
  reason?: string;
  note?: string;
  date?: string;
}) => (await api.post<FinishedTxn>('/finished/txns', body)).data;
export const removeFinishedTxn = async (id: number) => api.delete(`/finished/txns/${id}`);

export interface ShipmentContainerInput {
  id?: number;
  containerTypeId: number;
  containerNo?: string | null;
  sealNo?: string | null;
  tareWeightKg?: number | null;
  note?: string | null;
}

export interface ShipmentLineInput {
  id?: number;
  packingBatchId: number;
  /** Index into the containers array, for a box being created in the same request. */
  containerIndex?: number | null;
  containerId?: number | null;
  cartons: number;
  qty: number;
}

export interface ShipmentInput {
  status?: string;
  shipDate?: string | null;
  shippingBillNo?: string | null;
  shippingBillDate?: string | null;
  portOfLoading?: string | null;
  portOfDischarge?: string | null;
  finalDestination?: string | null;
  vesselOrFlight?: string | null;
  blAwbNo?: string | null;
  blAwbDate?: string | null;
  transporterName?: string | null;
  transporterGstin?: string | null;
  vehicleNo?: string | null;
  ewayBillNo?: string | null;
  ewayBillDate?: string | null;
  notes?: string | null;
  containers?: ShipmentContainerInput[];
  lines: ShipmentLineInput[];
}

export const createShipment = async (body: ShipmentInput) => (await api.post<Shipment>('/shipments', body)).data;
export const updateShipment = async (id: number, body: ShipmentInput) => (await api.put<Shipment>(`/shipments/${id}`, body)).data;
export const setShipmentStatus = async (id: number, status: string, shipDate?: string | null) =>
  (await api.patch(`/shipments/${id}/status`, { status, shipDate })).data;
export const deleteShipment = async (id: number) => (await api.delete(`/shipments/${id}`)).data;

/** Ask the server what containers this load would need. Advisory — the packer decides. */
export const planShipment = async (lines: { packingBatchId: number; cartons: number; qty: number }[]) =>
  (
    await api.post<{ totals: LoadTotals; containers: { containerTypeId: number; code: string; cartons: number; fit: ShipmentContainer['fit']; batchIds: number[] }[] }>(
      '/shipments/plan',
      { lines }
    )
  ).data;

export const raiseInvoice = async (shipmentId: number, body: { buyerId: number; invoiceDate?: string; incoterms?: string }) =>
  (await api.post<Invoice>(`/invoices/from-shipment/${shipmentId}`, body)).data;

export const updateInvoice = async (id: number, body: Record<string, unknown>) => (await api.put<Invoice>(`/invoices/${id}`, body)).data;
export const setInvoiceStatus = async (id: number, status: string) => (await api.patch(`/invoices/${id}/status`, { status })).data;
export const deleteInvoice = async (id: number) => (await api.delete(`/invoices/${id}`)).data;

export async function uploadInvoiceQr(invoiceId: number, file: File) {
  const form = new FormData();
  form.append('file', file);
  return (await api.post<{ qrFilename: string; qrUrl: string }>(`/invoices/${invoiceId}/qr`, form)).data;
}

// ---------------------------------------------------------------------------
// Documents
//
// Named helpers rather than hand-built URLs, so every download goes through
// `fetchDocument` and inherits the bearer token and the Blob-error unwrapping.
// ---------------------------------------------------------------------------

export const packingListPdf = (s: Shipment) => fetchDocument(`/shipments/${s.id}/packing-list`, `${s.number}-packing-list.pdf`, true);
export const vgmPdf = (s: Shipment) => fetchDocument(`/shipments/${s.id}/vgm`, `${s.number}-vgm.pdf`, true);
export const annexurePdf = (s: Shipment) => fetchDocument(`/shipments/${s.id}/annexure`, `${s.number}-annexure.pdf`, true);
export const originPdf = (s: Shipment) => fetchDocument(`/shipments/${s.id}/coo`, `${s.number}-coo.pdf`, true);
export const invoicePdf = (i: Invoice) => fetchDocument(`/invoices/${i.id}/pdf`, `${i.number}.pdf`, true);
export const invoiceEml = (i: Invoice) => fetchDocument(`/invoices/${i.id}/mail.eml`, `${i.number}.eml`, false);

/**
 * A packing list has no identity of its own — it is the shipment's, relabelled. Display
 * only: never store this and never use it as a key, because the shipment number is the real
 * one and document numbers are minted server-side by an atomic increment.
 */
export const packingListLabel = (shipmentNumber: string) => shipmentNumber.replace(/^SHP-/, 'PKL-');
