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
