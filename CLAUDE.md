# CLAUDE.md — Oswal Handicrafts ERP

Guidance for working in this repo.

## What this is

Modular ERP for Oswal Handicrafts (furniture/hardware exporter). **Phase 1 =
Product Management**, **Phase 2 = Operations** (proformas → orders → production
board), **Phase 3 = Manforce** (workers → muster → wages → statutory), **Phase 4 =
Finished Product & Sales** (finished stock → packing → container → shipment →
invoice). All four are built and self-checked. Product data (costing, dimensions,
differentiated volumes) feeds Operations; the Operations board feeds Manforce and
finished stock; what ships feeds the invoice.

## The shape of the app — one hub, one home for money

Two rules about where things live. They are navigation decisions, but breaking either
one puts the same fact in two places, which is the failure the rest of this file is
about.

**1. The ORDER is the single source of truth, and the order page is the hub.** An order
is what a person asks about, so `OrderDetailPage` must answer every form of that
question without sending anybody to a list: the board, what is finished, which cartons
it went into, which container carried them, which invoice billed it, what the buyer has
paid, its proforma, its products, its material sheets, its attachments, and who changed
a price. The sidebar lists are for seeing *everything* at once — they are not the way to
reach *one* job. Add a record that hangs off an order and it must become reachable from
that page in the same commit.

- The page is in **tabs** (Production · Fulfilment · Paperwork · Money · History) with
  the headline figures in a strip **above** them, so no tab repeats a summary and the
  board — the thing looked at daily — is not buried under a dozen cards.
- **`GET /orders/:id/fulfilment`** is the one read behind everything after the board:
  per-line finished/packed/shipped/invoiced, the packing batches, the shipments with
  their containers, and the invoices. It is deliberately **NOT folded into
  `serializeOrder`**, which runs once per row of the orders list — loading the finished
  position for every order to draw a list is several board walks per row.
- A co-loaded shipment and an invoice spanning orders are returned **whole**, with
  `mine` naming this order's share. Container fit is a property of the box, not of one
  order's share of it, so trimming the lines would make the capacity bar lie; and an
  invoice's total is the document's, not this order's.
- `order-fulfilment` is in **both** `OPS_KEYS` and `SALES_KEYS`: packing and shipping
  move it, but so does a board clearance, because DONE is what finished stock derives
  from.

**2. Money has exactly one home: `/finance`.** Receipts, payments, party statements and
invoices are all under it (`client/src/pages/finance/`). Payments used to sit under
Operations and invoices under Sales, which put the two halves of one buyer's position on
opposite sides of the menu. The old paths still resolve — `App.tsx` redirects
`/operations/payments/*` and `/sales/invoices/*` with the splat carried across, so a
bookmark lands on the right record rather than on a section index.

The sidebar follows from those two rules: **Orders** is top-level (it is the hub), then
**Operations** (proformas, delivery, sheets, suppliers, raw stock), **Dispatch**
(finished stock, packing, shipments), **Finance**, **Manforce**, **Products**, and
**Settings**. Only the group you are in is expanded — `openKeys` is controlled, not
`defaultOpenKeys`, which is read once at mount and left a group shut when you navigated
into it from elsewhere. Adding a sub-section means adding its URL segment to
`SECTION_KEYS` in the same commit, or the sidebar highlights nothing on that page.

## Architecture

- npm **workspaces**: `server` + `client`.
- **server**: Express + TypeScript, Prisma → **Postgres** (`server/prisma/schema.prisma`).
  Run with `tsx` in dev. See *The database* below — it lives inside the repo.
- **client**: React + Vite + TypeScript + Ant Design. Data via `@tanstack/react-query`
  + axios (`client/src/api/`). Vite proxies `/api` and `/uploads` to `:689`.
- **Auth**: JWT bearer token in `localStorage`; permissions are **user-defined roles**, not
  ranks (`server/src/middleware/auth.ts`, `client/src/auth/AuthContext.tsx`). See
  *Permissions* below.

## The database — Postgres, inside the repo

One factory, one machine. The backend runs on the factory's own computer and the database
runs beside it: `server/.pgdata` is a real Postgres cluster, driven by
`server/scripts/pg.ts`. The binaries come from the `embedded-postgres` npm package, so
there is nothing to install and no Docker — `npm install && npm run pg:start`. It was
SQLite until the move; the schema stayed portable and only the provider changed.

- **`DATABASE_URL` is the single source of truth.** Port, user, password and database name
  are parsed out of it; the port reaches `pg_ctl` as `-o "-p …"` rather than being written
  into `postgresql.conf`, so there is no second copy to disagree. Point it at a hosted
  Postgres and the app is unchanged — the `pg:*` scripts refuse to manage a non-local host.
- `initdb` uses **`--locale=C`**, which sorts in byte order — the collation SQLite gave,
  so `orderBy: name` lists did not silently reorder under everyone.
- The version in `package.json` is **pinned exactly, not caret-ranged**. A minor bump would
  ship a new Postgres major whose binaries refuse to open an existing data directory.
- `pg_ctl start` output goes to a **file, never a pipe**: the postmaster inherits the
  handle and outlives `pg_ctl`, so with a pipe `spawnSync` waits forever on a healthy
  database. This cost a debugging session; the comment in `run()` says so.
- Only `initdb`, `pg_ctl` and `postgres` ship — **no `psql`, no `createdb`, no `pg_dump`.**
  The database is created over a `pg` connection, and backups are a directory copy.

**Backups: `npm run db:backup` / `db:backups` / `db:restore`** (`scripts/backup.ts`).
Postgres permits copying a data directory only while the server is **cleanly stopped**, so
the script stops, copies, and starts again — a copy of a running cluster is a torn snapshot
that may not start at all. Two things matter:

- **`uploads` is copied with it.** Photos, hand-over proof images, worker documents and the
  buyer's own POs are files with only a filename in the database; tables alone would restore
  rows pointing at documents that no longer exist. One record, one backup.
- A `BACKUP_COMPLETE` marker is written **last**, and `list`/`restore` ignore directories
  without it — an interrupted copy must not look like a backup. A restore moves the cluster
  it replaces aside instead of deleting it, so restoring the wrong one is itself undoable.

A copy restores onto the **same Postgres major and platform** (both pinned), and it is a
cold, full copy — which is why the version pin above is load-bearing.

## Concurrency — the engine no longer protects the board

SQLite serialised write transactions, which made read-validate-write safe almost by
accident. **Postgres at READ COMMITTED does not:** two clearances can read the same board,
both conclude the pieces are there, and both append. The transaction was never what closed
that window; the engine was.

