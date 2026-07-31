/**
 * Backup and restore for the factory machine.
 *
 * This exists because of a gap in the packaging rather than in Postgres: the
 * `@embedded-postgres` build ships `initdb`, `pg_ctl` and `postgres` and nothing else, so
 * there is no `pg_dump` to take a logical dump with. What it does ship is a real Postgres
 * cluster in a directory, and PostgreSQL documents copying that directory as a valid
 * backup — on one condition, that **the server is cleanly shut down while you copy it**.
 * A copy taken from a running cluster is a torn snapshot that may not start, so this
 * script stops the server, copies, and starts it again. That is the whole trick, and it is
 * why backups are a command rather than something you can do in Explorer.
 *
 * **`uploads` is copied too, and that is not incidental.** Product photos, hand-over
 * proof-of-condition images, worker documents and the buyer's own POs live on disk with
 * only a filename in the database. A backup of the tables alone would restore rows
 * pointing at files that no longer exist — an order whose bill of lading is gone. The two
 * halves are one backup because they are one record.
 *
 * Restoring is deliberately noisy and explicit: it replaces live data, so it asks for
 * `--yes`, and it moves the current cluster aside instead of deleting it, so a restore of
 * the wrong backup is itself recoverable.
 *
 * The limits, stated rather than discovered later:
 *
 *  - A copy restores onto the **same Postgres major version and the same platform**. Both
 *    come from the pinned `embedded-postgres` version in package.json, which is why it is
 *    pinned exactly. Moving the factory to a new machine of the same OS is fine.
 *  - It is a **cold** backup: the app is down for as long as the copy takes (seconds for a
 *    database this size, longer if `uploads` has grown large).
 *  - It is a full copy every time, not an incremental one. Disk is cheaper than the
 *    complexity of anything else at this scale.
 *
 * Usage:  tsx scripts/backup.ts <backup|list|restore> [name|latest] [--yes] [--keep N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { PGDATA, SERVER_DIR, connection, die, isRunning, start, stop } from './pg';

const BACKUP_DIR = path.join(SERVER_DIR, 'backups');
const UPLOADS = path.join(SERVER_DIR, 'uploads');
/** How many backups to keep. Older ones are pruned after a successful new one. */
const DEFAULT_KEEP = 14;

/** `2026-07-29_1942` — sorts chronologically as a plain string, which `list` relies on. */
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function directorySize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

/** Every backup on disk, oldest first. A marker file is what makes one complete. */
function backups(): string[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(BACKUP_DIR, e.name, 'BACKUP_COMPLETE')))
    .map((e) => e.name)
    .sort();
}

function numberFlag(args: string[], flag: string, fallback: number): number {
  const at = args.indexOf(flag);
  if (at === -1) return fallback;
  const value = Number(args[at + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// ---------------------------------------------------------------------------

async function takeBackup(args: string[]): Promise<void> {
  const conn = connection();
  const keep = numberFlag(args, '--keep', DEFAULT_KEEP);

  if (!fs.existsSync(path.join(PGDATA, 'PG_VERSION'))) {
    die('There is no cluster in server/.pgdata to back up. Run:  npm run pg:start');
  }

  const name = stamp();
  const target = path.join(BACKUP_DIR, name);
  if (fs.existsSync(target)) die(`A backup named ${name} already exists. Wait a minute and try again.`);

  // Remember whether the app was up, so the machine is left as it was found.
  const wasRunning = isRunning();

  console.log(`\n  Backing up to backups/${name}`);
  if (wasRunning) {
    console.log('  Stopping Postgres — a copy of a running cluster is not restorable …');
    stop();
  }

  try {
    fs.mkdirSync(target, { recursive: true });
    console.log('  Copying the database …');
    fs.cpSync(PGDATA, path.join(target, 'pgdata'), { recursive: true });

    if (fs.existsSync(UPLOADS)) {
      console.log('  Copying uploads (photos, documents, attachments) …');
      fs.cpSync(UPLOADS, path.join(target, 'uploads'), { recursive: true });
    }

    // Written LAST and on purpose: a directory without this marker is a copy that was
    // interrupted, and `list` and `restore` both ignore it rather than offering a backup
    // that would not come back.
    fs.writeFileSync(
      path.join(target, 'BACKUP_COMPLETE'),
      JSON.stringify(
        {
          takenAt: new Date().toISOString(),
          database: conn.database,
          postgresMajor: fs.readFileSync(path.join(PGDATA, 'PG_VERSION'), 'utf8').trim(),
          platform: `${process.platform}-${process.arch}`,
        },
        null,
        2
      ) + '\n'
    );
    console.log(`  Done — ${human(directorySize(target))}.`);
  } catch (err) {
    // A half-copied directory is worse than none: it looks like a backup.
    fs.rmSync(target, { recursive: true, force: true });
    throw err;
  } finally {
    if (wasRunning) await start(conn);
  }

  const all = backups();
  const stale = all.slice(0, Math.max(0, all.length - keep));
  for (const old of stale) {
    fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
    console.log(`  Pruned old backup ${old}`);
  }
  console.log(`  ${Math.min(all.length, keep)} backup(s) kept.\n`);
}

function listBackups(): void {
  const all = backups();
  if (all.length === 0) {
    console.log('\n  No backups yet. Take one with:  npm run db:backup\n');
    return;
  }
  console.log(`\n  ${all.length} backup(s) in server/backups, newest last:\n`);
  for (const name of all) {
    const dir = path.join(BACKUP_DIR, name);
    let note = '';
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'BACKUP_COMPLETE'), 'utf8'));
      note = `  PG ${meta.postgresMajor}, ${meta.platform}`;
    } catch {
      /* marker unreadable; the name is enough */
    }
    console.log(`    ${name}   ${human(directorySize(dir)).padStart(9)}${note}`);
  }
  console.log('\n  Restore one with:  npm run db:restore -- <name> --yes\n');
}

