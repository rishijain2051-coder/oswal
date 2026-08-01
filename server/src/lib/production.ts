/**
 * Production board engine.
 *
 * Where every piece of an order line currently sits is DERIVED from the
 * append-only StageMove ledger — never stored. That means the board can never
 * drift out of sync with its own history, and any move can be undone by deleting
 * its ledger row.
 *
 * Buckets:  PENDING  ->  stage 1 .. stage n  ->  DONE
 *
 * Move kinds and their endpoints (see schema.prisma):
 *   RELEASE  PENDING   -> toStage
 *   ADVANCE  fromStage -> toStage           (forward)
 *   REJECT   fromStage -> toStage | PENDING  (backward — rework)
 *   COMPLETE fromStage -> DONE
 *   RETURN   DONE      -> toStage            (undo a completion)
 *
 * `kind` is what disambiguates a null endpoint: a null `toStageId` means DONE for
 * COMPLETE but PENDING for REJECT; a null `fromStageId` means PENDING for RELEASE
 * but DONE for RETURN.
 */

export const MOVE_KINDS = ['RELEASE', 'ADVANCE', 'REJECT', 'COMPLETE', 'RETURN'] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

export interface StageRow {
  id: number;
  name: string;
  sortOrder: number;
  vendorId: number | null;
  jobworkRate: number;
  /** ₹ per piece an in-house worker earns for clearing this stage. 0 = day-wage work. */
  labourRate?: number;
  note?: string | null;
  vendor?: { id: number; name: string } | null;
}

export interface MoveRow {
  id: number;
  kind: string;
  fromStageId: number | null;
  toStageId: number | null;
  qty: number;
  date?: Date | string;
  note?: string | null;
  /**
   * Does this clearance earn anything? Absent means yes — every movement recorded before the
   * flag existed was ordinary work. False is rework the vendor or the worker spoiled and is
   * putting right at their own cost.
   */
  billable?: boolean;
  /**
   * Who did it, with a piece count each. Needed for `labourValue` to mean anything: in-house
   * piece work is owed to the people NAMED on the movement, so the query behind any board that
   * displays it must include the workers relation (see `orderInclude`). Left out, the stage
   * reports no piece work — which is correct for a board that was never asked about wages.
   */
  workers?: { workerId: number; pieces: number }[];
}

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
  /** Pieces sitting at this stage right now. */
  at: number;
  /** Pieces that have moved forward out of this stage (advanced or completed). */
  cleared: number;
  /**
   * Of those, the ones that EARN. Lower than `cleared` when rework was recorded at the
   * vendor's or the worker's own cost. The two are kept apart because they answer different
   * questions: `cleared` is how much work went through this stage, `clearedBillable` is how
   * much of it anybody is paid for.
   */
  clearedBillable: number;
  /**
   * Of the billable ones, the pieces somebody was actually NAMED for.
   *
   * In-house piece work is owed to the people on the movement, so this — not `cleared` — is
   * what it costs. Clearing a piece-rate stage without naming anybody is not free labour that
   * vanished: it is day-wage work, which is paid through attendance rather than per piece.
   */
  attributedPieces: number;
  /**
   * Billable pieces cleared at a stage that HAS a piece rate with nobody named against them.
   *
   * Always 0 for a vendor stage and for an in-house stage with no rate. Non-zero means somebody
   * either forgot to say who did the work, or moved the pieces across several stages at once —
   * which cannot be attributed, because each stage is a different piece of work. It is the one
   * number a supervisor can act on, so the order page raises it the way it raises an
   * outsourced stage with no rate.
   */
  unattributed: number;
  /** Pieces sent backwards out of this stage (rejected for rework). */
  rejectedOut: number;
  /** Pieces that came back INTO this stage after a rejection downstream. */
  rejectedIn: number;
  /** Pieces that have ever entered this stage. */
  reached: number;
  /** Jobwork payable so far for this stage = cleared × rate (0 when in-house). */
  jobworkValue: number;
  /** In-house piece work earned so far = cleared × labourRate (0 when outsourced). */
  labourValue: number;
}

