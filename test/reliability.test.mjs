import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CodexAppServerClient } from '../state/safe-boot/seed-lkg/codexless-runtime/src/codex-app-server-client.mjs';
import { CodexAgentExecutor } from '../state/safe-boot/seed-lkg/codexless-runtime/src/codex-agent-executor.mjs';
import { LazyCodexAgentExecutor } from '../state/safe-boot/seed-lkg/codexless-runtime/src/lazy-codex-agent-executor.mjs';
import { createCodexAgentRouter } from '../state/safe-boot/seed-lkg/codexless-runtime/src/codex-agent-router.mjs';
import { createCodexAgentProvider } from '../state/safe-boot/seed-lkg/codexless-runtime/src/agent-providers/codex.mjs';
import { createAgentPreviewState, registerAgentPreviewTools } from '../state/safe-boot/seed-lkg/codexless-runtime/src/agent-tools.mjs';
import { registerSpikeAgentTools } from '../state/safe-boot/seed-lkg/codexless-runtime/src/spike-agent-tools.mjs';
import { composeRegisteredToolHandler } from '../state/safe-boot/seed-lkg/codexless-runtime/src/mcp-server-factory.mjs';

const USER_REQUESTED_DELEGATION = Object.freeze({
  basis: 'user_requested',
  rationale: 'This reliability fixture explicitly requests Agent execution.',
});

const server = `
const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.id===undefined)return;
 const send=()=>process.stdout.write(JSON.stringify({id:m.id,result:{method:m.method}})+'\\n');
 if(m.method==='slow'||m.method==='turn/start')setTimeout(send,160);else send();
});`;

test('Windows PowerShell owner receipt can atomically replace an existing file',t=>{
  if(process.platform!=='win32')return;
  const root=new URL('..',import.meta.url);
  if(!existsSync(new URL('RUN-TUNNEL-ACCOUNT-A-TASK.ps1',root))||!existsSync(new URL('RUN-TUNNEL-ACCOUNT-B-TASK.ps1',root))){t.skip('private tunnel owner scripts are intentionally excluded from the public build');return;}
  const script=`$ErrorActionPreference='Stop';$root=Join-Path (Get-Location) 'tmp/generated';New-Item -ItemType Directory -Force -Path $root|Out-Null;$dir=Join-Path $root ('owner-test-'+[guid]::NewGuid());New-Item -ItemType Directory -Path $dir|Out-Null;try{foreach($lane in @('A','B')){$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) ('RUN-TUNNEL-ACCOUNT-'+$lane+'-TASK.ps1')),[ref]$t,[ref]$e);if($e){throw 'syntax error'};$fn=$a.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Write-OwnerReceipt'},$true);Invoke-Expression $fn.Extent.Text;$ownerReceipt=Join-Path $dir ($lane+'.json');$tunnelId='fixture';$organization='fixture';$workspace='fixture';$target='fixture';Write-OwnerReceipt -State ready -RuntimePid 123;Write-OwnerReceipt -State ready -RuntimePid 456;if((Get-Content -Raw -LiteralPath $ownerReceipt|ConvertFrom-Json).runtime_pid -ne 456){throw 'replacement failed'}}}finally{$resolved=[IO.Path]::GetFullPath($dir);$boundary=[IO.Path]::GetFullPath($root)+[IO.Path]::DirectorySeparatorChar;if(!$resolved.StartsWith($boundary)){throw 'unsafe test cleanup'};Remove-Item -LiteralPath $resolved -Recurse -Force}`;
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{cwd:new URL('..',import.meta.url),windowsHide:true,stdio:'pipe',timeout:15000});
});

