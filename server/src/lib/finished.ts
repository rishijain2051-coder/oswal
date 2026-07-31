/**
 * Finished goods engine.
 *
 * What is finished and still here is DERIVED, exactly as where pieces are is derived from
 * the StageMove ledger. There is no quantity-on-hand column and there must never be one: it
 * would be a second record of a fact this function already computes, and it would drift the
 * first time a movement was undone.
 *
 * Four things put finished pieces on the floor and two take them off:
 *
 *   + the board's DONE bucket      read LIVE from buildBoard, never copied
 *   + adjustments                  an opening balance, a physical count correction
 *   + bought-in goods              a supplier receipt against a product (RawItem.productId)
 *   + returns                      goods coming back after a dispatch
 *   − packed                       still here, but in a box and spoken for
 *   − shipped                      gone
 *
 * The board is read live rather than mirrored into rows on COMPLETE. That is the whole
 * reason this engine can be trusted: undo a completion and the stock un-does itself, and a
 * RETURN move reduces it without anybody writing a compensating row.
 *
 * Pieces are either EARMARKED to the order line that produced them, or in a FREE POOL that
 * any order may draw on. Over-production, an opening balance, bought-in goods and buyer
 * returns are free-pool by nature — they belong to no order. Both are counted here, and
 * `byProduct` is the sum of the two.
 *
 * Pure: no DB. `salesBoard.ts` is the seam that loads for it, the same split as
 * production.ts / orderBoard.ts and workforce.ts / manforce.ts. It knows nothing about
 * `deletedAt` — the query that feeds it excludes deleted rows (see lib/softDelete.ts), and
 * verify.ts asserts that this stays true.
 */

import { FINISHED_KINDS } from './shipping';

/** A completed-pieces figure straight off the board, per order line. */
export interface BoardDoneRow {
  orderLineId: number;
  productId: number;
  /** `buildBoard(...).done` for that line. */
  done: number;
  /** What the line was ordered, so over-production is recognisable. */
  ordered: number;
}

export interface FinishedTxnRow {
  productId: number;
  orderLineId: number | null;
  /** ADJUST_IN | ADJUST_OUT | RETURN_IN — see FINISHED_KINDS. */
  kind: string;
  /** Always positive; `kind` carries the direction. */
  qty: number;
}

/** A supplier receipt of a finished product, bought in rather than made. */
export interface BoughtInRow {
  productId: number;
  /** Signed by the receipt's own type: IN positive, OUT negative. */
  qty: number;
}

export interface PackedRow {
  productId: number;
  orderLineId: number | null;
  qty: number;
}

export interface ShippedRow {
  productId: number;
  orderLineId: number | null;
  qty: number;
}

export interface FinishedInput {
  boardDone: BoardDoneRow[];
  txns: FinishedTxnRow[];
  boughtIn: BoughtInRow[];
  packed: PackedRow[];
  shipped: ShippedRow[];
}

export interface FinishedCell {
  productId: number;
  /** Null on a free-pool or product-level cell. */
  orderLineId: number | null;

  boardDone: number;
  adjusted: number;
  boughtIn: number;
  returned: number;
  packed: number;
  shipped: number;

  /** Finished, still here, whether boxed or loose. */
  onHand: number;
  /** Finished, here, and not yet in a box. */
  availableToPack: number;
  /** In a box, here, and not yet gone — what a dispatch may actually draw on. */
  availableToShip: number;
  /** Made beyond what the line was ordered. Free-pool by nature. 0 on a free-pool cell. */
  overProduced: number;
}

export interface FinishedPosition {
  /** Everything for one product, order-linked and free pool together. */
  byProduct: Map<number, FinishedCell>;
  /** Per order line. */
  byOrderLine: Map<number, FinishedCell>;
  /** Per product, the part that belongs to no order. */
  freePool: Map<number, FinishedCell>;
}

const KINDS = new Set<string>(FINISHED_KINDS);

function cell(productId: number, orderLineId: number | null): FinishedCell {
  return {
    productId,
    orderLineId,
    boardDone: 0,
    adjusted: 0,
    boughtIn: 0,
    returned: 0,
    packed: 0,
    shipped: 0,
    onHand: 0,
    availableToPack: 0,
    availableToShip: 0,
    overProduced: 0,
  };
}

