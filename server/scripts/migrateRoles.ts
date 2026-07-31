/**
 * Carry existing logins across to the role system — run ONCE, BEFORE the schema change.
 *
 *   npx tsx scripts/migrateRoles.ts
 *
 * Order matters and this is the whole reason the script exists. `User.role` (the old
 * 'Admin' | 'Manager' | 'Operator' | 'Viewer' string) is REMOVED by the schema that
 * introduces roles, and `prisma db push` drops the column with the data in it. Anything
 * that needs to read the old rank has to run first, so this adds `isOwner` itself with
 * raw SQL rather than waiting for Prisma to create it.
 *
 * What it does: every active Admin becomes an owner. Owners hold every permission
 * regardless of their role and sit outside the role system entirely, so promoting them is
 * what guarantees somebody can still administer the app the moment the old ranks are gone.
 *
 * It is idempotent — `ADD COLUMN IF NOT EXISTS`, and re-running only re-promotes the same
 * people — and it is safe to run after the schema change too, at which point the old column
 * is gone and the fallback promotes the oldest active account instead of nobody.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `;
  return Number(rows[0]?.n ?? 0) > 0;
}

async function main() {
  // Prisma would create this, but only after `role` has already been dropped.
  await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isOwner" BOOLEAN NOT NULL DEFAULT false`);

  const hasOldRole = await columnExists('User', 'role');

  if (hasOldRole) {
    const promoted = await prisma.$executeRawUnsafe(
      `UPDATE "User" SET "isOwner" = true WHERE "role" = 'Admin' AND "isActive" = true AND "isOwner" = false`
    );
    console.log(`  ${promoted} active Admin(s) promoted to owner.`);
  } else {
    console.log('  The old role column is already gone — nothing to read a rank from.');
  }

  // Whatever happened above, the app must not end up with nobody who can administer it.
  const owners = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "User" WHERE "isOwner" = true AND "isActive" = true`;
  if (Number(owners[0]?.n ?? 0) === 0) {
    const oldest = await prisma.$queryRaw<{ id: number; name: string; email: string }[]>`
      SELECT id, name, email FROM "User" WHERE "isActive" = true ORDER BY "createdAt" ASC, id ASC LIMIT 1
    `;
    if (oldest.length === 0) {
      console.log('\n  No active accounts at all — nothing to promote. Seed a user first.\n');
      return;
    }
    await prisma.$executeRawUnsafe(`UPDATE "User" SET "isOwner" = true WHERE id = ${oldest[0].id}`);
    console.log(`  No Admin found, so the oldest active account is now the owner: ${oldest[0].name} <${oldest[0].email}>.`);
  }

  const all = await prisma.$queryRaw<{ name: string; email: string }[]>`
    SELECT name, email FROM "User" WHERE "isOwner" = true AND "isActive" = true ORDER BY id
  `;
  console.log('\n  Owners (hold every permission, cannot all be removed):');
  for (const u of all) console.log(`      ${u.name} <${u.email}>`);
  console.log('\n  Everybody else now holds NO permissions until you create roles and assign them.\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
