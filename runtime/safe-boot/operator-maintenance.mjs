import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { legacySnapshot } from '../../operator/legacy-runtime.mjs';
import { runtimeCall, bridgeRpc } from '../../operator/server.mjs';

export function busyOperatorSnapshot(snapshot) {
  const c=snapshot?.counts;
  if(!c||!['active','awaitingApproval','starting','uncertain'].every(k=>Number.isInteger(c[k])&&c[k]>=0)) return true;
  return c.active+c.awaitingApproval+c.starting+c.uncertain>0;
}

const BLOCKING_TASK_STATUSES=new Set(['running','starting','queued','cancelling','awaitingApproval','unknown']);
export function operatorBlockerSummary(snapshot,{limit=8}={}) {
  const c=snapshot?.counts??{};
  const countText=`active=${Number.isInteger(c.active)?c.active:'?'} approval=${Number.isInteger(c.awaitingApproval)?c.awaitingApproval:'?'} starting=${Number.isInteger(c.starting)?c.starting:'?'} uncertain=${Number.isInteger(c.uncertain)?c.uncertain:'?'}`;
  const tasks=Array.isArray(snapshot?.tasks)?snapshot.tasks:[];
  const blockers=tasks.filter(task=>BLOCKING_TASK_STATUSES.has(task?.status)).slice(0,Math.max(1,Math.min(16,limit))).map(task=>{
    const provider=String(task?.provider??'unknown').replace(/[^A-Za-z0-9._-]/g,'?').slice(0,32);
    const ref=String(task?.ref??'unknown').replace(/[^A-Za-z0-9._-]/g,'?').slice(0,80);
    const status=String(task?.status??'unknown').replace(/[^A-Za-z0-9._-]/g,'?').slice(0,32);
    return `${provider}:${ref}:${status}`;
  });
  const hidden=Math.max(0,tasks.filter(task=>BLOCKING_TASK_STATUSES.has(task?.status)).length-blockers.length);
  return `${countText}; blockers=${blockers.join(',')||'none'}${hidden?`,+${hidden} more`:''}`;
}
// Used only for the one-time .9 -> operator-aware migration. A missing operator
// receipt is not general permission to restart; every task on the old process
// is read through its official status method before proceeding.
export async function legacyIdle(root) {
  const health=await (await fetch('http://127.0.0.1:7690/healthz',{signal:AbortSignal.timeout(5000)})).json();
  if(health.version!=='0.1.2-preview.9')throw new Error('旧版管理接入仅允许从已确认的 .9 基线迁移。');
  const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const inspected=await promisify(execFile)(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'operator/scripts/system.ps1'),'-Action','inspect'],{cwd:root,windowsHide:true,timeout:15000,maxBuffer:1048576});
  const info=JSON.parse(inspected.stdout.replace(/^\uFEFF/,''));
  const snapshot=await legacySnapshot(root,{...health,healthy:health.ok===true},info.bridgeProcess,bridgeRpc);
  if(busyOperatorSnapshot(snapshot))throw new Error(`旧版仍有运行、审批或状态不明的任务，暂不接入管理版本。${operatorBlockerSummary(snapshot)}`);
  for(const kind of ['queued','processing']) {
    const dir=path.join(root,'state/agents/mac/reverse',kind);
    if(fs.existsSync(dir)&&fs.readdirSync(dir).some(n=>n.endsWith('.json')))throw new Error('远程电脑仍有排队或处理中记录，请先核验再接入。');
  }
  const checked=snapshot.tasks.length;
  return {checked};
}
export async function withOperatorMaintenance(root, action, {allowLegacy=false}={}) {
  let acquired=false,keepEnabled=false;
  try{
    let status;
    try{status=await runtimeCall(root,'snapshot');}
    catch(error){if(!allowLegacy)throw new Error('无法确认活动任务，已拒绝切换；先恢复本机管理接口。');await legacyIdle(root);return await action();}
    status=await runtimeCall(root,'maintenance',{enabled:true});acquired=true;
    if(busyOperatorSnapshot(status))throw new Error('仍有运行、审批、启动中或状态不明的任务，已拒绝维护。');
    const result=await action();
    keepEnabled=result?.maintenanceHeld===true;
    return result;
  }finally{
    if(acquired&&!keepEnabled)await runtimeCall(root,'maintenance',{enabled:false}).catch(()=>{});
  }
}
