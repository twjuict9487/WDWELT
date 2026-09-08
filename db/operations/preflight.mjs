import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from '../core/mysql-driver.mjs';
import { databaseConnectionOptions, loadDatabaseConfig } from '../core/config.mjs';

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

export async function runPreflight(configPath) {
  const config = loadDatabaseConfig(configPath);
  const connection = await mysql.createConnection(databaseConnectionOptions(config));
  try {
    const output = {};
    for (const [name, sql] of [
      ['database', 'SELECT DATABASE() AS value'],
      ['version', 'SELECT VERSION() AS value'],
      ['currentUser', 'SELECT CURRENT_USER() AS value'],
      ['bindAddress', 'SHOW VARIABLES LIKE "bind_address"'],
      ['tables', 'SHOW TABLES'],
      ['grants', 'SHOW GRANTS'],
    ]) {
      const [rows] = await connection.query(sql);
      output[name] = rows;
    }
    const [usersTables] = await connection.execute('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', [config.database, 'users']);
    if (Number(usersTables[0]?.count) > 0) {
      output.usersSchema = (await connection.query('SHOW CREATE TABLE users'))[0];
      output.usersCount = (await connection.query('SELECT COUNT(*) AS value FROM users'))[0];
    } else {
      output.usersSchema = [];
      output.usersCount = [];
    }
    const [appUsers] = await connection.query("SELECT User, Host, plugin, account_locked FROM mysql.user WHERE User = 'wdwelt_app'");
    output.wdweltAppUsers = appUsers;
    if (appUsers.some((row) => row.Host === 'localhost')) output.wdweltAppGrants = (await connection.query("SHOW GRANTS FOR 'wdwelt_app'@'localhost'"))[0];
    return output;
  } finally { await connection.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = argument('--config') ?? process.env.WDWELT_DB_ADMIN_CONFIG;
  if (!configPath) { console.error('需要 --config 或 WDWELT_DB_ADMIN_CONFIG。'); process.exitCode = 1; }
  else runPreflight(resolve(configPath)).then((output) => console.log(JSON.stringify(output, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
