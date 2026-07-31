/**
 * Soft delete — nothing operational is ever unrecoverable.
 *
 * Setting `deletedAt` instead of removing the row means a mis-click costs a click to
 * undo rather than an evening of re-entry. Two rules make it safe:
 *
 * 1. **Filtering happens at the QUERY layer, never inside the pure functions.** The
 *    costing, board, workforce and pricing engines know nothing about deletion; a
 *    soft-deleted order leaves the money picture the same way a cancelled one does —
 *    because the query that loads it excludes it. Teaching the engines about it would
 *    put a second concept of "counts or not" in the one place that must stay simple.
 * 2. **Master data is NOT soft-deletable.** Currencies, units, buyers, suppliers and the
 *    rest already have `isActive`, which does the same job and is what the UI filters on.
 *    Adding a second mechanism there would mean two ways to hide the same row.
 *
 * A permanent delete exists and is Admin-only, with no waiting period and no automatic
 * purge: nothing disappears because time passed, and the only person who can truly lose
 * data is the one who owns the system.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db';
import { ApiError } from './http';

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * The models that carry `deletedAt`.
 *
 * `assertLive` names a row by `factoryCode` for a product and by `number` for everything
 * else, so a model added here must have one of those.
 */
export const SOFT_MODELS = ['product', 'order', 'proforma', 'ledgerEntry', 'operationSheet', 'shipment', 'invoice'] as const;
export type SoftModel = (typeof SOFT_MODELS)[number];

/**
 * Spread into any `where` that feeds a list or the money engine.
 *
 * `deletedAt: null` rather than a `not` test, because an index can satisfy `IS NULL`
 * directly — Postgres B-trees store nulls — and it reads as what it means: only live rows.
 */
export const notDeleted = { deletedAt: null } as const;

/** Merge `deletedAt: null` into an existing filter without clobbering it. */
export function live<T extends object>(where?: T): T & { deletedAt: null } {
  return { ...(where ?? ({} as T)), deletedAt: null };
}

/** Hide a record. Idempotent: deleting twice keeps the first timestamp. */
export async function softDelete(model: SoftModel, id: number, tx: Tx = prisma): Promise<Date> {
  const at = new Date();
  // updateMany so a row already deleted is a no-op rather than an error, and so the
  // `deletedAt: null` guard is part of the write itself.
  const done = await (tx as any)[model].updateMany({ where: { id, deletedAt: null }, data: { deletedAt: at } });
  if (done.count === 0) {
    const existing = await (tx as any)[model].findUnique({ where: { id }, select: { deletedAt: true } });
    if (existing?.deletedAt) return existing.deletedAt as Date;
  }
  return at;
}

/** Bring a record back. */
export async function restore(model: SoftModel, id: number, tx: Tx = prisma): Promise<void> {
  await (tx as any)[model].updateMany({ where: { id }, data: { deletedAt: null } });
}

/**
 * Refuse to reference something that is in the trash.
 *
 * Soft delete hides a record from every list, so quoting a hidden product — or aiming a
 * payment at a hidden order — would create a live document pointing at something nobody
 * can see. The row still EXISTS, so the foreign key would happily accept it; only this
 * check stops it.
 */
export async function assertLive(model: SoftModel, ids: number[], label: string, tx: Tx = prisma): Promise<void> {
  const wanted = [...new Set(ids.filter((n) => Number.isInteger(n)))];
  if (wanted.length === 0) return;
  const dead = await (tx as any)[model].findMany({
    where: { id: { in: wanted }, deletedAt: { not: null } },
    select: { id: true },
  });
  if (dead.length === 0) return;
  const names = await (tx as any)[model].findMany({
    where: { id: { in: dead.map((d: { id: number }) => d.id) } },
    select: { id: true, ...(model === 'product' ? { factoryCode: true } : { number: true }) },
  });
  const listed = names.map((n: Record<string, unknown>) => n.factoryCode ?? n.number ?? `#${n.id}`).join(', ');
  throw new ApiError(409, `${listed} ${dead.length === 1 ? 'is' : 'are'} in the trash. Restore ${dead.length === 1 ? 'it' : 'them'} before using ${dead.length === 1 ? 'it' : 'them'} on ${label}.`);
}

/** Everything currently in the trash for one model, newest deletion first. */
export async function trash<T>(model: SoftModel, select: object, tx: Tx = prisma): Promise<T[]> {
  return (tx as any)[model].findMany({ where: { deletedAt: { not: null } }, select, orderBy: { deletedAt: 'desc' } });
}
