import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from './mysql-driver.mjs';
import { databaseConnectionOptions, loadDatabaseConfig, protectLocalFile } from './config.mjs';
import { restoreDatabase } from './restore.mjs';

const configIndex = process.argv.indexOf('--config');
const adminConfigPath = (configIndex >= 0 ? process.argv[configIndex + 1] : process.argv[2]) ?? process.env.WDWELT_DB_ADMIN_CONFIG;
if (!adminConfigPath) throw new Error('Restore integration test requires an administrative config path');
const admin = loadDatabaseConfig(resolve(adminConfigPath));
const database = `wdwelt_test_restore_${Date.now()}_${randomBytes(3).toString('hex')}`;
if (!/^wdwelt_test_[a-z0-9_]+$/.test(database)) throw new Error('Unsafe generated restore test database name');
const root = mkdtempSync(join(tmpdir(), 'wdwelt restore integration '));
const configPath = join(root, 'database.json');
const backupPath = join(root, 'fixture.sql');
const wrongDatabaseBackupPath = join(root, 'wrong-database.sql');
const migrationsPath = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');
let created = false;

try {
  const adminConnection = await mysql.createConnection(databaseConnectionOptions(admin));
  try { await adminConnection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`); created = true; }
  finally { await adminConnection.end(); }
  writeFileSync(configPath, `${JSON.stringify({ ...admin, database, configPath: undefined }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  protectLocalFile(configPath);
  writeFileSync(backupPath, `-- MySQL dump isolated restore fixture
-- Current Database: \`${database}\`
USE \`${database}\`;
CREATE TABLE \`users\` (
  id INT NOT NULL AUTO_INCREMENT,
  username VARCHAR(50) NOT NULL,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE restore_marker (value INT NOT NULL);
INSERT INTO restore_marker VALUES (42);
`, 'utf8');
  writeFileSync(wrongDatabaseBackupPath, `-- MySQL dump wrong-database fixture
-- Current Database: \`g2\`
CREATE TABLE \`users\` (id INT NOT NULL);
`, 'utf8');
  let wrongDatabaseRejected = false;
  try { await restoreDatabase({ configPath, backupPath: wrongDatabaseBackupPath, migrationsPath }); }
  catch (error) { wrongDatabaseRejected = /different database/.test(error.message); }
  if (!wrongDatabaseRejected) throw new Error('Restore did not reject a dump for another database');
  const result = await restoreDatabase({ configPath, backupPath, migrationsPath });
  const verification = await mysql.createConnection(databaseConnectionOptions({ ...admin, database }));
  try {
    const [[marker], [migrations], [sessions]] = await Promise.all([
      verification.query('SELECT value FROM restore_marker'),
      verification.query('SELECT COUNT(*) AS count FROM schema_migrations'),
      verification.query('SELECT COUNT(*) AS count FROM sessions'),
    ]);
    if (!result.restored || marker[0]?.value !== 42 || Number(migrations[0].count) !== 1 || Number(sessions[0].count) !== 0) throw new Error('Isolated restore verification failed');
    console.log(`Restore integration passed in ${database}`);
  } finally { await verification.end(); }
} finally {
  if (created) {
    const cleanup = await mysql.createConnection(databaseConnectionOptions(admin));
    try { await cleanup.query(`DROP DATABASE \`${database}\``); } finally { await cleanup.end(); }
  }
  rmSync(root, { recursive: true, force: true });
}
