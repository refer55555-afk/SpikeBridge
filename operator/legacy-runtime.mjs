import fs from 'node:fs';
import path from 'node:path';

const TERMINAL = new Set(['completed','idle','failed','interrupted','rejected','lost']);
function read(file) { try { return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')); } catch(e) { if(e.code==='ENOENT')return null;throw new Error('任务记录无法读取：'+path.basename(file)); } }
function unpack(result) { if(result?.isError)throw new Error(result.structuredContent?.error || '旧版桥接状态读取失败。');return result?.structuredContent ?? result; }
export async function legacySnapshot(root, health, processInfo, rpc, terminalCache=new Map()) {
  if(health?.version!=='0.1.2-preview.9'||!health.healthy||processInfo?.pid!==health.pid||processInfo?.owned!==true||!Number.isFinite(Date.parse(processInfo.startedAt)))throw new Error('无法确认旧版桥接进程身份。');
  const boot=Date.parse(processInfo.startedAt), refs=new Map();
  for(const provider of ['codex-a','codex-b']) {
    for(const r of read(path.join(root,'state','agents',provider,'agent-task-cards.json'))?.records || []) {
      if(r.agentRef && r.updatedAt>=boot)refs.set(provider+':'+r.agentRef,{provider,ref:r.agentRef,title:r.taskCard?.title||r.taskCard?.summary||'编程任务',description:r.taskCard?.summary||r.taskCard?.title,descriptionIncomplete:true,reason:r.taskCard?.invocationRationale,sourceAt:r.updatedAt});
    }
  }
  for(const r of read(path.join(root,'state','agents','zcode','jobs.json'))?.records || []) {
    if(r.ref && (!TERMINAL.has(r.status)||r.startedAt>=boot))refs.set('zcode:'+r.ref,{provider:'zcode',ref:r.ref,title:'智谱任务'});
  }
  if(refs.size>1000)throw new Error('旧版任务记录过多，请先人工核验，面板不会截断后声称空闲。');
  const pending=[...refs.values()], tasks=[];
  let next=0;
  await Promise.all(Array.from({length:Math.min(3,pending.length)},async()=>{
    while(next<pending.length){const item=pending[next++];const cacheKey=health.pid+':'+item.provider+':'+item.ref;const cached=terminalCache.get(cacheKey);if(cached&&cached.sourceAt===item.sourceAt&&Date.now()-cached.at<60000){tasks.push(cached.task);continue;}try{
      const p=unpack(await rpc('tools/call',{name:'spike.agent_status',arguments:{provider:item.provider,ref:item.ref}}));
      const c=p.cardV1||{}, s=c.state||{}, ex=c.execution||{};
      const task={...item,live:true,status:s.status||p.status||'unknown',turnId:p.turnId||c.turn?.turnRef||null,model:ex.resolvedModel||ex.requestedModel,effort:ex.reasoningEffort,cwd:c.task?.cwd||c.task?.project,startedAt:s.startedAt,updatedAt:s.updatedAt||Date.now(),endedAt:s.endedAt,requestId:p.requestId,pendingApproval:p.pendingApproval||null,result:c.result?.summary,error:c.result?.error,quota:c.quota};tasks.push(task);if(TERMINAL.has(task.status))terminalCache.set(cacheKey,{sourceAt:item.sourceAt,at:Date.now(),task});else terminalCache.delete(cacheKey);
    }catch(e){tasks.push({...item,live:true,status:'unknown',error:e.message,updatedAt:Date.now()});}}
  }));
  return {schemaVersion:1,legacy:true,pid:health.pid,observedAt:new Date().toISOString(),settingsRevision:null,settingsHash:null,admission:{maintenance:false},counts:{active:tasks.filter(t=>['running','starting','queued','cancelling'].includes(t.status)).length,awaitingApproval:tasks.filter(t=>t.status==='awaitingApproval').length,starting:0,uncertain:tasks.filter(t=>t.status==='unknown').length,counted:tasks.filter(t=>!TERMINAL.has(t.status)).length},tasks,providers:[],commands:{inFlight:null},memory:null,coverage:'编程账号甲、编程账号乙、智谱执行器；远程电脑需接入管理版本后核验'};
}
export async function legacyTask(root, snapshot, params, rpc) {
  const {provider,ref,action,requestId}=params;
  if(!snapshot?.legacy||!['codex-a','codex-b','zcode'].includes(provider)||typeof requestId!=='string'||!requestId||requestId.length>512)throw new Error('旧版任务操作参数无效。');
  const task=snapshot.tasks.find(t=>t.provider===provider&&t.ref===ref);
  if(!task?.live || task.status==='unknown')throw new Error('此任务未通过当前运行实例核验。');
  if(action==='cancel') {
    if(TERMINAL.has(task.status))throw new Error('任务已经结束。');
    if(provider==='zcode')return rpc('tools/call',{name:'spike.agent_cancel',arguments:{provider,ref,requestId}});
    if(!params.expectedTurnId||params.expectedTurnId!==task.turnId)throw new Error('任务轮次已变化，请重新打开详情。');
    return rpc('tools/call',{name:'codex.agent_cancel',arguments:{agentRef:ref,expectedTurnId:params.expectedTurnId,requestId}});
  }
  if(!['approve','reject'].includes(action)||!provider.startsWith('codex-')||!params.approvalRequestId||String(task.pendingApproval?.requestId)!==String(params.approvalRequestId))throw new Error('审批请求已变化或当前操作不支持。');
  return rpc('tools/call',{name:action==='approve'?'codex.agent_approve':'codex.agent_reject',arguments:{agentRef:ref,approvalRequestId:String(params.approvalRequestId),requestId,...(action==='approve'&&params.elicitationContent?{elicitationContent:params.elicitationContent}:{})}});
}
