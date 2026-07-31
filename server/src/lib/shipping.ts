/**
 * Shipping engine — cartons, space, weight, and what may still go out.
 *
 * THE single authority for how many cartons a quantity makes, how much room and weight
 * they take, and whether a dispatch or an invoice is allowed. Mirrored exactly in
 * `client/src/util/shipping.ts` (keep them identical, like costing.ts, expr.ts and
 * pricing.ts) so the pack drawer's carton count, the container fit bars and the ship
 * guard update as you type and match what the API will decide. Change one, change both,
 * and re-run `npm run verify` — it compares the two files' text.
 *
 * Pure: no DB, no Prisma, no dates beyond what is handed in. It produces NO QUANTITIES of
 * its own — where pieces are is still the board's business, and what is on hand is
 * finished.ts's. This file only measures and refuses.
 *
 * Two rules that look like details and are not:
 *
 * 1. **`volumeAfterPackingCbm` on the product is PER PIECE, not per carton.** The wizard
 *    computes it as L×W×H×k divided by `piecesPerCarton`. Multiply it by the pieces in a
 *    carton to get that carton's volume; use it raw and every load under-reports by a
 *    factor of `piecesPerCarton`.
 * 2. **A part carton is a whole box for volume and pro-rata for weight.** A half-full box
 *    still occupies a full box on a vessel, but it does not weigh a full one.
 */

/** Delivery terms. `market` decides tax; this decides who pays for what in between. */
export const INCOTERMS = ['FOB', 'CIF', 'CFR', 'EXW', 'FCA'] as const;
export type Incoterm = (typeof INCOTERMS)[number];

