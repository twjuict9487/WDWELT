import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseConnection } from '../core/mysql-driver.mjs';
import { loadDatabaseConfig, databaseConnectionOptions } from '../core/config.mjs';

export async function provisionLearningCreator({configPath,userId,active=true,confirm}) {
  if(!Number.isSafeInteger(userId)||userId<1||confirm!==`CREATOR:${userId}`)throw new Error('Specify an exact existing --user-id and --confirm CREATOR:<id>.');
  const connection=await createDatabaseConnection(databaseConnectionOptions(loadDatabaseConfig(resolve(configPath))));
  try{
    await connection.beginTransaction();
    const [[account]]=await connection.execute('SELECT id,username,account_status FROM users WHERE id=? FOR UPDATE',[userId]);
    if(!account||account.account_status!=='active')throw new Error('Existing active account required.');
    await connection.execute('INSERT INTO learning_creators(user_id,active) VALUES(?,?) ON DUPLICATE KEY UPDATE active=VALUES(active)',[userId,active]);
    await connection.execute('INSERT INTO learning_audit(actor_id,action,details) VALUES(?,?,?)',[userId,'creator.local-provision',JSON.stringify({source:'local-management-cli',active})]);
    await connection.commit();return {userId:account.id,username:account.username,creator:active};
  }catch(error){await connection.rollback();throw error;}finally{await connection.end();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const argument=(name)=>{const index=process.argv.indexOf(name);return index<0?null:process.argv[index+1];};
  const configPath=argument('--config');
  if(!configPath){console.error('Explicit --config required.');process.exitCode=1;}
  else provisionLearningCreator({configPath,userId:Number(argument('--user-id')),confirm:argument('--confirm'),active:!process.argv.includes('--revoke')})
    .then((result)=>console.log(JSON.stringify(result))).catch((error)=>{console.error(error.message);process.exitCode=1;});
}
