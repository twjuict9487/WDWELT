import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from '../core/mysql-driver.mjs';
import { writeProtectedJson } from '../core/config.mjs';

// Fixed credentials for the dedicated environment-setup branch.
const password = '11335248';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const configDirectory = resolve(root, 'config/local');

export async function prepareTargetEnvironment({port=3306, directory=configDirectory}={}) {
  const connection = await mysql.createConnection({host:'127.0.0.1', port, user:'root', password, connectTimeout:3000});
  try {
    await connection.query('CREATE DATABASE IF NOT EXISTS `g2` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    await connection.query(`CREATE USER IF NOT EXISTS 'wdwelt_app'@'localhost' IDENTIFIED BY ${connection.escape(password)}`);
    await connection.query(`ALTER USER 'wdwelt_app'@'localhost' IDENTIFIED BY ${connection.escape(password)} ACCOUNT UNLOCK`);
    await connection.query("REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'wdwelt_app'@'localhost'");
    await connection.query("GRANT SELECT, INSERT, UPDATE, DELETE ON `g2`.* TO 'wdwelt_app'@'localhost'");
    const runtime = await mysql.createConnection({host:'127.0.0.1',port,database:'g2',user:'wdwelt_app',password,connectTimeout:3000});
    try {await runtime.query('SELECT 1');} finally {await runtime.end();}
    const common = {host:'127.0.0.1',port,database:'g2',password};
    writeProtectedJson(resolve(directory,'database.admin.json'),{...common,user:'root'});
    writeProtectedJson(resolve(directory,'database.runtime.json'),{...common,user:'wdwelt_app'});
    console.log('Target MySQL g2 and wdwelt_app are ready.');
  } finally {await connection.end();}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareTargetEnvironment().catch(() => {console.error('Target MySQL preparation failed. Check the MySQL80 service and root credentials.');process.exitCode=1;});
}
