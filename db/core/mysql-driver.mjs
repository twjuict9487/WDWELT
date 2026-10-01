import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const localRequire = createRequire(import.meta.url);
let mysql;
try {
  mysql = localRequire('mysql2/promise');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND') throw error;
  const databaseDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(databaseDirectory, '..', '..', 'server', 'app', 'server.mjs'),
    resolve(databaseDirectory, '..', '..', 'host', 'server.mjs'),
    resolve(databaseDirectory, '..', '..', 'tools', 'host', 'server.mjs'),
  ];
  let lastError = error;
  for (const candidate of candidates) {
    try { mysql = createRequire(candidate)('mysql2/promise'); break; }
    catch (candidateError) { lastError = candidateError; }
  }
  if (!mysql) throw lastError;
}

export default mysql;

export const DATABASE_TIME_ZONE = '+08:00';

export async function createDatabaseConnection(options) {
  const connection = await mysql.createConnection({ ...options, timezone: DATABASE_TIME_ZONE });
  try {
    await connection.query(`SET time_zone = '${DATABASE_TIME_ZONE}'`);
    return connection;
  } catch (error) {
    await connection.end().catch(() => {});
    throw error;
  }
}

export function createDatabasePool(options) {
  const pool = mysql.createPool({ ...options, timezone: DATABASE_TIME_ZONE });
  pool.on('connection', (connection) => {
    connection.query(`SET time_zone = '${DATABASE_TIME_ZONE}'`, (error) => {
      if (error) connection.destroy();
    });
  });
  return pool;
}
