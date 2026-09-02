# Hosting on Vercel + Supabase

A guide for moving this ERP off the factory machine and onto Vercel (app) + Supabase
(database and files).

Read the first section before starting. Vercel is not a drop-in host for this app, and
the reason is a hard platform limit rather than anything wrong with the code.

---

## 0. What you are signing up for

The app today is one Express server on one machine with a Postgres cluster beside it and
an `uploads` folder next to that. Vercel gives you none of those three things: no long-lived
process, no local disk, no database. Supabase supplies the last two. What remains is
adapting the app to a runtime that forgets everything between requests.

| Piece | Now | After |
|---|---|---|
| Database | `server/.pgdata`, embedded Postgres 17 | Supabase Postgres |
| API | Express on `:689`, one process | Vercel serverless function |
| Client | Vite dev server on `:688` | Vercel static build (CDN) |
| Files | `server/uploads/` on disk | Supabase Storage bucket |
| Backups | `npm run db:backup` (cold copy) | Supabase automatic backups |

**Effort, honestly:**

- Supabase database — **~30 minutes.** Genuinely easy; `DATABASE_URL` is already the
  single source of truth, exactly as `.env.example` says.
- Vercel wiring (build, routing, entrypoint) — **1–2 hours.**
- Moving uploads to Supabase Storage — **most of a day**, across ~11 files.