for (const [name,next,status,turn] of [
  ['new turn',{threadId:'thread',turnId:'new',latestError:'uncertain'},'unknown','new'],
  ['uncertain acceptance',{threadId:'thread',turnId:null,latestError:'acceptance unknown'},'unknown',null],
  ['same terminal',{threadId:'thread',turnId:'old',latestError:'read unavailable'},'completed','old'],
  ['missing agent',{threadId:null,turnId:null,latestError:'unknown agentRef'},'completed','old'],
]) test(`terminal fallback preserves ${name}`, async()=>{
  const state=createAgentPreviewState();let shows=0;
  const terminal={taskRef:'task',agentRef:'agent',threadId:'thread',turnId:'old',status:'completed',latestTurnStatus:'completed',finalResult:'old answer'};
  const persisted={taskRef:'task',phase:'terminal',action:'start',agentRef:'agent',turnId:'old',taskCard:{taskRef:'task',summary:'fixture'},terminalSnapshot:terminal};
  state.taskPersistence={findByAgentRef:()=>structuredClone(persisted),get:()=>structuredClone(persisted),put(){}};
  const handlers=new Map();
  registerAgentPreviewTools({registerTool(name,...args){handlers.set(name,args.at(-1));},registerResource(){}},{agentPreviewState:state,authorityExecutor:{},agentExecutor:{async show(){return ++shows===1?{...terminal,status:'idle'}:{agentRef:'agent',status:'unknown',...next};},async reattach(){throw Error('unexpected reattach');}}});
  const payload=(await handlers.get('codex.agent_show')({agentRef:'agent'})).structuredContent;
  assert.equal(payload.status,status);assert.equal(payload.turnId,turn);
  if(status==='completed')assert.equal(payload.finalResult,'old answer');else assert.notEqual(payload.finalResult,'old answer');
});

test('one agent RPC timeout preserves concurrent requests and later calls without replay', async () => {
  const client = new CodexAppServerClient({ cwd: process.cwd(), launch: () => ({command:process.execPath,args:['-e',server]}), closeOnRequestTimeout:false });
  try {
    await client.start();
    const slow = assert.rejects(client.request('slow',{}, {timeoutMs:50}), {name:'CodexRpcTimeoutError'});
    const accepted = assert.rejects(client.request('turn/start',{}, {timeoutMs:60}), {name:'CodexRpcTimeoutError'});
    assert.equal((await client.request('model/list',{})).method,'model/list');
    await Promise.all([slow,accepted]);
    assert.equal(client.running,true);
    await new Promise(resolve=>setTimeout(resolve,180));
    assert.equal((await client.request('thread/read',{})).method,'thread/read');
  } finally { await client.close(); }
});

test('isolated command clients retain shutdown-on-timeout behavior', async () => {
  const client=new CodexAppServerClient({cwd:process.cwd(),launch:()=>({command:process.execPath,args:['-e',server]})});
  try {await client.start();await assert.rejects(client.request('slow',{}, {timeoutMs:50}));assert.equal(client.running,false);}
  finally {await client.close();}
});

test('an abandoned approval handle cannot settle a new connection request with the same id', async () => {
  const fixture=`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');if(m.method==='initialized')process.stdout.write(JSON.stringify({id:'reused',method:'approval',params:{}})+'\\n');if(m.method==='exit')process.exit(0);});`;
  let arrived;
  const nextHandle=()=>new Promise(resolve=>{arrived=resolve;});
  const client=new CodexAppServerClient({cwd:process.cwd(),launch:()=>({command:process.execPath,args:['-e',fixture]}),serverRequestHandler:handle=>arrived(handle),closeOnRequestTimeout:false});
  try {
    let received=nextHandle();await client.start();const old=await received;
    await assert.rejects(client.request('exit',{}));assert.equal(old.settled,true);
    received=nextHandle();await client.start();const current=await received;
    assert.throws(()=>old.resolve({approved:true}),/unknown or already settled/);
    assert.equal(current.settled,false);current.reject({code:-1,message:'test decline'});assert.equal(current.settled,true);
  } finally {await client.close();}
});

