// Own datadir and random loopback port. Never connects to the installed service or production g2.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync,readdirSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import mysql from '../../db/core/mysql-driver.mjs';
import {DatabaseManager} from '../../server/app/db.mjs';
import {writeProtectedJson} from '../../db/core/config.mjs';
import {runMigrations} from '../../db/operations/migrate.mjs';
import {createReleaseSchema} from '../../db/core/release.mjs';
import {createLearningService} from '../../server/app/learning.mjs';
import {createActivityService} from '../../server/app/learning-activities.mjs';
import {provisionLearningCreator} from '../../db/operations/learning-creator.mjs';
import {hashPassword} from '../../server/app/auth.mjs';
import {createApiHandler} from '../../server/app/api.mjs';
import {createRequestHandler} from '../../server/app/host-core.mjs';
import {createSecurityPolicy,applySecurityHeaders} from '../../server/app/security.mjs';
import {createTemporaryOptionFile} from '../../db/core/mysql-option-file.mjs';
import {loadDatabaseConfig} from '../../db/core/config.mjs';
import {verifyBackupDump} from '../../db/operations/backup.mjs';
import {restoreDatabase} from '../../db/operations/restore.mjs';
import {readFileSync,writeFileSync} from 'node:fs';

const mysqld=process.argv[2];if(!mysqld)throw Error('Pass mysqld executable path; a disposable instance is required.');
const testDist=resolve(process.env.WDWELT_LEARNING_TEST_DIST??'runtime/learning-build');
const root=mkdtempSync(join(tmpdir(),'wdwelt-learning-')),data=join(root,'data');mkdirSync(data);
const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise((done)=>listener.close(done));
const bin=dirname(resolve(mysqld));let server,connection,database,httpServer,restartedHost,restartRuntime;const checks=[];
const pass=(name)=>{checks.push(name);console.log(`PASS ${name}`);};
try{
  const init=spawnSync(mysqld,['--no-defaults','--initialize-insecure',`--basedir=${dirname(bin)}`,`--datadir=${data}`,'--console'],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(init.status,0,init.stderr);
  server=spawn(mysqld,['--no-defaults',`--basedir=${dirname(bin)}`,`--datadir=${data}`,'--bind-address=127.0.0.1',`--port=${port}`,'--mysqlx=0','--max-connections=100','--console'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let diagnostics='';server.stderr.on('data',(chunk)=>{diagnostics+=chunk;});
  for(let i=0;i<120;i++){if(server.exitCode!==null)throw Error(diagnostics);try{connection=await mysql.createConnection({host:'127.0.0.1',port,user:'root',connectTimeout:1000});break;}catch{await new Promise((done)=>setTimeout(done,250));}}
  assert.ok(connection);const dbName='wdwelt_test_learning';await connection.query(`CREATE DATABASE ${dbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  const secret=randomUUID();await connection.query(`ALTER USER 'root'@'localhost' IDENTIFIED BY ${connection.escape(secret)}`);
  const config=join(root,'admin.json');writeProtectedJson(config,{host:'127.0.0.1',port,user:'root',password:secret,database:dbName,mysqlDumpPath:join(bin,'mysqldump.exe'),mysqlClientPath:join(bin,'mysql.exe')});
  assert.notEqual(port,3306,'Never test against the installed MySQL service');
  await connection.query('CREATE DATABASE wdwelt_test_release CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
  const releaseConnection=await mysql.createConnection({host:'127.0.0.1',port,user:'root',password:secret,database:'wdwelt_test_release',multipleStatements:true});
  try {
    const {sql}=createReleaseSchema(resolve('db/migrations'),'0.3.0');
    await releaseConnection.query(sql);
    assert.equal(Number((await releaseConnection.query('SELECT COUNT(*) AS count FROM schema_migrations'))[0][0].count),12);
    assert.equal(Number((await releaseConnection.query('SELECT COUNT(*) AS count FROM users'))[0][0].count),0);
    await assert.rejects(releaseConnection.query(sql));
    const releaseConfig=join(root,'release.json');writeProtectedJson(releaseConfig,{host:'127.0.0.1',port,user:'root',password:secret,database:'wdwelt_test_release'});
    assert.ok((await runMigrations({configPath:releaseConfig})).applied.every((m)=>m.status==='already-applied'));
    pass('combined fresh SQL imports all 12 migrations, has no accounts, rejects repeat import, and upgrade skips applied checksums');
  } finally {await releaseConnection.end();}
  await runMigrations({configPath:config});assert.ok((await runMigrations({configPath:config})).applied.every((m)=>m.status==='already-applied'));pass('fresh migrations and repeat checksum ledger');
  await connection.query('CREATE DATABASE wdwelt_test_learning_upgrade CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
  const legacyMigrations=join(root,'legacy-migrations');mkdirSync(legacyMigrations);
  for(const name of readdirSync('db/migrations').filter((n)=>/^00\d_|010_/.test(n)))copyFileSync(join('db/migrations',name),join(legacyMigrations,name));
  const upgradeConfig=join(root,'upgrade.json');writeProtectedJson(upgradeConfig,{host:'127.0.0.1',port,user:'root',password:secret,database:'wdwelt_test_learning_upgrade',mysqlDumpPath:join(bin,'mysqldump.exe'),mysqlClientPath:join(bin,'mysql.exe')});
  await runMigrations({configPath:upgradeConfig,migrationsPath:legacyMigrations});
  await connection.query("INSERT INTO wdwelt_test_learning_upgrade.users(username,normalized_username,password_salt,password_hash,password_parameters) VALUES('old-organizer','old-organizer',RANDOM_BYTES(32),RANDOM_BYTES(64),'{}')");
  await connection.query("INSERT INTO wdwelt_test_learning_upgrade.courses(user_id,class_name,normalized_class_name) VALUES(1,'private-307','private-307')");
  await connection.query("INSERT INTO wdwelt_test_learning_upgrade.course_progress(course_id,progress,note) VALUES(1,'P.61','preserve historical note')");
  await runMigrations({configPath:upgradeConfig});
  const [[preserved]]=await connection.query('SELECT progress,note FROM wdwelt_test_learning_upgrade.course_progress WHERE course_id=1');assert.equal(preserved.progress,'P.61');assert.equal(preserved.note,'preserve historical note');pass('schema 010 upgrade to 012 preserves private Organizer history');
  database=new DatabaseManager({...loadDatabaseConfig(config),queueLimit:100});assert.equal(await database.checkReady(),true);
  const credential=await hashPassword('fixture-password-only-2026');
  for(let id=1;id<=50;id++)await database.execute('INSERT INTO users(id,username,normalized_username,password_salt,password_hash,password_parameters) VALUES(?,?,?,?,?,?)',[id,`fixture-${id}`,`fixture-${id}`,credential.salt,credential.hash,JSON.stringify(credential.parameters)]);
  await provisionLearningCreator({configPath:config,userId:1,confirm:'CREATOR:1'});
  const service=createLearningService({database,publicOrigin:'https://classroom.example.test'}),activities=createActivityService({database,transaction:service.transaction,publicOrigin:'https://classroom.example.test'});
  const {id:workspace}=await service.createWorkspace(1,'測試組織');const {id:otherWorkspace}=await service.createWorkspace(1,'另一組織');
  await service.grant(1,workspace,{userId:2,role:'manager',active:true});
  await assert.rejects(service.grant(2,workspace,{userId:3,role:'manager',active:true}),{status:403});
  await assert.rejects(service.createClassroom(2,otherWorkspace,'越權'),{status:403});
  await service.grant(2,workspace,{userId:3,role:'teacher',active:true});await assert.rejects(service.grant(3,workspace,{userId:4,role:'teacher',active:true}),{status:403});
  await assert.rejects(service.grant(2,workspace,{userId:2,role:'teacher',active:true}),{status:403});
  const {id:classroom}=await service.createClassroom(2,workspace,'307');const {id:anotherClass}=await service.createClassroom(2,workspace,'307');
  await service.assign(2,classroom,{userId:3,active:true});await assert.rejects(service.classroom(3,anotherClass),{status:404});pass('creator-manager-teacher chain and workspace/classroom isolation');
  const {id:policy}=await service.policy(2,classroom);const token=await service.displayToken(3,classroom,policy);
  assert.equal((await service.preview(token.token)).classroom,'307');
  const joined=await Promise.all([service.join(4,token.token),service.join(4,token.token)]);assert.equal(joined.filter((r)=>!r.alreadyJoined).length,1);
  assert.equal((await service.notifications(4)).notifications.length,1);await assert.rejects(service.join(3,token.token),{status:409});
  for(let id=5;id<=49;id++)await service.join(id,token.token);
  await service.assign(2,classroom,{userId:3,active:false});await assert.rejects(service.preview(token.token),{status:410});
  await service.assign(2,classroom,{userId:3,active:true});await service.revoke(2,classroom,policy);await assert.rejects(service.join(50,token.token),{status:410});pass('concurrent confirmed joins deduplicate notifications; revoked issuer and policy invalidate tokens');
  const make=async(title,students)=>{
    const {id}=await activities.create(3,classroom,{title,scheduledAt:'2026-10-26T09:00+08:00'});
    let detail=await activities.detail(3,id);
    for(const p of detail.participants)if(!students.includes(p.user_id)){await activities.prepare(3,id,{action:'exclude',userId:p.user_id,excluded:true,version:detail.activity.version});detail=await activities.detail(3,id);}
    for(const name of ['A','B','C']){await activities.prepare(3,id,{action:'group',name,version:detail.activity.version});detail=await activities.detail(3,id);}
    for(const [index,userId]of students.entries()){await activities.prepare(3,id,{action:'move',userId,groupId:detail.groups[index%3].id,version:detail.activity.version});detail=await activities.detail(3,id);}
    await assert.rejects(activities.prepare(3,id,{action:'move',userId:50,groupId:detail.groups[0].id,version:detail.activity.version}),{status:422});
    await assert.rejects(activities.prepare(3,id,{action:'group',name:'stale',version:1}),{status:409});
    await activities.transition(3,id,{action:'start',version:detail.activity.version});return id;
  };
  const activity=await make('三組分數 fixture',[4,5,6,7,8,9]);
  const transition=async(id,action,extra={})=>{const d=await activities.detail(3,id);return activities.transition(3,id,{action,version:d.activity.version,...extra});};
  let detail=await activities.detail(3,activity);await transition(activity,'present',{groupId:detail.groups[0].id});
  const openVersion=(await activities.detail(3,activity)).activity.version;
  const simultaneousOpen=await Promise.allSettled([activities.transition(3,activity,{action:'open',version:openVersion}),activities.transition(3,activity,{action:'open',version:openVersion})]);
  assert.equal(simultaneousOpen.filter((r)=>r.status==='fulfilled').length,1);const round=simultaneousOpen.find((r)=>r.status==='fulfilled').value;pass('two concurrent open-round requests create exactly one collecting round');
  await assert.rejects(activities.prepare(3,activity,{action:'move',userId:4,groupId:detail.groups[1].id,version:detail.activity.version}),{status:409});
  assert.equal((await activities.resolve(4,round.token)).canSubmit,false);
  const criteria=detail.criteria;
  const body=(values,key=randomUUID())=>({requestKey:key,scores:values.map((score,i)=>({criterionId:criteria[i].id,score})),comment:'<img src=x onerror=alert(1)>'});
  await assert.rejects(activities.submit(4,round.roundId,body([5,5,5])),{status:403});
  const bodies=[[5,4,3],[4,4,4],[3,3,3],[5,5,5]].map((v)=>body(v));
  const students=[5,6,8,9];for(let i=0;i<4;i++)await activities.submit(students[i],round.roundId,bodies[i]);
  await transition(activity,'close');assert.equal((await activities.submit(5,round.roundId,bodies[0])).replayed,true);
  await assert.rejects(activities.submit(5,round.roundId,{...bodies[0],comment:'changed'}),{status:409});
  let results=await activities.results(3,activity);assert.equal(results.groups[0].average,4);assert.deepEqual(results.groups[0].criteria.map((c)=>c.average),[4.25,4,3.75]);
  await assert.rejects(activities.results(5,activity),{status:403});
  const raw=await activities.results(3,activity,{details:true});await activities.void(3,activity,raw.evaluations[3].id,{reason:'測試作廢'});
  results=await activities.results(3,activity);assert.equal(results.groups[0].valid,3);assert.ok(Math.abs(results.groups[0].average-11/3)<0.00001);
  assert.deepEqual(results.groups[0].criteria.map((c)=>Number(c.average.toFixed(2))),[4,3.67,3.33]);
  await transition(activity,'end');await transition(activity,'publish');const studentResult=await activities.results(5,activity,{details:true});assert.equal(studentResult.evaluations,undefined);pass('exact rubric aggregates, self-evaluation rejection, void retention, receipt replay and published privacy');
  const copy=await activities.copy(3,activity,{title:'Copied fixture',scheduledAt:'2026-10-27T11:00+08:00'});const copied=await activities.detail(3,copy.id);assert.equal(copied.activity.status,'draft');assert.equal(copied.groups.length,3);assert.equal((await activities.collection(3,copy.id)).rounds.length,0);pass('ended activity copies into a fresh draft without old evaluations');
  await assert.rejects(database.execute('INSERT INTO learning_scores(evaluation_id,activity_id,criterion_id,score) VALUES(?,?,?,?)',[raw.evaluations[0].id,activity,copied.criteria[0].id,4]),(error)=>error.code==='ER_NO_REFERENCED_ROW_2');pass('composite foreign key rejects a criterion belonging to another activity');
  const {id:load}=await activities.create(3,classroom,{title:'40 eligible concurrent',scheduledAt:'2026-10-26T10:00+08:00'});
  detail=await activities.detail(3,load);
  for(const p of detail.participants)if(p.user_id>45){await activities.prepare(3,load,{action:'exclude',userId:p.user_id,excluded:true,version:detail.activity.version});detail=await activities.detail(3,load);}
  for(const name of ['Target','Reviewers']){await activities.prepare(3,load,{action:'group',name,version:detail.activity.version});detail=await activities.detail(3,load);}
  for(let userId=4;userId<=45;userId++){await activities.prepare(3,load,{action:'move',userId,groupId:detail.groups[userId<6?0:1].id,version:detail.activity.version});detail=await activities.detail(3,load);}
  await transition(load,'start');await transition(load,'present',{groupId:detail.groups[0].id});const loadRound=await transition(load,'open');const loadCriteria=detail.criteria;
  const submissions=Array.from({length:40},(_,i)=>({actor:i+6,body:{requestKey:randomUUID(),scores:loadCriteria.map((c)=>({criterionId:c.id,score:4})),comment:''}}));
  const start=performance.now();const outcomes=await Promise.allSettled(submissions.map(({actor,body})=>activities.submit(actor,loadRound.roundId,body)));const elapsed=performance.now()-start;
  assert.equal(outcomes.filter((o)=>o.status==='fulfilled').length,40,JSON.stringify(outcomes.filter((o)=>o.status==='rejected').map((o)=>o.reason.message)));
  const retries=await Promise.all(submissions.slice(0,4).map(({actor,body})=>activities.submit(actor,loadRound.roundId,body)));assert.ok(retries.every((r)=>r.replayed));
  assert.equal((await activities.collection(3,load)).rounds[0].received,40);pass(`40 distinct concurrent evaluations: ${elapsed.toFixed(0)} ms, failures 0/40; retries do not duplicate`);
  // Genuine lock race. An accepted evaluation is serialized before close; no new receipt may appear after close.
  await transition(load,'close');detail=await activities.detail(3,load);await transition(load,'present',{groupId:detail.groups[1].id});const raceRound=await transition(load,'open');
  const raceBody={requestKey:randomUUID(),scores:loadCriteria.map((c)=>({criterionId:c.id,score:3})),comment:''};
  const race=await Promise.allSettled([activities.submit(4,raceRound.roundId,raceBody),transition(load,'close',{confirmIncomplete:true})]);assert.equal(race[1].status,'fulfilled');
  const before=(await activities.collection(3,load)).rounds.find((r)=>r.id===raceRound.roundId).received;
  await assert.rejects(activities.submit(5,raceRound.roundId,{...raceBody,requestKey:randomUUID()}),{status:410});
  assert.equal((await activities.collection(3,load)).rounds.find((r)=>r.id===raceRound.roundId).received,before);pass(`close vs submit real concurrency: submit ${race[0].status}, no new rows after close`);
  const [linear]=await database.execute('SELECT COUNT(*) AS invalid FROM learning_evaluations e JOIN learning_rounds r ON r.id=e.round_id WHERE r.id=? AND e.created_at>r.closed_at',[raceRound.roundId]);assert.equal(linear.invalid,0);
  const copiedDetail=await activities.detail(3,copy.id);
  const updated=await Promise.allSettled([activities.order(3,copy.id,{version:copiedDetail.activity.version,groupIds:copiedDetail.groups.map((g)=>g.id).reverse()}),activities.order(3,copy.id,{version:copiedDetail.activity.version,groupIds:copiedDetail.groups.map((g)=>g.id)})]);assert.equal(updated.filter((r)=>r.status==='fulfilled').length,1);pass('concurrent stale order updates have one winner and never overwrite silently');
  const freshPolicy=await service.policy(2,classroom),expiring=await service.displayToken(3,classroom,freshPolicy.id);
  await service.preview(expiring.token);await database.execute('UPDATE learning_invite_policies SET expires_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?',[freshPolicy.id]);await assert.rejects(service.join(50,expiring.token),{status:410});pass('expiry between preview and confirmation cannot create membership');
  const archivePolicy=await service.policy(2,anotherClass),archiveToken=await service.displayToken(2,anotherClass,archivePolicy.id);await service.archive(2,anotherClass);await assert.rejects(service.join(50,archiveToken.token),{status:410});await assert.rejects(service.preview('x'.repeat(43)),{status:410});pass('archived classroom and unknown invite cannot admit students');
  await service.grant(2,workspace,{userId:3,role:'teacher',active:false});await assert.rejects(activities.collection(3,load),{status:404});pass('teacher revocation applies on next operation, stored evaluations retained');
  {
    await service.grant(2,workspace,{userId:3,role:'teacher',active:true});
    let handler,security;const staticHandler=createRequestHandler({root:testDist});
    httpServer=createHttpServer(async(req,res)=>{applySecurityHeaders(res,security);if(!await handler(req,res))await staticHandler(req,res);});
    await new Promise((done)=>httpServer.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${httpServer.address().port}`;
    security=createSecurityPolicy({canonicalUrl:base,bindAddress:'127.0.0.1'});
    handler=createApiHandler({database,security,learning:{enabled:true,publicOrigin:base}});
    const request=async(path,{method='GET',body,cookie,origin=base}={})=>{
      const response=await fetch(base+path,{method,headers:{origin,...(cookie?{cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
      return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')};
    };
    const login=async(id)=>{const r=await request('/api/auth/login',{method:'POST',body:{username:`fixture-${id}`,password:'fixture-password-only-2026'}});assert.equal(r.status,200);return r.cookie.split(';')[0];};
    const teacherCookie=await login(3),managerCookie=await login(2),studentCookie=await login(6);
    assert.equal((await request(`/api/learning/workspaces/${workspace}/roles`,{method:'PUT',cookie:managerCookie,body:{userId:6,role:'manager',active:true}})).status,403);
    assert.equal((await request(`/api/learning/classrooms/${anotherClass}`,{cookie:teacherCookie})).status,404);
    assert.equal((await request(`/api/learning/activities/${load}/collection`,{cookie:studentCookie})).status,404);
    assert.equal((await request('/api/learning/workspaces',{method:'POST',cookie:studentCookie,origin:'https://attacker.test',body:{name:'bad'}})).status,403);
    const privateSchedule=await request('/api/timetable',{cookie:studentCookie});assert.equal(privateSchedule.status,200);
    await service.grant(2,workspace,{userId:3,role:'teacher',active:false});assert.equal((await request(`/api/learning/classrooms/${classroom}`,{cookie:teacherCookie})).status,404);
    await service.grant(2,workspace,{userId:3,role:'teacher',active:true});
    const disabledCookie=await login(49);await database.execute("UPDATE users SET account_status='disabled' WHERE id=49");assert.equal((await request('/api/learning/home',{cookie:disabledCookie})).status,401);
    const noFeature=createApiHandler({database,security});handler=noFeature;assert.equal((await request('/api/learning/home',{cookie:studentCookie})).status,404);assert.equal((await request('/api/timetable',{cookie:studentCookie})).status,200);
    handler=createApiHandler({database,security,learning:{enabled:true,publicOrigin:base}});pass('HTTP session authorization, CSRF, cross-class IDOR, disabled account and feature-off Organizer compatibility');
    const httpActivity=await activities.copy(3,load,{title:'Forty HTTP sessions',scheduledAt:'2026-10-27T10:00+08:00'});
    let httpDetail=await activities.detail(3,httpActivity.id);await transition(httpActivity.id,'start');await transition(httpActivity.id,'present',{groupId:httpDetail.groups[0].id});const httpRound=await transition(httpActivity.id,'open');
    const httpStudents=await Promise.all(Array.from({length:40},async(_,index)=>({actor:index+6,cookie:await login(index+6)})));
    const httpStarted=performance.now();const httpResults=await Promise.all(httpStudents.map((student)=>request(`/api/learning/rounds/${httpRound.roundId}/submit`,{method:'POST',cookie:student.cookie,body:{requestKey:randomUUID(),scores:httpDetail.criteria.map((c)=>({criterionId:c.id,score:4})),comment:''}})));
    assert.equal(httpResults.filter((r)=>r.status===200).length,40,JSON.stringify(httpResults.filter((r)=>r.status!==200)));
    assert.equal((await activities.collection(3,httpActivity.id)).rounds[0].received,40);pass(`40 authenticated HTTP submissions from one NAT, 5 DB connections: ${(performance.now()-httpStarted).toFixed(0)} ms, failures 0/40`);
    const {id:tenGroups}=await activities.create(3,classroom,{title:'40 students, ten groups',scheduledAt:'2026-10-27T11:00+08:00'});
    let ten=await activities.detail(3,tenGroups);await assert.rejects(activities.transition(3,tenGroups,{action:'start',version:ten.activity.version}),{status:409});
    const chosen=ten.participants.slice(0,40).map((p)=>p.user_id);assert.equal(chosen.length,40);
    for(const p of ten.participants.filter((p)=>!chosen.includes(p.user_id))){await activities.prepare(3,tenGroups,{action:'exclude',userId:p.user_id,excluded:true,version:ten.activity.version});ten=await activities.detail(3,tenGroups);}
    for(let index=0;index<10;index++){await activities.prepare(3,tenGroups,{action:'group',name:`Group ${index+1}`,version:ten.activity.version});ten=await activities.detail(3,tenGroups);}
    for(const [index,userId]of chosen.entries()){await activities.prepare(3,tenGroups,{action:'move',userId,groupId:ten.groups[index%10].id,version:ten.activity.version});ten=await activities.detail(3,tenGroups);}
    await activities.transition(3,tenGroups,{action:'start',version:ten.activity.version});const tenResult=await activities.results(3,tenGroups);assert.equal(tenResult.groups.length,10);assert.ok(tenResult.groups.every((g)=>g.average===null));pass('40-student ten-group preparation starts successfully; ungrouped start is rejected and zero submissions stay null');
    const raceActivity=await activities.copy(3,load,{title:'membership race',scheduledAt:'2026-10-27T10:00+08:00'});
    let raceDetail=await activities.detail(3,raceActivity.id);await transition(raceActivity.id,'start');await transition(raceActivity.id,'present',{groupId:raceDetail.groups[0].id});const membershipRound=await transition(raceActivity.id,'open');
    const membershipBody={requestKey:randomUUID(),scores:raceDetail.criteria.map((c)=>({criterionId:c.id,score:3})),comment:''};
    const removalRace=await Promise.allSettled([activities.submit(6,membershipRound.roundId,membershipBody),service.removeStudent(3,classroom,6)]);assert.equal(removalRace[1].status,'fulfilled');
    await assert.rejects(activities.submit(6,membershipRound.roundId,{...membershipBody,requestKey:randomUUID()}),(error)=>[403,404].includes(error.status));
    const receivedBefore=(await activities.collection(3,raceActivity.id)).rounds[0].received;assert.equal(receivedBefore,removalRace[0].status==='fulfilled'?1:0);pass(`real removal vs submit race: ${removalRace[0].status}; history retained, subsequent submission denied`);
    const disabledRace=await Promise.allSettled([activities.submit(7,membershipRound.roundId,{...membershipBody,requestKey:randomUUID()}),database.execute("UPDATE users SET account_status='disabled' WHERE id=7")]);assert.equal(disabledRace[1].status,'fulfilled');
    await assert.rejects(activities.submit(7,membershipRound.roundId,{...membershipBody,requestKey:randomUUID()}),{status:403});pass(`real account disable vs submit race: ${disabledRace[0].status}; next request denied`);
    const revokeRace=await Promise.allSettled([activities.roundLink(3,raceActivity.id,{}),service.grant(2,workspace,{userId:3,role:'teacher',active:false})]);assert.equal(revokeRace[1].status,'fulfilled');await assert.rejects(activities.roundLink(3,raceActivity.id,{}),{status:404});await service.grant(2,workspace,{userId:3,role:'teacher',active:true});pass(`real teacher revocation vs action race: ${revokeRace[0].status}; next action denied`);
    if(process.argv.includes('--browser')){
    const browserService=createLearningService({database,publicOrigin:base}),browserActivities=createActivityService({database,transaction:browserService.transaction,publicOrigin:base});
    const {testLearningBrowser}=await import('./learning-browser.mjs');console.log(JSON.stringify(await testLearningBrowser({base,service:browserService,activities:browserActivities,classroom})));pass('browser acceptance with separate account sessions and decoded real QR');
    }
    if(process.argv.includes('--regression')){
      const regression=spawnSync(process.execPath,['tests/integration/database.mjs','--config',config],{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(regression.status,0,regression.stdout+regression.stderr);console.log(regression.stdout);pass('existing Organizer MySQL integration suite on the isolated server');
      const oldDump=join(root,'incompatible-old.sql');writeFileSync(oldDump,'-- MySQL dump test\nCREATE TABLE `users` (id INT);\n');
      await assert.rejects(restoreDatabase({configPath:config,backupPath:oldDump,migrationsPath:resolve('db/migrations')}),/omits existing classroom/);
      const [beforeRestore]=await database.execute('SELECT COUNT(*) AS count FROM learning_evaluations');
      const dumpPath=join(root,'complete.sql'),settings=loadDatabaseConfig(config),option=createTemporaryOptionFile(settings);
      try{
        const dump=spawnSync(join(bin,'mysqldump.exe'),[`--defaults-extra-file=${option.optionPath}`,'--single-transaction','--no-tablespaces','--set-gtid-purged=OFF',`--result-file=${dumpPath}`,'--databases',dbName],{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(dump.status,0,dump.stderr);
      }finally{option.remove();}
      assert.equal(verifyBackupDump(readFileSync(dumpPath),{database:dbName}).valid,true);
      await restoreDatabase({configPath:config,backupPath:dumpPath,migrationsPath:resolve('db/migrations')});
      const [afterRestore]=await database.execute('SELECT COUNT(*) AS count FROM learning_evaluations');assert.equal(afterRestore.count,beforeRestore.count);
      const restartedService=createActivityService({database,transaction:service.transaction,publicOrigin:base});assert.equal((await restartedService.results(3,activity)).groups[0].valid,3);
      const checkCode="import {loadDatabaseConfig,databaseConnectionOptions} from './db/core/config.mjs';import {createDatabaseConnection} from './db/core/mysql-driver.mjs';const c=await createDatabaseConnection(databaseConnectionOptions(loadDatabaseConfig(process.argv[1])));try{const [[r]]=await c.query('SELECT COUNT(*) AS count FROM learning_evaluations');if(r.count<40)throw Error('Missing persisted evaluations');console.log('Independent restarted Node process reads persisted evaluations:',r.count);}finally{await c.end();}";
      const restarted=spawnSync(process.execPath,['--input-type=module','-e',checkCode,config],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(restarted.status,0,restarted.stdout+restarted.stderr);console.log(restarted.stdout);pass('incompatible restore rejected before import; full backup/restore and independent Node process preserve evaluations');
      await new Promise((done)=>httpServer.close(done));httpServer=null;
      restartRuntime=resolve('runtime',`learning-restart-${randomUUID()}`);mkdirSync(restartRuntime,{recursive:true});
      const hostConfig=join(root,'test-host.json');writeFileSync(hostConfig,JSON.stringify({port:Number(new URL(base).port),bindAddress:'127.0.0.1',canonicalUrl:base,installPath:resolve('.'),currentPath:testDist,runPath:join(restartRuntime,'run'),logPath:join(restartRuntime,'logs'),databaseConfigPath:config,logRetentionDays:1,logMaxBytes:1000000,classroomActivitiesEnabled:true}));
      restartedHost=spawn(process.execPath,['server/app/server.mjs','--config',hostConfig],{windowsHide:true,env:{...process.env,WDWELT_TEST_PORT:'1'},stdio:['ignore','pipe','pipe']});let hostOutput='';restartedHost.stdout.on('data',(chunk)=>{hostOutput+=chunk;});restartedHost.stderr.on('data',(chunk)=>{hostOutput+=chunk;});
      for(let attempt=0;attempt<100;attempt++){assert.equal(restartedHost.exitCode,null,hostOutput);try{if((await fetch(base+'/health/ready')).ok)break;}catch{}if(attempt===99)throw Error(hostOutput);await new Promise((done)=>setTimeout(done,100));}
      const freshCookie=await login(3);const persisted=await request(`/api/learning/activities/${activity}/results`,{cookie:freshCookie});assert.equal(persisted.status,200);assert.equal(persisted.body.groups[0].valid,3);pass('actual Host process restart on isolated random port, fresh login and persisted results');
      const [ledger]=await database.execute("SELECT checksum FROM schema_migrations WHERE migration_id='012_learning_activities.sql'");
      await database.execute("DELETE FROM schema_migrations WHERE migration_id='012_learning_activities.sql'");
      try{
        assert.equal((await fetch(base+'/health/ready')).status,200);
        assert.equal((await request('/api/learning/status')).body.ready,false);
        assert.equal((await request('/api/learning/home',{cookie:freshCookie})).status,503);
        assert.equal((await request('/api/timetable',{cookie:freshCookie})).status,200);
      }finally{await database.execute('INSERT INTO schema_migrations(migration_id,checksum) VALUES(?,?)',['012_learning_activities.sql',ledger.checksum]);}
      pass('real Host missing-module-schema status is unavailable while Organizer and core health stay ready');
    }
  }
  console.log(JSON.stringify({passed:checks.length,checks,database:dbName,port,productionTouched:false},null,2));
}finally{
  if(restartedHost&&restartedHost.exitCode===null){restartedHost.kill();await once(restartedHost,'exit');}
  if(httpServer)await new Promise((done)=>httpServer.close(done));
  if(database)await database.close();
  if(connection){try{await connection.query('SHUTDOWN');}catch{}await connection.end().catch(()=>{});}
  if(server&&server.exitCode===null){await Promise.race([once(server,'exit'),new Promise((done)=>setTimeout(done,5000))]);if(server.exitCode===null){server.kill();await once(server,'exit');}}
  assert.ok(resolve(root).startsWith(resolve(tmpdir())+'\\'));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  if(restartRuntime){assert.ok(restartRuntime.startsWith(resolve('runtime')+'\\learning-restart-'));rmSync(restartRuntime,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
}
