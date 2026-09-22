import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApiHandler } from '../server/app/api.mjs';
import { readResetCookie, recoveryKeyVerifier, resetCookie } from '../server/app/recovery.mjs';
import { readSessionCookie } from '../server/app/auth.mjs';

describe('host-only recovery configuration and distinct capability', () => {
  it('fails closed on missing configuration and compares only a host-held digest', () => {
    for (const value of [undefined, '', 'short', 'REPLACE_WITH_HOST_SECRET_VALUE_ONLY']) expect(recoveryKeyVerifier(value)).toBeNull();
    const key = randomBytes(32).toString('base64url');
    const verify = recoveryKeyVerifier(key);
    expect(verify(key)).toBe(true);
    expect(verify(randomBytes(32).toString('base64url'))).toBe(false);
    expect(verify({ toString: () => key })).toBe(false);
  });
  it('uses a restricted cookie path and never authenticates as a normal session', () => {
    const token = randomBytes(32).toString('base64url');
    const cookie = resetCookie(token, 600);
    expect(cookie).toContain('Path=/api/auth/recovery');
    expect(cookie).toContain('Max-Age=600');
    expect(readResetCookie(cookie)).toBe(token);
    expect(readSessionCookie(cookie)).toBeNull();
    expect(readResetCookie(`${cookie}; wdwelt_reset=${token}`)).toBeNull();
    expect(readResetCookie('wdwelt_reset=invalid')).toBeNull();
    expect(resetCookie()).toContain('Max-Age=0');
  });
  it('rejects unconfigured recovery before touching the database and does not leak request data', async () => {
    const handler = createApiHandler({ database: { execute: () => { throw new Error('must not query'); } }, masterRecoveryKey: '' });
    const server = createServer(handler);
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    try {
      for (const endpoint of ['verify', 'reset']) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/recovery/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: '密碼復原尚未設定，請聯絡主機管理者。' });
        expect(response.headers.get('set-cookie') ?? '').not.toContain('wdwelt_session');
      }
    } finally { await new Promise((done) => server.close(done)); }
  });
});
