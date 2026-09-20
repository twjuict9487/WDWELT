import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const source = (path) => readFileSync(resolve(path), 'utf8').replace(/^\uFEFF/, '');
const sourcesUnder = (path) => readdirSync(resolve(path), { withFileTypes: true }).flatMap((entry) => {
  const child = join(path, entry.name);
  if (entry.isDirectory()) return sourcesUnder(child);
  return /\.(?:html|mjs|ts)$/.test(entry.name) ? [source(child)] : [];
});

describe('G2 source-of-truth and secret boundaries', () => {
  it('keeps timetable and progress persistence out of localStorage', () => {
    const app = source('src/app.ts');
    expect(app).not.toMatch(/\b(?:persistState|loadStateResult|replaceTimetable|updateProgress|restoreProgress)\b/);
    expect(app).toContain("from './api'");
    expect(app).toContain("from './preferences'");
  });

  it('does not accept a client-selected user id in the API client', () => {
    expect(source('src/api.ts')).not.toMatch(/user_?id/i);
  });

  it('keeps credentials out of frontend and VITE configuration', () => {
    const frontend = `${source('src/app.ts')}\n${source('src/api.ts')}\n${source('vite.config.ts')}`;
    expect(frontend).not.toMatch(/VITE_.*(?:PASSWORD|DATABASE|MYSQL)/i);
    expect(frontend).not.toContain('wdwelt_app');
    expect(frontend).not.toMatch(/masterRecoveryKey|recoveryKeyVerifier/);
  });

  it('keeps the weekly overview below the unchanged timeline and routes entries to the existing editor', () => {
    const app = source('src/app.ts');
    const home = app.slice(app.indexOf('function renderHome'), app.indexOf('function autoCenterTimelineCard'));
    expect(home.indexOf('${renderTimeline(timeline, now)}')).toBeLessThan(home.indexOf('${renderWeeklyCourses()}'));
    expect(app).toContain("document.querySelectorAll<HTMLButtonElement>('.weekly-entry')");
    expect(app).toContain("openProgress(courseId, entry.dataset.timeLabel ?? '')");
    expect(app.match(/function renderProgress\(\)/g)).toHaveLength(1);
    expect(source('src/weekly.ts')).not.toMatch(/localStorage|fetch\(|saveProgress/);
  });

  it('keeps recovery host-only and separate from normal session authentication', () => {
    const api = source('server/app/api.mjs');
    const recovery = source('server/app/recovery.mjs');
    expect(api).toContain('readRecoveryConfig');
    expect(api).not.toContain('process.env');
    expect(api).toContain("'/api/auth/recovery/verify'");
    expect(api).toContain("'/api/auth/recovery/reset'");
    expect(recovery).toContain("const cookieName = 'wdwelt_reset'");
    expect(recovery).toContain('Path=/api/auth/recovery');
    expect(source('server/app/auth.mjs')).not.toContain('wdwelt_reset');
    expect(api).not.toMatch(/log\([^\n]*,\s*(?:body|recoveryKey|password|token)\b/);
  });

  it('keeps weekly and recovery controls within the existing mobile layout contract', () => {
    const css = source('src/styles.css');
    const app = source('src/app.ts');
    expect(css).toMatch(/\*\s*\{\s*box-sizing:\s*border-box;/);
    expect(css).toMatch(/\.app-shell\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*520px;[^}]*padding:/s);
    expect(css).toMatch(/input,\s*textarea\s*\{[^}]*width:\s*100%;/s);
    expect(css).toMatch(/\.weekly-entry\s*\{[^}]*width:\s*100%;[^}]*min-height:\s*56px;[^}]*display:\s*flex;/s);
    expect(css).toMatch(/\.weekly-details\s*\{[^}]*min-width:\s*0;/s);
    expect(css).toMatch(/\.weekly-name,\s*\.weekly-progress\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    for (const state of [':hover', ':focus-visible', ':active']) expect(css).toContain(`.weekly-entry${state}`);
    expect(app).toContain("form.dataset.submitting = 'true'");
    expect(app).toContain("field('recovery-key').value = ''");
    expect(app).toContain("authNotice = '密碼已更新，請使用新密碼登入。'");
  });

  it('has no public tunnel, port-forwarding, or external runtime endpoint', () => {
    const runtime = [
      ...sourcesUnder('src'),
      ...sourcesUnder('server/app'),
      ...sourcesUnder('db/core'),
      ...sourcesUnder('db/operations'),
      source('index.html'),
    ].join('\n');

    expect(runtime).not.toMatch(/\b(?:cloudflare|ngrok|tailscale|funnel|upnp|portproxy|port\s*forward|reverse\s*proxy)\b/i);
    expect(runtime).not.toMatch(/https?:\/\/(?!localhost\b|127\.0\.0\.1\b)/i);
    expect(source('src/api.ts')).toContain('fetch(path');
    expect(source('db/operations/bootstrap.mjs')).toContain("host: '127.0.0.1', port: 3306");
  });

  it('keeps host and MySQL listeners scoped to the configured machine', () => {
    const development = JSON.parse(source('config/development.json'));
    const manager = source('install/wdwelt.ps1') + source('install/deployment.ps1');
    const preflight = source('db/operations/preflight.mjs');

    expect(development.bindAddress).toBe('127.0.0.1');
    expect(manager).toContain('bindAddress=$chosen');
    expect(manager).toContain('$listenerMatches');
    expect(manager).toContain('Production network verification failed');
    expect(manager).toContain("$stageName = 'LAN Verification'; Test-Network");
    expect(manager).toContain('$createdProfilesMatch');
    expect(manager).toContain('mysqlx_bind_address');
    expect(manager).toContain("config\\database.runtime.json");
    expect(manager).toContain("config\\database.admin.json");
    expect(manager).toContain('Remove-LegacyInstalledCredentials');
    expect(preflight).toContain('mysqlx_bind_address');
  });
});
