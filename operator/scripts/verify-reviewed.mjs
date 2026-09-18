import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const stateDir=path.join(root,'state/operator');fs.mkdirSync(stateDir,{recursive:true});
const startedAt=new Date().toISOString(),results=[],reviewed=[];
let sourceLkg=null,stage=null,receipt=null;
const report=result=>({result,at:new Date().toISOString(),startedAt,sourceLkg,reviewedFiles:reviewed,tests:results,receipt,productionChanged:false});
const save=result=>fs.writeFileSync(path.join(stateDir,'last-verification.json'),JSON.stringify(result,null,2));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(name,args,cwd=root,timeout=30000){const r=spawnSync(process.execPath,args,{cwd,encoding:'utf8',windowsHide:true,timeout,maxBuffer:16*1024*1024});results.push({name,ok:r.status===0,exit:r.status,error:r.error?.message||null});fs.writeFileSync(path.join(stateDir,'verify-'+name+'.log'),(r.stdout||'')+'\n'+(r.stderr||''));if(r.status!==0)throw new Error('验收未通过：'+name+'；详情见对应验证日志。');}
try{
 const state=JSON.parse(fs.readFileSync(path.join(root,'state/safe-boot/safe-boot-state.json'),'utf8'));sourceLkg=state.lastKnownGood?.digest;
 if(!/^[a-f0-9]{64}$/.test(sourceLkg||''))throw new Error('当前稳定版本未确认。');
 const lkg=path.join(root,'state/safe-boot/releases',sourceLkg);stage=path.join(root,'state/safe-boot/work/operator-reviewed-source');
 const runtime='state/safe-boot/seed-lkg/codexless-runtime';
 const sources=['package.json','package-lock.json','src/operator-settings.mjs','src/operator-control.mjs','src/operator-usage.mjs','src/codexless-runtime.mjs','src/agent-tools.mjs','src/codex-agent-executor.mjs','src/codex-app-server-client.mjs','src/lazy-codex-agent-executor.mjs','src/mcp-server-factory.mjs','src/spike-agent-tools.mjs','src/agent-providers/codex.mjs','src/spike-agent-card-ui.mjs','src/surface-contracts.mjs'];
 save({...report('RUNNING'),phase:'准备独立候选'});
 fs.rmSync(stage,{recursive:true,force:true});fs.mkdirSync(stage,{recursive:true});
 for(const folder of ['codexless-runtime','overlay','plugins']){const p=path.join(lkg,folder);if(fs.existsSync(p))fs.cpSync(p,path.join(stage,folder),{recursive:true});}
 for(const name of sources){const src=path.join(root,runtime,name),dst=path.join(stage,'codexless-runtime',name);fs.copyFileSync(src,dst);reviewed.push({file:runtime+'/'+name,sha256:hash(dst)});}
 const overlay='runtime/codexless/mcp-http-with-git-commit-and-spike-context.mjs';fs.copyFileSync(path.join(root,overlay),path.join(stage,'overlay/mcp-http-with-git-commit-and-spike-context.mjs'));reviewed.push({file:overlay,sha256:hash(path.join(root,overlay))});
 fs.cpSync(path.join(root,'plugins/housekeeping'),path.join(stage,'plugins/housekeeping'),{recursive:true,force:true});
 // Unrelated in-progress changes are excluded: keep the current LKG gate suite as
 // the immutable baseline, and overlay only the regression test reviewed for this fix.
 const reviewedTests=['test/gate-codex-b-runtime.mjs'];for(const name of reviewedTests){const src=path.join(root,runtime,name),dst=path.join(stage,'codexless-runtime',name);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);reviewed.push({file:runtime+'/'+name,sha256:hash(dst)});}
 run('reliability',['--test','test/reliability.test.mjs']);
 run('operator',['--test','--test-timeout=15000','operator/tests/operator.test.mjs','operator/tests/usage.test.mjs','operator/tests/usage-executor.test.mjs']);
 run('safe-boot',['--test','test/safe-boot/production.test.mjs','test/safe-boot/codex-runtime.test.mjs','test/housekeeping.test.mjs']);
 const tests=['gate-codex-b-runtime.mjs'];
 for(const file of tests)run(file.replace('.mjs',''),['test/'+file],path.join(stage,'codexless-runtime'));
 for(const item of reviewed)if(hash(path.join(root,item.file))!==item.sha256)throw new Error('验证期间源文件变化，请重新验证：'+item.file);
 save({...report('RUNNING'),phase:'隔离端口验证与浏览器检查'});
 const verify=spawnSync(process.execPath,[path.join(root,'runtime/safe-boot/spike-home-production.g3.mjs'),'verify'],{cwd:root,env:{...process.env,SPIKE_BRIDGE_REVIEWED_SOURCE:stage},encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:4*1024*1024});
 fs.writeFileSync(path.join(stateDir,'verify-release.log'),(verify.stdout||'')+'\n'+(verify.stderr||''));
 let value;try{value=JSON.parse(verify.stdout);}catch{value=null;}
 if(verify.status!==0||value?.result!=='PASS')throw new Error(value?.error||verify.error?.message||'候选冻结验证失败；生产未切换。');
 receipt=value;save(report('PASS'));console.log(JSON.stringify(report('PASS'),null,2));
}catch(e){const failure={...report('FAIL'),error:e.message};save(failure);console.error(JSON.stringify(failure,null,2));process.exitCode=1;}
