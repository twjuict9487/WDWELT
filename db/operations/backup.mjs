import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDatabaseConfig, protectLocalFile } from '../core/config.mjs';
import { createTemporaryOptionFile } from '../core/mysql-option-file.mjs';

const argument = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };

export function backupDatabase({ configPath, outputDirectory, label = 'daily', retain = 14 }) {
  const config = loadDatabaseConfig(configPath);
  if (config.database !== 'g2') throw new Error('Production backup 只允許 g2 database');
  if (!config.mysqlDumpPath || !existsSync(config.mysqlDumpPath)) throw new Error('找不到 mysqldump executable');
  const directory = resolve(outputDirectory);
  mkdirSync(directory, { recursive: true });
  const safeLabel = /^[a-z0-9-]+$/i.test(label) ? label : 'manual';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(directory, `g2-${safeLabel}-${stamp}.sql`);
  const option = createTemporaryOptionFile(config);
  try {
    const result = spawnSync(config.mysqlDumpPath, [
      `--defaults-extra-file=${option.optionPath}`,
      '--single-transaction', '--routines', '--events', '--triggers', '--no-tablespaces',
      '--set-gtid-purged=OFF', '--default-character-set=utf8mb4',
      `--result-file=${backupPath}`, '--databases', 'g2',
    ], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`mysqldump failed with exit code ${result.status}: ${(result.stderr ?? '').trim()}`);
  } finally { option.remove(); }
  try { protectLocalFile(backupPath); }
  catch (error) { try { unlinkSync(backupPath); } catch { /* preserve ACL error */ } throw error; }
  const content = readFileSync(backupPath);
  const hasUsers = content.includes(Buffer.from('CREATE TABLE `users`'));
  const hasMigrationLedger = content.includes(Buffer.from('schema_migrations'));
  const hasDatabase = /CREATE DATABASE[^\r\n]*`g2`/.test(content.toString('utf8')) && content.includes(Buffer.from('USE `g2`;'));
  const completeDump = content.includes(Buffer.from('-- Dump completed on '));
  if (!content.length || !hasDatabase || !completeDump || (safeLabel !== 'pre-migration' && (!hasUsers || !hasMigrationLedger))) {
    try { unlinkSync(backupPath); } catch { /* preserve verification error */ }
    throw new Error('Backup verification failed; invalid dump was removed');
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
  if (!configPath || !outputDirectory) { console.error('需要 --config 與 --output。'); process.exitCode = 1; }
  else {
    try { console.log(JSON.stringify(backupDatabase({ configPath: resolve(configPath), outputDirectory: resolve(outputDirectory), label }), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
