import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { redact, PROVIDER_NAMES } from './operator-settings.mjs';

export const USAGE_METRICS = ['totalTokens','inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens'];
const TERMINAL = new Set(['completed','idle','failed','interrupted','rejected','lost']);
const ACTIVE = new Set(['running','starting','awaitingApproval','queued','processing','cancelling']);
const validCount = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const numericSum = (a,b) => Number.isSafeInteger(a) && Number.isSafeInteger(b) && Number.isSafeInteger(a+b) ? a+b : null;
const time = value => { const n=typeof value==='number'?value:Date.parse(value);return Number.isFinite(n)&&n>0?n:null; };
const safeString = (s,n=512) => typeof s==='string'?redact(s).slice(0,n):null;
const emptyMetrics = () => Object.fromEntries(USAGE_METRICS.map(k=>[k,null]));
const aliases = {totalTokens:['totalTokens','total_tokens'],inputTokens:['inputTokens','input_tokens','promptTokens','prompt_tokens'],cachedInputTokens:['cachedInputTokens','cached_input_tokens','cacheReadTokens'],outputTokens:['outputTokens','output_tokens','completionTokens','completion_tokens'],reasoningOutputTokens:['reasoningOutputTokens','reasoning_output_tokens','reasoningTokens']};
export function normalizeUsage(value) {
  const out=emptyMetrics();
  for(const [key,names] of Object.entries(aliases))for(const name of names){const v=validCount(value?.[name]);if(v!==null){out[key]=v;break;}}
  if(out.totalTokens===null&&out.inputTokens!==null&&out.outputTokens!==null)out.totalTokens=numericSum(out.inputTokens,out.outputTokens);
  if(out.cachedInputTokens!==null&&out.inputTokens!==null&&out.cachedInputTokens>out.inputTokens)out.cachedInputTokens=null;
  if(out.reasoningOutputTokens!==null&&out.outputTokens!==null&&out.reasoningOutputTokens>out.outputTokens)out.reasoningOutputTokens=null;
  return out;
}
export function usageDelta(total, baseline) {
  if(!total||!baseline)return emptyMetrics();
  const a=normalizeUsage(total),b=normalizeUsage(baseline),out=emptyMetrics();
  for(const k of USAGE_METRICS){if(a[k]!==null&&b[k]!==null){if(a[k]<b[k])return emptyMetrics();out[k]=a[k]-b[k];}}
  return out;
}
export const zeroUsage = () => Object.fromEntries(USAGE_METRICS.map(k=>[k,0]));
export function normalizeUsageObservation(row, {provider=null,source='runtime',now=Date.now()}={}) {
  const p=provider||row.provider;
  if(!Object.hasOwn(PROVIDER_NAMES,p))return null;
  const ref=safeString(row.agentRef||row.ref),turn=safeString(row.turnId||row.turnRef);
  if(!ref||!turn)return null;
  const raw=row.usage||row.resourceReceipt?.tokenUsage;
  const cumulative=raw?.total||raw?.threadTotal||raw?.cumulative||null;
  const latest=raw?.last||raw?.turn||null;
  const baseline=row.usageBaseline??null;
  const direct=row.usageScope==='turn'?normalizeUsage(raw):null;
  const measured=direct??usageDelta(cumulative,baseline);
  const known=measured.totalTokens!==null;
  return {provider:p,agentRef:ref,turnId:turn,model:safeString(row.model||row.execution?.resolvedModel||row.execution?.requestedModel),title:safeString(row.title,500),project:safeString(row.project||row.cwd,2048),startedAt:time(row.startedAt||row.timing?.startedAt),updatedAt:time(row.updatedAt)||now,endedAt:time(row.endedAt||row.timing?.endedAt),status:safeString(row.status,64)||'unknown',runtimePid:Number.isInteger(row.runtimePid)?row.runtimePid:null,usage:measured,latestResponseUsage:latest?normalizeUsage(latest):null,threadTotal:cumulative?normalizeUsage(cumulative):null,baseline:baseline?normalizeUsage(baseline):null,source,completeness:known?(TERMINAL.has(row.status)?'complete':'observed'):'unknown',live:row.live===true};
}
export function historyObservations(root) {
  const rows=[],errors=[];
  for(const provider of ['codex-a','codex-b']){
    const file=path.join(root,'state','agents',provider,'agent-task-cards.json');let records;
    try{const st=fs.statSync(file);if(st.size>64*1024*1024)throw new Error('历史文件过大，未截断统计');const doc=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));records=Array.isArray(doc.records)?doc.records:[];}catch(e){if(e.code!=='ENOENT')errors.push(provider+'：历史用量暂时不可读');continue;}
    const unique=new Map();
    for(const record of records){const s=record.terminalSnapshot||{},ref=record.agentRef,turn=record.turnId||s.turnId||s.resourceReceipt?.turnId;if(!ref||!turn)continue;const key=ref+':'+turn,old=unique.get(key);if(!old||(record.updatedAt||0)>=(old.updatedAt||0))unique.set(key,record);}
    const groups=new Map();for(const record of unique.values()){const list=groups.get(record.agentRef)||[];list.push(record);groups.set(record.agentRef,list);}
    for(const group of groups.values()){
      group.sort((a,b)=>(time(a.terminalSnapshot?.timing?.startedAt)||a.updatedAt||0)-(time(b.terminalSnapshot?.timing?.startedAt)||b.updatedAt||0));
      let baseline=null,priorEnd=null;
      for(const record of group){
        const s=record.terminalSnapshot||{},receipt=s.resourceReceipt,usage=receipt?.tokenUsage,start=time(s.timing?.startedAt),end=time(s.timing?.endedAt),turn=record.turnId||s.turnId||receipt?.turnId;
        const boundBaseline=record.action==='start'?zeroUsage():(baseline&&priorEnd&&start&&start>=priorEnd?baseline:null);
        const item=normalizeUsageObservation({provider,agentRef:record.agentRef,turnId:turn,model:s.execution?.resolvedModel||record.taskCard?.modelSelection?.selectedModel,title:record.taskCard?.title||record.taskCard?.summary,cwd:record.taskCard?.cwd,status:TERMINAL.has(s.status)?s.status:'unverified',startedAt:start,updatedAt:record.updatedAt,endedAt:end,usage,usageBaseline:boundBaseline,live:false},{source:record.action==='start'?'history_thread_total':'history_thread_delta'});
        if(item)rows.push(item);
        baseline=TERMINAL.has(s.status)&&usage?.threadTotal?usage.threadTotal:null;priorEnd=end;
      }
    }
  }
  const zfile=path.join(root,'state','agents','zcode','jobs.json');
  try{
    const st=fs.statSync(zfile);if(st.size>64*1024*1024)throw new Error('历史文件过大');
    const z=JSON.parse(fs.readFileSync(zfile,'utf8').replace(/^\uFEFF/,''));
    for(const job of Array.isArray(z.records)?z.records:[]){
      const item=normalizeUsageObservation({provider:'zcode',ref:job.ref,turnId:job.ref,model:job.model,title:job.title||'智谱任务',cwd:job.workspace,status:TERMINAL.has(job.status)?job.status:'unverified',startedAt:job.startedAt,updatedAt:job.finishedAt||job.startedAt,endedAt:job.finishedAt,usage:job.usage,usageScope:'turn',live:false},{source:'provider_task_receipt'});
      if(item)rows.push(item);
    }
  }catch(e){if(e.code!=='ENOENT')errors.push('智谱执行器：历史用量暂时不可读');}
  return {rows,errors};
}
function countGroup(rows,key,label){const known=rows.filter(r=>r.usage.totalTokens!==null);const sum=k=>{const v=rows.map(r=>r.usage[k]).filter(x=>x!==null);return v.length?v.reduce((a,b)=>numericSum(a,b),0):null;};return {key,label,turns:rows.length,knownTurns:known.length,...Object.fromEntries(USAGE_METRICS.map(k=>[k,sum(k)]))};}
function groups(rows,selector,labels){const map=new Map();for(const row of rows){const key=selector(row)||'unknown';if(!map.has(key))map.set(key,[]);map.get(key).push(row);}return [...map].map(([key,list])=>countGroup(list,key,labels?.[key]||key)).sort((a,b)=>(b.totalTokens||0)-(a.totalTokens||0));}
export class UsageLedger {
  constructor({root,port=7690,file=null,now=()=>Date.now()}={}){
    this.now=now;this.root=root;this.file=file||path.join(root,'state','operator',port===7690?'usage.sqlite':'usage-candidate-'+port+'.sqlite');this.error=null;this.lastHistoryAt=0;this.historyErrors=[];
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    this.db=new DatabaseSync(this.file,{timeout:3000});
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;');
    this.db.exec('CREATE TABLE IF NOT EXISTS usage_turns (provider TEXT NOT NULL,agent_ref TEXT NOT NULL,turn_id TEXT NOT NULL,started_at REAL NOT NULL,updated_at REAL NOT NULL,model TEXT,project TEXT,payload TEXT NOT NULL,PRIMARY KEY(provider,agent_ref,turn_id)) STRICT; CREATE INDEX IF NOT EXISTS usage_started ON usage_turns(started_at); CREATE INDEX IF NOT EXISTS usage_model ON usage_turns(model); PRAGMA user_version=1;');
    this.get=this.db.prepare('SELECT payload FROM usage_turns WHERE provider=? AND agent_ref=? AND turn_id=?');
    this.put=this.db.prepare('INSERT INTO usage_turns(provider,agent_ref,turn_id,started_at,updated_at,model,project,payload) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(provider,agent_ref,turn_id) DO UPDATE SET started_at=excluded.started_at,updated_at=excluded.updated_at,model=excluded.model,project=excluded.project,payload=excluded.payload');
  }
  record(input,{normalized=false,source='runtime'}={}){
    const row=normalized?input:normalizeUsageObservation(input,{source,now:this.now()});if(!row)return false;
    const cached=this.get.get(row.provider,row.agentRef,row.turnId)?.payload;
    if(cached){
      const seen=JSON.parse(cached);
      if(row.updatedAt<seen.updatedAt)return false;
      const fields=['provider','agentRef','turnId','model','title','project','startedAt','updatedAt','endedAt','status','runtimePid','usage','latestResponseUsage','threadTotal','baseline','source','completeness','live'];
      if(fields.every(key=>JSON.stringify(row[key])===JSON.stringify(seen[key])))return false;
    }
    // Recheck inside the transaction: the panel and runtime may share this ledger.
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const oldJson=this.get.get(row.provider,row.agentRef,row.turnId)?.payload;let old=oldJson?JSON.parse(oldJson):null;
      if(old){
        if(row.updatedAt<old.updatedAt)return this.rollbackFalse();
        const oldKnown=old.usage.totalTokens!==null,newKnown=row.usage.totalTokens!==null;
        if(oldKnown&&(!newKnown||row.usage.totalTokens<old.usage.totalTokens)){
          row.usage=old.usage;row.baseline=old.baseline;row.threadTotal=old.threadTotal;row.completeness=old.completeness==='complete'?'complete':'observed';row.source=old.source;
        }
        if(TERMINAL.has(old.status)&&!TERMINAL.has(row.status)){row.status=old.status;row.endedAt=old.endedAt;row.live=false;}
        for(const k of ['model','title','project','startedAt','runtimePid'])if(row[k]===null)row[k]=old[k];
        row.firstSeenAt=old.firstSeenAt;
        if(JSON.stringify({...old,lastSeenAt:0})===JSON.stringify({...row,lastSeenAt:0}))return this.rollbackFalse();
      }
      row.firstSeenAt??=this.now();row.lastSeenAt=this.now();
      this.put.run(row.provider,row.agentRef,row.turnId,row.startedAt||row.firstSeenAt,row.updatedAt,row.model,row.project,JSON.stringify(row));this.db.exec('COMMIT');this.error=null;return true;
    }catch(e){try{this.db.exec('ROLLBACK');}catch{}this.error=String(e.message);throw e;}
  }
  rollbackFalse(){this.db.exec('ROLLBACK');return false;}
  ingestHistory({force=false}={}){if(!force&&this.now()-this.lastHistoryAt<10000)return;this.lastHistoryAt=this.now();const h=historyObservations(this.root);this.historyErrors=h.errors;for(const r of h.rows)this.record(r,{normalized:true});}
  recordRows(rows,{runtimePid=null}={}){for(const r of rows||[])this.record({...r,runtimePid:r.runtimePid??runtimePid,live:true});}
  report({days=7,provider='',model='',limit=500,offset=0,currentRuntimePid=null}={}){
    const d=Number(days);if(!Number.isInteger(d)||d<1||d>366)throw new Error('统计天数必须在 1 到 366 之间。');
    if(provider&&!Object.hasOwn(PROVIDER_NAMES,provider))throw new Error('统计账号无效。');
    if(typeof model!=='string'||model.length>512)throw new Error('模型筛选无效。');
    if(!Number.isInteger(Number(limit))||Number(limit)<1||Number(limit)>5000||!Number.isInteger(Number(offset))||Number(offset)<0)throw new Error('明细分页参数无效。');
    const now=this.now(),begin=new Date(now);begin.setHours(0,0,0,0);begin.setDate(begin.getDate()-d+1);const from=begin.getTime();
    const sql='SELECT payload FROM usage_turns WHERE started_at>=? AND started_at<=?'+(provider?' AND provider=?':'')+(model?' AND model=?':'')+' ORDER BY started_at DESC';
    const values=[from,now,...(provider?[provider]:[]),...(model?[model]:[])];
    const size=this.db.prepare('SELECT count(*) AS n FROM usage_turns WHERE started_at>=? AND started_at<=?'+(provider?' AND provider=?':'')+(model?' AND model=?':'')).get(...values).n;
    if(size>50000)throw new Error('当前筛选超过五万轮记录，请缩短日期或按账号、模型筛选；不会截断后显示不完整总数。');
    const rows=this.db.prepare(sql).all(...values).map(x=>JSON.parse(x.payload));
    const summary=countGroup(rows,'all','总计');summary.recordedTurns=rows.length;summary.unknownTurns=rows.length-summary.knownTurns;
    summary.activeTurns=rows.filter(r=>r.live&&r.runtimePid===currentRuntimePid&&ACTIVE.has(r.status)).length;summary.completedTurns=rows.filter(r=>['completed','idle'].includes(r.status)).length;summary.failedTurns=rows.filter(r=>['failed','lost'].includes(r.status)).length;summary.stoppedTurns=rows.filter(r=>['interrupted','rejected'].includes(r.status)).length;
    const cacheCovered=rows.filter(r=>r.usage.cachedInputTokens!==null&&r.usage.inputTokens!==null),den=cacheCovered.reduce((n,r)=>n+r.usage.inputTokens,0);summary.cacheHitRate=den>0?cacheCovered.reduce((n,r)=>n+r.usage.cachedInputTokens,0)/den:null;
    const byDay=[];for(let i=0;i<d;i++){const dt=new Date(from);dt.setDate(dt.getDate()+i);const end=new Date(dt);end.setDate(end.getDate()+1);const key=dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');byDay.push(countGroup(rows.filter(r=>(r.startedAt||r.firstSeenAt)>=dt.getTime()&&(r.startedAt||r.firstSeenAt)<end.getTime()),key,key));}
    const byProvider=groups(rows,r=>r.provider,PROVIDER_NAMES),byModel=groups(rows,r=>r.model),byProject=groups(rows,r=>r.project);
    const insights=[];
    if(summary.unknownTurns)insights.push({level:'warning',title:'部分历史用量未获完整回执',text:summary.unknownTurns+' 个轮次缺少可确认的完整用量，不计入总数；未知不等于零。'});
    if(byModel[0]?.totalTokens>0&&summary.totalTokens>0)insights.push({level:'info',title:'主要用量来源',text:byModel[0].label+' 占已确认用量的 '+Math.round(byModel[0].totalTokens/summary.totalTokens*100)+'%。切换模型前仍需确认任务需要。'});
    if(summary.cacheHitRate!==null)insights.push({level:'info',title:'输入缓存利用率',text:Math.round(summary.cacheHitRate*100)+'%（仅在同时报告输入量和缓存量的记录内计算）。缓存量是输入量的一部分。'});
    if(!rows.length)insights.push({level:'info',title:'当前筛选尚无记录',text:'调整日期、账号或模型筛选；新任务有实际回执后才会出现用量。'});
    return {observedAt:new Date(now).toISOString(),period:{days:d,from:new Date(from).toISOString(),to:new Date(now).toISOString(),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone},summary,byDay,byProvider,byModel,byProject,records:rows.slice(Number(offset),Number(offset)+Number(limit)),pagination:{offset:Number(offset),limit:Number(limit),total:rows.length,hasMore:Number(offset)+Number(limit)<rows.length},insights,coverage:{unknownTurns:summary.unknownTurns,notes:['按账号、任务、轮次去重；重复刷新不会累计用量。','优先使用线程累计值与轮次开始基线的差；最后一次响应不冒充整个任务。','趋势按任务开始日归档；跨日任务没有拆成每日消耗。','缓存是输入的子项，推理是输出的子项；不能再次加到总用量。','这些是模型报告的用量，不等于订阅剩余额度或实际账单。',...this.historyErrors]},storage:{persistent:true,version:1,error:this.error}};
  }
  close(){if(this.db?.isOpen)this.db.close();}
}
