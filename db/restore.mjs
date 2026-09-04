import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from './mysql-driver.mjs';
import { databaseConnectionOptions, loadDatabaseConfig } from './config.mjs';
import { runMigrations } from './migrate.mjs';
import { createTemporaryOptionFile } from './mysql-option-file.mjs';

const argument = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };

export async function restoreDatabase({ configPath, backupPath, migrationsPath }) {
  const config = loadDatabaseConfig(configPath);
  const source = resolve(backupPath);
  if (config.database !== 'g2' && !/^wdwelt_test_[a-z0-9_]+$/i.test(config.database)) throw new Error('Restore 只允許 g2 或隔離的 wdwelt_test_* database');
  if (!source.toLowerCase().endsWith('.sql') || !existsSync(source) || !statSync(source).isFile() || statSync(source).size === 0) throw new Error('指定的 backup file 不合法或為空');
  if (!config.mysqlClientPath || !existsSync(config.mysqlClientPath)) throw new Error('找不到 mysql client executable');
  const dump = readFileSync(source, 'utf8').replace(/^\uFEFF/, '');
  if (!dump.startsWith('-- MySQL dump') || !dump.includes('CREATE TABLE `users`')) throw new Error('Backup verification failed; file is not a WDWELT MySQL dump');
  const referencedDatabases = [
    ...[...dump.matchAll(/-- Current Database: `([^`]+)`/g)].map((match) => match[1]),
    ...[...dump.matchAll(/\bUSE\s+`([^`]+)`\s*;/gi)].map((match) => match[1]),
    ...[...dump.matchAll(/\b(?:CREATE|DROP|ALTER)\s+DATABASE(?:\s+\/\*![^*]*\*\/)?(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+`([^`]+)`/gi)].map((match) => match[1]),
  ];
  if (referencedDatabases.some((database) => database.toLocaleLowerCase('en-US') !== config.database.toLocaleLowerCase('en-US'))) {
    throw new Error('Backup references a different database; restore was not started');
  }
  const option = createTemporaryOptionFile(config);
  try {
    await new Promise((resolveRestore, reject) => {
      const child = spawn(config.mysqlClientPath, [`--defaults-extra-file=${option.optionPath}`, '--one-database', `--database=${config.database}`], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      let errorText = '';
      child.stderr.on('data', (chunk) => { if (errorText.length < 16_384) errorText += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolveRestore() : reject(new Error(`mysql restore failed with exit code ${code}: ${errorText.trim()}`)));
      const input = createReadStream(source);
      input.once('error', (error) => { child.kill(); reject(error); });
      input.pipe(child.stdin);
    });
  } finally { option.remove(); }
  const migrations = await runMigrations({ configPath, migrationsPath });
  const connection = await mysql.createConnection(databaseConnectionOptions(config));
  try {
    await connection.query('DELETE FROM sessions');
    await connection.query('SELECT 1');
  } finally { await connection.end(); }
  return { restored: true, backupPath: source, migrations };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = argument('--config');
  const backupPath = argument('--backup');
  const migrationsPath = argument('--migrations');
  if (!configPath || !backupPath || !migrationsPath) { console.error('需要 --config、--backup 與 --migrations。'); process.exitCode = 1; }
  else restoreDatabase({ configPath: resolve(configPath), backupPath: resolve(backupPath), migrationsPath: resolve(migrationsPath) })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
