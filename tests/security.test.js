import { describe, expect, it } from 'vitest';
import { resetCookie } from '../server/app/recovery.mjs';
import { createApiHandler } from '../server/app/api.mjs';
import {
  applySecurityHeaders,
  assertRequestOrigin,
  createAuthRateLimiter,
  createFixedWindowLimiter,
  createSecurityPolicy,
} from '../server/app/security.mjs';

describe('public HTTPS exposure security', () => {
  const invoke = async (handler, { url, method = 'GET', headers = {} }) => {
    const responseHeaders = new Map();
    let status;
    let body = '';
    const response = {
      setHeader: (name, value) => responseHeaders.set(name.toLowerCase(), value),
      writeHead: (value, values) => { status = value; for (const [name, item] of Object.entries(values ?? {})) responseHeaders.set(name.toLowerCase(), item); },
      end: (value = '') => { body += value.toString(); },
    };
    await handler({ url, method, headers }, response);
    return { status, value: JSON.parse(body), headers: responseHeaders };
  };

  it('keeps LAN behavior and makes Funnel fail closed', () => {
    const lan = createSecurityPolicy({ canonicalUrl: 'http://192.168.0.18:8080', bindAddress: '192.168.0.18' });
    expect(lan).toMatchObject({ exposureMode: 'lan', secureCookies: false, requireSameOrigin: false, allowRegistration: true, allowMasterRecovery: true });

    const funnel = createSecurityPolicy({
      exposureMode: 'tailscale-funnel',
      publicOrigin: 'https://teacher.example-tailnet.ts.net',
      canonicalUrl: 'https://teacher.example-tailnet.ts.net',
      bindAddress: '127.0.0.1',
    });
    expect(funnel).toMatchObject({ secureCookies: true, requireSameOrigin: true, allowRegistration: false, allowMasterRecovery: false, minimumPasswordLength: 12, minimumRecoveryKeyLength: 20 });
    expect(() => createSecurityPolicy({ exposureMode: 'tailscale-funnel', publicOrigin: 'http://teacher.example-tailnet.ts.net', bindAddress: '127.0.0.1' })).toThrow(/HTTPS/);
    expect(() => createSecurityPolicy({ exposureMode: 'tailscale-funnel', publicOrigin: 'https://example.com', bindAddress: '127.0.0.1' })).toThrow(/\.ts\.net/);
    expect(() => createSecurityPolicy({ exposureMode: 'tailscale-funnel', publicOrigin: 'https://teacher.example-tailnet.ts.net', bindAddress: '0.0.0.0' })).toThrow(/127\.0\.0\.1/);
  });

  it('requires the exact HTTPS origin for state-changing Funnel requests', () => {
    const policy = createSecurityPolicy({ exposureMode: 'tailscale-funnel', publicOrigin: 'https://teacher.example-tailnet.ts.net', bindAddress: '127.0.0.1' });
    expect(() => assertRequestOrigin({ method: 'POST', headers: { origin: policy.publicOrigin } }, policy)).not.toThrow();
    expect(() => assertRequestOrigin({ method: 'GET', headers: {} }, policy)).not.toThrow();
    expect(() => assertRequestOrigin({ method: 'POST', headers: {} }, policy)).toThrow(/origin/);
    expect(() => assertRequestOrigin({ method: 'DELETE', headers: { origin: 'https://evil.example' } }, policy)).toThrow(/origin/);
  });

  it('emits HTTPS headers, secure recovery cookies and bounded auth attempts', () => {
    const headers = new Map();
    applySecurityHeaders({ setHeader: (name, value) => headers.set(name.toLowerCase(), value) }, { secureCookies: true });
    expect(headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(resetCookie('token', 600, { secure: true })).toContain('; Secure');

    const limiter = createAuthRateLimiter({ windowMs: 1_000, loginAttempts: 2, recoveryAttempts: 1, globalLoginAttempts: 10, globalRecoveryAttempts: 10, maximumEntries: 20 });
    expect(limiter.allowLogin('Teacher', 0)).toBe(true);
    expect(limiter.allowLogin(' teacher ', 1)).toBe(true);
    expect(limiter.allowLogin('TEACHER', 2)).toBe(false);
    expect(limiter.allowLogin('teacher', 1_001)).toBe(true);
    expect(limiter.allowRecovery('Teacher', 0)).toBe(true);
    expect(limiter.allowRecovery('teacher', 1)).toBe(false);
  });

  it('returns bounded fixed-window decisions with Retry-After timing', () => {
    const limiter=createFixedWindowLimiter({maximumEntries:2});
    expect(limiter.consume('api','client-a',{limit:2,windowMs:60_000},0).allowed).toBe(true);
    expect(limiter.consume('api','client-a',{limit:2,windowMs:60_000},1).allowed).toBe(true);
    expect(limiter.consume('api','client-a',{limit:2,windowMs:60_000},2)).toMatchObject({allowed:false,retryAfter:60});
  });

  it('public-disables registration and master recovery without touching the database', async () => {
    const security = createSecurityPolicy({ exposureMode: 'tailscale-funnel', publicOrigin: 'https://teacher.example-tailnet.ts.net', bindAddress: '127.0.0.1' });
    const handler = createApiHandler({ database: { execute: () => { throw new Error('database must not be called'); } }, security });
    expect(await invoke(handler, { url: '/api/auth/recovery/status' })).toMatchObject({ status: 200, value: { available: false } });
    expect(await invoke(handler, { url: '/api/auth/register', method: 'POST', headers: { origin: security.publicOrigin } })).toMatchObject({ status: 404 });
    expect(await invoke(handler, { url: '/api/auth/recovery/verify', method: 'POST', headers: { origin: security.publicOrigin } })).toMatchObject({ status: 404 });
    expect(await invoke(handler, { url: '/api/auth/login', method: 'POST' })).toMatchObject({ status: 403 });
  });

  it('keeps private account labels behind the privileged role boundary', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../server/app/api.mjs', import.meta.url), 'utf8'));
    expect(source).toContain("if (user.role !== 'privileged') throw new HttpError(403, 'Privileged access required.')");
    expect(source).toContain('SELECT id, username, admin_notes AS private_label FROM users ORDER BY id');
    expect(source).toContain('UPDATE users SET admin_notes=?, account_updated_at=CURRENT_TIMESTAMP(3) WHERE id=?');
    expect(source).not.toContain('SELECT id, username, password_hash, admin_notes AS private_label');
  });

  it('keeps monitoring privileged and makes inactivity detection non-destructive', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../server/app/api.mjs', import.meta.url), 'utf8'));
    expect(source).toContain("url.pathname === '/api/privileged/monitor'");
    expect(source).toContain("if (user.role !== 'privileged') throw new HttpError(403, 'Privileged access required.')");
    expect(source).toContain('automaticDeletion:false');
    expect(source).toContain('UPDATE users SET last_seen_at=CURRENT_TIMESTAMP(3) WHERE id=?');
    expect(source).toContain('lastSeenAt:account.last_seen_at == null ? null');
    expect(source).not.toMatch(/privileged\/monitor[\s\S]{0,6000}DELETE FROM users/);
  });
});
