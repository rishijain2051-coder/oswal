/**
 * Withholding money from a response that also carries something else.
 *
 * The permission catalogue promises that `orders.view` shows "the order, its products and its
 * quantities without the money", and that `money.view` is what "See order value, amount
 * received and balance" needs. `serializeOrder` did not know that: it returns the priced
 * total, the tax breakdown, the buyer's position and the jobwork accrued in the same object as
 * the delivery date, so a floor supervisor holding only `orders.view` was reading every one of
 * them. The prose was right and the code was wrong.
 *
 * Why the stripping lives HERE and not in the engines:
 *
 * - `serializeOrder`, `finishedPosition` and the rest stay ignorant of permissions for exactly
 *   the reason they stay ignorant of `deletedAt` — filtering belongs at the query and response
 *   layer, and an engine that knew about the caller could not be tested with fixed inputs.
 *   `verify.ts` asserts that separation for soft delete; this file is the same discipline.
 * - It cannot be done in the client. A figure filtered in a browser has still been sent, and
 *   the whole point of the money permissions is that it has not.
 *
 * **A money figure appears at FIVE depths of a serialized order, and the first attempt at this
 * file only found two of them.** The board strip went on printing `₹55/pc` and `$11,700.00`
 * because the rates the UI reads are under `line.board.stages`, a DERIVED copy, while the raw
 * `line.stages` array that was being blanked is not rendered at all; and the line value is
 * `amount`, not `unitPrice × qty`, so blanking the unit price left the total untouched. The
 * lesson is in `verify.ts`: its fixture is now the real response shape rather than a plausible
 * one, because a fixture that omits a field cannot fail on it.
 *
 * Each function nulls the money and sets a `*Hidden` flag rather than deleting the keys, so
 * the UI can say "you cannot see this" instead of rendering a balance of zero and being
 * believed. Same shape as `stripCosting` in products.routes.ts and `redact` in
 * manforce.routes.ts.
 */

/** Money on a serialized order: the priced total, the tax breakdown, the position, the rates. */
export function stripOrderMoney<T extends Record<string, any>>(order: T): T {
  return {
    ...order,
    total: null,
    totals: null,
    money: null,
    // Jobwork is pieces × rate, so the list is a payables figure however it is labelled.
    jobwork: [],
    lines: mapArray(order.lines, (line) => stripLineRates(stripLineValue(line))),
    moneyHidden: true,
    ratesHidden: true,
  };
}

/**
 * Rates only, leaving the order's VALUE intact — for somebody who may see what the buyer owes
 * but not what the factory pays its vendors and workers. The two are separate permissions and
 * `stripOrderMoney` is too blunt for the boundary between them.
 */
export function stripOrderRates<T extends Record<string, any>>(order: T): T {
  return {
    ...order,
    jobwork: [],
    lines: mapArray(order.lines, stripLineRates),
    ratesHidden: true,
  };
}

/**
 * What the line is WORTH. `amount` and `grossAmount` are the figures the UI actually prints —
 * the client does not multiply `unitPrice` by `qty` itself — so blanking the inputs without
 * these leaves the value on screen. All of them go.
 */
function stripLineValue<T extends Record<string, any>>(line: T): T {
  if (!isObject(line)) return line;
  return {
    ...line,
    unitPrice: null,
    discountPct: null,
    discountAmt: null,
    lineTotal: null,
    net: null,
    amount: null,
    grossAmount: null,
  };
}

/**
 * What the line's stages PAY. Three places carry it and all three are rendered somewhere:
 *
 * - `stages` — the stored `OrderLineStage` rows, used by the routing drawer.
 * - `board.stages` — the DERIVED strip the production tab draws, with `jobworkValue` and
 *   `labourValue` already multiplied out.
 * - `board.jobwork` — a per-line roll-up by vendor, which is what printed
 *   "Marigold Tile Studio: ₹8,640.00 (36 pcs)" under the strip after the first two were
 *   fixed. Note it is a SECOND jobwork list: the order-level `jobwork` is not the only one.
 * - `history[].labourValue` — what a single past movement earned.
 *
 * `vendors` and `outsourcedStages` are deliberately KEPT. Who does a stage is a routing fact
 * and the floor needs it; only the rate attached to it is money.
 */
function stripLineRates<T extends Record<string, any>>(line: T): T {
  if (!isObject(line)) return line;
  return {
    ...line,
    stages: mapArray(line.stages, (s) => ({ ...s, jobworkRate: null, labourRate: null })),
    board: isObject(line.board)
      ? {
          ...line.board,
          // The piece counts (`at`, `cleared`, `reached`) are the board itself and stay.
          stages: mapArray(line.board.stages, (s) => ({ ...s, jobworkRate: null, labourRate: null, jobworkValue: null, labourValue: null })),
          // Emptied rather than zeroed: the vendor's name is fine, the amount beside it is not.
          jobwork: [],
        }
      : line.board,
    history: mapArray(line.history, (h) => ({ ...h, labourValue: null })),
  };
}

/**
 * Invoice money on the order's Fulfilment read. The invoice is returned WHOLE on purpose —
 * its total is the document's, not this order's share — which is precisely why it has to be
 * blanked for somebody with no invoice or money permission: `mine.pieces` is a quantity and
 * is fine, but `totals.grandTotal` is a tax document's value.
 */
export function stripFulfilmentMoney<T extends Record<string, any>>(payload: T): T {
  return {
    ...payload,
    invoices: mapArray(payload.invoices, (i) => ({
      ...i,
      totals: null,
      exchangeRate: null,
      charges: [],
      lines: mapArray(i.lines, stripLineValue),
    })),
    invoiceMoneyHidden: true,
  };
}

const isObject = (v: unknown): v is Record<string, any> => v != null && typeof v === 'object';

/** Map an array if it is one, and leave anything else exactly as it came. */
function mapArray<T>(value: T, fn: (item: any) => any): T {
  return (Array.isArray(value) ? value.map(fn) : value) as T;
}
