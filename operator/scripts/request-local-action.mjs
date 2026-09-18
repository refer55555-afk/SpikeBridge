import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
export const ROOT=path.resolve(HERE,'../..');
const ALLOWED_ACTIONS=new Set(['verify','promote']);
const REQUEST_ID_RE=/^[A-Za-z0-9._:-]{1,128}$/;

function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
function assertReceipt(root){
  const receipt=readJson(path.join(root,'state','operator','panel-access.json'));
  if(receipt?.port!==7692||receipt?.service!=='spike-bridge-operator'||!Number.isInteger(receipt?.pid)||receipt.pid<1||typeof receipt?.token!=='string'||receipt.token.length<32){
    throw new Error('Operator panel access receipt is invalid.');
  }
  return receipt;
}
function publicOperation(value){
  if(!value||typeof value!=='object')return null;
  return {id:value.id??null,name:value.name??null,status:value.status??null,startedAt:value.startedAt??null,endedAt:value.endedAt??null,error:value.error??null};
}
export function buildActionPayload(root,action,requestId){
  if(!ALLOWED_ACTIONS.has(action))throw new Error('Only verify and promote are allowed.');
  if(typeof requestId!=='string'||!REQUEST_ID_RE.test(requestId))throw new Error('requestId must be a stable bounded identifier.');
  if(action==='verify')return {action,requestId};
  const verification=readJson(path.join(root,'state','operator','last-verification.json'));
  const current=readJson(path.join(root,'state','safe-boot','verified-current.json'));
  const digest=verification?.receipt?.digest;
  if(verification?.result!=='PASS'||typeof digest!=='string'||digest!==current?.digest){
    throw new Error('Operator and Safe-Boot candidate verification do not agree; run verify first.');
  }
  return {action,requestId,expectedDigest:digest,confirmed:true};
}
export async function requestLocalAction({root=ROOT,action,requestId,fetchImpl=fetch}={}){
  const receipt=assertReceipt(root);
  const payload=buildActionPayload(root,action,requestId);
  const response=await fetchImpl('http://127.0.0.1:7692/api/action',{
    method:'POST',
    headers:{'content-type':'application/json','x-panel-token':receipt.token},
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(10_000),
  });
  const body=await response.json();
  if(response.status!==202)throw new Error(body?.detail||body?.error||('Operator request failed: HTTP '+response.status));
  return {http:response.status,operation:publicOperation(body)};
}
export async function readLocalActionStatus({root=ROOT,fetchImpl=fetch}={}){
  const receipt=assertReceipt(root);
  const response=await fetchImpl('http://127.0.0.1:7692/api/state',{
    method:'GET',
    headers:{'x-panel-token':receipt.token},
    signal:AbortSignal.timeout(10_000),
  });
  const body=await response.json();
  if(response.status!==200)throw new Error(body?.detail||body?.error||('Operator status failed: HTTP '+response.status));
  return {
    http:response.status,
    operation:publicOperation(body?.operation),
    verifiedCandidateDigest:body?.verifiedCandidate?.digest??null,
    operatorVerifiedDigest:readJson(path.join(root,'state','operator','last-verification.json'))?.receipt?.digest??null,
    productionDigest:body?.bridge?.artifactDigest??null,
    productionPid:body?.bridge?.pid??null,
  };
}
export async function main(argv=process.argv.slice(2)){
  const [command,requestId]=argv;
  if(command==='status')return readLocalActionStatus();
  if(!ALLOWED_ACTIONS.has(command)||!requestId)throw new Error('usage: request-local-action.mjs verify|promote <requestId> | status');
  return requestLocalAction({action:command,requestId});
}
if(path.resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)){
  main().then(value=>console.log(JSON.stringify(value,null,2))).catch(error=>{console.error(JSON.stringify({result:'FAIL',error:error.message}));process.exitCode=1;});
}
