import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { hashSessionToken } from '../../server/app/auth.mjs';

// No real or fixed recovery key is stored in source/fixtures. The caller generates it for this run.
export async function testRecoveryApi({ base, database, key, logs, api, check }) {
  const username = 'RecoveryTeacher';
  const oldPassword = randomBytes(16).toString('hex');
  const newPassword = randomBytes(16).toString('hex');
  await api(base, '/api/auth/register', { method: 'POST', body: { username, password: oldPassword } });
  const normal = await api(base, '/api/auth/login', { method: 'POST', body: { username, password: oldPassword } });
  const secondNormal = await api(base, '/api/auth/login', { method: 'POST', body: { username, password: oldPassword } });
  const verify = (name = username, recoveryKey = key) => api(base, '/api/auth/recovery/verify', { method: 'POST', body: { username: name, recoveryKey } });
  const reset = (cookie, password = newPassword) => api(base, '/api/auth/recovery/reset', { method: 'POST', cookie, body: { password } });
  const tokenOf = (cookie) => cookie.match(/wdwelt_reset=([^;]+)/)[1];
  const sessionsBefore = (await database.execute('SELECT COUNT(*) AS count FROM sessions'))[0].count;
  const tokensBefore = (await database.execute('SELECT COUNT(*) AS count FROM password_reset_tokens'))[0].count;
  const wrongKey = await verify(username, randomBytes(32).toString('hex'));
  const wrongName = await verify('DoesNotExist');
  check(wrongKey.response.status === 401 && wrongName.response.status === 401 && wrongKey.value.error === wrongName.value.error, 'invalid account/key share a safe error');
  check((await database.execute('SELECT COUNT(*) AS count FROM password_reset_tokens'))[0].count === tokensBefore, 'failed verification creates no capability');
  const verified = await verify();
  check(verified.response.status === 200 && verified.cookie.includes('HttpOnly') && verified.cookie.includes('SameSite=Strict') && verified.cookie.includes('Path=/api/auth/recovery') && !verified.cookie.includes('wdwelt_session'), 'verification creates only a short-lived reset-only cookie');
  check((await database.execute('SELECT COUNT(*) AS count FROM sessions'))[0].count === sessionsBefore, 'recovery does not create a normal session');
  const token = tokenOf(verified.cookie);
  const stored = await database.execute('SELECT token_hash, expires_at, created_at FROM password_reset_tokens WHERE token_hash = ?', [hashSessionToken(token)]);
  check(stored.length === 1 && !stored[0].token_hash.includes(Buffer.from(token)) && stored[0].expires_at > stored[0].created_at, 'only token hash and explicit expiry are stored');
  for (const route of ['/api/auth/me', '/api/timetable', '/api/courses', '/api/progress/1']) {
    check((await api(base, route, { cookie: verified.cookie })).response.status === 401, `reset-only cookie cannot access ${route}`);
  }
  check((await api(base, '/api/timetable', { cookie: `wdwelt_session=${token}` })).response.status === 401, 'reset token cannot be substituted as a login token');
  check((await reset(normal.cookie)).response.status === 401, 'normal session cannot replace a reset capability');
  check((await reset(`wdwelt_reset=${randomBytes(32).toString('base64url')}`)).response.status === 401, 'forged capability rejected');
  check((await reset(verified.cookie, 'x')).response.status === 400, 'backend independently rejects an invalid new password');
  await database.execute('UPDATE password_reset_tokens SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE token_hash = ?', [hashSessionToken(token)]);
  check((await reset(verified.cookie)).response.status === 401, 'expired capability rejected');
  const retry = await verify();
  const retryToken = tokenOf(retry.cookie);
  await database.query("CREATE TRIGGER reject_recovery_update BEFORE UPDATE ON users FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'private recovery SQL detail'");
  try {
    const failed = await reset(retry.cookie);
    check(failed.response.status === 500 && !JSON.stringify(failed.value).includes('private recovery SQL'), 'failed password update exposes no SQL detail');
    check((await database.execute('SELECT token_hash FROM password_reset_tokens WHERE token_hash = ?', [hashSessionToken(retryToken)])).length === 1, 'failed update rolls back capability consumption');
  } finally { await database.query('DROP TRIGGER reject_recovery_update'); }
  const beforeHash = (await database.execute('SELECT password_hash FROM users WHERE normalized_username = ?', [username.toLowerCase()]))[0].password_hash;
  const results = await Promise.all([reset(retry.cookie), reset(retry.cookie)]);
  check(results.filter((result) => result.response.status === 200).length === 1 && results.filter((result) => result.response.status === 401).length === 1, 'concurrent token replay allows exactly one successful reset');
  check((await reset(retry.cookie)).response.status === 401, 'successful reset immediately consumes capability');
  const login = await api(base, '/api/auth/login', { method: 'POST', body: { username, password: newPassword } });
  check(login.response.status === 200 && (await api(base, '/api/auth/login', { method: 'POST', body: { username, password: oldPassword } })).response.status === 401, 'new password logs in and old password fails');
  check((await api(base, '/api/auth/me', { cookie: normal.cookie })).response.status === 401, 'reset revokes previous login sessions');
  check((await api(base, '/api/auth/me', { cookie: secondNormal.cookie })).response.status === 401, 'reset revokes other device sessions');
  const after = (await database.execute('SELECT password_hash, password_parameters FROM users WHERE normalized_username = ?', [username.toLowerCase()]))[0];
  check(!after.password_hash.equals(beforeHash) && String(typeof after.password_parameters === 'string' ? after.password_parameters : JSON.stringify(after.password_parameters)).includes('scrypt'), 'reset uses the existing password hash format');
  check((await verify()).response.status === 200, 'changing a user password does not change the master key');
  const serialized = JSON.stringify(logs);
  for (const secret of [key, token, retryToken, oldPassword, newPassword, beforeHash.toString('hex')]) assert.ok(!serialized.includes(secret), 'logs exclude all credentials and tokens');
  check(true, 'logs contain no recovery key, password, token, hash or SQL detail');
}
