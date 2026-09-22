import {
  clearSessionCookie,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeUsername,
  readSessionCookie,
  sessionCookie,
  SESSION_DURATION_SECONDS,
  validatePassword,
  verifyPassword,
} from './auth.mjs';
import { DatabaseUnavailableError } from './db.mjs';
import { readResetCookie, resetCookie, RESET_SECONDS } from './recovery.mjs';

import { readRecoveryConfig, recoveryStatus, verifyRecoveryPassword } from '../../db/core/recovery-config.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_CLASS_NAME = 20;
const MAX_PROGRESS = 120;
const MAX_NOTE = 300;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(response, status, body, headers = {}) {
  const content = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': content.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(content);
}

async function readJson(request) {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'Request body 過大');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body 過大');
    chunks.push(chunk);
  }
  if (!chunks.length) throw new HttpError(400, '缺少 JSON body');
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch { throw new HttpError(400, 'JSON body 格式不正確'); }
}

const normalizeClassName = (value) => {
  if (typeof value !== 'string') throw new HttpError(400, '班級格式不正確');
  const className = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!className || className.length > MAX_CLASS_NAME) throw new HttpError(400, `班級必須為 1–${MAX_CLASS_NAME} 個字元`);
  return { className, normalizedClassName: className.toLocaleLowerCase('zh-Hant') };
};

const iso = (value) => value instanceof Date ? value.toISOString() : new Date(`${value}Z`.replace('ZZ', 'Z')).toISOString();

async function authenticatedUser(request, database) {
  const token = readSessionCookie(request.headers.cookie);
  if (!token) throw new HttpError(401, '請先登入');
  const rows = await database.execute(
    `SELECT u.id, u.username, s.expires_at AS session_expires_at, UTC_TIMESTAMP(3) AS server_time
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3)
      LIMIT 1`,
    [hashSessionToken(token)],
  );
  if (!rows.length) throw new HttpError(401, 'Session 已失效，請重新登入');
  return { id: Number(rows[0].id), username: rows[0].username, token, expiresAt: iso(rows[0].session_expires_at), serverTime: iso(rows[0].server_time) };
}

async function loadState(database, userId, adapter = database) {
  const users = await adapter.execute('SELECT timetable_updated_at FROM users WHERE id = ?', [userId]);
  const courseRows = await adapter.execute(
    `SELECT c.id, c.class_name, p.progress, p.note, p.updated_at
       FROM courses c LEFT JOIN course_progress p ON p.course_id = c.id
      WHERE c.user_id = ? ORDER BY c.id`,
    [userId],
  );
  const entryRows = await adapter.execute(
    'SELECT weekday, period, course_id FROM timetable_entries WHERE user_id = ? ORDER BY weekday, period',
    [userId],
  );
  const courses = courseRows.map((row) => ({ courseId: String(row.id), className: row.class_name }));
  const progressByCourse = {};
  for (const row of courseRows) {
    if (row.updated_at == null) continue;
    const courseId = String(row.id);
    progressByCourse[courseId] = { courseId, progress: row.progress, note: row.note, updatedAt: iso(row.updated_at) };
  }
  const timetableUpdatedAt = users[0]?.timetable_updated_at;
  return {
    version: 2,
    timetable: timetableUpdatedAt == null ? null : {
      timezone: 'Asia/Taipei',
      entries: entryRows.map((row) => ({ weekday: Number(row.weekday), period: Number(row.period), courseId: String(row.course_id) })),
      updatedAt: iso(timetableUpdatedAt),
    },
    courses,
    progressByCourse,
  };
}

function validateTimetableBody(body) {
  if (!body || !Array.isArray(body.entries) || body.entries.length > 40) throw new HttpError(400, '課表 entries 格式不正確');
  const positions = new Set();
  return body.entries.map((entry) => {
    if (!entry || !Number.isInteger(entry.weekday) || entry.weekday < 1 || entry.weekday > 5 || !Number.isInteger(entry.period) || entry.period < 1 || entry.period > 8) throw new HttpError(400, '課表包含無效星期或節次');
    const position = `${entry.weekday}:${entry.period}`;
    if (positions.has(position)) throw new HttpError(400, '同一課表位置不可重複');
    positions.add(position);
    return { weekday: entry.weekday, period: entry.period, ...normalizeClassName(entry.className) };
  });
}

