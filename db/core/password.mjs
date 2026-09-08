import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const PASSWORD_PARAMETERS = Object.freeze({ algorithm: 'scrypt', N: 16_384, r: 8, p: 1, keyLength: 64 });
export const MAX_USERNAME_LENGTH = 50;
export const MAX_PASSWORD_LENGTH = 256;

export function normalizeUsername(value) {
  if (typeof value !== 'string') throw new Error('帳號格式不正確');
  const username = value.normalize('NFKC').trim();
  if (!username || username.length > MAX_USERNAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(username)) throw new Error(`帳號必須為 1–${MAX_USERNAME_LENGTH} 個字元`);
  return { username, normalizedUsername: username.toLocaleLowerCase('en-US') };
}

export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > MAX_PASSWORD_LENGTH) throw new Error(`密碼必須為 3–${MAX_PASSWORD_LENGTH} 個字元`);
  return value;
}

export async function derivePasswordHash(password, salt = randomBytes(16), parameters = PASSWORD_PARAMETERS) {
  const normalized = { ...PASSWORD_PARAMETERS, ...parameters };
  if (Object.entries(PASSWORD_PARAMETERS).some(([key, value]) => normalized[key] !== value)) throw new Error('不支援的 password parameters');
  const hash = await scrypt(password, salt, normalized.keyLength, { N: normalized.N, r: normalized.r, p: normalized.p, maxmem: 64 * 1024 * 1024 });
  return { salt: Buffer.from(salt), hash: Buffer.from(hash), parameters: normalized };
}

export async function hashPassword(password, salt = randomBytes(16), parameters = PASSWORD_PARAMETERS) {
  validatePassword(password);
  return derivePasswordHash(password, salt, parameters);
}

export async function verifyPassword(password, salt, expectedHash, parameters) {
  try {
    validatePassword(password);
    const computed = await derivePasswordHash(password, Buffer.from(salt), parameters);
    const expected = Buffer.from(expectedHash);
    return computed.hash.length === expected.length && timingSafeEqual(computed.hash, expected);
  } catch { return false; }
}
