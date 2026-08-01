import type { LineBoard, MoveKind, StageCell } from '../../../api/ops';

/**
 * The board has three kinds of place a piece can be: the not-started pool, one of
 * the stages, or the finished pool. The user only ever picks a FROM and a TO — the
 * move kind is derived from that pair, which keeps the UI down to two choices and
 * makes an illegal combination impossible to express.
 */

export const PENDING_KEY = 'PENDING';
export const DONE_KEY = 'DONE';

export type Endpoint = { kind: 'PENDING' } | { kind: 'DONE' } | { kind: 'STAGE'; stage: StageCell };

export const PENDING: Endpoint = { kind: 'PENDING' };
export const DONE: Endpoint = { kind: 'DONE' };

export const keyOf = (e: Endpoint): string => (e.kind === 'STAGE' ? String(e.stage.id) : e.kind);

export function parseKey(key: string | undefined, stages: StageCell[]): Endpoint | null {
  if (!key) return null;
  if (key === PENDING_KEY) return PENDING;
  if (key === DONE_KEY) return DONE;
  const stage = stages.find((s) => String(s.id) === key);
  return stage ? { kind: 'STAGE', stage } : null;
}

export const labelOf = (e: Endpoint): string => (e.kind === 'STAGE' ? e.stage.name : e.kind === 'PENDING' ? 'Not started' : 'Finished');

/** Pieces currently sitting at an endpoint. */
export function availableAt(board: LineBoard, e: Endpoint): number {
  if (e.kind === 'PENDING') return board.pending;
  if (e.kind === 'DONE') return board.done;
  return board.stages.find((s) => s.id === e.stage.id)?.at ?? 0;
}

/** The move kind implied by a from/to pair, or null when the pair is not a move. */
export function deriveKind(from: Endpoint, to: Endpoint): MoveKind | null {
  if (from.kind === 'PENDING') return to.kind === 'STAGE' ? 'RELEASE' : null;
  if (from.kind === 'DONE') return to.kind === 'STAGE' ? 'RETURN' : null;
  if (to.kind === 'DONE') return 'COMPLETE';
  if (to.kind === 'PENDING') return 'REJECT';
  if (to.stage.sortOrder === from.stage.sortOrder) return null;
  return to.stage.sortOrder > from.stage.sortOrder ? 'ADVANCE' : 'REJECT';
}

/** Plain-English description of what the chosen pair will do. */
export function describe(from: Endpoint, to: Endpoint, qty: number): string {
  const kind = deriveKind(from, to);
  const pcs = `${qty} pc${qty === 1 ? '' : 's'}`;
  switch (kind) {
    case 'RELEASE':
      return `Start ${pcs} at ${labelOf(to)}.`;
    case 'ADVANCE':
      return `Clear ${pcs} from ${labelOf(from)} into ${labelOf(to)}.`;
    case 'REJECT':
      return `Send ${pcs} back from ${labelOf(from)} to ${labelOf(to)} for rework.`;
    case 'COMPLETE':
      return `Finish ${pcs} out of ${labelOf(from)} — done and ready.`;
    case 'RETURN':
      return `Reopen ${pcs} from finished back into ${labelOf(to)}.`;
    default:
      return 'Pick where the pieces are coming from and going to.';
  }
}

/** Mirror of the server's rules, so the button can be disabled with a reason. */
export function validate(board: LineBoard, from: Endpoint | null, to: Endpoint | null, qty: number): string | null {
  if (!from) return 'Choose where the pieces are now.';
  if (!to) return 'Choose where the pieces are going.';
  const kind = deriveKind(from, to);
  if (!kind) {
    if (from.kind === to.kind && from.kind !== 'STAGE') return 'Pick two different places.';
    if (from.kind === 'STAGE' && to.kind === 'STAGE') return 'Pick a different stage to move into.';
    if (from.kind === 'PENDING') return 'Not-started pieces must go into a stage.';
    return 'Finished pieces can only be reopened into a stage.';
  }
  if (!Number.isInteger(qty) || qty <= 0) return 'Enter how many pieces.';
  const available = availableAt(board, from);
  if (qty > available) return `Only ${available} pc(s) at ${labelOf(from)}.`;
  return null;
}

/** Every place pieces could move to, given where they are. */
export function targetsFor(board: LineBoard, from: Endpoint | null): { value: string; label: string; hint?: string }[] {
  if (!from) return [];
  const out: { value: string; label: string; hint?: string }[] = [];
  if (from.kind === 'PENDING' || from.kind === 'DONE') {
    for (const s of board.stages) out.push({ value: String(s.id), label: `${s.sortOrder + 1}. ${s.name}`, hint: s.vendor?.name });
    return out;
  }
  for (const s of board.stages) {
    if (s.sortOrder === from.stage.sortOrder) continue;
    out.push({
      value: String(s.id),
      label: `${s.sortOrder + 1}. ${s.name}`,
      hint: s.sortOrder > from.stage.sortOrder ? (s.vendor ? `forward · ${s.vendor.name}` : 'forward') : 'send back',
    });
  }
  out.push({ value: DONE_KEY, label: 'Finished', hint: 'out of the line' });
  out.push({ value: PENDING_KEY, label: 'Not started', hint: 'send all the way back' });
  return out;
}

