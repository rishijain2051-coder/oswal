import axios from 'axios';

export const TOKEN_KEY = 'saraswati_erp_token';

// `withCredentials` lets the httpOnly session cookie ride along; it is what allows
// <img src="/uploads/…"> to load files that are no longer served publicly.
export const api = axios.create({ baseURL: '/api', withCredentials: true });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err?.response?.status === 401 && onUnauthorized) onUnauthorized();
    return Promise.reject(err);
  }
);

// Turn a server field path like "costSheet.groups.0.lines.2.name" into
// something readable: "Costing Sheet › Group 1 › Line 3 › Item name".
/**
 * Field names as a factory user would say them.
 *
 * A zod error arrives as a machine path — `charges.0.gstRatePct` — and anything missing from
 * this map passes through raw, so the person who has to fix the form reads `gstRatePct`
 * instead of `GST Rate`. The names are taken from the route schemas rather than guessed;
 * add an entry in the same commit you add a field, or the message degrades silently.
 */
const FIELD_LABELS: Record<string, string> = {
  // structure
  groups: 'Group',
  lines: 'Line',
  charges: 'Charge',
  costSheet: 'Costing Sheet',
  buyers: 'Buyer',
  related: 'Related',
  containers: 'Container',
  moves: 'Movement',
  workers: 'Worker',
  rates: 'Rate',
  batches: 'Packing batch',

  // identity and naming
  factoryCode: 'Factory Code',
  name: 'Name',
  groupName: 'Group name',
  code: 'Code',
  alias: 'Alias',
  label: 'Label',
  description: 'Description',
  note: 'Note',
  notes: 'Notes',
  comment: 'Comment',
  ref: 'Reference',
  reason: 'Reason',
  status: 'Status',
  kind: 'Kind',
  type: 'Type',
  category: 'Category',

  // money on a document
  qty: 'Qty',
  unitPrice: 'Unit Price',
  amount: 'Amount',
  pct: 'Percentage',
  value: 'Value',
  rate: 'Rate',
  discountPct: 'Discount %',
  discountAmt: 'Discount Amount',
  gstRatePct: 'GST Rate',
  hsnCode: 'HSN Code',
  isTaxable: 'Taxable',
  flatAmount: 'Flat Amount',
  marginPct: 'Margin %',
  factoryExpensePct: 'Factory Expense %',
  wastagePct: 'Wastage %',
  placeOfSupply: 'Place of Supply',
  reverseCharge: 'Reverse Charge',
  paymentTerms: 'Payment Terms',
  bankDetails: 'Bank Details',
  currency: 'Currency',
  currencyId: 'Currency',
  rateToBase: 'Rate to INR',
  symbol: 'Symbol',

  // parties
  buyerId: 'Buyer',
  supplierId: 'Supplier',
  relatedId: 'Related product',
  productId: 'Product',
  orderId: 'Order',
  orderLineId: 'Order line',
  vendorId: 'Vendor',
  partyName: 'Party',
  partyType: 'Party type',
  contactName: 'Contact',
  payeeName: 'Payee',
  email: 'E-mail',
  phone: 'Phone',
  altPhone: 'Alternate phone',
  website: 'Website',
  address: 'Address',
  addressL1: 'Address line 1',
  addressL2: 'Address line 2',
  city: 'City',
  state: 'State',
  country: 'Country',
  pincode: 'PIN Code',
  gstNo: 'GSTIN',
  panNo: 'PAN',
  iecNo: 'IEC',
  cinNo: 'CIN',
  market: 'Market',
  channel: 'Channel',

  // dates and terms
  date: 'Date',
  orderDate: 'Order date',
  deliveryDate: 'Delivery date',
  expectedDelivery: 'Expected delivery',
  invoiceDate: 'Invoice date',
  dueDate: 'Due date',
  validUntil: 'Valid until',
  shipDate: 'Ship date',
  packedOn: 'Packed on',
  incoterms: 'Incoterms',
  deliveryTerms: 'Delivery terms',

  // production routing
  stageLineId: 'Stage line',
  stageStepId: 'Stage step',
  fromStageId: 'From stage',
  toStageId: 'To stage',
  method: 'Costing method',
  expression: 'Formula',
  head: 'Cost head',
  measureUnit: 'Measure unit',
  dimUnit: 'Dimension unit',
  unitId: 'Unit',
  unit: 'Unit',

  // packing and shipping
  cartons: 'Cartons',
  cartonCount: 'Carton count',
  piecesPerCarton: 'Pieces per carton',
  packLengthIn: 'Carton length (in)',
  packWidthIn: 'Carton width (in)',
  packHeightIn: 'Carton height (in)',
  netWeightKg: 'Net weight (kg)',
  grossWeightKg: 'Gross weight (kg)',
  cbmPerCartonOverride: 'CBM per carton',
  shippingMarks: 'Shipping marks',
  marks: 'Marks',
  packingBatchId: 'Packing batch',
  shipmentLineId: 'Shipment line',
  containerId: 'Container',
  containerIndex: 'Container',
  containerTypeId: 'Container type',
  containerNo: 'Container No.',
  sealNo: 'Seal No.',
  tareWeightKg: 'Tare weight (kg)',
  capacityCbm: 'Capacity (CBM)',
  payloadKg: 'Payload (kg)',
  portOfLoading: 'Port of loading',
  portOfDischarge: 'Port of discharge',
  finalDestination: 'Final destination',
  vesselOrFlight: 'Vessel / flight',
  blAwbNo: 'B/L or AWB No.',
  blAwbDate: 'B/L or AWB date',
  shippingBillNo: 'Shipping bill No.',
  shippingBillDate: 'Shipping bill date',
  transporterName: 'Transporter',
  transporterGstin: 'Transporter GSTIN',
  vehicleNo: 'Vehicle No.',
  ewayBillNo: 'E-way bill No.',
  ewayBillDate: 'E-way bill date',
  irn: 'IRN',
  ackNo: 'Acknowledgement No.',
  ackDate: 'Acknowledgement date',

  // stock
  rawItemId: 'Raw item',
  itemTypeId: 'Item type',
  materialId: 'Material',
  openingQty: 'Opening qty',
  reorderLevel: 'Reorder level',
  stockTxnId: 'Stock receipt',

  // workforce
  workerId: 'Worker',
  contractorId: 'Contractor',
  tradeId: 'Trade',
  tradeName: 'Trade',
  payType: 'Pay type',
  dailyRate: 'Daily rate',
  monthlySalary: 'Monthly salary',
  monthlyDivisor: 'Monthly divisor',
  halfDayFactor: 'Half-day factor',
  shiftHours: 'Shift hours',
  otHours: 'Overtime hours',
  otHourlyRate: 'Overtime rate',
  otMultiplier: 'Overtime multiplier',
  minWages: 'Minimum wages',
  joinedOn: 'Joined on',
  exitOn: 'Left on',
  exitReason: 'Reason for leaving',
  accrualFrom: 'Accrues from',
  guardianName: 'Guardian',
  gender: 'Gender',
  dateOfBirth: 'Date of birth',
  emergencyName: 'Emergency contact',
  emergencyPhone: 'Emergency phone',
  aadhaarNo: 'Aadhaar No.',
  uanNo: 'UAN',
  esicNo: 'ESIC No.',
  bankName: 'Bank',
  bankAccountNo: 'Account No.',
  bankIfsc: 'IFSC',
  upiId: 'UPI ID',
  presumePresent: 'Presume present',
  weeklyOffDays: 'Weekly off days',
  defaultAdvanceRecovery: 'Default advance recovery',

  // statutory
  statutoryComponentId: 'Statutory component',
  statutoryComponentIds: 'Statutory components',
  employeePct: 'Employee %',
  employerPct: 'Employer %',
  wageCeiling: 'Wage ceiling',
  eligibilityCeiling: 'Eligibility ceiling',
  isProvision: 'Provision',

  // account
  password: 'Password',
  currentPassword: 'Current password',
  newPassword: 'New password',
  role: 'Role',
  isActive: 'Active',
};
/**
 * `charges.0.gstRatePct` → `Charge #1 › GST Rate`.
 *
 * An array index belongs to the label BEFORE it — "Charge #1", not "Charge › #1" — so the
 * separator in front of an index is collapsed after the join rather than each label being
 * given a trailing space, which is what used to leave "Charge  #1" with two spaces in it.
 */
function prettyPath(path: string): string {
  return path
    .split('.')
    .map((seg) => (/^\d+$/.test(seg) ? `#${Number(seg) + 1}` : FIELD_LABELS[seg] ?? seg))
    .join(' › ')
    .replace(/ › (#\d+)/g, ' $1');
}

/** Extract a human-readable message from an axios error. */
export function apiError(err: unknown, fallback = 'Something went wrong.'): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string; details?: { path?: string; message?: string }[] } | undefined;
    if (data?.error) {
      if (data.details?.length) {
        const parts = data.details.map((d) => (d.path ? `${prettyPath(d.path)}: ${d.message}` : d.message));
        return `${data.error} — ${parts.join('; ')}`;
      }
      return data.error;
    }
    return err.message;
  }
  return fallback;
}
