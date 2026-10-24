import { createHash, randomBytes } from 'node:crypto';

export class LearningError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const learningId = (value) => {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new LearningError(422, '資源 ID 無效');
  return Number(value);
};
export const learningText = (value, maximum = 100) => {
  if (typeof value !== 'string') throw new LearningError(422, '請輸入文字');
  const result = value.normalize('NFKC').trim();
  if (!result || result.length > maximum) throw new LearningError(422, `文字長度須為 1 至 ${maximum} 字元`);
  return result;
};
export const tokenDigest = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new LearningError(410, '加入碼無效或已過期');
  return createHash('sha256').update(value).digest();
};

export async function learningAudit(tx, actor, workspace, classroom, action, details = {}) {
  await tx.execute('INSERT INTO learning_audit(actor_id,workspace_id,classroom_id,action,details) VALUES(?,?,?,?,?)', [actor,workspace,classroom,action,JSON.stringify(details)]);
}

// Scoped grants are read on every request; session/global display roles confer no learning permissions.
export async function learningScope(tx, userId, workspaceId, lock = false) {
  const [workspace] = await tx.execute(`SELECT id,status FROM learning_workspaces WHERE id=?${lock ? ' FOR UPDATE' : ''}`, [workspaceId]);
  if (!workspace || workspace.status !== 'active') throw new LearningError(404, '找不到可用的工作空間');
  const [creator] = await tx.execute('SELECT user_id FROM learning_creators WHERE user_id=? AND active=TRUE', [userId]);
  const roles = await tx.execute('SELECT role FROM learning_roles WHERE workspace_id=? AND user_id=? AND active=TRUE', [workspaceId,userId]);
  return { creator:Boolean(creator), manager:roles.some((r)=>r.role==='manager'), teacher:roles.some((r)=>r.role==='teacher') };
}
export async function requireLearningManager(tx, userId, workspaceId, creatorOnly = false) {
  const scope = await learningScope(tx,userId,workspaceId,true);
  if (!scope.creator && (creatorOnly || !scope.manager)) throw new LearningError(403, '沒有此工作空間的管理權限');
  return scope;
}
export async function learningClassroom(tx, userId, classroomId, { manager = false, manage = false, lock = false } = {}) {
  const [hint] = await tx.execute('SELECT workspace_id FROM learning_classrooms WHERE id=?',[classroomId]);
  if (!hint) throw new LearningError(404,'找不到班級');
  const scope = await learningScope(tx,userId,hint.workspace_id,lock);
  const [classroom] = await tx.execute(`SELECT * FROM learning_classrooms WHERE id=?${lock ? ' FOR UPDATE' : ''}`,[classroomId]);
  const [assigned] = await tx.execute('SELECT user_id FROM learning_teachers WHERE classroom_id=? AND user_id=? AND active=TRUE',[classroomId,userId]);
  const [student] = await tx.execute('SELECT user_id FROM learning_students WHERE classroom_id=? AND user_id=? AND active=TRUE',[classroomId,userId]);
  const teaching = scope.teacher && Boolean(assigned);
  const administration = scope.creator || scope.manager;
  if (manager ? !administration : manage ? !teaching && !administration : !teaching && !administration && !student) throw new LearningError(404,'找不到可存取的班級');
  return { ...classroom, teaching, administration, student:Boolean(student) };
}