/** Finish a cell by working out the three derived figures. Never negative. */
function settle(c: FinishedCell): FinishedCell {
  c.onHand = c.boardDone + c.adjusted + c.boughtIn + c.returned - c.shipped;
  // Packed pieces are still on hand — they are in a box in the corner, not gone. What they
  // are not is available to pack again.
  c.availableToPack = Math.max(0, c.boardDone + c.adjusted + c.boughtIn + c.returned - c.packed);
  // A dispatch draws on BOXES, not on loose finished pieces. Shipping what was never packed
  // is what the pack step exists to prevent.
  c.availableToShip = Math.max(0, c.packed - c.shipped);
  return c;
}

/**
 * Work out what is finished, packed and gone.
 *
 * Invariants (all asserted in prisma/verify.ts):
 *   boardDone + adjusted + boughtIn + returned − shipped === onHand
 *   the order-linked cells plus the free pool sum to byProduct
 *   availableToShip counts PACKED and unshipped, never raw onHand
 */
export function finishedOnHand(input: FinishedInput): FinishedPosition {
  const byOrderLine = new Map<number, FinishedCell>();
  const freePool = new Map<number, FinishedCell>();

  const line = (orderLineId: number, productId: number) => {
    let c = byOrderLine.get(orderLineId);
    if (!c) byOrderLine.set(orderLineId, (c = cell(productId, orderLineId)));
    return c;
  };
  const free = (productId: number) => {
    let c = freePool.get(productId);
    if (!c) freePool.set(productId, (c = cell(productId, null)));
    return c;
  };

  // --- the board, read live -------------------------------------------------
  for (const b of input.boardDone) {
    const c = line(b.orderLineId, b.productId);
    c.boardDone += b.done;
    // Pieces made beyond the order are recorded on the line (they came off its board) but
    // named as over-production, because that is what any order may draw on.
    c.overProduced += Math.max(0, b.done - b.ordered);
  }

  // --- adjustments and returns ---------------------------------------------
  for (const t of input.txns) {
    if (!KINDS.has(t.kind)) continue; // an unknown kind must not silently count as a receipt
    const c = t.orderLineId != null ? line(t.orderLineId, t.productId) : free(t.productId);
    const qty = Math.abs(t.qty);
    if (t.kind === 'ADJUST_IN') c.adjusted += qty;
    else if (t.kind === 'ADJUST_OUT') c.adjusted -= qty;
    else if (t.kind === 'RETURN_IN') c.returned += qty;
  }

  // --- bought in: no order, by definition ----------------------------------
  for (const p of input.boughtIn) free(p.productId).boughtIn += p.qty;

  // --- out again -----------------------------------------------------------
  for (const p of input.packed) {
    const c = p.orderLineId != null ? line(p.orderLineId, p.productId) : free(p.productId);
    c.packed += p.qty;
  }
  for (const s of input.shipped) {
    const c = s.orderLineId != null ? line(s.orderLineId, s.productId) : free(s.productId);
    c.shipped += s.qty;
  }

  for (const c of byOrderLine.values()) settle(c);
  for (const c of freePool.values()) settle(c);

  // --- roll up to the product ---------------------------------------------
  const byProduct = new Map<number, FinishedCell>();
  const into = (src: FinishedCell) => {
    let c = byProduct.get(src.productId);
    if (!c) byProduct.set(src.productId, (c = cell(src.productId, null)));
    c.boardDone += src.boardDone;
    c.adjusted += src.adjusted;
    c.boughtIn += src.boughtIn;
    c.returned += src.returned;
    c.packed += src.packed;
    c.shipped += src.shipped;
    c.overProduced += src.overProduced;
  };
  for (const c of byOrderLine.values()) into(c);
  for (const c of freePool.values()) into(c);
  for (const c of byProduct.values()) settle(c);

  return { byProduct, byOrderLine, freePool };
}

/**
 * What one order line may still pack and ship.
 *
 * The free pool is deliberately NOT added in here. Drawing on it is a decision somebody
 * makes explicitly — a route lets a dispatch name free-pool stock — rather than something
 * that silently inflates every line's headroom.
 */
export function lineAvailability(
  pos: FinishedPosition,
  orderLineId: number
): { toPack: number; toShip: number; onHand: number } {
  const c = pos.byOrderLine.get(orderLineId);
  if (!c) return { toPack: 0, toShip: 0, onHand: 0 };
  return { toPack: c.availableToPack, toShip: c.availableToShip, onHand: c.onHand };
}

/** Free-pool headroom for a product, for a dispatch that asks for it by name. */
export function freeAvailability(pos: FinishedPosition, productId: number): { toPack: number; toShip: number } {
  const c = pos.freePool.get(productId);
  if (!c) return { toPack: 0, toShip: 0 };
  return { toPack: c.availableToPack, toShip: c.availableToShip };
}
