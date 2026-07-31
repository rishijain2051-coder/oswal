/**
 * Manforce defaults, and the one-off migration off typed wage names.
 *
 * Both are idempotent, so `npm run db:setup` can run them every time.
 */
import type { PrismaClient } from '@prisma/client';
import { BUILTIN_STATUTORY, dayStart } from '../src/lib/workforce';

const DEFAULT_TRADES = ['Carpenter', 'Polisher', 'Sander', 'Fitter', 'Packer', 'Helper', 'Supervisor'];

/**
 * Same atomic bump as lib/numbering, on the seed's own client. A read-then-write would
 * let two callers mint the same code, because a plain read takes no lock.
 */
async function nextCode(prisma: PrismaClient, key: string) {
  const seq = await prisma.docSequence.update({ where: { key }, data: { lastNo: { increment: 1 } } });
  return `${seq.prefix}-${String(seq.lastNo).padStart(4, '0')}`;
}

/** Settings, trades and the statutory components — all editable afterwards. */
export async function seedManforceDefaults(prisma: PrismaClient) {
  await prisma.workforceSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });

  for (const [i, name] of DEFAULT_TRADES.entries()) {
    await prisma.trade.upsert({ where: { name }, update: { sortOrder: i }, create: { name, sortOrder: i } });
  }

  for (const c of BUILTIN_STATUTORY) {
    // Update only what identifies the component: the rates belong to the Admin once
    // the row exists, so re-seeding must never overwrite an edited percentage.
    await prisma.statutoryComponent.upsert({
      where: { code: c.code },
      update: { name: c.name, sortOrder: c.sortOrder },
      create: { ...c },
    });
  }

  // Sequences for worker codes, contractor codes and statutory postings.
  for (const [key, prefix] of [
    ['WRK', 'WRK'],
    ['CTR', 'CTR'],
    ['STP', 'STP'],
  ] as const) {
    await prisma.docSequence.upsert({ where: { key }, update: {}, create: { key, prefix, useYear: false, lastNo: 0 } });
  }
}

/**
 * Turn every wage row still recorded against a typed name into a real worker.
 *
 * Historic balances must survive exactly, so the ledger rows are repointed rather than
 * rewritten. The new worker's `accrualFrom` is set to the day AFTER their last typed
 * entry: those wages were already recorded by hand, and letting the engine also
 * presume them present for that period would pay them twice.
 */
export async function migrateTypedWorkers(prisma: PrismaClient) {
  // The sequence must exist before a code can be drawn from it.
  await prisma.docSequence.upsert({ where: { key: 'WRK' }, update: {}, create: { key: 'WRK', prefix: 'WRK', useYear: false, lastNo: 0 } });
  const legacy = await prisma.ledgerEntry.findMany({
    where: { partyType: 'WORKER', workerId: null },
    orderBy: { date: 'asc' },
  });
  if (legacy.length === 0) return { workers: 0, entries: 0 };

  const names = [...new Set(legacy.map((e) => e.partyName.trim()).filter(Boolean))];
  let created = 0;
  let repointed = 0;

  for (const name of names) {
    const mine = legacy.filter((e) => e.partyName.trim() === name);
    const dates = mine.map((e) => new Date(e.date).getTime());
    const first = new Date(Math.min(...dates));
    const last = new Date(Math.max(...dates));

    // A worker of that name may already exist from an earlier run.
    let worker = (await prisma.worker.findMany({ where: { name }, take: 1 }))[0];
    if (!worker) {
      worker = await prisma.worker.create({
        data: {
          code: await nextCode(prisma, 'WRK'),
          name,
          payType: 'DAY',
          joinedOn: dayStart(first),
          accrualFrom: new Date(dayStart(last).getFullYear(), dayStart(last).getMonth(), dayStart(last).getDate() + 1),
          notes: 'Created from wage entries that predate the Manforce module. Set their pay type and rates to start accruing.',
        },
      });
      created++;
    }
    const { count } = await prisma.ledgerEntry.updateMany({ where: { id: { in: mine.map((e) => e.id) } }, data: { workerId: worker.id } });
    repointed += count;
  }

  return { workers: created, entries: repointed };
}