test('child exit reconnects once and retains identities and start idempotency', async () => {
  let running=false, starts=0, turns=0, notifications=0;
  const client={
    get running(){return running;}, initializedResult:{ok:true}, serverRequestMethods:[],
    async start(){starts++;await new Promise(r=>setTimeout(r,15));running=true;return this.initializedResult;},
    onNotification(){notifications++;return()=>notifications--;},
    async close(){running=false;},
    async request(method){
      if(method==='thread/start')return {thread:{id:'thread-stable'}};
      if(method==='turn/start'){turns++;return {turn:{id:'turn-stable',status:'inProgress'}};}
      if(method==='thread/read')return {thread:{status:{type:'idle'}}};
      if(method==='thread/turns/list')return {data:[{id:'turn-stable',status:'completed',items:[]}]};
      if(method==='model/list')return {data:[]};
      throw Error(method);
    }
  };
  const executor=new CodexAgentExecutor({defaultCwd:process.cwd(),clientFactory:()=>client});
  try {
    await executor.open();
    const first=await executor.start({task:'fixture',clientRequestId:'stable'});
    running=false;
    const [shown]=await Promise.all([executor.show({agentRef:first.agentRef}),executor.listModels()]);
    assert.equal(shown.threadId,'thread-stable');assert.equal(shown.turnId,'turn-stable');assert.equal(shown.status,'idle');
    const duplicate=await executor.start({task:'fixture',clientRequestId:'stable'});
    assert.equal(duplicate.agentRef,first.agentRef);assert.equal(duplicate.duplicate,true);
    assert.equal(starts,2);assert.equal(turns,1);assert.equal(notifications,1);
  } finally {await executor.close();}
});

test('lazy executor reopens the same delegate and closes failed initialization', async () => {
  let factories=0, opens=0, closes=0, running=false;
  const delegate={get running(){return running;},async open(){opens++;running=true;},async close(){closes++;running=false;},async listModels(){assert.equal(running,true);return []}};
  const lazy=new LazyCodexAgentExecutor({factory:async()=>{factories++;return delegate;}});
  await lazy.listModels();running=false;await lazy.listModels();
  assert.equal(factories,1);assert.equal(opens,2);await lazy.close();assert.equal(closes,1);
  const failed=new LazyCodexAgentExecutor({factory:async()=>({async open(){throw Error('launch failed');},async close(){closes++;}})});
  await assert.rejects(failed.listModels(),/launch failed/);assert.equal(closes,2);
});

for(const id of ['codex','codex-a'])test(`generic ${id} consent can commit and query through public router`,async()=>{
  const router=createCodexAgentRouter(),handlers=new Map();let committed=0;
  handlers.set('codex.agent_start',router.wrap('codex.agent_start',async()=>({structuredContent:{taskId:'task-a',status:'consent_required'}})));
  handlers.set('codex.agent_commit',router.wrap('codex.agent_commit',async()=>{committed++;return {structuredContent:{agentRef:'agent-a',status:'running'}};}));
  handlers.set('codex.agent_show',router.wrap('codex.agent_show',async()=>({structuredContent:{agentRef:'agent-a',status:'idle'}})));
  const provider=createCodexAgentProvider({id,handlers,routeRegistry:{bind:p=>router.bindPrimary(p,'codex-a')}});
  const prepared=await provider.start({task:'fixture',options:{requestId:'test-a',delegation:USER_REQUESTED_DELEGATION}});
  assert.equal(router.resolveProvider('codex.agent_commit',{taskId:prepared.taskId}),'codex-a');
  const started=await handlers.get('codex.agent_commit')({taskId:prepared.taskId});
  assert.equal(router.resolveProvider('codex.agent_show',{agentRef:started.structuredContent.agentRef}),'codex-a');
  assert.equal((await handlers.get('codex.agent_show')({agentRef:'agent-a'})).structuredContent.status,'idle');assert.equal(committed,1);
  await assert.rejects(handlers.get('codex.agent_show')({agentRef:'unknown-b'}),{code:'AGENT_ROUTE_UNKNOWN'});
});

