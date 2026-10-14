import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupDatabase } from './backup.mjs';
import { createDatabaseConnection } from '../core/mysql-driver.mjs';
import { databaseConnectionOptions, loadDatabaseConfig } from '../core/config.mjs';

const valueAfter = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };

export async function integrityReport(adapter) {
  const rows = async (sql) => (await adapter.query(sql))[0];
  const [unreferenced, archivedReferenced, invalidEntries, orphanProgress] = await Promise.all([
    rows(`SELECT c.id, c.user_id AS userId, c.class_name AS className, c.archived_at AS archivedAt,
                 (p.course_id IS NOT NULL) AS hasProgress
            FROM courses c LEFT JOIN timetable_entries t ON t.course_id=c.id AND t.user_id=c.user_id
            LEFT JOIN course_progress p ON p.course_id=c.id
           WHERE t.course_id IS NULL ORDER BY c.user_id,c.id`),
    rows(`SELECT DISTINCT c.id, c.user_id AS userId, c.class_name AS className
            FROM courses c JOIN timetable_entries t ON t.course_id=c.id AND t.user_id=c.user_id
           WHERE c.archived_at IS NOT NULL ORDER BY c.user_id,c.id`),
    rows(`SELECT t.user_id AS userId,t.weekday,t.period,t.course_id AS courseId
            FROM timetable_entries t LEFT JOIN users u ON u.id=t.user_id
            LEFT JOIN courses c ON c.id=t.course_id AND c.user_id=t.user_id
           WHERE u.id IS NULL OR c.id IS NULL`),
    rows(`SELECT p.course_id AS courseId FROM course_progress p LEFT JOIN courses c ON c.id=p.course_id WHERE c.id IS NULL`),
  ]);
  return { dryRun: true, generatedAt: new Date().toISOString(), unreferencedCourses: unreferenced,
    archivedButReferenced: archivedReferenced, invalidTimetableEntries: invalidEntries, orphanProgress,
    safeChanges: { archiveCourses: unreferenced.filter((r) => r.archivedAt == null).length, unarchiveCourses: archivedReferenced.length },
    destructiveChanges: 0 };
}

export async function applySafeRepairs(adapter) {
  await adapter.query(`UPDATE courses c JOIN timetable_entries t ON t.course_id=c.id AND t.user_id=c.user_id SET c.archived_at=NULL WHERE c.archived_at IS NOT NULL`);
  await adapter.query(`UPDATE courses c LEFT JOIN timetable_entries t ON t.course_id=c.id AND t.user_id=c.user_id SET c.archived_at=CURRENT_TIMESTAMP(3) WHERE t.course_id IS NULL AND c.archived_at IS NULL`);
}

async function main() {
  const configPath = valueAfter('--config');
  if (!configPath) throw new Error('Required: --config');
  const apply = process.argv.includes('--apply');
  if (apply && valueAfter('--confirm') !== 'APPLY-INTEGRITY-CLEANUP') throw new Error('Apply requires --confirm APPLY-INTEGRITY-CLEANUP');
  const config = loadDatabaseConfig(resolve(configPath));
  const connection = await createDatabaseConnection(databaseConnectionOptions(config));
  try {
    const before = await integrityReport(connection);
    if (!apply) { console.log(JSON.stringify(before, null, 2)); return; }
    const output = valueAfter('--backup-output');
    if (!output) throw new Error('Apply requires --backup-output; no changes were made');
    const backup = backupDatabase({ configPath: resolve(configPath), outputDirectory: resolve(output), label: 'manual' });
    await connection.beginTransaction();
    try { await applySafeRepairs(connection); await connection.commit(); }
    catch (error) { await connection.rollback(); throw error; }
    console.log(JSON.stringify({ applied: true, backup, before, after: await integrityReport(connection) }, null, 2));
  } finally { await connection.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