If the upload rewrite is more than you want, skip to [Appendix A](#appendix-a--the-shorter-road)
for a version that keeps uploads on disk and takes about an hour total.

### The three blockers, with numbers

**1. Request body limit — 4.5 MB.** A Vercel serverless function cannot receive a body
larger than 4.5 MB on any plan. Your limits today:

```
server/src/lib/imageUpload.ts:33      fileSize: 10 MB, files: 20
server/src/lib/documentUpload.ts:28   MAX_ATTACHMENT_BYTES = 25 MB, files: 10
```

Six endpoints post multipart bodies:

```
products.routes.ts:602      upload.array('images', 20)      product photos
ops.orders.routes.ts:1029   uploadAttachments.array(…, 10)  buyer POs, B/Ls, customs forms
ops.orders.routes.ts:1338   uploadPhotos.array('photos',10) hand-over proof
manforce.routes.ts:592      uploadDocs.array('files', 10)   worker documents
masters.routes.ts:274       uploadLogo.single('file')       company logo
sales.routes.ts:1227        uploadQr.single('file')         invoice QR
```

A scanned 4-page bill of lading clears 4.5 MB easily. This is not tunable — the fix is to
stop sending files through the API at all (§3).

**2. Read-only filesystem.** `imageUpload.ts:17` calls `fs.mkdirSync(uploadDir)` at module
load. On Vercel only `/tmp` is writable, and it is wiped between invocations, so a photo
written on one request is gone by the next. `express.static` in `index.ts:66` has nothing
to serve.

**3. In-memory state does not survive.** Two things assume one long-lived process:

- `auth.routes.ts` — the login throttle is a `Map` swept by `setInterval`. Across serverless
  instances each one counts separately, so brute-force protection weakens roughly in
  proportion to how many instances are warm. This is a real security regression, not a
  cosmetic one; see §6 for the fix.
- `access.ts` — the 10-second permission cache. Harmless: it just stops helping, and
  `CLAUDE.md` already calls the TTL a backstop.

---

## 1. Supabase — the database

### 1.1 Create the project

1. supabase.com → **New project**.
2. Region: **Mumbai (ap-south-1)** — the factory is in Jodhpur and every millisecond of
   round-trip is paid on each Prisma query.
3. Set a strong database password and save it in a password manager. You will need it in
   two connection strings.
4. Wait for provisioning (~2 minutes).

**Plan note.** The free tier is 500 MB database and 1 GB storage, and **pauses a project
after 7 days with no activity**. A factory using it daily never hits that, but a fortnight
shut for Diwali would come back to a paused database needing a manual resume. Pro ($25/mo)
removes the pause and gives 8 GB + 100 GB.

### 1.2 Get both connection strings

Project → **Connect** → *ORMs* → *Prisma*. You need two, and they are different on purpose:

```bash
# Transaction pooler (port 6543, PgBouncer). For the app at runtime.
# Serverless opens a connection per invocation; without the pooler you exhaust
# Postgres' connection limit under any real load.
DATABASE_URL="postgresql://postgres.<REF>:<PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"

# Session pooler (port 5432). For schema pushes only.
# PgBouncer in transaction mode cannot run DDL or prepared statements, so
# `prisma db push` must bypass it.
DIRECT_URL="postgresql://postgres.<REF>:<PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"
```

`connection_limit=1` is not a typo. Each serverless invocation is its own Prisma client;
letting each open a pool multiplies straight into PgBouncer's ceiling.

### 1.3 Teach Prisma about the second URL

`server/prisma/schema.prisma`:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

`directUrl` is required once declared, so add it to `server/.env` too, pointing at the same
local cluster:

```bash
DATABASE_URL="postgresql://postgres:oswal_local@127.0.0.1:687/oswal?schema=public"
DIRECT_URL="postgresql://postgres:oswal_local@127.0.0.1:687/oswal?schema=public"
```

### 1.4 Push the schema and seed

From your machine, with the Supabase URLs in the environment:

```bash
cd server && DATABASE_URL="<pooler-6543-url>" DIRECT_URL="<pooler-5432-url>" npx prisma db push
```

Then seed configuration (currencies, units, cost formulas, container types, statutory
components, the first owner login):

```bash
cd server && DATABASE_URL="<pooler-6543-url>" DIRECT_URL="<pooler-5432-url>" npx tsx prisma/seed.ts
```

Do **not** run `db:setup`, `db:demo`, `db:fill` or `db:clean` against Supabase — every one
of them starts the local cluster first (`tsx scripts/pg.ts start && …`) and `db:clean`
would wipe your production data. Call the underlying script directly, as above.

### 1.5 The collation change — read this one

`scripts/pg.ts` runs `initdb --locale=C`, which sorts in **byte order**. Supabase uses
`en_US.UTF-8`, which sorts case-insensitively and ignores punctuation. `CLAUDE.md` records
that `--locale=C` was chosen deliberately so `orderBy: name` lists did not reorder when the
app moved off SQLite.

Nothing breaks, but every alphabetical list changes order:

| | `C` (now) | `en_US.UTF-8` (Supabase) |
|---|---|---|
| `Almirah`, `almirah`, `Bench` | `Almirah`, `Bench`, `almirah` | `almirah`, `Almirah`, `Bench` |
| `AB-1`, `AB 2` | `AB 2`, `AB-1` | `AB-1`, `AB 2` |

Arguably the Supabase behaviour is nicer for humans. Just know it will happen, so nobody
reports it as a bug. Supabase does not let you set the cluster locale, so accept it or add
explicit collation to the affected `orderBy` clauses.

### 1.6 What stops working

`npm run pg:start`, `pg:stop`, `pg:status`, `pg:reset`, `db:backup`, `db:backups`,
`db:restore`. All of them manage a local cluster; `pg.ts` already refuses a non-local host,
so they fail loudly rather than doing something surprising. Supabase's own daily backups
replace them — **but they back up the database only.** Your uploads bucket needs its own
backup story, which is precisely the "one record, one backup" property `CLAUDE.md` says
`db:backup` existed to protect. Losing it is a genuine cost of this move.

---

## 2. Supabase Storage — the bucket

Project → **Storage** → **New bucket**:

- Name: `uploads`
- **Public: off.** These are buyer POs, worker Aadhaar scans and bank details. The app
  already serves them behind `authenticateUpload` with `nosniff` and a CSP; a public bucket
  would undo all of it.
- File size limit: `26214400` (25 MB, matching `MAX_ATTACHMENT_BYTES`).

Copy the **service role key** from Project → Settings → API. It bypasses row-level security,
which is what you want here — the app does its own permission checks and is the only thing
holding the key. It must never reach the browser.

---

## 3. Moving uploads off disk

This is the bulk of the work. The design below preserves both properties the codebase
cares about: the **magic-byte check** and the stored **`/uploads/<filename>` URL shape**.

### 3.1 Keep the URL shape

Several tables store `url: '/uploads/<filename>'` — `ProductImage`, `StageMovePhoto`,
`WorkerDocument`, `OrderAttachment`, the company logo, the invoice QR. Rewriting those rows
would mean a data migration and touching every component that renders one.

Don't. Keep the path, change what answers it. Replace the `express.static` block in
`server/src/index.ts` with a route that still sits behind `authenticateUpload` and redirects
to a short-lived signed URL:

```ts
// server/src/index.ts — replaces the express.static('/uploads') block
app.get('/uploads/:name', authenticateUpload, async (req, res, next) => {
  try {
    // The name is a generated one (`prefix-timestamp-nanoid.ext`); reject anything
    // carrying a separator so a stored value can never address another prefix.
    const name = req.params.name;
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new ApiError(400, 'Bad file name.');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.redirect(302, await signedDownloadUrl(name, 300)); // 5 minutes
  } catch (e) { next(e); }
});
```

`<img src="/uploads/…">` follows the redirect transparently, so **no client display code
changes at all.**

### 3.2 One seam for the bucket

New file, in the style of `imageUpload.ts` — one authority, stated once:

```ts
// server/src/lib/blobStore.ts
import { createClient } from '@supabase/supabase-js';

const BUCKET = 'uploads';
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

/** A URL the BROWSER may PUT one file to. Bypasses the 4.5 MB function limit. */
export async function signedUploadUrl(name: string) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(name);
  if (error) throw error;
  return data; // { signedUrl, token, path }
}

/** A short-lived URL the browser may GET. */
export async function signedDownloadUrl(name: string, seconds = 300) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(name, seconds);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * The first `n` bytes, for the magic-byte check. A ranged download, so a 25 MB
 * attachment costs 16 bytes to validate rather than being pulled into a function.
 */
export async function head(name: string, n = 16): Promise<Buffer | null> {
  const url = await signedDownloadUrl(name, 60);
  const r = await fetch(url, { headers: { Range: `bytes=0-${n - 1}` } });
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

/** Replaces every `fs.promises.unlink(path.join(uploadDir, …))` call. */
export async function remove(names: string[]) {
  if (names.length) await supabase.storage.from(BUCKET).remove(names);
}

/** Full bytes — only for pdfkit, which needs the whole image to draw it. */
export async function download(name: string): Promise<Buffer | null> {
  const { data, error } = await supabase.storage.from(BUCKET).download(name);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}
```

```bash
npm --workspace server install @supabase/supabase-js
```

### 3.3 The new upload flow

Files stop going through the API. Three steps instead of one:

```
1. POST /api/uploads/sign   { files: [{ name, size }] }
     → server checks the caller's permission and the extension allow-list
     → returns [{ key, signedUrl }]

2. Browser PUTs each file straight to signedUrl        ← no 4.5 MB limit
     → Supabase Storage

3. POST /api/orders/:id/attachments   { keys: [...] }  ← JSON, not multipart
     → server range-downloads 16 bytes per key, runs the SAME magic-byte check
     → on mismatch: storage.remove(key), refuse
     → on pass: write the rows
```

**The security invariant survives.** `CLAUDE.md` says a declared mimetype is
attacker-controlled and proves nothing, so bytes get checked. That is still true here — the
check moves from `fs.openSync` to a 16-byte ranged fetch, and an object that fails is
removed from the bucket before any row can point at it. Same rule, different read.

`looksLikeImage()` and the document sniffer become buffer functions rather than
path functions, which is a simplification:

```ts
// server/src/lib/imageUpload.ts
export function looksLikeImage(head: Buffer): boolean {
  if (head.length < 12) return false;
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const png  = head.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  const gif  = ['GIF87a','GIF89a'].includes(head.subarray(0, 6).toString('latin1'));
  const webp = head.subarray(0,4).toString('latin1') === 'RIFF'
            && head.subarray(8,12).toString('latin1') === 'WEBP';
  return jpeg || png || gif || webp;
}
```

The filename generator (`${prefix}${Date.now()}-${nanoid(8)}${ext}`) moves to the signing
endpoint unchanged — including the rule that only a known extension is kept, so a client
filename can never carry a path separator or a second extension.

### 3.4 Every file to touch

| File | Change |
|---|---|
| `server/src/lib/blobStore.ts` | **new** — the seam above |
| `server/src/lib/imageUpload.ts` | multer → key generation; `looksLikeImage(Buffer)` |
| `server/src/lib/documentUpload.ts` | same, for the 25 MB attachment sniffer |
| `server/src/routes/uploads.routes.ts` | **new** — `POST /uploads/sign` |
| `server/src/index.ts` | drop `express.static`; add the signed-redirect route |
| `server/src/lib/docPdf.ts:53` | `fs.existsSync` → `await download(name)` for photos |
| `server/src/lib/company.ts:65` | same, for the letterhead logo |
| `products.routes.ts:602` | multipart → `{ keys }`; `unlink` → `remove` |
| `ops.orders.routes.ts:1029,1338` | attachments + hand-over photos, same |
| `manforce.routes.ts:592,619` | worker documents, same |
| `masters.routes.ts:274`, `sales.routes.ts:1227` | logo + QR, same |
| `client/src/api/*` | upload helpers do sign → PUT → confirm |

`ops.orders.routes.ts:1097` needs care: the attachment download is deliberately
**scoped to the order in its path** so one order's id cannot fetch another's file, and it
always sends `Content-Disposition: attachment`. Keep both — issue the signed URL only after
the order check passes, and pass the original filename through Supabase's `download` query
parameter so the disposition header is preserved.

---

## 4. Vercel — the app

### 4.1 Split the Express app from the listener

`index.ts` currently builds the app and calls `listen`. A serverless function must export
the app instead. Move everything up to `app.use(errorHandler)` into `server/src/app.ts`:

```ts
// server/src/app.ts
const app = express();
/* … all existing middleware and routes, unchanged … */
app.use(errorHandler);
export default app;
```

```ts
// server/src/index.ts — the local/VPS entrypoint, still works as before
import app from './app';
import { env } from './env';
app.listen(env.PORT, () => {
  console.log(`\n  Oswal Handicrafts ERP API running at http://localhost:${env.PORT}\n`);
});
```

```ts
// api/index.ts — the Vercel entrypoint, at the repo root
import app from '../server/src/app';
export default app;
```

### 4.2 `vercel.json`

At the repo root:

```json
{
  "buildCommand": "npm run vercel-build",
  "outputDirectory": "client/dist",
  "installCommand": "npm install",
  "framework": null,
  "functions": {
    "api/index.ts": { "maxDuration": 30, "memory": 1024 }
  },
  "rewrites": [
    { "source": "/api/(.*)",     "destination": "/api" },
    { "source": "/uploads/(.*)", "destination": "/api" },
    { "source": "/(.*)",         "destination": "/index.html" }
  ]
}
```

Three things worth knowing:

- **Rewrites run after the filesystem check**, so `/assets/index-abc.js` is served from the
  CDN and never reaches the function. Only unmatched paths fall through to `/index.html`,
  which is what makes React Router's client-side routes work on refresh.
- The `/uploads/(.*)` rewrite is what routes file requests to the redirect route from §3.1.
- `maxDuration: 30` — Hobby caps lower than Pro. The PDF generation route is the one that
  can run long; if a proforma with a dozen photos times out, that is the number to raise.

Add the build script to the root `package.json`:

```json
"vercel-build": "npm --workspace server run build && npm --workspace client run build"
```

`server/build` already runs `prisma generate` first, so the client is generated during the
Vercel build — necessary, because Prisma's engine is platform-specific and the one on your
Windows machine is not the one Vercel's Linux runtime needs.

### 4.3 Environment variables

Vercel → Project → Settings → Environment Variables. All of these for **Production**:

```bash
DATABASE_URL                    # pooler, port 6543, ?pgbouncer=true&connection_limit=1
DIRECT_URL                      # pooler, port 5432
JWT_SECRET                      # 48 random bytes — see below
NODE_ENV=production
CORS_ORIGINS=https://<your-project>.vercel.app
SUPABASE_URL=https://<REF>.supabase.co
SUPABASE_SERVICE_ROLE_KEY       # service role, NOT the anon key
```

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`env.ts` throws on a missing or placeholder `JWT_SECRET` in production, so a bad value fails
the deploy rather than shipping a signable token. That is deliberate — leave it.

`CORS_ORIGINS` must be exact, including `https://` and no trailing slash. With it unset,
`resolveOrigins()` returns `[]` in production and **every** request is refused — the safe
direction to fail, but confusing if you don't expect it. Add your custom domain to the list
as a second comma-separated entry when you attach one.