for (const surface of ['direct', 'codex-a', 'codex-b', 'direct-memory-unavailable-first', 'direct-legacy', 'direct-pre-delegation-raw', 'direct-pre-delegation-enhanced']) test(`${surface} retries survive Memory drift and restart without duplicate turns`, async () => {
  const direct=surface.startsWith('direct');
  let revision=surface==='direct-legacy'?0:1, starts=0, sends=0, current, memoryFailed=surface==='direct-memory-unavailable-first';
  const rows=new Map(), dispatched=[];
  // JSON round-trips intentionally discard Symbols, just like durable checkpoints.
  const copy=value=>JSON.parse(JSON.stringify(value));
  const persistence={put:r=>rows.set(r.taskRef,copy(r)),get:key=>rows.get(key),
    findByRequest:({requestId,action,agentRef})=>[...rows.values()].find(r=>r.requestId===requestId&&r.action===action&&(r.subjectRef??null)===(agentRef??null)),
    findByAgentRef:ref=>[...rows.values()].reverse().find(r=>r.agentRef===ref)};
  const memory={
    beforeAgentStart:({task})=>{if(memoryFailed)throw Error('temporary Memory read failure');return {task:revision?`${task}\n\n<experience_memory>revision ${revision}</experience_memory>`:task,guard:{blocked:false}};},
    beforeAgentSend:({message})=>{if(memoryFailed)throw Error('temporary Memory read failure');return {message:`${message}\n\n<experience_memory>revision ${revision}</experience_memory>`,guard:{blocked:false}};},
  };
  const snapshot=()=>({...current,events:[],nextSeq:1,pendingApproval:null,latestError:null});
  const executor={running:true,
    async start(args){starts++;dispatched.push(args);current={agentRef:'memory-agent',threadId:'memory-thread',turnId:'turn-start',status:'idle',latestTurnStatus:'completed',canSend:true};return snapshot();},
    async send(args){sends++;dispatched.push(args);current={...current,turnId:'turn-send',status:'idle',latestTurnStatus:'completed',canSend:true};return snapshot();},
    async show(){return snapshot();},async reattach(){return snapshot();},
  };
  const build=()=>{
    const handlers=new Map(),state=createAgentPreviewState({meteredConsentMode:'off'});state.taskPersistence=persistence;
    registerAgentPreviewTools({registerTool(name,...args){handlers.set(name,composeRegisteredToolHandler({name,handler:args.at(-1),experienceMemory:memory}));},registerResource(){}},
      {agentExecutor:executor,authorityExecutor:{async resolveAuthority({cwd}){return {effectiveCwd:cwd??process.cwd(),permissionProfile:':read-only'};}},agentPreviewState:state,meteredConsentMode:'off'});
    const provider=createCodexAgentProvider({id:surface,handlers});
    const generic=new Map();registerSpikeAgentTools({registerTool(name,...args){generic.set(name,args.at(-1));}}, {registry:{require:()=>provider},memory});
    return {
      start:(text='Analyze this text',model,delegation=USER_REQUESTED_DELEGATION)=>direct
        ? handlers.get('codex.agent_start')({prompt:text,requestId:'memory-start',delegation,...(model?{model}:{})})
        : generic.get('spike.agent_start')({provider:surface,task:text,requestId:'memory-start',delegation,...(model?{options:{model}}:{})}),
      send:(text='Explain the result')=>direct
        ? handlers.get('codex.agent_send')({agentRef:'memory-agent',message:text,requestId:'memory-send'})
        : generic.get('spike.agent_send')({provider:surface,ref:'memory-agent',message:text,requestId:'memory-send'}),
    };
  };
  let api=build();
  const first=(await api.start()).structuredContent;assert.ok(!first.error,JSON.stringify(first));assert.equal(starts,1);
  if(surface.startsWith('direct-pre-delegation')){
    const raw=surface.endsWith('-raw');
    // Historical receipt format from before the delegation gate: no delegation key.
    const historicalHash=(action,text)=>`${raw?'raw-v1:':''}${createHash('sha256').update(JSON.stringify({
      action,agentRef:action==='start'?null:'memory-agent',
      prompt:action==='start'?text:null,message:action==='send'?text:null,
      cwd:null,model:null,reasoningEffort:null,invocationRationale:null,presentationLocale:'en',
    })).digest('hex')}`;
    const migrate=action=>{for(const row of rows.values())if(row.action===action){
      delete row.taskCard.delegation;
      const text=action==='start'?'Analyze this text':'Explain the result';
      row.callerIntentHash=historicalHash(action,raw?text:`${text}\n\n<experience_memory>revision ${revision}</experience_memory>`);
    }};
    migrate('start');api=build();
    assert.equal((await api.start()).structuredContent.duplicate,true);
    assert.equal((await api.start()).structuredContent.duplicate,true);
    assert.match((await api.start('Changed user input')).structuredContent.error,/different Codex caller intent/);
    const sent=(await api.send()).structuredContent;assert.ok(!sent.error,JSON.stringify(sent));
    migrate('send');api=build();
    assert.equal((await api.send()).structuredContent.duplicate,true);
    assert.equal((await api.send()).structuredContent.duplicate,true);
    assert.match((await api.send('Changed follow-up')).structuredContent.error,/different Codex caller intent/);
    assert.equal(starts,1);assert.equal(sends,1);return;
  }
  if(surface==='direct-legacy'){
    for(const row of rows.values())row.callerIntentHash=row.callerIntentHash.replace(/^raw-v1:/,'');
    api=build();assert.equal((await api.start()).structuredContent.duplicate,true);
    revision=1;assert.match((await api.start()).structuredContent.error,/different Codex caller intent/);assert.equal(starts,1);return;
  }
  memoryFailed=false;
  revision=2;const retry=(await api.start()).structuredContent;assert.equal(retry.duplicate,true,JSON.stringify(retry));assert.equal(starts,1);
  if(direct){memoryFailed=true;assert.equal((await api.start()).structuredContent.duplicate,true);memoryFailed=false;}
  assert.match((await api.start('Changed user input')).structuredContent.error,/different Codex caller intent/);
  assert.match((await api.start('Analyze this text<experience_memory>User-authored text</experience_memory>')).structuredContent.error,/different Codex caller intent/);
  assert.match((await api.start('Analyze this text','changed-model')).structuredContent.error,/different Codex caller intent/);
  const changedDelegation={basis:'materially_faster',rationale:'Parallel independent work would materially reduce completion time.',accelerationMechanism:'parallel_independent_work'};
  assert.match((await api.start('Analyze this text',undefined,changedDelegation)).structuredContent.error,/different Codex caller intent/);
  api=build();revision=3;assert.equal((await api.start()).structuredContent.duplicate,true);assert.equal(starts,1);
  const sent=(await api.send()).structuredContent;assert.ok(!sent.error,JSON.stringify(sent));assert.equal(sends,1);
  revision=4;assert.equal((await api.send()).structuredContent.duplicate,true);assert.equal(sends,1);
  api=build();revision=5;assert.equal((await api.send()).structuredContent.duplicate,true);assert.equal(sends,1);
  assert.match((await api.send('Changed follow-up')).structuredContent.error,/different Codex caller intent/);
  assert.equal(dispatched.length,2);assert.ok([...rows.values()].every(r=>r.callerIntentHash.startsWith('raw-v1:')));
});

