import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from '../core/mysql-driver.mjs';
import { databaseConnectionOptions, loadDatabaseConfig, writeProtectedJson } from '../core/config.mjs';

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

export async function bootstrapRuntimeUser({ adminConfigPath, runtimeConfigPath }) {
  const admin = loadDatabaseConfig(adminConfigPath);
  if (admin.database !== 'g2') throw new Error('Runtime bootstrap 只允許既有 g2 database');
  const connection = await mysql.createConnection(databaseConnectionOptions(admin));
  let runtimeConfig;
  let createdConfig = false;
  try {
    const [databaseRows] = await connection.query('SELECT DATABASE() AS databaseName');
    if (databaseRows[0]?.databaseName !== 'g2') throw new Error('Administrative connection 未連到 g2');
    const [accounts] = await connection.query("SELECT User, Host FROM mysql.user WHERE User = 'wdwelt_app'");
    const localhostAccount = accounts.find((row) => row.Host === 'localhost');
    const invalidHosts = accounts.filter((row) => row.Host !== 'localhost');
    if (invalidHosts.length) throw new Error('發現非 localhost 的 wdwelt_app account；未自動修改');

    if (existsSync(runtimeConfigPath)) runtimeConfig = loadDatabaseConfig(runtimeConfigPath);
    else if (localhostAccount) throw new Error('wdwelt_app 已存在但缺少可驗證的 runtime credential config；未重設密碼');
    else {
      runtimeConfig = {
        host: '127.0.0.1', port: 3306, database: 'g2', user: 'wdwelt_app',
        password: randomBytes(32).toString('base64url'),
        connectionLimit: 5, connectTimeoutMs: 3000, readyTimeoutMs: 2000,
        reconnectInitialSeconds: 1, reconnectMaxSeconds: 30,
        sessionDurationHours: 12, sessionCleanupMinutes: 60,
        mysqlDumpPath: admin.mysqlDumpPath,
        mysqlClientPath: admin.mysqlClientPath,
      };
      writeProtectedJson(runtimeConfigPath, runtimeConfig);
      createdConfig = true;
    }
    if (runtimeConfig.database !== 'g2' || runtimeConfig.user !== 'wdwelt_app' || !['127.0.0.1', 'localhost', '::1'].includes(runtimeConfig.host)) throw new Error('Runtime database config 不符合 localhost g2/wdwelt_app');
    if (!localhostAccount) {
      await connection.query(`CREATE USER 'wdwelt_app'@'localhost' IDENTIFIED BY ${connection.escape(runtimeConfig.password)}`);
    } else {
      const verification = await mysql.createConnection(databaseConnectionOptions(runtimeConfig, { database: undefined }));
      try { await verification.query('SELECT 1'); } finally { await verification.end(); }
    }
    if (localhostAccount) await connection.query("REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'wdwelt_app'@'localhost'");
    await connection.query("GRANT SELECT, INSERT, UPDATE, DELETE ON `g2`.* TO 'wdwelt_app'@'localhost'");
    const verification = await mysql.createConnection(databaseConnectionOptions(runtimeConfig));
    try { await verification.query('SELECT 1'); } finally { await verification.end(); }
    const [grants] = await connection.query("SHOW GRANTS FOR 'wdwelt_app'@'localhost'");
    return { database: 'g2', account: 'wdwelt_app@localhost', created: !localhostAccount, configCreated: createdConfig, grants: grants.map((row) => Object.values(row)[0]) };
  } finally { await connection.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const adminConfigPath = argument('--admin-config') ?? process.env.WDWELT_DB_ADMIN_CONFIG;
  const runtimeConfigPath = argument('--runtime-config');
  if (!adminConfigPath || !runtimeConfigPath) { console.error('需要 --admin-config 與 --runtime-config path。'); process.exitCode = 1; }
  else bootstrapRuntimeUser({ adminConfigPath: resolve(adminConfigPath), runtimeConfigPath: resolve(runtimeConfigPath) })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
