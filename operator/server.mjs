import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_SETTINGS, SETTINGS_FIELDS, HOUSEKEEPING_FIELDS, HOUSEKEEPING_DEFAULTS,
  PROVIDERS, readSettings, readDocument, validateSettings, validateHousekeeping,
  saveDocument, controlEndpoint, atomicWrite, redact,
} from '../state/safe-boot/seed-lkg/codexless-runtime/src/operator-settings.mjs';

import { legacySnapshot, legacyTask } from './legacy-runtime.mjs';
import { explainTask } from './explanations.mjs';
import { UsageLedger } from '../state/safe-boot/seed-lkg/codexless-runtime/src/operator-usage.mjs';
import { ExperienceMemory } from '../state/safe-boot/seed-lkg/codexless-runtime/src/memory/index.mjs';
import { spikeMemoryDbFile } from '../state/safe-boot/seed-lkg/codexless-runtime/src/spike-paths.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const legacyTerminalCache = new Map();
const ACTIVE = ['running', 'starting', 'awaitingApproval', 'cancelling'];
const TERMINAL = ['completed', 'idle', 'failed', 'interrupted', 'rejected', 'lost'];
const json = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const alive = pid => { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch(e) { return e.code === 'EPERM' ? null : false; } };
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; } }
async function fetchBound(url, timeout = 3500) { const r = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'error' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r; }
export async function runtimeCall(root, method, params = {}, { port = 7690, timeout = 12000 } = {}) {
  const receipt = readJson(path.join(root, 'state', 'operator', `runtime-${port}.json`));
  const endpoint = controlEndpoint(root, port);
  if (!receipt || receipt.endpoint !== endpoint || receipt.port !== port || typeof receipt.token !== 'string' || !alive(receipt.pid)) throw new Error('当前桥接尚未连接本机管理接口，或进程已经退出。');
  return new Promise((resolve, reject) => {
    let buffer = ''; let settled = false;
    const socket = net.createConnection(endpoint); socket.setEncoding('utf8'); const end = (err, data) => { if (settled) return; settled = true; socket.destroy(); err ? reject(err) : resolve(data); };
    socket.setTimeout(timeout, () => end(new Error('本机管理接口响应超时。')));
    socket.on('connect', () => socket.write(JSON.stringify({ token: receipt.token, method, params }) + '\n'));
    socket.on('data', chunk => { buffer += chunk.toString('utf8'); if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) return end(new Error('管理数据超出大小限制。')); const n = buffer.indexOf('\n'); if (n < 0) return; try { const r = JSON.parse(buffer.slice(0,n)); if (!r.ok) return end(Object.assign(new Error(r.error), { code: r.code })); end(null, r.result); } catch(e) { end(e); } });
    socket.on('error', () => end(new Error('本机管理接口暂时不可达。')));
    socket.on('end', () => { if (!settled) end(new Error('本机管理接口提前断开。')); });
  });
}
export async function bridgeRpc(method, params = {}, port = 7690) {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`桥接响应异常（${r.status}）。`);
  const text = await r.text();
  const events = r.headers.get('content-type')?.includes('application/json') ? [JSON.parse(text)] : text.split(/\r?\n/).filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));
  for (const event of events) { if (event.error) throw new Error(event.error.message); if (event.result) return event.result; }
  throw new Error('桥接没有返回有效结果。');
}
async function body(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('操作必须使用结构化请求。');
  req.setEncoding('utf8');
  let value = ''; for await (const part of req) { value += part.toString('utf8'); if (Buffer.byteLength(value) > 262144) throw new Error('请求内容过大。'); }
  try { return JSON.parse(value); } catch { throw new Error('请求格式不正确。'); }
}
export function panelErrorMessage(error) {
  const text=String(error?.message??error??'');
  if(/[\u4e00-\u9fff]/.test(text))return redact(text);
  if(/does not offer decline/i.test(text))return '这项请求没有提供“拒绝”选项，尚未确认拒绝。可以重新核对请求，或选择停止当前轮次。';
  if(/unsupported Codex approval request method/i.test(text))return '当前执行器尚不支持这一类审批请求。请查看原始请求，不要反复批准或重复启动任务。';
  if(/approval.*(stale|match|pending)|no pending/i.test(text))return '待处理请求已经变化，请重新打开任务详情并核对最新请求。';
  if(/EACCES|EPERM|access.*denied|permission.*denied/i.test(text))return '系统没有授予所需权限，操作尚未确认完成。请检查本机授权，技术详情已保留在控制台日志中。';
  if(/fetch failed|ECONNREFUSED|ETIMEDOUT|timeout/i.test(text))return '对应服务暂时不可达或响应超时，请查看连接状态；不要立即重复提交可能已开始的操作。';
  return '操作未完成，技术详情已记录。请在“日志与诊断”中核对具体原因。';
}
function unbox(result) { if (result?.isError) { const msg = result.structuredContent?.error || result.content?.map(x=>x.text || '').join('\n') || '操作失败'; throw new Error(msg); } return result?.structuredContent ?? result; }
const RULE_BEGIN='<!-- SPIKE_OPERATOR_RULES_V1_BEGIN -->',RULE_END='<!-- SPIKE_OPERATOR_RULES_V1_END -->';
function splitOperatorRules(instruction=''){
  const text=String(instruction||''),start=text.indexOf(RULE_BEGIN),end=text.indexOf(RULE_END);
  if(start<0||end<start)return {base:text.trim(),rules:[]};
  const block=text.slice(start+RULE_BEGIN.length,end),rules=[];
  for(const line of block.split(/\r?\n/)){const m=line.match(/^\s*-\s*\[([^\]]{1,128})\]\s+(.{1,4000})\s*$/);if(m)rules.push({id:m[1],text:m[2].trim()});}
  return {base:(text.slice(0,start)+text.slice(end+RULE_END.length)).trim(),rules};
}
function compileOperatorRules(base,rules=[]){
  const clean=rules.map(r=>({id:String(r.id||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,128),text:String(r.text||'').replace(/\s+/g,' ').trim().slice(0,4000)})).filter(r=>r.id&&r.text);
  const block=clean.length?`${RULE_BEGIN}\n以下规则由用户在 Bridge 面板逐条维护；与上方基础规则共同生效：\n${clean.map(r=>`- [${r.id}] ${r.text}`).join('\n')}\n${RULE_END}`:'';
  return [String(base||'').trim(),block].filter(Boolean).join('\n\n');
}
function taskHistoryDismissPath(root){return path.join(root,'state','operator','dismissed-task-history.json');}
function taskStamp(task){const raw=task?.updatedAt,numeric=Number(raw);if(Number.isFinite(numeric))return numeric;const parsed=typeof raw==='string'?Date.parse(raw):NaN;return Number.isFinite(parsed)?parsed:null;}
function dismissedTaskThresholds(root){
  const doc=readJson(taskHistoryDismissPath(root)),map=new Map();
  for(const row of Array.isArray(doc?.records)?doc.records:[]){
    if(typeof row?.provider!=='string'||typeof row?.ref!=='string')continue;
    const stamp=Number(row.throughUpdatedAt);if(!Number.isFinite(stamp))continue;
    const key=row.provider+':'+row.ref;map.set(key,Math.max(map.get(key)??-Infinity,stamp));
  }
  return map;
}
function taskDismissed(task,thresholds){const stamp=taskStamp(task),through=thresholds.get(task.provider+':'+task.ref);return stamp!==null&&Number.isFinite(through)&&stamp<=through;}
export function dismissTaskHistory(root,tasks){
  const list=Array.isArray(tasks)?tasks:[tasks],thresholds=dismissedTaskThresholds(root),now=Date.now();
  for(const task of list){
    const stamp=taskStamp(task);if(!task?.provider||!task?.ref||stamp===null)throw new Error('历史任务缺少可持久化身份。');
    const key=task.provider+':'+task.ref;thresholds.set(key,Math.max(thresholds.get(key)??-Infinity,stamp));
  }
  const records=[...thresholds.entries()].map(([key,throughUpdatedAt])=>{const split=key.indexOf(':');return {provider:key.slice(0,split),ref:key.slice(split+1),throughUpdatedAt,deletedAt:now};}).sort((a,b)=>a.provider.localeCompare(b.provider)||a.ref.localeCompare(b.ref));
  if(records.length>5000)throw new Error('历史删除记录过多，请先维护 Operator 状态文件。');
  atomicWrite(taskHistoryDismissPath(root),JSON.stringify({schemaVersion:1,records},null,2));
  return {dismissed:list.length,total:records.length};
}
function taskCanBeDismissed(task){return Boolean(task&&task.provider&&task.ref&&taskStamp(task)!==null&&(!task.live||TERMINAL.includes(task.status)));}