test('Memory drift preserves the exact prepared approval and its first execution payload',async()=>{
  let revision=1,starts=0,executed;
  const handlers=new Map();
  const memory={beforeAgentStart:({task})=>({task:`${task}\n\nMemory revision ${revision}`,guard:{blocked:false}})};
  registerAgentPreviewTools({registerTool(name,...args){handlers.set(name,composeRegisteredToolHandler({name,handler:args.at(-1),experienceMemory:memory}));},registerResource(){}},{
    agentExecutor:{running:true,async start(args){starts++;executed=args;return {agentRef:'approved-agent',threadId:'approved-thread',turnId:'approved-turn',status:'running',events:[],nextSeq:1};}},
    authorityExecutor:{async resolveAuthority(){return {effectiveCwd:process.cwd(),permissionProfile:':read-only'};}},
    agentPreviewState:createAgentPreviewState({meteredConsentMode:'always'}),meteredConsentMode:'always',
  });
  const args={prompt:'Analyze this text',requestId:'approval-memory',delegation:USER_REQUESTED_DELEGATION};
  const first=(await handlers.get('codex.agent_start')(args)).structuredContent;
  assert.equal(first.status,'consent_required',JSON.stringify(first));assert.equal(starts,0);
  revision=2;
  const retry=(await handlers.get('codex.agent_start')(args)).structuredContent;
  assert.equal(retry.duplicate,true);assert.equal(retry.taskId,first.taskId);assert.equal(retry.taskRef,first.taskRef);assert.equal(starts,0);
  const committed=(await handlers.get('codex.agent_commit')({taskId:first.taskId??first.taskRef})).structuredContent;
  assert.equal(committed.status,'running',JSON.stringify(committed));assert.equal(starts,1);
  assert.match(executed.task,/Memory revision 1/);assert.doesNotMatch(executed.task,/Memory revision 2/);
});