async function restoreBackup(args: string[]): Promise<void> {
  const conn = connection();
  const all = backups();
  if (all.length === 0) die('There are no backups to restore from.');

  const wanted = args.find((a) => !a.startsWith('--')) ?? 'latest';
  const name = wanted === 'latest' ? all[all.length - 1] : wanted;
  if (!all.includes(name)) {
    die(`No completed backup named "${name}".\n\n  Available:\n${all.map((b) => `      ${b}`).join('\n')}`);
  }
  const source = path.join(BACKUP_DIR, name);

  if (!args.includes('--yes')) {
    console.log(`\n  This replaces the live database and uploads with the backup taken at ${name}.`);
    console.log('  Everything entered since then is rolled back.\n');
    console.log('  The current cluster is moved aside rather than deleted, so this is reversible.\n');
    console.log(`  To go ahead:\n      npm run db:restore -- ${name} --yes\n`);
    process.exit(1);
  }

  const wasRunning = isRunning();
  if (wasRunning) {
    console.log('\n  Stopping Postgres …');
    stop();
  }

  const aside = `${PGDATA}.replaced-${stamp()}`;
  if (fs.existsSync(PGDATA)) {
    fs.renameSync(PGDATA, aside);
    console.log(`  Current cluster moved to ${path.basename(aside)}`);
  }
  const uploadsAside = `${UPLOADS}.replaced-${stamp()}`;
  if (fs.existsSync(UPLOADS)) {
    fs.renameSync(UPLOADS, uploadsAside);
    console.log(`  Current uploads moved to ${path.basename(uploadsAside)}`);
  }

  console.log('  Restoring the database …');
  fs.cpSync(path.join(source, 'pgdata'), PGDATA, { recursive: true });
  if (fs.existsSync(path.join(source, 'uploads'))) {
    console.log('  Restoring uploads …');
    fs.cpSync(path.join(source, 'uploads'), UPLOADS, { recursive: true });
  } else {
    fs.mkdirSync(UPLOADS, { recursive: true });
  }

  // A stale pid file from the machine the backup was taken on stops the server starting.
  fs.rmSync(path.join(PGDATA, 'postmaster.pid'), { force: true });

  await start(conn);
  console.log(`\n  Restored ${name}. The replaced copies are still on disk — delete them once you are satisfied.\n`);
}

async function main(): Promise<void> {
  const [command = 'list', ...args] = process.argv.slice(2);
  switch (command) {
    case 'backup':
      await takeBackup(args);
      break;
    case 'list':
      listBackups();
      break;
    case 'restore':
      await restoreBackup(args);
      break;
    default:
      die(`Unknown command "${command}". Use: backup | list | restore`);
  }
}

main().catch((err: unknown) => {
  die(err instanceof Error ? err.message : String(err));
});