export interface LineBoard {
  qty: number;
  pending: number;
  done: number;
  /** Pieces somewhere inside the stage line (neither pending nor done). */
  wip: number;
  progressPct: number;
  stages: StageCell[];
  /** Jobwork payable so far, grouped by vendor. */
  jobwork: { vendorId: number; vendorName: string; stages: string[]; pieces: number; amount: number }[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Build the live board for one order line from its stage snapshot + move ledger. */
export function buildBoard(qty: number, stages: StageRow[], moves: MoveRow[]): LineBoard {
  const ordered = [...stages].sort((a, b) => a.sortOrder - b.sortOrder);
  const cells = new Map<number, StageCell>();
  for (const s of ordered) {
    cells.set(s.id, {
      id: s.id,
      name: s.name,
      sortOrder: s.sortOrder,
      vendorId: s.vendorId ?? null,
      vendor: s.vendor ?? null,
      jobworkRate: s.jobworkRate ?? 0,
      labourRate: s.labourRate ?? 0,
      note: s.note ?? null,
      at: 0,
      cleared: 0,
      clearedBillable: 0,
      attributedPieces: 0,
      unattributed: 0,
      rejectedOut: 0,
      rejectedIn: 0,
      reached: 0,
      jobworkValue: 0,
      labourValue: 0,
    });
  }

  let pending = qty;
  let done = 0;

  for (const m of moves) {
    const q = m.qty;
    const from = m.fromStageId != null ? cells.get(m.fromStageId) : undefined;
    const to = m.toStageId != null ? cells.get(m.toStageId) : undefined;

    if (from) from.at -= q;
    if (to) {
      to.at += q;
      to.reached += q;
    }

    switch (m.kind) {
      case 'RELEASE':
        pending -= q;
        break;
      case 'ADVANCE':
        if (from) {
          from.cleared += q;
          // Absent means yes: every movement written before the flag existed was paid work.
          if (m.billable !== false) {
            from.clearedBillable += q;
            from.attributedPieces += (m.workers ?? []).reduce((a, w) => a + w.pieces, 0);
          }
        }
        break;
      case 'REJECT':
        if (from) from.rejectedOut += q;
        if (to) to.rejectedIn += q;
        else pending += q; // rejected all the way back to unstarted
        break;
      case 'COMPLETE':
        if (from) {
          from.cleared += q;
          if (m.billable !== false) {
            from.clearedBillable += q;
            from.attributedPieces += (m.workers ?? []).reduce((a, w) => a + w.pieces, 0);
          }
        }
        done += q;
        break;
      case 'RETURN':
        done -= q;
        break;
    }
  }

  const cellList = ordered.map((s) => cells.get(s.id)!);
  for (const c of cellList) {
    // Priced off `clearedBillable`, NOT `cleared`. The strip on the board and the payables
    // ledger have to agree to the rupee, and `jobworkEvents` skips unpaid rework — so pricing
    // the strip off the raw count would show a vendor owed for pieces they are re-doing free.
    c.jobworkValue = r2(c.vendorId ? c.clearedBillable * (c.jobworkRate || 0) : 0);
    /**
     * In-house piece work is priced off the pieces somebody was NAMED for — not off what the
     * stage cleared. The asymmetry with jobwork above is the point, not an oversight:
     *
     *   A VENDOR stage has an implied party. Clearing it owes that vendor, whoever held the
     *   spray gun, so `clearedBillable` is the right multiplier.
     *
     *   An IN-HOUSE stage has none. The money is owed to the people on the movement, and
     *   `labourEvents` pays nobody when nobody is named — so pricing this off `clearedBillable`
     *   made the board announce wages that no worker account had a paisa of. Clearing 40 pieces
     *   at ₹60 with nobody named read as ₹2,400 earned and paid out ₹0.
     *
     * Nothing is lost by that: an in-house clearance with nobody named is DAY-WAGE work, and a
     * day-wage worker is paid through attendance rather than per piece. What is worth saying
     * out loud is when a stage that HAS a piece rate cleared pieces anonymously, which is
     * almost always somebody forgetting — hence `unattributed` below.
     */
    c.labourValue = r2(!c.vendorId ? c.attributedPieces * (c.labourRate || 0) : 0);
    c.unattributed = !c.vendorId && (c.labourRate || 0) > 0 ? Math.max(c.clearedBillable - c.attributedPieces, 0) : 0;
  }

  const jobworkMap = new Map<number, { vendorId: number; vendorName: string; stages: string[]; pieces: number; amount: number }>();
  for (const c of cellList) {
    if (!c.vendorId || c.jobworkValue <= 0) continue;
    const row =
      jobworkMap.get(c.vendorId) ??
      jobworkMap.set(c.vendorId, { vendorId: c.vendorId, vendorName: c.vendor?.name ?? `Vendor #${c.vendorId}`, stages: [], pieces: 0, amount: 0 }).get(c.vendorId)!;
    row.stages.push(c.name);
    // The pieces BILLED, to match the amount beside them. Showing the raw cleared count next
    // to a total that excludes unpaid rework would read as a wrong rate.
    row.pieces += c.clearedBillable;
    row.amount = r2(row.amount + c.jobworkValue);
  }

  const wip = cellList.reduce((a, c) => a + c.at, 0);
  return {
    qty,
    pending,
    done,
    wip,
    progressPct: qty > 0 ? Math.round((done / qty) * 100) : 0,
    stages: cellList,
    jobwork: Array.from(jobworkMap.values()),
  };
}

/** A movement that cleared pieces out of a stage, i.e. work that was actually done. */
export interface Clearance<S extends StageRow = StageRow, M extends MoveRow = MoveRow> {
  move: M;
  /** The stage the pieces left — the one whose work is being paid for. */
  stage: S;
  /** True while pieces are known to have come back to this stage after a rejection. */
  rework: boolean;
}

/**
 * Every clearance out of a stage, oldest first, with rework flagged.
 *
 * This is the one walk over the move ledger that answers "what work was done, and was
 * it a re-do?". Both vendor jobwork (lib/finance.ts) and in-house labour
 * (lib/workforce.ts) are priced from it, so the two can never disagree about what
 * counted as a clearance.
 *
 * Work done twice counts twice — pieces rejected and re-done were genuinely worked on
 * again — which is why this counts movements rather than distinct pieces, and why the
 * totals agree with the board's `cleared` figure.
 */
export function clearances<S extends StageRow, M extends MoveRow>(stages: S[], moves: M[]): Clearance<S, M>[] {
  const byId = new Map(stages.map((s) => [s.id, s]));
  /** Pieces sent back INTO a stage that have not yet been cleared out of it again. */
  const awaitingRedo = new Map<number, number>();
  const out: Clearance<S, M>[] = [];

  const chronological = [...moves].sort((a, b) => {
    const d = new Date(a.date ?? 0).getTime() - new Date(b.date ?? 0).getTime();
    return d !== 0 ? d : a.id - b.id;
  });

  for (const m of chronological) {
    if (m.kind === 'REJECT' && m.toStageId != null) {
      awaitingRedo.set(m.toStageId, (awaitingRedo.get(m.toStageId) ?? 0) + m.qty);
    }
    if (m.kind !== 'ADVANCE' && m.kind !== 'COMPLETE') continue;
    if (m.fromStageId == null) continue;
    const stage = byId.get(m.fromStageId);
    if (!stage) continue;

    const pending = awaitingRedo.get(stage.id) ?? 0;
    const rework = pending > 0;
    if (rework) awaitingRedo.set(stage.id, Math.max(pending - m.qty, 0));

    /**
     * A clearance marked not-billable is dropped HERE, which is the one walk both
     * `jobworkEvents` and `labourEvents` are built on — so a vendor putting their own spoiled
     * work right is skipped by both, and neither builder has to remember to ask.
     *
     * It is dropped after the redo bookkeeping above, not before: the pieces genuinely came
     * back and genuinely went out again, so the BOARD must still see the movement. Only the
     * money is withheld. `buildBoard` reads the ledger directly and is untouched by this.
     */
    if (m.billable === false) continue;

    out.push({ move: m, stage, rework });
  }
  return out;
}

export interface MoveRequest {
  kind: MoveKind;
  fromStageId?: number | null;
  toStageId?: number | null;
  qty: number;
}

/**
 * Validate a move against the current board. Returns an error message, or null
 * when the move is legal. Every rule lives here so the API and the UI agree.
 */
export function validateMove(board: LineBoard, req: MoveRequest): string | null {
  const { kind, qty } = req;
  if (!MOVE_KINDS.includes(kind)) return `Unknown move type "${kind}".`;
  if (!Number.isInteger(qty) || qty <= 0) return 'Quantity must be a whole number of 1 or more.';

  const byId = new Map(board.stages.map((s) => [s.id, s]));
  const from = req.fromStageId != null ? byId.get(req.fromStageId) : undefined;
  const to = req.toStageId != null ? byId.get(req.toStageId) : undefined;
  if (req.fromStageId != null && !from) return 'The stage you are moving from does not belong to this order line.';
  if (req.toStageId != null && !to) return 'The stage you are moving to does not belong to this order line.';

  const need = (label: string, available: number) => (qty > available ? `Only ${available} pc(s) available at ${label}.` : null);

  switch (kind) {
    case 'RELEASE':
      if (from) return 'A release always starts from the not-started pool.';
      if (!to) return 'Pick the stage to release pieces into.';
      return need('not started', board.pending);

    case 'ADVANCE':
      if (!from) return 'Pick the stage to clear pieces from.';
      if (!to) return 'Pick the stage to move pieces into.';
      if (to.sortOrder <= from.sortOrder) return 'Advancing must move forward — use "send back" to return pieces to an earlier stage.';
      return need(from.name, from.at);

    case 'REJECT':
      if (!from) return 'Pick the stage the pieces are being rejected from.';
      if (to && to.sortOrder >= from.sortOrder) return 'Sending back must move to an earlier stage.';
      return need(from.name, from.at);

    case 'COMPLETE':
      if (!from) return 'Pick the stage to complete pieces from.';
      if (to) return 'Completing moves pieces out of the line — leave the target stage empty.';
      return need(from.name, from.at);

    case 'RETURN':
      if (from) return 'A return always starts from the finished pool.';
      if (!to) return 'Pick the stage to return finished pieces into.';
      return need('finished', board.done);
  }
  return null;
}

/** The stage a forward clearance should land on, or null when it finishes the line. */
export function nextStageAfter(board: LineBoard, stageId: number): StageCell | null {
  const cur = board.stages.find((s) => s.id === stageId);
  if (!cur) return null;
  return board.stages.find((s) => s.sortOrder > cur.sortOrder) ?? null;
}

/**
 * Expand a forward clearance that spans several stages into one hop per stage.
 *
 * Clearing 1 -> 4 in a single action records 1->2, 2->3, 3->4 rather than one jump,
 * so every stage's "cleared" count — and therefore the jobwork owed for it — stays
 * exact.
 *
 * Only ADVANCE expands. A REJECT is one event, not a walk back down the line; and a
 * COMPLETE is taken at its word — saying "these are finished" from stage 3 must NOT
 * quietly mark stages 4, 5 and 6 as passed, because any vendor owning those stages
 * would then be credited for work nobody did. To pay those stages, advance through
 * them first and complete from the last one.
 */
export function expandHops(
  board: LineBoard,
  req: { kind: MoveKind; fromStageId?: number | null; toStageId?: number | null; qty: number }
): { kind: MoveKind; fromStageId: number | null; toStageId: number | null; qty: number }[] {
  const single = [{ kind: req.kind, fromStageId: req.fromStageId ?? null, toStageId: req.toStageId ?? null, qty: req.qty }];
  if (req.kind !== 'ADVANCE') return single;

  const from = req.fromStageId != null ? board.stages.find((s) => s.id === req.fromStageId) : undefined;
  const to = req.toStageId != null ? board.stages.find((s) => s.id === req.toStageId) : undefined;
  if (!from || !to) return single;

  const between = board.stages.filter((s) => s.sortOrder > from.sortOrder && s.sortOrder <= to.sortOrder);
  if (between.length <= 1) return single;

  const hops: { kind: MoveKind; fromStageId: number | null; toStageId: number | null; qty: number }[] = [];
  let cursor = from.id;
  for (const stage of between) {
    hops.push({ kind: 'ADVANCE', fromStageId: cursor, toStageId: stage.id, qty: req.qty });
    cursor = stage.id;
  }
  return hops;
}

/** Human label for a move endpoint, used in movement history. */
export function endpointLabel(board: LineBoard, kind: string, stageId: number | null, side: 'from' | 'to'): string {
  if (stageId != null) return board.stages.find((s) => s.id === stageId)?.name ?? `Stage #${stageId}`;
  if (side === 'from') return kind === 'RETURN' ? 'Finished' : 'Not started';
  return kind === 'REJECT' ? 'Not started' : 'Finished';
}

/** Roll a set of line boards up to an order-level summary. */
export function rollUp(boards: LineBoard[]) {
  const ordered = boards.reduce((a, b) => a + b.qty, 0);
  const done = boards.reduce((a, b) => a + b.done, 0);
  const wip = boards.reduce((a, b) => a + b.wip, 0);
  const pending = boards.reduce((a, b) => a + b.pending, 0);
  return { ordered, done, wip, pending, progressPct: ordered > 0 ? Math.round((done / ordered) * 100) : 0 };
}

/**
 * Order status that the board — and the shipments — imply.
 *
 * Returns null when nothing should change, or when the current status is one this must not
 * touch. `Closed` and `Cancelled` stay human decisions; `Shipped` no longer is, because a
 * dispatch is a fact and a dropdown was only ever somebody's word for it.
 *
 * `shipped` is optional so every existing caller keeps its behaviour exactly: without it
 * this is the board-only rule it always was.
 *
 * A PARTLY shipped order is deliberately left where the board put it — usually `Ready`.
 * Inventing a fourth state for it would put a status on the page that no report, filter or
 * PDF knows about, when "Ready, and half of it has gone" is already visible from the
 * shipped figure beside it.
 */
export function impliedOrderStatus(
  current: string,
  summary: { ordered: number; done: number; wip: number; pending: number },
  shipped?: number
): string | null {
  if (['Closed', 'Cancelled'].includes(current)) return null;
  if (summary.ordered === 0) return null;

  const gone = shipped ?? 0;
  // Everything ordered has left the factory. This outranks the board: pieces that have
  // shipped are finished by definition, so it holds even if a movement is later corrected.
  if (shipped != null && gone >= summary.ordered) return current === 'Shipped' ? null : 'Shipped';

  // Past this point the board decides — but it must never pull an order BACK out of
  // Shipped on its own. Only un-shipping it (deleting the dispatch) may do that, which is
  // why this asks about `shipped` rather than trusting the stored status.
  if (current === 'Shipped') {
    if (shipped == null) return null; // caller did not ask about shipping; leave it alone
    // Genuinely no longer fully shipped — fall through and let the board restate it.
  }

  if (summary.done >= summary.ordered) return current === 'Ready' ? null : 'Ready';
  if (summary.wip > 0 || summary.done > 0) return current === 'Production' ? null : 'Production';
  // Nothing has moved. Deliberately null rather than 'Confirmed': this function only ever
  // advanced a status, and an order a human parked somewhere is not the board's business.
  return null;
}
