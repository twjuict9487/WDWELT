import {
  clearSessionCookie,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeUsername,
  readSessionCookie,
  sessionCookie,
  SESSION_DURATION_SECONDS,
  SESSION_RENEWAL_WINDOW_SECONDS,
  validatePassword,
  verifyPassword,
} from './auth.mjs';
import { DatabaseUnavailableError } from './db.mjs';
import { readResetCookie, resetCookie, RESET_SECONDS } from './recovery.mjs';
import { assertRequestOrigin, createAuthRateLimiter, createFixedWindowLimiter, trustworthyClientKey } from './security.mjs';
import { endpointHash } from './push.mjs';
import { createLearningApi } from './learning-api.mjs';

import { readRecoveryConfig, recoveryStatus, verifyRecoveryPassword } from '../../db/core/recovery-config.mjs';
import { toTaipeiIsoString } from '../../db/core/time.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_CLASS_NAME = 20;
const MAX_PROGRESS = 120;
const MAX_NOTE = 300;
const DUMMY_LOGIN_CREDENTIAL = await hashPassword('wdwelt-invalid-account-password');

class HttpError extends Error {
  constructor(status, message, details = null, headers = {}) { super(message); this.status = status; this.details = details; this.headers = headers; }
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

const iso = (value) => toTaipeiIsoString(value);

async function authenticatedUser(request, response, database, security) {
  const token = readSessionCookie(request.headers.cookie);
  if (!token) throw new HttpError(401, '請先登入');
  const rows = await database.execute(
    `SELECT u.id, u.username, u.account_role, u.account_status, u.must_change_password, s.expires_at AS session_expires_at, CURRENT_TIMESTAMP(3) AS server_time,
            TIMESTAMPDIFF(SECOND, CURRENT_TIMESTAMP(3), s.expires_at) AS remaining_seconds
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP(3)
      LIMIT 1`,
    [hashSessionToken(token)],
  );
  if (!rows.length) throw new HttpError(401, 'Session 已失效，請重新登入');
  if (rows[0].account_status === 'disabled') {
    await database.execute('DELETE FROM sessions WHERE token_hash = ?', [hashSessionToken(token)]);
    throw new HttpError(401, 'Account is disabled.');
  }
  let expiresAt = rows[0].session_expires_at;
  if (Number(rows[0].remaining_seconds) <= SESSION_RENEWAL_WINDOW_SECONDS) {
    await database.execute('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP(3), expires_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND) WHERE token_hash = ?', [SESSION_DURATION_SECONDS, hashSessionToken(token)]);
    const renewed = await database.execute('SELECT expires_at, CURRENT_TIMESTAMP(3) AS server_time FROM sessions WHERE token_hash = ?', [hashSessionToken(token)]);
    expiresAt = renewed[0].expires_at;
    rows[0].server_time = renewed[0].server_time;
    response.setHeader('Set-Cookie', sessionCookie(token, SESSION_DURATION_SECONDS, { secure: security.secureCookies }));
  } else {
    await database.execute('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP(3) WHERE token_hash = ?', [hashSessionToken(token)]);
  }
  await database.execute('UPDATE users SET last_seen_at=CURRENT_TIMESTAMP(3) WHERE id=? AND (last_seen_at IS NULL OR last_seen_at<DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 MINUTE))', [rows[0].id]);
  return { id: Number(rows[0].id), username: rows[0].username, role: rows[0].account_role, token, mustChangePassword: Boolean(rows[0].must_change_password), expiresAt: iso(expiresAt), serverTime: iso(rows[0].server_time) };
}

async function loadState(database, userId, adapter = database) {
  const users = await adapter.execute('SELECT timetable_updated_at FROM users WHERE id = ?', [userId]);
  const courseRows = await adapter.execute(
    `SELECT c.id, c.class_name, p.progress, p.note, p.updated_at
       FROM courses c LEFT JOIN course_progress p ON p.course_id = c.id
      WHERE c.user_id = ? AND c.archived_at IS NULL ORDER BY c.id`,
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

async function archiveUnusedCourses(adapter, userId) {
  return adapter.execute(
    `UPDATE courses c
      LEFT JOIN timetable_entries t ON t.course_id = c.id
       SET c.archived_at = CURRENT_TIMESTAMP(3)
     WHERE c.user_id = ? AND t.course_id IS NULL AND c.archived_at IS NULL`,
    [userId],
  );
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

export function createApiHandler({ database, pushService = null, log = () => {}, requestMonitor = null, learning = {}, security = {
  publicOrigin: 'http://localhost', secureCookies: false, requireSameOrigin: false,
  allowRegistration: true, allowMasterRecovery: true, minimumPasswordLength: 3, minimumRecoveryKeyLength: 3, rateLimit: null,
  limits: null,
} }) {
  const learningApi=createLearningApi({database,log,...learning});
  const sessionSeconds = SESSION_DURATION_SECONDS;
  const limiter = createAuthRateLimiter(security.rateLimit);
  const limits = security.limits ?? null;
  const routeLimiter = limits ? createFixedWindowLimiter(limits) : null;
  const limited = (scope, key, rule) => {
    if (!routeLimiter || !rule) return;
    const result = routeLimiter.consume(scope, key, rule);
    if (!result.allowed) {
      log('warning', 'rate_limit_violation', `${scope} rate limit exceeded.`);
      throw new HttpError(429, 'Too many requests. Please retry later.', null, { 'Retry-After': String(result.retryAfter) });
    }
  };
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;
    try {
      const clientKey = trustworthyClientKey(request, security);
      if(!url.pathname.startsWith('/api/learning/'))limited('general', clientKey, limits?.general);
      assertRequestOrigin(request, security);
      if(url.pathname.startsWith('/api/learning/')){
        const anonymous=url.pathname==='/api/learning/join/preview'||url.pathname==='/api/learning/status';
        const user=anonymous?null:await authenticatedUser(request,response,database,security);
        limited('learning-general',user?`account:${user.id}`:clientKey,limits?.general?{...limits.general,limit:user?limits.general.limit:Math.max(600,limits.general.limit)}:null);
        if(user?.mustChangePassword)throw new HttpError(403,'請先更換臨時密碼');
        return await learningApi({request,response,url,user,readJson,sendJson});
      }
      if (url.pathname === '/api/auth/recovery/status' && request.method === 'GET') {
        if (!security.allowMasterRecovery) {
          sendJson(response, 200, { available: false });
          return true;
        }
        const status = await recoveryStatus(database);
        if (!status.configured) log('warning', 'recovery_config_missing', 'Recovery configuration missing.');
        sendJson(response, 200, { available: status.configured });
        return true;
      }
      if (url.pathname === '/api/auth/recovery/verify' && request.method === 'POST') {
        if (!security.allowMasterRecovery) throw new HttpError(404, '找不到 API route');
        response.setHeader('Set-Cookie', resetCookie('', 0, { secure: security.secureCookies }));
        const body = await readJson(request);
        limited('recovery-source', clientKey, limits?.recovery);
        if (limiter && !limiter.allowRecovery(body.username ?? 'invalid')) {
          log('warning', 'recovery_rate_limited', 'Recovery verification rate limited.');
          throw new HttpError(429, '嘗試次數過多，請稍後再試。');
        }
        if (typeof body.recoveryKey !== 'string' || body.recoveryKey.length < security.minimumRecoveryKeyLength) {
          log('warning', 'recovery_verify_failed', 'Recovery verification rejected.');
          throw new HttpError(401, '帳號或復原密碼不正確。');
        }
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
          await transaction.execute('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND), CURRENT_TIMESTAMP(3))', [capability.tokenHash, accounts[0].id, RESET_SECONDS]);
          return capability.token;
        });
        log('info', 'recovery_verified', 'Password recovery verified.');
        sendJson(response, 200, { resetAllowed: true }, { 'Set-Cookie': resetCookie(token, RESET_SECONDS, { secure: security.secureCookies }) });
        return true;
      }

      if (url.pathname === '/api/auth/recovery/reset' && request.method === 'POST') {
        if (!security.allowMasterRecovery) throw new HttpError(404, '找不到 API route');
        const token = readResetCookie(request.headers.cookie);
        const invalid = () => {
          log('warning', 'recovery_token_invalid', 'Recovery token rejected.');
          return new HttpError(401, '密碼重設驗證已失效，請重新驗證。');
        };
        if (!token) throw invalid();
        const tokenHash = hashSessionToken(token);
        const capabilities = await database.execute('SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP(3)', [tokenHash]);
        if (!capabilities.length) throw invalid();
        const body = await readJson(request);
        let password;
        try {
          password = validatePassword(body.password);
          if (password.length < security.minimumPasswordLength) throw new Error('public password too short');
        }
        catch { throw new HttpError(400, '密碼必須為 3–256 個字元。'); }
        const saved = await hashPassword(password);
        await database.transaction(async (transaction) => {
          if (!await readRecoveryConfig(transaction, ' FOR SHARE')) throw invalid();
          const userId = capabilities[0].user_id;
          // A user lock serializes resets, including different tokens for the same account.
          const users = await transaction.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
          const valid = await transaction.execute('SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND user_id = ? AND expires_at > CURRENT_TIMESTAMP(3) FOR UPDATE', [tokenHash, userId]);
          if (!users.length || !valid.length) throw invalid();
          await transaction.execute('UPDATE users SET password_salt = ?, password_hash = ?, password_parameters = ? WHERE id = ?', [saved.salt, saved.hash, JSON.stringify(saved.parameters), userId]);
          await transaction.execute('DELETE FROM password_reset_tokens WHERE user_id = ?', [userId]);
          await transaction.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
        });
        log('info', 'recovery_reset_success', 'Password reset completed.');
        sendJson(response, 200, { reset: true }, { 'Set-Cookie': [resetCookie('', 0, { secure: security.secureCookies }), clearSessionCookie({ secure: security.secureCookies })] });
        return true;
      }

      if (url.pathname === '/api/auth/register' && request.method === 'POST') {
        limited('registration-source', clientKey, limits?.registration);
        if (!security.allowRegistration) throw new HttpError(404, '找不到 API route');
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
        if (limiter && !limiter.isLoginAllowed(body.username ?? 'invalid')) {
          log('warning', 'login_rate_limited', 'Login rate limited.');
          throw new HttpError(429, '嘗試次數過多，請稍後再試。');
        }
        let normalized;
        try {
          normalized = normalizeUsername(body.username);
          validatePassword(body.password);
          if (body.password.length < security.minimumPasswordLength) throw new Error('public password too short');
        }
        catch { throw new HttpError(401, '帳號或密碼錯誤'); }
        const rows = await database.execute('SELECT id, username, password_salt, password_hash, password_parameters, account_role, account_status, must_change_password FROM users WHERE normalized_username = ? LIMIT 1', [normalized.normalizedUsername]);
        const account = rows[0];
        const parameters = account ? (typeof account.password_parameters === 'string' ? JSON.parse(account.password_parameters) : account.password_parameters) : DUMMY_LOGIN_CREDENTIAL.parameters;
        const passwordMatches = await verifyPassword(
          body.password,
          account?.password_salt ?? DUMMY_LOGIN_CREDENTIAL.salt,
          account?.password_hash ?? DUMMY_LOGIN_CREDENTIAL.hash,
          parameters,
        );
        if (!account || !passwordMatches) {
          limiter?.recordLoginFailure(body.username ?? 'invalid');
          log('warning', 'login_failure', 'Login rejected.');
          throw new HttpError(401, '帳號或密碼錯誤');
        }
        if (account.account_status === 'disabled') {
          limiter?.recordLoginFailure(body.username ?? 'invalid');
          log('warning', 'login_disabled_account', 'Disabled account login rejected.');
          throw new HttpError(401, '帳號或密碼錯誤');
        }
        limiter?.clearLoginFailures(body.username ?? 'invalid');
        const { token, tokenHash } = createSessionToken();
        const session = await database.transaction(async (transaction) => {
          await transaction.execute('UPDATE users SET last_seen_at=CURRENT_TIMESTAMP(3) WHERE id=?', [account.id]);
          await transaction.execute('INSERT INTO sessions (token_hash, user_id, last_seen_at, expires_at) VALUES (?, ?, CURRENT_TIMESTAMP(3), DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND))', [tokenHash, account.id, sessionSeconds]);
          const [created] = await transaction.execute('SELECT expires_at, CURRENT_TIMESTAMP(3) AS server_time FROM sessions WHERE token_hash = ?', [tokenHash]);
          return created;
        });
        log('info', 'login_success', 'Login succeeded.');
        sendJson(response, 200, { authenticated: true, user: { id: Number(account.id), username: account.username, role: account.account_role }, mustChangePassword: Boolean(account.must_change_password), expiresAt: iso(session.expires_at), serverTime: iso(session.server_time) }, { 'Set-Cookie': sessionCookie(token, sessionSeconds, { secure: security.secureCookies }) });
        return true;
      }

      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        const token = readSessionCookie(request.headers.cookie);
        if (token) await database.execute('DELETE FROM sessions WHERE token_hash = ?', [hashSessionToken(token)]);
        log('info', 'logout', 'Session logged out.');
        sendJson(response, 200, { authenticated: false }, { 'Set-Cookie': clearSessionCookie({ secure: security.secureCookies }) });
        return true;
      }

      if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        const user = await authenticatedUser(request, response, database, security);
        sendJson(response, 200, { authenticated: true, user: { id: user.id, username: user.username, role: user.role }, mustChangePassword: user.mustChangePassword, expiresAt: user.expiresAt, serverTime: user.serverTime });
        return true;
      }

      const user = await authenticatedUser(request, response, database, security);
      if (url.pathname === '/api/privileged/monitor' && request.method === 'GET') {
        if (user.role !== 'privileged') throw new HttpError(403, 'Privileged access required.');
        const accounts = await database.execute(`SELECT u.id,u.username,u.admin_notes AS private_label,u.account_role,u.account_status,u.created_at,u.last_seen_at,
          TIMESTAMPDIFF(DAY,u.created_at,CURRENT_TIMESTAMP(3)) AS age_days,
          TIMESTAMPDIFF(DAY,COALESCE(u.last_seen_at,u.created_at),CURRENT_TIMESTAMP(3)) AS inactive_days,
          (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id) AS session_count,
          (SELECT COUNT(*) FROM courses c WHERE c.user_id=u.id) AS course_count,
          (SELECT COUNT(*) FROM timetable_entries t WHERE t.user_id=u.id) AS timetable_count,
          (SELECT COUNT(*) FROM course_progress p JOIN courses c2 ON c2.id=p.course_id WHERE c2.user_id=u.id) AS progress_count,
          (SELECT COUNT(*) FROM push_subscriptions ps WHERE ps.user_id=u.id) AS push_count
          FROM users u ORDER BY u.id`);
        const accountReview = accounts.map((account) => {
          const evidence = {
            sessions:Number(account.session_count), courses:Number(account.course_count), timetableEntries:Number(account.timetable_count),
            progressRecords:Number(account.progress_count), pushSubscriptions:Number(account.push_count),
          };
          const noUsageEvidence = Object.values(evidence).every((count) => count === 0);
          const needsReview = account.account_role !== 'privileged' && account.account_status === 'active' && Number(account.inactive_days) >= 7 && noUsageEvidence;
          return { id:Number(account.id), username:account.username, privateLabel:account.private_label ?? '', role:account.account_role, status:account.account_status,
            createdAt:iso(account.created_at), lastSeenAt:account.last_seen_at == null ? null : iso(account.last_seen_at), ageDays:Number(account.age_days), inactiveDays:Number(account.inactive_days), evidence, needsReview,
            indicators:needsReview ? ['not-seen-for-7-days','no-current-usage-evidence'] : [] };
        });
        sendJson(response, 200, { requests:requestMonitor?.snapshot() ?? null, accountReview, policy:{ inactivityReviewDays:7, automaticDeletion:false } });
        return true;
      }
      if (url.pathname === '/api/privileged/accounts' && request.method === 'GET') {
        if (user.role !== 'privileged') throw new HttpError(403, 'Privileged access required.');
        const accounts = await database.execute('SELECT id, username, admin_notes AS private_label FROM users ORDER BY id');
        sendJson(response, 200, { accounts: accounts.map((account) => ({ id:Number(account.id), username:account.username, privateLabel:account.private_label ?? '' })) });
        return true;
      }
      const privilegedLabelMatch = url.pathname.match(/^\/api\/privileged\/accounts\/(\d+)\/label$/);
      if (privilegedLabelMatch && request.method === 'PATCH') {
        if (user.role !== 'privileged') throw new HttpError(403, 'Privileged access required.');
        const targetUserId = Number(privilegedLabelMatch[1]);
        if (!Number.isSafeInteger(targetUserId) || targetUserId < 1) throw new HttpError(400, 'Invalid account id.');
        const body = await readJson(request);
        if (typeof body.privateLabel !== 'string') throw new HttpError(400, 'Private label must be text.');
        const privateLabel = body.privateLabel.normalize('NFKC').trim().replace(/\s+/gu, ' ');
        if (privateLabel.length > 100) throw new HttpError(400, 'Private label must be 100 characters or fewer.');
        const result = await database.execute('UPDATE users SET admin_notes=?, account_updated_at=CURRENT_TIMESTAMP(3) WHERE id=?', [privateLabel || null, targetUserId]);
        if (Number(result.affectedRows) !== 1) throw new HttpError(404, 'Account not found.');
        await database.execute('INSERT INTO developer_audit_log(action,target_user_id,details) VALUES(?,?,?)', ['privileged_private_label', targetUserId, JSON.stringify({ actorUserId:user.id, hasLabel:Boolean(privateLabel) })]);
        sendJson(response, 200, { updated:true, id:targetUserId, privateLabel });
        return true;
      }
      if (url.pathname === '/api/auth/password' && request.method === 'POST') {
        const payload = await readJson(request);
        let password;
        try { password = validatePassword(payload.password); if (password.length < security.minimumPasswordLength) throw new Error(); }
        catch { throw new HttpError(400, 'Invalid new password.'); }
        const saved = await hashPassword(password);
        const replacement = createSessionToken();
        await database.transaction(async (transaction) => {
          await transaction.execute('UPDATE users SET password_salt=?, password_hash=?, password_parameters=?, must_change_password=FALSE, account_updated_at=CURRENT_TIMESTAMP(3) WHERE id=?', [saved.salt, saved.hash, JSON.stringify(saved.parameters), user.id]);
          await transaction.execute('DELETE FROM sessions WHERE user_id=?', [user.id]);
          await transaction.execute('INSERT INTO sessions(token_hash,user_id,last_seen_at,expires_at) VALUES(?,?,CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL ? SECOND))', [replacement.tokenHash,user.id,sessionSeconds]);
        });
        sendJson(response,200,{changed:true},{'Set-Cookie':sessionCookie(replacement.token,sessionSeconds,{secure:security.secureCookies})}); return true;
      }
      if (user.mustChangePassword) throw new HttpError(403, 'Password change is required.');
      if (url.pathname.startsWith('/api/push/') && request.method !== 'GET') limited('push-user', user.id, limits?.push);
      if (url.pathname === '/api/debug/report' && request.method === 'GET') {
        const [sessions, subscriptions, integrity] = await Promise.all([
          database.execute('SELECT COUNT(*) AS count FROM sessions WHERE user_id=? AND expires_at>CURRENT_TIMESTAMP(3)', [user.id]),
          database.execute('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id=? AND enabled=TRUE', [user.id]),
          database.execute(`SELECT SUM(t.course_id IS NULL AND c.archived_at IS NULL) AS shouldArchive,
            SUM(t.course_id IS NOT NULL AND c.archived_at IS NOT NULL) AS shouldUnarchive
            FROM courses c LEFT JOIN timetable_entries t ON t.course_id=c.id AND t.user_id=c.user_id WHERE c.user_id=?`, [user.id]),
        ]);
        sendJson(response, 200, { generatedAt: iso(new Date()), session: { expiresAt:user.expiresAt, activeDevices:Number(sessions[0].count) },
          transport: { exposureMode:security.exposureMode, publicOrigin:security.publicOrigin, secureCookie:security.secureCookies, originProtection:security.requireSameOrigin },
          database: { integrityDryRun: { shouldArchive:Number(integrity[0]?.shouldArchive ?? 0), shouldUnarchive:Number(integrity[0]?.shouldUnarchive ?? 0), destructiveChanges:0 } },
          push: { configured:Boolean(pushService), activeSubscriptions:Number(subscriptions[0].count) } });
        return true;
      }
      if (url.pathname === '/api/push/config' && request.method === 'GET') {
        sendJson(response, 200, { configured:Boolean(pushService), publicKey:pushService?.publicKey ?? null, defaultReminderMinutes:10 }); return true;
      }
      if (url.pathname === '/api/push/subscription' && request.method === 'PUT') {
        if (!pushService) throw new HttpError(503, 'Push 尚未設定');
        const body=await readJson(request); const sub=body.subscription;
        if (!sub || typeof sub.endpoint!=='string' || sub.endpoint.length>2048 || !sub.endpoint.startsWith('https://') || typeof sub.keys?.p256dh!=='string' || typeof sub.keys?.auth!=='string') throw new HttpError(400,'無效的 Push Subscription');
        const reminder=Number(body.reminderMinutes ?? 10); if (!Number.isInteger(reminder)||reminder<0||reminder>120) throw new HttpError(400,'提醒時間必須是 0 到 120 分鐘');
        await database.execute(`INSERT INTO push_subscriptions (user_id,endpoint_hash,endpoint,p256dh,auth_secret,expiration_time,reminder_minutes,enabled)
          VALUES (?,?,?,?,?,?,?,TRUE) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),endpoint=VALUES(endpoint),p256dh=VALUES(p256dh),auth_secret=VALUES(auth_secret),expiration_time=VALUES(expiration_time),reminder_minutes=VALUES(reminder_minutes),enabled=TRUE,updated_at=CURRENT_TIMESTAMP(3)`,
        [user.id,endpointHash(sub.endpoint),sub.endpoint,sub.keys.p256dh,sub.keys.auth,sub.expirationTime ?? null,reminder]);
        sendJson(response,200,{enabled:true,reminderMinutes:reminder}); return true;
      }
      if (url.pathname === '/api/push/subscription' && request.method === 'DELETE') {
        const body=await readJson(request); if(typeof body.endpoint!=='string') throw new HttpError(400,'缺少 endpoint');
        await database.execute('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint_hash=?',[user.id,endpointHash(body.endpoint)]);
        sendJson(response,200,{enabled:false}); return true;
      }
      if (url.pathname === '/api/push/test' && request.method === 'POST') {
        if (!pushService) throw new HttpError(503,'Push 尚未設定');
        const body=await readJson(request); if(typeof body.endpoint!=='string') throw new HttpError(400,'缺少 endpoint');
        const rows=await database.execute('SELECT * FROM push_subscriptions WHERE user_id=? AND endpoint_hash=? AND enabled=TRUE LIMIT 1',[user.id,endpointHash(body.endpoint)]);
        if(!rows.length) throw new HttpError(404,'這台裝置尚未啟用通知');
        const result=await pushService.test(rows[0]);
        if(!result.ok) {
          const d=result.diagnostic;
          throw new HttpError(502,`推播失敗：階段 ${d.stage}；HTTP ${d.httpStatus ?? '無回應'}；代碼 ${d.errorCode ?? '無'}；原因 ${d.providerReason ?? d.message}`,{push:d});
        }
        sendJson(response,200,{sent:true,diagnostic:result.diagnostic}); return true;
      }
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
               ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), class_name = VALUES(class_name), archived_at = NULL`,
              [user.id, entry.className, entry.normalizedClassName],
            );
            savedEntries.push({ ...entry, courseId: Number(result.insertId) });
          }
          const retained = new Set(savedEntries.map((entry) => `${entry.weekday}:${entry.period}`));
          const existing = await transaction.execute('SELECT weekday, period FROM timetable_entries WHERE user_id = ?', [user.id]);
          for (const entry of savedEntries) await transaction.execute(
            'INSERT INTO timetable_entries (user_id, weekday, period, course_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE course_id = VALUES(course_id)',
            [user.id, entry.weekday, entry.period, entry.courseId],
          );
          for (const entry of existing) if (!retained.has(`${entry.weekday}:${entry.period}`)) {
            await transaction.execute('DELETE FROM timetable_entries WHERE user_id = ? AND weekday = ? AND period = ?', [user.id, entry.weekday, entry.period]);
          }
          await archiveUnusedCourses(transaction, user.id);
          await transaction.execute('UPDATE users SET timetable_updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [user.id]);
          return loadState(database, user.id, transaction);
        });
        sendJson(response, 200, { state });
        return true;
      }
      if (url.pathname === '/api/timetable' && request.method === 'DELETE') {
        const state = await database.transaction(async (transaction) => {
          await transaction.execute('DELETE FROM timetable_entries WHERE user_id = ?', [user.id]);
          await archiveUnusedCourses(transaction, user.id);
          await transaction.execute('UPDATE users SET timetable_updated_at = NULL WHERE id = ?', [user.id]);
          return loadState(database, user.id, transaction);
        });
        sendJson(response, 200, { state });
        return true;
      }
      if (url.pathname === '/api/courses' && request.method === 'GET') {
        const rows = await database.execute('SELECT id, class_name FROM courses WHERE user_id = ? AND archived_at IS NULL ORDER BY id', [user.id]);
        sendJson(response, 200, { courses: rows.map((row) => ({ courseId: String(row.id), className: row.class_name })) });
        return true;
      }
      const courseMatch = url.pathname.match(/^\/api\/courses\/(\d+)$/);
      if (courseMatch && request.method === 'DELETE') {
        const body=await readJson(request); const rows=await database.execute('SELECT class_name,archived_at FROM courses WHERE id=? AND user_id=?',[courseMatch[1],user.id]);
        if(!rows.length) throw new HttpError(404,'找不到課程');
        if(rows[0].archived_at == null) throw new HttpError(409,'請先從課表移除所有時段');
        if(body.confirmClassName!==rows[0].class_name) throw new HttpError(400,'永久刪除需輸入完整課程名稱確認');
        await database.execute('DELETE FROM courses WHERE id=? AND user_id=? AND archived_at IS NOT NULL',[courseMatch[1],user.id]);
        sendJson(response,200,{deleted:true}); return true;
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
            `INSERT INTO course_progress (course_id, progress, note, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP(3))
             ON DUPLICATE KEY UPDATE progress = VALUES(progress), note = VALUES(note), updated_at = CURRENT_TIMESTAMP(3)`,
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
      if (error instanceof HttpError || Number.isInteger(error?.status)) {
        if (error.status === 401 || error.status === 403) log('warning', 'unauthorized_api', 'Unauthorized API request rejected.');
        sendJson(response, error.status, { error: error.message, ...(error.details ?? {}) }, error.headers ?? {});
      }
      else if (error instanceof DatabaseUnavailableError) sendJson(response, 503, { error: '中央資料目前無法使用' });
      else {
        log('error', 'api_error', 'API request failed.');
        sendJson(response, 500, { error: '伺服器處理失敗' });
      }
      return true;
    }
  };
}