export function readTaskHistory(root, limit = 200) {
  const rows = [],dismissed=dismissedTaskThresholds(root);
  for (const provider of ['codex-a','codex-b']) {
    const p = path.join(root,'state','agents',provider,'agent-task-cards.json'); const doc = readJson(p);
    for (const r of Array.isArray(doc?.records) ? doc.records : []) {
      if (!r.agentRef) continue;
      const raw = r.terminalSnapshot || {}; const terminal = TERMINAL.includes(raw.status);
      const row={ ref:r.agentRef, provider, title:r.taskCard?.title || r.taskCard?.summary || '未命名任务', description:r.taskCard?.summary || r.taskCard?.title, descriptionIncomplete:true, reason:r.taskCard?.invocationRationale, cwd:r.taskCard?.cwd || r.cwd || null, model:r.taskCard?.modelSelection?.selectedModel || raw.execution?.resolvedModel || null, effort:r.taskCard?.modelSelection?.selectedReasoningEffort || null, requestId:r.requestId, turnId:raw.turnId || null, status:terminal ? raw.status : 'unverified', live:false, updatedAt:r.updatedAt, startedAt:r.createdAt || r.updatedAt, endedAt:raw.timing?.endedAt || null, result:raw.finalResult || null };
      if(!taskDismissed(row,dismissed))rows.push(row);
    }
  }
  const newest=new Map();
  for(const row of rows.sort((a,b)=>(b.updatedAt || 0)-(a.updatedAt || 0))){const key=row.provider+':'+row.ref;if(!newest.has(key))newest.set(key,row);}
  return [...newest.values()].slice(0,limit);
}
export async function readTunnel(root, lane) {
  const owner = readJson(path.join(root,'runtime','state',`tunnel-client-${lane}`,'task-owner.json'));
  const out = { lane, name: lane === 'a' ? 'Bridge A' : 'Bridge B', connected:false, ownerAlive:owner ? alive(owner.launcher_pid) : false, runtimeAlive:owner ? alive(owner.runtime_pid) : false, ownerState:owner?.state || 'missing', observedAt:new Date().toISOString(), lastChange:owner?.timestamp || null, runtimePid:owner?.runtime_pid || null, error:null, remoteVerified:false, recovering:false };
  if (!owner) return { ...out, error:'尚未找到通道运行记录。' };
  const changedAt=Date.parse(owner.timestamp || '');
  const freshOwner=Number.isFinite(changedAt) && Date.now()-changedAt < 60_000;
  const recoveryState=['starting','restarting','launching'].includes(String(owner.state || '').toLowerCase());
  const recovering=out.ownerAlive===true && (recoveryState || freshOwner);
  const recoveryView=(message='通道正在恢复连接，请稍候。')=>({ ...out, connected:null, recovering:true, error:message, healthBase:owner.health_base || null });
  if (!owner.health_base && recovering) return recoveryView();
  try {
    const u = new URL(owner.health_base);
    if (u.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || !u.port || u.pathname !== '/') throw new Error('通道健康地址不是本机地址。');
    const base = u.origin;
    const [h,r,s] = await Promise.all([fetchBound(base+'/healthz',8000),fetchBound(base+'/readyz',8000),fetchBound(base+'/api/status',8000)]);
    const [ht,rt,j] = await Promise.all([h.text(),r.text(),s.json()]);
    const targetOk = j.mcp_server_url === 'http://127.0.0.1:7690/mcp';
    const identityOk = j.control_plane_tunnel_id === owner.tunnel_id;
    out.connected = ht.trim() === 'live' && rt.trim() === 'ready' && identityOk && targetOk && j.channels?.find(x=>x.name==='main')?.probe_status === 'ok' && out.runtimeAlive !== false;
    out.processVerified = out.runtimeAlive === true;
    out.processNote = out.runtimeAlive === null ? '当前权限不能直接核验进程；健康端点、通道身份和目标地址已独立核对。' : null;
    Object.assign(out,{ live:ht.trim()==='live',ready:rt.trim()==='ready',probe:j.channels?.find(x=>x.name==='main')?.probe_status||'unknown',targetOk,identityOk,healthBase:base,uptimeSeconds:j.uptime_seconds,proxy:j.control_plane_route?.proxy_url || null,target:j.mcp_server_url });
    if (!out.connected) out.error='通道进程、目标地址或本机探针未全部通过。';
  } catch(e) {
    if (recovering) return recoveryView();
    out.error=redact(e.message);
  }
  return out;
}
export function tailFile(file, maxLines=200) {
  if (!file) return '';
  let fd; try { fd=fs.openSync(file,'r'); const size=fs.fstatSync(fd).size; const len=Math.min(size,256*1024); const buf=Buffer.alloc(len); fs.readSync(fd,buf,0,len,Math.max(0,size-len)); return redact(buf.toString('utf8').split(/\r?\n/).slice(-maxLines).join('\n')); } catch { return '暂无可读取的日志。'; } finally { if(fd!==undefined)fs.closeSync(fd); }
}
export function currentBridgeLogs(root,health) {
  const receipt=readJson(path.join(root,'state/bridge/bridge-7690.pid.json'));
  if(receipt?.pid===health?.pid)return {bridge:receipt.stderr,output:receipt.stdout};
  const dir=path.join(root,'state/safe-boot/boot-sessions');
  if(!fs.existsSync(dir))return {};
  const files=fs.readdirSync(dir).filter(n=>/^boot-[a-f0-9-]+\.jsonl$/.test(n)).map(n=>({n,t:fs.statSync(path.join(dir,n)).mtimeMs})).sort((a,b)=>b.t-a.t).slice(0,100);
  for(const {n}of files){const full=path.join(dir,n);if(fs.statSync(full).size>2097152)continue;for(const line of fs.readFileSync(full,'utf8').split(/\r?\n/)){let x;try{x=JSON.parse(line);}catch{continue;}if(x.type==='process_started'&&x.pid===health?.pid&&x.port===7690&&x.digest===health?.artifactDigest)return {bridge:x.stderr,output:x.stdout};}}
  return {};
}

