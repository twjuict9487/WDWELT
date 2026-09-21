// Runs against a disposable MySQL instance, never the machine's installed service.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import mysql from '../../db/core/mysql-driver.mjs';
import { writeProtectedJson } from '../../db/core/config.mjs';
import { runPreflight } from '../../db/operations/preflight.mjs';
import { backupDatabase } from '../../db/operations/backup.mjs';
import { runMigrations } from '../../db/operations/migrate.mjs';
import { checkRuntimeDatabase } from '../../db/operations/runtime-check.mjs';

const mysqld = process.argv[2];
if (!mysqld) throw new Error('Provide the installed mysqld.exe path; this test creates its own temporary server.');
const bin = dirname(resolve(mysqld));
const root = mkdtempSync(join(tmpdir(), 'wdwelt-existing-'));
const data = join(root, 'data');
mkdirSync(data);
const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise((done) => listener.close(done));
let server, connection;
const checks = [];
try {
  const initialized = spawnSync(mysqld, ['--no-defaults', '--initialize-insecure', `--basedir=${dirname(bin)}`, `--datadir=${data}`, '--console'], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(initialized.status, 0, initialized.stderr);
  server = spawn(mysqld, ['--no-defaults', `--basedir=${dirname(bin)}`, `--datadir=${data}`, '--bind-address=127.0.0.1', `--port=${port}`, '--mysqlx=0', '--console'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = '';
  server.stderr.on('data', (chunk) => { diagnostics += chunk; });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(diagnostics);
    try { connection = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', connectTimeout: 1000 }); break; }
    catch { await new Promise((done) => setTimeout(done, 250)); }
  }
  assert.ok(connection, 'isolated MySQL started');
  const secret = randomBytes(24).toString('hex');
  await connection.query('CREATE DATABASE g2 CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
  for (const name of ['school_installer', 'school_g2', 'school_readonly']) {
    await connection.query(`CREATE USER '${name}'@'localhost' IDENTIFIED BY '${secret}'`);
  }
  await connection.query("GRANT ALL PRIVILEGES ON g2.* TO 'school_installer'@'localhost'");
  await connection.query("GRANT SELECT, INSERT, UPDATE, DELETE ON g2.* TO 'school_g2'@'localhost'");
  await connection.query("GRANT SELECT ON g2.* TO 'school_readonly'@'localhost'");
  const accountSnapshot = async () => (await connection.query("SELECT User, Host, authentication_string FROM mysql.user WHERE User LIKE 'school_%' ORDER BY User"))[0];
  const before = await accountSnapshot();
  const grantsBefore = (await connection.query("SHOW GRANTS FOR 'school_g2'@'localhost'"))[0];
  const base = { host: '127.0.0.1', port, database: 'g2', password: secret, mysqlDumpPath: join(bin, 'mysqldump.exe'), mysqlClientPath: join(bin, 'mysql.exe') };
  const admin = join(root, 'admin.json'), runtime = join(root, 'runtime.json'), readonly = join(root, 'readonly.json');
  writeProtectedJson(admin, { ...base, user: 'school_installer' });
  writeProtectedJson(runtime, { ...base, user: 'school_g2' });
  writeProtectedJson(readonly, { ...base, user: 'school_readonly' });
  const preflight = await runPreflight(admin);
  assert.equal(preflight.usersSchema.length, 0);
  checks.push('empty g2 preflight with a non-root account and no mysql.user access');
  const emptyBackup = backupDatabase({ configPath: admin, outputDirectory: join(root, 'backups'), label: 'pre-migration' });
  assert.ok(readFileSync(emptyBackup.path, 'utf8').includes('USE `g2`;'));
  checks.push('verified pre-migration backup of an empty database');
  await assert.rejects(checkRuntimeDatabase(runtime, { requireSchema: true }));
  const first = await runMigrations({ configPath: admin });
  assert.equal(first.applied[0].status, 'applied');
  assert.equal((await checkRuntimeDatabase(runtime, { requireSchema: true })).ready, true);
  checks.push('migration and all runtime table read/write permissions with custom account names');
  await assert.rejects(checkRuntimeDatabase(readonly, { requireSchema: true }));
  checks.push('rejects a read-only runtime account');
  await connection.query("INSERT INTO g2.users (username, normalized_username, password_salt, password_hash, password_parameters) VALUES ('preserved-teacher', 'preserved-teacher', RANDOM_BYTES(32), RANDOM_BYTES(64), '{}')");
  const populatedBackup = backupDatabase({ configPath: admin, outputDirectory: join(root, 'backups'), label: 'daily' });
  assert.ok(readFileSync(populatedBackup.path, 'utf8').includes('preserved-teacher'));
  const second = await runMigrations({ configPath: admin });
  assert.equal(second.applied[0].status, 'already-applied');
  assert.deepEqual(await accountSnapshot(), before);
  assert.deepEqual((await connection.query("SHOW GRANTS FOR 'school_g2'@'localhost'"))[0], grantsBefore);
  assert.equal((await connection.query("SELECT COUNT(*) AS count FROM g2.users WHERE username='preserved-teacher'"))[0][0].count, 1);
  checks.push('daily backup and repeat migration preserve data, grants, accounts and passwords');
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  if (connection) {
    try { await connection.query('SHUTDOWN'); } catch { /* the server may close before replying */ }
    await connection.end().catch(() => {});
  }
  if (server && server.exitCode === null) {
    await Promise.race([once(server, 'exit'), new Promise((done) => setTimeout(done, 5000))]);
    if (server.exitCode === null) { server.kill(); await once(server, 'exit'); }
  }
  // root is a freshly created temporary directory owned exclusively by this test.
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\'));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
