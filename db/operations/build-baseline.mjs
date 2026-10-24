import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const migrationNamePattern = /^(?:00[5-9]|010)_.+\.sql$/;
const requiredLegacyTables = ['users', 'courses', 'timetable_entries', 'course_progress', 'sessions', 'password_reset_tokens', 'recovery_config', 'schema_migrations'];

export function migrationChecksum(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

export function buildCurrentBaseline({ sourceText, migrations }) {
  const source = String(sourceText ?? '').replace(/^\uFEFF/, '');
  if (!source.startsWith('-- MySQL dump')) throw new Error('Source is not a MySQL dump.');
  for (const table of requiredLegacyTables) {
    if (!new RegExp('CREATE\\s+TABLE\\s+`' + table + '`', 'i').test(source)) throw new Error(`Source is missing required table: ${table}`);
  }
  const ledger = [...source.matchAll(/\('([^']+\.sql)'\s*,\s*'([a-f0-9]{64})'/gi)].map((match) => match[1]);
  if (!ledger.includes('004_taipei_timestamps.sql')) throw new Error('Source must contain applied migration 004.');
  if (ledger.some((name) => /^(?:00[5-9]|010)_/.test(name))) throw new Error('Source already contains migration 005 or newer.');

  const ordered = [...migrations].sort((left, right) => left.name.localeCompare(right.name));
  if (ordered.length !== 6 || ordered.some((item) => !migrationNamePattern.test(item.name))) {
    throw new Error('Exactly migrations 005 through 010 are required.');
  }
  const expectedPrefixes = ['005_', '006_', '007_', '008_', '009_', '010_'];
  expectedPrefixes.forEach((prefix, index) => {
    if (!ordered[index].name.startsWith(prefix)) throw new Error(`Missing migration ${prefix.slice(0, 3)}.`);
  });

  const withoutCompletion = source
    .replace(/^-- Dump completed(?: on .*)?\s*$/gim, '')
    .trimEnd();
  const resetCurrentOnlyTables = [
    'DROP TABLE IF EXISTS `push_deliveries`;',
    'DROP TABLE IF EXISTS `push_subscriptions`;',
    'DROP TABLE IF EXISTS `developer_audit_log`;',
  ].join('\n');
  const resetAnchor = /(^\/\*!40014 SET @OLD_FOREIGN_KEY_CHECKS=.*FOREIGN_KEY_CHECKS=0 \*\/;\s*$)/im;
  if (!resetAnchor.test(withoutCompletion)) throw new Error('Source does not disable foreign-key checks before replacing tables.');
  const repeatableSource = withoutCompletion.replace(resetAnchor, `$1\n${resetCurrentOnlyTables}`);
  const additions = ordered.map(({ name, sql }) => {
    const normalized = String(sql).replace(/^\uFEFF/, '');
    const checksum = migrationChecksum(normalized);
    return [
      '',
      `-- WDWELT baseline applies ${name}`,
      normalized.trimEnd(),
      `INSERT INTO \`schema_migrations\` (migration_id, checksum) VALUES ('${name}', '${checksum}');`,
    ].join('\n');
  }).join('\n');

  return `${repeatableSource}\n${additions}\n\n-- Dump completed; WDWELT current baseline through 010\n`;
}

export function buildBaselineFile({ sourcePath, outputPath, migrationsPath }) {
  const source = resolve(sourcePath);
  const output = resolve(outputPath);
  const directory = resolve(migrationsPath);
  if (!existsSync(source)) throw new Error(`Source dump not found: ${source}`);
  const migrations = ['005_course_lifecycle.sql', '006_persistent_sessions.sql', '007_web_push.sql', '008_developer_admin.sql', '009_session_30_day_cap.sql', '010_last_seen.sql']
    .map((name) => ({ name, sql: readFileSync(resolve(directory, name), 'utf8') }));
  const result = buildCurrentBaseline({ sourceText: readFileSync(source, 'utf8'), migrations });
  writeFileSync(output, result, { encoding: 'utf8', flag: 'wx' });
  return { output, source: basename(source), bytes: Buffer.byteLength(result), sha256: createHash('sha256').update(result).digest('hex') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourcePath = argument('--source');
  const outputPath = argument('--output');
  const migrationsPath = argument('--migrations') ?? resolve(fileURLToPath(new URL('../migrations', import.meta.url)));
  if (!sourcePath || !outputPath) {
    console.error('Required arguments: --source and --output');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(buildBaselineFile({ sourcePath, outputPath, migrationsPath }), null, 2)); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}
