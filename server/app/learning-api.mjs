import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createLearningService, learningId, LearningError } from './learning.mjs';
import { createFixedWindowLimiter } from './security.mjs';
import { createActivityService } from './learning-activities.mjs';

const migrations=['011_classroom_identity.sql','012_learning_activities.sql'];
const checks=migrations.map((name)=>({name,checksum:createHash('sha256').update(readFileSync(new URL(`../../db/migrations/${name}`,import.meta.url),'utf8').replace(/^\uFEFF/,'')).digest('hex')}));

export function createLearningApi({database,enabled=false,publicOrigin=null,log=()=>{},limits={}}) {
  const service=createLearningService({database,publicOrigin});
  const activities=createActivityService({database,transaction:service.transaction,publicOrigin});
  const limiter=createFixedWindowLimiter();
  const limited=(key,limit)=>{
    const result=limiter.consume('learning',key,{limit,windowMs:60_000});
    if(!result.allowed){const error=new LearningError(429,'操作過於頻繁，請稍後再試');error.headers={'Retry-After':String(result.retryAfter)};throw error;}
  };
  const readiness=async()=>{
    for(const check of checks)if(!await database.hasMigration(check.name,check.checksum))return false;
    return true;
  };
  return async({request,url,user,readJson,sendJson,response})=>{
    if(!url.pathname.startsWith('/api/learning/'))return false;
    if(!enabled)throw new LearningError(404,'課堂活動尚未啟用');
    if(url.pathname==='/api/learning/status'&&request.method==='GET'){
      sendJson(response,200,{enabled:true,ready:await readiness()});return true;
    }
    if(!await readiness())throw new LearningError(503,'課堂活動資料庫尚未就緒，請管理員套用 migration 011、012');
    const path=url.pathname.slice('/api/learning'.length);
    const method=request.method;
    try{
      if(path==='/join/preview'&&method==='POST'){
        // Anonymous Funnel requests share a proxy; this large safety bucket is not a per-class student quota.
        limited(`preview:${user?.id??'anonymous'}`,limits.lookup??600);
        sendJson(response,200,await service.preview((await readJson(request)).token));return true;
      }
      if(!user)throw new LearningError(401,'請先登入');
      const actor=user.id;
      if(method!=='GET')limited(`mutation:${actor}`,limits.mutations??60);
      let value;
      if(path==='/home'&&method==='GET')value=await service.home(actor);
      else if(path==='/workspaces'&&method==='POST')value=await service.createWorkspace(actor,(await readJson(request)).name);
      else if(path==='/join/confirm'&&method==='POST')value=await service.join(actor,(await readJson(request)).token);
      else if(path==='/notifications'&&method==='GET')value=await service.notifications(actor);
      else {
        let match=path.match(/^\/notifications\/(\d+)\/read$/);
        if(match&&method==='POST')value=await service.readNotification(actor,learningId(match[1]));
        else if((match=path.match(/^\/workspaces\/(\d+)\/(roles|accounts|classrooms)$/))){
          const id=learningId(match[1]);
          if(match[2]==='roles'&&method==='PUT')value=await service.grant(actor,id,await readJson(request));
          else if(match[2]==='accounts'&&method==='GET')value=await service.accounts(actor,id,url.searchParams.get('q')??'');
          else if(match[2]==='classrooms'&&method==='POST')value=await service.createClassroom(actor,id,(await readJson(request)).name);
        }else if((match=path.match(/^\/classrooms\/(\d+)(?:\/(teachers|archive|policies|activities|leave))?$/))){
          const id=learningId(match[1]);
          if(!match[2]&&method==='GET')value=await service.classroom(actor,id);
          else if(match[2]==='teachers'&&method==='PUT')value=await service.assign(actor,id,await readJson(request));
          else if(match[2]==='archive'&&method==='POST')value=await service.archive(actor,id);
          else if(match[2]==='leave'&&method==='POST')value=await service.leave(actor,id);
          else if(match[2]==='policies'&&method==='POST')value=await service.policy(actor,id,await readJson(request));
          else if(match[2]==='activities'&&method==='GET')value=await activities.list(actor,id);
          else if(match[2]==='activities'&&method==='POST')value=await activities.create(actor,id,await readJson(request));
        }else if((match=path.match(/^\/classrooms\/(\d+)\/policies\/(\d+)\/(revoke|display)$/))&&method==='POST'){
          const id=learningId(match[1]),policy=learningId(match[2]);
          if(match[3]==='revoke')value=await service.revoke(actor,id,policy);
          else {limited(`display:${actor}`,limits.display??10);value=await service.displayToken(actor,id,policy);}
        }else if((match=path.match(/^\/classrooms\/(\d+)\/students\/(\d+)\/remove$/))&&method==='POST')value=await service.removeStudent(actor,learningId(match[1]),learningId(match[2]));
        else if((match=path.match(/^\/activities\/(\d+)(?:\/(prepare|order|transition|collection|results|round-link|copy))?$/))){
          const id=learningId(match[1]);const mode=url.searchParams.get('managementMode')==='true';
          if(!match[2]&&method==='GET')value=await activities.detail(actor,id,mode);
          else if(match[2]==='prepare'&&method==='POST')value=await activities.prepare(actor,id,await readJson(request));
          else if(match[2]==='copy'&&method==='POST')value=await activities.copy(actor,id,await readJson(request));
          else if(match[2]==='order'&&method==='PUT')value=await activities.order(actor,id,await readJson(request));
          else if(match[2]==='transition'&&method==='POST')value=await activities.transition(actor,id,await readJson(request));
          else if(match[2]==='round-link'&&method==='POST'){limited(`display:${actor}`,limits.display??10);value=await activities.roundLink(actor,id,await readJson(request));}
          else if(match[2]==='collection'&&method==='GET')value=await activities.collection(actor,id,mode);
          else if(match[2]==='results'&&method==='GET')value=await activities.results(actor,id,{managementMode:mode,details:url.searchParams.get('details')==='true',page:url.searchParams.get('page')});
        }else if((match=path.match(/^\/activities\/(\d+)\/evaluations\/(\d+)\/void$/))&&method==='POST')value=await activities.void(actor,learningId(match[1]),learningId(match[2]),await readJson(request));
        else if(path==='/evaluate/resolve'&&method==='POST')value=await activities.resolve(actor,(await readJson(request)).token);
        else if((match=path.match(/^\/rounds\/(\d+)\/submit$/))&&method==='POST'){
          limited(`submit:${actor}`,limits.submit??30);value=await activities.submit(actor,learningId(match[1]),await readJson(request));
        }else if((match=path.match(/^\/rounds\/(\d+)\/receipt$/))&&method==='GET')value=await activities.myReceipt(actor,learningId(match[1]));
      }
      if(value===undefined)throw new LearningError(404,'找不到課堂活動操作');
      sendJson(response,200,value);return true;
    }catch(error){
      if(error.status)throw error;
      const correlationId=randomUUID();log('error','learning_api_error',`correlation=${correlationId} path=${path.replace(/[^/]+$/,'operation')} code=${error.code??'unknown'}`);
      if(['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR','ECONNREFUSED','ETIMEDOUT'].includes(error.code)||error.name==='DatabaseUnavailableError')throw new LearningError(503,`課堂活動暫時無法使用（${correlationId}）`);
      throw new LearningError(500,`課堂活動處理失敗（${correlationId}）`);
    }
  };
}
