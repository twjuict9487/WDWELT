import { resolve } from 'node:path';
import { createDatabaseConnection } from '../core/mysql-driver.mjs';
import { databaseConnectionOptions, loadDatabaseConfig } from '../core/config.mjs';
import { normalizeUsername } from '../core/password.mjs';

const arg=(name)=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:null;};
const configPath=arg('--config'); const username=arg('--username'); const all=process.argv.includes('--all');
if(!configPath || (Boolean(username)===all) || arg('--confirm')!=='REVOKE-SESSIONS') {
  console.error('Usage: node sessions.mjs --config <admin.json> (--username <name> | --all) --confirm REVOKE-SESSIONS'); process.exitCode=1;
} else {
  const config=loadDatabaseConfig(resolve(configPath)); const connection=await createDatabaseConnection(databaseConnectionOptions(config));
  try {
    let result;
    if(all) result=await connection.execute('DELETE FROM sessions');
    else { const normalized=normalizeUsername(username); result=await connection.execute('DELETE s FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.normalized_username=?',[normalized.normalizedUsername]); }
    console.log(JSON.stringify({revoked:Number(result[0].affectedRows),scope:all?'all':username},null,2));
  } finally { await connection.end(); }
}
