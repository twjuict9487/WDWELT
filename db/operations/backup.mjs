import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDatabaseConfig, protectLocalFile } from '../core/config.mjs';
import { createTemporaryOptionFile } from '../core/mysql-option-file.mjs';

const argument = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };
const requiredTables = ['users', 'sessions', 'courses', 'timetable_entries', 'course_progress', 'password_reset_tokens', 'schema_migrations'];

const removeIfPresent = (path) => { try { unlinkSync(path); } catch { /* best effort */ } };
const cleanOutput = (value) => String(value ?? '').trim() || '(no output)';

export function buildMySqlDumpArguments(config, optionPath, backupPath) {
  return [
    `--defaults-extra-file=${optionPath}`,
    '--single-transaction', '--triggers', '--no-tablespaces',
    '--set-gtid-purged=OFF', '--default-character-set=utf8mb4',
    `--result-file=${backupPath}`, '--databases', config.database,
  ];
}

export function verifyBackupDump(content, { database = 'g2', label = 'daily' } = {}) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content ?? '');
  const escapedDatabase = database.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasDatabase = new RegExp(`CREATE\\s+DATABASE(?:\\s+[^;\\r\\n]*)?\\s+\`${escapedDatabase}\``, 'i').test(text);
  const hasUse = new RegExp(`USE\\s+\`${escapedDatabase}\`\\s*;`, 'i').test(text);
  const hasCompletionMarker = /^-- Dump completed(?: on .*)?\s*$/im.test(text);
  const tables = new Set([...text.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`([^`]+)`/gi)].map((match) => match[1].toLowerCase()));
  const missing = [];
  if (!text.trim()) missing.push('dump is empty');
  if (!hasDatabase) missing.push(`CREATE DATABASE ${database}`);
  if (!hasUse) missing.push(`USE ${database}`);
  if (!hasCompletionMarker) missing.push('completed dump marker');
  if (!(label === 'pre-migration' && tables.size === 0)) {
    const missingTables = requiredTables.filter((table) => !tables.has(table));
    if (missingTables.length) missing.push(`tables: ${missingTables.join(', ')}`);
  }
  return { valid: missing.length === 0, missing, tables: [...tables] };
}

const failureMessage = ({ result, config, configPath, backupPath, args }) => {
  const cause = result.error
    ? `could not start mysqldump: ${result.error.message}`
    : result.signal
      ? `mysqldump was terminated by signal ${result.signal}`
      : `mysqldump exited with code ${String(result.status)}`;
  const stderr = cleanOutput(result.stderr);
  const accessHint = /(?:1044|1045|access denied|denied to user)/i.test(`${stderr}\n${result.error?.message ?? ''}`)
    ? ' Administrative backup/migration credentials need the required privileges on g2; do not substitute the runtime wdwelt_app account.'
    : '';
  return [
    `${cause}.${accessHint}`,
    `Administrative config: ${resolve(configPath)}`,
    `Connection: user=${config.user} host=${config.host} port=${config.port} database=${config.database}`,
    `mysqldump: ${config.mysqlDumpPath}`,
    `output: ${backupPath}`,
    `arguments: ${args.join(' ')}`,
    `stderr: ${stderr}`,
    `stdout: ${cleanOutput(result.stdout)}`,
  ].join('\n');
};

export function backupDatabase({ configPath, outputDirectory, label = 'daily', retain = 14, spawn = spawnSync, createOptionFile = createTemporaryOptionFile }) {
  const config = loadDatabaseConfig(configPath);
  if (config.database !== 'g2') throw new Error('Production backup must target the g2 database');
  if (!config.mysqlDumpPath || !existsSync(config.mysqlDumpPath)) throw new Error(`mysqldump executable was not found: ${config.mysqlDumpPath ?? '(not configured)'}`);
  const directory = resolve(outputDirectory);
  mkdirSync(directory, { recursive: true });
  const safeLabel = /^[a-z0-9-]+$/i.test(label) ? label : 'manual';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(directory, `g2-${safeLabel}-${stamp}.sql`);
  const option = createOptionFile(config);
  const args = buildMySqlDumpArguments(config, option.optionPath, backupPath);
  try {
    const result = spawn(config.mysqlDumpPath, args, { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) {
      removeIfPresent(backupPath);
      throw new Error(failureMessage({ result, config, configPath, backupPath, args }));
    }
  } finally { option.remove(); }
  try { protectLocalFile(backupPath); }
  catch (error) { removeIfPresent(backupPath); throw error; }
  const content = readFileSync(backupPath);
  const verification = verifyBackupDump(content, { database: config.database, label: safeLabel });
  if (!verification.valid) {
    removeIfPresent(backupPath);
    throw new Error(`Backup verification failed and the invalid dump was removed. Missing: ${verification.missing.join('; ')}`);
  }
  const candidates = readdirSync(directory)
    .filter((name) => /^g2-(daily|manual|pre-restore|pre-migration)-.*\.sql$/.test(name))
    .map((name) => ({ name, path: resolve(directory, name), modified: statSync(resolve(directory, name)).mtimeMs }))
    .filter((item) => item.path.startsWith(`${directory}\\`) || item.path.startsWith(`${directory}/`))
    .sort((a, b) => b.modified - a.modified);
  for (const stale of candidates.slice(Math.max(1, Number(retain) || 14))) unlinkSync(stale.path);
  return { path: backupPath, name: basename(backupPath), bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = argument('--config');
  const outputDirectory = argument('--output');
  const label = argument('--label') ?? 'manual';
  if (!configPath || !outputDirectory) { console.error('Required arguments: --config and --output'); process.exitCode = 1; }
  else {
    try { console.log(JSON.stringify(backupDatabase({ configPath: resolve(configPath), outputDirectory: resolve(outputDirectory), label }), null, 2)); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}
