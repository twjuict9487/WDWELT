import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from './mysql-driver.mjs';
import { databaseConnectionOptions, loadDatabaseConfig } from './config.mjs';

const argument = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };

export async function checkRuntimeDatabase(configPath) {
  const config = loadDatabaseConfig(configPath);
  const connection = await mysql.createConnection(databaseConnectionOptions(config));
  try {
    const [rows] = await connection.query('SELECT DATABASE() AS databaseName, 1 AS ready');
    if (rows[0]?.databaseName !== 'g2' || Number(rows[0]?.ready) !== 1) throw new Error('Runtime connection did not reach g2');
    return { database: 'g2', ready: true };
  } finally { await connection.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = argument('--config');
  if (!configPath) { console.error('需要 --config。'); process.exitCode = 1; }
  else checkRuntimeDatabase(resolve(configPath)).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
