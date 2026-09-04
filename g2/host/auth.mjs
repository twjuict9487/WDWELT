import { createHash, randomBytes } from 'node:crypto';

export {
  derivePasswordHash,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  normalizeUsername,
  PASSWORD_PARAMETERS,
  validatePassword,
  verifyPassword,
} from '../../db/password.mjs';

export function createSessionToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function readSessionCookie(header) {
  if (typeof header !== 'string') return null;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== 'wdwelt_session') continue;
    const token = pair.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{40,100}$/.test(token) ? token : null;
  }
  return null;
}

export function sessionCookie(token, maxAgeSeconds) {
  return `wdwelt_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie() {
  return 'wdwelt_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
}