export function createLearningService({ database, publicOrigin }) {
  const transaction = async (operation) => {
    for (let attempt=0; ; attempt+=1) {
      try { return await database.transaction(operation); }
      catch(error) { if (error.code !== 'ER_LOCK_DEADLOCK' || attempt >= 2) throw error; }
    }
  };
  const enabledUser = async (tx, userId) => {
    const [user] = await tx.execute('SELECT id FROM users WHERE id=? AND account_status=\'active\' FOR SHARE',[userId]);
    if (!user) throw new LearningError(403,'帳號已停用或不存在');
  };
  const invite = async (tx, token, lock = false) => {
    const [hint] = await tx.execute('SELECT p.classroom_id FROM learning_invite_tokens t JOIN learning_invite_policies p ON p.id=t.policy_id WHERE t.token_hash=?',[tokenDigest(token)]);
    if (!hint) throw new LearningError(410,'加入碼無效或已過期');
    const [classHint] = await tx.execute('SELECT workspace_id FROM learning_classrooms WHERE id=?',[hint.classroom_id]);
    const [workspace] = await tx.execute(`SELECT id,status,name FROM learning_workspaces WHERE id=?${lock?' FOR UPDATE':''}`,[classHint.workspace_id]);
    const [classroom] = await tx.execute(`SELECT id,name,status FROM learning_classrooms WHERE id=?${lock?' FOR UPDATE':''}`,[hint.classroom_id]);
    const [row] = await tx.execute(`SELECT t.created_by,t.expires_at,p.id AS policy_id,p.expires_at AS policy_expiry,p.revoked,
      (t.expires_at>CURRENT_TIMESTAMP(3) AND p.expires_at>CURRENT_TIMESTAMP(3)) AS valid
      FROM learning_invite_tokens t JOIN learning_invite_policies p ON p.id=t.policy_id WHERE t.token_hash=?${lock?' FOR UPDATE':''}`,[tokenDigest(token)]);
    if (!row || !row.valid || row.revoked || classroom.status!=='active' || workspace.status!=='active') throw new LearningError(410,'加入碼已到期、撤銷或班級已封存');
    const scope = await learningScope(tx,row.created_by,workspace.id);
    const [assignment] = await tx.execute('SELECT user_id FROM learning_teachers WHERE classroom_id=? AND user_id=? AND active=TRUE',[classroom.id,row.created_by]);
    const [issuer] = await tx.execute('SELECT id FROM users WHERE id=? AND account_status=\'active\'',[row.created_by]);
    if (!issuer || !(scope.creator || scope.manager || scope.teacher && assignment)) throw new LearningError(410,'此加入碼的產生者已無權限');
    return { row, workspace, classroom };
  };
  return {
    async home(userId) {
      const creator = await database.execute('SELECT user_id FROM learning_creators WHERE user_id=? AND active=TRUE',[userId]);
      const workspaces = await database.execute(`SELECT w.id,w.name,CASE WHEN SUM(r.role='manager')>0 THEN 'manager' WHEN SUM(r.role='teacher')>0 THEN 'teacher' ELSE NULL END AS role FROM learning_workspaces w LEFT JOIN learning_roles r ON r.workspace_id=w.id AND r.user_id=? AND r.active=TRUE
        WHERE w.status='active' AND (r.user_id IS NOT NULL OR EXISTS(SELECT 1 FROM learning_creators cr WHERE cr.user_id=? AND cr.active=TRUE)) GROUP BY w.id,w.name ORDER BY w.id`,[userId,userId]);
      const classrooms = await database.execute(`SELECT DISTINCT c.id,c.name,c.workspace_id,w.name AS workspace_name FROM learning_classrooms c JOIN learning_workspaces w ON w.id=c.workspace_id
        WHERE c.status='active' AND w.status='active' AND (
        EXISTS(SELECT 1 FROM learning_creators cr WHERE cr.user_id=? AND cr.active=TRUE)
        OR EXISTS(SELECT 1 FROM learning_roles r WHERE r.workspace_id=c.workspace_id AND r.user_id=? AND r.active=TRUE AND (r.role='manager' OR r.role='teacher' AND EXISTS(SELECT 1 FROM learning_teachers t WHERE t.classroom_id=c.id AND t.user_id=? AND t.active=TRUE)))
        OR EXISTS(SELECT 1 FROM learning_students s WHERE s.classroom_id=c.id AND s.user_id=? AND s.active=TRUE)) ORDER BY c.id`,[userId,userId,userId,userId]);
      return { creator:creator.length>0,workspaces,classrooms };
    },
    async createWorkspace(actor,name) {
      return transaction(async(tx)=>{
        await enabledUser(tx,actor);
        const [creator] = await tx.execute('SELECT user_id FROM learning_creators WHERE user_id=? AND active=TRUE FOR UPDATE',[actor]);
        if(!creator) throw new LearningError(403,'只有本機指定的建立者可建立工作空間');
        const result=await tx.execute('INSERT INTO learning_workspaces(name,created_by) VALUES(?,?)',[learningText(name),actor]);
        await learningAudit(tx,actor,result.insertId,null,'workspace.create');
        return {id:result.insertId};
      });
    },
    async grant(actor,workspaceId,{userId,role,active}) {
      if(!['manager','teacher'].includes(role)||typeof active!=='boolean') throw new LearningError(422,'授權格式無效');
      return transaction(async(tx)=>{
        const scope=await requireLearningManager(tx,actor,workspaceId,role==='manager');
        await enabledUser(tx,actor);
        if(active&&Number(userId)===actor&&!scope.creator)throw new LearningError(403,'不能自行授予額外角色');
        await enabledUser(tx,learningId(userId));
        await tx.execute('INSERT INTO learning_roles(workspace_id,user_id,role,active,granted_by) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE active=VALUES(active),granted_by=VALUES(granted_by)',[workspaceId,userId,role,active,actor]);
        if(!active)await tx.execute('UPDATE learning_invite_tokens t JOIN learning_invite_policies p ON p.id=t.policy_id JOIN learning_classrooms c ON c.id=p.classroom_id SET t.expires_at=LEAST(t.expires_at,CURRENT_TIMESTAMP(3)) WHERE c.workspace_id=? AND t.created_by=?',[workspaceId,userId]);
        await learningAudit(tx,actor,workspaceId,null,'role.change',{userId,role,active});
        return {updated:true};
      });
    },
    async accounts(actor,workspaceId,q) {
      return transaction(async(tx)=>{
        await requireLearningManager(tx,actor,workspaceId);
        const term=learningText(q,80).replace(/[\\%_]/g,'\\$&');
        return {accounts:await tx.execute("SELECT id,username,display_name FROM users WHERE account_status='active' AND (username LIKE ? OR CAST(id AS CHAR)=?) ORDER BY id LIMIT 50",[`%${term}%`,q])};
      });
    },
    async createClassroom(actor,workspaceId,name) {
      return transaction(async(tx)=>{
        await requireLearningManager(tx,actor,workspaceId); await enabledUser(tx,actor);
        const result=await tx.execute('INSERT INTO learning_classrooms(workspace_id,name) VALUES(?,?)',[workspaceId,learningText(name)]);
        await learningAudit(tx,actor,workspaceId,result.insertId,'classroom.create');return {id:result.insertId};
      });
    },
    async classroom(actor,id) {
      const c=await learningClassroom(database,actor,id);
      const members=c.teaching||c.administration ? await database.execute('SELECT s.user_id,u.username,u.display_name,s.active,s.joined_at FROM learning_students s JOIN users u ON u.id=s.user_id WHERE classroom_id=? ORDER BY user_id',[id]):[];
      const policies=c.teaching||c.administration ? await database.execute('SELECT id,expires_at,revoked FROM learning_invite_policies WHERE classroom_id=? ORDER BY id DESC',[id]):[];
      return {classroom:c,members,policies};
    },
    async assign(actor,id,{userId,active}) {
      if(typeof active!=='boolean') throw new LearningError(422,'授權狀態無效');
      return transaction(async(tx)=>{
        const c=await learningClassroom(tx,actor,id,{manager:true,lock:true});await enabledUser(tx,actor);
        const scope=await learningScope(tx,learningId(userId),c.workspace_id);
        if(!scope.teacher) throw new LearningError(422,'請先授予此帳號工作空間教師權限');
        await enabledUser(tx,userId);
        await tx.execute('INSERT INTO learning_teachers(classroom_id,workspace_id,user_id,active,granted_by) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE active=VALUES(active),granted_by=VALUES(granted_by)',[id,c.workspace_id,userId,active,actor]);
        if(!active)await tx.execute('UPDATE learning_invite_tokens t JOIN learning_invite_policies p ON p.id=t.policy_id SET t.expires_at=LEAST(t.expires_at,CURRENT_TIMESTAMP(3)) WHERE p.classroom_id=? AND t.created_by=?',[id,userId]);
        await learningAudit(tx,actor,c.workspace_id,id,'teacher.assignment',{userId,active});return {updated:true};
      });
    },
    async archive(actor,id) {
      return transaction(async(tx)=>{
        const c=await learningClassroom(tx,actor,id,{manager:true,lock:true});await enabledUser(tx,actor);
        await tx.execute("UPDATE learning_classrooms SET status='archived',version=version+1 WHERE id=?",[id]);
        await learningAudit(tx,actor,c.workspace_id,id,'classroom.archive');return {archived:true};
      });
    },
    async removeStudent(actor,id,userId) {
      return transaction(async(tx)=>{
        const c=await learningClassroom(tx,actor,id,{manage:true,lock:true});await enabledUser(tx,actor);
        const result=await tx.execute('UPDATE learning_students SET active=FALSE WHERE classroom_id=? AND user_id=?',[id,userId]);
        if(!result.affectedRows)throw new LearningError(404,'找不到本班學生');
        await learningAudit(tx,actor,c.workspace_id,id,'student.remove',{userId});return {removed:true};
      });
    },
    async leave(actor,id) {
      return transaction(async(tx)=>{
        const c=await learningClassroom(tx,actor,id,{lock:true});await enabledUser(tx,actor);
        const [participated]=await tx.execute('SELECT p.user_id FROM learning_participants p JOIN learning_activities a ON a.id=p.activity_id WHERE a.classroom_id=? AND p.user_id=? LIMIT 1',[id,actor]);
        if(participated)throw new LearningError(409,'已有活動紀錄，請由教師協助處理離班');
        await tx.execute('UPDATE learning_students SET active=FALSE WHERE classroom_id=? AND user_id=?',[id,actor]);
        await learningAudit(tx,actor,c.workspace_id,id,'student.leave');return {left:true};
      });
    },
    async policy(actor,id,{days=7}={}) {
      if(!Number.isInteger(days)||days<1||days>30) throw new LearningError(422,'有效天數須為 1 至 30');
      return transaction(async(tx)=>{
        const c=await learningClassroom(tx,actor,id,{manager:true,lock:true});await enabledUser(tx,actor);
        if(c.status!=='active')throw new LearningError(409,'班級已封存');
        const result=await tx.execute('INSERT INTO learning_invite_policies(classroom_id,expires_at,created_by) VALUES(?,DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL ? DAY),?)',[id,days,actor]);
        await learningAudit(tx,actor,c.workspace_id,id,'invite.policy.create',{policyId:result.insertId,days});return {id:result.insertId};
      });
    },
    async revoke(actor,id,policyId) {
      return transaction(async(tx)=>{
        const c=await learningClassroom(tx,actor,id,{manager:true,lock:true});await enabledUser(tx,actor);
        const result=await tx.execute('UPDATE learning_invite_policies SET revoked=TRUE WHERE id=? AND classroom_id=?',[policyId,id]);
        if(!result.affectedRows)throw new LearningError(404,'找不到邀請政策');
        await learningAudit(tx,actor,c.workspace_id,id,'invite.policy.revoke',{policyId});return {revoked:true};
      });
    },
    async displayToken(actor,id,policyId) {
      const token=randomBytes(32).toString('base64url');
      return transaction(async(tx)=>{
        const c=await learningClassroom(tx,actor,id,{manage:true,lock:true});await enabledUser(tx,actor);
        const [p]=await tx.execute('SELECT id,expires_at FROM learning_invite_policies WHERE id=? AND classroom_id=? AND revoked=FALSE AND expires_at>CURRENT_TIMESTAMP(3) FOR UPDATE',[policyId,id]);
        if(!p||c.status!=='active')throw new LearningError(410,'班級加入政策已失效');
        await tx.execute('INSERT INTO learning_invite_tokens(token_hash,policy_id,created_by,expires_at) VALUES(?,?,?,LEAST(?,DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 15 MINUTE)))',[tokenDigest(token),policyId,actor,p.expires_at]);
        const [saved]=await tx.execute('SELECT expires_at FROM learning_invite_tokens WHERE token_hash=?',[tokenDigest(token)]);
        await learningAudit(tx,actor,c.workspace_id,id,'invite.display',{policyId});
        return {token,expiresAt:saved.expires_at,url:publicOrigin ? `${publicOrigin}/join/#${token}`:null};
      });
    },
    async preview(token) {
      const {workspace,classroom,row}=await invite(database,token);
      return {workspace:workspace.name,classroom:classroom.name,expiresAt:row.expires_at};
    },
    async join(actor,token) {
      return transaction(async(tx)=>{
        const {workspace,classroom}=await invite(tx,token,true);await enabledUser(tx,actor);
        const scope=await learningScope(tx,actor,workspace.id);
        const [teacher]=await tx.execute('SELECT user_id FROM learning_teachers WHERE classroom_id=? AND user_id=? AND active=TRUE',[classroom.id,actor]);
        if(scope.teacher&&teacher)throw new LearningError(409,'你已是本班教師，不能另以學生加入');
        const [old]=await tx.execute('SELECT active FROM learning_students WHERE classroom_id=? AND user_id=? FOR UPDATE',[classroom.id,actor]);
        if(old?.active)return {joined:true,alreadyJoined:true,classroom:classroom.name};
        await tx.execute('INSERT INTO learning_students(classroom_id,user_id) VALUES(?,?) ON DUPLICATE KEY UPDATE active=TRUE,joined_at=CURRENT_TIMESTAMP(3)',[classroom.id,actor]);
        await tx.execute("INSERT INTO learning_notifications(user_id,classroom_id,kind) VALUES(?,?,'classroom.joined') ON DUPLICATE KEY UPDATE created_at=CURRENT_TIMESTAMP(3),read_at=NULL",[actor,classroom.id]);
        await learningAudit(tx,actor,workspace.id,classroom.id,'student.join');return {joined:true,alreadyJoined:false,classroom:classroom.name};
      });
    },
    async notifications(actor) {
      return {notifications:await database.execute('SELECT n.id,n.kind,n.created_at,n.read_at,c.name AS classroom FROM learning_notifications n JOIN learning_classrooms c ON c.id=n.classroom_id WHERE n.user_id=? ORDER BY n.id DESC LIMIT 100',[actor])};
    },
    async readNotification(actor,id) {
      const result=await database.execute('UPDATE learning_notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP(3)) WHERE id=? AND user_id=?',[id,actor]);
      if(!result.affectedRows)throw new LearningError(404,'找不到通知');return {read:true};
    },
    transaction,
  };
}