So `server/src/lib/rowLock.ts` makes it explicit. `lockOrder(tx, orderId)` takes an
exclusive lock on the parent `Order` row — an ordinary `updateMany` of `updatedAt`, which
takes the same row lock without hand-written SQL — and it **must be the first statement in
the transaction**. Taken after the board has been read it locks nothing that matters. Three
routes hold it, so they take their turn per order: `POST /orders/:id/moves`,
`DELETE /moves/:id` (an undo must still be the newest movement) and `PUT /orders/:id`
(qty may not drop below `wip + done`, re-checked under the lock rather than before it).
Orders lock independently — only movements on the same order invalidate each other.

## Search — `contains` is case-sensitive here

`like(q)` in `server/src/lib/search.ts`, used by every search box. SQLite's `LIKE` matched
regardless of case for free; Postgres' does not, so a bare `{ contains: q }` silently
returns nothing for a lower-case search over upper-case data — a search box that looks
broken with no error anywhere. `like()` adds `mode: 'insensitive'` (`ILIKE`) and is stated
in one place so a new search box cannot get the case-sensitive default by accident.

## Costing engine — the core

`server/src/lib/costing.ts` (pure functions) and its client mirror
`client/src/util/costing.ts` MUST stay in sync. Likewise the safe expression
evaluator exists on both sides: `server/src/lib/expr.ts` and
`client/src/util/expr.ts` — keep them identical. Formulas were reverse-engineered
and verified to the rupee against `example.xlsx` (the "Crazy Almirah", FOB
₹19,180.60 — reproduced by the seed as product `AB-00123`).

- 7 heads: MAIN_COMPONENT, SUB_COMPONENT, HARDWARE, POLISHING, PACKAGING, LABOUR, FORWARDING.
- Hierarchy: CostSheet → CostGroup (has a `method`) → CostLine (per-line `rate`).
- **Methods are DATA-DRIVEN** — stored in the `CostMethod` table with a free-form
  `expression` (vars L/W/H/AL/AW/AH/QTY/WASTAGE/WEIGHT), editable/creatable in
  Master Data → Cost Formulas. `BUILTIN_METHODS` in costing.ts seeds the six
  defaults (CFT/SQFT/SQMT/RFT/WEIGHT/QTY). `lineMeasure(methodDef, line)`
  evaluates the expression; product routes load the method map via
  `loadMethodMap()` and pass it into `computeCostSheet`.
- Measures/amounts are **computed by the API**, never stored (avoids drift).
- Roll-up: Ex-Factory excludes Forwarding; FOB adds Forwarding + FactoryExpense% +
  Margin% cumulatively; Non-FOB is the same without Forwarding.
- If you change a formula, update BOTH files and re-verify against `example.xlsx`.

## Exchange rates (ICEGATE)

The ICEGATE customs exchange-rate page is CAPTCHA-protected, so rates are NOT
fetched automatically (never bypass the CAPTCHA). Master Data → Currencies has a
human-assisted importer (`CurrencyRatesImport.tsx`): the user solves the CAPTCHA
on ICEGATE, copies the table, pastes it; the client parses the **Export** column
(last number per line) and the `POST /currencies/bulk-rates` endpoint applies it.
`rateToBase` = INR per 1 unit of the currency (base = INR).

## Operations — the production board

The factory flow is: **proforma → (accepted) → order → pieces move through stages →
each hand-over carries a note and photos → jobwork feeds Payments.**

- **Stage lines** (`StageLine` + `StageLineStep`, Master Data → Stage Lines) are the
  named routes, e.g. `X = raw joining → raw sanding → polishing → accessory fitting
  → QC → packaging`. A **product** is assigned one (`Product.stageLineId`, set in the
  wizard); each **order line SNAPSHOTS** the steps into `OrderLineStage` rows, so
  editing a master line never rewrites live orders.
- **Where pieces are is DERIVED, never stored.** `StageMove` is an append-only ledger;
  `server/src/lib/production.ts` (`buildBoard`) sums it into buckets
  `PENDING → stage 1..n → DONE`. This is the single source of truth — do not add a
  stored quantity column, it would drift.
- Move kinds and their endpoints: `RELEASE` (pending→stage), `ADVANCE` (forward),
  `REJECT` (backward / rework), `COMPLETE` (stage→done), `RETURN` (done→stage).
  `kind` is what disambiguates a null endpoint (null `toStageId` = DONE for COMPLETE
  but PENDING for REJECT). All rules live in `validateMove`; the client mirrors them
  in `client/src/pages/operations/board/moveLogic.ts` — **keep those two in sync.**
  The UI only asks for a *from* and a *to* and derives the kind, so an illegal move
  cannot be expressed.
- **Multi-step clearance:** a forward move spanning several stages is expanded by
  `expandHops()` into one `ADVANCE` per stage crossed, so each stage's `cleared`
  count — and therefore the jobwork owed for it — stays exact. **Only ADVANCE
  expands.** A rejection is one event, and a COMPLETE is taken at its word: finishing
  from stage 3 must not mark 4-6 as passed, or a vendor owning one of them would be
  paid for work nobody did. The drawer warns which stages a completion skips.
  `hopsBetween()` mirrors this client-side so the drawer can say "recorded as 3
  steps" before you commit. One submission may carry moves for several order lines
  (that is what the "Clear a stage" bulk drawer posts).
- **Outsourcing lives per stage.** `OrderLineStage.vendorId` (null = in-house) plus
  `jobworkRate` is the only source of truth, so any pattern works — stages 1-3
  in-house, 4 at a vendor, 5-6 in-house again. `OrderLine` carries no mode/vendor
  fields; `serializeOrder` derives `mode` (INHOUSE / MIXED / OUTSOURCED), `vendors`
  and `outsourcedStages`. A vendor stage with a zero rate is rejected, or it would
  silently bill nothing. Jobwork payable = pieces cleared × rate.
- **Hand-overs carry a comment and photos, not challans.** `StageMove.note` is the
  hand-over comment (applied to every hop of one submission) and `StageMovePhoto`
  holds uploaded proof-of-condition images. The moves response returns `photoMoveId`
  — the hop the pieces landed on — and the client posts the files to
  `POST /moves/:id/photos` right after. There is deliberately **no challan model**;
  don't reintroduce one.
- Guards worth preserving: only the newest movement of a line can be undone; a line's
  stage line cannot change once pieces have moved; order qty cannot drop below
  `wip + done`; `PUT /orders/:id` PATCHES lines by id (never wipe-and-rebuild, that
  would destroy history). Order status auto-advances Confirmed → Production → Ready →
  **Shipped** (`impliedOrderStatus`, which takes the shipped quantity — a fully shipped
  order becomes Shipped, a partly shipped one stays where the board put it). Only **Closed
  and Cancelled** are human decisions now: `PATCH /orders/:id/status` accepts only those two
  and refuses the derived four, and `POST /orders/:id/reopen` leaves a terminal state and
  re-derives. The order page shows the status as a read-only tag with Close / Cancel /
  Reopen actions — never a free dropdown, which would offer statuses that do not stick.
- `OperationSheet` is now just a numbered **material sheet** (costing explosion for a
  product × qty). It holds no progress.

