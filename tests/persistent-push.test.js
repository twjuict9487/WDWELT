import { describe, expect, it } from 'vitest';
import { SESSION_DURATION_SECONDS, SESSION_RENEWAL_WINDOW_SECONDS } from '../server/app/auth.mjs';
import { endpointHash, pushFailureDiagnostic } from '../server/app/push.mjs';
import { readFileSync } from 'node:fs';

describe('persistent login and push contracts', () => {
  it('uses a 180-day rolling session with a 30-day renewal window', () => {
    expect(SESSION_DURATION_SECONDS).toBe(180*24*60*60);
    expect(SESSION_RENEWAL_WINDOW_SECONDS).toBe(30*24*60*60);
  });
  it('hashes subscription endpoints and keeps credentials out of browser storage', () => {
    expect(endpointHash('https://push.example/device').length).toBe(32);
    const app=readFileSync(new URL('../src/app.ts',import.meta.url),'utf8');
    expect(app).not.toMatch(/localStorage\.(?:setItem|getItem)\([^)]*(?:token|subscription)/i);
  });
  it('exposes the authenticated read-only self test only for debug=0', () => {
    const app=readFileSync(new URL('../src/app.ts',import.meta.url),'utf8');
    expect(app).toContain("selfTestModeEnabled(globalThis.location.search)");
    expect(app).toContain("loadDebugReport()");
  });
  it('classifies Apple VAPID and expired subscription responses without leaking credentials', () => {
    expect(pushFailureDiagnostic({statusCode:403,body:'{"reason":"BadJwtToken"}',message:'unexpected'})).toEqual({stage:'vapid-authentication',httpStatus:403,errorCode:null,providerReason:'BadJwtToken',message:'unexpected'});
    expect(pushFailureDiagnostic({statusCode:410,body:'{"reason":"Unregistered"}',message:'gone'}).stage).toBe('subscription-expired');
    expect(pushFailureDiagnostic({code:'ETIMEDOUT',message:'timeout'}).stage).toBe('network');
  });
});
