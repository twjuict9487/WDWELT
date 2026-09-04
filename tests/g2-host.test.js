import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestHandler, readRelease, safeStaticPath } from '../g2/host/host-core.mjs';
import { createLogger } from '../g2/host/logger.mjs';

const temporaryDirectories = [];
afterEach(() => { while (temporaryDirectories.length) rmSync(temporaryDirectories.pop(), { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wdwelt-host-'));
  temporaryDirectories.push(root);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><h1>WDWELT</h1>');
  writeFileSync(join(root, 'assets', 'app-abc.js'), 'export default true');
  writeFileSync(join(root, 'build-metadata.json'), JSON.stringify({ releaseLabel: 'G2 Pilot', version: '0.3.0', build: 'test-42', buildTimestamp: '2026-09-02T00:00:00.000Z' }));
  return root;
}

async function withServer(root, operation, health = { checkDatabase: async () => true, currentMigration: async () => '001_initial.sql', databaseStatus: () => ({ lastCheck: '2026-09-03T00:00:00.000Z' }) }) {
  const server = createServer(createRequestHandler({ root, startedAt: Date.now() - 2_500, ...health }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await operation(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

describe('G2 production host', () => {
  it('serves index, hashed assets, SPA routes and exact health metadata', async () => {
    const root = fixture();
    await withServer(root, async (url) => {
      const home = await fetch(url, { headers: { accept: 'text/html' } });
      expect(home.status).toBe(200);
      expect(home.headers.get('cache-control')).toBe('no-store');
      const asset = await fetch(`${url}/assets/app-abc.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('cache-control')).toContain('immutable');
      const route = await fetch(`${url}/settings`, { headers: { accept: 'text/html' } });
      expect(await route.text()).toContain('WDWELT');
      const health = await fetch(`${url}/health`);
      expect(health.headers.get('content-type')).toContain('application/json');
      expect(await health.json()).toMatchObject({ status: 'ok', app: 'ok', database: 'ok', migration: '001_initial.sql', databaseLastCheck: '2026-09-03T00:00:00.000Z', version: '0.3.0', build: 'test-42' });
      const head = await fetch(`${url}/health`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
    });
  });

  it('keeps liveness healthy and reports readiness 503 while MySQL is unavailable', async () => {
    const root = fixture();
    await withServer(root, async (url) => {
      const live = await fetch(`${url}/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toMatchObject({ status: 'ok', version: '0.3.0' });
      const ready = await fetch(`${url}/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ status: 'unavailable', app: 'ok', database: 'unavailable' });
      const full = await fetch(`${url}/health`);
      expect(full.status).toBe(503);
      expect(await full.json()).toMatchObject({ status: 'degraded', app: 'ok', database: 'unavailable' });
    }, { checkDatabase: async () => false, currentMigration: async () => 'unavailable', databaseStatus: () => ({ lastCheck: '2026-09-03T00:00:00.000Z' }) });
  });

  it('does not turn missing assets or health variants into SPA 200', async () => {
    const root = fixture();
    await withServer(root, async (url) => {
      expect((await fetch(`${url}/assets/missing.js`, { headers: { accept: 'text/html' } })).status).toBe(404);
      expect((await fetch(`${url}/health/missing`, { headers: { accept: 'application/json' } })).status).toBe(404);
      expect((await fetch(`${url}/health`, { method: 'POST' })).status).toBe(405);
    });
  });

  it('rejects traversal and fails health when metadata or index is unavailable', async () => {
    const root = fixture();
    expect(safeStaticPath(root, '/../secret.txt')).toBeNull();
    expect(readRelease(root).build).toBe('test-42');
    writeFileSync(join(root, 'build-metadata.json'), '{bad');
    await withServer(root, async (url) => expect((await fetch(`${url}/health`)).status).toBe(500));
  });

  it('reports EADDRINUSE without changing port or stopping the owner', async () => {
    const first = createServer((_request, response) => response.end('owner'));
    await new Promise((resolve) => first.listen(0, '127.0.0.1', resolve));
    const port = first.address().port;
    const second = createServer();
    const error = await new Promise((resolve) => { second.once('error', resolve); second.listen(port, '127.0.0.1'); });
    expect(error.code).toBe('EADDRINUSE');
    expect(first.listening).toBe(true);
    await new Promise((resolve) => first.close(resolve));
  });

  it('rotates only matching WDWELT logs inside its configured directory', () => {
    const directory = fixture();
    const logs = join(directory, 'logs'); mkdirSync(logs);
    const outside = join(directory, 'outside.txt'); writeFileSync(outside, 'keep');
    const active = join(logs, 'wdwelt.jsonl'); appendFileSync(active, 'x'.repeat(100));
    const log = createLogger({ logPath: logs, maxBytes: 50, retentionDays: 14, release: { version: '0.3.0', build: '42' } });
    log('info', 'start', 'test');
    expect(statSync(outside).size).toBe(4);
    expect(statSync(join(logs, 'wdwelt.jsonl')).size).toBeGreaterThan(0);
  });
});
