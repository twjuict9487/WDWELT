import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

// Runs the shipped host and CLI against the caller's disposable MySQL server.
export async function testPackagedRecovery({ repository, root, admin, runtime, password }) {
  const installed = join(root, 'installed package');
  const source = join(repository, 'artifacts/wdwelt-package');
  mkdirSync(join(installed, 'tools'), { recursive: true });
  for (const [from, to] of [['production', 'current'], ['host', 'tools/host'], ['db', 'db']]) {
    cpSync(join(source, from), join(installed, to), { recursive: true });
  }
  const config = join(installed, 'host.json');
  writeFileSync(config, JSON.stringify({ port:8080, bindAddress:'127.0.0.1', canonicalHost:'127.0.0.1', canonicalUrl:'http://127.0.0.1:8080', installPath:installed, currentPath:join(installed,'current'), runPath:join(installed,'run'), logPath:join(installed,'logs'), databaseConfigPath:runtime, logRetentionDays:14, logMaxBytes:5000000 }));
  const host = spawn(process.execPath, [join(installed,'tools/host/server.mjs'), '--config', config], { windowsHide:true, stdio:['ignore','pipe','pipe'] });
  let output = '';
  host.stdout.on('data', chunk => { output += chunk; });
  host.stderr.on('data', chunk => { output += chunk; });
  const endpoint = 'http://127.0.0.1:8080';
  const post = (path, body, cookie) => fetch(endpoint+path, {method:'POST', headers:{'Content-Type':'application/json', Origin:endpoint, ...(cookie ? {Cookie:cookie} : {})}, body:JSON.stringify(body)});
  try {
    for (let i=0; i<100 && !output.includes('listening on'); i++) {
      assert.equal(host.exitCode, null, output);
      await new Promise(resolve => setTimeout(resolve,100));
    }
    assert.ok(output.includes('listening on'), output);
    for (let i=0; i<100; i++) {
      const ready = await fetch(endpoint+'/health/ready');
      if (ready.ok) break;
      assert.ok(i<99,'Packaged host never became ready');
      await new Promise(resolve => setTimeout(resolve,100));
    }
    assert.equal((await fetch(endpoint+'/health/live')).status,200);
    assert.deepEqual(await (await fetch(endpoint+'/api/auth/recovery/status')).json(),{available:true});
    const verified = await post('/api/auth/recovery/verify',{username:'preserved-teacher', recoveryKey:password});
    assert.equal(verified.status,200);
    const cookie = verified.headers.get('set-cookie').split(';')[0];
    const rotated = spawnSync(process.execPath,[join(installed,'db/operations/recovery.mjs'),'set','--stdin','--config',admin],{input:JSON.stringify({password:password+'new',confirmation:password+'new'}),encoding:'utf8',windowsHide:true});
    assert.equal(rotated.status,0,rotated.stdout+rotated.stderr);
    assert.equal((await post('/api/auth/recovery/reset',{password:'new-teacher-password'},cookie)).status,401);
    assert.equal((await post('/api/auth/recovery/verify',{username:'preserved-teacher',recoveryKey:password})).status,401);
    const fresh = await post('/api/auth/recovery/verify',{username:'preserved-teacher',recoveryKey:password+'new'});
    assert.equal(fresh.status,200);
    const freshCookie = fresh.headers.get('set-cookie').split(';')[0];
    const reset = await post('/api/auth/recovery/reset',{password:'new-teacher-password'},freshCookie);
    assert.equal(reset.status,200);
    const sessionCookie = reset.headers.getSetCookie().find(value => value.startsWith('wdwelt_session='));
    if (sessionCookie) assert.match(sessionCookie, /^wdwelt_session=;.*Max-Age=0/);
    assert.equal((await post('/api/auth/recovery/reset',{password:'another-password'},freshCookie)).status,401);
    assert.equal((await post('/api/auth/login',{username:'preserved-teacher',password:'new-teacher-password'})).status,200);
    assert.equal(host.exitCode,null,'Host must remain running through rotation');
  } finally {
    if (host.exitCode === null) { host.kill(); await once(host,'exit'); }
  }
}
