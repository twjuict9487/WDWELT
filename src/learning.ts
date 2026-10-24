import QRCode from 'qrcode';

type Item = Record<string, unknown>;
type Reply = Record<string, unknown>;
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const rows=(value:unknown):Item[]=>Array.isArray(value)?value as Item[]:[];
const object=(value:unknown):Item=>(value&&typeof value==='object'?value:{}) as Item;
const time=(value:unknown)=>value?new Date(String(value)).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'}):'未設定';
const stateName=(value:unknown)=>({draft:'準備中',live:'進行中',ended:'已結束',cancelled:'已取消',pending:'待報告',presenting:'報告中',collecting:'互評中',completed:'已完成'}[String(value)]??String(value));
const button=(id:string,label:string)=>`<button type="button" class="button secondary" data-learning="${id}">${label}</button>`;
const input=(name:string,label:string,type='text',value='')=>`<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" required></label>`;

export async function learningAvailable():Promise<boolean>{
  try{const r=await fetch('/api/learning/status',{credentials:'same-origin'});return r.ok&&(await r.json()).enabled===true;}catch{return false;}
}

export async function showLearningJoinPreview(container:HTMLElement|null):Promise<void>{
  if(!container||location.pathname!=='/join/')return;
  try{
    const response=await fetch('/api/learning/join/preview',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:location.hash.slice(1)})});
    if(response.status===404)return;
    const value=await response.json();if(!container.isConnected)return;
    container.innerHTML=response.ok?`<p>加入「${esc(value.workspace)}」的「${esc(value.classroom)}」。請先登入／建立帳號，之後按確認才會以學生身分加入。</p>`:`<p role="alert">${esc(value.error)}</p><a href="/">回首頁</a>`;
  }catch{if(container.isConnected)container.textContent='邀請預覽暫時無法載入，請確認連線。';}
}

