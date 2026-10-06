import crypto from 'node:crypto';

const SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
if (!process.env.JWT_SECRET) console.warn('[auth] JWT_SECRET not set - using insecure dev secret');

const b64 = (b) => Buffer.from(b).toString('base64url');
const hmac = (data) => crypto.createHmac('sha256', SECRET).update(data).digest();

export function signJwt(payload, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  return `${head}.${body}.${b64(hmac(`${head}.${body}`))}`;
}

export function verifyJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = hmac(`${parts[0]}.${parts[1]}`);
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return p.exp > Math.floor(Date.now() / 1000) ? p : null;
  } catch { return null; }
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [, salt, hash] = stored.split('$');
  const test = crypto.scryptSync(pw, salt, 32);
  const real = Buffer.from(hash, 'hex');
  return test.length === real.length && crypto.timingSafeEqual(test, real);
}


export const deviceKey = (meterId) => hmac(`device:${meterId}`).toString('hex').slice(0, 40);
