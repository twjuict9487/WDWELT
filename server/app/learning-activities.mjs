import { createHash, randomBytes } from 'node:crypto';
import { LearningError, learningId, learningText, learningClassroom, learningAudit, tokenDigest } from './learning.mjs';

export function learningTime(value) {
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?\+08:00$/.test(value))throw new LearningError(422,'活動時間須為 Asia/Taipei +08:00');
  const date=new Date(value);if(Number.isNaN(date.getTime()))throw new LearningError(422,'活動時間無效');
  const local=new Date(date.getTime()+8*60*60*1000).toISOString().slice(0,19);
  if(local.slice(0,value.length-6)!==value.slice(0,-6))throw new LearningError(422,'活動日期無效');
  return local.replace('T',' ');
}

export function validateEvaluation(body,criteria) {
  if(!body || typeof body.requestKey!=='string'||!/^[A-Za-z0-9_-]{16,80}$/.test(body.requestKey))throw new LearningError(422,'提交識別碼無效');
  if(Object.keys(body).some((key)=>!['requestKey','scores','comment'].includes(key)))throw new LearningError(422,'評分包含不允許的欄位');
  if(!Array.isArray(body.scores)||body.scores.length!==criteria.length)throw new LearningError(422,'請完成所有評分項目');
  const expected=new Set(criteria.map((c)=>Number(c.id))),seen=new Set();
  const scores=body.scores.map((s)=>{
    if(!s||Object.keys(s).some((key)=>!['criterionId','score'].includes(key))||!Number.isInteger(s.criterionId)||!expected.has(s.criterionId)||seen.has(s.criterionId)||!Number.isInteger(s.score)||s.score<1||s.score>5)throw new LearningError(422,'評分項目不可重複，分數須為 1 至 5 的整數');
    seen.add(s.criterionId);return {criterionId:s.criterionId,score:s.score};
  }).sort((a,b)=>a.criterionId-b.criterionId);
  if(body.comment!==undefined&&typeof body.comment!=='string')throw new LearningError(422,'留言格式無效');
  const comment=(body.comment??'').trim();
  if(comment.length>500)throw new LearningError(422,'留言最多 500 字元');
  const hash=createHash('sha256').update(JSON.stringify({scores,comment})).digest();
  return {scores,comment,hash,requestKey:body.requestKey};
}

export function summarizeEvaluations(criteria,rows) {
  const valid=rows.filter((row)=>!row.voided);
  return {received:rows.length,valid:valid.length,voided:rows.length-valid.length,
    average:valid.length?valid.reduce((sum,row)=>sum+row.scores.reduce((s,item)=>s+item.score,0)/criteria.length,0)/valid.length:null,
    criteria:criteria.map((criterion)=>({id:Number(criterion.id),name:criterion.name,average:valid.length?valid.reduce((sum,row)=>sum+row.scores.find((score)=>score.criterionId===Number(criterion.id)).score,0)/valid.length:null}))};
}

