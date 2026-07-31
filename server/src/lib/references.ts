/**
 * Why a record cannot be deleted — including the part nobody could see.
 *
 * Delete routes report what references a record instead of letting a foreign key surface
 * as a 500. That works, but the counts they report include rows sitting in the TRASH, and
 * a soft-deleted row has left every list and every total. So the message named a number
 * the user could not go and look at: "referenced by 1 money entry" when the Payments page
 * shows none, because the entry is in the trash.
 *
 * The block itself is right and stays. The trashed row genuinely still points at the
 * record, and these deletes are permanent — release the reference and a later restore
 * would bring back a payment belonging to a worker who no longer exists. What was missing
 * is the one sentence that turns a dead end into an instruction.
 *
 * Only the soft-deletable models can be in the trash (`Product`, `Order`, `Proforma`,
 * `LedgerEntry`, `OperationSheet` — see lib/softDelete.ts); everything else is always
 * live, so it needs no probe.
 */
import { prisma } from '../db';
import type { SoftModel } from './softDelete';

export type TrashProbe = { model: SoftModel; where: object };

/**
 * A sentence to append to a "cannot delete" message, or '' when nothing is in the trash.
 * Takes the same `where` clauses the route already counted with.
 */
export async function trashedNote(probes: TrashProbe[]): Promise<string> {
  const counts = await Promise.all(
    probes.map((p) => (prisma as unknown as Record<SoftModel, { count(a: object): Promise<number> }>)[p.model].count({ where: { ...p.where, deletedAt: { not: null } } }))
  );
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return '';
  const one = total === 1;
  return ` ${total} of ${one ? 'those is' : 'them are'} in the trash, where you will not see ${one ? 'it' : 'them'} — destroy ${one ? 'it' : 'them'} from the Trash drawer first if you really mean to remove this.`;
}