export function operatorPolicy() {
  return {
    automation: { label:'Agent 自动化规则', source:'当前调用规则与并发设置', scope:'各执行器按照已授权任务、账号隔离和各自能力执行', changedRulesApplyTo:'后续新任务；运行中的任务保留已绑定规则' },
    operator: { label:'操作者面板规则', source:'已认证的本机窗口', scope:'你在页面核对并确认的这一项操作', priority:'明确人工决定优先于 Agent 默认偏好', credentials:'不显示密钥，不接收任意系统命令' },
    effectiveSource:'人工明确决定优先，自动化规则作为默认；系统与执行器权限仍是硬边界',
    canOverrideAgentPreferences:true, osElevationRequired:true,
    authentication:'local_panel_session', physicalPresenceVerified:false,
    notes:['Agent 的请求参数不能自行声明“最高权限”。','面板确认绑定当前任务、当前轮次或当前审批；状态变化后需重新核对。','需要系统管理员权限的安装和修复，必须由系统授权对话框确认。'],
  };
}

export function createPanel({ root=ROOT, port=7692, runtime=runtimeCall, tunnel=readTunnel, bridgeHealth=null, systemAction=null, startWatchdog=true }={}) {
  const stateDir=path.join(root,'state','operator'); fs.mkdirSync(stateDir,{recursive:true});
  const token=randomBytes(32).toString('hex'); const startedAt=new Date().toISOString();
  let usageLedger=null,usageError=null,memoryCompat=null;
  try { usageLedger=new UsageLedger({root}); } catch(e) { usageError=e.message; }
  let settingsDoc; try { settingsDoc=readSettings(root); } catch { settingsDoc={value:structuredClone(DEFAULT_SETTINGS),hash:'invalid'}; }
  let cache=null, cacheAt=0, collecting=null, operation=null, recovering=false, failureCount=0, lastRecovery=0, lastRecoveryCheck=0, schedulerCache=null, schedulerAt=0;
  const operations=new Map();
  function audit(action,status,detail='') {
    const file=path.join(stateDir,'actions.jsonl');
    try { fs.appendFileSync(file,JSON.stringify({at:new Date().toISOString(),action,status,detail:redact(String(detail).slice(0,1500))})+'\n',{mode:0o600});
      if(fs.statSync(file).size>2*1024*1024) atomicWrite(file,tailFile(file,2000)+'\n');
    } catch(e) { console.error('管理记录写入失败：'+e.message); }
  }
  async function system(action,lane='') {
    if(systemAction)return systemAction(action,lane);
    if(process.platform!=='win32')throw new Error('此操作仅在安装控制台的 Windows 电脑上可用。');
    const result=await execFileAsync(path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(HERE,'scripts','system.ps1'),'-Action',action,...(lane?['-Lane',lane]:[])],{cwd:root,windowsHide:true,timeout:60000,maxBuffer:1048576});
    try{return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());}catch{return {message:redact(result.stdout.trim())};}
  }
  async function health() { if(bridgeHealth)return bridgeHealth(); const [h,r]=await Promise.all([fetchBound('http://127.0.0.1:7690/healthz'),fetchBound('http://127.0.0.1:7690/readyz')]); const a=await h.json(), b=await r.json(); return {...a,healthy:a.ok===true&&b.ok===true}; }
  async function collect(force=false) {
    if(!force&&cache&&Date.now()-cacheAt<1500)return cache;
    if(collecting)return collecting;
    collecting=(async()=>{
      let settingsError=null; try{settingsDoc=readSettings(root);}catch(e){settingsError=e.message;}
      const [h,c,a,b]=await Promise.allSettled([health(),runtime(root,'snapshot'),tunnel(root,'a'),tunnel(root,'b')]);
      const safe=readJson(path.join(root,'state','safe-boot','safe-boot-state.json'),{});
      const prod=h.status==='fulfilled'?h.value:{healthy:false,error:'桥接服务当前不可达。'};
      if(Date.now()-schedulerAt>30000 || schedulerCache?.bridgeProcess?.pid!==prod.pid){schedulerAt=Date.now();try{schedulerCache=await system('inspect');}catch(e){schedulerCache={error:redact(e.message)};}}
      let live=c.status==='fulfilled'?c.value:null, legacyError=null;
      if(!live && prod.healthy && prod.version==='0.1.2-preview.9') {
        try { live=await legacySnapshot(root,prod,schedulerCache?.bridgeProcess,bridgeRpc,legacyTerminalCache); } catch(e) { legacyError=e.message; }
      }
      const liveMap=new Map((live?.tasks||[]).map(r=>[`${r.provider}:${r.ref}`,r]));
      const history=readTaskHistory(root,settingsDoc.value.panel.historyLimit);
      const historyMap=new Map(history.map(r=>[`${r.provider}:${r.ref}`,r]));
      const tasks=[...liveMap].map(([k,r])=>({...historyMap.get(k),...r,title:r.title==='任务详情见历史记录'?(historyMap.get(k)?.title||r.title):r.title}));
      for(const r of history)if(!liveMap.has(`${r.provider}:${r.ref}`))tasks.push(r);
      const dismissed=dismissedTaskThresholds(root);
      const visibleTasks=tasks.filter(task=>!taskDismissed(task,dismissed)||!taskCanBeDismissed(task));
      visibleTasks.sort((x,y)=>Number(y.live&&ACTIVE.includes(y.status))-Number(x.live&&ACTIVE.includes(x.status)) || (y.updatedAt||0)-(x.updatedAt||0));
      for(const task of visibleTasks)task.explanation=explainTask(task);
      const lkg=safe.lastKnownGood||null;
      try { usageLedger?.ingestHistory(); if(live&&!live.legacy)usageLedger?.recordRows(live.tasks,{runtimePid:prod.pid}); }
      catch(e) { usageError=e.message; }
      return redact({observedAt:new Date().toISOString(),operatorPolicy:operatorPolicy(),usageRecording:{available:Boolean(usageLedger),error:usageError,native:!!live&&!live.legacy},panel:{pid:process.pid,port,startedAt,version:'1.1.0',background:true},bridge:prod,lkg:{...lkg,active:Boolean(prod.healthy&&lkg?.digest===prod.artifactDigest),pending:safe.pending||null,circuitBreaker:safe.circuitBreaker||null},candidateVerification:readJson(path.join(stateDir,'last-verification.json')),verifiedCandidate:readJson(path.join(root,'state/safe-boot/verified-current.json')),runtime:live,controlConnected:Boolean(live),controlNative:Boolean(live&&!live.legacy),controlError:live?null:(legacyError || (c.status==='rejected'?c.reason.message:null)),settings:{...settingsDoc,error:settingsError},channels:[a.status==='fulfilled'?a.value:{lane:'a',name:'Bridge A',connected:false,error:'探测失败'},b.status==='fulfilled'?b.value:{lane:'b',name:'Bridge B',connected:false,error:'探测失败'}],tasks:visibleTasks.slice(0,settingsDoc.value.panel.historyLimit),scheduler:schedulerCache,machine:{memoryTotal:os.totalmem(),memoryFree:os.freemem(),uptimeSeconds:os.uptime(),cpuCount:os.cpus().length},operation,recovery:{failureCount,lastRecovery:lastRecovery?new Date(lastRecovery).toISOString():null}});
    })();
    try{cache=await collecting;cacheAt=Date.now();return cache;}finally{collecting=null;}
  }
  async function control(method,params={},opts={}) {
    try { return await runtime(root,method,params,opts); } catch(error) {
      const h=await health(); if(h.version!=='0.1.2-preview.9')throw error;
      if(method==='snapshot'){const state=await collect(true);if(!state.runtime)throw error;return state.runtime;}
      if(method==='profile')return bridgeRpc('tools/call',{name:'codex.call_profile',arguments:params});
      if(method==='models'){
        const p=unbox(await bridgeRpc('tools/call',{name:'codex.model_list',arguments:{limit:100,includeHidden:false}}));
        const mapLive=m=>({id:m.model||m.id,name:m.displayName||m.display_name||m.model||m.id,efforts:(m.supportedReasoningEfforts||m.supported_reasoning_levels||[]).map(x=>x.reasoningEffort||x.reasoning_effort||x.effort||x)});
        const b=readJson(path.join(root,'accounts','codex-b','models_cache.json')),bRows=Array.isArray(b?.models)?b.models:[];
        const mapCache=m=>({id:m.slug||m.id,name:m.display_name||m.displayName||m.slug||m.id,efforts:(m.supported_reasoning_levels||m.supportedReasoningEfforts||[]).map(x=>x.effort||x.reasoningEffort||x.reasoning_effort||x)});
        return {'codex-a':(p.models||p.data||[]).map(mapLive),'codex-b':bRows.filter(m=>m.visibility!=='hide').map(mapCache)};
      }
      if(method==='memory'){
        memoryCompat??=new ExperienceMemory({dbPath:spikeMemoryDbFile(root),seed:false});
        if(!memoryCompat.store)throw new Error('Memory Core 当前不可用。');
        if(params.action==='list'){const items=memoryCompat.exportSanitized().items.sort((a,b)=>String(b.updated_at||b.created_at||'').localeCompare(String(a.updated_at||a.created_at||''))).slice(0,Math.max(1,Math.min(1000,Number(params.limit)||300)));return {status:memoryCompat.status(),items};}
        if(params.action==='add'){const title=String(params.title||'').trim(),summary=String(params.summary||'').trim(),scope=String(params.scope||'').trim();if(!title||title.length>500||!summary||summary.length>8000||!['global','machine','provider','project','tool'].includes(scope))throw new Error('Memory 内容或层级无效。');if(scope==='provider'&&!params.provider||scope==='project'&&!params.project||scope==='tool'&&!params.tool)throw new Error('所选 Memory 层级需要填写对应范围。');return memoryCompat.rememberExplicit({explicitUserIntent:true,title,summary,scope,provider:params.provider||null,project:params.project||null,tool:params.tool||null,tags:Array.isArray(params.tags)?params.tags.slice(0,20):[]});}
        if(params.action==='delete'){if(typeof params.id!=='string'||!params.id)throw new Error('Memory ID 无效。');return {deleted:memoryCompat.forget(params.id),id:params.id};}
        throw new Error('不支持此 Memory 操作。');
      }
      if(method==='task'){const state=await collect(true);return legacyTask(root,state.runtime,params,bridgeRpc);}
      throw error;
    }
  }
  function beginOperation(name,fn,requestId) {
    if(typeof requestId!=='string'||!requestId||requestId.length>128)throw new Error('操作缺少请求编号。');
    if(operations.has(requestId))return operations.get(requestId);
    if(operation?.status==='running')throw new Error('已有维护操作正在运行，请等待完成。');
    const item={id:requestId,name,status:'running',startedAt:new Date().toISOString(),endedAt:null,result:null,error:null};
    operations.set(requestId,item);operation=item;audit(name,'开始');
    void (async()=>{try{item.result=redact(await fn());item.status='completed';audit(name,'完成');}catch(e){item.error=redact(e.message);item.status='failed';audit(name,'失败',item.error);}finally{item.endedAt=new Date().toISOString();atomicWrite(path.join(stateDir,'last-operation.json'),JSON.stringify(item,null,2));cacheAt=0;}})();
    return item;
  }
  async function safeBoot(action,expectedDigest=null) {
    const h=action==='promote'?await health():null;
    const result=await execFileAsync(process.execPath,[path.join(root,'runtime','safe-boot','spike-home-production.g3.mjs'),action],{cwd:root,env:{...process.env,...(expectedDigest?{SPIKE_OPERATOR_EXPECTED_DIGEST:expectedDigest}:{}),...(h?.version==='0.1.2-preview.9'?{SPIKE_OPERATOR_BOOTSTRAP:'1'}:{})},windowsHide:true,timeout:240000,maxBuffer:4*1024*1024});
    let parsed;try{parsed=JSON.parse(result.stdout);}catch{throw new Error('安全启动没有返回结构化结果。');}
    if(!['PASS','HEALTHY','STARTED'].includes(parsed.result))throw new Error(`安全启动未完成：${parsed.error||parsed.result||'结果未知'}`);
    return parsed;
  }
  async function handleAction(input) {
    const {action,lane,requestId,expectedDigest}=input;
    if(action==='promote'){const verification=readJson(path.join(stateDir,'last-verification.json'));const current=readJson(path.join(root,'state/safe-boot/verified-current.json'));if(verification?.result!=='PASS'||!expectedDigest||expectedDigest!==verification.receipt?.digest||expectedDigest!==current?.digest)throw new Error('候选尚未验证通过，或候选已变化。请先验证管理版本并重新核对。');}
    const names={ensure:'启动或恢复桥接',verify:'验证管理版本候选',promote:'发布已验证候选',restart:'重启当前稳定版本',channelStart:'启动通道',channelStop:'停用通道',channelRestart:'重新连接通道',housekeepingPreview:'预览清理范围',housekeepingRun:'执行保守清理',startupEnable:'启用面板登录自启',startupDisable:'关闭面板登录自启'};
    if(!names[action])throw new Error('不支持的维护操作。');
    if(action.startsWith('channel')&&!['a','b'].includes(lane))throw new Error('必须指定 Bridge A 或 Bridge B。');
    if(input.confirmed!==true&&['promote','restart','channelStop','channelRestart','housekeepingRun'].includes(action))throw new Error('请先确认此次维护操作的影响。');
    return beginOperation(names[action],async()=>{
      if(['promote','restart'].includes(action)){
        const status=await control('snapshot');
        if(status.counts.active||status.counts.awaitingApproval||status.counts.starting||status.counts.uncertain)throw new Error('仍有运行、审批或状态不明的任务。请等任务结束后再维护，控制台不会擅自中断。');
      }
      if (action === 'verify') { await execFileAsync(process.execPath, [path.join(root,'operator','scripts','verify-reviewed.mjs')], {cwd:root,windowsHide:true,timeout:240000,maxBuffer:4*1024*1024}); return {result:'PASS',message:'候选测试与验证通过，生产尚未切换。'}; }
      if(['ensure','promote','restart'].includes(action))return safeBoot(action,expectedDigest);
      if(action.startsWith('channel'))return system(action,lane);
      if(action.startsWith('startup')){const r=await system(action);schedulerAt=0;return r;}
      return runtime(root,'housekeeping',{action:action==='housekeepingPreview'?'preview':'run'},{timeout:120000});
    },requestId);
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try{
      const host=req.headers.host;const allowedHosts=[`127.0.0.1:${port}`,`localhost:${port}`];
      if(!allowedHosts.includes(host))return json(res,403,{error:'管理面板仅允许本机访问。'});
      if(req.headers.origin&&!allowedHosts.map(h=>'http://'+h).includes(req.headers.origin))return json(res,403,{error:'拒绝来自其他网页的管理请求。'});
      const url=new URL(req.url,'http://'+host);
      if(url.pathname==='/api/ping')return json(res,200,{service:'spike-bridge-operator',apiVersion:1,pid:process.pid,startedAt});
      if(url.pathname.startsWith('/api/')){
        const auth=req.headers['x-panel-token'];if(typeof auth!=='string'||auth.length!==token.length||!timingSafeEqual(Buffer.from(auth),Buffer.from(token)))return json(res,401,{error:'窗口认证已过期，请从桌面重新打开控制台。'});
        if(req.method==='GET'&&url.pathname==='/api/state')return json(res,200,await collect());
        if(req.method==='GET'&&url.pathname==='/api/policy')return json(res,200,operatorPolicy());
        if(req.method==='GET'&&['/api/usage','/api/usage/export'].includes(url.pathname)){
          if(!usageLedger)throw new Error('用量数据库暂不可用：'+(usageError||'未初始化'));
          const status=await collect();
          const report=usageLedger.report({days:Number(url.searchParams.get('days')||7),provider:url.searchParams.get('provider')||'',model:url.searchParams.get('model')||'',limit:Number(url.searchParams.get('limit')||(url.pathname.endsWith('/export')?5000:500)),offset:Number(url.searchParams.get('offset')||0),currentRuntimePid:status.bridge?.pid});
          if(!status.controlNative){report.summary.activeTurns=null;report.coverage.notes.push('当前生产为兼容模式：已有正式回执可回填，正在执行的轮次尚未提供实时累计数据；这里不把未知显示为零。');}
          if(usageError)report.coverage.notes.push('最近记录错误：'+redact(usageError));
          return json(res,200,report);
        }
        if(req.method==='GET'&&url.pathname==='/api/catalog')return json(res,200,{fields:SETTINGS_FIELDS,housekeeping:HOUSEKEEPING_FIELDS});
        if(req.method==='GET'&&url.pathname==='/api/settings')return json(res,200,readSettings(root));
        if(req.method==='POST'&&url.pathname==='/api/settings'){
          const data=await body(req);const saved=saveDocument(root,path.join(root,'config','operator.json'),data.value,data.expectedHash,validateSettings);settingsDoc=saved;
          let applied=false,applyError=null;try{const ack=await runtime(root,'reload');applied=ack.hash===saved.hash;}catch(e){applyError=e.message;}
          cacheAt=0;audit('保存管理设置',applied?'已生效':'已保存，待运行时连接');return json(res,200,{...saved,applied,applyError});
        }
        if(req.method==='GET'&&url.pathname==='/api/housekeeping')return json(res,200,readDocument(path.join(root,'config','housekeeping.json'),HOUSEKEEPING_DEFAULTS));
        if(req.method==='POST'&&url.pathname==='/api/housekeeping'){
          const data=await body(req),validated=validateHousekeeping(data.value);
          for(const item of validated.protectedPaths){const full=path.isAbsolute(item)?path.resolve(item):path.resolve(root,item),rel=path.relative(root,full);if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('保护路径必须位于 Spike Bridge 项目目录内。');}
          const saved=saveDocument(root,path.join(root,'config','housekeeping.json'),validated,data.expectedHash,validateHousekeeping);
          let applied=false;try{await runtime(root,'housekeeping',{action:'reload'},{timeout:120000});applied=true;}catch{}
          audit('保存清理设置',applied?'已生效':'已保存');cacheAt=0;return json(res,200,{...saved,applied});
        }
        if(req.method==='GET'&&url.pathname==='/api/profile')return json(res,200,unbox(await control('profile',{action:'show'})));
        if(req.method==='POST'&&url.pathname==='/api/profile'){
          const data=await body(req);if(typeof data.instruction!=='string'||data.instruction.length>40000||typeof data.requireCallApproval!=='boolean')throw new Error('调用规则内容无效。');
          const result=unbox(await control('profile',{action:'save',instruction:data.instruction,requireCallApproval:data.requireCallApproval,expectedProfileHash:data.expectedProfileHash,expectedProfileRevision:data.expectedProfileRevision}));audit('保存调用与审批规则','完成');return json(res,200,result);
        }
        if(req.method==='GET'&&url.pathname==='/api/rules'){
          const current=unbox(await control('profile',{action:'show'})),p=current.profile||current,parts=splitOperatorRules(p.instruction||'');
          return json(res,200,{rules:parts.rules,baseInstruction:parts.base,requireCallApproval:p.effective?.requireCallApproval??p.requireCallApproval??true,profileHash:p.profileHash||p.hash,profileRevision:p.profileRevision});
        }
        if(req.method==='POST'&&url.pathname==='/api/rules'){
          const data=await body(req);if(data.confirmed!==true||!['add','delete','update'].includes(data.action))throw new Error('请确认这一次自动化规则修改。');
          const current=unbox(await control('profile',{action:'show'})),p=current.profile||current,parts=splitOperatorRules(p.instruction||'');let rules=parts.rules.slice();
          if(data.action==='add'){const text=String(data.text||'').replace(/\s+/g,' ').trim();if(!text||text.length>4000)throw new Error('规则内容不能为空且不能超过 4000 字。');if(rules.length>=100)throw new Error('逐条规则已达到 100 条上限。');rules.push({id:'rule_'+randomUUID(),text});}
          if(data.action==='delete'){const before=rules.length;rules=rules.filter(r=>r.id!==data.id);if(rules.length===before)throw new Error('这条规则已经不存在，请刷新。');}
          if(data.action==='update'){const text=String(data.text||'').replace(/\s+/g,' ').trim(),row=rules.find(r=>r.id===data.id);if(!row||!text||text.length>4000)throw new Error('规则已经变化或内容无效。');row.text=text;}
          const instruction=compileOperatorRules(parts.base,rules),saved=unbox(await control('profile',{action:'save',instruction,requireCallApproval:p.effective?.requireCallApproval??p.requireCallApproval??true,expectedProfileHash:p.profileHash||p.hash,expectedProfileRevision:p.profileRevision}));audit('逐条自动化规则：'+data.action,'完成',data.id||data.text||'');return json(res,200,{saved,rules,baseInstruction:parts.base});
        }
        if(req.method==='GET'&&url.pathname==='/api/models')return json(res,200,await control('models',{}, {timeout:30000}));
        if(req.method==='GET'&&url.pathname==='/api/memory')return json(res,200,await control('memory',{action:'list',limit:Number(url.searchParams.get('limit')||300)}));
        if(req.method==='POST'&&url.pathname==='/api/memory'){
          const data=await body(req);if(data.confirmed!==true||!['add','delete'].includes(data.action))throw new Error('请明确确认这一次 Memory 修改。');
          const result=await control('memory',data,{timeout:30000});audit(data.action==='add'?'新增 Memory':'删除 Memory','完成',data.id||data.title||'');cacheAt=0;return json(res,200,result);
        }
        if(req.method==='POST'&&url.pathname==='/api/task-history'){
          const data=await body(req);if(data.confirmed!==true||data.action!=='dismiss')throw new Error('请确认删除这一条历史任务记录。');
          const expectedStamp=taskStamp({updatedAt:data.updatedAt});
          if(typeof data.provider!=='string'||typeof data.ref!=='string'||!data.provider||!data.ref||expectedStamp===null)throw new Error('历史任务身份无效。');
          const current=await collect(true);
          const target=current.tasks.find(task=>task.provider===data.provider&&task.ref===data.ref&&taskStamp(task)===expectedStamp);
          if(!target)throw new Error('这条历史任务已经变化、已删除或不再可见，请刷新后重新核对。');
          if(!taskCanBeDismissed(target))throw new Error('当前运行、待处理或状态不明的任务不能删除；请先等任务进入已结束状态。');
          const result=dismissTaskHistory(root,target);audit('删除历史任务记录','完成',`${target.provider}:${target.ref}`);cacheAt=0;return json(res,200,result);
        }
        if(req.method==='POST'&&url.pathname==='/api/task'){
          const data=await body(req);if(data.confirmed!==true)throw new Error('请确认对这一个任务的操作。');
          const result=unbox(await control('task',data));audit('任务操作：'+data.action,'完成',data.ref);cacheAt=0;return json(res,200,result);
        }
        if(req.method==='POST'&&url.pathname==='/api/action')return json(res,202,await handleAction(await body(req)));
        if(req.method==='GET'&&url.pathname==='/api/logs'){
          const kind=url.searchParams.get('kind')||'bridge';
          if(!['bridge','output','operator'].includes(kind))throw new Error('不支持的日志分类。');
          let logHealth=null;try{logHealth=await health();}catch{}
          const files={...(logHealth?currentBridgeLogs(root,logHealth):{}),operator:path.join(stateDir,'actions.jsonl')};let target=files[kind];
          let sourceState='current';
          if(!target&&!logHealth&&kind!=='operator'){
            const lastReceipt=readJson(path.join(root,'state/bridge/bridge-7690.pid.json'));
            target=kind==='bridge'?lastReceipt?.stderr:lastReceipt?.stdout;sourceState='last_known';
          }
          if(!target)return json(res,200,{kind,text:'尚未找到与当前实例匹配的日志；不会展示旧实例日志作为当前结果。',observedAt:new Date().toISOString()});
          if(!target)throw new Error('不支持的日志分类。');const rel=path.relative(root,target);if(rel.startsWith('..')||path.isAbsolute(rel)||(!rel.startsWith('logs'+path.sep)&&kind!=='operator'))throw new Error('日志路径不在允许范围。');
          const prefix=sourceState==='last_known'?'【上一次实例日志】当前桥接不可达，以下仅用于故障排查，不代表该实例仍在运行。\n\n':'';
          return json(res,200,{kind,sourceState,text:prefix+tailFile(target,settingsDoc.value.panel.logLines),observedAt:new Date().toISOString()});
        }
        if(req.method==='GET'&&url.pathname==='/api/diagnostics'){
          const state=await collect(true);const report={...state,settings:{revision:state.settings.value?.revision,hash:state.settings.hash,error:state.settings.error},tasks:state.tasks.map(({ref,provider,status,live,model,updatedAt})=>({ref,provider,status,live,model,updatedAt})),runtime:state.runtime?{...state.runtime,tasks:state.runtime.tasks.map(({ref,provider,status})=>({ref,provider,status}))}:null};
          return json(res,200,redact(report));
        }
        return json(res,404,{error:'此管理接口不存在。'});
      }
      if(req.method!=='GET')return json(res,405,{error:'不支持此请求方式。'});
      const assets={'/':'index.html','/app.js':'app.js','/app.css':'app.css'};const file=assets[url.pathname];if(!file)return json(res,404,{error:'页面不存在。'});
      const mime=file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript';
      res.writeHead(200,{'content-type':mime+'; charset=utf-8','cache-control':'no-store'});res.end(fs.readFileSync(path.join(HERE,'web',file)));
    }catch(e){
      audit('控制台请求失败','失败',e.message);
      json(res,e.code==='CONFLICT'?409:400,{error:panelErrorMessage(e),detail:redact(e.message),code:e.code||'OPERATOR_ERROR'});
    }
  });
  server.requestTimeout=20000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  async function watchdog(){
    try{const cfg=readSettings(root).value.recovery;if(!cfg.enabled||Date.now()-lastRecoveryCheck<cfg.intervalSeconds*1000)return;lastRecoveryCheck=Date.now();
      try{const h=await health();if(h.healthy){failureCount=0;return;}}catch{}failureCount++;
      if(failureCount<cfg.failureThreshold||recovering||operation?.status==='running'||Date.now()-lastRecovery<cfg.cooldownSeconds*1000)return;
      recovering=true;lastRecovery=Date.now();audit('自动恢复桥接','开始');try{await safeBoot('ensure');failureCount=0;audit('自动恢复桥接','完成');}catch(e){audit('自动恢复桥接','失败',e.message);}finally{recovering=false;}
    }catch(e){audit('后台检查','失败',e.message);}
  }
  let timer;
  return {server,token,port,root,collect,
    async start(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});atomicWrite(path.join(stateDir,'panel-access.json'),JSON.stringify({pid:process.pid,port,token,startedAt,service:'spike-bridge-operator'}));if(startWatchdog){timer=setInterval(()=>void watchdog(),5000);timer.unref();}return this;},
    async close(){clearInterval(timer);server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));usageLedger?.close();memoryCompat?.close();},
  };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const app=createPanel({root:process.env.SPIKE_BRIDGE_ROOT||ROOT,port:Number(process.env.SPIKE_PANEL_PORT||7692)});
  await app.start();console.log('Bridge 后台已启动，监听本机端口 '+app.port+'。');
  let closing=false;const stop=()=>{if(closing)return;closing=true;void app.close().finally(()=>process.exit(0));};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
