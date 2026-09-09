import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from '../core/mysql-driver.mjs';
import { databaseConnectionOptions, loadDatabaseConfig } from '../core/config.mjs';

const argument = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };

export async function checkRuntimeDatabase(configPath, { requireSchema = false } = {}) {
  const config = loadDatabaseConfig(configPath);
  const connection = await mysql.createConnection(databaseConnectionOptions(config));
  try {
    const [rows] = await connection.query('SELECT DATABASE() AS databaseName, 1 AS ready');
    if (rows[0]?.databaseName !== 'g2' || Number(rows[0]?.ready) !== 1) throw new Error('Runtime connection did not reach g2');
    if (requireSchema) {
      for (const [table, column] of [['users', 'id'], ['sessions', 'user_id'], ['courses', 'id'], ['timetable_entries', 'user_id'], ['course_progress', 'course_id']]) {
        await connection.query(`SELECT * FROM \`${table}\` LIMIT 0`);
        await connection.query(`EXPLAIN INSERT INTO \`${table}\` (\`${column}\`) VALUES (1)`);
        await connection.query(`EXPLAIN UPDATE \`${table}\` SET \`${column}\` = \`${column}\` WHERE 1 = 0`);
        await connection.query(`EXPLAIN DELETE FROM \`${table}\` WHERE 1 = 0`);
      }
      await connection.query('SELECT migration_id, checksum FROM schema_migrations LIMIT 0');
    }
    return { database: 'g2', ready: true };
  } finally { await connection.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = argument('--config');
  if (!configPath) { console.error('需要 --config。'); process.exitCode = 1; }
  else checkRuntimeDatabase(resolve(configPath), { requireSchema: process.argv.includes('--require-schema') }).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
