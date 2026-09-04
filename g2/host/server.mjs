import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequestHandler, readRelease } from './host-core.mjs';
import { createLogger } from './logger.mjs';
import { createApiHandler } from './api.mjs';
import { DatabaseManager, UnavailableDatabaseManager } from './db.mjs';
import { loadDatabaseConfig } from '../../db/config.mjs';

const hostDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(dirname(hostDir));
const requiredMigrationId = '001_initial.sql';
const requiredMigrationSql = readFileSync(resolve(projectRoot, 'db', 'migrations', requiredMigrationId), 'utf8').replace(/^\uFEFF/, '');
const requiredMigrationChecksum = createHash('sha256').update(requiredMigrationSql).digest('hex');
const readJsonFile = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const args = process.argv.slice(2);
const valueAfter = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const configArgument = valueAfter('--config', 'g2/config.development.json');
const configPath = isAbsolute(configArgument) ? configArgument : resolve(projectRoot, configArgument);
const config = readJsonFile(configPath);
const configDirectory = dirname(configPath);
const configuredPath = (value) => isAbsolute(value) ? value : resolve(configDirectory, value);
const installRoot = configuredPath(config.installPath);
const assertWithinInstall = (path, name) => {
  const relation = relative(installRoot, path);
  if (relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relation)) throw new Error(`${name} must remain inside installPath`);
};
const rootArgument = valueAfter('--root', null);
const root = rootArgument
  ? isAbsolute(rootArgument) ? rootArgument : resolve(projectRoot, rootArgument)
  : configuredPath(config.currentPath);
assertWithinInstall(root, 'currentPath');
const port = Number(config.port);
if (port !== 8080) throw new Error('Production port 必須固定為 8080');
for (const key of ['logRetentionDays', 'logMaxBytes']) {
  if (!Number.isFinite(Number(config[key])) || Number(config[key]) <= 0) throw new Error(`${key} 必須大於 0`);
}
const runPath = configuredPath(config.runPath);
assertWithinInstall(runPath, 'runPath');
assertWithinInstall(configuredPath(config.logPath), 'logPath');
mkdirSync(runPath, { recursive: true });
const release = readRelease(root);
const log = createLogger({ logPath: configuredPath(config.logPath), retentionDays: config.logRetentionDays, maxBytes: config.logMaxBytes, release });
const startedAt = Date.now();
let database;
try {
  if (!config.databaseConfigPath) throw new Error('databaseConfigPath missing');
  database = new DatabaseManager(loadDatabaseConfig(configuredPath(config.databaseConfigPath)), log);
} catch {
  database = new UnavailableDatabaseManager({}, log);
}
database.start();
const apiHandler = createApiHandler({ database, log });
const currentMigration = () => database.currentMigration();
const checkApplicationDatabase = async () => {
  if (!await database.checkReady()) return false;
  return database.hasMigration(requiredMigrationId, requiredMigrationChecksum);
};
const staticHandler = createRequestHandler({ root, startedAt, checkDatabase: checkApplicationDatabase, currentMigration, databaseStatus: () => database.status });
const server = createServer(async (request, response) => {
  if (await apiHandler(request, response)) return;
  await staticHandler(request, response);
});
const pidPath = resolve(runPath, 'host.pid.json');
const shutdownRequestPath = resolve(runPath, 'shutdown.request.json');
const controlToken = randomUUID();

server.on('error', (error) => {
  let owner = 'owner 無法確認';
  if (error.code === 'EADDRINUSE' && process.platform === 'win32') {
    try {
      const line = execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
        .split(/\r?\n/).find((entry) => /^\s*TCP\s+\S+:8080\s+\S+\s+LISTENING\s+\d+\s*$/.test(entry));
      const match = line?.match(/LISTENING\s+(\d+)\s*$/);
      if (match) owner = `owner PID ${match[1]}`;
    } catch { /* occupation is still reported without guessing */ }
  }
  const message = error.code === 'EADDRINUSE'
    ? `Port ${port} 已被占用（${owner}）；WDWELT 不會改用其他 port，也不會停止占用程序。請執行 .\\wdwelt.ps1 network 查看占用資訊。`
    : `Host 啟動失敗：${error.message}`;
  log('error', error.code === 'EADDRINUSE' ? 'duplicate_attempt' : 'crash', message);
  console.error(message);
  process.exitCode = 1;
});
server.listen(port, config.bindAddress ?? '0.0.0.0', () => {
  writeFileSync(pidPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date(startedAt).toISOString(), root, configPath, version: release.version, build: release.build, controlToken }, null, 2)}\n`);
  log('info', 'start', `Listening on ${config.bindAddress ?? '0.0.0.0'}:${port}`);
  console.log(`WDWELT ${release.version} build ${release.build} listening on ${config.bindAddress ?? '0.0.0.0'}:${port}`);
});

let closing = false;
const shutdown = (signal) => {
  if (closing) return;
  closing = true;
  log('info', 'stop', `Graceful stop requested (${signal})`);
  server.close(async () => {
    try { await database.close(); } catch { /* process is stopping */ }
    try { unlinkSync(pidPath); } catch { /* stale PID is handled by manager */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
const controlTimer = setInterval(() => {
  if (!existsSync(shutdownRequestPath)) return;
  try {
    const request = readJsonFile(shutdownRequestPath);
    if (request.pid === process.pid && request.controlToken === controlToken) {
      unlinkSync(shutdownRequestPath);
      shutdown('verified-control-request');
    }
  } catch { /* invalid control requests are ignored */ }
}, 500);
controlTimer.unref();
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => { log('error', 'crash', error.message); console.error(error.message); process.exit(1); });
process.on('unhandledRejection', (error) => { log('error', 'crash', String(error)); console.error(error); process.exit(1); });