## Money — derived, not typed

`server/src/lib/finance.ts` is the accounting core; `orderMoney()` in
`lib/orderBoard.ts` and the `/finance/*` routes build on it. Two rules hold
everywhere:

**1. Nothing the system can work out is entered by hand.**
- **buyer receivable** = order value − receipts. `Order.exchangeRate` (snapshotted at
  creation) converts to rupees for totals.
- **jobwork payable** = board-accrued jobwork − payments. `jobworkEvents()` turns each
  clearance out of a vendor stage into a dated earning (pieces × that stage's rate),
  so a vendor's total is explained movement by movement. Pieces rejected and re-done
  earn again — the work was done again — which is why events count movements, not
  distinct pieces, and why they reconcile with the board's `cleared` figure. That
  reconciliation is the invariant to test.
- **material / wages** are the only manually-billed amounts. A `StockTxn` may be
  billed once (`LedgerEntry.stockTxnId @unique`), which keeps "what arrived" and "what
  they charged" separate without ever double-counting; un-billed deliveries are
  surfaced on the supplier statement.
- Therefore `BUYER` and `JOBWORK` rows may only be `PAYMENT`; posting a `BILL` for
  either is refused. Cancelled orders drop out of every total.

**2. Allocation is COMPUTED, never stored.** `allocateFifo()` spreads payments across
what is outstanding, oldest first: a payment settles the order it names, then the
surplus rolls on to the next oldest debt, and anything still left over is **credit on
account** rather than a negative balance. Because it is a pure function of (buckets,
payments) recomputed on every read, a later order automatically soaks up an existing
credit and nothing can go stale — there is deliberately no allocation table. Buyer
buckets are partitioned by currency so a receipt never crosses currencies.

**One shared context.** `buildFinanceContext()` allocates every payment once and
indexes the result by order; `orderMoney()` reads from it. Never recompute an order's
position from `order.ledger` alone — a row's `orderId` is only where a payment was
*aimed*, not where FIFO landed it, so doing so makes the order page and the Payments
page disagree. `financeContextFor()` loads what is needed; `serializeOrders()` shares
one context across a list.

Statements: `/finance/statement?partyType=…&partyId=…` returns a running balance plus
the detail behind every charge and how each payment was split. **A statement row
settles only the *allocated* part of a payment** — money on account is not a reduction
of any debt — which is what makes the closing balance equal the summary balance.
Overpayment to a party shows as "paid in advance" and is clamped out of the payable
total rather than offsetting real debts.

Endpoints: `/finance/receivables` (per order + buyer credits), `/finance/payables`
(per party, per-job breakdown), `/finance/parties` (index), `/finance/statement`,
`/finance/summary`. `financeTotals()` is shared with the dashboard so the two can
never disagree.

## Manforce — a worker is a running account

**There are no pay periods.** The factory pays people when it pays them: a worker may
draw an advance or go unpaid for two months. So a worker is an account like a jobwork
vendor — earnings accrue as dated events, payments are ad-hoc, nothing is ever "run" or
closed. Do not add a payroll-period model; it would be wrong on day one.

- `server/src/lib/workforce.ts` is the **pure engine** (no DB) and
  `server/src/lib/manforce.ts` is the **seam** that loads data into it — the same split
  as `production.ts` / `orderBoard.ts`. Nothing derivable is stored: no wage table, no
  balance column, no day count.
- **Attendance is exceptions-only.** Every active worker is presumed present on a
  working day; a row exists only to say otherwise (or to pay someone on a day off).
  Which days count is Admin config (`WorkforceSetting.weeklyOffDays` + `Holiday`), and
  `presumePresent` can switch the presumption off. Adding a holiday RESTATES past
  accrual, which is the point of deriving it.
- **Pay type decides which accrual applies** — DAY (rate × days), PIECE (board only,
  so attendance can never double-pay), MONTHLY (pro-rata per working day, never a
  lump). `monthlyPerDay()` honours the Admin's divisor; WORKING is exact, the FIXED_*
  bases are conventional and documented as such.
- **`Worker.accrualFrom` exists to stop double-paying history.** Wages used to be typed
  against a name; a migrated worker starts accruing after their last manual entry.
  Never default it to `joinedOn` for a migrated worker.
- **Two figures, one identity.** `balance` = earned − deductions − statutory −
  payments − advances (the party balance, used everywhere). `dueNow` is the same but with
  advance *recovery* in place of the advance, honouring each advance's monthly cap.
  `dueNow − advanceOutstanding === balance` — asserted in `verify.ts`. Break that and the
  worker page and the payables page start disagreeing.
- **Advance cash is ONE ledger row** (`LedgerEntry.advanceId @unique`, the same pattern
  as `stockTxnId`). `WorkerAdvance` holds only the recovery terms. Deleting the payment
  alone is refused; delete the advance and the cash goes with it.
- **Piece work comes off the board.** `StageMoveWorker` names who cleared a stage with a
  piece count each, which must sum to the movement's qty (`validateMoveWorkers`,
  mirrored in `client/src/pages/operations/board/moveLogic.ts` — **keep those in sync**).
  Priced at the stage's current `OrderLineStage.labourRate`, exactly as vendor jobwork is
  priced, so rework earns again and the totals reconcile with the board's `cleared`
  figure. `clearances()` in `production.ts` is the ONE walk over the move ledger that
  both `jobworkEvents` and `labourEvents` are built on — do not fork it.
- **Only a single-hop clearance can be attributed.** A move spanning several stages is
  refused rather than guessed at, because each hop is a different stage's work. A vendor
  stage refuses workers, and an in-house stage with workers named requires a rate (a zero
  rate elsewhere is normal — that stage is day-wage work).
- **Product LABOUR lines are REFERENCE only.** `CostLine.stageStepId` maps a labour line
  to a step of the product's stage line; `labourRatesForProduct()` seeds
  `OrderLineStage.labourRate` when an order snapshots its stages. Costing itself never
  reads it — the roll-up and the example.xlsx FOB must stay byte-identical.
- **Contractors are paid, gangs are not.** `Worker.contractorId` set = their earnings
  roll into the contractor's balance, and paying the worker directly is refused. A gang
  member is deliberately NOT a payable row of their own, or the money would count twice.
- **Statutory is admin-defined data** (`StatutoryComponent`, seeded from
  `BUILTIN_STATUTORY` exactly as `BUILTIN_METHODS` seeds cost formulas) and is incurred
  **only when posted**. `StatutoryPostingLine` stores the wage base it used, because the
  earnings behind it can legitimately be restated later and a posted liability must not
  move. Overlapping periods for one component are refused. `isProvision` accrues a cost
  that is never a payable.
- **Worker money stays out of order costing** (a deliberate decision) but workers,
  contractors and levies DO appear in `/finance/payables`, `/finance/parties`,
  `/finance/statement` and the dashboard total.
