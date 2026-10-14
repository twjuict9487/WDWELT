import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import webpush from 'web-push';

const PERIOD_START = new Map([[1,'08:10'],[2,'09:10'],[3,'10:10'],[4,'11:10'],[5,'13:05'],[6,'14:05'],[7,'15:10'],[8,'16:10']]);
export const endpointHash = (endpoint) => createHash('sha256').update(endpoint, 'utf8').digest();

export function pushFailureDiagnostic(error) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : null;
  const code = typeof error?.code === 'string' ? error.code : null;
  let providerReason = null;
  if (typeof error?.body === 'string' && error.body.length <= 4096) {
    try {
      const parsed = JSON.parse(error.body);
      providerReason = typeof parsed?.reason === 'string' ? parsed.reason : typeof parsed?.error === 'string' ? parsed.error : null;
    } catch { providerReason = error.body.replace(/[^\x20-\x7E]/g, '').slice(0, 240) || null; }
  }
  let stage = 'provider-response';
  if (status == null) stage = 'network';
  else if (status === 401 || status === 403) stage = 'vapid-authentication';
  else if (status === 404 || status === 410) stage = 'subscription-expired';
  else if (status === 400) stage = 'subscription-or-payload';
  return { stage, httpStatus: status, errorCode: code, providerReason, message: String(error?.message ?? 'Unknown push error').slice(0, 300) };
}

function taipeiParts(date = new Date()) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' }).formatToParts(date).map((p)=>[p.type,p.value]));
  const calendar = new Date(Date.UTC(Number(values.year), Number(values.month)-1, Number(values.day)));
  const day = calendar.getUTCDay();
  return { date: `${values.year}-${values.month}-${values.day}`, weekday: day === 0 ? 7 : day, minutes: Number(values.hour)*60+Number(values.minute) };
}

export function loadPushConfig(path) {
  if (!path || !existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  let subject;
  try { subject = new URL(value.subject); } catch { throw new Error('Invalid VAPID subject URL'); }
  if (!['mailto:','https:'].includes(subject.protocol) || (subject.protocol === 'mailto:' && !subject.pathname.includes('@')) || !value.publicKey || !value.privateKey) throw new Error('Invalid VAPID config');
  return value;
}

export function createPushService({ database, config, log = () => {} }) {
  if (!config) return null;
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  const send = async (row, payload) => {
    try {
      const providerResponse = await webpush.sendNotification({ endpoint: row.endpoint, expirationTime: row.expiration_time == null ? null : Number(row.expiration_time), keys: { p256dh: row.p256dh, auth: row.auth_secret } }, JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
      await database.execute('UPDATE push_subscriptions SET failure_count=0, updated_at=CURRENT_TIMESTAMP(3) WHERE id=?', [row.id]);
      return { ok: true, diagnostic: { stage:'complete', httpStatus:Number(providerResponse?.statusCode ?? 201), errorCode:null, providerReason:null, message:'Push accepted by provider' } };
    } catch (error) {
      const diagnostic = pushFailureDiagnostic(error);
      if (error?.statusCode === 404 || error?.statusCode === 410) await database.execute('DELETE FROM push_subscriptions WHERE id=?', [row.id]);
      else await database.execute('UPDATE push_subscriptions SET failure_count=LEAST(failure_count+1,65535), updated_at=CURRENT_TIMESTAMP(3) WHERE id=?', [row.id]);
      log('warning', 'push_send_failed', `Push delivery failed: stage=${diagnostic.stage} status=${diagnostic.httpStatus ?? 'none'} code=${diagnostic.errorCode ?? 'none'} reason=${diagnostic.providerReason ?? 'none'} message=${diagnostic.message}`);
      return { ok:false, diagnostic };
    }
  };
  const run = async (now = new Date()) => {
    const t = taipeiParts(now);
    if (t.weekday > 5) return { considered: 0, sent: 0 };
    const rows = await database.execute(`SELECT s.id,s.user_id,s.endpoint,s.p256dh,s.auth_secret,s.expiration_time,s.reminder_minutes,
        e.weekday,e.period,c.class_name
      FROM push_subscriptions s JOIN timetable_entries e ON e.user_id=s.user_id
      JOIN courses c ON c.id=e.course_id AND c.user_id=e.user_id
      WHERE s.enabled=TRUE AND e.weekday=? AND c.archived_at IS NULL`, [t.weekday]);
    let sent = 0;
    for (const row of rows) {
      const start = PERIOD_START.get(Number(row.period));
      const [hour, minute] = start.split(':').map(Number);
      const delta = hour*60+minute-Number(row.reminder_minutes)-t.minutes;
      if (delta < 0 || delta > 1) continue;
      try {
        await database.execute('INSERT INTO push_deliveries (subscription_id,timetable_user_id,weekday,period,class_date) VALUES (?,?,?,?,?)', [row.id,row.user_id,row.weekday,row.period,t.date]);
      } catch (error) { if (error?.code === 'ER_DUP_ENTRY') continue; throw error; }
      const result = await send(row, { title: '即將上課', body: `${row.class_name} 將於 ${start} 開始`, url: '/', tag: `class-${t.date}-${row.weekday}-${row.period}` });
      if (result.ok) sent += 1;
      else await database.execute('DELETE FROM push_deliveries WHERE subscription_id=? AND timetable_user_id=? AND weekday=? AND period=? AND class_date=?', [row.id,row.user_id,row.weekday,row.period,t.date]).catch(()=>{});
    }
    return { considered: rows.length, sent };
  };
  let timer = null;
  return {
    publicKey: config.publicKey,
    start() { if (timer) return; timer=setInterval(()=>void run().catch(()=>{}), 30_000); timer.unref(); void run().catch(()=>{}); },
    stop() { if (timer) clearInterval(timer); timer=null; },
    run,
    test: (row) => send(row, { title:'WDWELT 測試通知', body:'這台裝置的推播已可正常送達。', url:'/?debug=0', tag:'wdwelt-test' }),
  };
}
