import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { hashPassword } from '../db/core/password.mjs';
import { createDeveloperAdminHandler } from '../server/app/developer-admin.mjs';

async function credentials() {
  const saved=await hashPassword('correct horse battery staple');
  return {normalizedUsername:'developer',passwordSalt:saved.salt,passwordHash:saved.hash,passwordParameters:saved.parameters};
}
async function invoke(handler,{url='/api/login',method='POST',remoteAddress='127.0.0.1',headers={},payload}={}){
  const request=Readable.from(payload===undefined?[]:[Buffer.from(JSON.stringify(payload))]);
  Object.assign(request,{url,method,headers:{...(payload===undefined?{}:{'content-length':String(Buffer.byteLength(JSON.stringify(payload)))}),...headers},socket:{remoteAddress}});
  let status=0;let result='';const response={writeHead(code){status=code;},end(value=''){result+=value;}};
  await handler(request,response);return{status,body:JSON.parse(result)};
}

describe('loopback-only developer administration',()=>{
  it('rejects remote clients even when proxy and Host headers claim localhost',async()=>{
    const handler=createDeveloperAdminHandler({database:{},credentials:await credentials()});
    const result=await invoke(handler,{remoteAddress:'203.0.113.7',headers:{host:'127.0.0.1:8081','x-forwarded-for':'127.0.0.1'},payload:{username:'developer',password:'correct horse battery staple'}});
    expect(result).toMatchObject({status:404,body:{error:'Not found.'}});
  });

  it('accepts valid loopback credentials and rejects incorrect credentials',async()=>{
    const handler=createDeveloperAdminHandler({database:{},credentials:await credentials()});
    expect((await invoke(handler,{payload:{username:'developer',password:'wrong password'}})).status).toBe(401);
    const accepted=await invoke(handler,{payload:{username:'developer',password:'correct horse battery staple'}});
    expect(accepted.status).toBe(200);expect(accepted.body.csrf).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
