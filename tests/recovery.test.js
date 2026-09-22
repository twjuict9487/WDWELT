import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApiHandler } from '../server/app/api.mjs';
import { readResetCookie, resetCookie } from '../server/app/recovery.mjs';
import { readSessionCookie } from '../server/app/auth.mjs';

describe('host-only recovery configuration and distinct capability', () => {
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
  it('returns only availability when the database is unavailable', async () => {
    const events = [];
    const handler = createApiHandler({ database: { execute: () => { throw new Error('private SQL'); } }, log: (...event) => events.push(event) });
    const server = createServer(handler);
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/recovery/status`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ available: false });
      expect(events[0][1]).toBe('recovery_database_error');
      expect(JSON.stringify(events)).not.toContain('private SQL');
    } finally { await new Promise((done) => server.close(done)); }
  });
});
