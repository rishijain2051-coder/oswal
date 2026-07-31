/**
 * Serialise the routes that read the movement ledger and then write to it.
 *
 * This is the one place where moving off SQLite genuinely changed the rules rather than
 * just the syntax, so it is worth stating plainly.
 *
 * Where pieces are is DERIVED: `StageMove` is append-only and `buildBoard` sums it. A
 * clearance therefore has to read every movement on a line, check the move is legal, and
 * only then append — read, validate, write. Under SQLite that sequence was safe almost by
 * accident: write transactions serialise, so of two simultaneous clearances one was made
 * to wait and re-read, and it saw the other's pieces.
 *
 * Postgres does not work that way. At READ COMMITTED — the default, and what Prisma uses
 * — a `SELECT` takes no locks and two transactions happily read the same board, both
 * conclude 10 pieces are available, and both append. Nothing conflicts, both commit, and
 * a stage goes negative. The transaction was never what made it safe; the engine was.
 *
 * So the lock is now explicit. Every route that reads the ledger and writes it takes an
 * exclusive lock on the parent `Order` row FIRST, which makes those routes take their
 * turn on a per-order basis:
 *
 *   - `POST /orders/:id/moves`   append clearances after checking the board
 *   - `DELETE /moves/:id`        undo, which must still be the newest movement
 *   - `PUT /orders/:id`          order qty may not drop below `wip + done`
 *
 * They all contend for the same row, so a clearance cannot slip in between another
 * request reading the board and acting on it. Orders lock independently of each other,
 * which is the point: the factory clears stages on many orders at once and only movements
 * on the SAME order can invalidate each other's arithmetic.
 *
 * It is done with an ordinary `UPDATE` of `updatedAt` rather than raw `SELECT … FOR
 * UPDATE` because an update takes the same row-level exclusive lock, held until the
 * transaction commits, while keeping this codebase free of hand-written SQL — and because
 * it is true: appending a movement does change the order. `updateMany` rather than
 * `update` so a missing order comes back as `count: 0` for the caller to turn into a 404,
 * instead of a Prisma exception that has to be caught and translated.
 *
 * MUST be the first statement in the transaction. Taken after the board has been read,
 * it locks nothing that matters — the stale read has already happened.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { ApiError } from './http';

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Take the order's write lock. Returns false when there is no such order, so the caller
 * can raise its own 404 with wording that fits the route.
 *
 * **Only a LIVE order can be locked.** The lock is an `UPDATE` of `updatedAt`, so locking a
 * trashed order would quietly modify a row that is supposed to be inert — and every caller
 * is about to write to a board that no longer counts towards anything. A trashed order is
 * refused here rather than by each route in turn, so the one message is stated once: the
 * routes used to check `deletedAt` for themselves *after* locking, and only one of them did.
 */
export async function lockOrder(tx: Tx, orderId: number): Promise<boolean> {
  const locked = await tx.order.updateMany({ where: { id: orderId, deletedAt: null }, data: { updatedAt: new Date() } });
  if (locked.count > 0) return true;

  // Nothing was locked: either the order does not exist — the caller's 404 — or it is in the
  // trash, which is a different answer and worth saying, because it is recoverable.
  const trashed = await tx.order.findUnique({ where: { id: orderId }, select: { number: true, deletedAt: true } });
  if (trashed?.deletedAt) throw new ApiError(409, `${trashed.number} is in the trash. Restore it before changing it.`);
  return false;
}
