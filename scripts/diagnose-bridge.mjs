// Read-only composite diagnosis. Does not start/restart services or run model turns.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=promisify(execFile);
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8').replace(/^\uFEFF/,''));
function sandboxIdentityStorage(){
  if(process.platform!=='win32')return {ok:true,applicable:false};
  const desktopHome=path.join(process.env.USERPROFILE||'C:\\Users\\Administrator','.codex');
  const homes=[['desktop',desktopHome],['a',path.join(root,'accounts','codex-a')],['b',path.join(root,'accounts','codex-b')]];
  const entries=homes.map(([lane,home])=>{
    try{
      const identityDirectory=fs.realpathSync(path.join(home,'.sandbox-secrets'));
      // Check access only. Never read or emit sandbox passwords in doctor output.
      fs.accessSync(path.join(identityDirectory,'sandbox_users.json'),fs.constants.R_OK);
      const markerFile=path.join(home,'.sandbox','setup_marker.json');
      let marker=null;
      if(fs.existsSync(markerFile))marker=JSON.parse(fs.readFileSync(markerFile,'utf8').replace(/^\uFEFF/,''));
      return {lane,identityDirectory,readable:true,markerPresent:!!marker,markerVersion:marker?.version??null};
    }catch(error){return {lane,readable:false,errorCode:error.code||'INVALID_MARKER'};}
  });
  const shared=entries.every(entry=>entry.readable&&entry.identityDirectory.toLowerCase()===entries[0].identityDirectory?.toLowerCase());
  return {ok:shared,applicable:true,sharedWindowsIdentity:shared,entries,scope:'Windows sandbox identity only; ChatGPT accounts remain separate',note:shared?'Storage agrees; this read-only check does not validate Windows passwords.':'Run the sandbox identity diagnostic before invoking tools; do not retry automatic setup.'};
}
function request(url,body=null){
  return new Promise(resolve=>{
    const started=Date.now();let done=false;
    const finish=value=>{if(!done){done=true;resolve({...value,elapsedMs:Date.now()-started});}};
    const req=http.request(url,{method:body?'POST':'GET',headers:body?{'content-type':'application/json',accept:'application/json, text/event-stream'}:{}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;if(text.length>2*1024*1024)req.destroy(Error('response exceeds diagnostic limit'));});
      res.on('end',()=>{let value=text;try{value=JSON.parse(text);}catch{}finish({ok:res.statusCode===200,status:res.statusCode,value});});
      res.on('error',error=>finish({ok:false,error:error.message}));
    });
    req.setTimeout(8000,()=>req.destroy(Error('local probe timed out after 8000ms')));
    req.on('error',error=>finish({ok:false,error:error.message}));req.end(body?JSON.stringify(body):undefined);
  });
}
const alive=async pid=>{
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(e){if(e.code!=='EPERM')return false;}
  // Windows can deny signal access to a live Scheduled Task child.
  try{const {stdout}=await run('tasklist.exe',['/FI',`PID eq ${pid}`,'/FO','CSV','/NH'],{windowsHide:true,timeout:8000});return stdout.includes(`\",\"${pid}\",`);}catch{return null;}
};
async function task(name){
  try{
    const {stdout}=await run(path.join(process.env.SystemRoot||'C:\\Windows','System32','schtasks.exe'),['/Query','/TN',name,'/XML'],{windowsHide:true,timeout:10000});
    return {name,exists:true,queryStatus:'ok',enabled:!/<Enabled>false<\/Enabled>/.test(stdout),loginTrigger:stdout.includes('<LogonTrigger>'),minuteWatchdog:/<Interval>PT1M<\/Interval>/.test(stdout),ignoreNew:stdout.includes('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'),noExecutionLimit:stdout.includes('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')};
  }catch(error){return {name,exists:null,queryStatus:'failed',errorCode:error.code,note:'Query failed: registration absence, corruption and access restrictions require separate diagnosis.'};}
}
function maintenanceDependencies(){
  const required=['START-SPIKE-BRIDGE.cmd','runtime/safe-boot/spike-home-production.g3.mjs','operator/scripts/system.ps1','operator/scripts/Run-PanelOwner.ps1','operator/scripts/Start-Panel.ps1','RUN-TUNNEL-ACCOUNT-A-TASK.ps1','RUN-TUNNEL-ACCOUNT-B-TASK.ps1','scripts/admin/SET-BRIDGE-TASK-OWNER-ACCESS.ps1'];
  const failures=[];
  for(const file of required){try{fs.accessSync(path.join(root,file),fs.constants.R_OK);}catch(error){failures.push({file,errorCode:error.code});}}
  return {ok:failures.length===0,checked:required.length,failures};
}
async function taskManagementAccess(){
  try{
    const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const {stdout}=await run(executable,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'operator/scripts/system.ps1'),'-Action','inspect'],{windowsHide:true,timeout:12000,maxBuffer:1048576});
    const value=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());
    const grants=['a','b','panel'].map(lane=>({lane,ownerManageable:value.tasks?.[lane]?.ownerManageable===true}));
    return {ok:grants.every(entry=>entry.ownerManageable),grants};
  }catch(error){return {ok:false,errorCode:error.code||'INSPECTION_FAILED'};}
}
async function tunnel(lane){
  let owner;
  try{owner=read(`runtime/state/tunnel-client-${lane}/task-owner.json`);}catch(error){return {lane,ok:false,error:error.message};}
  const [ownerAlive,runtimeAlive]=await Promise.all([alive(owner.launcher_pid),alive(owner.runtime_pid)]);
  const out={lane,ownerState:owner.state,launcherPid:owner.launcher_pid,runtimePid:owner.runtime_pid,ownerAlive,runtimeAlive};
  try{
    const url=new URL(owner.health_base);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('invalid loopback health URL');
    const [h,r,s]=await Promise.all(['/healthz','/readyz','/api/status'].map(p=>request(url.origin+p)));
    return {...out,healthBase:url.origin,live:h.ok&&String(h.value).trim()==='live',ready:r.ok&&String(r.value).trim()==='ready',identityMatch:s.ok&&s.value.control_plane_tunnel_id===owner.tunnel_id,targetMatch:s.ok&&s.value.mcp_server_url==='http://127.0.0.1:7690/mcp',probe:s.value?.channels?.find(c=>c.name==='main')?.probe_status??'unknown',latencyMs:Math.max(h.elapsedMs,r.elapsedMs,s.elapsedMs)};
  }catch(error){return {...out,ok:false,error:error.message};}
}
const [health,ready,panel,a,b,...tasks]=await Promise.all([
  request('http://127.0.0.1:7690/healthz'),request('http://127.0.0.1:7690/readyz'),request('http://127.0.0.1:7692/api/ping'),tunnel('a'),tunnel('b'),
  ...['SpikeBridge-Operator','SpikeBridge-Account-A','SpikeBridge-Account-B'].map(task),
]);
let lkg={};try{const s=read('state/safe-boot/safe-boot-state.json');lkg={digest:s.lastKnownGood?.digest,pending:Boolean(s.pending),circuit:s.circuitBreaker?.state};}catch{}
const rpc=await request('http://127.0.0.1:7690/mcp',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'spike-bridge-doctor',version:'1.0'}}});
let initialized=null;
if(rpc.ok){try{const lines=String(rpc.value).split(/\r?\n/);initialized=typeof rpc.value==='object'?rpc.value:JSON.parse(lines.find(l=>l.startsWith('data: ')).slice(6));}catch{}}
const bridge={healthy:health.ok&&ready.ok&&health.value?.ok===true&&ready.value?.ok===true&&health.value?.service==='spike-home-codexless-overlay',pid:health.value?.pid,toolCount:health.value?.toolCount,version:health.value?.version,digest:health.value?.artifactDigest,lkgMatch:health.value?.artifactDigest===lkg.digest&&Boolean(lkg.digest),mcp:!!initialized?.result?.serverInfo&&!initialized?.error,latencyMs:Math.max(health.elapsedMs,ready.elapsedMs)};
const channels=[a,b].map(c=>({...c,ok:c.live&&c.ready&&c.identityMatch&&c.targetMatch&&c.probe==='ok'&&c.ownerAlive===true&&c.runtimeAlive===true}));
const schedulerOk=tasks.every(t=>t.exists&&t.enabled&&t.loginTrigger&&t.minuteWatchdog&&t.ignoreNew&&t.noExecutionLimit);
const operator={ok:panel.ok&&panel.value?.service==='spike-bridge-operator',pid:panel.value?.pid};
const sandbox=sandboxIdentityStorage();
const maintenance=maintenanceDependencies();
const management=await taskManagementAccess();
const result=bridge.healthy&&bridge.mcp&&bridge.lkgMatch&&operator.ok&&channels.every(c=>c.ok)&&schedulerOk&&!lkg.pending&&sandbox.ok&&maintenance.ok&&management.ok?'PASS':'FAIL';
console.log(JSON.stringify({result,observedAt:new Date().toISOString(),bridge,operator,channels,scheduler:{ok:schedulerOk&&management.ok,tasks,management},sandbox,maintenance,lkg,modelTurnsStarted:0},null,2));
process.exitCode=result==='PASS'?0:1;
