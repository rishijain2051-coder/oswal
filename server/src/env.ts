import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

/** Secrets shipped in source are not secrets. Refuse to run on a known one. */
const WEAK_SECRETS = new Set(['oswal-dev-secret', 'oswal-dev-secret-change-in-production', 'secret', 'changeme']);

function resolveJwtSecret(): string {
  const supplied = process.env.JWT_SECRET?.trim();

  if (isProd) {
    if (!supplied) {
      throw new Error('JWT_SECRET must be set in production. Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
    }
    if (WEAK_SECRETS.has(supplied) || supplied.length < 32) {
      throw new Error('JWT_SECRET is a placeholder or too short (needs 32+ characters). Anyone holding it can mint valid logins.');
    }
    return supplied;
  }

  if (!supplied || WEAK_SECRETS.has(supplied)) {
    // Random per boot in development: tokens die with the server rather than being
    // signable by anyone who has read the repository.
    const ephemeral = crypto.randomBytes(48).toString('base64url');
    console.warn('[env] JWT_SECRET is unset or a known placeholder — using a random secret for this run, so existing logins are invalidated. Set a real one in server/.env to keep sessions across restarts.');
    return ephemeral;
  }
  return supplied;
}

/**
 * Browser origins allowed to call the API.
 *
 * `CORS_ORIGINS` overrides everything and is what production uses — unset there, NOTHING is
 * allowed, which is the safe direction to fail in.
 *
 * The development fallback covers this machine AND the private network it is on, because one
 * factory runs one server and the floor reads the board on a tablet. It is tempting to think
 * the dev proxy makes this unnecessary — the client calls `/api` relative and Vite forwards it,
 * so surely it is same-origin? It is, and the browser still sends an `Origin` header on a
 * same-origin POST, so the allowlist is still consulted and a tablet at 192.168.1.7 was refused
 * its login while everything worked perfectly on the machine itself.
 *
 * Only PRIVATE ranges are matched, and only in development. A public address never is, so this
 * cannot quietly open the API to the internet if somebody runs a dev server on a cloud box.
 */
const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

export function isAllowedOrigin(origin: string, allowlist: string[]): boolean {
  if (allowlist.includes(origin)) return true;
  if (isProd) return false;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && PRIVATE_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

function resolveOrigins(): string[] {
  const configured = process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean);
  if (configured?.length) return configured;
  return isProd ? [] : ['http://localhost:688', 'http://127.0.0.1:688'];
}

export const env = {
  PORT: parseInt(process.env.PORT || '689', 10),
  JWT_SECRET: resolveJwtSecret(),
  NODE_ENV,
  isProd,
  CORS_ORIGINS: resolveOrigins(),
  /** Sessions last this long; the client silently renews while someone is working. */
  TOKEN_TTL: process.env.TOKEN_TTL || '12h',
};
