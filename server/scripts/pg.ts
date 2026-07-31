/**
 * The Postgres cluster that lives inside this repository.
 *
 * There is no system-wide Postgres to install and no Docker to run: the server
 * binaries arrive as an npm package (`embedded-postgres`, which pulls the
 * `@embedded-postgres/<platform>` build for this machine) and the data directory is
 * `server/.pgdata`, git-ignored beside `server/uploads`. Clone, `npm install`,
 * `npm run pg:start`, and the database is real Postgres on localhost.
 *
 * Two decisions are worth keeping:
 *
 * 1. **`DATABASE_URL` is the single source of truth.** The port, user, password and
 *    database name are parsed out of it rather than restated here, so there is exactly
 *    one place to change and the cluster cannot end up listening somewhere Prisma is
 *    not looking. The port is handed to `pg_ctl` with `-o "-p …"` for the same reason —
 *    writing it into `postgresql.conf` would make it a second copy that could disagree.
 * 2. **The cluster is started detached, via `pg_ctl`.** The `embedded-postgres` library
 *    API keeps the server as a child of the Node process that started it, which dies
 *    with the script; `pg_ctl start` daemonises and leaves a pid file, so
 *    `npm run pg:start` then `npm run dev` behaves the way a system service would.
 *
 * `initdb` runs with `--locale=C`, which sorts strings in byte order — the same order
 * SQLite's default collation gave, so lists that were already sorted by name did not
 * quietly reorder when the database changed underneath them.
 *
 * The only binaries the platform package ships are `initdb`, `pg_ctl` and `postgres` —
 * there is no `psql` or `createdb`, which is why the database itself is created over a
 * connection with `pg` rather than by shelling out.
 *
 * Usage:  tsx scripts/pg.ts <start|stop|restart|status|init|reset|url>
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

export const SERVER_DIR = path.resolve(__dirname, '..');
export const PGDATA = path.join(SERVER_DIR, '.pgdata');
const LOGFILE = path.join(PGDATA, 'postgres.log');
const IS_WINDOWS = process.platform === 'win32';

dotenv.config({ path: path.join(SERVER_DIR, '.env') });

export function die(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Connection details, read out of DATABASE_URL
// ---------------------------------------------------------------------------

export type Conn = { host: string; port: number; user: string; password: string; database: string };

/**
 * A cluster this script may create, start, stop and destroy has to be one this repo
 * owns. Anything that is not plainly local is refused rather than acted on — `pg:reset`
 * deletes a data directory, and pointing `DATABASE_URL` at a shared server should never
 * be the thing that decides whether that happens.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);

export function connection(): Conn {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) die('DATABASE_URL is not set. Copy server/.env.example to server/.env.');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return die(`DATABASE_URL is not a valid URL: ${raw}`);
  }

  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    die(`DATABASE_URL is not a Postgres URL (${url.protocol}//…). This project moved off SQLite — see server/.env.example.`);
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    die(`DATABASE_URL points at "${url.hostname}", which is not this machine. This script only manages the cluster in server/.pgdata; a remote database is managed wherever it is hosted.`);
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const user = decodeURIComponent(url.username);
  if (!database) die('DATABASE_URL has no database name (…:5433/saraswati).');
  if (!user) die('DATABASE_URL has no user (…//postgres:password@…).');

  return {
    host: url.hostname || '127.0.0.1',
    port: parseInt(url.port || '5432', 10),
    user,
    password: decodeURIComponent(url.password),
    database,
  };
}

// ---------------------------------------------------------------------------
// Binaries
// ---------------------------------------------------------------------------

/** The `@embedded-postgres` build npm installed for this machine. */
function platformPackage(): string {
  const key = `${process.platform}-${process.arch}`;
  const known: Record<string, string> = {
    'win32-x64': 'windows-x64',
    'darwin-arm64': 'darwin-arm64',
    'darwin-x64': 'darwin-x64',
    'linux-x64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
    'linux-arm': 'linux-arm',
    'linux-ia32': 'linux-ia32',
    'linux-ppc64': 'linux-ppc64',
  };
  const build = known[key];
  if (!build) die(`No embedded Postgres build for ${key}. Install Postgres yourself and point DATABASE_URL at it.`);
  return `@embedded-postgres/${build}`;
}

/**
 * The package sets `"exports": "./dist/index.js"`, which blocks `require.resolve` of any
 * other subpath, and it is ESM-only — so the bin directory is found by walking up the
 * node_modules chain the way Node itself would, rather than importing it.
 */
function binDir(): string {
  const pkg = platformPackage();
  let dir = SERVER_DIR;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...pkg.split('/'), 'native', 'bin');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return die(`Postgres binaries not found (${pkg}). Run:  npm install`);
}

