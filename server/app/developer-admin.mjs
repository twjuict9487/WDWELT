import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifyPassword, hashPassword, normalizeUsername, validatePassword } from '../../db/core/password.mjs';
import { SAFE_ADMIN_HTML } from './developer-admin-ui.mjs';

const MAX_BODY = 32 * 1024;
const SESSION_MS = 30 * 60_000;
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const sessions = new Map();

const json = (response, status, value, headers = {}) => {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Content-Length':body.length, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...headers });
  response.end(body);
};
const text = (response, status, body, type='text/plain; charset=utf-8') => {
  const content=Buffer.from(body); response.writeHead(status,{'Content-Type':type,'Content-Length':content.length,'Cache-Control':'no-store','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"}); response.end(content);
};
const cookie = (request, name) => (request.headers.cookie ?? '').split(';').map((part)=>part.trim()).find((part)=>part.startsWith(`${name}=`))?.slice(name.length+1) ?? null;
const local = (request) => LOCAL_ADDRESSES.has(request.socket?.remoteAddress);
const clean = (value, maximum) => {
  if (typeof value !== 'string') throw Object.assign(new Error('Invalid text value.'),{status:400});
  const result=value.normalize('NFKC').trim(); if(result.length>maximum) throw Object.assign(new Error('Text is too long.'),{status:400}); return result;
};
async function body(request) {
  if(Number(request.headers['content-length']??0)>MAX_BODY) throw Object.assign(new Error('Request body too large.'),{status:413});
  const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>MAX_BODY)throw Object.assign(new Error('Request body too large.'),{status:413});chunks.push(chunk);}
  try{const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();return parsed;}catch{throw Object.assign(new Error('Invalid JSON body.'),{status:400});}
}
function sessionFor(request) {
  const token=cookie(request,'wdwelt_developer'); if(!token)return null; const record=sessions.get(token); if(!record||record.expiresAt<=Date.now()){sessions.delete(token);return null;} record.expiresAt=Date.now()+SESSION_MS; return record;
}
function requireAdmin(request) {
  const session=sessionFor(request); if(!session)throw Object.assign(new Error('Developer authentication required.'),{status:401});
  if(request.method!=='GET'&&request.headers['x-wdwelt-admin-csrf']!==session.csrf)throw Object.assign(new Error('CSRF validation failed.'),{status:403}); return session;
}
const safeDetails = (details) => JSON.stringify(details);

export function loadDeveloperCredentials(path) {
  const raw=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
  if(!raw.normalizedUsername||!raw.passwordSalt||!raw.passwordHash||!raw.passwordParameters)throw new Error('Developer credential file is invalid.');
  return {...raw,passwordSalt:Buffer.from(raw.passwordSalt,'base64'),passwordHash:Buffer.from(raw.passwordHash,'base64')};
}