### 4.4 The cookie

`auth.routes.ts` sets the session cookie with `sameSite: 'lax'`, `secure: env.isProd`. On
Vercel everything is HTTPS on one origin, so this works unchanged and `secure` finally does
something. If you ever split the API onto a different domain from the client, this cookie
stops being sent and `<img src="/uploads/…">` breaks — `sameSite` would need to become
`'none'`. Keeping them same-origin avoids the whole problem, which is why §4.2 routes
`/api` and `/uploads` through the same Vercel project.

### 4.5 Deploy

```bash
npm i -g vercel
vercel link
vercel --prod
```

Or connect the GitHub repo in the dashboard for a deploy on every push to `main`.

---

## 5. Post-deploy checklist

Work through these in order; each one catches a different class of failure.

- [ ] `GET https://<app>.vercel.app/api/health` returns `{"ok":true}` — the function boots
      and `env.ts` accepted `JWT_SECRET`.
- [ ] Log in. Failure here is usually `CORS_ORIGINS`; the response says which origin was
      refused.
- [ ] Open a product with photos — exercises the `/uploads` redirect and the signed URL.
- [ ] Upload a **6 MB** photo. This is the one that proves the 4.5 MB bypass works; anything
      smaller would pass even through a broken implementation.
- [ ] Upload a **20 MB** PDF as an order attachment, then download it — checks the ranged
      magic-byte read and the order-scoped download.