function exe(name: string): string {
  const file = path.join(binDir(), IS_WINDOWS ? `${name}.exe` : name);
  if (!fs.existsSync(file)) die(`${name} is missing from ${binDir()}. Run:  npm install`);
  return file;
}

type Run = { code: number; stdout: string; stderr: string };

/**
 * Run one of the Postgres binaries and wait for it.
 *
 * Output goes to temporary FILES rather than pipes, which looks like a detour and is not:
 * `pg_ctl start` leaves a postmaster running, and that postmaster inherits whatever
 * stdout and stderr handles it was given. With pipes, `spawnSync` waits for end-of-file on
 * a stream the database server holds open for as long as it is alive — so the call never
 * returns even though `pg_ctl` itself exited seconds earlier, and `npm run pg:start` hangs
 * with a perfectly healthy database behind it. A file handle carries no such wait.
 * Do not "simplify" this back to `encoding: 'utf8'`.
 */
function run(file: string, args: string[], env?: Record<string, string>): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saraswati-pg-'));
  const outPath = path.join(dir, 'stdout');
  const errPath = path.join(dir, 'stderr');
  const out = fs.openSync(outPath, 'w');
  const err = fs.openSync(errPath, 'w');
  try {
    const res = spawnSync(file, args, {
      stdio: ['ignore', out, err],
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    fs.closeSync(out);
    fs.closeSync(err);
    if (res.error) die(`Could not run ${path.basename(file)}: ${res.error.message}`);
    return {
      code: res.status ?? 1,
      stdout: fs.readFileSync(outPath, 'utf8'),
      stderr: fs.readFileSync(errPath, 'utf8'),
    };
  } finally {
    // Closing an already-closed descriptor throws, so the happy path closes and this
    // only cleans up after a failure before that point.
    for (const fd of [out, err]) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Cluster lifecycle
// ---------------------------------------------------------------------------

function isInitialised(): boolean {
  return fs.existsSync(path.join(PGDATA, 'PG_VERSION'));
}

/** `pg_ctl status` exits 0 when the server is up, 3 when the data dir is idle. */
export function isRunning(): boolean {
  if (!isInitialised()) return false;
  return run(exe('pg_ctl'), ['status', '-D', PGDATA]).code === 0;
}

/** The last few lines of the server log, for when a start fails and the reason is in there. */
function tailLog(lines = 12): string {
  if (!fs.existsSync(LOGFILE)) return '';
  const all = fs.readFileSync(LOGFILE, 'utf8').trimEnd().split(/\r?\n/);
  return all.slice(-lines).map((l) => `      ${l}`).join('\n');
}

/**
 * Something is already accepting connections on the port. Checked before creating a
 * cluster, because the interesting case is a Postgres the user installed themselves: the
 * data directory here is empty, `initdb` would happily build a second cluster, and the
 * start would then fail on the address being in use — with an error about ports rather
 * than about the two databases.
 */
function portInUse(conn: Conn): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(conn.port, conn.host === '::1' ? '::1' : conn.host);
  });
}

async function init(conn: Conn): Promise<void> {
  if (isInitialised()) return;

  if (await portInUse(conn)) {
    die(
      `Something is already serving port ${conn.port} on ${conn.host}, and there is no cluster in ` +
        `${path.relative(process.cwd(), PGDATA)} yet.\n\n` +
        `  If that is a Postgres you installed yourself, you do not need these scripts at all — the\n` +
        `  app only needs DATABASE_URL to point at it. Create the database and run:  npm run db:setup\n\n` +
        `  If it is something else, change the port in server/.env and run this again.`
    );
  }

  console.log(`  Creating a Postgres cluster in ${path.relative(process.cwd(), PGDATA)} …`);
  fs.mkdirSync(PGDATA, { recursive: true });

  // initdb will not take a password on the command line (it would sit in the process
  // list), so it goes through a file that is removed either way.
  const pwfile = path.join(os.tmpdir(), `saraswati-initdb-${process.pid}`);
  fs.writeFileSync(pwfile, conn.password, { mode: 0o600 });
  try {
    const res = run(exe('initdb'), [
      '-D', PGDATA,
      '-U', conn.user,
      `--pwfile=${pwfile}`,
      '--encoding=UTF8',
      '--locale=C',
      '--auth=scram-sha-256',
    ]);
    if (res.code !== 0) {
      fs.rmSync(PGDATA, { recursive: true, force: true });
      die(`initdb failed:\n${res.stderr || res.stdout}`);
    }
  } finally {
    fs.rmSync(pwfile, { force: true });
  }
  console.log('  Cluster created.');
}