- **Dates are calendar facts.** Always go through `dayStart` / `dayKey` / `monthKey`.
  `toISOString().slice(0,10)` on a local midnight names the day BEFORE east of UTC and
  would shift a whole muster or statutory period; `verify.ts` guards this.
- RBAC: `muster.mark` for the muster, `workers.manage` / `workers.rates` / `wages.view` /
  `statutory.post` for the rest. Identity and bank fields need `workers.pii` (`redact()` in
  the routes) and the money block needs `wages.view` — both withheld server-side.

## Finished goods — a ledger, not a count

What is finished and still here is DERIVED, exactly as where pieces are is derived from
the `StageMove` ledger. `server/src/lib/finished.ts` is the pure engine.
**There is no quantity-on-hand column and there must never be one.**

- Four things put pieces on the floor and two take them off: the board's DONE bucket,
  adjustments, bought-in goods and returns; less packed and shipped.
- **The board is read LIVE via `buildBoard`, never mirrored into rows on COMPLETE.** That
  is the whole reason this can be trusted: undo a completion and the stock un-does itself,
  and a `RETURN` move reduces it without a compensating row. `FinishedTxn` therefore holds
  ONLY what the board cannot know — `ADJUST_IN`, `ADJUST_OUT`, `RETURN_IN`. Its `qty` is
  always positive and `kind` carries the direction, the same discipline as `OrderCharge`.
- **Bought-in finished goods reuse the supplier machinery.** `RawItem.productId` set means
  "this purchased item IS product X, bought in rather than made". The link is on `RawItem`
  and NOT on `StockTxn` deliberately: a receipt against a product would mean making
  `StockTxn.rawItemId` nullable, and some fifteen readers dereference `txn.rawItem` with no
  null check. This way the receipt, the `stockTxnId @unique` billed-once rule and the
  supplier statement are all untouched.
- Pieces are either EARMARKED to the order line that produced them or in a **FREE POOL**
  any order may draw on. An opening balance, over-production, bought-in goods and returns
  are free-pool by nature. `byProduct` is the sum of the two.
- **`availableToShip` counts PACKED and unshipped, never raw `onHand`** — shipping what was
  never packed is exactly what the pack step exists to prevent.
- **There is no location or godown dimension. Deliberately.** One factory, one floor; a
  second axis would be a column nobody fills in.

## Shipping — cartons, space and weight

`server/src/lib/shipping.ts` is the single authority for how many cartons a quantity makes,
how much room and weight they take, and whether a dispatch or an invoice is allowed —
mirrored exactly in `client/src/util/shipping.ts` (keep them identical, like `costing.ts`,
`expr.ts` and `pricing.ts`). `verify.ts` now compares **both** mirror pairs by text, from a
marker to end of file; the header comments above the marker may differ, and must not quote
the marker declaration or `indexOf` matches the comment instead of the code.

- **`Product.volumeAfterPackingCbm` is PER PIECE, not per carton** — the wizard divides
  `L×W×H×k` by `piecesPerCarton`. Carton volume is it × `piecesPerCarton`. Use it raw and
  every load under-reports by a factor of `piecesPerCarton`. `PackingBatch.cbmPerPiece`
  snapshots it in the same unit as its source so the property stays checkable.
  It reconciles back to the box volume **to within 4-dp rounding, not exactly** — the stored
  per-piece figure is rounded, so multiplying it back can be out by half a unit in the last
  place per piece. That drift is why `CBM_MISMATCH_PCT` is 1% and not zero; verify.ts asserts
  the tolerance rather than an equality the data cannot deliver.
- **A part carton is a whole box for volume and pro-rata for weight.** A half-full box still
  occupies a full box on a vessel. `cartonCbm()` takes no piece count at all, so a caller
  cannot scale a box down.
- Volume precedence is `cbmPerCartonOverride` (somebody measured it) → the stored per-piece
  figure → the dimensions. **A caller hands authority to the dimensions by clearing
  `cbmPerPiece`** — that is the whole contract, and there is deliberately no "has it
  changed?" comparison, which would depend on data the caller may not pass. A disagreement
  over 1% is reported via `mismatchPct` and never resolved silently.
- A capacity of 0 means "not a container" (an LCL part load) and can never be over capacity.
  Tare weight counts against the payload — the limit is on what crosses a weighbridge.
- `vgm()` is always `tare + derived cargo gross`; it is never stored, so it cannot
  contradict the packing list.
- `guardShipQty` / `guardPackQty` / `guardInvoiceQty` return a message or null, the shape
  `validateMove()` uses, so a drawer renders them the way the board's drawers already do.
  They are the WARNING; the server must re-check inside the write transaction under
  `lockOrder`.
- `ContainerType` is master data (CBM + payload kg), seeded from `BUILTIN_CONTAINER_TYPES`
  exactly as `BUILTIN_METHODS` seeds the cost formulas. `isActive`, not `deletedAt`. The
  seed refreshes only the name and sort order — **capacities are never overwritten**, or
  re-running it would undo the Admin's edit.

## Invoices — inputs copied, totals derived

`Invoice` **stores no total**. Its lines COPY their price inputs from the order line when it
is raised — the same thing accepting a proforma does when it copies charges onto the order —
and every figure is then produced by `documentValueOf()` / `documentTotalsOf()`. That is how
both rules hold at once: the document is frozen against a later correction to the order (the
property `StatutoryPostingLine.wages` exists for), yet nothing on it can contradict the one
pricing engine. `Invoice` satisfies `DocumentLike` as-is, so **pricing.ts needed no change**.
Document money now has **four readers**: `serializeOrder`, the FIFO buckets, the dashboard's
`orderValue()`, and the invoice.

An invoice may span SEVERAL ORDERS of one buyer; a SHIPMENT carries no money at all and no
`buyerId`, because a container may be co-loaded. Freight and insurance are document-level
charges on the invoice. A **cancelled invoice keeps its number** — a gap in an invoice series
is a compliance problem — and drops out of every total the way a cancelled order does.

## The receivable basis — the one setting that restates history

`AppSetting.receivableBasis` is `ORDER` (the default, and how the app has always worked) or
`INVOICE`. Because allocation is a pure function of (buckets, payments) recomputed on every
read, flipping it restates every balance and statement immediately — **no migration, nothing
to rebuild**.

- **It is applied inside `buildFinanceContext()` and in `buyerPositions()`, and nowhere
  else.** A route that branched on it separately would be a second source of truth and the
  order page and the Payments page would disagree — the failure this file already warns
  about. Note that `/finance/*` does NOT use `buildFinanceContext`: it has its own
  `financeData()`, so **both** funnels carry the basis.
- Under INVOICE the buckets are invoices, so **one bucket is no longer one order**. Callers
  must use `pos.subjectOf(bucket)`, never `orders.find(o => o.id === b.orderId)!`, and must
  match a receipt's allocations on `a.key` rather than `a.orderId`.
