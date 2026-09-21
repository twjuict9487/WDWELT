import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from '../core/mysql-driver.mjs';
import { databaseConnectionOptions, loadDatabaseConfig } from '../core/config.mjs';
import { recoveryStatus, setRecoveryPassword } from '../core/recovery-config.mjs';

const args = process.argv.slice(2);
const mode = args[0];
const configIndex = args.indexOf('--config');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = configIndex >= 0 ? resolve(args[configIndex + 1]) : resolve(root, 'config/local/database.admin.json');
let database;
let connection;
try {
  if (!['status', 'set', 'initialize'].includes(mode)) throw new Error('Invalid command.');
  connection = await mysql.createConnection(databaseConnectionOptions(loadDatabaseConfig(configPath)));
  database = {
    execute: async (...arguments_) => (await connection.execute(...arguments_))[0],
    transaction: async (operation) => {
      await connection.beginTransaction();
      try { const result = await operation(database); await connection.commit(); return result; }
      catch (error) { await connection.rollback(); throw error; }
    },
  };
  if (mode === 'status') {
    const status = await recoveryStatus(database);
    if (args.includes('--json')) console.log(JSON.stringify(status));
    else {
      console.log(`Recovery configured: ${status.configured ? 'YES' : 'NO'}`);
      console.log(`Last updated: ${status.updatedAt instanceof Date ? status.updatedAt.toISOString() : status.updatedAt ?? '—'}`);
    }
  } else {
    if (!args.includes('--stdin')) throw new Error('Secure input required.');
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 8192) throw new Error('Input too large.');
    }
    const values = JSON.parse(input);
    input = '';
    if (typeof values.password !== 'string' || values.password !== values.confirmation) throw new Error('Passwords do not match.');
    const result = await setRecoveryPassword(database, values.password, { initializeOnly: mode === 'initialize' });
    values.password = values.confirmation = undefined;
    console.log(result.preserved ? 'Recovery configuration found.\nExisting Master Recovery Password preserved.' : 'Recovery configured. Existing reset tokens invalidated.');
  }
} catch {
  console.error('Recovery operation failed. Check database access, migrations and matching passwords (3–256 characters).');
  process.exitCode = 1;
} finally { await connection?.end(); }
