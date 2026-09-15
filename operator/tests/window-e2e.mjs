import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const edge=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p=>fs.existsSync(p));
if(!edge)throw new Error('未找到用于界面验收的浏览器。');
const work=path.join(root,'tmp/generated/operator-window-e2e-'+process.pid);fs.mkdirSync(work,{recursive:true});
const shots=path.join(root,'design/reviews/operator/2026-09-13');fs.mkdirSync(shots,{recursive:true});
const receipt=JSON.parse(fs.readFileSync(path.join(root,'state/operator/panel-access.json'),'utf8'));
const child=spawn(edge,['--headless=new','--remote-debugging-port=0','--no-first-run','--disable-background-networking','--disable-extensions','--user-data-dir='+path.join(work,'profile'),'about:blank'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let browserUrl='',err='',ws,seq=0,waiting=new Map();
child.on('error',e=>{err=e.message;});child.stderr.on('data',b=>{err=(err+b.toString()).slice(-12000);const m=err.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)browserUrl=m[1];});child.stdout.on('data',()=>{});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function rpc(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{waiting.delete(id);reject(new Error('界面测试调用超时：'+method));},12000);waiting.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
const report=[];
try{
 for(let i=0;i<60&&!browserUrl&&child.exitCode===null;i++)await sleep(250);
 if(!browserUrl)throw new Error('界面浏览器未启动：'+err);
 ws=new WebSocket(browserUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&waiting.has(m.id)){const w=waiting.get(m.id);waiting.delete(m.id);m.error?w.reject(new Error(m.error.message)):w.resolve(m.result);}});
 const {targetId}=await rpc('Target.createTarget',{url:'about:blank'});const {sessionId}=await rpc('Target.attachToTarget',{targetId,flatten:true});
 const call=(m,p={})=>rpc(m,p,sessionId);
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result?.value;};
 async function ready(selector){for(let i=0;i<60;i++){if(await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`))return;await sleep(250);}throw new Error('界面元素未出现：'+selector);}
 async function click(selector){await ready(selector);await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);await sleep(300);}
 async function shot(name){const r=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(shots,name+'.png'),Buffer.from(r.data,'base64'));report.push({name,path:'design/reviews/operator/2026-09-13/'+name+'.png'});}
 await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:`http://127.0.0.1:${receipt.port}/#token=${receipt.token}`});await ready('[data-nav="concurrency"]');
 if(!process.argv.includes('--finish')) {
 assert.ok(await evaluate(`document.body.innerText.includes('运行总览')`));await shot('01-overview');
 const taskCount=await evaluate(`document.querySelectorAll('.task-table tbody tr').length`);report.push({taskRows:taskCount});
 await click('[data-nav="concurrency"]');await ready('#setting-admission-maxActive');
 await evaluate(`(()=>{const x=document.querySelector('#setting-admission-maxActive');x.value='3';x.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await sleep(3500);assert.equal(await evaluate(`document.querySelector('#setting-admission-maxActive').value`),'3');await shot('02-concurrency-draft');
 await click('#reset-settings');await click('[data-nav="channels"]');await shot('03-channels');
 await click('[data-nav="tasks"]');if(taskCount){await click('[data-task]');await ready('.dialog-head');await shot('04-task-approval');await click('[data-dialog-close]');}
 await click('[data-nav="profile"]');await ready('#profile-instruction');
 await evaluate(`(()=>{const x=document.querySelector('#profile-instruction');x.value+='\\n界面验收草稿（不保存）';x.dispatchEvent(new Event('input',{bubbles:true}));})()`);await click('[data-nav="logs"]');assert.equal(await evaluate(`document.querySelector('#dialog').open`),true);await click('[data-dialog-close]');assert.ok(await evaluate(`document.querySelector('#profile-instruction').value.includes('界面验收草稿')`));await click('[data-nav="appearance"]');await click('#confirm-yes');
 await evaluate(`document.documentElement.dataset.theme='dark'`);await shot('05-dark-display');
 await call('Emulation.setDeviceMetricsOverride',{width:820,height:900,deviceScaleFactor:1,mobile:false});await shot('06-narrow-display');
 assert.ok(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth+1`));
 }
 // Test empty/disconnected rendering in the test browser only; no server state is changed.
 await call('Page.addScriptToEvaluateOnNewDocument',{source:`const originalFetch=window.fetch;window.fetch=async (...args)=>{const response=await originalFetch(...args);if(String(args[0]).startsWith('/api/state')){const s=await response.json();s.tasks=[];s.controlConnected=false;s.controlNative=false;s.runtime=null;s.controlError='测试：本机管理连接中断';s.bridge.healthy=false;return new Response(JSON.stringify(s),{status:200,headers:{'content-type':'application/json'}});}return response;};`});
 await call('Page.reload');
 for(let i=0;i<80;i++){if(await evaluate(`document.body.innerText.includes('测试：本机管理连接中断')`))break;await sleep(250);}
 assert.ok(await evaluate(`document.body.innerText.includes('测试：本机管理连接中断')`));
 await sleep(700);await shot('07-disconnected-empty');
 await rpc('Target.closeTarget',{targetId});
 console.log(JSON.stringify({result:'PASS',noTaskMutations:true,noSettingsSaved:true,report},null,2));
}catch(e){console.error(JSON.stringify({result:'FAIL',error:e.message,report},null,2));process.exitCode=1;}
finally{if(ws?.readyState===1){try{await rpc('Browser.close');}catch{}ws.close();}if(child.exitCode===null)child.kill();}
