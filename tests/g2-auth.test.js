import { describe, expect, it } from 'vitest';
import {
  clearSessionCookie,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeUsername,
  readSessionCookie,
  sessionCookie,
  validatePassword,
  verifyPassword,
} from '../g2/host/auth.mjs';

describe('G2 authentication primitives', () => {
  it('normalizes usernames consistently and accepts the pilot password 111', () => {
    expect(normalizeUsername('  Ｔeacher307  ')).toEqual({ username: 'Teacher307', normalizedUsername: 'teacher307' });
    expect(validatePassword('111')).toBe('111');
    expect(() => validatePassword('11')).toThrow();
  });

  it('uses unique random salts and verifies through scrypt', async () => {
    const first = await hashPassword('111');
    const second = await hashPassword('111');
    expect(first.salt.equals(second.salt)).toBe(false);
    expect(first.hash.equals(second.hash)).toBe(false);
    expect(await verifyPassword('111', first.salt, first.hash, first.parameters)).toBe(true);
    expect(await verifyPassword('222', first.salt, first.hash, first.parameters)).toBe(false);
    expect(await verifyPassword('111', first.salt, first.hash, { ...first.parameters, N: 1_073_741_824 })).toBe(false);
  });

  it('stores only a digest server-side and emits a strict HttpOnly LAN cookie', () => {
    const { token, tokenHash } = createSessionToken();
    expect(tokenHash.equals(hashSessionToken(token))).toBe(true);
    expect(tokenHash.toString('hex')).not.toContain(token);
    const cookie = sessionCookie(token, 3600);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure');
    expect(readSessionCookie(cookie)).toBe(token);
    expect(clearSessionCookie()).toContain('Max-Age=0');
  });
});
