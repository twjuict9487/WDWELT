import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildCurrentBaseline, migrationChecksum } from '../db/operations/build-baseline.mjs';
import { verifyDumpMigrationLedger } from '../db/operations/restore.mjs';

const migrationsPath = resolve('db/migrations');
const migration004 = readFileSync(resolve(migrationsPath, '004_taipei_timestamps.sql'), 'utf8');
const migrations = ['005_course_lifecycle.sql', '006_persistent_sessions.sql', '007_web_push.sql', '008_developer_admin.sql', '009_session_30_day_cap.sql', '010_last_seen.sql']
  .map((name) => ({ name, sql: readFileSync(resolve(migrationsPath, name), 'utf8') }));
const legacy = `-- MySQL dump fixture
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
CREATE TABLE \`users\` (id INT);
CREATE TABLE \`courses\` (id INT);
CREATE TABLE \`timetable_entries\` (id INT);
CREATE TABLE \`course_progress\` (id INT);
CREATE TABLE \`sessions\` (id INT);
CREATE TABLE \`password_reset_tokens\` (id INT);
CREATE TABLE \`recovery_config\` (id INT);
CREATE TABLE \`schema_migrations\` (migration_id VARCHAR(100), checksum CHAR(64));
INSERT INTO \`schema_migrations\` VALUES ('004_taipei_timestamps.sql','${migrationChecksum(migration004)}');
-- Dump completed on fixture
`;

describe('current database baseline', () => {
  it('combines a migration-004 dump with migrations 005 through 010 and matching ledger checksums', () => {
    const output = buildCurrentBaseline({ sourceText: legacy, migrations });
    for (const migration of migrations) {
      expect(output).toContain(migration.sql.trimEnd());
      expect(output).toContain(`('${migration.name}', '${migrationChecksum(migration.sql)}')`);
    }
    expect(output).toContain('DROP TABLE IF EXISTS `push_deliveries`;');
    expect(output).toContain('DROP TABLE IF EXISTS `push_subscriptions`;');
    expect(output).toContain('DROP TABLE IF EXISTS `developer_audit_log`;');
    expect(verifyDumpMigrationLedger(output, migrationsPath).migrations).toEqual([
      '004_taipei_timestamps.sql',
      '005_course_lifecycle.sql', '006_persistent_sessions.sql', '007_web_push.sql',
      '008_developer_admin.sql', '009_session_30_day_cap.sql', '010_last_seen.sql',
    ]);
  });

  it('rejects a source that already contains development migrations', () => {
    expect(() => buildCurrentBaseline({
      sourceText: `${legacy}\nINSERT INTO \`schema_migrations\` VALUES ('005_course_lifecycle.sql','${'b'.repeat(64)}');`,
      migrations,
    })).toThrow(/already contains migration 005/);
  });

  it('rejects a dump whose recorded migration checksum differs from current code', () => {
    const output = buildCurrentBaseline({ sourceText: legacy, migrations }).replace(
      migrationChecksum(migrations[0].sql), '0'.repeat(64),
    );
    expect(() => verifyDumpMigrationLedger(output, migrationsPath)).toThrow(/checksum does not match/);
  });
});