for(const fault of ['none','startup-fails','cleanup-fails'])test(`production promotion handles ${fault} without premature control calls or overlapping rollback`,async()=>{
  const source=readFileSync(new URL('../runtime/safe-boot/spike-home-production.g3.mjs',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('async function promoteFull(){'),source.indexOf('const STAGED_PROMOTION_RECEIPT_MAX_AGE_MS'));
  let state={lastKnownGood:{digest:'old',artifactPath:'old'}},ready=false,started=0,spawnedAlive=false;
  const calls=[];
  const receipt={digest:'new',artifactPath:'new',productionPid:101,kind:'current'};
  const healthy=digest=>({ok:true,healthz:{body:{artifactDigest:digest,toolCount:50}},readyz:{body:{toolCount:50}}});
  const stubs={
    withLock:fn=>fn(),randomUUID:()=> 'session',gateOperationalCircuit:async()=>({allowed:true}),VERIFIED_PATH:'fixture',json:async()=>receipt,
    process:{env:{}},ROOT:'fixture',PENDING_SCHEMA_VERSION:1,releaseFromRecord:r=>({path:r.artifactPath,manifest:{digest:r.digest}}),verifyIntegrity:async p=>({digest:p}),
    productionIdentity:async()=>({pid:101}),health:async()=>healthy('old'),validateCandidate:async()=>{},preflight:async()=>({passed:true}),
    store:{readState:async()=>state,writeState:async s=>(state=s)},event:async()=>{},fail:m=>{throw Error(m);},releaseRecord:r=>({artifactPath:r.path,digest:r.manifest.digest}),
    legacyIdle:async()=>{},stopExact:async()=>{calls.push('stop-old');},
    writePendingPhase:async(s,p,phase,extra={})=>(state={...s,pending:{...p,phase,...extra}}),
    startRelease:async r=>{started++;calls.push(`start-${r.path}`);spawnedAlive=true;return r.path==='new'?202:303;},
    waitHealth:async(_port,digest)=>{calls.push(`ready-${digest}`);if(digest==='new'&&fault!=='none')throw Error('candidate not ready');ready=true;return healthy(digest);},
    setProductionMaintenance:async()=>{calls.push('maintenance');if(!ready)throw Error('stale control receipt');},
    candidateSurfaceAcceptance:async()=>({toolCount:50,expectedToolCount:50,browser:{status:'ok'},browserAttempts:[]}),
    writeManagedBridgeRecord:async()=>{},closedCircuitBreaker:()=>({state:'closed'}),
    recordOperationalFailure:async()=>({...state,circuitBreaker:{state:'closed',consecutiveFailures:1}}),processAlive:()=>spawnedAlive,
    stopSpawnedProcessTree:async()=>{calls.push('stop-spawned');if(fault==='cleanup-fails')throw Error('cannot verify child exit');spawnedAlive=false;},
    listenerPid:async()=>null,clean:s=>s,
  };
  const promote=new Function(...Object.keys(stubs),`return (${body});`)(...Object.values(stubs));
  const result=await promote();
  if(fault==='none'){
    assert.equal(result.result,'PASS');assert.equal(started,1);
    assert.ok(calls.indexOf('ready-new')<calls.indexOf('maintenance'));assert.equal(state.pending,null);
  }else if(fault==='cleanup-fails'){
    assert.equal(result.stage,'candidate-cleanup');assert.equal(result.rollbackNotStarted,true);assert.equal(result.pendingPreserved,true);assert.equal(started,1);assert.ok(!calls.includes('start-old'));
  }else{
    assert.equal(result.result,'ROLLED_BACK');assert.equal(started,2);assert.ok(calls.indexOf('stop-spawned')<calls.indexOf('start-old'));assert.equal(state.pending,null);
  }
});
