import { createHash, timingSafeEqual } from 'node:crypto';

export const RESET_SECONDS = 10 * 60;
const cookieName = 'wdwelt_reset';
const digest = (value) => createHash('sha256').update(value, 'utf8').digest();

// The host reads this once at startup. Only its digest is retained by the API.
export function recoveryKeyVerifier(value) {
  if (typeof value !== 'string' || value.length < 32 || value.startsWith('REPLACE_')) return null;
  const expected = digest(value);
  return (candidate) => typeof candidate === 'string' && candidate.length <= 4096
    && timingSafeEqual(expected, digest(candidate));
}

export function resetCookie(token = '', seconds = 0) {
  return `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/api/auth/recovery; Max-Age=${seconds}`;
}

export function readResetCookie(header) {
  if (typeof header !== 'string') return null;
  const values = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
