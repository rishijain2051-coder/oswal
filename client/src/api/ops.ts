import { useQuery } from '@tanstack/react-query';
import { api, apiError } from './client';
import type { Buyer, Currency } from './types';

export const ORDER_STATUSES = ['Confirmed', 'Production', 'Ready', 'Shipped', 'Closed', 'Cancelled'] as const;
export const PROFORMA_STATUSES = ['Draft', 'Sent', 'Accepted', 'Rejected'] as const;
export const PARTY_TYPES = ['SUPPLIER', 'JOBWORK', 'BUYER', 'WORKER', 'CONTRACTOR', 'STATUTORY'] as const;

export const ORDER_STATUS_COLOR: Record<string, string> = {
  Confirmed: 'blue',
  Production: 'gold',
  Ready: 'cyan',
  Shipped: 'green',
  Closed: 'default',
  Cancelled: 'red',
};

export const PROFORMA_STATUS_COLOR: Record<string, string> = { Draft: 'default', Sent: 'blue', Accepted: 'green', Rejected: 'red' };

export type MoveKind = 'RELEASE' | 'ADVANCE' | 'REJECT' | 'COMPLETE' | 'RETURN';

export const MOVE_LABEL: Record<MoveKind, string> = {
  RELEASE: 'Started',
  ADVANCE: 'Cleared',
  REJECT: 'Sent back',
  COMPLETE: 'Finished',
  RETURN: 'Reopened',
};

export const MOVE_COLOR: Record<MoveKind, string> = {
  RELEASE: 'blue',
  ADVANCE: 'green',
  REJECT: 'red',
  COMPLETE: 'purple',
  RETURN: 'orange',
};

export interface Supplier {
  id: number;
  code: string;
  name: string;
  type: 'MATERIAL' | 'JOBWORK' | 'BOTH' | string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  gstNo?: string | null;
  address?: string | null;
  paymentTerms?: string | null;
  isActive: boolean;
}

export interface StageLineStep {
  id: number;
  name: string;
  sortOrder: number;
  /** How long this step usually takes, for auto-scheduling. Null = an equal share. */
  defaultDays?: number | null;
}

export interface StageLine {
  id: number;
  code: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  notes?: string | null;
  steps: StageLineStep[];
  _count?: { products: number; orderLines: number };
}

export interface RawItem {
  id: number;
  code: string;
  name: string;
  category?: string | null;
  unit: string;
  reorderLevel: number;
  openingQty: number;
  isActive: boolean;
  inQty: number;
  outQty: number;
  balance: number;
  low: boolean;
}

export interface StockTxn {
  id: number;
  rawItemId: number;
  type: 'IN' | 'OUT';
  qty: number;
  rate: number;
  supplierId?: number | null;
  orderRef?: string | null;
  note?: string | null;
  date: string;
  rawItem?: { name: string; unit: string };
  supplier?: { name: string } | null;
}

// --- the production board ---------------------------------------------------

export interface StageCell {
  id: number;
  name: string;
  sortOrder: number;
  vendorId: number | null;
  vendor?: { id: number; name: string } | null;
  jobworkRate: number;
  /** ₹ per piece an in-house worker earns for clearing this stage. 0 = day-wage work. */
  labourRate: number;
  note?: string | null;
  /** Pieces sitting here right now. */
  at: number;
  /** Pieces that moved forward out of here. */
  cleared: number;
  rejectedOut: number;
  rejectedIn: number;
  reached: number;
  jobworkValue: number;
  /** In-house piece work earned so far = cleared × labourRate (0 when outsourced). */
  labourValue: number;
}

export interface LineBoard {
  qty: number;
  pending: number;
  done: number;
  wip: number;
  progressPct: number;
  stages: StageCell[];
  jobwork: { vendorId: number; vendorName: string; stages: string[]; pieces: number; amount: number }[];
}

export interface StageMovePhoto {
  id: number;
  url: string;
  caption?: string | null;
}

