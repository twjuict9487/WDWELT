import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseConnection } from '../core/mysql-driver.mjs';
import { databaseConnectionOptions, loadDatabaseConfig, writeProtectedJson } from '../core/config.mjs';
import { bootstrapRuntimeUser } from './bootstrap.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const configDirectory = resolve(root, 'config/local');

export async function prepareTargetEnvironment({port=3306, directory=configDirectory, adminPassword=process.env.WDWELT_DB_ROOT_PASSWORD}={}) {
  const adminPath=resolve(directory,'database.admin.json');
  const runtimePath=resolve(directory,'database.runtime.json');
  const existing=existsSync(adminPath);
  if(!existing && !adminPassword)throw new Error('Set WDWELT_DB_ROOT_PASSWORD or provide config/local/database.admin.json.');
  const admin=existing?loadDatabaseConfig(adminPath):{host:'127.0.0.1',port,database:'g2',user:'root',password:adminPassword,connectTimeoutMs:3000};
  if(admin.database!=='g2')throw new Error('Administrative config must target g2.');
  if(existsSync(runtimePath)) {
    const runtime=loadDatabaseConfig(runtimePath);
    if(runtime.password===admin.password)throw new Error('Runtime and administrative MySQL passwords are identical. Rotate the runtime credential before deployment.');
  }
  const connection = await createDatabaseConnection(databaseConnectionOptions(admin,{database:undefined}));
  try {
    if(existing) {
      const [rows]=await connection.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', ['g2']);
      if(!rows.length)throw new Error('The configured g2 database does not exist.');
    } else {
      await connection.query('CREATE DATABASE IF NOT EXISTS `g2` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    }
  } finally {await connection.end();}
  if(!existing)writeProtectedJson(adminPath,admin);
  const result=await bootstrapRuntimeUser({adminConfigPath:adminPath,runtimeConfigPath:runtimePath});
  if(loadDatabaseConfig(runtimePath).password===loadDatabaseConfig(adminPath).password)throw new Error('Runtime and administrative MySQL passwords are identical. Rotate the runtime credential before deployment.');
  console.log('Target MySQL g2 and least-privilege runtime account are ready.');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareTargetEnvironment().catch((error) => {
    const code = typeof error?.code === 'string' ? ` [${error.code}]` : '';
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Target MySQL preparation failed${code}: ${detail}`);
    console.error('Next: confirm the MySQL80 service is running and provide an authorized administrative credential.');
    process.exitCode=1;
  });
}
