import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from './mysql-driver.mjs';
import { createApiHandler } from '../g2/host/api.mjs';
import { hashSessionToken } from '../g2/host/auth.mjs';
import { DatabaseManager } from '../g2/host/db.mjs';
import { databaseConnectionOptions, loadDatabaseConfig } from './config.mjs';
import { runMigrations } from './migrate.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configIndex = process.argv.indexOf('--config');
const adminConfigPath = (configIndex >= 0 ? process.argv[configIndex + 1] : process.argv[2]) ?? process.env.WDWELT_DB_ADMIN_CONFIG;
if (!adminConfigPath) throw new Error('Integration test requires an administrative config path');
const admin = loadDatabaseConfig(resolve(adminConfigPath));
const testDatabase = `wdwelt_test_${Date.now()}_${randomBytes(3).toString('hex')}`;
if (!/^wdwelt_test_[a-z0-9_]+$/.test(testDatabase)) throw new Error('Unsafe generated test database name');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'wdwelt db integration '));
const testConfigPath = join(temporaryRoot, 'database.json');
const migrationCopy = join(temporaryRoot, 'migrations');
let created = false;
let database = null;
let server = null;
let recoveryManager = null;
const checks = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); };

function cookieToken(cookie) {
  return cookie?.match(/wdwelt_session=([^;]+)/)?.[1] ?? null;
}

async function api(base, path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  return { response, value, cookie: response.headers.get('set-cookie') };
}