- **Only an `ISSUED` invoice is a debt.** A DRAFT has not been sent to anybody, so it is
  neither owed nor a reduction of the order book — counting it would make a receivable
  appear the moment somebody started typing.
- An invoice spanning orders is ONE debt. `attributeToOrders()` splits what was settled back
  across its orders weighted by `lineNet()`, giving the rounding remainder to the largest
  share so the parts sum to the whole EXACTLY. **`invoiceReceived` is the authority**; the
  per-order figure is a labelled display attribution that colours the order page and must
  never be summed into a total.
- A receipt may name BOTH an invoice and an order. The invoice is tried first and the order
  is a **fallback, not an alternative** — treating them as either/or drops the order aim the
  moment the basis is switched back.
- `ctx.orderBook` is populated ONLY under INVOICE. Under ORDER the order already IS the
  receivable, and a map that also called it "not yet billed" would invite a page to show the
  same money twice.
- `LedgerEntry.invoiceId` is advisory in exactly the way `orderId` is: where money was
  AIMED, not where FIFO landed it.

## Remembering figures — suggestions vs the change log

Two different questions, answered by two deliberately different mechanisms. Do not
merge them.

**"What did we use last time?" is DERIVED, never stored.** `server/src/lib/suggest.ts`
holds the pure maths and `routes/suggest.routes.ts` reads it out of the live records —
cost sheets, stock receipts, stage rates, orders and proformas — on every request.
There is no price-memory table on purpose: a stored copy would drift the moment
somebody corrected the original, and the correction is exactly what you want to see.

- **Matching is by name, case- and space-insensitive** (`normalizeKey`). `CARVING
  LABOUR`, `Carving Labour` and `carving  labour` are one item, because that is how the
  sheets were actually typed. Nothing cleverer — fuzzy matching would silently merge
  two genuinely different lines.
- **Sources are kept SEPARATE, never averaged.** What a line was *costed* at and what a
  supplier actually *billed* are different facts and the gap between them is the
  interesting part. `assemble()` orders them most-comparable first and drops the empty
  ones so the UI never shows a heading with nothing under it.
- Everything relative is connected: a cost line reaches its own history in other
  products, the **supplier receipts** for the matching raw item (matched on the GROUP
  name, which is the material), and — when the line is mapped to a stage — what
  **vendors charged** and **workers earned** for that stage. A product line on a
  proforma or order reaches what that buyer, then any buyer, paid in the same currency.
- **The window is a hard cut-off** (`AppSetting.suggestionWindowDays`, 365). Older
  figures are not shown at all — a two-year-old rate is worse than no rate. A cost
  sheet's date is its `createdAt`, because saving a product REPLACES the sheet, which
  makes it the moment those rates were set.
- **`outlier()` compares against the window's AVERAGE, not the last value**, and stays
  silent below two past uses — one previous use is not a pattern. It never blocks; it is
  a note beside a field to catch ₹2,600 typed for ₹260. `outlierOf()` in
  `client/src/api/suggest.ts` mirrors it so the note updates as you type — **keep the
  two in step.**
- The costing wizard asks **once for the whole sheet** (`POST /suggest/cost-lines`).
  Forty fields asking individually would be forty round-trips.

**"Who changed this, and what was it?" is STORED, because nothing else can reconstruct
it** — an edit destroys the old value. `server/src/lib/changeLog.ts`, surfaced as a
History tab on the product, order and worker.

- **Only money and rates are logged.** A log of every keystroke would bury the one entry
  anybody ever needs.
- `rootType`/`rootId` is the record a person would *open* to look. A cost line's own id
  is useless for that, because saving a product replaces the whole sheet — so a rate
  change is logged against the **product**.
- `diffCostSheet()` must run **BEFORE** the sheet is replaced, or the old rates are
  already gone. Lines are matched on group + line name, the same key suggestions use.
- `differs()` ignores sub-paisa differences, which are rounding, not edits — so a save
  that changed nothing logs nothing.
- `wipeOperational()` in the demo seed clears the log FIRST: rows point at records by
  id, and left behind they would resurface on whichever new record reuses that id.

## Markets and channels — four workflows, two axes

A buyer carries TWO independent settings, so all four combinations exist and none of them
is a special case: `Buyer.channel` (B2B | B2C) and `Buyer.market` (OVERSEAS | DOMESTIC).
An overseas importer, a domestic dealer, a domestic walk-in and a web order from abroad
are the same machinery with different data. Existing buyers are OVERSEAS + B2B, which is
all the app supported before.

`market` is the one that changes behaviour:

| | Overseas | Domestic |
|---|---|---|
| Price basis | **FOB** in the buyer's currency | **Non-FOB** in rupees (no CHA / forwarder / ICD) |
| Tax | zero-rated, every rate on the document ignored | GST, split CGST+SGST or IGST |
| Numbering | `PI-` / `ORD-` | `DPI-` / `DORD-` |
| Document | Proforma Invoice | Quotation |
| Incoterms | yes | hidden — an export concept |

`channel` records who they are; it drives no arithmetic. B2C simply has no GSTIN, which
the buyer form allows and the document handles.

## Document money — one engine, three readers

`server/src/lib/pricing.ts` is the **single authority for what a proforma or an order is
worth**, mirrored exactly in `client/src/util/pricing.ts` (keep them identical, like
costing.ts and expr.ts). It exists because three separate places used to add up
`qty × unitPrice` independently — `serializeOrder`, the FIFO buckets in
`buildFinanceContext`, and `orderValue()` on the dashboard. Once a line can carry a
discount and a document can carry freight and GST, three copies of that sum would
disagree the moment one was missed, and the order page and the Payments page would tell
the buyer two different things. **Everything goes through `documentValueOf()`.**

The rules, in the order they apply:

1. A **line** is `qty × unitPrice`, less its discount percentage, then its flat amount, and
   never below zero. Percentage first, because "10% off and another ₹500 off" is how it is
   said out loud.
2. A **charge** belongs to the whole document and carries its OWN gst rate rather than
   being apportioned across the lines — that is how an invoice really bills freight, and
   apportioning would make the tax on one line depend on unrelated lines. A percentage
   charge is a percentage of the **line subtotal only**, so charges never compound and the
   order they were entered in cannot change the total. Amounts are stored positive;
   `kind` (CHARGE | DISCOUNT) carries the sign, so a negative number typed against a
   discount cannot flip it back into a charge.
3. **Tax** applies per rate, one row per slab, so a document with 12% and 18% goods
   summarises correctly. `isTaxable` false is for something added after tax (a round-off).
4. **CGST+SGST versus IGST is DERIVED** by comparing the buyer's state with the company's
   (`Company.state`, Master Data → Company) — never typed, so it cannot contradict the
   addresses on the document. `sameState()` treats an unknown state as **not** a match, so
   an unconfigured company charges IGST rather than silently under-collecting. The halves
   are split off the *rounded* slab total, which is what keeps `CGST + SGST === taxTotal`.
