import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from '../core/mysql-driver.mjs';
import { databaseConnectionOptions, loadDatabaseConfig } from '../core/config.mjs';
import { derivePasswordHash, normalizeUsername } from '../core/password.mjs';

const dbRoot = dirname(fileURLToPath(import.meta.url));
const defaultMigrationsPath = resolve(dbRoot, '..', 'migrations');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function tableExists(connection, database, table) {
  const [rows] = await connection.execute('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', [database, table]);
  return Number(rows[0].count) > 0;
}

async function columnsFor(connection, database, table) {
  const [rows] = await connection.execute('SELECT COLUMN_NAME AS columnName FROM information_schema.columns WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [database, table]);
  return new Set(rows.map((row) => row.columnName));
}

async function createUsersTable(connection) {
  await connection.query(`CREATE TABLE users (
    id INT NOT NULL AUTO_INCREMENT,
    username VARCHAR(50) NOT NULL,
    normalized_username VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    password_salt VARBINARY(32) NOT NULL,
    password_hash VARBINARY(64) NOT NULL,
    password_parameters JSON NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    timetable_updated_at DATETIME(3) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_normalized_username (normalized_username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
}

async function ensureUsersCompatibility(connection, database) {
  if (!await tableExists(connection, database, 'users')) { await createUsersTable(connection); return { mode: 'created', migratedRows: 0 }; }
  let columns = await columnsFor(connection, database, 'users');
  if (!columns.has('id') || !columns.has('username') || !columns.has('created_at') || (!columns.has('password') && !columns.has('password_hash'))) {
    const legacyName = `users_legacy_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
    await connection.query(`RENAME TABLE users TO \`${legacyName}\``);
    await createUsersTable(connection);
    return { mode: `preserved-as-${legacyName}`, migratedRows: 0 };
  }

  const selectedCredentialColumns = ['password', 'password_salt', 'password_hash', 'password_parameters']
    .map((column) => columns.has(column) ? `\`${column}\`` : `NULL AS \`${column}\``)
    .join(', ');
  const [existingRows] = await connection.query(`SELECT id, username, ${selectedCredentialColumns} FROM users ORDER BY id`);
  const normalizedRows = existingRows.map((row) => ({ ...row, ...normalizeUsername(row.username) }));
  const unique = new Set(normalizedRows.map((row) => row.normalizedUsername));
  if (unique.size !== normalizedRows.length) throw new Error('Existing users normalize to duplicate usernames; no schema changes were applied');
  const migrationPlan = normalizedRows.map((row) => {
    let parameters = row.password_parameters;
    if (typeof parameters === 'string') {
      try { parameters = JSON.parse(parameters); } catch { parameters = null; }
    }
    const validParameters = parameters && Object.entries({ algorithm: 'scrypt', N: 16_384, r: 8, p: 1, keyLength: 64 })
      .every(([key, value]) => parameters[key] === value);
    const secureCredentialComplete = Buffer.isBuffer(row.password_salt) && row.password_salt.length > 0
      && Buffer.isBuffer(row.password_hash) && row.password_hash.length === 64 && validParameters;
    if (!secureCredentialComplete && row.password == null) throw new Error(`User ${row.id} has no recoverable password value; no schema changes were applied`);
    return { row, rehash: !secureCredentialComplete };
  });

  const additions = [
    ['normalized_username', 'ALTER TABLE users ADD COLUMN normalized_username VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER username'],
    ['password_salt', 'ALTER TABLE users ADD COLUMN password_salt VARBINARY(32) NULL AFTER normalized_username'],
    ['password_hash', 'ALTER TABLE users ADD COLUMN password_hash VARBINARY(64) NULL AFTER password_salt'],
    ['password_parameters', 'ALTER TABLE users ADD COLUMN password_parameters JSON NULL AFTER password_hash'],
    ['timetable_updated_at', 'ALTER TABLE users ADD COLUMN timetable_updated_at DATETIME(3) NULL AFTER created_at'],
  ];
  for (const [column, sql] of additions) if (!columns.has(column)) await connection.query(sql);
  columns = await columnsFor(connection, database, 'users');

  let migratedRows = 0;
  for (const { row, rehash } of migrationPlan) {
    if (rehash) {
      const saved = await derivePasswordHash(String(row.password));
      await connection.execute(
        'UPDATE users SET username = ?, normalized_username = ?, password_salt = ?, password_hash = ?, password_parameters = ? WHERE id = ?',
        [row.username, row.normalizedUsername, saved.salt, saved.hash, JSON.stringify(saved.parameters), row.id],
      );
      migratedRows += 1;
    } else {
      await connection.execute('UPDATE users SET username = ?, normalized_username = ? WHERE id = ?', [row.username, row.normalizedUsername, row.id]);
    }
  }
  await connection.query('UPDATE users SET created_at = UTC_TIMESTAMP(3) WHERE created_at IS NULL');
  await connection.query('ALTER TABLE users MODIFY username VARCHAR(50) NOT NULL, MODIFY normalized_username VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, MODIFY password_salt VARBINARY(32) NOT NULL, MODIFY password_hash VARBINARY(64) NOT NULL, MODIFY password_parameters JSON NOT NULL, MODIFY created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)');
  const [indexes] = await connection.query("SHOW INDEX FROM users WHERE Key_name = 'uq_users_normalized_username'");
  if (!indexes.length) await connection.query('ALTER TABLE users ADD UNIQUE KEY uq_users_normalized_username (normalized_username)');
  if (columns.has('password')) await connection.query('ALTER TABLE users DROP COLUMN password');
  return { mode: migratedRows ? 'altered-and-passwords-hashed' : 'compatible', migratedRows };
}

export async function runMigrations({ configPath, migrationsPath = defaultMigrationsPath, log = () => {} }) {
  const config = loadDatabaseConfig(configPath);
  const connection = await mysql.createConnection(databaseConnectionOptions(config, { multipleStatements: true }));
  const lockName = `wdwelt_migrate_${config.database}`;
  let locked = false;
  try {
    const [databaseRows] = await connection.query('SELECT DATABASE() AS databaseName');
    if (databaseRows[0]?.databaseName !== config.database) throw new Error('Connected database differs from migration config');
    const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 10) AS acquired', [lockName]);
    if (Number(lockRows[0].acquired) !== 1) throw new Error('Could not acquire migration lock');
    locked = true;
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id VARCHAR(100) NOT NULL,
      checksum CHAR(64) NOT NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (migration_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    const files = readdirSync(migrationsPath).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    const applied = [];
    for (const migrationId of files) {
      const sql = readFileSync(join(migrationsPath, migrationId), 'utf8').replace(/^\uFEFF/, '');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const [records] = await connection.execute('SELECT checksum FROM schema_migrations WHERE migration_id = ?', [migrationId]);
      if (records.length) {
        if (records[0].checksum !== checksum) throw new Error(`Applied migration checksum changed: ${migrationId}`);
        applied.push({ migrationId, status: 'already-applied' });
        continue;
      }
      log('info', 'migration_start', `Applying ${migrationId}.`);
      const users = migrationId === '001_initial.sql' ? await ensureUsersCompatibility(connection, config.database) : null;
      await connection.query(sql);
      await connection.execute('INSERT INTO schema_migrations (migration_id, checksum) VALUES (?, ?)', [migrationId, checksum]);
      log('info', 'migration_success', `Applied ${migrationId}.`);
      applied.push({ migrationId, status: 'applied', users });
    }
    return { database: config.database, applied };
  } catch (error) {
    log('error', 'migration_failure', 'Migration failed.');
    throw error;
  } finally {
    if (locked) { try { await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]); } catch { /* connection cleanup continues */ } }
    await connection.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = argument('--config') ?? process.env.WDWELT_DB_ADMIN_CONFIG;
  const migrationsPath = argument('--migrations') ?? defaultMigrationsPath;
  if (!configPath) { console.error('需要 --config 或 WDWELT_DB_ADMIN_CONFIG。'); process.exitCode = 1; }
  else runMigrations({ configPath: resolve(configPath), migrationsPath: resolve(migrationsPath), log: (_level, event, message) => console.log(`${event}: ${message}`) })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
