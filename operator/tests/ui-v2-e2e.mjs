// UI-only browser tests. No production imports with side effects, credentials, tasks or servers.
// Run: node operator/tests/ui-v2-e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {DEFAULT_SETTINGS,SETTINGS_FIELDS,HOUSEKEEPING_FIELDS,HOUSEKEEPING_DEFAULTS} from '../../state/safe-boot/seed-lkg/codexless-runtime/src/operator-settings.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const shots=path.join(root,'design/reviews/operator/ux-v2');
const work=path.join(root,'tmp/generated/operator-ui-v2-'+process.pid);
const edge=[process.env.SPIKE_UI_TEST_BROWSER,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find(p=>fs.existsSync(p));
if(!edge)throw new Error('No local test browser. Set SPIKE_UI_TEST_BROWSER to an installed Chromium executable.');
fs.mkdirSync(shots,{recursive:true});fs.mkdirSync(work,{recursive:true});
const stamp=()=>new Date().toISOString();
const settings=structuredClone(DEFAULT_SETTINGS);settings.panel.historyLimit=1000;
const request=(id='request-1')=>({requestId:id,method:'mcpServer/elicitation/request',reason:'需要确认报表参数。',details:{kind:'elicitation',requiresContent:true,message:'请填写报表名称与份数。',serverName:'本地报表工具',url:'http://example.invalid/report',requiredFields:['name','copies','mode','publish'],requestedSchema:{type:'object',required:['name','copies','mode','publish'],properties:{name:{type:'string',title:'报表名称',minLength:2},copies:{type:'integer',title:'份数',minimum:1,maximum:5},mode:{type:'integer',title:'处理方式',enum:[10,20]},publish:{type:'boolean',title:'是否公开'}}}}});
const mock={
  stateDelay:800,stateStatus:200,catalogStatus:200,usageDelay:0,usageStatus:200,postDelay:0,
  profileDelay:0,houseDelay:0,logDelay:0,posts:[],queries:[],apiReads:[],usageQueries:[],
  state:{observedAt:stamp(),controlConnected:true,runtime:{legacy:false,settingsHash:'hash-0',settingsRevision:0,counts:{active:3,awaitingApproval:2,counted:5,uncertain:1},commands:{inFlight:1},memory:{enabled:true,items:24,dbPath:'F:/mock/memory.sqlite'}},bridge:{healthy:true,version:'mock-ui-only',pid:123,toolCount:50,artifactDigest:'fixture-digest'},lkg:{active:true,digest:'fixture-digest',circuitBreaker:{state:'closed'}},panel:{port:0,pid:456},channels:[{lane:'a',name:'Bridge A',connected:true,ownerAlive:true,runtimePid:111,proxy:'http://127.0.0.1:7890',healthBase:'http://127.0.0.1:19999',uptimeSeconds:600},{lane:'b',name:'Bridge B',connected:null,error:'尚未提供本机探测结果'}],machine:{memoryFree:8*1024**3,memoryTotal:32*1024**3,uptimeSeconds:3600},settings:{hash:'hash-0',value:settings},operation:null,candidateVerification:null,operatorPolicy:{automation:{scope:'后续新任务按自动化规则运行'},operator:{scope:'已核对的这一项请求'},effectiveSource:'明确人工决定优先于 Agent 默认偏好；系统与执行器权限仍是硬边界',canOverrideAgentPreferences:true,osElevationRequired:true},tasks:[]},
  profile:{profile:{instruction:'所有任务遵循项目范围。',effective:{requireCallApproval:true},profileHash:'profile-0',profileRevision:0}},
  rules:{baseInstruction:'所有任务遵循项目范围。',requireCallApproval:true,rules:[{id:'rule-existing',text:'发布前先检查活动任务。'}]},
  memory:{status:{enabled:true,items:2,core:2,evidence:0},items:[{id:'mem-1',title:'发布前检查',summary:'发布前先检查活动任务。',scope:'machine',status:'active',confidence:'high',updated_at:stamp(),tags:['release']},{id:'mem-2',title:'项目偏好',summary:'这个项目使用中文说明。',scope:'project',project:'F:/mock/project',status:'active',confidence:'high',updated_at:stamp(),tags:['ui']}]},
  house:{value:structuredClone(HOUSEKEEPING_DEFAULTS),hash:'house-0'}
};
mock.state.tasks=[
  {provider:'codex-b',ref:'task-form',turnId:'turn-1',live:true,status:'awaitingApproval',title:'生成项目运行周报',description:'整理本周改动。这段任务说明不替代具体动作授权。',model:'gpt-6-astra',cwd:'F:/mock/project',startedAt:stamp(),updatedAt:stamp(),pendingApproval:request()},
  {provider:'codex-a',ref:'task-command',turnId:'turn-c',live:true,status:'awaitingApproval',title:'检查本地资源',model:'gpt-6-astra',cwd:'F:/mock/project',startedAt:stamp(),updatedAt:stamp(),pendingApproval:{requestId:'command-r',details:{kind:'command',command:'echo "<img src=x onerror=window.__injected=true>"; Remove-Item -LiteralPath F:/mock/only',cwd:'F:/mock/only',reason:'任务说可以继续，所以请求方声称安全。'}}},
  {provider:'zcode',ref:'task-live',turnId:'turn-z',live:true,status:'running',title:'对照界面与产品需求',model:'glm-fixture',cwd:'F:/mock/another',startedAt:stamp(),updatedAt:stamp(),result:'已完成导航检查，正在整理信息层级。',usage:{totalTokens:1400,inputTokens:1000,cachedInputTokens:500,outputTokens:400,reasoningOutputTokens:100}},
  {provider:'mac',ref:'task-unknown',turnId:null,live:true,status:'unknown',title:'等待远程状态核验',updatedAt:stamp()},
  ...Array.from({length:125},(_,i)=>({provider:'codex-b',ref:'history-'+i,turnId:'h-'+i,live:false,status:i%2?'completed':'unverified',title:'历史记录 '+i+' · '+(i===0?'长标题'.repeat(100):'开发任务'),model:'gpt-6-astra',cwd:'F:/mock/'+'long-path/'.repeat(i===0?30:1),startedAt:stamp(),updatedAt:stamp()}))
];
function usage(){
 const records=Array.from({length:123},(_,i)=>({provider:i%2?'codex-a':'codex-b',agentRef:'usage-task-'+i,turnId:'usage-turn-'+i,model:i%2?'gpt-6-astra':'model-fixture',title:i===0?'<img src=x onerror=window.__injected=true> 用量证据':'任务用量 '+i,project:'F:/mock/'+(i===0?'long-path/'.repeat(30):'project'),startedAt:stamp(),updatedAt:stamp(),endedAt:i%3?stamp():null,status:i%3?'completed':'running',usage:{totalTokens:i===0?null:1500,inputTokens:1000,cachedInputTokens:500,outputTokens:500,reasoningOutputTokens:100},completeness:i===0?'unknown':'complete',source:'mock-receipt'}));
 return {observedAt:stamp(),period:{days:7,from:'2026-09-07T00:00:00.000Z',to:stamp(),timeZone:'Asia/Shanghai'},summary:{recordedTurns:123,knownTurns:122,unknownTurns:1,totalTokens:183000,inputTokens:122000,cachedInputTokens:61000,outputTokens:61000,reasoningOutputTokens:12200,cacheHitRate:.5,activeTurns:41,completedTurns:82,failedTurns:0},byDay:Array.from({length:7},(_,i)=>({key:'2026-09-'+(7+i),label:'9/'+(7+i),turns:20,knownTurns:i===2?0:20,totalTokens:i===2?null:i===0?0:20000+i*1500,inputTokens:10000,outputTokens:10000})),byProvider:[{key:'codex-b',label:'codex-b',turns:62,knownTurns:61,totalTokens:91500},{key:'codex-a',label:'codex-a',turns:61,knownTurns:61,totalTokens:91500}],byModel:[{key:'gpt-6-astra',label:'gpt-6-astra',turns:61,knownTurns:61,totalTokens:91500},{key:'model-fixture',label:'model-fixture',turns:62,knownTurns:61,totalTokens:91500}],byProject:[{key:'F:/mock/project',label:'F:/mock/project',turns:123,knownTurns:122,totalTokens:183000}],records,insights:[{level:'info',title:'存在未知用量',text:'1 个轮次尚无总量回执，不能补零。'}],coverage:{unknownTurns:1,notes:['模拟数据，仅用于隔离浏览器验证。']}};
}
mock.usage=usage();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1'),route=url.pathname;
  const json=(code,data)=>{if(!res.destroyed){res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(data));}};
  if(route.startsWith('/api/')){
   mock.apiReads.push(route);
   if(req.headers['x-panel-token']!=='ui-test-only')return json(401,{error:'模拟：窗口认证已过期'});
   if(req.method==='POST'){
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);mock.posts.push({route,body});
    if(mock.postDelay)await sleep(mock.postDelay);
    if(route==='/api/settings'){if(body.expectedHash!==mock.state.settings.hash)return json(409,{error:'模拟保存冲突'});const value=structuredClone(body.value);value.revision=mock.state.settings.value.revision+1;mock.state.settings={value,hash:'hash-'+value.revision};mock.state.runtime.settingsHash=mock.state.settings.hash;return json(200,{...mock.state.settings,applied:true});}
    if(route==='/api/profile'){mock.profile={profile:{instruction:body.instruction,effective:{requireCallApproval:body.requireCallApproval},profileHash:'profile-1',profileRevision:1}};return json(200,mock.profile);}
    if(route==='/api/rules'){if(body.action==='add'){mock.rules.rules.push({id:'rule-'+(mock.rules.rules.length+1),text:body.text});}else if(body.action==='delete'){mock.rules.rules=mock.rules.rules.filter(r=>r.id!==body.id);}else if(body.action==='update'){const r=mock.rules.rules.find(r=>r.id===body.id);if(r)r.text=body.text;}return json(200,{rules:mock.rules.rules,baseInstruction:mock.rules.baseInstruction});}
    if(route==='/api/memory'){if(body.action==='add'){mock.memory.items.push({id:'mem-'+(mock.memory.items.length+1),title:body.title,summary:body.summary,scope:body.scope,provider:body.provider,project:body.project,tool:body.tool,status:'active',confidence:'high',updated_at:stamp(),tags:body.tags||[]});mock.memory.status.items=mock.memory.items.length;return json(200,{accepted:true});}if(body.action==='delete'){mock.memory.items=mock.memory.items.filter(m=>m.id!==body.id);mock.memory.status.items=mock.memory.items.length;return json(200,{deleted:true});}}
    if(route==='/api/housekeeping'){mock.house={value:body.value,hash:'house-1'};return json(200,{...mock.house,applied:false});}
    if(route==='/api/task'){const t=mock.state.tasks.find(t=>t.ref===body.ref);if(!t||body.expectedTurnId!==t.turnId||body.action!=='cancel'&&body.approvalRequestId!==t.pendingApproval?.requestId)return json(409,{error:'模拟：请求已变化'});t.pendingApproval=null;t.status=body.action==='cancel'?'interrupted':'running';return json(200,{ok:true});}
    if(route==='/api/task-history'){const index=mock.state.tasks.findIndex(t=>t.provider===body.provider&&t.ref===body.ref&&t.updatedAt===body.updatedAt);if(index<0)return json(409,{error:'模拟：历史任务已变化'});const t=mock.state.tasks[index];if(t.live&&!['completed','idle','failed','interrupted','rejected','lost'].includes(t.status))return json(400,{error:'模拟：当前任务不能删除'});mock.state.tasks.splice(index,1);return json(200,{dismissed:1});}
    if(route==='/api/action'){mock.state.operation={name:'模拟清理预览',status:'completed',endedAt:stamp(),result:{fixture:true,files:[]}};return json(202,{ok:true});}
    return json(404,{error:'mock route missing'});
   }
   if(route==='/api/catalog')return json(mock.catalogStatus,mock.catalogStatus===200?{fields:SETTINGS_FIELDS,housekeeping:HOUSEKEEPING_FIELDS}:{error:'模拟：窗口认证已过期'});
   if(route==='/api/state'){if(mock.stateDelay)await sleep(mock.stateDelay);if(mock.stateStatus!==200)return json(mock.stateStatus,{error:mock.stateStatus===401?'模拟：窗口认证已过期':'模拟：后台不可达'});mock.state.observedAt=stamp();return json(200,mock.state);}
   if(route==='/api/usage'){mock.usageQueries.push(url.search);const data=structuredClone(mock.usage),delay=mock.usageDelay,status=mock.usageStatus;if(delay)await sleep(delay);return json(status,status===200?data:{error:'模拟：用量接口暂不可用'});}
   if(route==='/api/profile'){if(mock.profileDelay)await sleep(mock.profileDelay);return json(200,mock.profile);}
   if(route==='/api/rules')return json(200,mock.rules);
   if(route==='/api/memory')return json(200,mock.memory);
   if(route==='/api/housekeeping'){if(mock.houseDelay)await sleep(mock.houseDelay);return json(200,mock.house);}
   if(route==='/api/logs'){if(mock.logDelay)await sleep(mock.logDelay);return json(200,{text:'模拟日志 '+url.searchParams.get('kind')+' <img src=x onerror=window.__injected=true>'});}
   if(route==='/api/models')return json(200,{'codex-a':[{id:'gpt-6-astra',name:'GPT-6 Astra',efforts:['low','medium','high','xhigh']}],'codex-b':[{id:'gpt-6-astra',name:'GPT-6 Astra',efforts:['low','medium','high','xhigh']}]});
   if(route==='/api/diagnostics')return json(200,{fixture:true,observedAt:stamp()});
   return json(404,{error:'未实现的模拟接口'});
  }
  const file={'/':'index.html','/app.js':'app.js','/app.css':'app.css'}[route];
  if(!file){res.writeHead(404);return res.end();}
  res.writeHead(200,{'content-type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':'text/javascript','cache-control':'no-store'});
  res.end(fs.readFileSync(path.join(root,'operator/web',file)));
 }catch(err){if(!res.destroyed){res.writeHead(500);res.end(JSON.stringify({error:err.message}));}}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
