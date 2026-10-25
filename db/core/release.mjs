import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function createReleaseSchema(directory, applicationVersion) {
  if (!/^\d+\.\d+\.\d+$/.test(applicationVersion)) throw new Error('Expected a numeric application version.');
  const files = readdirSync(directory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));
  if (!files.length) throw new Error('No schema migrations found.');
  const migrations = files.map((id, index) => {
    if (Number(id.split('_')[0]) !== index + 1) throw new Error('Schema migrations must be contiguous from 001.');
    const sql = readFileSync(join(directory, id), 'utf8').replace(/^\uFEFF/, '');
    return { id, checksum: createHash('sha256').update(sql).digest('hex'), sql };
  });
  const schemaVersion = String(migrations.length).padStart(4, '0');
  const version = `${applicationVersion.split('.').slice(0, 2).join('.')}.${schemaVersion}`;
  const manifest = { version, applicationVersion, schemaVersion, migrations: migrations.map(({ id, checksum }) => ({ id, checksum })) };
  // No account exports, DROP statements, or automatic import. Only for a NEW empty schema.
  const sql = [
    `-- WDWELT ${version}: NEW EMPTY DATABASE ONLY. Existing hosts must use setup/upgrade.`,
    '-- Contains schema only; no production users, credentials, or personal data.',
    'SET NAMES utf8mb4;',
    'CREATE TABLE schema_migrations (migration_id VARCHAR(100) NOT NULL PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;',
    ...migrations.map(({ id, checksum, sql: migration }) => `-- ${id}\n${migration.trimEnd()}\nINSERT INTO schema_migrations (migration_id, checksum) VALUES ('${id}', '${checksum}');`),
  ].join('\n\n') + '\n';
  return { manifest, sql };
}