- [ ] Rename `notes.txt` to `notes.png` and upload it as a product image. It must be
      **refused and removed from the bucket**. If it succeeds, the magic-byte check did not
      survive the move.
- [ ] Download a proforma PDF for a product with photos — `docPdf.ts` fetching from Storage.
- [ ] Clear a stage on the production board, then undo it — the `lockOrder` row lock under
      PgBouncer. Watch for `prepared statement "s0" already exists`, which means
      `?pgbouncer=true` is missing from `DATABASE_URL`.
- [ ] Check an alphabetical list against the old machine (§1.5) so the collation reorder is
      recognised rather than reported.
- [ ] `npm run verify` locally. It needs no database, so it still guards every engine
      invariant — and none of this work should have touched one.

---

## 6. The login throttle

Worth doing before you consider this finished. `auth.routes.ts` counts failed logins in a
process-local `Map`. On Vercel each warm instance counts separately, so the effective limit
multiplies by the number of instances — the protection degrades silently, which is the worst
way for a security control to fail.

Options, cheapest first:

1. **Move the counter into Postgres.** A small `LoginAttempt` table with an atomic
   `{ increment: 1 }`, exactly the pattern `nextDocNumber` already uses for the same reason
   — a read-then-write lets two callers agree on a stale value. One table, no new service.