export function createApiHandler({ database, log = () => {} }) {
  const sessionSeconds = SESSION_DURATION_SECONDS;
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;
    try {
      if (url.pathname === '/api/auth/recovery/status' && request.method === 'GET') {
        const status = await recoveryStatus(database);
        if (!status.configured) log('warning', 'recovery_config_missing', 'Recovery configuration missing.');
        sendJson(response, 200, { available: status.configured });
        return true;
      }
      if (url.pathname === '/api/auth/recovery/verify' && request.method === 'POST') {
        response.setHeader('Set-Cookie', resetCookie());
        const body = await readJson(request);
        const token = await database.transaction(async (transaction) => {
          const config = await readRecoveryConfig(transaction, ' FOR SHARE');
          if (!config) {
            log('warning', 'recovery_config_missing', 'Recovery configuration missing.');
            throw new HttpError(503, '密碼復原尚未設定，請聯絡主機管理者。');
          }
          const rejected = () => {
            log('warning', 'recovery_verify_failed', 'Recovery verification rejected.');
            return new HttpError(401, '帳號或復原密碼不正確。');
          };
          let normalized;
          try { normalized = normalizeUsername(body.username); } catch { throw rejected(); }
          const matches = await verifyRecoveryPassword(body.recoveryKey, config);
          const accounts = await transaction.execute('SELECT id FROM users WHERE normalized_username = ? LIMIT 1', [normalized.normalizedUsername]);
          if (!matches || !accounts.length) throw rejected();
          const capability = createSessionToken();
          await transaction.execute('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND), UTC_TIMESTAMP(3))', [capability.tokenHash, accounts[0].id, RESET_SECONDS]);
          return capability.token;
        });
        log('info', 'recovery_verified', 'Password recovery verified.');
        sendJson(response, 200, { resetAllowed: true }, { 'Set-Cookie': resetCookie(token, RESET_SECONDS) });
        return true;
      }

      if (url.pathname === '/api/auth/recovery/reset' && request.method === 'POST') {
        const token = readResetCookie(request.headers.cookie);
        const invalid = () => {
          log('warning', 'recovery_token_invalid', 'Recovery token rejected.');
          return new HttpError(401, '密碼重設驗證已失效，請重新驗證。');
        };
        if (!token) throw invalid();
        const tokenHash = hashSessionToken(token);
        const capabilities = await database.execute('SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP(3)', [tokenHash]);
        if (!capabilities.length) throw invalid();
        const body = await readJson(request);
        let password;
        try { password = validatePassword(body.password); }
        catch { throw new HttpError(400, '密碼必須為 3–256 個字元。'); }
        const saved = await hashPassword(password);
        await database.transaction(async (transaction) => {
          if (!await readRecoveryConfig(transaction, ' FOR SHARE')) throw invalid();
          const userId = capabilities[0].user_id;
          // A user lock serializes resets, including different tokens for the same account.
          const users = await transaction.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
          const valid = await transaction.execute('SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND user_id = ? AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE', [tokenHash, userId]);
          if (!users.length || !valid.length) throw invalid();
          await transaction.execute('UPDATE users SET password_salt = ?, password_hash = ?, password_parameters = ? WHERE id = ?', [saved.salt, saved.hash, JSON.stringify(saved.parameters), userId]);
          await transaction.execute('DELETE FROM password_reset_tokens WHERE user_id = ?', [userId]);
          await transaction.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
        });
        log('info', 'recovery_reset_success', 'Password reset completed.');
        sendJson(response, 200, { reset: true }, { 'Set-Cookie': [resetCookie(), clearSessionCookie()] });
        return true;
      }

      if (url.pathname === '/api/auth/register' && request.method === 'POST') {
        const body = await readJson(request);
        const { username, normalizedUsername } = normalizeUsername(body.username);
        const password = validatePassword(body.password);
        const saved = await hashPassword(password);
        try {
          await database.execute(
            'INSERT INTO users (username, normalized_username, password_salt, password_hash, password_parameters) VALUES (?, ?, ?, ?, ?)',
            [username, normalizedUsername, saved.salt, saved.hash, JSON.stringify(saved.parameters)],
          );
        } catch (error) {
          if (error?.code === 'ER_DUP_ENTRY') throw new HttpError(409, '此帳號已存在');
          throw error;
        }
        log('info', 'register_success', 'Account registered.');
        sendJson(response, 201, { created: true, username });
        return true;
      }

      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        const body = await readJson(request);
        let normalized;
        try { normalized = normalizeUsername(body.username); validatePassword(body.password); }
        catch { throw new HttpError(401, '帳號或密碼錯誤'); }
        const rows = await database.execute('SELECT id, username, password_salt, password_hash, password_parameters FROM users WHERE normalized_username = ? LIMIT 1', [normalized.normalizedUsername]);
        const account = rows[0];
        const parameters = account ? (typeof account.password_parameters === 'string' ? JSON.parse(account.password_parameters) : account.password_parameters) : null;
        if (!account || !await verifyPassword(body.password, account.password_salt, account.password_hash, parameters)) {
          log('warning', 'login_failure', 'Login rejected.');
          throw new HttpError(401, '帳號或密碼錯誤');
        }
        const { token, tokenHash } = createSessionToken();
        await database.execute('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND))', [tokenHash, account.id, sessionSeconds]);
        const [session] = await database.execute('SELECT expires_at, UTC_TIMESTAMP(3) AS server_time FROM sessions WHERE token_hash = ?', [tokenHash]);
        log('info', 'login_success', 'Login succeeded.');
        sendJson(response, 200, { authenticated: true, user: { id: Number(account.id), username: account.username }, expiresAt: iso(session.expires_at), serverTime: iso(session.server_time) }, { 'Set-Cookie': sessionCookie(token, sessionSeconds) });
        return true;
      }

      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        const token = readSessionCookie(request.headers.cookie);
        if (token) await database.execute('DELETE FROM sessions WHERE token_hash = ?', [hashSessionToken(token)]);
        log('info', 'logout', 'Session logged out.');
        sendJson(response, 200, { authenticated: false }, { 'Set-Cookie': clearSessionCookie() });
        return true;
      }

      if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        const user = await authenticatedUser(request, database);
        sendJson(response, 200, { authenticated: true, user: { id: user.id, username: user.username }, expiresAt: user.expiresAt, serverTime: user.serverTime });
        return true;
      }

      const user = await authenticatedUser(request, database);
      if (url.pathname === '/api/timetable' && request.method === 'GET') {
        sendJson(response, 200, { state: await loadState(database, user.id) });
        return true;
      }
      if (url.pathname === '/api/timetable' && request.method === 'PUT') {
        const entries = validateTimetableBody(await readJson(request));
        const state = await database.transaction(async (transaction) => {
          const savedEntries = [];
          for (const entry of entries) {
            const result = await transaction.execute(
              `INSERT INTO courses (user_id, class_name, normalized_class_name) VALUES (?, ?, ?)
               ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), class_name = VALUES(class_name)`,
              [user.id, entry.className, entry.normalizedClassName],
            );
            savedEntries.push({ ...entry, courseId: Number(result.insertId) });
          }
          await transaction.execute('DELETE FROM timetable_entries WHERE user_id = ?', [user.id]);
          for (const entry of savedEntries) await transaction.execute('INSERT INTO timetable_entries (user_id, weekday, period, course_id) VALUES (?, ?, ?, ?)', [user.id, entry.weekday, entry.period, entry.courseId]);
          await transaction.execute('UPDATE users SET timetable_updated_at = UTC_TIMESTAMP(3) WHERE id = ?', [user.id]);
          return loadState(database, user.id, transaction);
        });
        sendJson(response, 200, { state });
        return true;
      }
      if (url.pathname === '/api/timetable' && request.method === 'DELETE') {
        const state = await database.transaction(async (transaction) => {
          await transaction.execute('DELETE FROM timetable_entries WHERE user_id = ?', [user.id]);
          await transaction.execute('UPDATE users SET timetable_updated_at = NULL WHERE id = ?', [user.id]);
          return loadState(database, user.id, transaction);
        });
        sendJson(response, 200, { state });
        return true;
      }
      if (url.pathname === '/api/courses' && request.method === 'GET') {
        const rows = await database.execute('SELECT id, class_name FROM courses WHERE user_id = ? ORDER BY id', [user.id]);
        sendJson(response, 200, { courses: rows.map((row) => ({ courseId: String(row.id), className: row.class_name })) });
        return true;
      }
      if (url.pathname === '/api/progress' && request.method === 'DELETE') {
        await database.execute('DELETE p FROM course_progress p JOIN courses c ON c.id = p.course_id WHERE c.user_id = ?', [user.id]);
        sendJson(response, 200, { cleared: true });
        return true;
      }
      const progressMatch = url.pathname.match(/^\/api\/progress\/(\d+)$/);
      if (progressMatch) {
        const courseId = progressMatch[1];
        const owned = await database.execute('SELECT id FROM courses WHERE id = ? AND user_id = ? LIMIT 1', [courseId, user.id]);
        if (!owned.length) throw new HttpError(404, '找不到課程');
        if (request.method === 'GET') {
          const rows = await database.execute('SELECT course_id, progress, note, updated_at FROM course_progress WHERE course_id = ?', [courseId]);
          sendJson(response, 200, { progress: rows[0] ? { courseId, progress: rows[0].progress, note: rows[0].note, updatedAt: iso(rows[0].updated_at) } : null });
          return true;
        }
        if (request.method === 'PUT') {
          const body = await readJson(request);
          if (typeof body.progress !== 'string' || body.progress.length > MAX_PROGRESS || typeof body.note !== 'string' || body.note.length > MAX_NOTE) throw new HttpError(400, '進度或備註格式不正確');
          await database.execute(
            `INSERT INTO course_progress (course_id, progress, note, updated_at) VALUES (?, ?, ?, UTC_TIMESTAMP(3))
             ON DUPLICATE KEY UPDATE progress = VALUES(progress), note = VALUES(note), updated_at = UTC_TIMESTAMP(3)`,
            [courseId, body.progress.trim(), body.note.trim()],
          );
          const rows = await database.execute('SELECT course_id, progress, note, updated_at FROM course_progress WHERE course_id = ?', [courseId]);
          sendJson(response, 200, { progress: { courseId, progress: rows[0].progress, note: rows[0].note, updatedAt: iso(rows[0].updated_at) } });
          return true;
        }
        if (request.method === 'DELETE') {
          await database.execute('DELETE p FROM course_progress p JOIN courses c ON c.id = p.course_id WHERE p.course_id = ? AND c.user_id = ?', [courseId, user.id]);
          sendJson(response, 200, { deleted: true });
          return true;
        }
      }
      throw new HttpError(404, '找不到 API route');
    } catch (error) {
      if (url.pathname.startsWith('/api/auth/recovery/') && !(error instanceof HttpError)) {
        log('error', 'recovery_database_error', 'Recovery database operation failed.');
        sendJson(response, 503, url.pathname === '/api/auth/recovery/status' ? { available: false } : { error: '密碼復原資料目前無法使用' });
        return true;
      }
      if (error instanceof HttpError) sendJson(response, error.status, { error: error.message });
      else if (error instanceof DatabaseUnavailableError) sendJson(response, 503, { error: '中央資料目前無法使用' });
      else {
        log('error', 'api_error', 'API request failed.');
        sendJson(response, 500, { error: '伺服器處理失敗' });
      }
      return true;
    }
  };
}