/**
 * The stages a forward clearance will actually pass through, in order. Mirrors the
 * server's hop expansion so the drawer can say "recorded as 3 steps" up front.
 * Only an ADVANCE expands — finishing is taken at its word and skips the rest.
 */
export function hopsBetween(board: LineBoard, from: Endpoint, to: Endpoint): StageCell[] {
  if (deriveKind(from, to) !== 'ADVANCE' || from.kind !== 'STAGE' || to.kind !== 'STAGE') return [];
  return board.stages.filter((s) => s.sortOrder > from.stage.sortOrder && s.sortOrder <= to.stage.sortOrder);
}

/** Where a straightforward forward clearance should land. */
export function suggestedTarget(board: LineBoard, from: Endpoint): Endpoint {
  if (from.kind === 'PENDING') return board.stages.length ? { kind: 'STAGE', stage: board.stages[0] } : DONE;
  if (from.kind === 'DONE') return board.stages.length ? { kind: 'STAGE', stage: board.stages[board.stages.length - 1] } : PENDING;
  const next = board.stages.find((s) => s.sortOrder > from.stage.sortOrder);
  return next ? { kind: 'STAGE', stage: next } : DONE;
}

/**
 * Whether this move can say who did the work, and why not when it cannot.
 *
 * Mirrors the server: only a clearance is work done, a clearance crossing several
 * stages cannot attribute each one, and an outsourced stage pays its vendor instead.
 */
export function attributionState(board: LineBoard, from: Endpoint | null, to: Endpoint | null): { allowed: boolean; stage: StageCell | null; reason?: string } {
  if (!from || !to) return { allowed: false, stage: null };
  const kind = deriveKind(from, to);
  if (kind !== 'ADVANCE' && kind !== 'COMPLETE') return { allowed: false, stage: null, reason: 'Only clearing pieces forward, or finishing them, counts as work done.' };
  if (from.kind !== 'STAGE') return { allowed: false, stage: null };
  const stage = board.stages.find((s) => s.id === from.stage.id) ?? from.stage;
  if (stage.vendorId) return { allowed: false, stage, reason: `${stage.name} is outsourced — ${stage.vendor?.name ?? 'the vendor'} is paid for it.` };
  const hops = hopsBetween(board, from, to);
  if (hops.length > 1) {
    /**
     * Mirror of the server's rule. A clearance crossing several stages normally cannot say who
     * did which — unless every stage it crosses belongs to ONE piece group, a run of steps
     * engaged at a single agreed price. Then there is nothing to split, and clearing the run in
     * one action is exactly how such a job is worked.
     *
     * The money hangs off the LAST step of the run, which is where the group's rate is stored,
     * so that is the stage returned for pricing and validation.
     */
    /**
     * `hopsBetween` returns the stages pieces LAND on, so the ones actually CLEARED are the
     * source plus every hop but the last: A→D is A→B, B→C, C→D, which clears A, B and C.
     */
    const crossed = [stage, ...hops.slice(0, -1)];
    const group = stage.pieceGroup;
    const bundled = !!group && crossed.every((s) => s.pieceGroup === group);
    if (!bundled) {
      return { allowed: false, stage, reason: 'This clearance crosses several stages, so it cannot say who did which. Clear one stage at a time to record the workers, or group the steps into one paid-together job.' };
    }
    return { allowed: true, stage: crossed[crossed.length - 1] };
  }
  return { allowed: true, stage };
}

/** Mirror of the server's `validateMoveWorkers` — keep the two in step. */
export function validateWorkers(qty: number, workers: { workerId?: number; pieces?: number }[], stage: StageCell | null): string | null {
  const filled = workers.filter((w) => w.workerId != null);
  if (filled.length === 0) return null;
  if (!stage) return 'Pick the stage the work was done at.';
  const ids = new Set<number>();
  for (const w of filled) {
    if (!w.pieces || !Number.isInteger(w.pieces) || w.pieces <= 0) return 'Give each worker a whole number of 1 piece or more.';
    if (ids.has(w.workerId!)) return 'The same worker is listed twice — combine their pieces into one line.';
    ids.add(w.workerId!);
  }
  const total = filled.reduce((a, w) => a + (w.pieces ?? 0), 0);
  if (total !== qty) return `The pieces per worker add up to ${total}, but ${qty} pc are being moved.`;
  if (!(stage.labourRate > 0)) return `${stage.name} has no piece rate, so there is nothing to pay the workers named on it. Set a labour rate on the stage first.`;
  return null;
}

/** True when the pieces are changing hands between us and a vendor (or vice versa). */
export function crossesHands(from: Endpoint | null, to: Endpoint | null): boolean {
  const fromVendor = from?.kind === 'STAGE' ? from.stage.vendorId : null;
  const toVendor = to?.kind === 'STAGE' ? to.stage.vendorId : null;
  return fromVendor !== toVendor;
}