export interface StageMoveHistory {
  id: number;
  kind: MoveKind;
  fromStageId: number | null;
  toStageId: number | null;
  fromStage: string | null;
  toStage: string | null;
  qty: number;
  date: string;
  /** The hand-over comment written when the pieces were passed on. */
  note?: string | null;
  photos: StageMovePhoto[];
  /** Who did the work, with their piece counts. Empty when nobody was named. */
  workers: { workerId: number; code: string; name: string; pieces: number }[];
  /** What this movement earned in in-house labour, at the stage's current rate. */
  labourValue: number;
}

// --- scheduling and delivery ------------------------------------------------

export const DELIVERY_TEXT: Record<string, string> = {
  LATE: 'Late',
  AT_RISK: 'At risk',
  ON_TRACK: 'On track',
  DELIVERED: 'Delivered',
  NO_DATE: 'No date',
};

export const DELIVERY_COLOUR: Record<string, string> = {
  LATE: 'red',
  AT_RISK: 'orange',
  ON_TRACK: 'green',
  DELIVERED: 'default',
  NO_DATE: 'default',
};

/** Will this order make its date? Derived on every read, never stored. */
export interface DeliveryVerdict {
  status: string;
  percentComplete: number;
  daysToDelivery: number | null;
  daysLate: number;
  reason: string;
}

export interface DeliveryRow {
  orderId: number;
  number: string;
  status: string;
  buyerId: number;
  buyerName: string;
  market: string;
  orderDate: string;
  deliveryDate?: string | null;
  expectedDelivery?: string | null;
  qty: number;
  done: number;
  wip: number;
  deliveryStatus: string;
  percentComplete: number;
  daysToDelivery: number | null;
  daysLate: number;
  reason: string;
}

export interface DeliveryStatusResponse {
  rows: DeliveryRow[];
  counts: Record<string, number>;
}

/** One stage of the schedule, compared with what the board shows. */
export interface StageEstimate {
  orderLineStageId: number;
  name: string;
  sortOrder: number;
  estimatedStart: string | null;
  estimatedEnd: string | null;
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE' | 'OVERDUE' | 'AHEAD' | string;
  daysRemaining: number | null;
  daysOverdue: number;
}

export interface LineSchedule {
  stages: StageEstimate[];
  estimatedCompletion: string | null;
  percentComplete: number;
  isBehind: boolean;
  daysLate: number;
}

export const STAGE_STATUS_COLOUR: Record<string, string> = {
  NOT_STARTED: '#e0e0e0',
  IN_PROGRESS: '#42a5f5',
  DONE: '#66bb6a',
  AHEAD: '#26a69a',
  OVERDUE: '#ef5350',
};

/** Paperwork attached to an order. */
export interface OrderAttachment {
  id: number;
  orderId: number;
  filename: string;
  originalName?: string | null;
  url: string;
  label?: string | null;
  note?: string | null;
  sizeBytes?: number | null;
  createdAt: string;
}

export const ATTACHMENT_LABELS = ['PO_COPY', 'SHIPPING', 'CUSTOMS', 'PACKING_LIST', 'INSPECTION', 'DRAWING', 'OTHER'] as const;

export const ATTACHMENT_LABEL_TEXT: Record<string, string> = {
  PO_COPY: 'Buyer PO copy',
  SHIPPING: 'Shipping document',
  CUSTOMS: 'Customs document',
  PACKING_LIST: 'Packing list',
  INSPECTION: 'Inspection certificate',
  DRAWING: 'Drawing',
  OTHER: 'Other',
};

/** A document-level extra cost or discount: freight, packing, a dealer discount. */
export interface DocCharge {
  id?: number;
  name: string;
  kind: 'CHARGE' | 'DISCOUNT' | string;
  /** Always stored positive; `kind` carries the sign. */
  amount: number;
  /** A percentage of the line subtotal. May be set alongside `amount`. */
  pct: number;
  gstRatePct: number;
  /** False for something added after tax, e.g. a round-off. */
  isTaxable: boolean;
  note?: string | null;
  sortOrder?: number;
}