export function createDeveloperAdminHandler({database,credentials,log=()=>{}}) {
  let failed=0;let blockedUntil=0;
  return async(request,response)=>{
    if(!local(request)){log('warning','developer_remote_rejected','Non-loopback developer request rejected.');json(response,404,{error:'Not found.'});return;}
    const url=new URL(request.url??'/','http://127.0.0.1');
    try{
      if(url.pathname==='/'&&request.method==='GET'){text(response,200,SAFE_ADMIN_HTML,'text/html; charset=utf-8');return;}
      if(url.pathname==='/api/login'&&request.method==='POST'){
        if(Date.now()<blockedUntil)throw Object.assign(new Error('Too many attempts.'),{status:429,retryAfter:Math.ceil((blockedUntil-Date.now())/1000)});
        const input=await body(request);let normalized='';try{normalized=normalizeUsername(input.username).normalizedUsername;}catch{}
        const usernameMatch=Buffer.from(normalized).length===Buffer.from(credentials.normalizedUsername).length&&timingSafeEqual(Buffer.from(normalized),Buffer.from(credentials.normalizedUsername));
        const passwordMatch=typeof input.password==='string'&&await verifyPassword(input.password,credentials.passwordSalt,credentials.passwordHash,credentials.passwordParameters);
        if(!usernameMatch||!passwordMatch){failed+=1;if(failed>=5){blockedUntil=Date.now()+15*60_000;failed=0;}log('warning','developer_login_failure','Developer login rejected.');throw Object.assign(new Error('Access denied.'),{status:401});}
        failed=0;const token=randomBytes(32).toString('base64url');const csrf=randomBytes(24).toString('base64url');sessions.set(token,{csrf,expiresAt:Date.now()+SESSION_MS});
        log('info','developer_login','Developer login succeeded.');json(response,200,{authenticated:true,csrf},{'Set-Cookie':`wdwelt_developer=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS/1000}`});return;
      }
      if(url.pathname==='/api/logout'&&request.method==='POST'){const active=requireAdmin(request);for(const[token,value]of sessions)if(value===active)sessions.delete(token);json(response,200,{authenticated:false},{'Set-Cookie':'wdwelt_developer=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});return;}
      requireAdmin(request);
      if(url.pathname==='/api/accounts'&&request.method==='GET'){
        const q=clean(url.searchParams.get('q')??'',80);const page=Math.max(1,Math.min(100000,Number(url.searchParams.get('page')??1)||1));const limit=Math.max(1,Math.min(100,Number(url.searchParams.get('limit')??25)||25));const offset=(page-1)*limit;const like=`%${q.replace(/[\\%_]/g,'\\$&')}%`;
        const rows=await database.execute(`SELECT id,username,display_name,class_name,seat_number,identity_labels,admin_notes,account_role,account_status,must_change_password,created_at,account_updated_at FROM users WHERE ?='' OR username LIKE ? ESCAPE '\\\\' OR CAST(id AS CHAR)=? OR display_name LIKE ? ESCAPE '\\\\' OR class_name LIKE ? ESCAPE '\\\\' OR seat_number LIKE ? ESCAPE '\\\\' ORDER BY id LIMIT ? OFFSET ?`,[q,like,q,like,like,like,limit,offset]);
        json(response,200,{accounts:rows.map((row)=>({...row,password_hash:undefined,password_salt:undefined})),page,limit});return;
      }
      const match=url.pathname.match(/^\/api\/accounts\/(\d+)(?:\/(identity|password|status))?$/);
      if(match&&request.method==='PATCH'){
        const userId=Number(match[1]);const action=match[2];const input=await body(request);
        await database.transaction(async(tx)=>{
          const found=await tx.execute('SELECT id FROM users WHERE id=? FOR UPDATE',[userId]);if(!found.length)throw Object.assign(new Error('Account not found.'),{status:404});
          if(action==='identity'){
            const labels=Array.isArray(input.labels)?input.labels.map((item)=>clean(item,40)).filter(Boolean).slice(0,20):[];
            await tx.execute('UPDATE users SET display_name=?,class_name=?,seat_number=?,identity_labels=?,admin_notes=?,account_updated_at=CURRENT_TIMESTAMP(3) WHERE id=?',[clean(input.displayName??'',80)||null,clean(input.className??'',40)||null,clean(input.seatNumber??'',20)||null,JSON.stringify(labels),clean(input.notes??'',500)||null,userId]);
            await tx.execute('INSERT INTO developer_audit_log(action,target_user_id,details) VALUES(?,?,?)',['identity_update',userId,safeDetails({labels,fields:['displayName','className','seatNumber','notes']})]);
          }else if(action==='password'){
            const password=validatePassword(input.temporaryPassword);if(password.length<12)throw Object.assign(new Error('Temporary password must be at least 12 characters.'),{status:400});const saved=await hashPassword(password);
            await tx.execute('UPDATE users SET password_salt=?,password_hash=?,password_parameters=?,must_change_password=TRUE,account_updated_at=CURRENT_TIMESTAMP(3) WHERE id=?',[saved.salt,saved.hash,JSON.stringify(saved.parameters),userId]);await tx.execute('DELETE FROM sessions WHERE user_id=?',[userId]);await tx.execute('DELETE FROM password_reset_tokens WHERE user_id=?',[userId]);
            await tx.execute('INSERT INTO developer_audit_log(action,target_user_id,details) VALUES(?,?,?)',['password_reset',userId,'{}']);
          }else if(action==='status'){
            const status=input.enabled===true?'active':'disabled';await tx.execute('UPDATE users SET account_status=?,account_updated_at=CURRENT_TIMESTAMP(3) WHERE id=?',[status,userId]);if(status==='disabled')await tx.execute('DELETE FROM sessions WHERE user_id=?',[userId]);await tx.execute('INSERT INTO developer_audit_log(action,target_user_id,details) VALUES(?,?,?)',['status_change',userId,safeDetails({status})]);
          }else throw Object.assign(new Error('Unknown action.'),{status:404});
        });
        log('info','developer_action',`Developer action ${action} completed for account ${userId}.`);json(response,200,{updated:true});return;
      }
      if(url.pathname==='/api/audit'&&request.method==='GET'){const rows=await database.execute('SELECT id,action,target_user_id,details,created_at FROM developer_audit_log ORDER BY id DESC LIMIT 100');json(response,200,{events:rows});return;}
      throw Object.assign(new Error('Not found.'),{status:404});
    }catch(error){const headers=error.retryAfter?{'Retry-After':String(error.retryAfter)}:{};json(response,error.status??500,{error:error.status?error.message:'Developer administration failed.'},headers);}
  };
}

export const ADMIN_HTML=`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>WDWELT Developer</title><style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem;background:#111827;color:#f9fafb}input,textarea,button{font:inherit;padding:.55rem;margin:.2rem;border-radius:.4rem}button{cursor:pointer}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #374151;padding:.5rem;text-align:left}.card{background:#1f2937;padding:1rem;border-radius:.7rem;margin:1rem 0}.muted{color:#9ca3af}</style><h1>WDWELT Developer Administration</h1><p class="muted">Only available through 127.0.0.1. Credentials are separate from WDWELT accounts.</p><div id="login" class="card"><input id="u" placeholder="Developer username" autocomplete="username"><input id="p" type="password" placeholder="Password" autocomplete="current-password"><button onclick="login()">登入</button></div><main id="app" hidden><div class="card"><input id="q" placeholder="Search username, ID, name, class, seat"><button onclick="load()">搜尋</button><button onclick="logout()">登出</button></div><div id="rows"></div></main><pre id="message"></pre><script>let csrf='';const call=async(path,options={})=>{const r=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-WDWELT-Admin-CSRF':csrf,...options.headers}});const j=await r.json();if(!r.ok)throw Error(j.error);return j};async function login(){try{const j=await call('/api/login',{method:'POST',body:JSON.stringify({username:u.value,password:p.value})});csrf=j.csrf;p.value='';login.hidden=true;app.hidden=false;load()}catch(e){message.textContent=e.message}}async function logout(){await call('/api/logout',{method:'POST'});location.reload()}const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));async function load(){try{const j=await call('/api/accounts?q='+encodeURIComponent(q.value));rows.innerHTML='<table><tr><th>ID / account</th><th>Identity</th><th>Status</th><th>Actions</th></tr>'+j.accounts.map(a=>'<tr><td>'+a.id+'<br>'+esc(a.username)+'<br><small>'+esc(a.account_role)+'</small></td><td>'+esc(a.display_name)+' / '+esc(a.class_name)+' / '+esc(a.seat_number)+'<br>'+esc((a.identity_labels||[]).join(', '))+'<br>'+esc(a.admin_notes)+'</td><td>'+esc(a.account_status)+(a.must_change_password?' / password change required':'')+'</td><td><button onclick="identity('+a.id+')">標籤／備註</button><button onclick="resetpw('+a.id+')">重設密碼</button><button onclick="status('+a.id+','+(a.account_status!=='active')+')">'+(a.account_status==='active'?'停用':'啟用')+'</button></td></tr>').join('')+'</table>'}catch(e){message.textContent=e.message}}async function identity(id){const displayName=prompt('Name')??'';const className=prompt('Class')??'';const seatNumber=prompt('Seat number')??'';const labels=(prompt('Labels, comma separated')??'').split(',');const notes=prompt('Notes')??'';await call('/api/accounts/'+id+'/identity',{method:'PATCH',body:JSON.stringify({displayName,className,seatNumber,labels,notes})});load()}async function resetpw(id){const temporaryPassword=prompt('Temporary password (12+ characters). It is never stored or logged in plaintext.');if(!temporaryPassword)return;await call('/api/accounts/'+id+'/password',{method:'PATCH',body:JSON.stringify({temporaryPassword})});load()}async function status(id,enabled){await call('/api/accounts/'+id+'/status',{method:'PATCH',body:JSON.stringify({enabled})});load()}</script></html>`;
