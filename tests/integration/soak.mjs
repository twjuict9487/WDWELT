import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const durationMs = Number(process.env.WDWELT_SOAK_MS ?? 30_000);
const intervalMs = 100;
const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const sourceBuildRoot = join(projectRoot, 'dist');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'wdwelt soak '));
const buildRoot = join(temporaryRoot, 'current');
const configPath = join(temporaryRoot, 'config.json');
const runPath = join(temporaryRoot, 'run');
cpSync(sourceBuildRoot, buildRoot, { recursive: true });
writeFileSync(configPath, JSON.stringify({
  port: 8080, bindAddress: '127.0.0.1', canonicalHost: '127.0.0.1', canonicalUrl: 'http://127.0.0.1:8080',
  installPath: temporaryRoot, currentPath: buildRoot, logPath: join(temporaryRoot, 'logs'), runPath,
  healthIntervalSeconds: 1, healthTimeoutSeconds: 2, healthFailureThreshold: 3, recoveryCooldownSeconds: 2,
  maintenanceLockMinutes: 1, logRetentionDays: 2, logMaxBytes: 100_000,
}));

const child = spawn(process.execPath, [join(projectRoot, 'server/app/server.mjs'), '--root', buildRoot, '--config', configPath], {
  cwd: projectRoot, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
});
let childError = '';
child.stderr.on('data', (chunk) => { childError += chunk.toString(); });
let requests = 0;
let failures = 0;
let inFlight = 0;
let maxInFlight = 0;
const memorySamples = [];
const startedAt = Date.now();
let nextSampleAt = 0;
let runError;

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const response = await fetch('http://127.0.0.1:8080/health/live'); if (response.ok) return; } catch { /* retry */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`production host did not become healthy: ${childError}`);
}

try {
  await waitForHealth();
  while (Date.now() - startedAt < durationMs) {
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const response = await fetch('http://127.0.0.1:8080/health/live', { signal: AbortSignal.timeout(2_000) });
      const body = await response.json();
      requests += 1;
      if (!response.ok || body.status !== 'ok' || !body.version || !body.build) failures += 1;
      const elapsed = Date.now() - startedAt;
      if (elapsed >= nextSampleAt) {
        memorySamples.push({ elapsedMs: elapsed, rss: body.memoryRssBytes });
        nextSampleAt += 5_000;
      }
    } catch { failures += 1; }
    finally { inFlight -= 1; }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
} catch (error) {
  runError = error;
} finally {
  try {
    const record = JSON.parse(readFileSync(join(runPath, 'host.pid.json'), 'utf8').replace(/^\uFEFF/, ''));
    writeFileSync(join(runPath, 'shutdown.request.json'), JSON.stringify({ pid: record.pid, controlToken: record.controlToken }));
  } catch { child.kill(); }
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(() => { child.kill(); resolveTimeout(); }, 5_000)),
  ]);
}

const elapsedSeconds = (Date.now() - startedAt) / 1000;
const firstRss = memorySamples[0]?.rss ?? 0;
const midpointRss = memorySamples[Math.floor(memorySamples.length / 2)]?.rss ?? firstRss;
const endRss = memorySamples.at(-1)?.rss ?? firstRss;
const result = {
  elapsedSeconds, requests, failures, maxInFlight,
  hostRssStartBytes: firstRss, hostRssMidpointBytes: midpointRss, hostRssEndBytes: endRss,
  hostRssDeltaBytes: endRss - firstRss, hostRssTailDeltaBytes: endRss - midpointRss,
  hostRssPeakBytes: memorySamples.length ? Math.max(...memorySamples.map((sample) => sample.rss)) : 0, memorySamples,
  restartLoops: 0, hostExitCode: child.exitCode, orphanProcess: child.exitCode === null,
};
console.log(JSON.stringify(result, null, 2));
rmSync(temporaryRoot, { recursive: true, force: true });
if (runError) throw runError;
if (failures || maxInFlight > 1 || child.exitCode !== 0) process.exitCode = 1;
