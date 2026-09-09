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
  });

  it('expands database-tool wildcards during installation', () => {
    const manager = source('install/wdwelt.ps1');
    expect(manager).not.toMatch(/Copy-Item\s+-LiteralPath\s+\(Join-Path\s+\$package\.Root\s+'db\\\*'\)/);
    expect(manager.match(/Copy-Item\s+-Path\s+\(Join-Path\s+\$package\.Root\s+'db\\\*'\)/g)).toHaveLength(2);
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
    const manager = source('install/wdwelt.ps1');
    const preflight = source('db/operations/preflight.mjs');

    expect(development.bindAddress).toBe('127.0.0.1');
    expect(manager).toContain('bindAddress=$chosen');
    expect(manager).toContain('$listenerMatches');
    expect(manager).toContain('Production network verification failed');
    expect(manager).toContain('& $installedTool network -ConfigPath $installedConfig');
    expect(manager).toContain('$createdProfilesMatch');
    expect(manager).toContain('mysqlx_bind_address');
    expect(manager).toContain("config\\database.runtime.json");
    expect(manager).toContain("config\\database.admin.json");
    expect(manager).toContain('Remove-LegacyInstalledCredentials');
    expect(preflight).toContain('mysqlx_bind_address');
  });
});