5. An **overseas document is zero-rated end to end**: every rate on it is ignored rather
   than trusted, so a stray 18% left on a line can never tax an export.

A domestic buyer is refused without a state, because the split would otherwise be wrong
silently. Accepting a proforma **copies** its charges and line discounts onto the order
(not references them), so the order stays worth what was quoted even if the PI is later
revised — and a PI carrying charges refuses to become an order if any line is unlinked,
since freight would then be billed on goods that did not come across.

## Nothing is destroyed — soft delete

`Product`, `Order`, `Proforma`, `LedgerEntry`, `OperationSheet`, `Shipment` and `Invoice`
carry `deletedAt`.
`DELETE` sets it; the row survives and can be restored from the Trash drawer on the list
page. Two rules keep it safe:

- **Filtering happens at the QUERY layer, never in the pure functions**
  (`server/src/lib/softDelete.ts`). The costing, board, workforce, shipping, finished-stock
  and pricing engines know
  nothing about deletion — a deleted order leaves the money picture the way a *cancelled*
  one does, because the query excludes it. `verify.ts` asserts this by passing a
  soft-deleted order to `buildFinanceContext` and checking it is still priced: if someone
  ever "helpfully" teaches the engine about `deletedAt`, that check fails and says why.
  `LIVE_ORDER` is now `{ status: not Cancelled, deletedAt: null }` — one place, both rules.
- **Master data is NOT soft-deletable.** Currencies, units, buyers, suppliers and the rest
  already have `isActive`, which does the same job. A second mechanism would mean two ways
  to hide one row.

A permanent delete exists, needs the record type's own **`*.purge`** permission, works only
from the trash, and has **no
waiting period and no automatic purge** — nothing disappears because time passed. The
product "in use" check is now ADVISORY on soft delete (the orders referencing it are
unaffected) and BLOCKING on permanent delete, where the foreign keys really bite.

**Express matches routes in registration order**, so every literal path — `/trash`,
`/orders/delivery-status` — must be registered BEFORE the `/:id` route that would
otherwise swallow it and hand the handler `Number('trash')`.

## Attachments — paperwork on an order

`OrderAttachment` holds the buyer's PO, bills of lading, customs forms, packing lists,
inspection certificates and drawings. `server/src/lib/documentUpload.ts` mirrors the
discipline of `imageUpload.ts`: an extension allow-list, then the **magic bytes** are
checked and anything whose contents contradict its name is unlinked before a row can point
at it. Two limits are documented rather than pretended away — `.docx`/`.xlsx`/`.zip` share
the `PK` signature so only the extension distinguishes them, and `.txt`/`.csv`/`.eml` have
no signature at all, so they are only checked for being NUL-free text. 25 MB per file.

Downloads go through `GET /orders/:id/attachments/:attachmentId`, **scoped to the order in
the path** so one order's id cannot fetch another's file, and always
`Content-Disposition: attachment` with `nosniff` — an arbitrary document must download,
never render. Removing an attachment is a hard delete: a file has no history worth keeping,
and orphaned bytes in `uploads` would be worse.

## Scheduling — an overlay, never a replacement

`server/src/lib/scheduling.ts` is pure and produces **no quantities whatsoever**. The
board's invariant is untouched: `StageMove` still says where pieces ARE.

- `OrderLineSchedule` + `StageSchedule` hold estimated start/end per stage.
  `StageLineStep.defaultDays` (Master Data → Stage Lines) is what makes `autoSchedule()`
  believable — stated once, it lays an order out backwards from its delivery date and
  gives every stage at least a day, scaling the durations rather than overrunning the
  deadline.
- `estimateCompletion()` compares the plan with the board: DONE / AHEAD / IN_PROGRESS /
  OVERDUE / NOT_STARTED per stage. **Progress always comes from the board**, never from the
  schedule.
- `deliveryStatus()` is derived on every read, so it can never be stale. AT_RISK is the
  only judgement call: inside the last `AT_RISK_DAYS` (7) with less than `AT_RISK_PCT`
  (80%) finished. Far out, a slow start is normal and is deliberately not flagged.
- `Order.expectedDelivery` is the factory's own estimate, distinct from `deliveryDate`
  which is what the buyer asked for. Comparing the two is the point.

## Multi-currency receivables

`receivablesByCurrency()` in `finance.ts` groups what is outstanding by currency and values
it twice — at the rate each order was booked at (`Order.exchangeRate`) and at today's from
the currency master. The gap is **unrealised** forex: nothing is booked until the money
arrives, which is why it is presented as a movement rather than folded into a total. The
average booked rate is **weighted by what is outstanding**, so it is comparable with the
live rate. `/finance/receivables` carries the block and
`/finance/receivables/summary` returns it alone; both are built from the same allocated
rows, so the summary bar and the table cannot disagree.

## Proforma → order

Accepting a PI is the only thing that creates an order (`POST /proformas/:id/accept`,
one order per PI, enforced server-side); the client confirms first. Rejecting records
the reason and stops. `POST .../reopen` puts it back to Draft to revise and re-send.

## Documents & e-mail

- The proforma PDF is generated server-side with **pdfkit**
  (`server/src/lib/docPdf.ts`), product photos included. It draws its letterhead from the
  **Company** record and its money from `documentTotals()` — it never adds anything up
  itself, so it cannot print a figure the rest of the app disagrees with. A domestic
  document gains HSN and GST columns, a place of supply, the charge rows and the
  CGST/SGST/IGST breakdown, and is titled *Quotation*; an export is byte-for-byte what it
  always was. `collect()` must be called
  *before* drawing and `finish()` after — calling `doc.end()` early truncates the file.
  Standard PDF fonts are WinAnsi-only, so all text goes through `safe()` and money is
  printed as a currency **code** (`USD 1,200.00`), never a symbol.
- **`mailto:` cannot attach a file** — the URI scheme has no attachment field and no
  client accepts one. So Send offers both: a `mailto:` link (subject + body) *and* a
  `.eml` download (`server/src/lib/mailDraft.ts`) carrying To/Subject/Body plus the PI
  PDF as a base64 MIME part. `X-Unsent: 1` makes Outlook/Windows Mail open it as an
  editable draft. Don't "fix" this by trying to attach via mailto.
- Downloads go through axios as a blob (`fetchDocument` in `client/src/api/ops.ts`) so
  the bearer token is sent; server errors arrive as a Blob and are unwrapped there.

## Permissions — the catalogue is code, the roles are data

There are **no built-in roles and no ranks.** The four-rank ladder (Admin > Manager >
Operator > Viewer) is gone: `User.role` the string is gone, `requireRole` is gone, and
`hasRole` is gone from the client. A role is a row somebody created, holding a set of
permission keys, and an account with **no role holds nothing at all** — a new login can sign
in and see an empty app until it is granted something. That is the intended default.