try {
  const recoveryEvents = [];
  recoveryManager = new DatabaseManager({ ...admin, database: testDatabase }, (_level, event) => recoveryEvents.push(event));
  recoveryManager.start();
  assert(await recoveryManager.checkReady() === false, 'database manager reported unavailable before test database existed');
  const adminConnection = await mysql.createConnection(databaseConnectionOptions(admin));
  try {
    await adminConnection.query(`CREATE DATABASE \`${testDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    created = true;
  } finally { await adminConnection.end(); }
  let recovered = false;
  for (let attempt = 0; attempt < 20 && !recovered; attempt += 1) {
    recovered = await recoveryManager.checkReady();
    if (!recovered) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert(recovered && recoveryEvents.includes('db_connect'), 'database manager recovered without a Node restart after MySQL became available');
  await recoveryManager.close();
  recoveryManager = null;
  writeFileSync(testConfigPath, `${JSON.stringify({ ...admin, database: testDatabase, configPath: undefined }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  const setup = await mysql.createConnection(databaseConnectionOptions({ ...admin, database: testDatabase }));
  try {
    await setup.query(`CREATE TABLE users (
      id INT NOT NULL AUTO_INCREMENT,
      username VARCHAR(50) NOT NULL,
      password VARCHAR(255) NOT NULL,
      password_hash VARBINARY(64) NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await setup.execute('INSERT INTO users (username, password, password_hash) VALUES (?, ?, ?)', ['legacy_teacher', '111', Buffer.alloc(64)]);
  } finally { await setup.end(); }

  const firstMigration = await runMigrations({ configPath: testConfigPath });
  assert(firstMigration.applied[0]?.status === 'applied', 'initial migration applied to isolated database');
  assert(firstMigration.applied[0]?.users?.migratedRows === 1, 'legacy user row was preserved and scrypt-migrated');
  const secondMigration = await runMigrations({ configPath: testConfigPath });
  assert(secondMigration.applied[0]?.status === 'already-applied', 'migration rerun was idempotent');

  mkdirSync(migrationCopy);
  const migrationSource = readFileSync(join(projectRoot, 'db/migrations/001_initial.sql'), 'utf8');
  writeFileSync(join(migrationCopy, '001_initial.sql'), `${migrationSource}\n-- checksum mutation test\n`);
  let checksumRejected = false;
  try { await runMigrations({ configPath: testConfigPath, migrationsPath: migrationCopy }); } catch (error) { checksumRejected = /checksum changed/.test(error.message); }
  assert(checksumRejected, 'applied migration checksum changes were rejected');

  database = new DatabaseManager(loadDatabaseConfig(testConfigPath));
  assert(await database.checkReady(), 'temporary database pool became ready');
  const handler = createApiHandler({ database });
  server = createServer(async (request, response) => {
    if (!await handler(request, response)) { response.writeHead(404); response.end(); }
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;

  assert((await api(base, '/api/auth/register', { method: 'POST', body: null })).response.status === 400, 'non-object JSON body returned 400');
  const legacyLogin = await api(base, '/api/auth/login', { method: 'POST', body: { username: 'legacy_teacher', password: '111' } });
  assert(legacyLogin.response.status === 200, 'legacy plaintext credential still logged in after secure migration');
  const registrationA = await api(base, '/api/auth/register', { method: 'POST', body: { username: 'TeacherA', password: '111' } });
  assert(registrationA.response.status === 201, 'password 111 registered successfully');
  const duplicate = await api(base, '/api/auth/register', { method: 'POST', body: { username: ' teachera ', password: '222' } });
  assert(duplicate.response.status === 409, 'duplicate normalized username returned 409');
  const registrationB = await api(base, '/api/auth/register', { method: 'POST', body: { username: 'TeacherB', password: '12345678' } });
  assert(registrationB.response.status === 201, 'second isolated user registered');
  const wrongLogin = await api(base, '/api/auth/login', { method: 'POST', body: { username: 'TeacherA', password: 'wrong' } });
  assert(wrongLogin.response.status === 401, 'wrong password was rejected');
  const loginA = await api(base, '/api/auth/login', { method: 'POST', body: { username: 'TeacherA', password: '111' } });
  const cookieA = loginA.cookie;
  assert(loginA.response.status === 200 && cookieA?.includes('HttpOnly') && cookieA?.includes('SameSite=Strict') && !cookieA?.includes('Secure'), 'login set the LAN-compatible opaque session cookie');
  assert((await api(base, '/api/auth/me')).response.status === 401, 'unauthenticated me returned 401');
  assert((await api(base, '/api/auth/me', { cookie: cookieA })).value.user.username === 'TeacherA', 'session cookie restored current identity');

  const tokenA = cookieToken(cookieA);
  const storedSession = await database.execute('SELECT token_hash FROM sessions WHERE token_hash = ?', [hashSessionToken(tokenA)]);
  assert(storedSession.length === 1 && !Buffer.from(storedSession[0].token_hash).includes(Buffer.from(tokenA)), 'database stored only the session token digest');
  const credentialRows = await database.execute("SELECT COUNT(*) AS plaintextColumn FROM information_schema.columns WHERE table_schema = ? AND table_name = 'users' AND column_name = 'password'", [testDatabase]);
  assert(Number(credentialRows[0].plaintextColumn) === 0, 'plaintext password column no longer existed');

  const timetable = await api(base, '/api/timetable', { method: 'PUT', cookie: cookieA, body: { entries: [
    { weekday: 1, period: 1, className: ' 307 ' }, { weekday: 2, period: 2, className: '307' },
  ] } });
  assert(timetable.response.status === 200 && timetable.value.state.courses.length === 1 && timetable.value.state.timetable.entries.length === 2, 'duplicate class entries reused one course');
  const courseA = timetable.value.state.courses[0].courseId;
  assert((await api(base, `/api/progress/${courseA}`, { method: 'PUT', cookie: cookieA, body: null })).response.status === 400, 'null progress body returned 400 without an internal error');
  const savedProgress = await api(base, `/api/progress/${courseA}`, { method: 'PUT', cookie: cookieA, body: { progress: 'P.61', note: '3-2 未完成' } });
  assert(savedProgress.response.status === 200 && /Z$/.test(savedProgress.value.progress.updatedAt), 'progress used a backend-generated UTC timestamp');
  await api(base, '/api/timetable', { method: 'PUT', cookie: cookieA, body: { entries: [] } });
  assert((await api(base, `/api/progress/${courseA}`, { cookie: cookieA })).value.progress.progress === 'P.61', 'removing timetable entries preserved course progress');

  const loginB = await api(base, '/api/auth/login', { method: 'POST', body: { username: 'TeacherB', password: '12345678' } });
  const cookieB = loginB.cookie;
  assert((await api(base, `/api/progress/${courseA}`, { cookie: cookieB })).response.status === 404, 'user B could not read user A course');
  const meB = await api(base, '/api/auth/me', { cookie: cookieB });
  const userB = meB.value.user.id;
  let crossUserRejected = false;
  try { await database.execute('INSERT INTO timetable_entries (user_id, weekday, period, course_id) VALUES (?, 1, 1, ?)', [userB, courseA]); } catch (error) { crossUserRejected = error.code === 'ER_NO_REFERENCED_ROW_2'; }
  assert(crossUserRejected, 'database constraint rejected cross-user timetable reference');

  await api(base, '/api/timetable', { method: 'PUT', cookie: cookieA, body: { entries: [{ weekday: 1, period: 1, className: '307' }] } });
  await database.query(`CREATE TRIGGER reject_test_period BEFORE INSERT ON timetable_entries FOR EACH ROW
    BEGIN IF NEW.period = 2 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'integration rollback'; END IF; END`);
  const failedReplace = await api(base, '/api/timetable', { method: 'PUT', cookie: cookieA, body: { entries: [{ weekday: 1, period: 2, className: '308' }] } });
  await database.query('DROP TRIGGER reject_test_period');
  const afterFailure = await api(base, '/api/timetable', { cookie: cookieA });
  assert(failedReplace.response.status === 500 && afterFailure.value.state.timetable.entries[0].period === 1, 'failed timetable replacement rolled back completely');

  const logout = await api(base, '/api/auth/logout', { method: 'POST', cookie: cookieA });
  assert(logout.response.status === 200 && (await api(base, '/api/auth/me', { cookie: cookieA })).response.status === 401, 'logout invalidated the original session');
  const secondLoginA = await api(base, '/api/auth/login', { method: 'POST', body: { username: 'TeacherA', password: '111' } });
  const secondTokenA = cookieToken(secondLoginA.cookie);
  await database.execute('UPDATE sessions SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE token_hash = ?', [hashSessionToken(secondTokenA)]);
  assert((await api(base, '/api/auth/me', { cookie: secondLoginA.cookie })).response.status === 401, 'expired session was rejected');

  const [tableCount, migrationCount] = await Promise.all([
    database.execute('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ?', [testDatabase]),
    database.execute('SELECT COUNT(*) AS count FROM schema_migrations'),
  ]);
  assert(Number(tableCount[0].count) === 6 && Number(migrationCount[0].count) === 1, 'migration created five application tables plus schema_migrations');
  console.log(`DB integration passed: ${checks.length} checks in ${testDatabase}`);
  for (const check of checks) console.log(`  PASS ${check}`);
} finally {
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  if (database) await database.close();
  if (recoveryManager) await recoveryManager.close();
  if (created) {
    if (!/^wdwelt_test_[a-z0-9_]+$/.test(testDatabase) || testDatabase === 'g2') throw new Error('Refused unsafe test database cleanup');
    const cleanup = await mysql.createConnection(databaseConnectionOptions(admin));
    try { await cleanup.query(`DROP DATABASE \`${testDatabase}\``); } finally { await cleanup.end(); }
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}
