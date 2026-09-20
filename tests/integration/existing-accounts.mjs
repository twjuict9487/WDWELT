// Runs against a disposable MySQL instance, never the machine's installed service.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
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
import { repairRuntime } from '../../db/operations/repair-runtime.mjs';
import { checkRuntimeDatabase } from '../../db/operations/runtime-check.mjs';
import { testPackagedRecovery } from './packaged-recovery.mjs';

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
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const recoverySecret = randomBytes(24).toString('hex');
  const promptResult = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repository, 'tests/integration/recovery-prompt.ps1'), '-RecoveryScript', join(repository, 'install/recovery.ps1'), '-ConfigPath', admin], {input: JSON.stringify({password: recoverySecret, confirmation: recoverySecret}), encoding: 'utf8', windowsHide: true});
  assert.equal(promptResult.status, 0, promptResult.stdout + promptResult.stderr);
  assert.ok(!(promptResult.stdout + promptResult.stderr).includes(recoverySecret));
  const recoveryBefore = (await connection.query('SELECT * FROM g2.recovery_config'))[0];
  assert.equal(recoveryBefore.length, 1, promptResult.stdout + promptResult.stderr);
  assert.ok(!recoveryBefore[0].password_hash.includes(Buffer.from(recoverySecret)));
  const preserveResult = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repository, 'install/recovery.ps1'), '-Mode', 'initialize', '-NonInteractive', '-ConfigPath', admin], {encoding:'utf8', windowsHide:true});
  assert.equal(preserveResult.status, 0, preserveResult.stdout + preserveResult.stderr);
  assert.ok(preserveResult.stdout.includes('Existing Master Recovery Password preserved.'));
  assert.deepEqual((await connection.query('SELECT * FROM g2.recovery_config'))[0], recoveryBefore);
  checks.push('hidden PowerShell prompt writes only salted hash and noninteractive reinstall preserves it');
  const statusResult = spawnSync(process.execPath, [join(repository, 'db/operations/recovery.mjs'), 'status', '--config', admin], {encoding:'utf8',windowsHide:true});
  assert.equal(statusResult.status, 0);
  assert.match(statusResult.stdout, /^Recovery configured: YES[\r\n]+Last updated: /);
  assert.ok(!statusResult.stdout.includes(recoverySecret) && !statusResult.stdout.includes(recoveryBefore[0].password_hash.toString('hex')));
  const failedSet = spawnSync(process.execPath, [join(repository, 'db/operations/recovery.mjs'), 'set', '--stdin', '--config', admin], {input:JSON.stringify({password:recoverySecret,confirmation:'different'}),encoding:'utf8',windowsHide:true});
  assert.notEqual(failedSet.status, 0);
  assert.deepEqual((await connection.query('SELECT * FROM g2.recovery_config'))[0], recoveryBefore);
  checks.push('CLI status reveals only status/time and mismatched confirmation leaves settings intact');
  const repairBackup = backupDatabase({configPath:admin,outputDirectory:join(root,'backups'),label:'pre-reinstall',retain:1});
  assert.match(repairBackup.name, /^pre-reinstall-\d{8}-\d{6}(?:-\d+)?\.sql$/);
  assert.ok(readFileSync(populatedBackup.path).length && readFileSync(emptyBackup.path).length);
  checks.push('repair backup uses specified filename and preserves existing backups');
  const preservedConfig = readFileSync(runtime);
  assert.equal((await repairRuntime({ adminConfigPath: admin, runtimeConfigPath: runtime })).preserved, true);
  assert.deepEqual(readFileSync(runtime), preservedConfig);
  checks.push('valid custom runtime configuration preserved byte-for-byte');
  const repairAdmin = join(root, 'repair-admin.json');
  writeProtectedJson(repairAdmin, { ...base, user: 'root', password: secret });
  await connection.query(`ALTER USER 'root'@'localhost' IDENTIFIED BY '${secret}'`);
  await connection.query(`ALTER USER 'school_g2'@'localhost' IDENTIFIED BY '${randomBytes(24).toString('hex')}'`);
  assert.equal((await repairRuntime({ adminConfigPath: repairAdmin, runtimeConfigPath: runtime })).repaired, true);
  assert.equal((await checkRuntimeDatabase(runtime, { requireSchema: true })).ready, true);
  assert.deepEqual((await connection.query("SHOW GRANTS FOR 'school_g2'@'localhost'"))[0], grantsBefore);
  checks.push('invalid runtime connection repaired through dedicated localhost account without modifying custom grants');
  await connection.query("ALTER USER 'wdwelt_app'@'localhost' ACCOUNT LOCK");
  assert.equal((await repairRuntime({ adminConfigPath: repairAdmin, runtimeConfigPath: runtime })).repaired, true);
  assert.equal((await checkRuntimeDatabase(runtime, { requireSchema: true })).ready, true);
  assert.deepEqual((await connection.query('SELECT * FROM g2.recovery_config'))[0], recoveryBefore);
  checks.push('locked runtime account repaired without changing recovery configuration');
  await testPackagedRecovery({repository,root,admin:repairAdmin,runtime,password:recoverySecret});
  checks.push('installed package host and CLI verify readiness, recovery and immediate rotation against real isolated MySQL');
  const deployment = spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(repository,'tests/integration/deployment-database.ps1'),'-Repository',repository,'-FixtureRoot',root,'-AdminConfig',repairAdmin,'-RuntimeConfig',runtime],{encoding:'utf8',windowsHide:true,timeout:180_000});
  if (deployment.status !== 0) console.error(deployment.stdout+deployment.stderr);
  assert.equal(deployment.status,0,deployment.stdout+deployment.stderr);
  assert.ok(deployment.stdout.includes('REAL DEPLOYMENT DATABASE INTEGRATION PASSED'));
  assert.match(deployment.stdout,/Application rollback:\s+SUCCESS/);
  checks.push('real installer backs up, reinstalls and restores a healthy previous host after readiness failure');
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
