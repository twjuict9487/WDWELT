import { hashPassword, verifyPassword } from './password.mjs';

export async function recoveryStatus(database) {
  const rows = await database.execute('SELECT updated_at FROM recovery_config WHERE id = 1');
  return { configured: rows.length === 1, updatedAt: rows[0]?.updated_at ?? null };
}

export async function readRecoveryConfig(database, lock = '') {
  const rows = await database.execute(`SELECT password_hash, salt, hash_parameters FROM recovery_config WHERE id = 1${lock}`);
  return rows[0] ?? null;
}

export async function verifyRecoveryPassword(password, row) {
  if (!row) return false;
  const parameters = typeof row.hash_parameters === 'string' ? JSON.parse(row.hash_parameters) : row.hash_parameters;
  return verifyPassword(password, row.salt, row.password_hash, parameters);
}

export async function setRecoveryPassword(database, password, { initializeOnly = false } = {}) {
  const saved = await hashPassword(password);
  return database.transaction(async (transaction) => {
    // Serialize initialization and rotation, including concurrent installers.
    await transaction.execute('INSERT IGNORE INTO recovery_config (id, password_hash, salt, hash_parameters, updated_at) VALUES (1, ?, ?, ?, UTC_TIMESTAMP(3))', [saved.hash, saved.salt, JSON.stringify(saved.parameters)]);
    const current = await readRecoveryConfig(transaction, ' FOR UPDATE');
    if (initializeOnly && !current.password_hash.equals(saved.hash)) return { preserved: true };
    if (!initializeOnly) await transaction.execute('UPDATE recovery_config SET password_hash = ?, salt = ?, hash_parameters = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = 1', [saved.hash, saved.salt, JSON.stringify(saved.parameters)]);
    await transaction.execute('DELETE FROM password_reset_tokens');
    return { preserved: false };
  });
}
