import { resolve } from 'node:path';
import { createDatabaseConnection } from '../core/mysql-driver.mjs';
import { databaseConnectionOptions, loadDatabaseConfig } from '../core/config.mjs';
import { createPushService, loadPushConfig } from '../../server/app/push.mjs';

const index = process.argv.indexOf('--config');
const configPath = index >= 0 ? process.argv[index + 1] : null;
const valueAfter = (name) => { const i=process.argv.indexOf(name); return i>=0 ? process.argv[i+1] : null; };
if (!configPath) {
  console.error('Required: --config <database config>');
  process.exitCode = 1;
} else {
  const connection = await createDatabaseConnection(databaseConnectionOptions(loadDatabaseConfig(resolve(configPath))));
  try {
    const [rows] = await connection.query(`SELECT s.id, u.username,
      SUBSTRING_INDEX(SUBSTRING_INDEX(s.endpoint, '/', 3), '/', -1) AS endpointHost,
      s.reminder_minutes AS reminderMinutes, s.enabled, s.failure_count AS failureCount,
      s.created_at AS createdAt, s.updated_at AS updatedAt,
      LENGTH(s.p256dh) AS p256dhLength, LENGTH(s.auth_secret) AS authLength
      FROM push_subscriptions s JOIN users u ON u.id=s.user_id ORDER BY s.id`);
    console.log(JSON.stringify({ subscriptionCount: rows.length, subscriptions: rows }, null, 2));
    const testId = valueAfter('--test-subscription');
    if (testId) {
      if (!/^\d+$/.test(testId)) throw new Error('Invalid subscription id');
      const [targets] = await connection.execute('SELECT * FROM push_subscriptions WHERE id=? LIMIT 1',[testId]);
      if (!targets.length) throw new Error('Subscription not found');
      const adapter = { execute: async (sql, parameters=[]) => (await connection.execute(sql,parameters))[0] };
      const events=[];
      const service=createPushService({database:adapter,config:loadPushConfig(resolve(valueAfter('--push-config') ?? 'config/local/push.json')),log:(level,event,message)=>events.push({level,event,message})});
      const result=await service.test(targets[0]);
      console.log(JSON.stringify({ testSubscription:Number(testId), result, events },null,2));
      if(!result.ok) process.exitCode=2;
    }
  } finally { await connection.end(); }
}
