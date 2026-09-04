import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const integer = (value, name, minimum, maximum) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} 設定不合法`);
  return parsed;
};

export function resolveFromConfig(configPath, value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Path 設定不可為空');
  return isAbsolute(value) ? resolve(value) : resolve(dirname(configPath), value);
}

export function loadDatabaseConfig(configPath) {
  const absolutePath = resolve(configPath);
  const raw = JSON.parse(readFileSync(absolutePath, 'utf8').replace(/^\uFEFF/, ''));
  if (!['127.0.0.1', 'localhost', '::1'].includes(raw.host)) throw new Error('Database host 必須限制在 localhost');
  if (raw.database !== 'g2' && !/^wdwelt_test_[a-z0-9_]+$/i.test(raw.database ?? '')) throw new Error('Database name 不在允許範圍');
  if (typeof raw.user !== 'string' || !raw.user || typeof raw.password !== 'string' || !raw.password) throw new Error('Database credential 不完整');
  const config = {
    ...raw,
    configPath: absolutePath,
    port: integer(raw.port ?? 3306, 'port', 1, 65535),
    connectionLimit: integer(raw.connectionLimit ?? 5, 'connectionLimit', 1, 20),
    connectTimeoutMs: integer(raw.connectTimeoutMs ?? 3000, 'connectTimeoutMs', 250, 30_000),
    readyTimeoutMs: integer(raw.readyTimeoutMs ?? 2000, 'readyTimeoutMs', 250, 30_000),
    reconnectInitialSeconds: integer(raw.reconnectInitialSeconds ?? 1, 'reconnectInitialSeconds', 1, 60),
    reconnectMaxSeconds: integer(raw.reconnectMaxSeconds ?? 30, 'reconnectMaxSeconds', 1, 600),
    sessionDurationHours: integer(raw.sessionDurationHours ?? 12, 'sessionDurationHours', 1, 168),
    sessionCleanupMinutes: integer(raw.sessionCleanupMinutes ?? 60, 'sessionCleanupMinutes', 1, 1440),
    mysqlDumpPath: raw.mysqlDumpPath ? resolveFromConfig(absolutePath, raw.mysqlDumpPath) : null,
    mysqlClientPath: raw.mysqlClientPath ? resolveFromConfig(absolutePath, raw.mysqlClientPath) : null,
  };
  if (config.reconnectMaxSeconds < config.reconnectInitialSeconds) throw new Error('reconnectMaxSeconds 不可小於 reconnectInitialSeconds');
  return config;
}

export function databaseConnectionOptions(config, extras = {}) {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectTimeout: config.connectTimeoutMs,
    timezone: 'Z',
    charset: 'utf8mb4',
    ...extras,
  };
}

export function writeProtectedJson(targetPath, value) {
  const absolutePath = resolve(targetPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(temporaryPath, absolutePath);
  try { return protectLocalFile(absolutePath); }
  catch (error) { try { unlinkSync(absolutePath); } catch { /* preserve original ACL error */ } throw error; }
}

export function protectLocalFile(targetPath) {
  const absolutePath = resolve(targetPath);
  try { chmodSync(absolutePath, 0o600); } catch { /* Windows ACL is applied below */ }
  if (process.platform === 'win32') {
    const actualAccount = execFileSync('whoami.exe', { encoding: 'utf8', windowsHide: true }).trim();
    const signedInAccount = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
    const accounts = [...new Set([actualAccount, signedInAccount].filter(Boolean))];
    if (!accounts.length) throw new Error('無法識別目前 Windows account，credential ACL 未套用');
    execFileSync('icacls.exe', [absolutePath, '/inheritance:r', '/grant:r', ...accounts.map((account) => `${account}:F`), '*S-1-5-18:F', '*S-1-5-32-544:F'], { stdio: 'ignore', windowsHide: true });
  }
  return absolutePath;
}