export async function start(conn: Conn): Promise<void> {
  await init(conn);

  if (isRunning()) {
    console.log(`  Postgres is already running on port ${conn.port}.`);
  } else {
    // `-w` waits until the server is actually accepting connections, so anything that
    // runs after this command can connect without polling.
    const res = run(exe('pg_ctl'), ['start', '-D', PGDATA, '-l', LOGFILE, '-w', '-o', `-p ${conn.port}`]);
    if (res.code !== 0) {
      const log = tailLog();
      die(`Postgres did not start:\n${res.stderr || res.stdout}${log ? `\n\n    From ${path.relative(process.cwd(), LOGFILE)}:\n${log}` : ''}`);
    }
    console.log(`  Postgres is up on port ${conn.port}.`);
  }
}

export function stop(): void {
  if (!isInitialised()) {
    console.log('  No cluster in server/.pgdata — nothing to stop.');
    return;
  }
  if (!isRunning()) {
    console.log('  Postgres is not running.');
    return;
  }
  // `fast` rolls back open transactions and shuts down rather than waiting for clients
  // to disconnect on their own, which a dev server never does.
  const res = run(exe('pg_ctl'), ['stop', '-D', PGDATA, '-m', 'fast', '-w']);
  if (res.code !== 0) die(`Could not stop Postgres:\n${res.stderr || res.stdout}`);
  console.log('  Postgres stopped.');
}

// ---------------------------------------------------------------------------
// The application database
// ---------------------------------------------------------------------------

/**
 * `initdb` only ever creates `postgres`, `template0` and `template1`, and the platform
 * package ships no `createdb`, so the application database is created over a connection
 * to the maintenance database. Prisma would create it too, but then `pg:start` alone
 * would leave a cluster with no database in it and the failure would surface later,
 * somewhere less obvious.
 */
export async function ensureDatabase(conn: Conn): Promise<void> {
  // Required lazily: this file also runs `stop`/`status`, which need no client.
  const { Client } = require('pg') as typeof import('pg');
  const client = new Client({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: 'postgres',
  });
  await client.connect();
  try {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [conn.database]);
    if (found.rowCount === 0) {
      // The name cannot be a bound parameter in DDL, so it is quoted as an identifier —
      // doubling any embedded quote — rather than interpolated raw.
      await client.query(`CREATE DATABASE "${conn.database.replace(/"/g, '""')}"`);
      console.log(`  Created database "${conn.database}".`);
    }
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function status(conn: Conn): Promise<void> {
  console.log(`  data directory : ${path.relative(process.cwd(), PGDATA)}${isInitialised() ? '' : '  (not created yet)'}`);
  console.log(`  server         : ${isRunning() ? `running on port ${conn.port}` : 'stopped'}`);
  console.log(`  database       : ${conn.database} as ${conn.user}`);
  if (fs.existsSync(LOGFILE)) console.log(`  log            : ${path.relative(process.cwd(), LOGFILE)}`);
}

/**
 * Destroys the cluster and everything in it. Guarded by an explicit `--yes` because it
 * is the one command here that loses data, and `db:clean` / `db:reset` already cover
 * every case where the schema or the rows — rather than the server — are the problem.
 */
async function reset(conn: Conn, args: string[]): Promise<void> {
  if (!args.includes('--yes')) {
    console.log(`\n  This deletes the whole cluster at ${path.relative(process.cwd(), PGDATA)} —`);
    console.log(`  every table and row in "${conn.database}" goes with it.\n`);
    console.log('  To empty the data but keep the database, use one of these instead:');
    console.log('      npm run db:clean     operational data to zero, configuration kept');
    console.log('      npm run db:reset     drop and recreate the schema, then seed\n');
    console.log('  If you really mean the cluster:');
    console.log('      npm run pg:reset -- --yes\n');
    process.exit(1);
  }
  stop();
  fs.rmSync(PGDATA, { recursive: true, force: true });
  console.log('  Cluster deleted.');
  await start(conn);
  await ensureDatabase(conn);
  console.log('\n  Empty cluster ready. Now run:  npm run db:setup\n');
}

async function main(): Promise<void> {
  const [command = 'status', ...args] = process.argv.slice(2);
  const conn = connection();

  switch (command) {
    case 'init':
      await init(conn);
      break;
    case 'start':
      await start(conn);
      await ensureDatabase(conn);
      break;
    case 'stop':
      stop();
      break;
    case 'restart':
      stop();
      await start(conn);
      await ensureDatabase(conn);
      break;
    case 'status':
      await status(conn);
      break;
    case 'reset':
      await reset(conn, args);
      break;
    case 'url':
      console.log(process.env.DATABASE_URL);
      break;
    default:
      die(`Unknown command "${command}". Use: start | stop | restart | status | init | reset | url`);
  }
}

// Only run the CLI when invoked directly. `scripts/backup.ts` imports the lifecycle
// helpers above, and importing a module must not start or stop a database.
if (require.main === module) {
  main().catch((err: unknown) => {
    die(err instanceof Error ? err.message : String(err));
  });
}