export function createActivityService({database,transaction,publicOrigin}) {
  // All changes take workspace -> classroom -> activity -> round locks, then current account/membership.
  const context=async(tx,actor,id,{manage=false,managementMode=false,lock=false}={})=>{
    const [hint]=await tx.execute('SELECT classroom_id FROM learning_activities WHERE id=?',[id]);
    if(!hint)throw new LearningError(404,'找不到活動');
    const classroom=await learningClassroom(tx,actor,hint.classroom_id,{manage,lock});
    if(manage&&!classroom.teaching&&(!classroom.administration||!managementMode))throw new LearningError(403,'管理者須明確開啟授權管理模式');
    const [activity]=await tx.execute(`SELECT * FROM learning_activities WHERE id=?${lock?' FOR UPDATE':''}`,[id]);
    const [user]=await tx.execute(`SELECT id FROM users WHERE id=? AND account_status='active'${lock?' FOR SHARE':''}`,[actor]);
    if(!user)throw new LearningError(403,'帳號已停用');
    return {activity,classroom};
  };
  const draft=(a,version)=>{if(a.status!=='draft')throw new LearningError(409,'活動開始後不能更改名單、分組或評分項目');if(!Number.isInteger(version)||a.version!==version)throw new LearningError(409,'資料已被其他視窗修改，請重新載入');};
  const bump=async(tx,id)=>tx.execute('UPDATE learning_activities SET version=version+1 WHERE id=?',[id]);
  const audit=async(tx,actor,c,id,action,details={})=>learningAudit(tx,actor,c.workspace_id,c.id,action,{activityId:id,...details});
  const management=(body)=>body.managementMode===true;
  const criteriaFor=(tx,id)=>tx.execute('SELECT id,name,position FROM learning_criteria WHERE activity_id=? ORDER BY position',[id]);
  const currentStudent=async(tx,actor,c,a)=>{
    const [student]=await tx.execute('SELECT s.user_id FROM learning_students s JOIN learning_participants p ON p.user_id=s.user_id AND p.activity_id=? WHERE s.classroom_id=? AND s.user_id=? AND s.active=TRUE AND p.excluded=FALSE FOR SHARE',[a.id,c.id,actor]);
    if(!student||c.teaching)throw new LearningError(403,c.teaching?'本班教師不能以學生身分評分':'你不是本次活動的有效學生');
  };
  const receipt=async(tx,evaluation)=>({id:evaluation.id,roundId:evaluation.round_id,submittedAt:evaluation.created_at,comment:evaluation.comment,voided:Boolean(evaluation.voided),scores:(await tx.execute('SELECT criterion_id AS criterionId,score FROM learning_scores WHERE evaluation_id=? ORDER BY criterion_id',[evaluation.id])).map((s)=>({criterionId:Number(s.criterionId),score:Number(s.score)}))});
  return {
    async list(actor,classroomId) {await learningClassroom(database,actor,classroomId);return {activities:await database.execute('SELECT id,title,scheduled_at,status,published FROM learning_activities WHERE classroom_id=? ORDER BY scheduled_at DESC,id DESC',[classroomId])};},
    async create(actor,classroomId,body) {
      return transaction(async(tx)=>{
        const c=await learningClassroom(tx,actor,classroomId,{manage:true,lock:true});
        const [account]=await tx.execute("SELECT id FROM users WHERE id=? AND account_status='active' FOR SHARE",[actor]);if(!account)throw new LearningError(403,'帳號已停用');
        if(!c.teaching&&!management(body))throw new LearningError(403,'請明確開啟授權管理模式');
        if(c.status!=='active')throw new LearningError(409,'班級已封存');
        const saved=await tx.execute('INSERT INTO learning_activities(classroom_id,title,scheduled_at,created_by) VALUES(?,?,?,?)',[classroomId,learningText(body.title,120),learningTime(body.scheduledAt),actor]);
        const id=Number(saved.insertId);
        await tx.execute('INSERT INTO learning_participants(activity_id,user_id) SELECT ?,s.user_id FROM learning_students s JOIN users u ON u.id=s.user_id WHERE s.classroom_id=? AND s.active=TRUE AND u.account_status=\'active\'',[id,classroomId]);
        for(const [position,name]of ['內容','表達','合作'].entries())await tx.execute('INSERT INTO learning_criteria(activity_id,name,position) VALUES(?,?,?)',[id,name,position+1]);
        await audit(tx,actor,c,id,'activity.create',{managementMode:management(body)});return {id};
      });
    },
    async detail(actor,id,managementMode=false) {
      const {activity:a,classroom:c}=await context(database,actor,id);
      const managing=c.teaching||c.administration&&managementMode;
      const criteria=await criteriaFor(database,id);
      const groups=await database.execute('SELECT id,name,position,status FROM learning_groups WHERE activity_id=? ORDER BY position',[id]);
      let participants;
      if(managing)participants=await database.execute('SELECT p.user_id,u.username,p.excluded,m.group_id FROM learning_participants p JOIN users u ON u.id=p.user_id LEFT JOIN learning_group_members m ON m.activity_id=p.activity_id AND m.user_id=p.user_id WHERE p.activity_id=? ORDER BY p.user_id',[id]);
      const [mine]=await database.execute('SELECT p.user_id,p.excluded,m.group_id FROM learning_participants p LEFT JOIN learning_group_members m ON m.activity_id=p.activity_id AND m.user_id=p.user_id WHERE p.activity_id=? AND p.user_id=?',[id,actor]);
      return {activity:{id:a.id,title:a.title,scheduledAt:a.scheduled_at,status:a.status,version:a.version,published:Boolean(a.published),activeGroupId:a.active_group_id},classroom:{id:c.id,name:c.name},managing,criteria,groups,participants,mine:mine??null};
    },
    async prepare(actor,id,body) {
      return transaction(async(tx)=>{
        const {activity:a,classroom:c}=await context(tx,actor,id,{manage:true,managementMode:management(body),lock:true});draft(a,body.version);
        if(body.action==='sync')await tx.execute('INSERT IGNORE INTO learning_participants(activity_id,user_id) SELECT ?,s.user_id FROM learning_students s JOIN users u ON u.id=s.user_id WHERE s.classroom_id=? AND s.active=TRUE AND u.account_status=\'active\'',[id,c.id]);
        else if(body.action==='exclude'){
          if(typeof body.excluded!=='boolean')throw new LearningError(422,'排除狀態無效');
          const found=await tx.execute('SELECT user_id FROM learning_participants WHERE activity_id=? AND user_id=?',[id,learningId(body.userId)]);if(!found.length)throw new LearningError(404,'不在本次活動名單');
          await tx.execute('DELETE FROM learning_group_members WHERE activity_id=? AND user_id=?',[id,body.userId]);
          await tx.execute('UPDATE learning_participants SET excluded=? WHERE activity_id=? AND user_id=?',[body.excluded,id,body.userId]);
        }else if(body.action==='group'){
          const [{position}]=await tx.execute('SELECT COALESCE(MAX(position),0)+1 AS position FROM learning_groups WHERE activity_id=?',[id]);
          await tx.execute('INSERT INTO learning_groups(activity_id,name,position) VALUES(?,?,?)',[id,learningText(body.name,80),position]);
        }else if(body.action==='rename-group'){
          const result=await tx.execute('UPDATE learning_groups SET name=? WHERE activity_id=? AND id=?',[learningText(body.name,80),id,learningId(body.groupId)]);if(!result.affectedRows)throw new LearningError(404,'找不到本活動組別');
        }else if(body.action==='delete-group'){
          const gid=learningId(body.groupId);
          await tx.execute('DELETE FROM learning_group_members WHERE activity_id=? AND group_id=?',[id,gid]);
          const result=await tx.execute('DELETE FROM learning_groups WHERE activity_id=? AND id=?',[id,gid]);if(!result.affectedRows)throw new LearningError(404,'找不到本活動組別');
        }else if(body.action==='move'){
          const userId=learningId(body.userId),groupId=learningId(body.groupId);
          const [student]=await tx.execute('SELECT p.user_id FROM learning_participants p JOIN learning_students s ON s.user_id=p.user_id AND s.classroom_id=? WHERE p.activity_id=? AND p.user_id=? AND p.excluded=FALSE AND s.active=TRUE',[c.id,id,userId]);
          const [group]=await tx.execute('SELECT id FROM learning_groups WHERE activity_id=? AND id=?',[id,groupId]);
          if(!student||!group)throw new LearningError(422,'學生或組別不屬於本活動');
          await tx.execute('INSERT INTO learning_group_members(activity_id,user_id,group_id) VALUES(?,?,?) ON DUPLICATE KEY UPDATE group_id=VALUES(group_id)',[id,userId,groupId]);
        }else if(body.action==='criteria'){
          if(!Array.isArray(body.names)||body.names.length<1||body.names.length>10)throw new LearningError(422,'評分項目須為 1 至 10 項');
          const names=body.names.map((n)=>learningText(n,80));await tx.execute('DELETE FROM learning_criteria WHERE activity_id=?',[id]);
          for(const [position,name]of names.entries())await tx.execute('INSERT INTO learning_criteria(activity_id,name,position) VALUES(?,?,?)',[id,name,position+1]);
        }else if(body.action==='update'){
          await tx.execute('UPDATE learning_activities SET title=?,scheduled_at=? WHERE id=?',[learningText(body.title,120),body.scheduledAt===undefined?a.scheduled_at:learningTime(body.scheduledAt),id]);
        }else throw new LearningError(422,'未知的活動準備操作');
        await bump(tx,id);await audit(tx,actor,c,id,`activity.${body.action}`,{managementMode:management(body)});return {updated:true,version:a.version+1};
      });
    },
    async order(actor,id,body) {
      return transaction(async(tx)=>{
        const {activity:a,classroom:c}=await context(tx,actor,id,{manage:true,managementMode:management(body),lock:true});
        if(!['draft','live'].includes(a.status)||a.version!==body.version)throw new LearningError(409,'活動狀態或版本已變更');
        const groups=await tx.execute('SELECT id,status,position FROM learning_groups WHERE activity_id=? ORDER BY position',[id]);
        if(!Array.isArray(body.groupIds)||body.groupIds.length!==groups.length||new Set(body.groupIds).size!==groups.length||body.groupIds.some((gid)=>!groups.some((g)=>g.id===gid)))throw new LearningError(422,'排序必須包含每個組別一次');
        const fixed=groups.filter((g)=>g.status!=='pending');
        if(fixed.some((g)=>body.groupIds.indexOf(g.id)!==groups.indexOf(g)))throw new LearningError(409,'只能調整尚未開始的組別');
        await tx.execute('UPDATE learning_groups SET position=-position WHERE activity_id=?',[id]);
        for(const [index,gid]of body.groupIds.entries())await tx.execute('UPDATE learning_groups SET position=? WHERE activity_id=? AND id=?',[index+1,id,gid]);
        await bump(tx,id);await audit(tx,actor,c,id,'activity.order',{groupIds:body.groupIds});return {updated:true};
      });
    },
    async transition(actor,id,body) {
      return transaction(async(tx)=>{
        const {activity:a,classroom:c}=await context(tx,actor,id,{manage:true,managementMode:management(body),lock:true});
        if(a.version!==body.version)throw new LearningError(409,'資料已變更，請重新載入');
        const action=body.action;
        let result={updated:true};
        if(action==='start'){
          draft(a,body.version);
          const inactive=await tx.execute(`SELECT p.user_id FROM learning_participants p
            JOIN users u ON u.id=p.user_id LEFT JOIN learning_students s ON s.classroom_id=? AND s.user_id=p.user_id AND s.active=TRUE
            WHERE p.activity_id=? AND p.excluded=FALSE AND (s.user_id IS NULL OR u.account_status<>'active' OR EXISTS(
              SELECT 1 FROM learning_teachers t JOIN learning_roles r ON r.workspace_id=t.workspace_id AND r.user_id=t.user_id AND r.role='teacher' AND r.active=TRUE
              WHERE t.classroom_id=? AND t.user_id=p.user_id AND t.active=TRUE))`,[c.id,id,c.id]);
          if(inactive.length)throw new LearningError(409,`名單有已離班、停用或任課教師，請明確排除：${inactive.map((p)=>p.user_id).join('、')}`);
          const missing=await tx.execute('SELECT p.user_id FROM learning_participants p LEFT JOIN learning_group_members m ON m.activity_id=p.activity_id AND m.user_id=p.user_id WHERE p.activity_id=? AND p.excluded=FALSE AND m.user_id IS NULL',[id]);
          if(missing.length)throw new LearningError(409,`尚有未分組學生：${missing.map((s)=>s.user_id).join('、')}`);
          const groups=await tx.execute('SELECT g.id,COUNT(m.user_id) AS members FROM learning_groups g LEFT JOIN learning_group_members m ON m.group_id=g.id WHERE g.activity_id=? GROUP BY g.id',[id]);
          if(groups.length<2||groups.some((g)=>Number(g.members)===0))throw new LearningError(409,'至少需要兩個非空組別；請先移除空組');
          if(!(await criteriaFor(tx,id)).length)throw new LearningError(409,'請先設定評分項目');
          await tx.execute("UPDATE learning_activities SET status='live',started_at=CURRENT_TIMESTAMP(3) WHERE id=?",[id]);
        }else if(action==='cancel'){
          draft(a,body.version);await tx.execute("UPDATE learning_activities SET status='cancelled',ended_at=CURRENT_TIMESTAMP(3) WHERE id=?",[id]);
        }else if(action==='publish'||action==='unpublish'){
          if(a.status!=='ended')throw new LearningError(409,'活動結束後才可控制發布');
          await tx.execute('UPDATE learning_activities SET published=? WHERE id=?',[action==='publish',id]);
        }else{
          if(a.status!=='live'||c.status!=='active')throw new LearningError(409,'活動並未進行中');
          if(action==='present'){
            if(a.active_group_id)throw new LearningError(409,'請先完成目前組別');
            const [next]=await tx.execute("SELECT id FROM learning_groups WHERE activity_id=? AND status='pending' ORDER BY position LIMIT 1",[id]);
            if(!next||next.id!==body.groupId)throw new LearningError(409,'請依序開始，或先明確調整待報告順序');
            await tx.execute("UPDATE learning_groups SET status='presenting' WHERE id=? AND activity_id=?",[next.id,id]);
            await tx.execute('UPDATE learning_activities SET active_group_id=? WHERE id=?',[next.id,id]);
          }else if(action==='cancel-presentation'){
            const [group]=await tx.execute('SELECT status FROM learning_groups WHERE id=? AND activity_id=?',[a.active_group_id,id]);
            if(group?.status!=='presenting')throw new LearningError(409,'只有尚未開放互評的報告可以取消');
            await tx.execute("UPDATE learning_groups SET status='pending' WHERE id=?",[a.active_group_id]);await tx.execute('UPDATE learning_activities SET active_group_id=NULL WHERE id=?',[id]);
          }else if(action==='open'){
            const [group]=await tx.execute('SELECT status FROM learning_groups WHERE id=? AND activity_id=?',[a.active_group_id,id]);
            if(group?.status!=='presenting')throw new LearningError(409,'請先開始報告');
            const token=randomBytes(32).toString('base64url');
            const round=await tx.execute('INSERT INTO learning_rounds(activity_id,group_id,token_hash) VALUES(?,?,?)',[id,a.active_group_id,tokenDigest(token)]);
            await tx.execute(`INSERT INTO learning_eligibility(round_id,activity_id,reviewer_id,group_id)
              SELECT ?,m.activity_id,m.user_id,m.group_id FROM learning_group_members m JOIN learning_participants p ON p.activity_id=m.activity_id AND p.user_id=m.user_id
              JOIN learning_students s ON s.user_id=m.user_id AND s.classroom_id=? JOIN users u ON u.id=m.user_id
              WHERE m.activity_id=? AND m.group_id<>? AND p.excluded=FALSE AND s.active=TRUE AND u.account_status='active'
              AND NOT EXISTS(SELECT 1 FROM learning_teachers t JOIN learning_roles r ON r.workspace_id=t.workspace_id AND r.user_id=t.user_id AND r.role='teacher' AND r.active=TRUE WHERE t.classroom_id=? AND t.user_id=m.user_id AND t.active=TRUE)`,[round.insertId,c.id,id,a.active_group_id,c.id]);
            await tx.execute("UPDATE learning_groups SET status='collecting' WHERE id=?",[a.active_group_id]);result={...result,roundId:round.insertId,token,url:publicOrigin?`${publicOrigin}/evaluate/#${token}`:null};
          }else if(action==='close'||action==='end'){
            const [round]=await tx.execute("SELECT id FROM learning_rounds WHERE activity_id=? AND status='collecting' FOR UPDATE",[id]);
            if(round){
              const [{expected,received}]=await tx.execute('SELECT (SELECT COUNT(*) FROM learning_eligibility WHERE round_id=?) AS expected,(SELECT COUNT(*) FROM learning_evaluations WHERE round_id=?) AS received',[round.id,round.id]);
              if(Number(received)<Number(expected)&&body.confirmIncomplete!==true)throw new LearningError(409,`尚有 ${Number(expected)-Number(received)} 人未提交，請確認後關閉`);
              await tx.execute("UPDATE learning_rounds SET status='closed',closed_at=CURRENT_TIMESTAMP(3) WHERE id=?",[round.id]);
              await tx.execute("UPDATE learning_groups SET status='completed' WHERE id=?",[a.active_group_id]);
            }else if(action==='close')throw new LearningError(409,'目前沒有開放的互評');
            await tx.execute('UPDATE learning_activities SET active_group_id=NULL WHERE id=?',[id]);
            if(action==='end')await tx.execute("UPDATE learning_activities SET status='ended',ended_at=CURRENT_TIMESTAMP(3) WHERE id=?",[id]);
          }else throw new LearningError(422,'未知的活動狀態操作');
        }
        await bump(tx,id);await audit(tx,actor,c,id,`activity.${action}`,{managementMode:management(body)});return result;
      });
    },
    async roundLink(actor,id,body) {
      return transaction(async(tx)=>{
        const {activity:a,classroom:c}=await context(tx,actor,id,{manage:true,managementMode:management(body),lock:true});
        const [round]=await tx.execute("SELECT id FROM learning_rounds WHERE activity_id=? AND status='collecting' FOR UPDATE",[id]);
        if(a.status!=='live'||!round)throw new LearningError(410,'互評已關閉');
        const token=randomBytes(32).toString('base64url');await tx.execute('UPDATE learning_rounds SET token_hash=? WHERE id=?',[tokenDigest(token),round.id]);
        await audit(tx,actor,c,id,'round.redisplay',{roundId:round.id});return {roundId:round.id,token,url:publicOrigin?`${publicOrigin}/evaluate/#${token}`:null};
      });
    },
    async copy(actor,id,body) {
      return transaction(async(tx)=>{
        const {activity:a,classroom:c}=await context(tx,actor,id,{manage:true,managementMode:management(body),lock:true});
        if(c.status!=='active')throw new LearningError(409,'班級已封存');
        const saved=await tx.execute('INSERT INTO learning_activities(classroom_id,title,scheduled_at,created_by) VALUES(?,?,?,?)',[c.id,learningText(body.title,120),learningTime(body.scheduledAt),actor]);
        const target=Number(saved.insertId);
        await tx.execute('INSERT INTO learning_participants(activity_id,user_id,excluded) SELECT ?,p.user_id,p.excluded FROM learning_participants p JOIN learning_students s ON s.user_id=p.user_id AND s.classroom_id=? AND s.active=TRUE JOIN users u ON u.id=p.user_id AND u.account_status=\'active\' WHERE p.activity_id=?',[target,c.id,id]);
        const groups=await tx.execute('SELECT id,name,position FROM learning_groups WHERE activity_id=? ORDER BY position',[id]);
        for(const g of groups){
          const group=await tx.execute('INSERT INTO learning_groups(activity_id,name,position) VALUES(?,?,?)',[target,g.name,g.position]);
          await tx.execute('INSERT INTO learning_group_members(activity_id,user_id,group_id) SELECT ?,m.user_id,? FROM learning_group_members m JOIN learning_participants p ON p.user_id=m.user_id AND p.activity_id=? AND p.excluded=FALSE WHERE m.activity_id=? AND m.group_id=?',[target,group.insertId,target,id,g.id]);
        }
        for(const criterion of await criteriaFor(tx,id))await tx.execute('INSERT INTO learning_criteria(activity_id,name,position) VALUES(?,?,?)',[target,criterion.name,criterion.position]);
        await audit(tx,actor,c,target,'activity.copy',{sourceActivityId:a.id});return {id:target};
      });
    },
    async myReceipt(actor,roundId) {
      const [round]=await database.execute('SELECT activity_id FROM learning_rounds WHERE id=?',[roundId]);if(!round)throw new LearningError(404,'找不到互評回合');
      const {activity:a,classroom:c}=await context(database,actor,round.activity_id);await currentStudent(database,actor,c,a);
      const [own]=await database.execute('SELECT * FROM learning_evaluations WHERE round_id=? AND reviewer_id=?',[roundId,actor]);
      if(!own)throw new LearningError(404,'尚未提交評分');return {receipt:await receipt(database,own)};
    },
    async resolve(actor,token) {
      const [round]=await database.execute('SELECT id,activity_id,group_id,status FROM learning_rounds WHERE token_hash=?',[tokenDigest(token)]);
      if(!round)throw new LearningError(410,'互評連結已失效');
      const {activity:a,classroom:c}=await context(database,actor,round.activity_id);
      await currentStudent(database,actor,c,a);
      const [group]=await database.execute('SELECT name FROM learning_groups WHERE id=?',[round.group_id]);
      const [mine]=await database.execute('SELECT m.group_id,g.name FROM learning_group_members m JOIN learning_groups g ON g.id=m.group_id WHERE m.activity_id=? AND m.user_id=?',[a.id,actor]);
      const [evaluation]=await database.execute('SELECT * FROM learning_evaluations WHERE round_id=? AND reviewer_id=?',[round.id,actor]);
      const [eligible]=await database.execute('SELECT reviewer_id FROM learning_eligibility WHERE round_id=? AND reviewer_id=?',[round.id,actor]);
      return {roundId:round.id,activity:a.title,classroom:c.name,targetGroup:group.name,myGroup:mine?.name??null,criteria:await criteriaFor(database,a.id),receipt:evaluation?await receipt(database,evaluation):null,
        canSubmit:Boolean(eligible)&&a.status==='live'&&round.status==='collecting'&&!evaluation,
        reason:evaluation?'已提交':mine?.group_id===round.group_id?'不可自評':!mine?'未分組':!eligible?'不具本回合資格':a.status!=='live'||round.status!=='collecting'?'互評已關閉':null};
    },
    async submit(actor,roundId,body) {
      const [hint]=await database.execute('SELECT activity_id FROM learning_rounds WHERE id=?',[roundId]);if(!hint)throw new LearningError(404,'找不到互評回合');
      return transaction(async(tx)=>{
        const {activity:a,classroom:c}=await context(tx,actor,hint.activity_id,{lock:true});
        const [round]=await tx.execute('SELECT * FROM learning_rounds WHERE id=? AND activity_id=? FOR UPDATE',[roundId,a.id]);
        await currentStudent(tx,actor,c,a);
        const criteria=await criteriaFor(tx,a.id);const input=validateEvaluation(body,criteria);
        const [old]=await tx.execute('SELECT * FROM learning_evaluations WHERE round_id=? AND reviewer_id=? FOR UPDATE',[roundId,actor]);
        if(old){
          if(old.request_key===input.requestKey&&old.payload_hash.equals(input.hash))return {receipt:await receipt(tx,old),replayed:true};
          throw new LearningError(409,old.request_key===input.requestKey?'相同提交識別碼不可使用不同內容':'你已提交此回合評分');
        }
        if(a.status!=='live'||round.status!=='collecting'||c.status!=='active')throw new LearningError(410,'互評已關閉，無法新增評分');
        const [eligible]=await tx.execute('SELECT reviewer_id FROM learning_eligibility WHERE round_id=? AND reviewer_id=?',[roundId,actor]);
        if(!eligible)throw new LearningError(403,'不可自評、未分組或不具本回合評分資格');
        const [reuse]=await tx.execute('SELECT id FROM learning_evaluations WHERE reviewer_id=? AND request_key=?',[actor,input.requestKey]);if(reuse)throw new LearningError(409,'此提交識別碼已用於另一回合');
        const saved=await tx.execute('INSERT INTO learning_evaluations(round_id,activity_id,reviewer_id,request_key,payload_hash,comment) VALUES(?,?,?,?,?,?)',[roundId,a.id,actor,input.requestKey,input.hash,input.comment]);
        for(const s of input.scores)await tx.execute('INSERT INTO learning_scores(evaluation_id,activity_id,criterion_id,score) VALUES(?,?,?,?)',[saved.insertId,a.id,s.criterionId,s.score]);
        const [created]=await tx.execute('SELECT * FROM learning_evaluations WHERE id=?',[saved.insertId]);return {receipt:await receipt(tx,created),replayed:false};
      }).catch((error)=>{if(error.code==='ER_DUP_ENTRY')throw new LearningError(409,'此提交識別碼或回合已經提交');throw error;});
    },
    async collection(actor,id,managementMode=false) {
      await context(database,actor,id,{manage:true,managementMode});
      return {rounds:await database.execute(`SELECT r.id,r.group_id,r.status,
        (SELECT COUNT(*) FROM learning_eligibility e WHERE e.round_id=r.id) AS expected,
        (SELECT COUNT(*) FROM learning_evaluations v WHERE v.round_id=r.id) AS received,
        (SELECT COUNT(*) FROM learning_evaluations v WHERE v.round_id=r.id AND v.voided=FALSE) AS valid,
        (SELECT COUNT(*) FROM learning_eligibility e JOIN users u ON u.id=e.reviewer_id WHERE e.round_id=r.id AND u.account_status='disabled') AS disabled
        FROM learning_rounds r WHERE r.activity_id=? ORDER BY r.id`,[id])};
    },
    async results(actor,id,{managementMode=false,details=false,page=1}={}) {
      const {activity:a,classroom:c}=await context(database,actor,id);
      const managing=c.teaching||c.administration&&managementMode;
      if(!managing&&(!a.published||a.status!=='ended'))throw new LearningError(403,'結果尚未發布');
      const criteria=await criteriaFor(database,id);
      const summaries=await database.execute(`SELECT g.id,g.name,COUNT(DISTINCT e.id) AS received,COUNT(DISTINCT CASE WHEN e.voided=FALSE THEN e.id END) AS valid,
        AVG(CASE WHEN e.voided=FALSE THEN CAST(s.score AS DECIMAL(18,10)) END) AS average FROM learning_groups g LEFT JOIN learning_rounds r ON r.group_id=g.id
        LEFT JOIN learning_evaluations e ON e.round_id=r.id LEFT JOIN learning_scores s ON s.evaluation_id=e.id WHERE g.activity_id=? GROUP BY g.id,g.name ORDER BY g.position`,[id]);
      const perCriterion=await database.execute(`SELECT r.group_id,s.criterion_id,AVG(CAST(s.score AS DECIMAL(18,10))) AS average FROM learning_scores s JOIN learning_evaluations e ON e.id=s.evaluation_id JOIN learning_rounds r ON r.id=e.round_id WHERE e.activity_id=? AND e.voided=FALSE GROUP BY r.group_id,s.criterion_id`,[id]);
      const groups=summaries.map((g)=>({id:g.id,name:g.name,received:Number(g.received),valid:Number(g.valid),voided:Number(g.received)-Number(g.valid),average:g.average==null?null:Number(g.average),criteria:criteria.map((criterion)=>({id:criterion.id,name:criterion.name,average:perCriterion.find((p)=>p.group_id===g.id&&p.criterion_id===criterion.id)?.average==null?null:Number(perCriterion.find((p)=>p.group_id===g.id&&p.criterion_id===criterion.id).average)}))}));
      const result={groups,published:Boolean(a.published)};
      if(managing&&details){
        const offset=(Math.max(1,Math.min(100000,Number(page)||1))-1)*50;
        result.evaluations=await database.execute('SELECT e.id,e.round_id,e.reviewer_id,u.username,e.comment,e.voided,e.void_reason,e.created_at FROM learning_evaluations e JOIN users u ON u.id=e.reviewer_id WHERE e.activity_id=? ORDER BY e.id LIMIT 50 OFFSET ?',[id,offset]);
        for(const row of result.evaluations)row.scores=(await receipt(database,row)).scores;
      }
      return result;
    },
    async void(actor,id,evaluationId,body) {
      return transaction(async(tx)=>{
        const {classroom:c}=await context(tx,actor,id,{manage:true,managementMode:management(body),lock:true});
        const reason=learningText(body.reason,500);
        const [evaluation]=await tx.execute('SELECT id FROM learning_evaluations WHERE id=? AND activity_id=? FOR UPDATE',[evaluationId,id]);if(!evaluation)throw new LearningError(404,'找不到本活動評分');
        await tx.execute('UPDATE learning_evaluations SET voided=TRUE,void_reason=? WHERE id=?',[reason,evaluationId]);
        await audit(tx,actor,c,id,'evaluation.void',{evaluationId,reason});return {voided:true};
      });
    },
  };
}
