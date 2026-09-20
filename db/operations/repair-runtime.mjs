import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from '../core/mysql-driver.mjs';
import { databaseConnectionOptions, loadDatabaseConfig, writeProtectedJson } from '../core/config.mjs';

export async function repairRuntime({ adminConfigPath, runtimeConfigPath }) {
  const admin = loadDatabaseConfig(adminConfigPath);
  if (admin.database !== 'g2') throw new Error('Runtime repair requires g2.');
  let runtime;
  try { runtime = loadDatabaseConfig(runtimeConfigPath); } catch { /* missing or malformed credentials can be repaired */ }
  if (runtime && runtime.port === admin.port && runtime.database === admin.database) {
    let verification;
    try {
      verification = await mysql.createConnection(databaseConnectionOptions(runtime));
      await verification.query('SELECT 1');
      return { preserved: true, repaired: false };
    } catch (error) {
      // An outage is not evidence that a password should be replaced.
      if (!['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_ACCOUNT_HAS_BEEN_LOCKED', 'ER_MUST_CHANGE_PASSWORD_LOGIN'].includes(error.code)) throw new Error('Runtime database unavailable; credentials preserved.');
    } finally { await verification?.end(); }
  }
  const connection = await mysql.createConnection(databaseConnectionOptions(admin));
  try {
    // This operation owns only the dedicated localhost application account.
    // Other/custom accounts and their grants remain untouched.
    const password = randomBytes(32).toString('base64url');
    await connection.query(`CREATE USER IF NOT EXISTS 'wdwelt_app'@'localhost' IDENTIFIED BY ${connection.escape(password)}`);
    await connection.query(`ALTER USER 'wdwelt_app'@'localhost' IDENTIFIED BY ${connection.escape(password)} ACCOUNT UNLOCK`);
    await connection.query("GRANT SELECT, INSERT, UPDATE, DELETE ON g2.* TO 'wdwelt_app'@'localhost'");
    const replacement = { ...admin, configPath: undefined, user: 'wdwelt_app', password };
    const verification = await mysql.createConnection(databaseConnectionOptions(replacement));
    try { await verification.query('SELECT 1'); } finally { await verification.end(); }
    writeProtectedJson(runtimeConfigPath, replacement);
    return { preserved: false, repaired: true };
  } finally { await connection.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
  const adminConfigPath = option('--admin-config');
  const runtimeConfigPath = option('--runtime-config');
  if (!adminConfigPath || !runtimeConfigPath) { console.error('Administrative and runtime config paths are required.'); process.exitCode = 1; }
  else repairRuntime({ adminConfigPath, runtimeConfigPath }).then((result) => console.log(JSON.stringify(result))).catch(() => {
    console.error('Runtime account repair failed. Check administrative account privileges and MySQL availability.');
    process.exitCode = 1;
  });
}