**`server/src/lib/permissions.ts` is the single authority for which permissions exist**, and
it is CODE rather than a table for one reason: a permission is only real if a route enforces
it. Were the catalogue data, an Admin could invent `orders.approve` in the picker, tick it,
and be told they had granted something that guards nothing. So `verify.ts` asserts **both
directions** — every catalogue key is referenced by at least one route (no *orphans*), and no
route asks for a key the catalogue lacks (no *ghosts*, which would be permanently unreachable).
120 permissions across 13 modules at the time of writing.

- **The prose is part of the contract.** Each entry carries `what`, `allows`, `blocks` and a
  `risk`, and the Roles screen renders all of it beside the checkbox — because the person
  granting a permission is not the person who wrote the route, and `board.workers` tells them
  nothing. `blocks` does the real work: it names the near-miss a granter would otherwise
  assume came with it ("naming who did the work" does *not* set the rate they are paid).
  `verify.ts` fails a permission with an empty `allows` or `blocks`.
- **`requires` is applied when a role is SAVED, never when a permission is checked.** Ticking
  `orders.purge` stores `orders.restore` and `orders.view` too (`withRequired`, walked
  transitively and asserted idempotent). Routes still state **every** key they need: leaning
  on `requires` at check time would make enforcement depend on the shape of this file rather
  than on what the route does.
- **Permissions are resolved from the database on EVERY request** (`server/src/lib/access.ts`),
  never read out of the token. A token lives twelve hours and renews itself quietly, so a role
  baked into it would mean revoking access did nothing until the next working day. Resolution
  is cached for 10 s with **explicit invalidation** on every role and user write — the TTL is
  only a backstop for a change made straight in the database. This also closed a hole the old
  model had: a **deactivated account's token kept working** until it expired, because nothing
  looked the user up again.
- **`can(...)` requires every listed key; `canAny(...)` at least one.** `may(req, key)` is the
  in-handler form, for when a permission changes WHAT IS RETURNED rather than whether the call
  is allowed — worker identity (`workers.pii`), worker money (`wages.view`), product costing
  (`products.costing.view`). That stripping happens server-side; filtering in the client would
  still put the data on the wire.
- **Some permissions depend on the PAYLOAD, not the route**, so they are checked in the handler
  and cannot be middleware: `board.reject` and `board.workers` on `POST /orders/:id/moves`,
  `board.rates` on the routing patch, `orders.pricing` on `PUT /orders/:id` (compared against
  what is stored, because the client always posts the whole order), `products.costing.edit`
  when a save carries a cost sheet, and `workers.rates` when a save carries a rate or a pay
  type. Splitting these is the point: a coordinator may fix a quantity without re-pricing the
  job, and a supervisor may send a stage to a vendor without setting what the vendor is paid.
- **`User.isOwner` is the key under the mat.** An owner holds every permission and sits
  outside the role system entirely. It exists because permissions are live: without it, a role
  that lost `roles.manage` would be unrecoverable without database surgery. Three guards keep
  it honest — the **last active owner** cannot be demoted, deactivated or deleted; owner status
  is granted only **by an owner** (`requireOwner`, not `users.manage`, or anyone who could edit
  users could escalate themselves); and a non-owner cannot remove `roles.manage` from **their
  own** role or deactivate it.
- A role somebody still holds cannot be deleted — the count is reported, following the
  convention the other delete routes use. An **inactive role grants nothing**, which is how a
  role is retired without silently leaving its holders with what it used to carry.
- **Roles are configuration, so they survive a wipe** exactly as logins do. They are
  deliberately NOT in `wipeOperational()` — see the note there, since the rule in that file
  says to add every new model.
- Reference lists (currencies, units, attributes, stage routes, cost formulas, container
  types, the company record) sit behind `canReference` in `masters.routes.ts` — `canAny` of the
  module views that consume them — because every form in the app reads one, and gating them on
  `masters.view` alone would make an order-entry role need a master-data permission it has no
  other use for.
- `client/src/App.tsx` gates routes with `<Needs>` / `<NeedsAny>` so a stale link says which
  permission is missing instead of rendering an empty page that fails a dozen requests. It had
  no checks at all before. This is a courtesy; the server refuses regardless.
- `npx tsx server/scripts/dumpPermissions.ts > PERMISSIONS.md` prints the catalogue as
  Markdown, for whoever grants permissions rather than whoever wrote them.

`server/scripts/migrateRoles.ts` carried the old ranks across and is a **run-once** script
that must run BEFORE the schema change, because `prisma db push` drops `User.role` with the
data in it. It promoted every active Admin to owner and left everybody else with no role.

## Security invariants

Undoing any of these reopens a hole that was closed deliberately:

- `env.ts` **throws** on a missing/placeholder `JWT_SECRET` in production and generates
  a random one in dev. Never reintroduce a hardcoded fallback.
- CORS is an allowlist from `CORS_ORIGINS`; `cors()` with no options is wide open.
- **Every route states a permission.** The `/finance/*` reads once sat behind `authenticate`
  alone, so any login — a Viewer included — could pull every buyer balance, every payable and
  any party statement over the API while the client politely hid it. `verify.ts` now asserts
  each of those six is behind a `money.*` key by name.
- `/uploads` sits behind `authenticateUpload`, which accepts the bearer header **or**
  the httpOnly `oswal_session` cookie that login sets — an `<img>` tag cannot send
  a header. The client's axios instance uses `withCredentials`. Files go out with
  `nosniff` + CSP.
- All image uploads go through `lib/imageUpload.ts`: extension allow-list, then the
  magic bytes are checked and anything that is not really an image is unlinked. A
  declared mimetype is attacker-controlled and proves nothing.
- `nextDocNumber` uses an atomic `{ increment: 1 }`. A read-then-write would let two
  callers mint the same number, because SQLite takes no lock on the read.
- `POST /orders/:id/moves` validates **inside** the write transaction; so does undo.
- Delete routes report what references a record instead of letting a foreign key
  surface as a 500 — products, buyers, suppliers, raw items, currencies, units,
  attributes, stage lines, stock receipts, users, trades, contractors, workers,
  statutory components and postings.
- Order attachments are validated by **magic bytes**, not the declared mimetype, and are
  served `Content-Disposition: attachment` with `nosniff` so a document can never render
  in the browser. A download is scoped to the order in its path.
- The company logo goes through the same image pipeline as product photos, and the
  previous file is unlinked on replace rather than orphaned.
- **Permanent delete needs `<record>.purge`** and is only reachable from the trash; soft
  delete needs `<record>.delete`. `TrashDrawer` maps its endpoint to the purge key, so a new
  trashable model shows no permanent-delete button until it is added there deliberately.
- **Worker identity and bank details need `workers.pii`** (`redact()` in
  `manforce.routes.ts`). Filtering them in the client only would still ship them over
  the wire to anyone with an Operator login.