2. **Vercel KV / Upstash Redis.** Purpose-built, ~10 lines, another service to hold a key.
3. **Accept it.** Only defensible if logins are also protected some other way. It is not
   the default I would pick for an app holding worker Aadhaar numbers and bank details.

The `setInterval` sweep can go either way; it is `.unref()`'d, so it is inert rather than
harmful.

---

## Appendix A — the shorter road

If the upload rewrite is more than this is worth right now, host the API somewhere with a
real filesystem and keep Vercel for the client only:

| | Vercel + Supabase | Vercel (client) + Render/Railway/Fly (API) + Supabase (DB) |
|---|---|---|
| Upload rewrite | required, ~1 day | **none** |
| 4.5 MB body limit | applies | does not apply |
| Login throttle | degrades | works as written |
| `express.static` | must be replaced | unchanged |
| Cold starts | yes | no |
| Cost | Vercel free/$20 + Supabase free/$25 | + ~$7/mo for the API |

**What changes:** `DATABASE_URL` points at Supabase, `CORS_ORIGINS` names the Vercel
domain, and the client needs `VITE_API_URL` because `api/client.ts` currently uses a
relative `baseURL: '/api'`. Attach a persistent disk (Render Disks, Railway Volumes, Fly
Volumes) mounted at `server/uploads` and **nothing else in the server changes at all** —
the same `npm run build && npm start` you run today.

The catch is the split origin: the session cookie needs `sameSite: 'none'` and
`withCredentials` on every request, or `<img src="/uploads/…">` stops loading. Putting the
API on a subdomain of the same registrable domain (`api.oswal.example` + `oswal.example`)
keeps `sameSite: 'lax'` working and avoids it.

**Or a single container** on Render/Railway/Fly serving the built client as static files
from Express, with Supabase for the database only. One service, one origin, no CORS, no
`VITE_API_URL`, uploads on disk. That is the closest thing to what the app was designed for
while still being off the factory machine — and if the goal is "reachable from anywhere"
rather than "on Vercel specifically", it is what I would recommend.

---

## Appendix B — what this costs you

Stated plainly, because these were deliberate properties and the move gives them up:

- **`npm run db:backup` becomes half a backup.** `CLAUDE.md`: *"uploads is copied with it …
  tables alone would restore rows pointing at documents that no longer exist. One record,
  one backup."* Supabase backs up the database; the bucket is your problem.
- **Byte-order collation goes** (§1.5).
- **The login throttle weakens** until §6 is done.
- **Cold starts.** An 18,000-line Express app plus a Prisma client is a slow first request
  after idle — commonly 2–4 seconds. Every subsequent request is fast. A factory floor
  hitting the board all day rarely sees it; the first person in at 8am will.
- **You now depend on the internet.** The current design runs on the factory's own machine
  and keeps working when the line goes down. That was a real property of the architecture,
  and it is the one worth thinking hardest about before moving.