// Mounted inside the existing app shell. All student drafts stay in this page instance.
export function mountLearning(root:HTMLElement):()=>void {
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  let route='home',selected=0,workspace=0,mode=false,detail:Reply={},notice='',busy=false,failures=0,loadGeneration=0;
  let token=location.hash.slice(1),qrUrl='',qrExpiry=0;
  let evaluationDraft:{requestKey:string;scores:Item[];comment:string}|null=null;
  let currentEvaluationRound:number|null=null;
  const api=async(path:string,method='GET',body?:unknown):Promise<Reply>=>{
    const response=await fetch(`/api/learning${path}`,{method,credentials:'same-origin',signal:controller.signal,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}).catch((error)=>{if(controller.signal.aborted)throw error;throw new Error('連線中斷，尚未確認操作結果；輸入已保留，請重試。');});
    const value=await response.json();if(!response.ok)throw new Error(value.error??`請求失敗 (${response.status})`);return value as Reply;
  };
  const state=()=>object(detail.activity);
  const shell=(content:string)=>{
    root.innerHTML=`<section class="panel learning-module"><div class="button-stack"><a href="/">回 Organizer</a>${button('home','我的班級／課堂活動')}${button('notifications','站內通知')}</div><h2>課堂活動</h2><p role="status" aria-live="polite">${esc(notice)}</p>${content}<div id="learning-qr"></div></section>`;
    root.querySelectorAll<HTMLButtonElement>('[data-learning]').forEach((control)=>{control.disabled=busy;control.addEventListener('click',()=>void act(control.dataset.learning!));});
    root.querySelectorAll<HTMLFormElement>('form[data-form]').forEach((form)=>form.addEventListener('submit',(event)=>{event.preventDefault();void submitForm(form);}));
    if(qrUrl)void renderQr();
  };
  const renderQr=async()=>{
    const slot=root.querySelector('#learning-qr');if(!slot)return;
    if(qrExpiry&&Date.now()>=qrExpiry){slot.textContent='展示碼已過期，請手動更新。';return;}
    const original=qrUrl;const data=await QRCode.toDataURL(original,{width:280,errorCorrectionLevel:'M'});
    if(controller.signal.aborted||qrUrl!==original||!slot.isConnected)return;
    slot.innerHTML=`<h3>掃碼開啟</h3><img width="280" height="280" alt="班級或互評連結 QR" src="${data}"><p>${qrExpiry?`有效至 ${esc(time(qrExpiry))}`:'僅在本回合開放時可提交'}</p><a href="${esc(original)}">開啟連結</a><button type="button" id="copy-learning-link">複製連結</button>`;
    slot.querySelector('#copy-learning-link')?.addEventListener('click',()=>void navigator.clipboard.writeText(original).catch(()=>{notice='無法複製，請使用開啟連結';}));
  };
  const renderHome=()=>{
    shell(`${detail.creator?`<form data-form="workspace">${input('name','工作空間名稱')}<button class="button primary">建立工作空間</button></form>`:''}
    <h3>班級</h3>${rows(detail.classrooms).map((c)=>`<p>${esc(c.workspace_name)}／${esc(c.name)} ${button(`class:${c.id}`,'開啟班級')}</p>`).join('')||'<p>尚未加入班級。請向管理員或教師取得加入連結。</p>'}
    ${rows(detail.workspaces).some((w)=>detail.creator||w.role==='manager')?`<h3>人員授權</h3>${rows(detail.workspaces).filter((w)=>detail.creator||w.role==='manager').map((w)=>`<p>${esc(w.name)} ${button(`workspace:${w.id}`,'班級與人員授權')}</p>`).join('')}`:''}`);
  };
  const renderWorkspace=()=>shell(`<h3>班級管理</h3><form data-form="classroom">${input('name','新班級名稱')}<button class="button primary">建立班級</button></form>
    <h3>指派既有帳號</h3><form data-form="search">${input('q','搜尋帳號或確切 ID')}<button class="button secondary">搜尋</button></form>
    ${rows(detail.accounts).map((u)=>`<p>ID ${u.id} · ${esc(u.username)} · ${esc(u.display_name)} ${button(`grant-teacher:${u.id}`,'授予教師')}${button(`revoke-teacher:${u.id}`,'撤銷教師')}${detail.creator?button(`grant-manager:${u.id}`,'授予管理員')+button(`revoke-manager:${u.id}`,'撤銷管理員'):''}</p>`).join('')}`);
  const renderClass=()=>{
    const c=object(detail.classroom);const manager=Boolean(c.administration),teacher=Boolean(c.teaching);
    shell(`<h3>${esc(c.name)}</h3>${teacher||manager?`<label><input id="learning-mode" type="checkbox" ${mode?'checked':''}>明確進入授權管理模式（管理者代操作須勾選）</label>
      <form data-form="activity">${input('title','活動標題')}${input('scheduledAt','台北預定時間','datetime-local')}<button class="button primary">建立報告活動</button></form>
      ${manager?`<form data-form="assign">${input('userId','已授權教師的確切 ID','number')}<select name="active"><option value="true">指派</option><option value="false">撤銷</option></select><button class="button secondary">確認班級教師指派</button></form>${button('policy','建立七天學生加入政策')}${button('archive','封存班級')}`:''}
      <h3>加入 QR</h3>${rows(detail.policies).map((p)=>`<p>#${p.id} 到期 ${esc(time(p.expires_at))} ${p.revoked?'已撤銷':button(`display:${p.id}`,'展示十五分鐘加入碼')}${manager&&!p.revoked?button(`revoke-policy:${p.id}`,'撤銷政策'):''}</p>`).join('')}
      <h3>學生名單</h3>${rows(detail.members).map((u)=>`<p>ID ${u.user_id} · ${esc(u.username)}${u.active?button(`remove-student:${u.user_id}`,'移除學生'):'（已移除）'}</p>`).join('')}`:''}
      <h3>活動</h3>${rows(detail.activities).map((a)=>`<p>${esc(a.title)} · ${esc(stateName(a.status))} ${button(`activity:${a.id}`,'開啟活動')}</p>`).join('')||'<p>尚無活動</p>'}${c.student?button('leave','離開班級'):''}`);
    root.querySelector('#learning-mode')?.addEventListener('change',(e)=>{mode=(e.target as HTMLInputElement).checked;});
  };
  const renderActivity=()=>{
    const a=state(),groups=rows(detail.groups),participants=rows(detail.participants),criteria=rows(detail.criteria);
    const current=groups.find((g)=>g.id===a.activeGroupId),next=groups.find((g)=>g.status==='pending');
    shell(`<h3>${esc(a.title)}</h3><p>${esc(stateName(a.status))} · 台北 ${esc(time(a.scheduledAt))}</p><p>目前報告：${esc(current?.name??'無')}／下一組：${esc(next?.name??'無')}</p>
      ${detail.managing&&a.status==='draft'?`<form data-form="update-activity">${input('title','修改活動標題','text',String(a.title))}${input('scheduledAt','修改台北預定時間','datetime-local',new Date(new Date(String(a.scheduledAt)).getTime()+8*60*60*1000).toISOString().slice(0,16))}<button class="button secondary">更新活動資料</button></form>`:''}
      ${detail.managing?`${a.status==='draft'?`${button('sync','同步新增學生')}${button('add-group','新增組別')}${button('criteria','修改評分項目')}${button('start','開始活動')}${button('cancel','取消活動')}`:''}
      ${a.status==='live'?`${!current&&next?button(`present:${next.id}`,'開始下一組報告'):''}${current?.status==='presenting'?button('open','開放互評並產生 QR')+button('cancel-presentation','取消本次報告'):''}${current?.status==='collecting'?button('round-link','重新展示互評 QR')+button('close','關閉互評'):''}${button('end','結束整場活動')}`:''}
      ${a.status==='ended'?button(a.published?'unpublish':'publish',a.published?'收回結果發布':'發布彙總結果'):''}
      ${['ended','cancelled'].includes(String(a.status))?button('copy','複製成新活動'):''}
      <h3>分組順序</h3>${groups.map((g,index)=>`<p>${index+1}. ${esc(g.name)} · ${esc(stateName(g.status))} ${['draft','live'].includes(String(a.status))?button(`up:${g.id}`,'上移')+button(`down:${g.id}`,'下移'):''}${a.status==='draft'?button(`rename-group:${g.id}`,'改組名')+button(`delete-group:${g.id}`,'刪除組別'):''}</p>`).join('')}
      ${a.status==='draft'?`<h3>名單與分組</h3>${participants.map((p)=>`<p>${esc(p.username)}（${p.excluded?'排除':groups.find((g)=>g.id===p.group_id)?.name??'未分組'}）${button(`move:${p.user_id}`,'分配組別')}${button(`exclude:${p.user_id}`,p.excluded?'恢復名單':'排除此活動')}</p>`).join('')}`:''}
      <h3>收分狀態</h3>${rows(detail.rounds).map((r)=>`<p>回合 ${r.id}：已收 ${r.received}／${r.expected}；有效 ${r.valid}；作廢 ${Number(r.received)-Number(r.valid)}；帳號停用 ${r.disabled}</p>`).join('')}
      ${button('results','查看結果與明細')}`:`<p>你的組別：${esc(groups.find((g)=>g.id===object(detail.mine).group_id)?.name??'尚未分組')}</p><p>請使用教師展示的互評連結。教師可查看你的評分與留言。</p>${a.published?button('results','查看已發布結果'):''}`}
      <p>評分項目：${criteria.map((c)=>esc(c.name)).join('、')}（各 1～5 分）</p>`);
  };
  const renderEvaluate=()=>{
    const receipt=object(detail.receipt);
    shell(`<h3>${esc(detail.classroom)} · ${esc(detail.activity)}</h3><p>評分對象：${esc(detail.targetGroup)}；你的組別：${esc(detail.myGroup??'未分組')}</p><p>教師可查看你的評分與留言。提交後不可修改。</p>
      ${detail.receipt?`<p>已提交，收據 #${receipt.id} · ${esc(time(receipt.submittedAt))}</p><p>${esc(receipt.comment)}</p><p>${rows(receipt.scores).map((s)=>`${s.criterionId}: ${s.score}`).join('、')}</p>`:detail.canSubmit?`<form data-form="evaluate">${rows(detail.criteria).map((c)=>`<label for="learning-score-${c.id}">${esc(c.name)}</label><select id="learning-score-${c.id}" name="score-${c.id}" required><option value="">請選擇</option>${[1,2,3,4,5].map((score)=>`<option value="${score}" ${evaluationDraft?.scores.some((s)=>s.criterionId===c.id&&s.score===score)?'selected':''}>${score}</option>`).join('')}</select>`).join('')}<label for="learning-comment">留言（選填，最多 500 字元）</label><textarea id="learning-comment" name="comment" maxlength="500">${esc(evaluationDraft?.comment??'')}</textarea><button class="button primary">確認並送出評分</button></form>`:`<p role="alert">${esc(detail.reason??'目前無法評分')}</p>`}`);
    root.querySelector('form[data-form="evaluate"]')?.addEventListener('input',captureEvaluation);
  };
  const renderResults=()=>shell(`<h3>活動結果</h3>${rows(detail.groups).map((g)=>`<p><strong>${esc(g.name)}</strong>：${g.average==null?'尚無評分':Number(g.average).toFixed(2)}；收到 ${g.received}、有效 ${g.valid}、作廢 ${g.voided}</p><p>${rows(g.criteria).map((c)=>`${esc(c.name)} ${c.average==null?'尚無評分':Number(c.average).toFixed(2)}`).join('／')}</p>`).join('')}
    ${rows(detail.evaluations).map((e)=>`<details><summary>收據 #${e.id} · ${esc(e.username)} ${e.voided?'已作廢':''}</summary><p>${esc(e.comment)}</p><p>${esc(e.void_reason)}</p>${!e.voided?button(`void:${e.id}`,'作廢（保留原始內容）'):''}</details>`).join('')}${rows(detail.evaluations).length===50?button('more-results','下一頁明細'):''}${button(`activity:${selected}`,'返回活動')}`);
  let resultPage=1;
  const captureEvaluation=()=>{
    const form=root.querySelector<HTMLFormElement>('form[data-form="evaluate"]');if(!form)return;
    const data=new FormData(form);evaluationDraft={requestKey:evaluationDraft?.requestKey??crypto.randomUUID(),scores:rows(detail.criteria).map((c)=>({criterionId:c.id,score:Number(data.get(`score-${c.id}`))})),comment:String(data.get('comment')??'')};
  };
  const render=()=>{
    if(route==='home')renderHome();else if(route==='workspace')renderWorkspace();else if(route==='class')renderClass();else if(route==='activity')renderActivity();else if(route==='evaluate')renderEvaluate();else if(route==='results')renderResults();
    else if(route==='join')shell(`<h3>確認加入班級</h3><p>你將以學生身分加入「${esc(detail.workspace)}」的「${esc(detail.classroom)}」。</p>${button('confirm-join','確認加入')}`);
    else if(route==='notifications')shell(`<h3>站內通知</h3>${rows(detail.notifications).map((n)=>`<p>已加入 ${esc(n.classroom)} · ${esc(time(n.created_at))}${n.read_at?'':button(`read:${n.id}`,'標為已讀')}</p>`).join('')||'<p>沒有通知</p>'}`);
  };
  const refresh=async()=>{
    const current=route,id=selected,generation=++loadGeneration;
    let result:Reply;
    if(route==='home')result=await api('/home');
    else if(route==='class')result={...await api(`/classrooms/${id}`),...await api(`/classrooms/${id}/activities`)};
    else if(route==='activity'){
      result=await api(`/activities/${id}?managementMode=${mode}`);
      if(result.managing)result={...result,...await api(`/activities/${id}/collection?managementMode=${mode}`)};
    }else if(route==='evaluate')result=await api('/evaluate/resolve','POST',{token});
    else if(route==='join')result=await api('/join/preview','POST',{token});
    else if(route==='notifications')result=await api('/notifications');
    else if(route==='results')result=await api(`/activities/${id}/results?managementMode=${mode}&details=true&page=${resultPage}`);
    else return;
    if(controller.signal.aborted||route!==current||selected!==id||generation!==loadGeneration)return;
    if(route==='evaluate'&&currentEvaluationRound!==Number(result.roundId)){evaluationDraft=null;currentEvaluationRound=Number(result.roundId);}
    const keepForm=route==='evaluate'&&detail.canSubmit===result.canSubmit&&!result.receipt&&Boolean(root.querySelector('form[data-form="evaluate"]'));
    detail=result;failures=0;if(!keepForm)render();
  };
  const run=async(operation:()=>Promise<void>)=>{
    if(busy)return;busy=true;loadGeneration+=1;root.querySelectorAll<HTMLButtonElement>('button').forEach((b)=>{b.disabled=true;});
    try{await operation();}catch(error){notice=error instanceof Error?error.message:'操作失敗，請重試';}finally{busy=false;if(!controller.signal.aborted)render();}
  };
  const act=async(action:string)=>run(async()=>{
    captureEvaluation();const [command,arg]=action.split(':');let result:Reply;
    if(['present','open','close','end','cancel-presentation'].includes(command)){qrUrl='';root.querySelector('#learning-qr')?.replaceChildren();}
    if(command==='home'||command==='notifications'){route=command;qrUrl='';await refresh();return;}
    if(command==='class'){route='class';selected=Number(arg);qrUrl='';await refresh();return;}
    if(command==='workspace'){workspace=Number(arg);route='workspace';qrUrl='';detail={creator:detail.creator};render();return;}
    if(command==='activity'){selected=Number(arg);route='activity';qrUrl='';await refresh();return;}
    if(command==='results'||command==='more-results'){resultPage=command==='results'?1:resultPage+1;route='results';qrUrl='';await refresh();return;}
    if(command==='copy'){
      const title=prompt('新活動標題',`${state().title}（複本）`),scheduled=prompt('台北時間，例如 2026-10-26T11:00');if(!title||!scheduled)return;
      const saved=await api(`/activities/${selected}/copy`,'POST',{title,scheduledAt:`${scheduled}+08:00`,managementMode:mode});selected=Number(saved.id);route='activity';qrUrl='';await refresh();return;
    }
    if(command==='read'){await api(`/notifications/${arg}/read`,'POST',{});await refresh();return;}
    if(command==='confirm-join'){result=await api('/join/confirm','POST',{token});notice=result.alreadyJoined?'你已加入此班級':`已以學生身分加入 ${result.classroom}`;token='';history.replaceState(null,'','/classroom/');route='home';await refresh();return;}
    if(['grant-teacher','revoke-teacher','grant-manager','revoke-manager'].includes(command)){
      if(!confirm(`確認對 ID ${arg} ${command}？請核對上方帳號。`))return;
      await api(`/workspaces/${workspace}/roles`,'PUT',{userId:Number(arg),role:command.endsWith('manager')?'manager':'teacher',active:command.startsWith('grant')});notice='授權已更新';return;
    }
    if(command==='policy'){await api(`/classrooms/${selected}/policies`,'POST',{});await refresh();return;}
    if(command==='display'){
      result=await api(`/classrooms/${selected}/policies/${arg}/display`,'POST',{});qrUrl=String(result.url??'');qrExpiry=Date.parse(String(result.expiresAt));notice=qrUrl?['localhost','127.0.0.1','[::1]'].includes(new URL(qrUrl).hostname)?'此加入碼僅供本機測試；跨裝置請設定公開網址':'加入碼已產生':'未設定可跨裝置使用的公開網址';render();return;
    }
    if(command==='revoke-policy'){await api(`/classrooms/${selected}/policies/${arg}/revoke`,'POST',{});qrUrl='';await refresh();return;}
    if(command==='archive'){if(!confirm('確認封存此班級？'))return;await api(`/classrooms/${selected}/archive`,'POST',{});route='home';await refresh();return;}
    if(command==='leave'){if(!confirm('確認離開此班級？'))return;await api(`/classrooms/${selected}/leave`,'POST',{});route='home';await refresh();return;}
    if(command==='remove-student'){if(!confirm(`確認移除學生 ID ${arg}？既有評分會保留。`))return;await api(`/classrooms/${selected}/students/${arg}/remove`,'POST',{});await refresh();return;}
    const a=state(),base={version:a.version,managementMode:mode};
    if(command==='round-link'){const result=await api(`/activities/${selected}/round-link`,'POST',{managementMode:mode});qrUrl=String(result.url??'');qrExpiry=0;render();return;}
    if(command==='add-group'){const name=prompt('組別名稱');if(!name)return;if(rows(detail.groups).some((g)=>g.name===name)&&!confirm('已有同名組別，仍要新增？'))return;await api(`/activities/${selected}/prepare`,'POST',{...base,action:'group',name});}
    else if(command==='rename-group'){const name=prompt('新組別名稱');if(!name)return;await api(`/activities/${selected}/prepare`,'POST',{...base,action:'rename-group',groupId:Number(arg),name});}
    else if(command==='delete-group'){await api(`/activities/${selected}/prepare`,'POST',{...base,action:'delete-group',groupId:Number(arg)});}
    else if(command==='sync')await api(`/activities/${selected}/prepare`,'POST',{...base,action:'sync'});
    else if(command==='criteria'){const names=prompt('評分項目，以逗號分隔',rows(detail.criteria).map((c)=>c.name).join(','));if(!names)return;await api(`/activities/${selected}/prepare`,'POST',{...base,action:'criteria',names:names.split(/[,，]/).map((n)=>n.trim())});}
    else if(command==='move'){const value=prompt(`輸入組別 ID：${rows(detail.groups).map((g)=>`${g.id}=${g.name}`).join('，')}`);if(!value)return;await api(`/activities/${selected}/prepare`,'POST',{...base,action:'move',userId:Number(arg),groupId:Number(value)});}
    else if(command==='exclude'){const p=rows(detail.participants).find((p)=>p.user_id===Number(arg));await api(`/activities/${selected}/prepare`,'POST',{...base,action:'exclude',userId:Number(arg),excluded:!p?.excluded});}
    else if(command==='up'||command==='down'){const ids=rows(detail.groups).map((g)=>g.id),index=ids.indexOf(Number(arg)),next=index+(command==='up'?-1:1);if(next<0||next>=ids.length)return;[ids[index],ids[next]]=[ids[next],ids[index]];await api(`/activities/${selected}/order`,'PUT',{...base,groupIds:ids});}
    else if(command==='void'){const reason=prompt('作廢理由（必填）');if(!reason)return;await api(`/activities/${selected}/evaluations/${arg}/void`,'POST',{reason,managementMode:mode});}
    else{
      if(['close','end'].includes(command)&&!confirm(`確認${command==='end'?'結束活動':'關閉互評'}？${rows(detail.rounds).filter((r)=>r.status==='collecting').map((r)=>`尚有 ${Number(r.expected)-Number(r.received)} 人未提交。`).join('')}`))return;
      result=await api(`/activities/${selected}/transition`,'POST',{...base,action:command,groupId:arg?Number(arg):undefined,confirmIncomplete:['close','end'].includes(command)});
      if(command==='open'){qrUrl=String(result.url??'');qrExpiry=0;}
      if(['close','end'].includes(command))qrUrl='';
    }
    notice='已儲存';await refresh();
  });
  const submitForm=async(form:HTMLFormElement)=>run(async()=>{
    const data=new FormData(form),kind=form.dataset.form;
    const fields=Object.fromEntries(data.entries());
    if(kind==='workspace'){await api('/workspaces','POST',fields);route='home';}
    else if(kind==='classroom'){await api(`/workspaces/${workspace}/classrooms`,'POST',fields);route='home';}
    else if(kind==='search'){detail={...detail,...await api(`/workspaces/${workspace}/accounts?q=${encodeURIComponent(String(fields.q))}`)};render();return;}
    else if(kind==='assign'){
      const found=await api(`/workspaces/${object(detail.classroom).workspace_id}/accounts?q=${encodeURIComponent(String(fields.userId))}`);
      const account=rows(found.accounts).find((u)=>u.id===Number(fields.userId));if(!account)throw Error('找不到此確切帳號 ID');
      if(!confirm(`確認班級教師：ID ${account.id}／${account.username}／${account.display_name??''}？`))return;
      await api(`/classrooms/${selected}/teachers`,'PUT',{userId:Number(fields.userId),active:fields.active==='true'});
    }
    else if(kind==='activity'){
      mode=(root.querySelector<HTMLInputElement>('#learning-mode'))?.checked??mode;
      const result=await api(`/classrooms/${selected}/activities`,'POST',{title:fields.title,scheduledAt:`${fields.scheduledAt}+08:00`,managementMode:mode});selected=Number(result.id);route='activity';qrUrl='';qrExpiry=0;
    }else if(kind==='update-activity'){
      await api(`/activities/${selected}/prepare`,'POST',{action:'update',version:state().version,managementMode:mode,title:fields.title,scheduledAt:`${fields.scheduledAt}+08:00`});
    }else if(kind==='evaluate'){
      captureEvaluation();if(!evaluationDraft)return;
      if(!confirm(`確認送出對「${detail.targetGroup}」的評分？${evaluationDraft.scores.map((s)=>s.score).join('／')}。提交後不可修改。`))return;
      const result=await api(`/rounds/${detail.roundId}/submit`,'POST',evaluationDraft);detail={...detail,receipt:result.receipt,canSubmit:false};notice='評分已提交';render();return;
    }
    notice='已儲存';await refresh();
  });
  const poll=async()=>{
    if(controller.signal.aborted)return;
    if(!document.hidden&&!busy&&['activity','evaluate'].includes(route)){
      try{captureEvaluation();await refresh();}catch(error){failures+=1;notice=error instanceof Error?error.message:'連線失敗';}
    }
    if(qrExpiry&&Date.now()>=qrExpiry){qrUrl='';notice='展示碼已過期，請手動更新';render();}
    timer=setTimeout(()=>void poll(),Math.min(60000,(route==='activity'?5000:10000)*2**Math.min(failures,3)));
  };
  route=location.pathname.startsWith('/join')?'join':location.pathname.startsWith('/evaluate')?'evaluate':'home';
  shell('<p>正在載入課堂活動…</p>');
  void api('/status').then(async(status)=>{if(!status.ready)throw Error('課堂活動資料庫尚未就緒，請管理員套用 migration');await refresh();void poll();}).catch((error)=>{notice=String(error.message);shell('<p>課堂活動目前無法使用。</p>');});
  return ()=>{controller.abort();if(timer)clearTimeout(timer);evaluationDraft=null;token='';qrUrl='';};
}