mock.state.panel.port=server.address().port;
const child=spawn(edge,['--headless=new','--remote-debugging-port=0','--no-first-run','--disable-background-networking','--disable-extensions','--user-data-dir='+path.join(work,'profile'),'about:blank'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let browserUrl='',stderr='',ws,seq=0,waiting=new Map(),call,evaluate;
const checks=[],images=[],errors=[];
child.on('error',e=>{stderr=e.message;});child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-8000);const m=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)browserUrl=m[1];});child.stdout.on('data',()=>{});
function rpc(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++seq,t=setTimeout(()=>{waiting.delete(id);reject(new Error('CDP timeout '+method));},15000);waiting.set(id,{resolve:r=>{clearTimeout(t);resolve(r);},reject:e=>{clearTimeout(t);reject(e);}});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
const q=JSON.stringify;
async function until(expression,message,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate(expression))return;await sleep(100);}throw new Error(message+'; '+expression);}
async function ready(selector){await until('Boolean(document.querySelector('+q(selector)+'))','missing selector '+selector);}
async function click(selector){await ready(selector);await evaluate('document.querySelector('+q(selector)+').click()');await sleep(120);}
async function fill(selector,value,event='input'){await ready(selector);await evaluate('(()=>{const x=document.querySelector('+q(selector)+');x.focus();x.value='+q(value)+';x.dispatchEvent(new Event('+q(event)+',{bubbles:true}));})()');}
async function nav(view){await evaluate('(()=>{const x=document.querySelector('+q('#nav [data-nav="'+view+'"]')+');const g=x.closest("details");if(g)g.open=true;x.click();})()');await sleep(150);}
async function shot(name){const r=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(shots,name+'.png'),Buffer.from(r.data,'base64'));images.push(name+'.png');}
async function pass(name){checks.push(name);console.log('PASS '+name);}
async function fresh(){const previous=mock.apiReads.filter(x=>x==='/api/state').length;await click('#refresh-all');await until('document.querySelector("#panel-state").textContent.includes("已连接")','state read');await sleep(mock.stateDelay+180);assert.ok(mock.apiReads.filter(x=>x==='/api/state').length>previous);}
async function answer(){await fill('[data-elic="name"]','中文周报');await fill('[data-elic="copies"]','2');await fill('[data-elic="mode"]','1');await fill('[data-elic="publish"]','false');}
async function closeDialog(){await click('#dialog [data-dialog-close]');if(await evaluate('document.querySelector("#confirm-dialog").open'))await click('#confirm-yes');}
try{
 for(let i=0;i<80&&!browserUrl&&child.exitCode===null;i++)await sleep(100);
 if(!browserUrl)throw new Error('Browser failed to launch: '+stderr);
 ws=new WebSocket(browserUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
 ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id&&waiting.has(m.id)){const w=waiting.get(m.id);waiting.delete(m.id);m.error?w.reject(new Error(m.error.message)):w.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);});
 const {targetId}=await rpc('Target.createTarget',{url:'about:blank'});const {sessionId}=await rpc('Target.attachToTarget',{targetId,flatten:true});
 call=(m,p={})=>rpc(m,p,sessionId);
 evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
 await call('Page.enable');await call('Runtime.enable');await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await rpc('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:path.join(work,'downloads')});
 await call('Page.navigate',{url:origin+'/#token=ui-test-only'});await ready('.loading');await shot('01-loading');await ready('#nav [data-nav="usage"]');mock.stateDelay=0;
 assert.equal(await evaluate('document.querySelectorAll("#nav [data-nav]").length'),12);
 assert.equal(await evaluate('[...document.querySelectorAll("#nav>details")].filter(x=>x.open).length'),0);
 assert.equal(await evaluate('location.hash'), '');
 assert.match(await evaluate('document.querySelector("#main").innerText'),/Bridge 正常/);
 assert.match(await evaluate('document.querySelector("#main").innerText'),/尚未核验/);
 await shot('02-overview-light');await pass('grouped navigation, honest channel unknown, loading and token fragment removal');

 mock.state.bridge.healthy=null;await fresh();assert.match(await evaluate('document.querySelector("#main").innerText'),/Bridge 状态未知/);assert.doesNotMatch(await evaluate('document.querySelector("#main").innerText'),/Bridge 不可达/);mock.state.bridge.healthy=true;await fresh();
 await nav('tasks');await fill('#task-search','项目');
 await evaluate('window.__focusNode=document.querySelector("#task-search");window.__mainNode=document.querySelector("#main h1");window.__focusNode.setSelectionRange(1,2);');
 await sleep(3300);
 assert.equal(await evaluate('window.__focusNode===document.querySelector("#task-search")&&document.activeElement===window.__focusNode&&window.__focusNode.selectionStart===1&&window.__mainNode===document.querySelector("#main h1")'),true);
 await fill('#task-search','');await fill('#task-status','all','change');
 assert.equal(await evaluate('document.querySelectorAll("#task-list tbody tr").length'),50);
 await click('[data-task-page="1"]');assert.match(await evaluate('document.querySelector("#task-list .pagination").innerText'),/2 \/ 3/);
 await click('[data-task="history-50"]');assert.equal(await evaluate('Boolean(document.querySelector("#task-dismiss-history"))'),true);await click('#task-dismiss-history');await ready('#confirm-yes');await click('#confirm-yes');await sleep(250);
 assert.equal(mock.state.tasks.some(t=>t.ref==='history-50'),false);assert.equal(mock.posts.filter(x=>x.route==='/api/task-history').length,1);
 await fill('#task-status','live','change');await click('[data-task="task-live"]');assert.equal(await evaluate('Boolean(document.querySelector("#task-dismiss-history"))'),false);await closeDialog();
 await pass('polling retains DOM identity, input focus/selection; large task list paginates; stale history deletes while active tasks cannot');

 await nav('tasks');await click('[data-task="task-command"]');
 assert.equal(await evaluate('Boolean(window.__injected)||Boolean(document.querySelector("#dialog img"))'),false);
 assert.match(await evaluate('document.querySelector(".request-explanation").innerText'),/F:\/mock\/only/);
 assert.match(await evaluate('document.querySelector(".request-explanation").innerText'),/它想做什么/);assert.match(await evaluate('document.querySelector(".request-explanation").innerText'),/建议怎么判断/);assert.equal(await evaluate('document.querySelector(".request-explanation details").open'),false);
 await shot('03-command-evidence');await closeDialog();
 await click('[data-task="task-form"]');await answer();
 await evaluate('window.__formNode=document.querySelector("[data-elic=name]");document.querySelector("#dialog").scrollTop=180;window.__dialogScroll=document.querySelector("#dialog").scrollTop;');
 mock.state.tasks[0].result='更新：仍在等待报表参数。';await sleep(3300);
 assert.equal(await evaluate('window.__formNode===document.querySelector("[data-elic=name]")&&window.__formNode.value==="中文周报"'),true);
 assert.equal(await evaluate('document.querySelector("#dialog").scrollTop===window.__dialogScroll'),true);
 await shot('04-request-form');
 mock.state.tasks[0].pendingApproval=request('request-2');await sleep(3300);
 assert.equal(await evaluate('document.querySelector("#task-approve").disabled'),true);
 assert.equal(await evaluate('document.querySelector("[data-elic=name]").value'),'中文周报');
 await click('#task-reopen');await click('#confirm-no');
 assert.equal(await evaluate('document.querySelector("[data-elic=name]").value'),'中文周报');
 await click('#task-reopen');await click('#confirm-yes');await sleep(200);await answer();
 await fill('[data-elic="copies"]','1.5');await click('#task-approve');
 assert.equal(await evaluate('document.querySelector("#confirm-dialog").open'),false);
 await fill('[data-elic="copies"]','2');await click('#task-approve');await ready('#confirm-yes');
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await sleep(100);
 assert.equal(await evaluate('document.querySelector("#confirm-dialog").open'),false);
 assert.equal(await evaluate('document.querySelector("#dialog").open'),true);
 assert.equal(await evaluate('document.querySelector("[data-elic=name]").value'),'中文周报');
 await click('#task-approve');mock.state.tasks[0].pendingApproval=request('request-3');await sleep(3300);
 assert.equal(await evaluate('document.querySelector("#confirm-yes").disabled'),true);
 assert.equal(mock.posts.filter(x=>x.route==='/api/task').length,0);
 await shot('05-changed-request-locked');await click('#confirm-no');await click('#task-reopen');await click('#confirm-yes');await sleep(200);await answer();
 await click('#task-approve');await click('#confirm-yes');
 await until('document.querySelector("#task-approve").disabled','approval submitted');await sleep(300);
 const decision=mock.posts.find(x=>x.route==='/api/task');
 assert.ok(decision);assert.equal(decision.body.expectedTurnId,'turn-1');assert.equal(decision.body.approvalRequestId,'request-3');
 assert.deepEqual(decision.body.elicitationContent,{name:'中文周报',copies:2,mode:20,publish:false});
 assert.equal(decision.body.decisionSource,'operator');assert.equal(decision.body.confirmed,true);
 await closeDialog();await pass('escaped commands, request explanation, stable forms, integer validation, cancel return, stale identity lock and exact typed approval');

 await nav('concurrency');await fill('#setting-admission-maxActive','3');
 await sleep(3300);assert.equal(await evaluate('document.querySelector("#setting-admission-maxActive").value'),'3');
 mock.state.settings.hash='external-update';await fresh();
 assert.match(await evaluate('document.querySelector("#save-note").textContent'),/另一个窗口/);
 assert.match(await evaluate('document.querySelector("#settings-status").textContent'),/尚未确认/);
 await click('#save-settings');await sleep(150);assert.equal(await evaluate('document.querySelector("#setting-admission-maxActive").value'),'3');
 assert.equal(await evaluate('document.querySelector("#confirm-dialog").open'),false);
 await shot('06-settings-conflict');await click('#reset-settings');await fill('#setting-admission-maxActive','4');await click('#save-settings');await sleep(250);
 assert.equal(mock.state.settings.value.admission.maxActive,4);
 assert.equal(await evaluate('document.querySelector("#confirm-dialog").open'),false);
 await nav('channels');await fill('#setting-tunnels-a-proxyUrl','http://127.0.0.1:8899');await click('#save-settings');await sleep(200);
 assert.match(await evaluate('document.querySelector("#save-note").textContent'),/需重新连接/);
 await click('[data-maintenance="channelStop"][data-lane="b"]');
 assert.equal(await evaluate('document.querySelector("#confirm-dialog").open'),true);await click('#confirm-no');
 assert.equal(mock.posts.filter(x=>x.route==='/api/action').length,0);
 await nav('profile');await ready('#call-approval');const approvalBefore=await evaluate('document.querySelector("#call-approval").checked');await click('#call-approval');
 await sleep(3300);assert.equal(await evaluate('document.querySelector("#call-approval").checked'),!approvalBefore);
 await fill('#search','并发');assert.equal(await evaluate('document.querySelector("#search").value'),'');assert.equal(await evaluate('document.querySelector("#call-approval").checked'),!approvalBefore);
 await nav('usage');await click('#confirm-no');assert.equal(await evaluate('document.querySelector("#call-approval").checked'),!approvalBefore);
 await nav('usage');await click('#confirm-yes');await ready('#usage-results .usage-summary');
 await pass('config saves once without extra confirmation, conflict preserves draft, proxy restart state and profile/search guard');

 assert.match(await evaluate('document.querySelector(".usage-summary").innerText'),/183,000/);
 assert.equal(await evaluate('document.querySelectorAll(".usage-table tbody tr").length'),50);
 assert.match(await evaluate('document.querySelector("#usage-results").innerText'),/未知/);
 assert.equal(await evaluate('Boolean(window.__injected)||Boolean(document.querySelector("#usage-results img"))'),false);
 await shot('07-usage-light');
 await click('[data-usage-page="1"]');assert.equal(await evaluate('document.querySelectorAll(".usage-table tbody tr").length'),50);
 await click('[data-usage-page="-1"]');await click('[data-usage-record="0"]');assert.match(await evaluate('document.querySelector("#dialog").innerText'),/未知/);await closeDialog();
 await click('#usage-export');await sleep(600);
 let exports=[];for(let i=0;i<30&&!exports.length;i++){exports=fs.readdirSync(path.join(work,'downloads')).filter(n=>n.endsWith('.json'));if(!exports.length)await sleep(100);}assert.equal(exports.length,1);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(work,'downloads',exports[0]),'utf8')).summary,mock.usage.summary);
 mock.usageDelay=1500;await fill('#usage-days','30');await fill('#usage-provider','codex-b');await fill('#usage-model','gpt-6-astra');
 await evaluate('document.querySelector("#usage-filters").requestSubmit()');await sleep(100);assert.match(await evaluate('document.querySelector("#usage-feedback").innerText'),/正在读取/);await shot('08-usage-loading');
 await fill('#usage-model','draft-kept');await until('document.querySelector("#usage-results").getAttribute("aria-busy")==="false"','usage complete');
 assert.equal(await evaluate('document.querySelector("#usage-model").value'),'draft-kept');
 assert.ok(mock.usageQueries.some(x=>x.includes('days=30')&&x.includes('provider=codex-b')&&x.includes('model=gpt-6-astra')));
 mock.usageDelay=0;mock.usageStatus=404;await click('#usage-refresh');await until('document.querySelector("#usage-feedback").innerText.includes("尚未提供用量接口")','missing usage');
 assert.equal(await evaluate('document.querySelector("#usage-export").disabled'),true);await shot('09-usage-missing-endpoint');
 mock.usageStatus=200;mock.usage={...usage(),summary:{recordedTurns:0,knownTurns:0,unknownTurns:0,totalTokens:null},records:[],byDay:[],byProvider:[],byModel:[],byProject:[]};await click('#usage-refresh');await until('document.querySelector("#usage-results").innerText.includes("当前筛选没有记录")','empty usage');await shot('10-usage-empty');
 mock.usage=usage();await click('#usage-refresh');await until('Boolean(document.querySelector(".usage-table"))','usage restored');
 await pass('usage arithmetic, null handling, filter draft retention, loading/missing/empty states, pagination and exact JSON export');


 await nav('providers');assert.ok(await evaluate('document.querySelectorAll("[data-setting]").length')>=12);await click('#load-models');await until('document.querySelectorAll("#setting-providers-codex-b-defaultModel option").length>1','model choices');assert.match(await evaluate('document.querySelector("#setting-providers-codex-b-defaultModel").innerText'),/GPT-6 Astra/);
 await nav('memory');await ready('[data-house="intervalMinutes"]');await until('document.querySelectorAll(".memory-row").length===2','memory list');assert.match(await evaluate('document.querySelector("#memory-panel").innerText'),/发布前检查/);
 await fill('#memory-title','UI 新增 Memory');await fill('#memory-summary','这是一条 UI 测试长期记忆。');await click('#memory-add');await click('#confirm-yes');await until('document.querySelectorAll(".memory-row").length===3','memory added');assert.equal(mock.memory.items.length,3);
 await click('[data-memory-delete="mem-3"]');await click('#confirm-yes');await until('document.querySelectorAll(".memory-row").length===2','memory deleted');assert.equal(mock.memory.items.length,2);
 await fill('[data-house="intervalMinutes"]','45');await click('#protected-add');assert.match(await evaluate('document.querySelector("#toast").innerText'),/填写/);await fill('#protected-new','tmp/keep-this');await click('#protected-add');await fresh();
 assert.equal(await evaluate('document.querySelector("[data-house=intervalMinutes]").value'),'45');assert.match(await evaluate('document.querySelector("#housekeeping-form").innerText'),/tmp\/keep-this/);
 await click('#save-housekeeping');await until('document.querySelector("#housekeeping-form").innerText.includes("尚未确认应用")','housekeeping applied state');assert.ok(mock.house.value.protectedPaths.includes('tmp/keep-this'));
 await click('[data-maintenance="housekeepingPreview"]');await until('document.querySelector("#operation-status").innerText.includes("模拟清理预览")','preview receipt');
 assert.match(await evaluate('document.querySelector("#main h1").innerText'),/^Memory$/);
 await nav('recovery');assert.ok(await evaluate('Boolean(document.querySelector("[data-maintenance=promote]"))'));
 await nav('logs');await until('document.querySelector("#log-view").textContent.includes("模拟日志")','logs');assert.equal(await evaluate('Boolean(document.querySelector("#log-view img"))'),false);
 await fill('#log-kind','output','change');await until('document.querySelector("#log-view").textContent.includes("output")','log filter');
 await nav('advanced');assert.match(await evaluate('document.querySelector("#main").innerText'),/生产服务地址/);
 await nav('profile');await ready('#rule-new');assert.equal(await evaluate('[...document.querySelectorAll("[data-rule-text]")].find(x=>x.dataset.ruleText==="rule-existing").value'),'发布前先检查活动任务。');await fill('#rule-new','后续新任务先核对项目范围。');await click('#rule-add');await click('#confirm-yes');await until('document.querySelectorAll(".rule-row").length===2','rule add');assert.equal(mock.rules.rules.length,2);
 await click('[data-rule-delete="rule-existing"]');await click('#confirm-yes');await until('document.querySelectorAll(".rule-row").length===1','rule delete');assert.equal(mock.rules.rules.length,1);assert.equal(mock.rules.baseInstruction,'所有任务遵循项目范围。');
 await click('#call-approval');await click('#save-profile-approval');await until('document.querySelector("#call-approval").checked===false','approval setting save');assert.equal(mock.profile.profile.effective.requireCallApproval,false);
 await pass('all sections accessible, model reasoning catalog, Memory CRUD, protected cleanup paths, itemized rules and escaped logs');

 await nav('appearance');await fill('#setting-panel-theme','dark');await click('#save-settings');await until('document.documentElement.dataset.theme==="dark"','dark theme');
 await nav('usage');await ready('.usage-summary');await shot('11-usage-dark');
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await sleep(200);
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true);
 await shot('12-usage-narrow-dark');await click('#toggle-navigation');assert.equal(await evaluate('getComputedStyle(document.querySelector("#navigation-pane")).display!=="none"'),true);await shot('13-narrow-navigation');
 await nav('tasks');
 const narrowOverflow=await evaluate('({width:innerWidth,doc:document.documentElement.scrollWidth,body:document.body.scrollWidth,main:document.querySelector("#main").scrollWidth,overflow:[...document.querySelectorAll("body *")].filter(x=>getComputedStyle(x).display!=="none"&&x.getBoundingClientRect().right>innerWidth+1).map(x=>({tag:x.tagName,id:x.id,cls:x.className,right:x.getBoundingClientRect().right})).slice(0,12)})');
 assert.ok(narrowOverflow.doc<=narrowOverflow.width+1,JSON.stringify(narrowOverflow));
 await click('[data-task="task-command"]');assert.equal(await evaluate('document.querySelector("#dialog").scrollWidth<=document.querySelector("#dialog").clientWidth+1'),true);await shot('14-request-narrow-dark');await closeDialog();
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});assert.equal(await evaluate('getComputedStyle(document.querySelector("#main")).scrollBehavior'),'auto');
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await nav('overview');
 await pass('real dark theme save, 390px layout, navigation, narrow approval and reduced motion');

 mock.stateDelay=4200;await click('#refresh-all');await sleep(2400);assert.match(await evaluate('document.querySelector("#connection-notice").innerText'),/较慢/);await shot('15-slow-backend');await sleep(2100);mock.stateDelay=0;
 mock.stateStatus=503;await click('#refresh-all');await sleep(200);assert.match(await evaluate('document.querySelector("#panel-state").innerText'),/过期/);
 await shot('16-backend-error-stale');mock.stateStatus=200;await fresh();
 mock.stateDelay=14000;await click('#refresh-all');await until('document.querySelector("#connection-notice").innerText.includes("读取超时")','dead backend timeout',14000);await shot('18-backend-timeout');
 mock.stateDelay=0;await fresh();
 await nav('tasks');await click('[data-task="task-command"]');mock.stateStatus=401;await sleep(3300);
 assert.equal(await evaluate('document.querySelector("#task-approve").disabled'),true);
 assert.match(await evaluate('document.querySelector("#connection-notice").innerText'),/认证已过期/);
 await shot('17-auth-expired');await closeDialog();
 const count401=mock.apiReads.filter(x=>x==='/api/state').length;await sleep(3300);
 assert.equal(mock.apiReads.filter(x=>x==='/api/state').length,count401);
 await pass('slow/dead backend keeps stale snapshot, 401 locks actions and stops retry loop');
 mock.catalogStatus=401;await call('Page.reload');await until('document.querySelector("#main").innerText.includes("窗口认证已过期")','initial unauthorized');
 assert.equal(await evaluate('document.querySelectorAll("#nav [data-nav]").length'),0);await shot('19-initial-unauthorized');
 await pass('initial authentication failure is actionable and exposes no controls');


 assert.deepEqual(errors,[]);
 assert.equal(mock.posts.filter(x=>x.route==='/api/task').length,1);
 assert.deepEqual(mock.posts.filter(x=>x.route==='/api/action').map(x=>x.body.action),['housekeepingPreview']);
 const report={result:'PASS',checks,images,isolated:true,productionContact:false,paidModelCalls:0,posts:mock.posts.map(x=>({route:x.route,action:x.body.action||'save'})),consoleErrors:errors};
 fs.writeFileSync(path.join(shots,'test-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 await rpc('Target.closeTarget',{targetId});
}catch(err){
 if(call)try{await shot('failure');}catch{}
 const report={result:'FAIL',error:err.stack,checks,images,consoleErrors:errors};fs.writeFileSync(path.join(shots,'test-results.json'),JSON.stringify(report,null,2));console.error(JSON.stringify(report,null,2));process.exitCode=1;
}finally{
 if(ws?.readyState===1){try{await rpc('Browser.close');}catch{}ws.close();}
 if(child.exitCode===null)child.kill();
 for(const w of waiting.values())w.reject(new Error('Test closed'));waiting.clear();
 server.closeAllConnections();await new Promise(r=>server.close(r));
}
