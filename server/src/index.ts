import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { env } from './env';
import { ApiError, errorHandler } from './lib/http';
import { authenticate, authenticateUpload } from './middleware/auth';
import authRoutes from './routes/auth.routes';
import metaRoutes from './routes/meta.routes';
import usersRoutes from './routes/users.routes';
import mastersRoutes from './routes/masters.routes';
import productsRoutes from './routes/products.routes';
import opsSuppliersRoutes from './routes/ops.suppliers.routes';
import opsOrdersRoutes from './routes/ops.orders.routes';
import opsProductionRoutes from './routes/ops.production.routes';
import manforceRoutes from './routes/manforce.routes';
import suggestRoutes from './routes/suggest.routes';
import salesRoutes from './routes/sales.routes';

const app = express();

/**
 * Only the app's own origins may call the API. Wide-open CORS would let any site a
 * logged-in user visits drive the ERP with their credentials.
 *
 * A disallowed origin is REFUSED with an error rather than answered with `cb(null, false)`.
 * The difference matters: `false` only tells `cors` to omit the `Access-Control-Allow-Origin`
 * header, so the browser discards the *response* — but the handler has already run, and a
 * request that qualifies as "simple" under CORS is never preflighted, so a state-changing
 * POST from an unknown origin would have executed before anything was blocked. Throwing
 * makes the refusal happen before any route.
 */
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin, curl, server-to-server
      if (env.CORS_ORIGINS.includes(origin)) return cb(null, true);
      cb(new ApiError(403, `Origin ${origin} is not allowed to call this API.`));
    },
    credentials: true,
  })
);
// 8 MB rather than 4: a cost sheet with forty lines, a bulk currency import or an order
// edit carrying every line's charges is a big JSON body, and the failure mode was a bare
// "Payload Too Large" with nothing telling anybody which request was too big.
app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'oswal-erp' }));

/**
 * Uploaded product photos and hand-over proof shots are business data, so they are
 * not public files. `<img>` tags cannot send an Authorization header, which is why
 * login also sets an httpOnly cookie — `authenticateUpload` accepts either.
 *
 * `nosniff` stops a file that slipped through as an image from being interpreted as
 * HTML or script, and everything is served as an attachment-safe download rather
 * than being rendered in place.
 */
app.use(
  '/uploads',
  authenticateUpload,
  express.static(path.join(__dirname, '..', 'uploads'), {
    index: false,
    dotfiles: 'deny',
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
      res.setHeader('Cache-Control', 'private, max-age=300');
    },
  })
);

// Each router also applies `authenticate` internally; guarding at the mount as well
// means a route added above that line cannot accidentally be published.
app.use('/api/auth', authRoutes);
app.use('/api/meta', authenticate, metaRoutes);
app.use('/api/users', authenticate, usersRoutes);
app.use('/api', authenticate, mastersRoutes);
app.use('/api/products', authenticate, productsRoutes);
app.use('/api', authenticate, opsSuppliersRoutes);
app.use('/api', authenticate, opsOrdersRoutes);
app.use('/api', authenticate, opsProductionRoutes);
app.use('/api', authenticate, manforceRoutes);
app.use('/api', authenticate, suggestRoutes);
app.use('/api', authenticate, salesRoutes);

app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`\n  Oswal Handicrafts ERP API running at http://localhost:${env.PORT}\n`);
});