- `round()` nudges the magnitude, not the signed value, so negatives round
  symmetrically; `client/src/util/costing.ts` mirrors it exactly.

## Conventions

- Enum-like fields are `String` validated with zod in routes — a SQLite constraint
  originally, kept because it stays portable and the validation is in the routes anyway.
- `nextDocNumber(key, tx?)` — **pass the caller's `tx` when already inside
  `$transaction`.** A nested transaction is a second connection: its write leaves the
  caller's atomic unit and blocks behind any row the outer transaction holds, which is a
  deadlock that ends as a 5 s timeout rather than an error naming the cause.
- **`companyState()` upserts, so it is a WRITE.** Read it before opening a transaction,
  never inside one — the same deadlock, and it cost a 5-second timeout on the proforma
  save before every call site was hoisted.
- **A currency change must restate `exchangeRate`, and a buyer change the tax snapshot.**
  `PUT /orders/:id` and `PUT /proformas/:id` rewrite both. Left behind, a rupee order
  edited to USD stayed at rate 1 — booking a phantom forex gain of the whole order value —
  and a domestic order moved to another state still printed CGST + SGST on what had become
  an inter-state sale.
- Uploads (product images, hand-over photos and worker documents) share
  `server/uploads`, served at `/uploads`. Hand-over photos are named `move-*` and worker
  photos/IDs `worker-*` so they are distinguishable on disk; deleting a movement or a
  worker unlinks its files as well as its rows.
- Product create uses Prisma *unchecked* input: scalar FKs (`productTypeId`, `createdById`, …)
  + nested child creates. Do NOT mix a scalar FK with a relation `connect` in one create.
- Product update **replaces** buyers / related / cost sheet in a transaction.
- Money uses `Float` + rounding at the API boundary (`round()`), base currency INR.

## Commands

```bash
npm install
npm run db:setup     # start Postgres + prisma db push + seed
npm run dev          # starts Postgres, then server :689 + client :688
npm run build        # type-check + build both (run before declaring done)
```

```bash
npm run verify       # DB-free self-checks — run these before declaring done
npm run db:demo      # rebuild the investor demo (wipes operational data first)
npm run db:fill      # same thing, named for what it does — fill the DB with examples
npm run db:clean     # clean slate: operational data to zero, doc numbering reset
npm run db:workers   # migrate typed wage names onto worker records (idempotent)
```

The database, which lives in `server/.pgdata`:

```bash
npm run pg:start     # create the cluster if needed, start it, create the database
npm run pg:stop      # stop it (a clean stop is what makes a backup restorable)
npm run pg:status    # data directory, whether it is up, which database
npm run pg:restart
npm run pg:reset -- --yes   # destroy the cluster and start empty (db:clean is usually what you want)
```

Backups — cluster **and** uploads, since the two are one record:

```bash
npm run db:backup                        # stop, copy to server/backups/<date>, start again
npm run db:backups                       # what is on disk
npm run db:restore -- latest --yes       # or a specific name from db:backups
```

`db:setup`, `db:demo`, `db:fill`, `db:clean` and `db:workers` all start Postgres first, so
none of them fails with a connection error on a cold machine. `npm run verify` deliberately
does not — it needs no database. `npm run serve` is the factory boot sequence: database,
then the built API.

`prisma/verify.ts` holds the invariants as pure-function assertions with fixed inputs:
the example.xlsx FOB (₹19,180.60), board conservation, the move rules, hop expansion,
jobwork reconciliation, FIFO allocation, and the whole workforce engine — the
working-day calendar, exceptions-only accrual, pro-rata salary, piece attribution,
statutory maths and the `dueNow − advanceOutstanding === balance` identity, plus the
suggestion maths (name normalisation, which source leads, the outlier threshold), and the
document pricing (line discounts, charge signs, the GST slabs, the CGST/SGST split
reconciling to the paisa, and an export staying untaxed), the scheduling engine
(auto-scheduling from stage durations, plan-versus-board status, the delivery verdict), the
currency grouping behind the forex position, and the rule that soft delete stays OUT of the
pure functions, and the receivable basis (the ORDER default unchanged, an invoice spanning
orders staying one debt, the attribution reconciling to the paisa, a draft not yet a debt), and
the permission catalogue (no orphan keys, no ghost keys, the prose present on every entry, the
`requires` graph acyclic and its closure idempotent and transitive, and the finance reads
guarded by name).
It needs no database, so it survives any wipe — **this is now the authority
for the costing formulas**, not a seeded product. Add a case here whenever you touch
`costing.ts`, `production.ts`, `finance.ts`, `workforce.ts`, `suggest.ts`, `pricing.ts`,
`scheduling.ts`, `shipping.ts`, `finished.ts` or `permissions.ts`.

It also holds the **client-mirror identity checks** as a table of pairs (`pricing`,
`shipping`). Add a pair there whenever you add a mirrored engine, or nothing stops it
drifting.

`prisma/cleanSlate.ts` (`db:clean`) is the opposite of the demo seed and shares its wipe
list: every operational table to zero, uploads unlinked, and all ten DocSequence
counters back to 0 so numbering restarts at 001. Configuration is deliberately kept —
logins, currencies, units, attributes, cost formulas, stage lines, container types, trades,
holidays, workforce settings and statutory components — because that is setup, not data.
**If you add a model, add it to BOTH `wipeOperational()` and `cleanSlate.ts`**, or a wipe
will leave orphans behind that resurface on whichever new record reuses their id.

The sales block sits AFTER `ledgerEntry.deleteMany()`, because a buyer receipt may name the
invoice it was aimed at; and `finishedTxn` goes before `shipmentLine` (a return names the
dispatch it reverses) while `packingBatch` goes last (a shipment line REQUIRES its batch).
Relying on a `SetNull` referential action instead would make the order of that list
load-bearing in a way its own comment promises it is not.

`prisma/demoSeed.ts` builds a whole factory mid-season — 10 photographed products
with real costing, three buyers in GBP/USD/EUR, proformas at every stage of the sales
cycle, four orders at different points of production (mid-line outsourcing, a QC
rejection, hand-over photos), and a money position that demonstrates FIFO settlement
and credit on account. Photos live in `prisma/demo/assets/` (web-sized, tracked) and
are copied into `uploads/` on seed, exactly as an upload would be. It clears
operational data first but leaves configuration alone, so it is safe to re-run.

`npm run build` runs `prisma generate`, which on Windows fails with `EPERM … rename
query_engine-windows.dll.node` while a dev server holds the engine — stop `npm run dev`
first. The seed is idempotent: it leaves the demo product `AB-00123` alone once it
exists, so re-running it never wipes orders that reference it.

Type-check without building: `npx tsc --noEmit -p server/tsconfig.json` and
`npx tsc --noEmit -p client/tsconfig.json`.
