import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../env';

/**
 * What the token carries. Deliberately NOT the user's permissions or role: those are
 * resolved from the database on every request (`lib/access.ts`) so that revoking access
 * takes effect on the next click rather than whenever a twelve-hour token happens to
 * expire. The token answers "who signed in", nothing more.
 */
export interface JwtPayload {
  sub: number;
  name: string;
  email: string;
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.TOKEN_TTL as jwt.SignOptions['expiresIn'] });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_SECRET) as unknown as JwtPayload;
}