/** One GST slab on a document. */
export interface TaxRow {
  ratePct: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

/**
 * The full breakdown behind a document's total, from the server's pricing engine.
 * `client/src/util/pricing.ts` computes the identical shape for live editing.
 */
export interface DocumentTotals {
  subtotal: number;
  grossSubtotal: number;
  lineDiscount: number;
  charges: { name: string; kind: string; value: number; isTaxable: boolean; gstRatePct: number }[];
  chargeTotal: number;
  taxableValue: number;
  taxRows: TaxRow[];
  cgst: number;
  sgst: number;
  igst: number;
  taxTotal: number;
  untaxedCharges: number;
  grandTotal: number;
  /** True when CGST+SGST applied, false for IGST. Meaningless when `taxed` is false. */
  intraState: boolean;
  /** False for an export, which is zero-rated end to end. */
  taxed: boolean;
}

export interface OrderLineDto {
  id: number;
  productId: number;
  qty: number;
  unitPrice: number;
  sortOrder: number;
  /** Net of this line's own discount — what it contributes to the subtotal. */
  amount: number;
  grossAmount: number;
  discountPct: number;
  discountAmt: number;
  /** Domestic only; ignored on an export, which is zero-rated. */
  gstRatePct: number;
  hsnCode?: string | null;
  product: { id: number; factoryCode: string; name: string; primaryImage?: string | null; stageLineId?: number | null; unit?: { code: string } | null };
  stageLineId?: number | null;
  stageLine?: { id: number; code: string; name: string } | null;
  /** Derived from who owns each stage: all ours, all a vendor's, or a mix. */
  mode: 'INHOUSE' | 'OUTSOURCED' | 'MIXED' | string;
  vendors: { id: number; name: string }[];
  outsourcedStages: { id: number; name: string; stage: string; sortOrder: number }[];
  needsStageLine: boolean;
  board: LineBoard;
  /** When this line SHOULD be at each stage, versus where it is. Null until scheduled. */
  schedule?: LineSchedule | null;
  history: StageMoveHistory[];
  sheet?: { id: number; number: string } | null;
}

/** The money position of one order — every figure derived, never typed in. */
export interface OrderMoney {
  currency: string;
  symbol: string;
  exchangeRate: number;
  invoiced: number;
  received: number;
  receivable: number;
  invoicedInr: number;
  receivableInr: number;
  jobworkAccrued: number;
  jobworkPaid: number;
  jobworkDue: number;
  materialBilled: number;
  materialPaid: number;
  materialDue: number;
  wagesBilled: number;
  wagesPaid: number;
  wagesDue: number;
  payableInr: number;
}

export interface Order {
  id: number;
  number: string;
  buyerId: number;
  buyer: Buyer;
  currencyId?: number | null;
  currency?: Currency | null;
  status: string;
  orderDate: string;
  deliveryDate?: string | null;
  incoterms?: string | null;
  notes?: string | null;
  exchangeRate?: number | null;
  proforma?: { id: number; number: string; status: string } | null;
  lines: OrderLineDto[];
  charges: DocCharge[];
  attachments: OrderAttachment[];
  /** The grand total — what the buyer owes, charges and GST included. */
  /**
   * The tax basis frozen when the document was created. Preferred over the live buyer,
   * so correcting an address later cannot restate a document already issued.
   */
  taxMarket?: string | null;
  taxBuyerState?: string | null;
  taxCompanyState?: string | null;
  total: number;
  /** Subtotal, charges and the CGST/SGST/IGST breakdown behind `total`. */
  totals: DocumentTotals;
  /** Will this make its date? Derived from the board, never stored. */
  delivery: DeliveryVerdict;
  expectedDelivery?: string | null;
  summary: { ordered: number; done: number; wip: number; pending: number; progressPct: number };
  jobwork: { vendorId: number; vendorName: string; pieces: number; amount: number; stages: string[] }[];
  money: OrderMoney;
  ledger: LedgerEntry[];
  /** Present on the response to a move submission. */
  createdMoves?: number;
  moveIds?: number[];
  /** The hop the pieces landed on — hand-over photos attach here. */
  photoMoveId?: number | null;
  statusChangedTo?: string | null;
}

/** Payload for `POST /orders/:id/moves`. */
export interface MoveInput {
  orderLineId: number;
  kind: MoveKind;
  fromStageId?: number | null;
  toStageId?: number | null;
  qty: number;
  note?: string | null;
}

// --- proformas -------------------------------------------------------------

export interface ProformaLineDto {
  id?: number;
  productId?: number | null;
  imageId?: number | null;
  description: string;
  qty: number;
  unitPrice: number;
  amount?: number;
  grossAmount?: number;
  discountPct?: number;
  discountAmt?: number;
  /** Domestic only; ignored on an export, which is zero-rated. */
  gstRatePct?: number;
  hsnCode?: string | null;
  specs?: string | null;
  image?: { id: number; url: string; filename: string } | null;
  product?: {
    id: number;
    factoryCode: string;
    name: string;
    images?: { id: number; url: string; filename: string; isPrimary: boolean; caption?: string | null }[];
  } | null;
}

export interface Proforma {
  id: number;
  number: string;
  buyerId: number;
  buyer: Buyer;
  currencyId?: number | null;
  currency?: Currency | null;
  status: string;
  date: string;
  validUntil?: string | null;
  paymentTerms?: string | null;
  deliveryTerms?: string | null;
  incoterms?: string | null;
  bankDetails?: string | null;
  notes?: string | null;
  exchangeRate?: number | null;
  showImages: boolean;
  sentAt?: string | null;
  decidedAt?: string | null;
  rejectReason?: string | null;
  order?: { id: number; number: string } | null;
  lines: ProformaLineDto[];
  charges: DocCharge[];
  /** Subtotal, charges and the CGST/SGST/IGST breakdown behind `total`. */
  /**
   * The tax basis frozen when the document was created. Preferred over the live buyer,
   * so correcting an address later cannot restate a document already issued.
   */
  taxMarket?: string | null;
  taxBuyerState?: string | null;
  taxCompanyState?: string | null;
  totals: DocumentTotals;
  total: number;
  canEdit: boolean;
}

export interface MailDraftInfo {
  to: string[];
  hasEmail: boolean;
  buyerName: string;
  contactName: string | null;
  subject: string;
  text: string;
  html: string;
  mailto: string | null;
  filename: string;
  attachmentSupported: false;
}

// --- material sheets -------------------------------------------------------

export interface OpExplosion {
  currency?: { code: string; symbol: string } | null;
  perPiece: {
    headTotals: Record<string, number>;
    exFactory: number;
    forwarding: number;
    fob: number;
    nonFob: number;
    factoryExpensePct: number;
    marginPct: number;
  };
  order: { qty: number; headTotals: Record<string, number>; exFactory: number; forwarding: number; fob: number; nonFob: number };
  groups: {
    head: string;
    name: string;
    method: string;
    total: number;
    orderTotal: number;
    lines: { name: string; unit?: string | null; measure: number; amount: number; orderMeasure: number; orderAmount: number }[];
  }[];
}

export interface MaterialSheet {
  id: number;
  number: string;
  productId: number;
  product: { id: number; factoryCode: string; name: string; unit?: { code: string } | null };
  orderId?: number | null;
  order?: { id: number; number: string; buyer?: { name: string } } | null;
  orderLineId?: number | null;
  /** Stage owners come from the line, so "made by" is derived rather than stored. */
  orderLine?: { id: number; qty: number; stages: { name: string; vendor?: { id: number; name: string } | null }[] } | null;
  qty: number;
  notes?: string | null;
  explosion?: OpExplosion | null;
  existing?: boolean;
}

// --- payments --------------------------------------------------------------

export interface LedgerEntry {
  id: number;
  partyType: string;
  supplierId?: number | null;
  buyerId?: number | null;
  orderId?: number | null;
  partyName: string;
  kind: 'BILL' | 'PAYMENT';
  amount: number;
  currency?: string | null;
  date: string;
  ref?: string | null;
  note?: string | null;
  supplier?: { name: string } | null;
  buyer?: { name: string } | null;
  order?: { id: number; number: string } | null;
}

/** How one payment was spread across what was outstanding. */
export interface AllocatedPayment {
  id: number;
  date: string;
  amount: number;
  currency: string;
  ref?: string | null;
  note?: string | null;
  partyName: string;
  aimedAtOrder?: string | null;
  allocations: { key: string; orderId: number | null; label: string; amount: number }[];
  /** Money that had nothing left to settle — credit on account. */
  unallocated: number;
}

/** One live order's receivable position, with the receipts that touched it. */
export interface Receivable {
  orderId: number;
  orderNumber: string;
  buyerId: number;
  buyerName: string;
  status: string;
  orderDate: string;
  deliveryDate?: string | null;
  currency: string;
  symbol: string;
  exchangeRate: number;
  invoiced: number;
  received: number;
  balance: number;
  balanceInr: number;
  receiptCount: number;
  receipts: { id: number; date: string; ref?: string | null; amount: number; fullAmount: number; spreadAcross: number; aimedAtOrder?: string | null }[];
}

export interface ReceivablesResponse {
  rows: Receivable[];
  /** Money received beyond every outstanding order, held against the buyer. */
  credits: { buyerId: number; buyerName: string; currency: string; symbol: string; amount: number }[];
}

/** One party's payable position; jobwork and wages both accrue off the board. */
export interface Payable {
  partyType: string;
  /** Canonical id for the party, whatever its type. */
  partyId: number | null;
  supplierId: number | null;
  partyName: string;
  code?: string | null;
  accrued: number;
  paid: number;
  balance: number;
  credit: number;
  pieces: number;
  events: number;
  /** Workers only: cash due now, and any advance not yet worked off. */
  dueNow?: number;
  advanceOutstanding?: number;
  /** A provision is a cost, not a debt — shown but never counted as payable. */
  isProvision?: boolean;
  /** A wage row still keyed to a typed name, awaiting migration. */
  unlinked?: boolean;
  jobs: { orderId: number | null; orderNumber: string; product: string; stages: string[]; pieces: number; amount: number; paid: number; balance: number }[];
}

export interface FinanceSummary {
  /** Which question `receivableInr` answers — see AppSetting.receivableBasis. */
  receivableBasis?: 'ORDER' | 'INVOICE';
  /** Confirmed but not yet billed. Beside the receivable, never inside it. */
  orderBookInr?: number;
  invoicedInr: number;
  receivedInr: number;
  receivableInr: number;
  buyerCreditInr: number;
  jobworkAccrued: number;
  jobworkPaid: number;
  jobworkDue: number;
  materialBilled: number;
  materialPaid: number;
  materialDue: number;
  /** Wages ACCRUED from attendance and the board, plus any pre-Manforce entries. */
  wagesBilled: number;
  wagesPaid: number;
  wagesDue: number;
  headcount: number;
  contractorCount: number;
  contractorDue: number;
  statutoryDue: number;
  statutoryProvision: number;
  advanceOutstanding: number;
  payableInr: number;
  jobworkEvents: number;
}

export type PartyType = 'BUYER' | 'JOBWORK' | 'SUPPLIER' | 'WORKER' | 'CONTRACTOR' | 'STATUTORY';

export interface PartyRow {
  partyType: PartyType;
  partyId: number | null;
  name: string;
  code?: string | null;
  owesUs: number;
  weOwe: number;
  credit: number;
  orders: number;
}

export interface StatementRow {
  /** Stable identity, supplied by the server. */
  key: string;
  date: string;
  type: 'ACCRUAL' | 'BILL' | 'INVOICE' | 'PAYMENT' | 'RECEIPT';
  description: string;
  ref?: string | null;
  orderNumber?: string | null;
  charge: number;
  settle: number;
  balance: number;
  detail?: string | null;
}

/** One dated jobwork earning: pieces cleared out of a vendor stage × its rate. */
export interface JobworkEvent {
  moveId: number;
  date: string;
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
  rework: boolean;
}

export interface PartyStatement {
  party: { partyType: PartyType; partyId: number | null; name: string; code?: string | null; email?: string | null; phone?: string | null; gstNo?: string | null; paymentTerms?: string | null };
  /** Buyers can trade in more than one currency, so their statement is per currency. */
  currencies?: {
    currency: string;
    symbol: string;
    invoiced: number;
    received: number;
    balance: number;
    credit: number;
    orders: { orderId: number; orderNumber: string; date: string; status: string; gross: number; paid: number; balance: number }[];
    receipts: AllocatedPayment[];
    statement: StatementRow[];
  }[];
  currency?: string;
  summary?: { accrued: number; paid: number; balance: number; credit: number; pieces: number; events: number };
  perOrder?: { orderId: number | null; orderNumber: string; pieces: number; gross: number; paid: number; balance: number }[];
  events?: JobworkEvent[];
  bills?: { id: number; date: string; amount: number; ref?: string | null; note?: string | null; orderNumber?: string | null; stockTxn?: { id: number; item: string; qty: number; unit: string; rate: number } | null }[];
  payments?: AllocatedPayment[];
  /** Material deliveries recorded in stock, and whether each has been billed. */
  supplied?: { id: number; date: string; item: string; qty: number; unit: string; rate: number; value: number; note?: string | null; billed: boolean; billId: number | null }[];
  unbilledValue?: number;
  statement?: StatementRow[];
  /**
   * Present for WORKER, CONTRACTOR and STATUTORY parties, whose position is derived
   * from attendance, the board and what has been posted rather than from bills.
   */
  workforce?: {
    payType?: string;
    trade?: string | null;
    contractor?: string | null;
    dueNow?: number;
    deducted?: number;
    statutoryDeducted?: number;
    earnedDays?: number;
    overtimeEarned?: number;
    advanced?: number;
    advanceRecovered?: number;
    advanceOutstanding?: number;
    advances?: { id: number; date: string; amount: number; recoveryPerMonth: number; note?: string | null; recovered: number; outstanding: number }[];
    gang?: number;
    workers?: { id: number; code: string; name: string; payType: string; earned: number; days: number; pieces: number }[];
    isProvision?: boolean;
    employee?: number;
    employer?: number;
    payeeName?: string;
    workersCovered?: number;
    lines?: { id: number; posting: string; workerCode: string; workerName: string; wages: number; employeeAmt: number; employerAmt: number; postedOn: string }[];
  };
}

export interface OpsDashboard {
  pendingOrders: number;
  awaitingDecision: number;
  inProduction: number;
  atVendors: number;
  pendingPieces: number;
  finishedPieces: number;
  jobworkAccrued: number;
  receivable: number;
  payable: number;
  buyerCredit: number;
  vendorLoad: { vendorId: number; vendorName: string; pieces: number }[];
  recentProformas: { id: number; number: string; buyer: string; status: string; date: string }[];
  lowStock: { id: number; name: string; unit: string; balance: number; reorderLevel: number }[];
}

const get = async <T>(url: string, params?: Record<string, unknown>) => (await api.get<T>(url, { params })).data;

export const useSuppliers = (type?: string) => useQuery({ queryKey: ['suppliers', type ?? 'all'], queryFn: () => get<Supplier[]>('/suppliers', type ? { type } : {}) });
export const useStageLines = () => useQuery({ queryKey: ['stage-lines'], queryFn: () => get<StageLine[]>('/stage-lines') });
export const useRawItems = () => useQuery({ queryKey: ['raw-items'], queryFn: () => get<RawItem[]>('/raw-items') });
export const useStockTxns = (rawItemId?: number) => useQuery({ queryKey: ['stock-txns', rawItemId ?? 'all'], queryFn: () => get<StockTxn[]>('/stock/txns', rawItemId ? { rawItemId } : {}) });
export const useOrders = (status?: string) => useQuery({ queryKey: ['orders', status ?? 'all'], queryFn: () => get<Order[]>('/orders', status ? { status } : {}) });
export const useOrder = (id?: number | string) => useQuery({ enabled: id != null && id !== 'new', queryKey: ['order', id], queryFn: () => get<Order>(`/orders/${id}`) });
export const useProformas = (status?: string) => useQuery({ queryKey: ['proformas', status ?? 'all'], queryFn: () => get<Proforma[]>('/proformas', status ? { status } : {}) });
export const useProforma = (id?: number | string) => useQuery({ enabled: id != null && id !== 'new', queryKey: ['proforma', id], queryFn: () => get<Proforma>(`/proformas/${id}`) });
export const useSheets = (orderId?: number) => useQuery({ queryKey: ['op-sheets', orderId ?? 'all'], queryFn: () => get<MaterialSheet[]>('/operation-sheets', orderId ? { orderId } : {}) });
export const useSheet = (id?: number | string) => useQuery({ enabled: id != null, queryKey: ['op-sheet', id], queryFn: () => get<MaterialSheet>(`/operation-sheets/${id}`) });
export const usePayments = (params: Record<string, unknown> = {}) => useQuery({ queryKey: ['payments', params], queryFn: () => get<LedgerEntry[]>('/payments', params) });
export const useReceivables = () => useQuery({ queryKey: ['receivables'], queryFn: () => get<ReceivablesResponse>('/finance/receivables') });
export const usePayables = () => useQuery({ queryKey: ['payables'], queryFn: () => get<Payable[]>('/finance/payables') });
export const useFinanceSummary = () => useQuery({ queryKey: ['finance-summary'], queryFn: () => get<FinanceSummary>('/finance/summary') });
export const useFinanceParties = () => useQuery({ queryKey: ['finance-parties'], queryFn: () => get<PartyRow[]>('/finance/parties') });
export const usePartyStatement = (partyType?: PartyType, partyId?: number | string, partyName?: string) =>
  useQuery({
    enabled: !!partyType && (partyId != null || !!partyName),
    queryKey: ['statement', partyType, partyId ?? partyName],
    queryFn: () => get<PartyStatement>('/finance/statement', { partyType, partyId, partyName }),
  });
export const useOpsDashboard = () => useQuery({ queryKey: ['ops-dashboard'], queryFn: () => get<OpsDashboard>('/ops/dashboard') });

/** Every query key that a movement or a money entry can invalidate. */
// `order-fulfilment` is in SALES_KEYS as well, and belongs in both: packing and shipping
// obviously move it, but so does a board clearance, because the board's DONE bucket is what
// finished stock is derived from. Listed here, completing a piece refreshes what the order
// page says is ready to pack.
export const OPS_KEYS = [['orders'], ['order'], ['order-fulfilment'], ['ops-dashboard'], ['receivables'], ['payables'], ['finance-summary'], ['finance-parties'], ['statement'], ['payments'], ['stock-txns'], ['finance-receivables-summary'], ['delivery-status']];

/** Upload hand-over photos onto a movement. */
export async function uploadMovePhotos(moveId: number, files: File[]): Promise<Order> {
  const form = new FormData();
  for (const f of files) form.append('photos', f);
  return (await api.post<Order>(`/moves/${moveId}/photos`, form)).data;
}
export const useMailDraft = (proformaId?: number | string, enabled = true) =>
  useQuery({ enabled: enabled && proformaId != null, queryKey: ['pi-mail', proformaId], queryFn: () => get<MailDraftInfo>(`/proformas/${proformaId}/mail`) });

/**
 * The costed floor for a product, on the right basis for the buyer's market: Non-FOB in
 * rupees for a domestic sale, FOB converted for an export. Also returns the product's
 * tax classification so a domestic line can seed its GST rate in the same round-trip.
 */
export async function suggestPrice(productId: number, currencyId?: number, buyerId?: number) {
  return get<{ fobInr: number; basis: 'FOB' | 'NON_FOB'; rate: number; currencyCode: string; suggested: number; gstRatePct: number; hsnCode: string | null }>('/ops/price', {
    productId,
    currencyId,
    buyerId,
  });
}

/**
 * Fetch a binary document through axios (so the bearer token is sent) and hand it
 * to the browser. `open: true` shows a PDF in a new tab; otherwise it downloads.
 */
export async function fetchDocument(url: string, filename: string, open = false): Promise<void> {
  try {
    const res = await api.get(url, { responseType: 'blob' });
    const contentType = res.headers['content-type'];
    const blob = new Blob([res.data], { type: typeof contentType === 'string' ? contentType : 'application/octet-stream' });
    const href = URL.createObjectURL(blob);
    if (open) {
      const w = window.open(href, '_blank');
      if (!w) triggerDownload(href, filename); // popup blocked — fall back to saving it
    } else {
      triggerDownload(href, filename);
    }
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  } catch (err) {
    throw new Error(await blobErrorMessage(err));
  }
}

function triggerDownload(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Server errors arrive as a Blob when responseType is 'blob' — unwrap them. */
async function blobErrorMessage(err: unknown): Promise<string> {
  const data = (err as any)?.response?.data;
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text());
      if (parsed?.error) return parsed.error;
    } catch {
      /* not JSON — fall through */
    }
  }
  return apiError(err);
}