export const SHIPMENT_STATUSES = ['PLANNED', 'LOADED', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'CANCELLED'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Movements of finished stock that the board cannot know about. */
export const FINISHED_KINDS = ['ADJUST_IN', 'ADJUST_OUT', 'RETURN_IN'] as const;
export type FinishedKind = (typeof FINISHED_KINDS)[number];

export const FINISHED_REASONS = ['OPENING', 'DAMAGE', 'PHYSICAL_COUNT', 'RETURN'] as const;
export type FinishedReason = (typeof FINISHED_REASONS)[number];

/**
 * Cubic metres per cubic inch. THE one definition in the app — the product wizard imports
 * it from here rather than keeping its own copy, so a carton measured on the packing screen
 * and a volume shown in the wizard can never disagree.
 */
export const CBM_PER_CUBIC_INCH = 0.0000163871;

/** Volumes are quoted to four places; two would lose a small carton entirely. */
export function round4(v: number): number {
  if (!isFinite(v)) return v;
  const r = Math.round((Math.abs(v) + Number.EPSILON) * 10000) / 10000;
  return v < 0 ? -r : r;
}

/** Two places, for weights and percentages. Mirrors `round()` in costing.ts. */
export function round2(v: number): number {
  if (!isFinite(v)) return v;
  const r = Math.round((Math.abs(v) + Number.EPSILON) * 100) / 100;
  return v < 0 ? -r : r;
}

// ---------------------------------------------------------------------------
// Cartons
// ---------------------------------------------------------------------------

export interface CartonCount {
  /** Boxes filled to `piecesPerCarton`. */
  full: number;
  /** Pieces in the last, short box. 0 when the quantity divided evenly. */
  lastPieces: number;
  /** Boxes in total — a short box is still a box. */
  total: number;
}

/**
 * How many cartons a quantity makes.
 *
 * A missing or zero `piecesPerCarton` means one piece per carton rather than a division by
 * zero: a product nobody has told us how to pack ships as loose pieces, which is wrong but
 * visible, where `Infinity` cartons would be neither.
 */
export function cartonsFor(qty: number, piecesPerCarton?: number | null): CartonCount {
  const per = Math.floor(piecesPerCarton ?? 0) > 0 ? Math.floor(piecesPerCarton as number) : 1;
  const n = Math.max(0, Math.floor(qty || 0));
  const full = Math.floor(n / per);
  const lastPieces = n - full * per;
  return { full, lastPieces, total: full + (lastPieces > 0 ? 1 : 0) };
}

/** The packing figures a carton is measured from — the product master, or a batch's snapshot. */
export interface PackSpec {
  packLengthIn?: number | null;
  packWidthIn?: number | null;
  packHeightIn?: number | null;
  piecesPerCarton?: number | null;
  /** Per piece, as the product master stores them. */
  netWeightKg?: number | null;
  grossWeightKg?: number | null;
  /** Per piece. See the header note — this is NOT a carton volume. */
  cbmPerPiece?: number | null;
  /** Set only when the box itself was measured and disagreed. Outranks everything. */
  cbmPerCartonOverride?: number | null;
}

/** The box's own volume from its dimensions, or null when they are not all known. */
export function cartonBoxCbm(p: PackSpec): number | null {
  const l = p.packLengthIn ?? 0;
  const w = p.packWidthIn ?? 0;
  const h = p.packHeightIn ?? 0;
  if (l <= 0 || w <= 0 || h <= 0) return null;
  return round4(l * w * h * CBM_PER_CUBIC_INCH);
}

export interface CartonVolume {
  /** What to use. */
  value: number;
  /**
   * Where it came from. OVERRIDE — a human measured this box. STORED — the per-piece figure
   * carried on the product or the batch. DERIVED — worked out from the dimensions.
   */
  source: 'OVERRIDE' | 'STORED' | 'DERIVED';
  /** What the dimensions say, when they are known — so a caller can show both. */
  derived: number | null;
  /** How far apart stored and derived are, as a percentage. 0 when only one exists. */
  mismatchPct: number;
}

/**
 * ONE CARTON's volume — always a whole box, never a fraction of one.
 *
 * There is no `piecesInCarton` argument on purpose. A half-full box occupies a full box on
 * a vessel, so a part carton is measured exactly like a full one; only its WEIGHT is
 * pro-rata, and that is `packedTotals`' business. An argument here would invite a caller to
 * scale the volume down and quietly under-report the load.
 *
 * The order of preference:
 *
 * 1. `cbmPerCartonOverride` wins outright — somebody measured this box, and a measurement
 *    outranks arithmetic.
 * 2. Otherwise the stored per-piece figure × `piecesPerCarton`. It may be a deliberate
 *    human override on the product, which the wizard allows on purpose, so it is trusted.
 * 3. Otherwise the dimensions.
 *
 * **How a caller hands authority to the dimensions:** clear `cbmPerPiece`. That is the whole
 * contract — when the packer edits a carton's L/W/H, the route drops the stored figure it
 * copied from the product, because that figure described a different box. There is
 * deliberately no "has it changed?" comparison in here: it would need the original to
 * compare against, and a rule that depends on data the caller may not pass is a rule that
 * silently stops working.
 *
 * `mismatchPct` is reported whenever both exist, so a caller can show both figures and let
 * a human decide. It is never resolved silently.
 */
export function cartonCbm(p: PackSpec): CartonVolume {
  const derived = cartonBoxCbm(p);
  const per = Math.floor(p.piecesPerCarton ?? 0) > 0 ? Math.floor(p.piecesPerCarton as number) : 1;
  const stored = p.cbmPerPiece != null && p.cbmPerPiece > 0 ? round4(p.cbmPerPiece * per) : null;
  const mismatchPct = gap(stored, derived);

  const override = p.cbmPerCartonOverride;
  if (override != null && override > 0) {
    return { value: round4(override), source: 'OVERRIDE', derived, mismatchPct };
  }
  if (stored != null) return { value: stored, source: 'STORED', derived, mismatchPct };
  if (derived != null) return { value: derived, source: 'DERIVED', derived, mismatchPct };
  return { value: 0, source: 'DERIVED', derived: null, mismatchPct: 0 };
}

/** How far apart two figures are, as a percentage of the larger. */
function gap(a: number | null, b: number | null): number {
  if (a == null || b == null || a <= 0 || b <= 0) return 0;
  return round2((Math.abs(a - b) / Math.max(a, b)) * 100);
}

/** A stored/derived disagreement worth telling the packer about. Rounding is not. */
export const CBM_MISMATCH_PCT = 1;

// ---------------------------------------------------------------------------
// What a load adds up to
// ---------------------------------------------------------------------------

/** A packed batch as this engine sees it: its spec, its pieces, and its boxes. */
export interface PackedBatch extends PackSpec {
  qty: number;
  cartonCount: number;
}

export interface LoadTotals {
  cartons: number;
  pieces: number;
  cbm: number;
  netKg: number;
  grossKg: number;
}

const EMPTY: LoadTotals = { cartons: 0, pieces: 0, cbm: 0, netKg: 0, grossKg: 0 };

/**
 * What a set of packed batches comes to.
 *
 * `cartonsTaken` is for a shipment that ships part of a batch: it scales the volume by
 * boxes and the weight by pieces, which is the distinction rule 2 in the header is about.
 */
export function packedTotals(batches: (PackedBatch & { cartonsTaken?: number; piecesTaken?: number })[]): LoadTotals {
  let t = { ...EMPTY };
  for (const b of batches) {
    const boxes = Math.max(0, Math.floor(b.cartonsTaken ?? b.cartonCount ?? 0));
    const pieces = Math.max(0, Math.floor(b.piecesTaken ?? b.qty ?? 0));
    if (boxes === 0 && pieces === 0) continue;

    // Volume is per box, and every box counts as full — including a short last one.
    const per = cartonCbm(b).value;

    t.cartons += boxes;
    t.pieces += pieces;
    t.cbm = round4(t.cbm + per * boxes);
    t.netKg = round2(t.netKg + (b.netWeightKg ?? 0) * pieces);
    t.grossKg = round2(t.grossKg + (b.grossWeightKg ?? 0) * pieces);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export interface Capacity {
  capacityCbm: number;
  payloadKg: number;
}

export interface ContainerFit {
  usedCbm: number;
  usedKg: number;
  /** Percentage of the box used, 0 when the box has no stated capacity (LCL). */
  cbmPct: number;
  kgPct: number;
  overCbm: boolean;
  overKg: boolean;
  fits: boolean;
}

/**
 * How full one container is.
 *
 * A capacity of 0 means "not a container" — an LCL part load — and can never be over
 * capacity, because there is no stated limit to exceed. Tare weight counts against the
 * payload: the limit is on what crosses a weighbridge, not on the cargo alone.
 */
export function containerFit(load: LoadTotals, cap: Capacity, tareKg = 0): ContainerFit {
  const usedCbm = round4(load.cbm);
  const usedKg = round2(load.grossKg + (tareKg || 0));
  const cbmCap = cap.capacityCbm ?? 0;
  const kgCap = cap.payloadKg ?? 0;
  const cbmPct = cbmCap > 0 ? round2((usedCbm / cbmCap) * 100) : 0;
  const kgPct = kgCap > 0 ? round2((usedKg / kgCap) * 100) : 0;
  const overCbm = cbmCap > 0 && usedCbm > cbmCap;
  const overKg = kgCap > 0 && usedKg > kgCap;
  return { usedCbm, usedKg, cbmPct, kgPct, overCbm, overKg, fits: !overCbm && !overKg };
}

/** Verified gross mass: the box plus what went in it. Never stored — always this sum. */
export function vgm(tareKg: number | null | undefined, cargoGrossKg: number): number {
  return round2((tareKg ?? 0) + cargoGrossKg);
}

export interface ContainerTypeLike extends Capacity {
  id: number;
  code: string;
}

export interface PlannedContainer {
  containerTypeId: number;
  code: string;
  cartonIndexes: number[];
  fit: ContainerFit;
}

/** One carton, as the planner moves it around. */
export interface PlannableCarton {
  cbm: number;
  grossKg: number;
}

/**
 * Propose a container plan for a set of cartons.
 *
 * Deliberately simple: biggest box first, filled until the next carton would not fit, then
 * a new box. It answers the question the factory actually asks — "how many 40HQ do I need"
 * — and it is a SUGGESTION. The packer moves cartons by hand afterwards, so a cleverer
 * bin-packing would buy accuracy nobody would trust anyway.
 *
 * Boxes with no capacity (LCL) are skipped: they would swallow everything and report a
 * perfect fit.
 */
export function planContainers(cartons: PlannableCarton[], types: ContainerTypeLike[]): PlannedContainer[] {
  const usable = types.filter((t) => (t.capacityCbm ?? 0) > 0).sort((a, b) => b.capacityCbm - a.capacityCbm);
  if (usable.length === 0 || cartons.length === 0) return [];

  const box = usable[0];
  const out: PlannedContainer[] = [];
  let current: number[] = [];
  let cbm = 0;
  let kg = 0;

  const flush = () => {
    if (current.length === 0) return;
    out.push({
      containerTypeId: box.id,
      code: box.code,
      cartonIndexes: current,
      fit: containerFit({ ...EMPTY, cartons: current.length, cbm, grossKg: kg }, box),
    });
    current = [];
    cbm = 0;
    kg = 0;
  };

  for (let i = 0; i < cartons.length; i++) {
    const c = cartons[i];
    const nextCbm = round4(cbm + c.cbm);
    const nextKg = round2(kg + c.grossKg);
    const wouldOverflow =
      (box.capacityCbm > 0 && nextCbm > box.capacityCbm) || (box.payloadKg > 0 && nextKg > box.payloadKg);
    // A single carton larger than the box still has to go somewhere — put it in its own
    // container rather than looping forever.
    if (wouldOverflow && current.length > 0) flush();
    current.push(i);
    cbm = round4(cbm + c.cbm);
    kg = round2(kg + c.grossKg);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * These return a message or null, exactly as `validateMove()` in production.ts does, so a
 * drawer can render the first refusal the same way the board's drawers already do. The
 * server re-checks every one of them INSIDE the write transaction under `lockOrder` — these
 * are the warning, not the enforcement.
 */

/** Pieces cannot leave that were never packed. */
export function guardShipQty(available: number, requested: number): string | null {
  if (!Number.isFinite(requested) || requested <= 0) return 'Enter how many pieces are going.';
  if (!Number.isInteger(requested)) return 'Pieces ship whole.';
  if (requested > available) {
    return available <= 0
      ? 'Nothing is packed and ready for this line yet.'
      : `Only ${available} pc(s) are packed and unshipped on this line.`;
  }
  return null;
}

/** Pieces cannot be packed that were never finished. */
export function guardPackQty(available: number, requested: number): string | null {
  if (!Number.isFinite(requested) || requested <= 0) return 'Enter how many pieces are being packed.';
  if (!Number.isInteger(requested)) return 'Pieces pack whole.';
  if (requested > available) {
    return available <= 0
      ? 'Nothing is finished and unpacked on this line yet.'
      : `Only ${available} finished pc(s) are still unpacked on this line.`;
  }
  return null;
}

/** Nothing may be billed that has not gone out, and nothing twice. */
export function guardInvoiceQty(shipped: number, alreadyInvoiced: number, requested: number): string | null {
  if (!Number.isFinite(requested) || requested <= 0) return 'Enter how many pieces are being billed.';
  const billable = shipped - alreadyInvoiced;
  if (shipped <= 0) return 'This line has not shipped yet, so there is nothing to bill.';
  if (requested > billable) {
    return billable <= 0
      ? `All ${shipped} shipped pc(s) on this line are already invoiced.`
      : `Only ${billable} of the ${shipped} shipped pc(s) are still to be invoiced.`;
  }
  return null;
}

/** A carton cannot hold more than it holds. */
export function guardCartonFit(cartons: number, piecesPerCarton: number, qty: number): string | null {
  const per = Math.floor(piecesPerCarton ?? 0) > 0 ? Math.floor(piecesPerCarton) : 1;
  if (cartons <= 0) return 'Enter how many cartons are going.';
  if (qty > cartons * per) {
    return `${cartons} carton(s) of ${per} hold at most ${cartons * per} pc — not ${qty}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The boxes an exporter actually books, seeded into `ContainerType` exactly as
 * `BUILTIN_METHODS` seeds the cost formulas. Capacities are the usable internal volume and
 * the common payload limit — both editable, because a line's own limits differ.
 *
 * LCL carries no capacity on purpose: it means "part load, no box of our own", and
 * `containerFit` treats a zero capacity as having no limit to exceed.
 */
export const BUILTIN_CONTAINER_TYPES = [
  { code: '20FT', name: "20' standard", capacityCbm: 33, payloadKg: 21000, sortOrder: 1 },
  { code: '40FT', name: "40' standard", capacityCbm: 67, payloadKg: 26500, sortOrder: 2 },
  { code: '40HQ', name: "40' high cube", capacityCbm: 76, payloadKg: 26500, sortOrder: 3 },
  { code: 'LCL', name: 'LCL / part load', capacityCbm: 0, payloadKg: 0, sortOrder: 4 },
] as const;
