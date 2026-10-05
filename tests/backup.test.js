import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase, buildMySqlDumpArguments, verifyBackupDump } from '../db/operations/backup.mjs';
import { createTemporaryOptionFile } from '../db/core/mysql-option-file.mjs';

const tables = ['users', 'sessions', 'courses', 'timetable_entries', 'course_progress', 'password_reset_tokens', 'schema_migrations'];
const dump = ({ marker = '-- Dump completed', includedTables = tables } = {}) => [
  'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `g2`;',
  'USE `g2` ;',
  ...includedTables.map((table) => `CREATE TABLE \`${table}\` (id int);`),
  marker,
  '',
].join('\n');

const withTemp = (run) => {
  const root = mkdtempSync(join(tmpdir(), 'wdwelt-backup-test-'));
  try { return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

describe('database backup', () => {
  it('accepts valid mysqldump variants and requires the complete application schema', () => {
    expect(verifyBackupDump(dump()).valid).toBe(true);
    expect(verifyBackupDump('CREATE DATABASE `g2`;\nUSE `g2`;\n-- Dump completed\n', { label: 'pre-migration' }).valid).toBe(true);
    const incomplete = verifyBackupDump(dump({ includedTables: tables.filter((table) => table !== 'schema_migrations') }));
    expect(incomplete.valid).toBe(false);
    expect(incomplete.missing).toContain('tables: schema_migrations');
    expect(verifyBackupDump(dump({ marker: '-- unfinished' })).missing).toContain('completed dump marker');
  });

  it('uses an option file first and does not request routine or event privileges', () => {
    const args = buildMySqlDumpArguments({ database: 'g2' }, 'C:\\Temp\\secure.cnf', 'C:\\Backup\\g2.sql');
    expect(args[0]).toBe('--defaults-extra-file=C:\\Temp\\secure.cnf');
    expect(args).toContain('--databases');
    expect(args.at(-1)).toBe('g2');
    expect(args).not.toContain('--routines');
    expect(args).not.toContain('--events');
  });

  it('keeps shell-special passwords in the protected option file and out of process arguments', () => withTemp((root) => {
    const password = `p!&^%#;='\"\\ with spaces`;
    const option = createTemporaryOptionFile({ host: '127.0.0.1', port: 3306, user: 'school_installer', password });
    try {
      const content = readFileSync(option.optionPath, 'utf8');
      expect(content).toContain('password="p!&^%#;=\'\\"\\\\ with spaces"');
      expect(buildMySqlDumpArguments({ database: 'g2' }, option.optionPath, join(root, 'g2.sql')).join(' ')).not.toContain(password);
    } finally { option.remove(); }
  }));

  it('reports exit code 2, MySQL stderr, admin identity and paths without exposing the password', () => withTemp((root) => {
    const password = 'secret!&^%';
    const configPath = join(root, 'database.admin.json');
    writeFileSync(configPath, JSON.stringify({ host: '127.0.0.1', port: 3306, database: 'g2', user: 'school_installer', password, mysqlDumpPath: process.execPath }));
    expect(() => backupDatabase({
      configPath,
      outputDirectory: join(root, 'backups'),
      spawn: () => ({ status: 2, signal: null, stdout: '', stderr: "mysqldump: Got error: 1044: Access denied for user 'school_installer'" }),
      createOptionFile: () => ({ optionPath: join(root, 'secure.cnf'), remove() {} }),
    })).toThrowError(expect.objectContaining({ message: expect.stringMatching(/exited with code 2[\s\S]*Administrative config:[\s\S]*user=school_installer[\s\S]*1044/) }));
    try { backupDatabase({ configPath, outputDirectory: join(root, 'backups'), spawn: () => ({ status: 2, stderr: '1044 Access denied' }), createOptionFile: () => ({ optionPath: join(root, 'secure.cnf'), remove() {} }) }); }
    catch (error) { expect(error.message).not.toContain(password); }
  }));

  it('removes an unverifiable dump and explains exactly what is missing', () => withTemp((root) => {
    const configPath = join(root, 'database.admin.json');
    writeFileSync(configPath, JSON.stringify({ host: '127.0.0.1', port: 3306, database: 'g2', user: 'admin', password: 'safe', mysqlDumpPath: process.execPath }));
    expect(() => backupDatabase({
      configPath,
      outputDirectory: join(root, 'backups'),
      spawn: (_tool, args) => {
        const output = args.find((arg) => arg.startsWith('--result-file=')).slice('--result-file='.length);
        writeFileSync(output, 'CREATE DATABASE `g2`;\nUSE `g2`;\n');
        return { status: 0, signal: null, stdout: '', stderr: '' };
      },
      createOptionFile: () => ({ optionPath: join(root, 'secure.cnf'), remove() {} }),
    })).toThrow(/Missing: completed dump marker; tables:/);
  }));
});
