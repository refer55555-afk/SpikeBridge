import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePinnedCodex } from './codex-runtime.mjs';
import { legacyIdle, withOperatorMaintenance } from "./operator-maintenance.mjs";
import { SafeBootStore } from "./safe-boot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");
export const STATE_ROOT = path.join(ROOT, "state", "safe-boot");
export const RELEASES_ROOT = path.join(STATE_ROOT, "releases");
const SEED_ROOT = path.join(STATE_ROOT, "seed-lkg"), LOG_ROOT = path.join(ROOT, "logs", "safe-boot"), BRIDGE_STATE_ROOT = path.join(ROOT, "state", "bridge");
const LOCK_PATH = path.join(STATE_ROOT, "production.lock"), VERIFIED_PATH = path.join(STATE_ROOT, "verified-current.json"), VERIFY_PENDING_PATH = path.join(STATE_ROOT, "verify-pending.json");
const PRIMARY_CODEX_HOME = path.join(ROOT, "accounts", "codex-a");
const PRIMARY_MEMORY_DB = path.join(ROOT, "data", "memory", "experience.db");
const PRIMARY_CALL_PROFILE = path.join(ROOT, "config", "codex-call-profile.md");
const PRIMARY_AGENT_A_STATE = path.join(ROOT, "state", "agents", "codex-a", "agent-task-cards.json");
const PRIMARY_ZCODE_STATE = path.join(ROOT, "state", "agents", "zcode", "jobs.json");
const PRIMARY_MAC_SECRET = path.join(ROOT, "secrets", "mac", "pairing.secret");
const CANDIDATE_CODEX_HOME_ROOT = path.join(STATE_ROOT, "work", "candidate-codex-home");
const WORKBENCH_ROOT = ROOT;
const MUTABLE_LAUNCHER = path.join(ROOT, "bootstrap", "start-spike-bridge.ps1");
const NODE = "C:\\Program Files\\nodejs\\node.exe", PYTHON = "C:\\Users\\Administrator\\Documents\\Spike-OS\\.venv\\Scripts\\python.exe";
const ENTRYPOINT = "mcp-http-with-git-commit-and-spike-context.mjs";
const OVERLAY_FILES = [ENTRYPOINT, "git-commit-primitive.mjs", "git-commit-selftest.mjs", "spike-context-bridge.py"];
const OVERLAY_TOOL_NAMES = ["model_free_git_commit", "spike_context"];
const BASE_FROZEN_DEPS = ["@modelcontextprotocol/server", "@modelcontextprotocol/node", "@modelcontextprotocol/core", "@hono/node-server", "zod"];
const OPTIONAL_FROZEN_DEPS = ["@napi-rs/canvas", "pdfjs-dist"];
export function frozenDepsForPackage(packageJson){const declared=packageJson?.dependencies??{};return [...BASE_FROZEN_DEPS,...OPTIONAL_FROZEN_DEPS.filter(dep=>Object.prototype.hasOwnProperty.call(declared,dep))];}
export function runtimeDependencyProbes(packageJson){const declared=packageJson?.dependencies??{},probes=["@modelcontextprotocol/server","@modelcontextprotocol/node","@modelcontextprotocol/core","@hono/node-server","zod/v4"];if(Object.prototype.hasOwnProperty.call(declared,"@napi-rs/canvas"))probes.push("@napi-rs/canvas");if(Object.prototype.hasOwnProperty.call(declared,"pdfjs-dist"))probes.push("pdfjs-dist/legacy/build/pdf.mjs");return probes;}
const ACTIONS = new Set(["init-seed", "verify", "fault-test", "promote", "adopt-lkg", "ensure", "status", "restart"]), store = new SafeBootStore({ rootDir: STATE_ROOT });
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;
const PENDING_SCHEMA_VERSION = 1;
const PENDING_PHASES = new Set(["prepared", "old_stopped", "candidate_started", "candidate_core_verified", "candidate_verified"]);

export function closedCircuitBreaker() {
  return {
    state: "closed",
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastFailureStage: null,
    openedAt: null,
    nextRetryAt: null,
  };
}

export function breakerGateDecision(breaker, now = Date.now()) {
  if (!breaker || breaker.state === "closed") return { allowed: true, transition: null, breaker: breaker ?? closedCircuitBreaker() };
  if (breaker.state === "half_open") return { allowed: true, transition: null, breaker };
  if (breaker.state !== "open") throw new Error("invalid circuit breaker state");
  const retryAt = Date.parse(breaker.nextRetryAt ?? "");
  if (!Number.isFinite(retryAt) || retryAt > now) return { allowed: false, transition: null, breaker };
  return { allowed: true, transition: "half_open", breaker: { ...breaker, state: "half_open" } };
}

export function breakerAfterFailure(breaker, stage, now = Date.now(), threshold = CIRCUIT_FAILURE_THRESHOLD, cooldownMs = CIRCUIT_COOLDOWN_MS) {
  const current = breaker ?? closedCircuitBreaker();
  const consecutiveFailures = current.consecutiveFailures + 1;
  const mustOpen = current.state === "half_open" || consecutiveFailures >= threshold;
  const at = new Date(now).toISOString();
  return {
    state: mustOpen ? "open" : "closed",
    consecutiveFailures,
    lastFailureAt: at,
    lastFailureStage: String(stage),
    openedAt: mustOpen ? at : null,
    nextRetryAt: mustOpen ? new Date(now + cooldownMs).toISOString() : null,
  };
}

function releaseRecord(release) {
  return {
    id: "7691",
    version: release.manifest.digest,
    artifactPath: release.path,
    digest: release.manifest.digest,
  };
}

function validatePendingRecord(pending) {
  if (!pending || typeof pending !== "object" || pending.schemaVersion !== PENDING_SCHEMA_VERSION) fail("pending promotion schema is invalid");
  if (!PENDING_PHASES.has(pending.phase)) fail("pending promotion phase is invalid");
  if (typeof pending.sessionId !== "string" || !pending.sessionId) fail("pending promotion sessionId is invalid");
  if (!pending.candidate || !pending.previousLastKnownGood) fail("pending promotion release records are required");
  if (!Number.isInteger(pending.oldProductionPid) || pending.oldProductionPid <= 0) fail("pending promotion oldProductionPid is invalid");
  if (["candidate_started", "candidate_core_verified", "candidate_verified"].includes(pending.phase)) {
    if (!Number.isInteger(pending.candidatePid) || pending.candidatePid <= 0) fail("pending promotion candidatePid is invalid");
  }
  if (pending.phase === "candidate_core_verified") {
    if (!Number.isInteger(pending.candidateToolCount) || pending.candidateToolCount <= 0) fail("pending promotion candidateToolCount is invalid");
    if (typeof pending.candidateCoreVerifiedAt !== "string" || !Number.isFinite(Date.parse(pending.candidateCoreVerifiedAt))) fail("pending promotion core verification timestamp is invalid");
  }
  return pending;
}

export function pendingHealthDecision(pending, healthPayload) {
  validatePendingRecord(pending);
  if (!healthPayload || healthPayload.ok !== true) return "production_down";
  const digest = healthPayload.artifactDigest ?? null;
  if (digest === pending.candidate.digest) return "candidate";
  if (digest === pending.previousLastKnownGood.digest) return "previous_lkg";
  return "mismatch";
}

function clean(v) { if (typeof v === "string") return v.replace(/https?:\/\/\S+/gi, "[redacted-url]").replace(/(token|secret|password|credential|authorization|api[-_]?key)\s*[=:]\s*\S+/gi, "$1=[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]"); if (Array.isArray(v)) return v.map(clean); if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k,x]) => [k, /token|secret|password|credential|authorization|api[-_]?key/i.test(k) ? "[redacted]" : clean(x)])); return v; }
function fail(m) { throw new Error(clean(String(m))); }
async function exists(p) { try { await stat(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } }
async function json(p) { return JSON.parse(await readFile(p, "utf8")); }
async function atomicJson(p, v) { await mkdir(path.dirname(p), { recursive: true }); const t = `${p}.${process.pid}.${randomUUID()}.tmp`; await writeFile(t, `${JSON.stringify(clean(v), null, 2)}\n`, { mode: 0o600 }); await rename(t, p); }
async function filesUnder(root, rel = "") { const out=[]; for (const e of await readdir(path.join(root, rel), { withFileTypes:true })) { const r=path.join(rel,e.name); if(e.isDirectory()) out.push(...await filesUnder(root,r)); else if(e.isFile()) out.push(r.replaceAll("\\","/")); } return out.sort(); }
async function manifestFor(bundle) { const names=(await filesUnder(bundle)).filter(x=>x!=="manifest.json"), files=[]; for(const name of names){const data=await readFile(path.join(bundle,...name.split("/"))); files.push({path:name,bytes:data.length,sha256:createHash("sha256").update(data).digest("hex")});} const digest=createHash("sha256").update(files.map(x=>`${x.path}\0${x.bytes}\0${x.sha256}\n`).join("")).digest("hex"); return {schemaVersion:1,digest,fileCount:files.length,byteCount:files.reduce((n,x)=>n+x.bytes,0),files}; }
function assertManagedRelease(p) { const rel=path.relative(RELEASES_ROOT,path.resolve(p)); if(!rel||rel.startsWith("..")||path.isAbsolute(rel)||rel.includes(path.sep)||!/^[a-f0-9]{64}$/.test(path.basename(p))) fail("managed artifact path escapes releases root or is not content-addressed"); }
export async function verifyIntegrity(p) { assertManagedRelease(p); const expected=await json(path.join(p,"manifest.json")), actual=await manifestFor(p); if(expected.digest!==path.basename(p)||JSON.stringify(expected)!==JSON.stringify(actual)) fail("release integrity mismatch"); return actual; }
async function freeze(source,{replaceEntrypoint=false,omitServer=false}={}) {
  await mkdir(RELEASES_ROOT,{recursive:true});
  const temp=path.join(STATE_ROOT,`.release-${randomUUID()}`);
  try {
    await mkdir(path.join(temp,"overlay"),{recursive:true});
    for(const name of OVERLAY_FILES){const src=replaceEntrypoint&&name===ENTRYPOINT?path.join(ROOT,"runtime","codexless",name):path.join(source,"overlay",name);await cp(src,path.join(temp,"overlay",name));}
    const reviewedHousekeeping=path.join(source,"plugins","housekeeping");
    const housekeepingSource=await exists(reviewedHousekeeping)?reviewedHousekeeping:path.join(ROOT,"plugins","housekeeping");
    await cp(housekeepingSource,path.join(temp,"plugins","housekeeping"),{recursive:true});
    await cp(path.join(source,"codexless-runtime","package.json"),path.join(temp,"codexless-runtime","package.json"),{recursive:true});
    await cp(path.join(source,"codexless-runtime","src"),path.join(temp,"codexless-runtime","src"),{recursive:true});
    await cp(path.join(source,"codexless-runtime","config"),path.join(temp,"codexless-runtime","config"),{recursive:true});
    const packageJson=await json(path.join(source,"codexless-runtime","package.json"));
    for(const dep of frozenDepsForPackage(packageJson)){if(omitServer&&dep==="@modelcontextprotocol/server")continue;await cp(path.join(source,"codexless-runtime","node_modules",...dep.split("/")),path.join(temp,"codexless-runtime","node_modules",...dep.split("/")),{recursive:true});}
    const manifest=await manifestFor(temp),final=path.join(RELEASES_ROOT,manifest.digest);
    if(await exists(final)){await verifyIntegrity(final);return {path:final,manifest};}
    await writeFile(path.join(temp,"manifest.json"),`${JSON.stringify(manifest,null,2)}\n`,{mode:0o444});await rename(temp,final);return {path:final,manifest};
  } finally { await rm(temp,{recursive:true,force:true}).catch(()=>{}); }
}
async function sourceWithRuntimeConfig(source) { await cp(path.join(process.env.LOCALAPPDATA,"Codexless","config"),path.join(source,"codexless-runtime","config"),{recursive:true}); return source; }
async function freezeCurrent(options={}) {
  if(process.env.SPIKE_BRIDGE_REVIEWED_SOURCE){
    const reviewed=path.join(STATE_ROOT,"work","operator-reviewed-source");
    if(path.resolve(process.env.SPIKE_BRIDGE_REVIEWED_SOURCE)!==reviewed)fail("reviewed candidate source path is not allowed");
    return freeze(reviewed,options);
  }
  const source=path.join(STATE_ROOT,`.current-${randomUUID()}`); try { await mkdir(source,{recursive:true}); await mkdir(path.join(source,"overlay"),{recursive:true}); for(const name of OVERLAY_FILES) await cp(path.join(ROOT,"runtime","codexless",name),path.join(source,"overlay",name)); await cp(path.join(SEED_ROOT,"codexless-runtime"),path.join(source,"codexless-runtime"),{recursive:true}); await sourceWithRuntimeConfig(source); return await freeze(source,options); } finally { await rm(source,{recursive:true,force:true}).catch(()=>{}); } }
async function freezeSeed() { const source=path.join(STATE_ROOT,`.seed-${randomUUID()}`); try { await cp(SEED_ROOT,source,{recursive:true}); await sourceWithRuntimeConfig(source); return await freeze(source,{replaceEntrypoint:true}); } finally { await rm(source,{recursive:true,force:true}).catch(()=>{}); } }
async function verificationCandidate(){
  const digest=String(process.env.SPIKE_SAFE_BOOT_VERIFY_DIGEST??"").trim().toLowerCase();
  if(!digest)return freezeCurrent();
  if(!/^[a-f0-9]{64}$/.test(digest))fail("SPIKE_SAFE_BOOT_VERIFY_DIGEST must be a 64-character lowercase hex digest");
  const releasePath=path.join(RELEASES_ROOT,digest);
  const manifest=await verifyIntegrity(releasePath);
  return {path:releasePath,manifest};
}
function validateVerifyPending(value){
  if(!value||typeof value!=="object"||value.schemaVersion!==1)fail("staged verify record is invalid");
  if(typeof value.sessionId!=="string"||!/^[0-9a-f-]{36}$/.test(value.sessionId))fail("staged verify session id is invalid");
  if(value.kind!=="current")fail("staged verify kind is invalid");
  if(typeof value.digest!=="string"||!/^[a-f0-9]{64}$/.test(value.digest))fail("staged verify digest is invalid");
  if(typeof value.releasePath!=="string")fail("staged verify release path is invalid");
  assertManagedRelease(value.releasePath);
  if(path.basename(path.resolve(value.releasePath))!==value.digest)fail("staged verify release identity mismatch");
  if(!Number.isInteger(value.productionPid)||value.productionPid<=0)fail("staged verify production pid is invalid");
  if(!Number.isInteger(value.candidatePid)||value.candidatePid<=0)fail("staged verify candidate pid is invalid");
  if(typeof value.startedAt!=="string"||!Number.isFinite(Date.parse(value.startedAt)))fail("staged verify timestamp is invalid");
  if(value.coreVerifiedAt!==undefined&&value.coreVerifiedAt!==null){
    if(typeof value.coreVerifiedAt!=="string"||!Number.isFinite(Date.parse(value.coreVerifiedAt)))fail("staged verify core timestamp is invalid");
    if(!value.coreSurface||typeof value.coreSurface!=="object"||!Number.isInteger(value.coreSurface.toolCount)||value.coreSurface.toolCount<=0)fail("staged verify core surface is invalid");
  }
  return structuredClone(value);
}
async function readVerifyPending(){
  try{return validateVerifyPending(await json(VERIFY_PENDING_PATH));}
  catch(error){if(error?.code==="ENOENT")return null;throw error;}
}
async function clearVerifyPending(){await rm(VERIFY_PENDING_PATH,{force:true});}
function run(exe,args,opts={}) { const r=spawnSync(exe,args,{encoding:"utf8",windowsHide:true,...opts}); return {ok:r.status===0,status:r.status,stdout:clean(r.stdout||""),stderr:clean(r.stderr||"")}; }
export async function preflight(p) { const checks=[],add=(name,ok,detail)=>checks.push({name,status:ok?"pass":"fail",...(!ok&&detail?{detail:clean(detail)}:{})}); add("fixed-node",await exists(NODE)); add("fixed-spike-os-python",await exists(PYTHON)); add("canonical-codex-a-auth",await exists(path.join(PRIMARY_CODEX_HOME,"auth.json"))); add("canonical-call-profile",await exists(PRIMARY_CALL_PROFILE)); add("canonical-memory-db",await exists(PRIMARY_MEMORY_DB)); add("canonical-mac-secret",await exists(PRIMARY_MAC_SECRET)); let integrity; try{integrity=await verifyIntegrity(p);add("release-integrity",true);}catch(e){add("release-integrity",false,e.message);return {status:"not_ready",passed:false,checks};} for(const name of OVERLAY_FILES.slice(0,3)){const r=run(NODE,["--check",path.join(p,"overlay",name)]);add(`node-check:${name}`,r.ok,r.stderr);} const runtimeRoot=path.join(p,"codexless-runtime"),packageJson=await json(path.join(runtimeRoot,"package.json")),probes=runtimeDependencyProbes(packageJson),script=`const{createRequire}=require('node:module'),path=require('node:path');const root=${JSON.stringify(runtimeRoot)},r=createRequire(${JSON.stringify(path.join(runtimeRoot,"package.json"))});for(const n of ${JSON.stringify(probes)}){const found=path.resolve(r.resolve(n));if(!found.toLowerCase().startsWith((root+path.sep).toLowerCase()))throw new Error('resolution escaped frozen runtime: '+n);}`,req=run(NODE,["-e",script]);add("frozen-createRequire",req.ok,req.stderr); const bridge=run(PYTHON,[path.join(p,"overlay","spike-context-bridge.py"),"--preflight"]);let b;try{b=JSON.parse(bridge.stdout);}catch{} add("spike-context-preflight",bridge.ok&&b?.result==="PASS"&&b?.tool==="spike_context"&&b?.write_tools===0&&b?.ledger_scope==="personal_g6",bridge.stderr||(b?"contract mismatch":"invalid JSON")); const passed=checks.every(x=>x.status==="pass");return {status:passed?"ready":"not_ready",passed,digest:integrity.digest,checks}; }
async function request(port,ep){const r=await fetch(`http://127.0.0.1:${port}/${ep}`,{signal:AbortSignal.timeout(5000)});return {status:r.status,body:await r.json()};}
function parseMcpEvent(text){for(const line of String(text).split(/\r?\n/)){if(!line.startsWith("data: "))continue;const value=JSON.parse(line.slice(6));if(value?.error)fail(`MCP error ${value.error.code}: ${value.error.message}`);if(value?.result)return value.result;}fail("MCP response missing result event");}
async function mcpRpc(port,id,method,params,{timeoutMs=20000}={}){const r=await fetch(`http://127.0.0.1:${port}/mcp`,{method:"POST",headers:{"content-type":"application/json","accept":"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id,method,params}),signal:AbortSignal.timeout(timeoutMs)});if(r.status!==200)fail(`MCP ${method} returned HTTP ${r.status}`);return parseMcpEvent(await r.text());}
function samePath(a,b){return typeof a==="string"&&typeof b==="string"&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();}
async function productionTrustedRoots(){
  const roots=[];
  for(const [index,root] of [ROOT].entries()){
    const called=await mcpRpc(7690,900+index,"tools/call",{name:"codex.project_context",arguments:{cwd:root}});
    const context=called?.structuredContent??null;
    const runtimeRoots=Array.isArray(context?.runtimeWorkspaceRoots)?context.runtimeWorkspaceRoots:[];
    if(!samePath(context?.cwd,root)||!runtimeRoots.some(value=>samePath(value,root))||typeof context?.activePermissionProfile?.id!=="string"||!context.activePermissionProfile.id){
      fail(`production Codex trust proof failed for ${root}`);
    }
    roots.push(path.resolve(root));
  }
  return roots;
}
async function expectedCandidateToolNames(release){const contractPath=path.join(release.path,"codexless-runtime","src","surface-contracts.mjs"),module=await import(`${pathToFileURL(contractPath).href}?digest=${release.manifest.digest}`),publicTools=module.PUBLIC_TOOL_ALLOWLIST;if(!Array.isArray(publicTools)||!publicTools.every(name=>typeof name==="string"&&name))fail("candidate public tool allowlist is invalid");const expected=[...publicTools,...OVERLAY_TOOL_NAMES];if(new Set(expected).size!==expected.length)fail("candidate expected tool contract contains duplicates");return expected;}
export function candidateBrowserStatusAccepted(browser){return Boolean(browser&&browser.status==="ok"&&browser.nodeRepl==="ok"&&browser.chrome?.family==="chrome"&&["ok","not_required"].includes(browser.chromeSkill)&&browser.reason!=="chrome_skill_unavailable"&&browser.reason!=="current_chrome_skill_unavailable");}
export function candidateBrowserStatusRetryable(browser){return Boolean(browser&&browser.status==="unavailable"&&browser.reason==="BROWSER_RUNTIME_ERROR");}
function browserStatusSummary(browser){return {status:browser?.status??"unknown",reason:browser?.reason??null,error:browser?.error??null,nodeRepl:browser?.nodeRepl??"unknown",chromeFamily:browser?.chrome?.family??null,chromeSkill:browser?.chromeSkill??"unknown",connectedBrowsers:Array.isArray(browser?.connectedBrowsers)?browser.connectedBrowsers:[]};}
async function readCandidateBrowserStatus(port,id){
  // Browser Workbench tool calls have a 60s inner budget plus cold bootstrap.
  // The outer probe must wait for that bounded result instead of aborting at 20s.
  const called=await mcpRpc(port,id,"tools/call",{name:"codex.browser_status",arguments:{cwd:WORKBENCH_ROOT}},{timeoutMs:90000});
  return called?.structuredContent??null;
}
function browserToolError(called){
  if(!called?.isError)return null;
  const text=Array.isArray(called?.content)?called.content.map(item=>typeof item?.text==="string"?item.text:"").filter(Boolean).join("\n"):"";
  if(!text)return {error:"browser tool returned isError",errorCode:null};
  try{
    const parsed=JSON.parse(text);
    return {error:parsed?.error??text.slice(0,1000),errorCode:parsed?.errorCode??null};
  }catch{
    return {error:text.slice(0,1000),errorCode:null};
  }
}
async function readCandidateBrowserTabs(port,id){
  const called=await mcpRpc(port,id,"tools/call",{name:"codex.browser_tabs",arguments:{cwd:WORKBENCH_ROOT}},{timeoutMs:90000});
  const toolError=browserToolError(called);
  if(toolError)return {ok:false,...toolError,value:null};
  const value=called?.structuredContent??null;
  const ok=Boolean(
    value?.status==="ok" &&
    value?.browser==="chrome" &&
    Number.isInteger(value?.count) &&
    Array.isArray(value?.tabs) &&
    value.count===value.tabs.length
  );
  return {ok,error:ok?null:"browser_tabs returned an invalid structured result",errorCode:null,value};
}
function browserTabsSummary(result){
  return {
    ok:Boolean(result?.ok),
    error:result?.error??null,
    errorCode:result?.errorCode??null,
    status:result?.value?.status??null,
    browser:result?.value?.browser??null,
    count:Number.isInteger(result?.value?.count)?result.value.count:null,
  };
}
async function candidateBrowserAcceptance(port,session=null){
  const browserAttempts=[];
  let browser=await readCandidateBrowserStatus(port,2);
  browserAttempts.push(browserStatusSummary(browser));
  if(!candidateBrowserStatusAccepted(browser)&&candidateBrowserStatusRetryable(browser)){
    await new Promise(resolve=>setTimeout(resolve,5000));
    browser=await readCandidateBrowserStatus(port,3);
    browserAttempts.push(browserStatusSummary(browser));
  }
  const browserLive=candidateBrowserStatusAccepted(browser);
  const browserOfflineAdvisory=Boolean(browser?.status==="unavailable"&&browser?.reason==="chrome_not_connected"&&browser?.nodeRepl==="ok");
  if(!browserLive&&!browserOfflineAdvisory){
    fail(`candidate Browser contract mismatch after ${browserAttempts.length} attempt(s): ${JSON.stringify(browserAttempts)}`);
  }
  const browserTabsAttempts=[];
  let browserTabs={ok:false,error:"skipped: Chrome is not connected",errorCode:"CHROME_NOT_CONNECTED",value:null};
  if(browserLive){
    browserTabs=await readCandidateBrowserTabs(port,4);
    browserTabsAttempts.push(browserTabsSummary(browserTabs));
    if(!browserTabs.ok&&browserTabs.errorCode==="BROWSER_RUNTIME_ERROR"){
      await new Promise(resolve=>setTimeout(resolve,5000));
      browserTabs=await readCandidateBrowserTabs(port,5);
      browserTabsAttempts.push(browserTabsSummary(browserTabs));
    }
    if(!browserTabs.ok){
      fail(`candidate browser_tabs contract mismatch after ${browserTabsAttempts.length} attempt(s): ${JSON.stringify(browserTabsAttempts)}`);
    }
  }
  if(session)await event(session,"candidate_browser_probe_pass",{browser:browserStatusSummary(browser),browserLive,browserOfflineAdvisory,browserTabs:browserTabsSummary(browserTabs)});
  return {browser,browserAttempts,browserLive,browserOfflineAdvisory,browserTabs,browserTabsAttempts};
}
async function candidateSurfaceAcceptance(release,port,session=null,{includeBrowser=true}={}){
  const expected=await expectedCandidateToolNames(release);
  const listed=await mcpRpc(port,1,"tools/list",{});
  const tools=Array.isArray(listed?.tools)?listed.tools:[];
  const names=tools.map(tool=>tool?.name).filter(Boolean);
  if(new Set(names).size!==names.length)fail("candidate MCP tool list contains duplicates");
  const actualSorted=[...names].sort(),expectedSorted=[...expected].sort();
  if(JSON.stringify(actualSorted)!==JSON.stringify(expectedSorted)){
    const missing=expected.filter(name=>!names.includes(name)),extra=names.filter(name=>!expected.includes(name));
    fail(`candidate MCP tool contract mismatch: expected=${expected.length} actual=${names.length} missing=${missing.join(",")||"none"} extra=${extra.join(",")||"none"}`);
  }
  if(names.includes("spike.agent_show"))fail("candidate retired public spike.agent_show must remain absent");
  if(!names.includes("spike.agent_status"))fail("candidate public spike.agent_status is required");
  for(const required of ["codex.browser_status","codex.browser_tabs","codex.browser_read","model_free_git_commit","spike_context"]){
    if(!names.includes(required))fail(`candidate MCP missing required tool: ${required}`);
  }
  const agentApprove=tools.find(tool=>tool?.name==="codex.agent_approve");
  const approveProperties=agentApprove?.inputSchema?.properties;
  if(!approveProperties?.elicitationContent||typeof agentApprove?.description!=="string"||!agentApprove.description.includes("mcpServer/elicitation/request")){
    fail("candidate codex.agent_approve is missing MCP elicitation control contract");
  }
  const agentReject=tools.find(tool=>tool?.name==="codex.agent_reject");
  if(typeof agentReject?.description!=="string"||!agentReject.description.includes("mcpServer/elicitation/request")){
    fail("candidate codex.agent_reject is missing MCP elicitation decline contract");
  }

  const cardContractPath=path.join(release.path,"codexless-runtime","src","spike-agent-card-ui.mjs");
  const cardModule=await import(`${pathToFileURL(cardContractPath).href}?digest=${release.manifest.digest}`);
  const cardCurrent=cardModule.SPIKE_AGENT_CARD_URI;
  const cardCompat=Array.isArray(cardModule.SPIKE_AGENT_CARD_COMPAT_URIS)
    ? cardModule.SPIKE_AGENT_CARD_COMPAT_URIS.filter(uri=>typeof uri==="string"&&uri)
    : [cardModule.SPIKE_AGENT_CARD_LEGACY_URI,cardModule.SPIKE_AGENT_CARD_LEGACY_V2_URI,cardModule.SPIKE_AGENT_CARD_LEGACY_V1_URI].filter(uri=>typeof uri==="string"&&uri);
  if(typeof cardCurrent!=="string"||!/^ui:\/\/spike\/agent-card-v\d+\.html$/.test(cardCurrent)){
    fail("candidate Spike Agent Card canonical resource URI is invalid");
  }
  if(cardCompat.some(uri=>!/^ui:\/\/spike\/agent-card-v\d+\.html$/.test(uri))||new Set([cardCurrent,...cardCompat]).size!==1+cardCompat.length){
    fail("candidate Spike Agent Card compatibility resource URIs are invalid");
  }
  const spikeStart=tools.find(tool=>tool?.name==="spike.agent_start");
  if(spikeStart?._meta?.ui?.resourceUri!==cardCurrent||spikeStart?._meta?.["openai/outputTemplate"]!==cardCurrent){
    fail("candidate Spike Agent Card start metadata does not match the frozen canonical resource");
  }
  const expectedDelegationBases=["user_requested","capability_required","materially_faster"];
  for(const startToolName of ["spike.agent_start","codex.agent_start"]){
    const tool=tools.find(entry=>entry?.name===startToolName);
    const schema=tool?.inputSchema;
    const delegation=schema?.properties?.delegation;
    const basisEnum=delegation?.properties?.basis?.enum;
    const topRequired=Array.isArray(schema?.required)?schema.required:[];
    const delegationRequired=Array.isArray(delegation?.required)?delegation.required:[];
    if(!tool||!topRequired.includes("delegation")||delegation?.type!=="object"
      ||!delegationRequired.includes("basis")||!delegationRequired.includes("rationale")
      ||!Array.isArray(basisEnum)||JSON.stringify([...basisEnum].sort())!==JSON.stringify([...expectedDelegationBases].sort())){
      fail(`candidate ${startToolName} is missing the deny-by-default Agent Delegation Gate contract`);
    }
  }
  for(const name of ["spike.agent_status","spike.agent_send","spike.agent_cancel"]){
    const tool=tools.find(entry=>entry?.name===name);
    if(tool?._meta?.ui?.resourceUri||tool?._meta?.["openai/outputTemplate"]){
      fail(`candidate ${name} must remain data-only without App template metadata`);
    }
  }
  const appResources=await mcpRpc(port,10,"resources/list",{});
  const resourceUris=Array.isArray(appResources?.resources)?appResources.resources.map(item=>item?.uri).filter(Boolean):[];
  for(const uri of [cardCurrent,...cardCompat])if(!resourceUris.includes(uri))fail(`candidate Spike Agent Card resource is missing: ${uri}`);
  const readCard=async(id,uri)=>{
    const read=await mcpRpc(port,id,"resources/read",{uri}),content=read?.contents?.[0];
    if(content?.uri!==uri||content?.mimeType!=="text/html;profile=mcp-app"||content?._meta?.ui?.prefersBorder!==true||typeof content?.text!=="string"||!content.text.includes("acceptAgentCardView")){
      fail(`candidate Spike Agent Card resource contract failed for ${uri}`);
    }
    return content;
  };
  const cardCurrentContent=await readCard(11,cardCurrent);
  for(let index=0;index<cardCompat.length;index+=1){
    const compatContent=await readCard(12+index,cardCompat[index]);
    if(compatContent.text!==cardCurrentContent.text)fail(`candidate compatibility resource must serve byte-identical canonical App HTML: ${cardCompat[index]}`);
  }

  const surfaceModule=await import(`${pathToFileURL(path.join(release.path,"codexless-runtime","src","surface-contracts.mjs")).href}?digest=${release.manifest.digest}`);
  if(surfaceModule.PUBLIC_SURFACE_VERSION?.includes("operator-control-v1")){
    const {runtimeCall}=await import("../../operator/server.mjs");
    const snapshot=await runtimeCall(ROOT,"snapshot",{},{port});
    const observed=await health(port);
    const healthBody=observed.healthz?.body;
    if(snapshot?.pid!==healthBody?.pid||healthBody?.artifactDigest!==release.manifest.digest||!Number.isInteger(snapshot?.settingsRevision)||typeof snapshot?.settingsHash!=="string")fail("candidate private operator identity/settings handshake failed");
    for(const key of ["active","awaitingApproval","starting","uncertain"])if(!Number.isInteger(snapshot?.counts?.[key])||snapshot.counts[key]<0)fail(`candidate private operator count unavailable: ${key}`);
    if(surfaceModule.PUBLIC_SURFACE_VERSION?.includes("operator-usage-v1")&&snapshot?.usageRecording?.enabled!==true)fail("candidate durable usage recording is unavailable");
    if(names.some(name=>/operator|usage_export|admin/i.test(name)))fail("candidate private operator controls leaked into public MCP tools");
  }
  if(session)await event(session,"candidate_surface_structural_pass",{toolCount:names.length});

  const providerProbe=async(id,tool,provider,ref,extra={})=>{
    const called=await mcpRpc(port,id,"tools/call",{name:tool,arguments:{provider,ref,...extra}});
    return {isError:Boolean(called?.isError),value:called?.structuredContent??null};
  };
  const accountGate=(async()=>{
    const called=await mcpRpc(port,20,"tools/call",{name:"codex.account_preflight",arguments:{}});
    const value=called?.structuredContent??null;
    if(session)await event(session,"candidate_account_probe_completed",{status:value?.status??null,accountStatus:value?.account?.status??null,authMode:value?.account?.authMode??null});
    return called;
  })();
  const providerGate=(async()=>{
    const values=await Promise.all([
      providerProbe(21,"spike.agent_status","codex-a","safe_boot_missing_codex_a"),
      providerProbe(22,"spike.agent_status","codex-b","safe_boot_missing_codex_b"),
      providerProbe(23,"spike.agent_status","zcode","safe_boot_missing_zcode"),
      providerProbe(24,"spike.agent_cancel","mac","safe_boot_missing_mac",{requestId:"safe-boot-mac-cancel-contract"}),
      providerProbe(25,"spike.agent_cancel","workbee","safe_boot_missing_workbee",{requestId:"safe-boot-workbee-reject-contract"}),
    ]);
    if(session)await event(session,"candidate_provider_probes_completed",{providers:["codex-a","codex-b","zcode","mac","workbee"]});
    return values;
  })();
  const browserGate=includeBrowser
    ? candidateBrowserAcceptance(port,session)
    : Promise.resolve({browser:null,browserAttempts:[],browserLive:false,browserOfflineAdvisory:false,browserTabs:{ok:false,error:"skipped: staged core verification",errorCode:"STAGED_CORE_ONLY",value:null},browserTabsAttempts:[]});
  const [browserGateResult,accountCall,providerProbeValues]=await Promise.all([browserGate,accountGate,providerGate]);
  const {browser,browserAttempts,browserLive,browserOfflineAdvisory,browserTabs,browserTabsAttempts}=browserGateResult;
  const account=accountCall?.structuredContent??null;
  if(!account||!["ok","partial"].includes(account.status)||account?.account?.status!=="ok"||account?.account?.accountPresent!==true||account?.account?.authMode!=="chatgpt"){
    fail(`candidate Codex A account preflight failed: ${JSON.stringify({status:account?.status??null,account:account?.account??null})}`);
  }
  const [codexA,codexB,zcode,mac,workbee]=providerProbeValues;
  const providerProbes={codexA,codexB,zcode,mac,workbee};
  if(providerProbes.codexA.isError||providerProbes.codexA.value?.provider!=="codex-a")fail("candidate codex-a provider route failed");
  if(providerProbes.codexB.isError||providerProbes.codexB.value?.provider!=="codex-b")fail("candidate codex-b provider route failed");
  if(!providerProbes.zcode.isError||providerProbes.zcode.value?.provider!=="zcode"||providerProbes.zcode.value?.status!=="lost"||typeof providerProbes.zcode.value?.error!=="string")fail("candidate zcode missing-ref contract failed");
  if(!providerProbes.mac.isError||providerProbes.mac.value?.provider!=="mac"||providerProbes.mac.value?.code!=="AGENT_PROVIDER_CANCEL_UNSUPPORTED")fail("candidate mac cancel-unsupported contract failed");
  const macCard=providerProbes.mac.value?.cardV1;
  if(macCard?.schemaVersion!=="spike.agent-card.v1"||macCard?.provider?.label!=="Mac"||macCard?.state?.status!=="unknown"||macCard?.execution?.host!=="Mac"||macCard?.quota?.available!==false||macCard?.capabilities?.cancel!==false){
    fail("candidate cancel.cardV1 canonical contract failed");
  }
  if(!providerProbes.workbee.isError||providerProbes.workbee.value?.errorCode!=="AGENT_PROVIDER_UNKNOWN")fail("candidate legacy workbee route was not rejected");

  return {
    toolCount:names.length,
    expectedToolCount:expected.length,
    account:{status:account.status,authMode:account.account.authMode,plan:account.account.plan??null,quotaStatus:account.quota?.status??null},
    providerRoutes:{codexA:"pass",codexB:"pass",zcode:"pass",mac:"pass",workbee:"rejected"},
    browser,
    browserAttempts,
    browserLive,
    browserOfflineAdvisory,
    browserTabs:browserTabs.value,
    browserTabsAttempts,
  };
}
async function listenerPid(port){const r=run("C:\\Windows\\System32\\netstat.exe",["-ano","-p","tcp"]);if(!r.ok)fail("netstat failed");const line=r.stdout.split(/\r?\n/).find(x=>new RegExp(`^\\s*TCP\\s+127\\.0\\.0\\.1:${port}\\s+.*\\s+LISTENING\\s+\\d+\\s*$`,"i").test(x));return line?Number(line.trim().split(/\s+/).at(-1)):null;}
async function commandLine(pid){
  const s=`$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -OperationTimeoutSec 2 -ErrorAction Stop; Write-Output $p.CommandLine`;
  const r=run("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",["-NoProfile","-NonInteractive","-Command",s],{timeout:5000});
  return r.ok?r.stdout.trim():null;
}
async function processPath(pid){
  const s=`$p=Get-Process -Id ${pid} -ErrorAction Stop; Write-Output $p.Path`;
  const r=run("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",["-NoProfile","-NonInteractive","-Command",s],{timeout:5000});
  if(!r.ok)fail(`cannot inspect executable path for process ${pid}`);
  return path.resolve(r.stdout.trim());
}
async function processStartedAt(pid){
  const s=`$p=Get-Process -Id ${pid} -ErrorAction Stop; Write-Output ($p.StartTime.ToUniversalTime().ToString(\"o\"))`;
  const r=run("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",["-NoProfile","-NonInteractive","-Command",s],{timeout:5000});
  if(!r.ok)return null;
  const value=Date.parse(r.stdout.trim());
  return Number.isFinite(value)?value:null;
}
async function assertOverlayIdentity(pid,port){
  if(![7690,7691].includes(port))fail("identity check requires fixed port");
  const owner=await listenerPid(port);
  if(owner!==pid)fail(`listener ownership mismatch on ${port}`);
  const exe=await processPath(pid);
  if(exe.toLowerCase()!==path.resolve(NODE).toLowerCase())fail(`listener ${pid} is not fixed Node executable`);
  const cmd=await commandLine(pid);
  if(cmd&&cmd.toLowerCase().includes(ENTRYPOINT.toLowerCase()))return {pid,method:"command-line"};
  const h=await health(port);
  if(!h.ok)fail(`listener ${pid} failed Spike Home health identity`);
  const reportedPid=h.healthz?.body?.pid;
  if(Number.isInteger(reportedPid)&&reportedPid!==pid)fail(`health PID mismatch on ${port}`);
  if(!Number.isInteger(reportedPid)){
    const body=h.healthz?.body;
    if(port!==7690||body?.service!=="spike-home-codexless-overlay"||body?.surfaceVersion!=="codexless-public-preview-v1+model-free-git-commit-v1+spike-context-personal-v1"){
      fail(`legacy listener identity could not be proven for ${pid}`);
    }
    return {pid,method:"legacy-health"};
  }
  return {pid,method:"health-pid"};
}
async function productionIdentity(knownHealth=null){
  const h=knownHealth??await health(7690);
  const pid=await listenerPid(7690);
  if(!pid)return null;
  if(h?.ok){
    const healthPid=h.healthz?.body?.pid,readyPid=h.readyz?.body?.pid;
    const serviceOk=h.healthz?.body?.service==="spike-home-codexless-overlay"&&h.readyz?.body?.service==="spike-home-codexless-overlay";
    if(serviceOk&&healthPid===pid&&readyPid===pid)return {pid,method:"health-listener-pid"};
    fail(`healthy production PID identity mismatch on 7690 (listener=${pid}, health=${String(healthPid)}, ready=${String(readyPid)})`);
  }
  return assertOverlayIdentity(pid,7690);
}
async function health(port,digest){try{const [h,r]=await Promise.all([request(port,"healthz"),request(port,"readyz")]),valid=x=>x.status===200&&x.body?.ok===true&&x.body.modelFreeGitCommit==="PASS"&&x.body.spikeContextBridge==="PASS"&&x.body.spikeContextTool==="spike_context"&&x.body.modelCallCount===0&&(digest===undefined||x.body.artifactDigest===digest);return {ok:valid(h)&&valid(r),healthz:h,readyz:r};}catch(e){return {ok:false,error:clean(e.message)};}}
function processAlive(pid){return run("C:\\Windows\\System32\\tasklist.exe",["/FI",`PID eq ${pid}`,"/NH"]).stdout.includes(String(pid));}
async function cleanupOrphanedPinnedCodex(session){
  const pinned=path.resolve(resolvePinnedCodex());
  const escaped=pinned.replaceAll("'","''");
  const script=`$expected='${escaped}'; Get-CimInstance Win32_Process -OperationTimeoutSec 2 | Where-Object { $_.Name -eq 'codex.exe' -and $_.ExecutablePath -eq $expected -and $_.CommandLine -match 'app-server\\s+--stdio' } | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress`;
  const listed=run("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{timeout:5000});
  if(!listed.ok){
    await event(session,"orphaned_codex_inspection_unavailable",{reason:clean(listed.stderr||listed.stdout||`status=${String(listed.status)}`)});
    return [];
  }
  let rows=[];
  if(String(listed.stdout||"").trim()){
    let parsed;try{parsed=JSON.parse(listed.stdout);}catch{fail("pinned Codex process inventory returned invalid JSON");}
    rows=Array.isArray(parsed)?parsed:[parsed];
  }
  const cleaned=[];
  for(const row of rows){
    const pid=Number(row?.ProcessId),parentPid=Number(row?.ParentProcessId);
    if(!Number.isInteger(pid)||pid<=0)continue;
    if(Number.isInteger(parentPid)&&parentPid>0&&processAlive(parentPid))continue;
    if(!processAlive(pid))continue;
    const killed=run("C:\\Windows\\System32\\taskkill.exe",["/PID",String(pid),"/T","/F"]);
    if(!killed.ok&&processAlive(pid))fail(`failed to clean orphaned pinned Codex app-server ${pid}`);
    cleaned.push(pid);
  }
  if(cleaned.length)await event(session,"orphaned_codex_cleaned",{pids:cleaned});
  return cleaned;
}
async function waitHealth(port,digest,pid,ms=90000,{lateGraceMs=15000}={}){
  const started=Date.now(),end=started+ms,startupGraceMs=3000;
  do{
    const h=await health(port,digest);
    if(h.ok)return h;
    if(pid&&!processAlive(pid)&&Date.now()-started>=startupGraceMs)fail(`process ${pid} exited before readiness`);
    await new Promise(r=>setTimeout(r,500));
  }while(Date.now()<end);
  if(pid&&processAlive(pid)&&lateGraceMs>0){
    const lateEnd=Date.now()+lateGraceMs;
    do{
      const h=await health(port,digest);
      if(h.ok)return h;
      if(!processAlive(pid))fail(`process ${pid} exited during late readiness reconciliation`);
      await new Promise(r=>setTimeout(r,500));
    }while(Date.now()<lateEnd);
  }
  const finalHealth=await health(port,digest);
  if(finalHealth.ok)return finalHealth;
  fail(`readiness timeout on ${port}`);
}
async function stopSpawnedProcessTree(pid,port){
  if(!pid)return;
  if(![7690,7691].includes(port))fail("stopSpawnedProcessTree requires fixed port");
  const listener=await listenerPid(port);
  if(listener!==null&&listener!==pid)fail(`port ${port} is owned by unexpected pid ${listener}; refusing to stop ${pid}`);
  if(!processAlive(pid)){
    if(listener===null)return;
    fail(`pid ${pid} is not alive but still appears to own port ${port}`);
  }
  if(listener===pid)await assertOverlayIdentity(pid,port);
  else{
    const exe=await processPath(pid);
    if(exe.toLowerCase()!==path.resolve(NODE).toLowerCase())fail(`spawned pid ${pid} is not fixed Node executable`);
    const cmd=await commandLine(pid);
    if(!cmd||!cmd.toLowerCase().includes(ENTRYPOINT.toLowerCase()))fail(`spawned pid ${pid} is not the managed Spike Bridge entrypoint`);
  }
  const r=run("C:\\Windows\\System32\\taskkill.exe",["/PID",String(pid),"/T","/F"]);
  if(!r.ok)fail(`failed to stop managed process tree ${pid}: exit=${r.status}; ${r.stderr||r.stdout}`);
  const end=Date.now()+15000;
  while(Date.now()<end){
    const alive=processAlive(pid);
    const current=await listenerPid(port);
    if(!alive&&current===null)return;
    if(current!==null&&current!==pid)fail(`port ${port} was taken by unexpected pid ${current} while stopping ${pid}`);
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  fail(`managed process tree ${pid} did not fully release port ${port}`);
}
async function stopExact(pid, port){
  if(!pid)return;
  if(![7690,7691].includes(port))fail("stopExact requires fixed port");
  await assertOverlayIdentity(pid,port);
  return stopSpawnedProcessTree(pid,port);
}
async function event(session,type,data={}){await store.appendEvent(session,type,clean(data));}
function candidateCodexHome(session){
  const safe=String(session??"").replace(/[^A-Za-z0-9._-]/g,"_");
  if(!safe)fail("candidate CODEX_HOME requires session id");
  return path.join(CANDIDATE_CODEX_HOME_ROOT,safe);
}
async function copyCandidateStatic(source,destination,{recursive=false}={}){
  try{
    await cp(source,destination,{recursive,force:true,dereference:recursive});
    return true;
  }catch(error){
    if(error?.code==="ENOENT")return false;
    throw error;
  }
}
async function prepareCandidateCodexHome(session,trustedRoots=[]){
  const stateRoot=candidateCodexHome(session);
  await rm(stateRoot,{recursive:true,force:true,maxRetries:20,retryDelay:250});
  await mkdir(stateRoot,{recursive:true});
  const sqliteHome=path.join(stateRoot,"sqlite");
  await mkdir(sqliteHome,{recursive:true});
  const configOverridesFile=path.join(stateRoot,"safe-boot-config-overrides.json");
  const overrides=trustedRoots.map(root=>`projects.${JSON.stringify(path.resolve(root))}.trust_level=\"trusted\"`);
  await writeFile(configOverridesFile,`${JSON.stringify({overrides},null,2)}\n`,"utf8");
  return {home:PRIMARY_CODEX_HOME,sqliteHome,configOverridesFile,stateRoot};
}
async function cleanupCandidateCodexHome(session){
  await rm(candidateCodexHome(session),{recursive:true,force:true,maxRetries:20,retryDelay:250});
}
function runtimeEnv(release,port,codexHome=PRIMARY_CODEX_HOME,configOverridesFile=null,sqliteHome=null){
  const candidateStateRoot=port===7691&&sqliteHome?path.dirname(sqliteHome):null;
  const noProxy=[...new Set([...(String(process.env.NO_PROXY??"").split(",").map(x=>x.trim()).filter(Boolean)),"127.0.0.1","localhost","::1"])].join(",");
  const env={
    ...process.env,
    SPIKE_BRIDGE_ROOT:ROOT,
    CODEX_BIN:resolvePinnedCodex(),
    CODEX_TOOLBOX_PUBLIC_HOST:"127.0.0.1",
    CODEX_TOOLBOX_PUBLIC_PORT:String(port),
    CODEXLESS_CODEX_RUNTIME:"existing",
    CODEXLESS_DEFAULT_CWD:ROOT,
    CODEXLESS_PROFILE:":workspace",
    CODEXLESS_AGENT_TASK_STATE_FILE:candidateStateRoot?path.join(candidateStateRoot,"agent-task-cards.json"):PRIMARY_AGENT_A_STATE,
    CODEXLESS_CALL_PROFILE_FILE:PRIMARY_CALL_PROFILE,
    SPIKE_BRIDGE_MEMORY_DB:candidateStateRoot?path.join(candidateStateRoot,"experience.db"):PRIMARY_MEMORY_DB,
    SPIKE_BRIDGE_ZCODE_STATE_FILE:candidateStateRoot?path.join(candidateStateRoot,"zcode-jobs.json"):PRIMARY_ZCODE_STATE,
    SPIKE_BRIDGE_MAC_SECRET_FILE:PRIMARY_MAC_SECRET,
    SPIKE_BRIDGE_HOUSEKEEPING_PLUGIN:path.join(release.path,"plugins","housekeeping","index.mjs"),
    TOOLBOX_DEFAULT_CWD:ROOT,
    CODEX_TOOLBOX_DEFAULT_CWD:ROOT,
    SPIKE_HOME_CODEXLESS_RUNTIME_ROOT:path.join(release.path,"codexless-runtime"),
    SPIKE_HOME_ARTIFACT_DIGEST:release.manifest.digest,
    USERPROFILE:"C:\\Users\\Administrator",
    HOME:"C:\\Users\\Administrator",
    HOMEDRIVE:"C:",
    HOMEPATH:"\\Users\\Administrator",
    LOCALAPPDATA:"C:\\Users\\Administrator\\AppData\\Local",
    APPDATA:"C:\\Users\\Administrator\\AppData\\Roaming",
    CODEX_HOME:codexHome,
    NO_PROXY:noProxy,
  };
  if(port===7691){
    if(!sqliteHome)fail("candidate sqlite home is required on 7691");
    env.CODEX_SQLITE_HOME=sqliteHome;
    if(configOverridesFile){
      env.CODEXLESS_CONFIG_OVERRIDES_FILE=configOverridesFile;
      env.CODEX_TOOLBOX_CONFIG_OVERRIDES_FILE=configOverridesFile;
    }
  }
  return env;
}
async function startRelease(release,port,session,trustedRoots=[]){
  if(![7690,7691].includes(port))fail("invalid fixed port");
  await verifyIntegrity(release.path);
  const candidateRuntime=port===7691?await prepareCandidateCodexHome(session,trustedRoots):null;
  const codexHome=candidateRuntime?.home??PRIMARY_CODEX_HOME;
  const configOverridesFile=candidateRuntime?.configOverridesFile??null;
  const sqliteHome=candidateRuntime?.sqliteHome??null;
  const out=path.join(LOG_ROOT,`boot-${session}-${port}.stdout.log`),err=path.join(LOG_ROOT,`boot-${session}-${port}.stderr.log`);
  await mkdir(LOG_ROOT,{recursive:true});
  const of=await open(out,"a"),ef=await open(err,"a");
  try{
    const child=spawn(NODE,[path.join(release.path,"overlay",ENTRYPOINT)],{cwd:ROOT,detached:true,windowsHide:true,stdio:["ignore",of.fd,ef.fd],env:runtimeEnv(release,port,codexHome,configOverridesFile,sqliteHome)});
    child.unref();
    await event(session,"process_started",{pid:child.pid,port,digest:release.manifest.digest,stdout:out,stderr:err,candidateCodexHome:port===7691?codexHome:null});
    return child.pid;
  }catch(error){
    if(port===7691)await cleanupCandidateCodexHome(session);
    throw error;
  }finally{
    await of.close();
    await ef.close();
  }
}
async function findBootProcessStart(pid,port){
  const dir=path.join(STATE_ROOT,"boot-sessions");
  let entries=[];
  try{entries=await readdir(dir,{withFileTypes:true});}catch(error){if(error?.code==="ENOENT")return null;throw error;}
  const files=[];
  for(const entry of entries){
    if(!entry.isFile()||!/^boot-[0-9a-f-]+\.jsonl$/i.test(entry.name))continue;
    const full=path.join(dir,entry.name),info=await stat(full);
    files.push({full,mtimeMs:info.mtimeMs});
  }
  files.sort((a,b)=>b.mtimeMs-a.mtimeMs);
  for(const {full} of files.slice(0,200)){
    const lines=(await readFile(full,"utf8")).split(/\r?\n/).filter(Boolean).reverse();
    for(const line of lines){
      let value;try{value=JSON.parse(line);}catch{continue;}
      if(value?.type==="process_started"&&value?.pid===pid&&value?.port===port){
        return {sessionId:value.sessionId??null,stdout:value.stdout??null,stderr:value.stderr??null};
      }
    }
  }
  return null;
}
async function writeManagedBridgeRecord(release,pid,session,snapshot=null){
  const h=snapshot??await health(7690);
  if(!h.ok)fail("cannot record managed bridge state while 7690 is unhealthy");
  const observed=session?null:await findBootProcessStart(pid,7690);
  const now=new Date().toISOString();
  const effectiveSession=session??observed?.sessionId??null;
  const record={
    pid:Number(pid),
    port:7690,
    startedAt:now,
    recordedAt:now,
    aHome:PRIMARY_CODEX_HOME,
    runtimeRoot:path.join(release.path,"codexless-runtime"),
    overlay:path.join(release.path,"overlay",ENTRYPOINT),
    stdout:observed?.stdout??(effectiveSession?path.join(LOG_ROOT,`boot-${effectiveSession}-7690.stdout.log`):null),
    stderr:observed?.stderr??(effectiveSession?path.join(LOG_ROOT,`boot-${effectiveSession}-7690.stderr.log`):null),
    surfaceVersion:h.healthz?.body?.surfaceVersion??null,
    toolCount:h.healthz?.body?.toolCount??null,
    artifactDigest:h.healthz?.body?.artifactDigest??release.manifest.digest,
    managedBy:"safe-boot",
  };
  await atomicJson(path.join(BRIDGE_STATE_ROOT,"bridge-7690.pid.json"),record);
  return record;
}
async function startMutableProduction(session){
  const powershell="C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const mutableRuntime=path.join(SEED_ROOT,"codexless-runtime");
  const r=run(powershell,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",MUTABLE_LAUNCHER,"-Port","7690","-AHome",PRIMARY_CODEX_HOME,"-RuntimeRoot",mutableRuntime,"-ReadyTimeoutSec","30","-BreakGlassMutableProduction"],{env:{...process.env,SPIKE_SAFE_BOOT_BREAK_GLASS:"1"}});
  if(!r.ok)fail(`mutable production rollback launcher failed: ${r.stderr||r.stdout||`exit ${r.status}`}`);
  let receipt=null;
  try{const line=String(r.stdout||"").trim().split(/\r?\n/).filter(Boolean).at(-1);receipt=JSON.parse(line);}catch{}
  if(receipt?.result!=="PASS")fail("mutable production rollback did not return PASS receipt");
  const h=await health(7690);
  if(!h.ok||h.healthz?.body?.artifactDigest!==null)fail("mutable production rollback did not restore healthy direct runtime");
  const pid=await listenerPid(7690);
  await event(session,"mutable_production_restored",{pid,artifactDigest:h.healthz?.body?.artifactDigest??null});
  return {pid,health:h,receipt};
}
async function validateCandidate(release,session){
  if(await listenerPid(7691))fail("candidate port 7691 is occupied");
  const pf=await preflight(release.path);
  await event(session,"dependency_preflight",pf);
  if(!pf.passed)fail("dependency preflight failed");
  const trustedRoots=await productionTrustedRoots();
  await event(session,"candidate_trust_snapshot",{trustedRoots});
  let pid=null,validationError=null;
  try{
    pid=await startRelease(release,7691,session,trustedRoots);
    const h=await waitHealth(7691,release.manifest.digest,pid);
    const surface=await candidateSurfaceAcceptance(release,7691,session);
    if(h.healthz?.body?.toolCount!==surface.expectedToolCount||h.readyz?.body?.toolCount!==surface.expectedToolCount)fail(`candidate health tool count mismatch: expected=${surface.expectedToolCount} actual=${h.healthz?.body?.toolCount}/${h.readyz?.body?.toolCount}`);
    await event(session,"candidate_ready",{pid,digest:release.manifest.digest,toolCount:surface.toolCount,browser:surface.browser,browserAttempts:surface.browserAttempts});
    return {...h,surface};
  }catch(error){
    validationError=error;
    await event(session,"candidate_validation_failed",{error:error.message});
    throw error;
  }finally{
    try{
      if(pid&&processAlive(pid))await stopExact(pid,7691);
      await cleanupCandidateCodexHome(session);
    }catch(cleanupError){
      await event(session,"candidate_cleanup_failed",{error:cleanupError.message,validationError:validationError?.message??null});
      if(validationError)throw new AggregateError([validationError,cleanupError],`${validationError.message}; candidate cleanup also failed: ${cleanupError.message}`);
      throw cleanupError;
    }
  }
}
async function stageCandidateVerification(release,kind="current"){
  if(kind!=="current")fail("staged verification supports current candidates only");
  const stale=await readVerifyPending();
  if(stale){
    if(processAlive(stale.candidatePid))fail(`staged verify already active for ${stale.digest}`);
    await clearVerifyPending();
    await cleanupCandidateCodexHome(stale.sessionId).catch(()=>{});
  }
  if(await listenerPid(7691))fail("candidate port 7691 is occupied");
  const session=randomUUID();
  const before=await productionIdentity(),beforeHealth=await health(7690);
  if(!before||!beforeHealth.ok)fail("production 7690 is not healthy before staged candidate validation");
  await event(session,"session_started",{action:"verify",phase:"start",kind,digest:release.manifest.digest,productionPid:before.pid});
  const pf=await preflight(release.path);
  await event(session,"dependency_preflight",pf);
  if(!pf.passed)fail("dependency preflight failed");
  const trustedRoots=await productionTrustedRoots();
  await event(session,"candidate_trust_snapshot",{trustedRoots});
  let pid=null,keepCandidate=false;
  try{
    pid=await startRelease(release,7691,session,trustedRoots);
    const h=await waitHealth(7691,release.manifest.digest,pid);
    const pending={
      schemaVersion:1,
      sessionId:session,
      kind,
      digest:release.manifest.digest,
      releasePath:release.path,
      productionPid:before.pid,
      candidatePid:pid,
      startedAt:new Date().toISOString(),
    };
    await atomicJson(VERIFY_PENDING_PATH,pending);
    keepCandidate=true;
    await event(session,"candidate_staged",{pid,digest:release.manifest.digest,toolCount:h.healthz?.body?.toolCount??null});
    return {result:"PASS",action:"verify-staged",phase:"start",digest:release.manifest.digest,sessionId:session,candidatePid:pid,productionPid:before.pid};
  }finally{
    if(!keepCandidate){
      if(pid&&processAlive(pid))await stopExact(pid,7691).catch(()=>{});
      await cleanupCandidateCodexHome(session).catch(()=>{});
    }
  }
}
async function coreCandidateVerification(){
  const pending=await readVerifyPending();
  if(!pending)fail("no staged verify candidate is available");
  const release={path:path.resolve(pending.releasePath),manifest:await verifyIntegrity(pending.releasePath)};
  const before=await productionIdentity(),beforeHealth=await health(7690);
  if(!before||!beforeHealth.ok||before.pid!==pending.productionPid)fail("production changed during staged candidate validation");
  const candidateOwner=await listenerPid(7691);
  if(candidateOwner!==pending.candidatePid)fail(`staged candidate listener mismatch: expected=${pending.candidatePid} observed=${candidateOwner??"none"}`);
  await assertOverlayIdentity(pending.candidatePid,7691);
  const h=await health(7691,pending.digest);
  if(!h.ok)fail("staged candidate is not healthy at core verification");
  const surface=await candidateSurfaceAcceptance(release,7691,pending.sessionId,{includeBrowser:false});
  if(h.healthz?.body?.toolCount!==surface.expectedToolCount||h.readyz?.body?.toolCount!==surface.expectedToolCount)fail(`candidate health tool count mismatch: expected=${surface.expectedToolCount} actual=${h.healthz?.body?.toolCount}/${h.readyz?.body?.toolCount}`);
  const next={
    ...pending,
    coreVerifiedAt:new Date().toISOString(),
    coreSurface:{toolCount:surface.toolCount,expectedToolCount:surface.expectedToolCount,account:surface.account,providerRoutes:surface.providerRoutes},
  };
  await atomicJson(VERIFY_PENDING_PATH,next);
  await event(pending.sessionId,"candidate_core_verified",{pid:pending.candidatePid,digest:pending.digest,toolCount:surface.toolCount,account:surface.account,providerRoutes:surface.providerRoutes});
  return {result:"PASS",action:"verify-core",phase:"core",digest:pending.digest,sessionId:pending.sessionId,candidatePid:pending.candidatePid,productionPid:pending.productionPid,toolCount:surface.toolCount};
}
async function finishCandidateVerification(){
  const pending=await readVerifyPending();
  if(!pending)fail("no staged verify candidate is available");
  if(!pending.coreVerifiedAt||!pending.coreSurface)fail("staged verify core phase has not completed");
  if(Date.now()-Date.parse(pending.coreVerifiedAt)>10*60_000)fail("staged verify core evidence expired; restart verification");
  const release={path:path.resolve(pending.releasePath),manifest:await verifyIntegrity(pending.releasePath)};
  let candidateStopped=false,verified=false;
  try{
    const before=await productionIdentity(),beforeHealth=await health(7690);
    if(!before||!beforeHealth.ok||before.pid!==pending.productionPid)fail("production changed during staged candidate validation");
    const candidateOwner=await listenerPid(7691);
    if(candidateOwner!==pending.candidatePid)fail(`staged candidate listener mismatch: expected=${pending.candidatePid} observed=${candidateOwner??"none"}`);
    await assertOverlayIdentity(pending.candidatePid,7691);
    const h=await health(7691,pending.digest);
    if(!h.ok)fail("staged candidate is not healthy at finish");
    const browser=await candidateBrowserAcceptance(7691,pending.sessionId);
    const expectedToolCount=pending.coreSurface.expectedToolCount??pending.coreSurface.toolCount;
    if(h.healthz?.body?.toolCount!==expectedToolCount||h.readyz?.body?.toolCount!==expectedToolCount)fail(`candidate health tool count mismatch: expected=${expectedToolCount} actual=${h.healthz?.body?.toolCount}/${h.readyz?.body?.toolCount}`);
    await event(pending.sessionId,"candidate_surface_verified",{pid:pending.candidatePid,digest:pending.digest,toolCount:pending.coreSurface.toolCount,browser:browser.browser,browserAttempts:browser.browserAttempts});
    await stopExact(pending.candidatePid,7691);
    candidateStopped=true;
    await cleanupCandidateCodexHome(pending.sessionId);
    const after=await productionIdentity(),afterHealth=await health(7690);
    if(!afterHealth.ok||after?.pid!==pending.productionPid)fail("production changed during staged candidate validation");
    const receipt={schemaVersion:1,digest:pending.digest,releasePath:pending.releasePath,verifiedAt:new Date().toISOString(),productionPid:pending.productionPid,kind:pending.kind};
    await atomicJson(VERIFIED_PATH,receipt);
    await clearVerifyPending();
    verified=true;
    await event(pending.sessionId,"verified",receipt);
    return {result:"PASS",action:"verify-finished",phase:"finish",...receipt,toolCount:pending.coreSurface.toolCount,browser:browser.browser,browserAttempts:browser.browserAttempts};
  }catch(error){
    await event(pending.sessionId,"staged_verify_failed",{error:error instanceof Error?error.message:String(error)}).catch(()=>{});
    throw error;
  }finally{
    if(!candidateStopped&&processAlive(pending.candidatePid))await stopExact(pending.candidatePid,7691).catch(()=>{});
    await cleanupCandidateCodexHome(pending.sessionId).catch(()=>{});
    if(!verified)await clearVerifyPending().catch(()=>{});
  }
}
async function abortCandidateVerification(){
  const pending=await readVerifyPending();
  if(!pending)return {result:"PASS",action:"verify-aborted",phase:"abort",alreadyIdle:true};
  const before=await productionIdentity(),beforeHealth=await health(7690);
  if(!before||!beforeHealth.ok||before.pid!==pending.productionPid)fail("production changed during staged candidate validation; refusing to abort or clear candidate state");
  const candidateOwner=await listenerPid(7691);
  if(candidateOwner!==null){
    if(candidateOwner!==pending.candidatePid)fail(`staged candidate listener mismatch during abort: expected=${pending.candidatePid} observed=${candidateOwner}`);
    await assertOverlayIdentity(pending.candidatePid,7691);
    await stopExact(pending.candidatePid,7691);
  }else if(processAlive(pending.candidatePid)){
    fail(`staged candidate pid ${pending.candidatePid} is still alive without owning port 7691; refusing unsafe cleanup`);
  }
  await cleanupCandidateCodexHome(pending.sessionId);
  const after=await productionIdentity(),afterHealth=await health(7690);
  if(!after||!afterHealth.ok||after.pid!==pending.productionPid)fail("production changed while aborting staged candidate validation");
  await clearVerifyPending();
  await event(pending.sessionId,"candidate_verify_aborted",{pid:pending.candidatePid,digest:pending.digest,productionPid:pending.productionPid});
  return {result:"PASS",action:"verify-aborted",phase:"abort",digest:pending.digest,candidatePid:pending.candidatePid,productionPid:pending.productionPid};
}
async function lockOwnerIsActive(owner){
  if(!Number.isInteger(owner?.pid)||owner.pid<=0||!processAlive(owner.pid))return false;
  const lockAt=Date.parse(owner?.at??"");
  const startedAt=await processStartedAt(owner.pid);
  if(Number.isFinite(lockAt)&&Number.isFinite(startedAt))return startedAt<=lockAt;
  const cmd=await commandLine(owner.pid);
  if(!cmd)return true;
  const scriptName=path.basename(fileURLToPath(import.meta.url)).toLowerCase();
  return cmd.toLowerCase().includes(scriptName);
}
async function withLock(fn){
  await mkdir(STATE_ROOT,{recursive:true});
  try{
    await mkdir(LOCK_PATH);
  }catch(e){
    if(e.code!=="EEXIST")throw e;
    let owner;
    try{owner=await json(path.join(LOCK_PATH,"owner.json"));}catch{}
    if(await lockOwnerIsActive(owner))fail("safe-boot production lock is held");
    await rm(LOCK_PATH,{recursive:true,force:true});
    await mkdir(LOCK_PATH);
  }
  await atomicJson(path.join(LOCK_PATH,"owner.json"),{pid:process.pid,at:new Date().toISOString()});
  try{return await fn();}
  finally{await rm(LOCK_PATH,{recursive:true,force:true});}
}
async function stateUpdate(patch){const s=await store.readState();return store.writeState({...s,...patch,updatedAt:new Date().toISOString()});}

async function gateOperationalCircuit(session, action, now = Date.now()){
  let state=await store.readState();
  const decision=breakerGateDecision(state.circuitBreaker,now);
  if(!decision.allowed){
    await event(session,"circuit_breaker_blocked",{action,nextRetryAt:state.circuitBreaker.nextRetryAt,breaker:state.circuitBreaker});
    return {allowed:false,state};
  }
  if(decision.transition==="half_open"){
    state=await store.writeState({...state,circuitBreaker:decision.breaker,updatedAt:new Date(now).toISOString()});
    await event(session,"circuit_breaker_half_open",{action,breaker:state.circuitBreaker});
  }
  return {allowed:true,state};
}

async function recordOperationalFailure(session,stage,error,now=Date.now()){
  const state=await store.readState();
  const breaker=breakerAfterFailure(state.circuitBreaker,stage,now);
  const next=await store.writeState({...state,circuitBreaker:breaker,updatedAt:new Date(now).toISOString()});
  await event(session,"circuit_breaker_failure",{stage,error:clean(String(error)),breaker});
  return next;
}

async function closeOperationalCircuit(session,reason){
  const state=await store.readState();
  const breaker=closedCircuitBreaker();
  const next=await store.writeState({...state,circuitBreaker:breaker,updatedAt:new Date().toISOString()});
  await event(session,"circuit_breaker_closed",{reason});
  return next;
}

async function writePendingPhase(state,pending,phase,extra={}){
  if(!PENDING_PHASES.has(phase))fail("invalid pending phase");
  const nextPending={...pending,...extra,phase,updatedAt:new Date().toISOString()};
  return store.writeState({...state,pending:nextPending,updatedAt:nextPending.updatedAt});
}

async function reconcilePending(state){
  const pending=validatePendingRecord(state.pending);
  const session=pending.sessionId;
  let candidate,previous;
  try{
    candidate=releaseFromRecord(pending.candidate);
    candidate.manifest=await verifyIntegrity(candidate.path);
    previous=releaseFromRecord(pending.previousLastKnownGood);
    previous.manifest=await verifyIntegrity(previous.path);
  }catch(error){
    await event(session,"pending_recovery_invalid_release",{phase:pending.phase,error:error.message});
    return {result:"FAIL",action:"pending-invalid",reason:"pending_release_invalid",pendingPreserved:true};
  }

  const current=await health(7690);
  if(current.ok){
    const decision=pendingHealthDecision(pending,current.healthz?.body);
    if(decision==="candidate"){
      try{
        const currentPid=await listenerPid(7690);
        if(pending.candidatePid&&currentPid!==pending.candidatePid)fail(`pending candidate PID mismatch: expected=${pending.candidatePid} observed=${currentPid??"none"}`);
        const maintenance=await setProductionMaintenance(true);
        const counts=maintenance?.counts;
        if(!counts||!["active","awaitingApproval","starting","uncertain"].every(key=>Number.isInteger(counts[key])&&counts[key]>=0))fail("pending candidate operator counts are unavailable");
        if(counts.active+counts.awaitingApproval+counts.starting+counts.uncertain>0)fail("pending candidate has active or uncertain work; recovery will not finalize it");

        if(pending.phase==="candidate_started"){
          const surface=await candidateSurfaceAcceptance(candidate,7690,session,{includeBrowser:false});
          if(current.healthz?.body?.toolCount!==surface.expectedToolCount||current.readyz?.body?.toolCount!==surface.expectedToolCount)fail(`pending candidate health tool count mismatch: expected=${surface.expectedToolCount} actual=${current.healthz?.body?.toolCount}/${current.readyz?.body?.toolCount}`);
          const verifiedAt=new Date().toISOString();
          const nextState=await writePendingPhase(state,pending,"candidate_core_verified",{candidatePid:currentPid,candidateToolCount:surface.toolCount,candidateCoreVerifiedAt:verifiedAt,candidateAccount:surface.account,candidateProviderRoutes:surface.providerRoutes});
          await event(session,"pending_candidate_core_verified",{digest:pending.candidate.digest,pid:currentPid,toolCount:surface.toolCount});
          return {result:"PASS",action:"pending-candidate-core-verified",digest:pending.candidate.digest,pid:currentPid,toolCount:surface.toolCount,pendingPreserved:true,circuitBreaker:nextState.circuitBreaker};
        }

        let browser=null,browserAttempts=[];
        let workingState=state;
        let workingPending=pending;
        if(pending.phase==="candidate_core_verified"){
          if(Date.now()-Date.parse(pending.candidateCoreVerifiedAt)>STAGED_PROMOTION_CORE_MAX_AGE_MS)fail("pending candidate core evidence expired; staged recovery requires a fresh core verification");
          const browserGate=await candidateBrowserAcceptance(7690,session);
          browser=browserGate.browser;
          browserAttempts=browserGate.browserAttempts;
          if(current.healthz?.body?.toolCount!==pending.candidateToolCount||current.readyz?.body?.toolCount!==pending.candidateToolCount)fail(`pending candidate health tool count mismatch: expected=${pending.candidateToolCount} actual=${current.healthz?.body?.toolCount}/${current.readyz?.body?.toolCount}`);
          workingState=await writePendingPhase(state,pending,"candidate_verified",{candidatePid:currentPid,candidateToolCount:pending.candidateToolCount,candidateBrowserAttempts:browserAttempts,candidateBrowser:browser});
          workingPending=workingState.pending;
        }else if(pending.phase==="candidate_verified"){
          browser=pending.candidateBrowser??null;
          browserAttempts=Array.isArray(pending.candidateBrowserAttempts)?pending.candidateBrowserAttempts:[];
        }else{
          fail(`healthy candidate cannot be finalized from pending phase ${pending.phase}`);
        }

        if(currentPid)await writeManagedBridgeRecord(candidate,currentPid,session,current);
        const finalized=await store.writeState({...workingState,lastKnownGood:workingPending.candidate,pending:null,circuitBreaker:closedCircuitBreaker(),updatedAt:new Date().toISOString()});
        await setProductionMaintenance(false).catch(()=>{});
        await event(session,"pending_candidate_finalized",{phase:workingPending.phase,digest:workingPending.candidate.digest,toolCount:workingPending.candidateToolCount,browser,browserAttempts});
        return {result:"PASS",action:"pending-candidate-finalized",digest:workingPending.candidate.digest,toolCount:workingPending.candidateToolCount,browser,browserAttempts,circuitBreaker:finalized.circuitBreaker};
      }catch(error){
        await event(session,"pending_candidate_surface_failed",{phase:pending.phase,digest:pending.candidate.digest,error:error.message});
        return {result:"FAIL",action:"pending-candidate-surface-failed",reason:"candidate_surface_unverified",pendingPreserved:true,maintenanceHeld:true};
      }
    }
    if(decision==="previous_lkg"){
      const currentPid=await listenerPid(7690);
      if(currentPid)await writeManagedBridgeRecord(previous,currentPid,session,current);
      await store.writeState({...state,lastKnownGood:pending.previousLastKnownGood,pending:null,updatedAt:new Date().toISOString()});
      await event(session,"pending_rollback_recognized",{phase:pending.phase,digest:pending.previousLastKnownGood.digest});
      return {result:"PASS",action:"pending-lkg-recognized",digest:pending.previousLastKnownGood.digest};
    }
    await event(session,"pending_recovery_mismatch",{phase:pending.phase,observedDigest:current.healthz?.body?.artifactDigest??null});
    return {result:"FAIL",action:"pending-mismatch",reason:"healthy_production_digest_mismatch",pendingPreserved:true};
  }

  const pf=await preflight(previous.path);
  await event(session,"pending_lkg_preflight",{phase:pending.phase,preflight:pf});
  if(!pf.passed)return {result:"FAIL",action:"pending-lkg-preflight-failed",pendingPreserved:true};

  const existing=await listenerPid(7690);
  if(existing){
    const identity=await productionIdentity();
    if(!identity||identity.pid!==existing)return {result:"FAIL",action:"pending-port-occupied",pendingPreserved:true};
    await stopExact(identity.pid,7690);
  }

  const pid=await startRelease(previous,7690,session);
  try{
    const restoredHealth=await waitHealth(7690,previous.manifest.digest,pid);
    await writeManagedBridgeRecord(previous,pid,session,restoredHealth);
  }catch(error){
    await event(session,"pending_lkg_restore_failed",{error:error.message,pid,digest:previous.manifest.digest});
    return {result:"FAIL",action:"pending-lkg-restore-failed",pendingPreserved:true};
  }
  await store.writeState({...state,lastKnownGood:pending.previousLastKnownGood,pending:null,updatedAt:new Date().toISOString()});
  await event(session,"pending_lkg_restored",{pid,digest:previous.manifest.digest});
  return {result:"PASS",action:"pending-lkg-restored",pid,digest:previous.manifest.digest};
}
async function verifyRelease(release,kind="current"){const session=randomUUID(),before=await productionIdentity(),beforeHealth=await health(7690);if(!before||!beforeHealth.ok)fail("production 7690 is not healthy before candidate validation");await event(session,"session_started",{action:"verify",kind,digest:release.manifest.digest,productionPid:before.pid});await validateCandidate(release,session);const after=await productionIdentity(),afterHealth=await health(7690);if(!afterHealth.ok||after?.pid!==before.pid)fail("production changed during candidate validation");const receipt={schemaVersion:1,digest:release.manifest.digest,releasePath:release.path,verifiedAt:new Date().toISOString(),productionPid:before.pid,kind};await atomicJson(VERIFIED_PATH,receipt);await event(session,"verified",receipt);return {result:"PASS",...receipt};}
async function initSeed(){return withLock(async()=>{const release=await freezeSeed(),result=await verifyRelease(release,"seed-lkg");await stateUpdate({lastKnownGood:{id:"7691",version:release.manifest.digest,artifactPath:release.path,digest:release.manifest.digest}});return result;});}
async function verifyCurrent(){
  return withLock(async()=>{
    const phase=String(process.env.SPIKE_SAFE_BOOT_VERIFY_PHASE??"full").trim().toLowerCase()||"full";
    if(!["full","start","core","finish","abort"].includes(phase))fail("SPIKE_SAFE_BOOT_VERIFY_PHASE must be full, start, core, finish, or abort");
    const circuitSession=randomUUID();
    const gate=await gateOperationalCircuit(circuitSession,"verify");
    if(!gate.allowed)return {result:"REFUSED",action:"verify",reason:"circuit_breaker_open",circuitBreaker:gate.state.circuitBreaker};
    try{
      const result=phase==="start"
        ? await stageCandidateVerification(await verificationCandidate(),"current")
        : phase==="core"
          ? await coreCandidateVerification()
          : phase==="finish"
            ? await finishCandidateVerification()
            : phase==="abort"
              ? await abortCandidateVerification()
              : await verifyRelease(await verificationCandidate(),"current");
      if(!["start","core"].includes(phase))await closeOperationalCircuit(circuitSession,"verify_success");
      return result;
    }catch(error){
      const state=await recordOperationalFailure(circuitSession,`verify_${phase}`,error.message);
      return {result:"FAIL",action:"verify",phase,error:clean(error.message),circuitBreaker:state.circuitBreaker};
    }
  });
}
async function faultTest(){return withLock(async()=>{const before=await productionIdentity(),beforeHealth=await health(7690);if(!before||!beforeHealth.ok)fail("production unhealthy before fault test");const bad=await freezeCurrent({omitServer:true}),session=randomUUID(),pf=await preflight(bad.path);await event(session,"test_only_fault",{digest:bad.manifest.digest,preflight:pf});if(pf.passed)fail("bad candidate unexpectedly passed");const after=await productionIdentity(),afterHealth=await health(7690);if(!afterHealth.ok||after?.pid!==before.pid)fail("production changed during fault test");return {result:"PASS",testOnly:true,badDigest:bad.manifest.digest,productionPid:before.pid,preflightRejected:true};});}
function releaseFromRecord(rec){const p=path.resolve(rec.artifactPath??rec.releasePath);assertManagedRelease(p);return {path:p,manifest:{digest:rec.digest}};}
async function promoteFull(){
  return withLock(async()=>{
    const session=randomUUID();
    const gate=await gateOperationalCircuit(session,"promote");
    if(!gate.allowed)return {result:"REFUSED",action:"promote",reason:"circuit_breaker_open",circuitBreaker:gate.state.circuitBreaker};

    let receipt,release,old,priorState,prior,priorRecord;
    try{
      receipt=await json(VERIFIED_PATH);
      if(process.env.SPIKE_OPERATOR_EXPECTED_DIGEST&&receipt.digest!==process.env.SPIKE_OPERATOR_EXPECTED_DIGEST)fail("operator selected candidate changed before promotion");
      release=releaseFromRecord(receipt);
      release.manifest=await verifyIntegrity(release.path);
      if(release.manifest.digest!==receipt.digest)fail("verified receipt no longer matches release");
      old=await productionIdentity();
      const oldHealth=await health(7690);
      if(!old||!oldHealth.ok)fail("production is not healthy before promotion");
      if(receipt.kind!=="current")fail(`verified receipt kind is not promotable: ${receipt.kind??"unknown"}`);
      if(receipt.productionPid!==old.pid)fail(`production changed since verification: verifiedPid=${receipt.productionPid??"unknown"} currentPid=${old.pid}`);

      await validateCandidate(release,session);

      priorState=await store.readState();
      priorRecord=priorState.lastKnownGood;
      if(!priorRecord)fail("promotion requires a previous last known good");
      if(oldHealth.healthz?.body?.artifactDigest!==priorRecord.digest)fail(`production artifact drifted from recorded LKG: observed=${oldHealth.healthz?.body?.artifactDigest??"unknown"} recorded=${priorRecord.digest}`);
      prior=releaseFromRecord(priorRecord);
      prior.manifest=await verifyIntegrity(prior.path);
      const priorPreflight=await preflight(prior.path);
      await event(session,"rollback_target_preflight",{digest:prior.manifest.digest,preflight:priorPreflight});
      if(!priorPreflight.passed)fail("previous last known good preflight failed");
    }catch(error){
      const failed=await recordOperationalFailure(session,"promote_precheck",error.message);
      return {result:"FAIL",action:"promote",stage:"precheck",error:clean(error.message),productionPreserved:true,circuitBreaker:failed.circuitBreaker};
    }

    const candidateRecord=releaseRecord(release);
    const startedAt=new Date().toISOString();
    const pending={
      schemaVersion:PENDING_SCHEMA_VERSION,
      phase:"prepared",
      sessionId:session,
      candidate:candidateRecord,
      previousLastKnownGood:priorRecord,
      oldProductionPid:old.pid,
      startedAt,
      updatedAt:startedAt,
    };
    let state=await store.writeState({...priorState,pending,updatedAt:startedAt});
    await event(session,"promotion_prepared",{digest:receipt.digest,oldPid:old.pid,previousDigest:priorRecord.digest});

    let newPid=null;
    try{
      if(process.env.SPIKE_OPERATOR_BOOTSTRAP==="1")await legacyIdle(ROOT);
      await stopExact(old.pid,7690);
      state=await writePendingPhase(state,state.pending,"old_stopped");

      newPid=await startRelease(release,7690,session);
      state=await writePendingPhase(state,state.pending,"candidate_started",{candidatePid:newPid});
      const h=await waitHealth(7690,receipt.digest,newPid);
      // The native control receipt belongs to the new process only after its
      // startup completes. Early maintenance calls can still see the dead PID.
      await setProductionMaintenance(true);
      const surface=await candidateSurfaceAcceptance(release,7690);
      if(h.healthz?.body?.toolCount!==surface.expectedToolCount||h.readyz?.body?.toolCount!==surface.expectedToolCount)fail(`production candidate health tool count mismatch: expected=${surface.expectedToolCount} actual=${h.healthz?.body?.toolCount}/${h.readyz?.body?.toolCount}`);
      await writeManagedBridgeRecord(release,newPid,session,h);
      state=await writePendingPhase(state,state.pending,"candidate_verified",{candidatePid:newPid,candidateToolCount:surface.toolCount,candidateBrowserAttempts:surface.browserAttempts});

      state=await store.writeState({
        ...state,
        lastKnownGood:candidateRecord,
        pending:null,
        circuitBreaker:closedCircuitBreaker(),
        updatedAt:new Date().toISOString(),
      });
      await event(session,"promotion_succeeded",{digest:receipt.digest,pid:newPid,toolCount:surface.toolCount,browser:surface.browser,browserAttempts:surface.browserAttempts});
      return {result:"PASS",digest:receipt.digest,oldPid:old.pid,newPid,health:h,toolCount:surface.toolCount,browser:surface.browser,browserAttempts:surface.browserAttempts,artifactDigestMatch:h.healthz?.body?.artifactDigest===receipt.digest,circuitBreaker:state.circuitBreaker};
    }catch(error){
      const failedState=await recordOperationalFailure(session,"promotion_activation",error.message);
      let candidateStopError=null;
      if(newPid&&processAlive(newPid)){
        try{await stopSpawnedProcessTree(newPid,7690);}catch(stopError){candidateStopError=stopError;await event(session,"failed_candidate_stop_error",{error:stopError.message,pid:newPid});}
      }
      await event(session,"promotion_failed",{error:error.message,phase:(await store.readState()).pending?.phase??null});
      if(candidateStopError)return {result:"FAIL",action:"promote",stage:"candidate-cleanup",error:clean(error.message),cleanupError:clean(candidateStopError.message),pendingPreserved:true,maintenanceHeld:true,rollbackNotStarted:true,circuitBreaker:failedState.circuitBreaker};

      try{
        prior.manifest=await verifyIntegrity(prior.path);
        const priorPf=await preflight(prior.path);
        if(!priorPf.passed)fail("rollback LKG preflight failed");
        const occupying=await listenerPid(7690);
        if(occupying){
          const identity=await productionIdentity();
          if(!identity||identity.pid!==occupying)fail("rollback refused unknown 7690 listener");
          await stopExact(identity.pid,7690);
        }
        const rollbackPid=await startRelease(prior,7690,session);
        const rollbackHealth=await waitHealth(7690,prior.manifest.digest,rollbackPid);
        await writeManagedBridgeRecord(prior,rollbackPid,session,rollbackHealth);
        const latest=await store.readState();
        const restored=await store.writeState({...latest,lastKnownGood:priorRecord,pending:null,updatedAt:new Date().toISOString()});
        await event(session,"rollback_succeeded",{digest:prior.manifest.digest,pid:rollbackPid});
        return {result:"ROLLED_BACK",action:"promote",error:clean(error.message),rollbackPid,digest:prior.manifest.digest,circuitBreaker:restored.circuitBreaker};
      }catch(rollbackError){
        await event(session,"rollback_failed",{error:rollbackError.message,originalError:error.message});
        return {result:"FAIL",action:"promote",stage:"rollback",error:clean(error.message),rollbackError:clean(rollbackError.message),pendingPreserved:true,circuitBreaker:failedState.circuitBreaker};
      }
    }
  });
}

const STAGED_PROMOTION_RECEIPT_MAX_AGE_MS=30*60_000;
const STAGED_PROMOTION_CORE_MAX_AGE_MS=10*60_000;
function promotionPhase(){
  const phase=String(process.env.SPIKE_SAFE_BOOT_PROMOTE_PHASE??"full").trim().toLowerCase()||"full";
  if(!["full","start","core","finish"].includes(phase))fail("SPIKE_SAFE_BOOT_PROMOTE_PHASE must be full, start, core, or finish");
  return phase;
}
async function setProductionMaintenance(enabled){
  const {runtimeCall}=await import("../../operator/server.mjs");
  return runtimeCall(ROOT,"maintenance",{enabled:enabled===true});
}
async function stagedPromotionPrecheck(session){
  const receipt=await json(VERIFIED_PATH);
  if(process.env.SPIKE_OPERATOR_EXPECTED_DIGEST&&receipt.digest!==process.env.SPIKE_OPERATOR_EXPECTED_DIGEST)fail("operator selected candidate changed before promotion");
  if(receipt.kind!=="current")fail(`verified receipt kind is not promotable: ${receipt.kind??"unknown"}`);
  const verifiedAt=Date.parse(receipt.verifiedAt??"");
  if(!Number.isFinite(verifiedAt)||Date.now()-verifiedAt>STAGED_PROMOTION_RECEIPT_MAX_AGE_MS)fail("verified candidate receipt is too old for staged promotion; verify the candidate again");
  const release=releaseFromRecord(receipt);
  release.manifest=await verifyIntegrity(release.path);
  if(release.manifest.digest!==receipt.digest)fail("verified receipt no longer matches release");
  const old=await productionIdentity(),oldHealth=await health(7690);
  if(!old||!oldHealth.ok)fail("production is not healthy before promotion");
  if(receipt.productionPid!==old.pid)fail(`production changed since verification: verifiedPid=${receipt.productionPid??"unknown"} currentPid=${old.pid}`);
  const priorState=await store.readState();
  if(priorState.pending)fail("promotion already has a pending transaction; recover it before starting another");
  const priorRecord=priorState.lastKnownGood;
  if(!priorRecord)fail("promotion requires a previous last known good");
  if(oldHealth.healthz?.body?.artifactDigest!==priorRecord.digest)fail(`production artifact drifted from recorded LKG: observed=${oldHealth.healthz?.body?.artifactDigest??"unknown"} recorded=${priorRecord.digest}`);
  const prior=releaseFromRecord(priorRecord);
  prior.manifest=await verifyIntegrity(prior.path);
  const priorPreflight=await preflight(prior.path);
  await event(session,"rollback_target_preflight",{digest:prior.manifest.digest,preflight:priorPreflight});
  if(!priorPreflight.passed)fail("previous last known good preflight failed");
  await event(session,"promotion_verified_receipt_reused",{digest:receipt.digest,verifiedAt:receipt.verifiedAt,productionPid:old.pid,maxAgeMs:STAGED_PROMOTION_RECEIPT_MAX_AGE_MS});
  return {receipt,release,old,oldHealth,priorState,priorRecord,prior};
}
async function rollbackStagedPromotion(failedState,error){
  const pending=validatePendingRecord(failedState.pending);
  const session=pending.sessionId;
  try{
    const previous=releaseFromRecord(pending.previousLastKnownGood);
    previous.manifest=await verifyIntegrity(previous.path);
    const priorPf=await preflight(previous.path);
    if(!priorPf.passed)fail("rollback LKG preflight failed");
    const current=await health(7690);
    if(current.ok&&pendingHealthDecision(pending,current.healthz?.body)==="previous_lkg"){
      const currentPid=await listenerPid(7690);
      if(currentPid)await writeManagedBridgeRecord(previous,currentPid,session,current);
      const latest=await store.readState();
      const restored=await store.writeState({...latest,lastKnownGood:pending.previousLastKnownGood,pending:null,updatedAt:new Date().toISOString()});
      await setProductionMaintenance(false).catch(()=>{});
      await event(session,"rollback_succeeded",{digest:previous.manifest.digest,pid:currentPid,recognized:true});
      return {result:"ROLLED_BACK",action:"promote",error:clean(error.message??error),rollbackPid:currentPid,digest:previous.manifest.digest,circuitBreaker:restored.circuitBreaker};
    }
    const occupying=await listenerPid(7690);
    if(occupying){
      const identity=await productionIdentity();
      if(!identity||identity.pid!==occupying)fail("rollback refused unknown 7690 listener");
      await stopExact(identity.pid,7690);
    }
    const rollbackPid=await startRelease(previous,7690,session);
    const rollbackHealth=await waitHealth(7690,previous.manifest.digest,rollbackPid);
    await writeManagedBridgeRecord(previous,rollbackPid,session,rollbackHealth);
    await setProductionMaintenance(false).catch(()=>{});
    const latest=await store.readState();
    const restored=await store.writeState({...latest,lastKnownGood:pending.previousLastKnownGood,pending:null,updatedAt:new Date().toISOString()});
    await event(session,"rollback_succeeded",{digest:previous.manifest.digest,pid:rollbackPid});
    return {result:"ROLLED_BACK",action:"promote",error:clean(error.message??error),rollbackPid,digest:previous.manifest.digest,circuitBreaker:restored.circuitBreaker};
  }catch(rollbackError){
    await event(session,"rollback_failed",{error:rollbackError.message,originalError:error.message??String(error)}).catch(()=>{});
    return {result:"FAIL",action:"promote",stage:"rollback",error:clean(error.message??error),rollbackError:clean(rollbackError.message),pendingPreserved:true,maintenanceHeld:true,circuitBreaker:failedState.circuitBreaker};
  }
}
async function stagedPromotionStart(session){
  const {receipt,release,old,priorState,priorRecord}=await stagedPromotionPrecheck(session);
  const candidateRecord=releaseRecord(release);
  const startedAt=new Date().toISOString();
  const pending={schemaVersion:PENDING_SCHEMA_VERSION,phase:"prepared",sessionId:session,candidate:candidateRecord,previousLastKnownGood:priorRecord,oldProductionPid:old.pid,startedAt,updatedAt:startedAt};
  let state=await store.writeState({...priorState,pending,updatedAt:startedAt});
  await event(session,"promotion_prepared",{digest:receipt.digest,oldPid:old.pid,previousDigest:priorRecord.digest,staged:true});
  await stopExact(old.pid,7690);
  state=await writePendingPhase(state,state.pending,"old_stopped");
  const newPid=await startRelease(release,7690,session);
  state=await writePendingPhase(state,state.pending,"candidate_started",{candidatePid:newPid});
  const h=await waitHealth(7690,receipt.digest,newPid);
  await setProductionMaintenance(true);
  await writeManagedBridgeRecord(release,newPid,session,h);
  await event(session,"promotion_candidate_staged",{digest:receipt.digest,oldPid:old.pid,newPid,toolCount:h.healthz?.body?.toolCount??null});
  return {result:"PASS",action:"promote-staged",phase:"start",digest:receipt.digest,oldPid:old.pid,newPid,artifactDigestMatch:h.healthz?.body?.artifactDigest===receipt.digest,maintenanceHeld:true,circuitBreaker:state.circuitBreaker};
}
async function stagedPromotionCore(){
  let state=await store.readState();
  const pending=validatePendingRecord(state.pending);
  if(pending.phase==="candidate_core_verified"&&Date.now()-Date.parse(pending.candidateCoreVerifiedAt)<=STAGED_PROMOTION_CORE_MAX_AGE_MS)return {result:"PASS",action:"promote-core",phase:"core",digest:pending.candidate.digest,pid:pending.candidatePid,toolCount:pending.candidateToolCount,maintenanceHeld:true,circuitBreaker:state.circuitBreaker,idempotent:true};
  if(!["candidate_started","candidate_core_verified"].includes(pending.phase))fail(`staged promotion core requires candidate_started or stale candidate_core_verified, got ${pending.phase}`);
  const candidate=releaseFromRecord(pending.candidate);
  candidate.manifest=await verifyIntegrity(candidate.path);
  const current=await health(7690,pending.candidate.digest);
  const currentPid=await listenerPid(7690);
  if(!current.ok||currentPid!==pending.candidatePid)fail(`staged promotion candidate identity mismatch during core verification: expectedPid=${pending.candidatePid} observedPid=${currentPid??"none"}`);
  const surface=await candidateSurfaceAcceptance(candidate,7690,pending.sessionId,{includeBrowser:false});
  if(current.healthz?.body?.toolCount!==surface.expectedToolCount||current.readyz?.body?.toolCount!==surface.expectedToolCount)fail(`production candidate health tool count mismatch: expected=${surface.expectedToolCount} actual=${current.healthz?.body?.toolCount}/${current.readyz?.body?.toolCount}`);
  const verifiedAt=new Date().toISOString();
  state=await writePendingPhase(state,state.pending,"candidate_core_verified",{candidatePid:pending.candidatePid,candidateToolCount:surface.toolCount,candidateCoreVerifiedAt:verifiedAt,candidateAccount:surface.account,candidateProviderRoutes:surface.providerRoutes});
  await event(pending.sessionId,"promotion_candidate_core_verified",{digest:pending.candidate.digest,pid:pending.candidatePid,toolCount:surface.toolCount,account:surface.account,providerRoutes:surface.providerRoutes});
  return {result:"PASS",action:"promote-core",phase:"core",digest:pending.candidate.digest,pid:pending.candidatePid,toolCount:surface.toolCount,maintenanceHeld:true,circuitBreaker:state.circuitBreaker};
}
async function stagedPromotionFinish(){
  let state=await store.readState();
  const pending=validatePendingRecord(state.pending);
  if(!["candidate_core_verified","candidate_verified"].includes(pending.phase))fail(`staged promotion finish requires candidate_core_verified, got ${pending.phase}`);
  const candidate=releaseFromRecord(pending.candidate);
  candidate.manifest=await verifyIntegrity(candidate.path);
  const current=await health(7690,pending.candidate.digest);
  const currentPid=await listenerPid(7690);
  if(!current.ok||currentPid!==pending.candidatePid)fail(`staged promotion candidate identity mismatch during finish: expectedPid=${pending.candidatePid} observedPid=${currentPid??"none"}`);
  let browser=null,browserAttempts=[];
  if(pending.phase==="candidate_core_verified"){
    if(Date.now()-Date.parse(pending.candidateCoreVerifiedAt)>STAGED_PROMOTION_CORE_MAX_AGE_MS){const error=new Error("staged promotion core evidence expired; re-run core verification");error.code="STAGED_CORE_REVERIFY_REQUIRED";throw error;}
    const browserGate=await candidateBrowserAcceptance(7690,pending.sessionId);
    browser=browserGate.browser;
    browserAttempts=browserGate.browserAttempts;
    const expectedToolCount=pending.candidateToolCount;
    if(current.healthz?.body?.toolCount!==expectedToolCount||current.readyz?.body?.toolCount!==expectedToolCount)fail(`production candidate health tool count mismatch: expected=${expectedToolCount} actual=${current.healthz?.body?.toolCount}/${current.readyz?.body?.toolCount}`);
    state=await writePendingPhase(state,state.pending,"candidate_verified",{candidatePid:pending.candidatePid,candidateToolCount:pending.candidateToolCount,candidateBrowserAttempts:browserAttempts,candidateBrowser:browser});
  }else{
    browser=pending.candidateBrowser??null;
    browserAttempts=Array.isArray(pending.candidateBrowserAttempts)?pending.candidateBrowserAttempts:[];
  }
  await writeManagedBridgeRecord(candidate,pending.candidatePid,pending.sessionId,current);
  state=await store.writeState({...state,lastKnownGood:pending.candidate,pending:null,circuitBreaker:closedCircuitBreaker(),updatedAt:new Date().toISOString()});
  await event(pending.sessionId,"promotion_succeeded",{digest:pending.candidate.digest,pid:pending.candidatePid,toolCount:pending.candidateToolCount,browser,browserAttempts,staged:true});
  await setProductionMaintenance(false).catch(()=>{});
  return {result:"PASS",action:"promote-finished",phase:"finish",digest:pending.candidate.digest,newPid:pending.candidatePid,toolCount:pending.candidateToolCount,browser,browserAttempts,artifactDigestMatch:current.healthz?.body?.artifactDigest===pending.candidate.digest,circuitBreaker:state.circuitBreaker};
}
async function promote(){
  const phase=promotionPhase();
  if(phase==="full")return promoteFull();
  return withLock(async()=>{
    const controlSession=randomUUID();
    const gate=await gateOperationalCircuit(controlSession,`promote_${phase}`);
    if(!gate.allowed)return {result:"REFUSED",action:"promote",phase,reason:"circuit_breaker_open",circuitBreaker:gate.state.circuitBreaker};
    try{
      if(phase==="start")return stagedPromotionStart(controlSession);
      if(phase==="core")return stagedPromotionCore();
      return stagedPromotionFinish();
    }catch(error){
      if(error?.code==="STAGED_CORE_REVERIFY_REQUIRED"){
        const currentState=await store.readState();
        return {result:"REFUSED",action:"promote",phase,error:clean(error.message),reason:"core_reverify_required",pendingPreserved:true,maintenanceHeld:true,nextAction:{phase:"core"},circuitBreaker:currentState.circuitBreaker};
      }
      const failed=await recordOperationalFailure(controlSession,`promote_${phase}`,error.message);
      if(failed.pending)return rollbackStagedPromotion(failed,error);
      return {result:"FAIL",action:"promote",phase,error:clean(error.message),productionPreserved:true,circuitBreaker:failed.circuitBreaker};
    }
  });
}
async function adoptLkg(){
  return withLock(async()=>{
    const session=randomUUID();
    const gate=await gateOperationalCircuit(session,"adopt-lkg");
    if(!gate.allowed)return {result:"REFUSED",action:"adopt-lkg",reason:"circuit_breaker_open",circuitBreaker:gate.state.circuitBreaker};
    let state=await store.readState();
    if(!state.lastKnownGood)fail("adopt-lkg requires an initialized last known good");
    const lkgRecord=state.lastKnownGood;
    const lkg=releaseFromRecord(lkgRecord);
    lkg.manifest=await verifyIntegrity(lkg.path);
    const pf=await preflight(lkg.path);
    if(!pf.passed)fail("adopt-lkg LKG preflight failed");
    const old=await productionIdentity();
    const oldHealth=await health(7690);
    if(!old||!oldHealth.ok)fail("production is not healthy before LKG adoption");
    const observedDigest=oldHealth.healthz?.body?.artifactDigest??null;
    await event(session,"adoption_started",{lkgDigest:lkg.manifest.digest,oldPid:old.pid,observedDigest});
    if(observedDigest===lkg.manifest.digest){
      await writeManagedBridgeRecord(lkg,old.pid,session,oldHealth);
      state=await closeOperationalCircuit(session,"adopt_lkg_already_active");
      return {result:"PASS",action:"already-adopted",pid:old.pid,digest:lkg.manifest.digest,circuitBreaker:state.circuitBreaker};
    }
    if(observedDigest!==null)fail(`refusing first LKG adoption over different managed digest: ${observedDigest}`);

    await validateCandidate(lkg,session);
    let newPid=null;
    let oldStopped=false;
    try{
      if(process.env.SPIKE_OPERATOR_BOOTSTRAP==="1")await legacyIdle(ROOT);
      await stopExact(old.pid,7690);
      oldStopped=true;
      await event(session,"adoption_old_stopped",{oldPid:old.pid});
      newPid=await startRelease(lkg,7690,session);
      const h=await waitHealth(7690,lkg.manifest.digest,newPid);
      const surface=await candidateSurfaceAcceptance(lkg,7690);
      if(h.healthz?.body?.toolCount!==surface.expectedToolCount||h.readyz?.body?.toolCount!==surface.expectedToolCount)fail(`adopted LKG tool count mismatch: expected=${surface.expectedToolCount} actual=${h.healthz?.body?.toolCount}/${h.readyz?.body?.toolCount}`);
      await writeManagedBridgeRecord(lkg,newPid,session,h);
      state=await store.readState();
      state=await store.writeState({...state,lastKnownGood:lkgRecord,pending:null,circuitBreaker:closedCircuitBreaker(),updatedAt:new Date().toISOString()});
      await event(session,"adoption_succeeded",{oldPid:old.pid,newPid,digest:lkg.manifest.digest,toolCount:surface.toolCount,browser:surface.browser,browserOfflineAdvisory:surface.browserOfflineAdvisory});
      return {result:"PASS",action:"lkg-adopted",oldPid:old.pid,newPid,digest:lkg.manifest.digest,artifactDigestMatch:h.healthz?.body?.artifactDigest===lkg.manifest.digest,toolCount:surface.toolCount,browser:surface.browser,browserOfflineAdvisory:surface.browserOfflineAdvisory,circuitBreaker:state.circuitBreaker};
    }catch(error){
      const failedState=await recordOperationalFailure(session,"adopt_lkg",error.message);
      if(!oldStopped){
        await event(session,"adoption_failed_production_preserved",{error:error.message,oldPid:old.pid});
        return {result:"FAIL",action:"adopt-lkg",stage:"stop-old",error:clean(error.message),productionPreserved:true,circuitBreaker:failedState.circuitBreaker};
      }
      if(newPid&&processAlive(newPid)){
        try{await stopExact(newPid,7690);}catch(stopError){await event(session,"adoption_failed_candidate_stop_error",{error:stopError.message,pid:newPid});}
      }
      try{
        const restored=await startMutableProduction(session);
        await event(session,"adoption_rolled_back_to_mutable",{error:error.message,pid:restored.pid});
        return {result:"ROLLED_BACK",action:"adopt-lkg",error:clean(error.message),rollbackPid:restored.pid,circuitBreaker:failedState.circuitBreaker};
      }catch(rollbackError){
        await event(session,"adoption_rollback_failed",{error:rollbackError.message,originalError:error.message});
        return {result:"FAIL",action:"adopt-lkg",stage:"rollback",error:clean(error.message),rollbackError:clean(rollbackError.message),circuitBreaker:failedState.circuitBreaker};
      }
    }
  });
}
async function ensure(){
  return withLock(async()=>{
    let s=await store.readState();
    if(s.pending)return reconcilePending(s);

    const h=await health(7690);
    if(h.ok){
      const pid=(await productionIdentity(h)).pid;
      if(!s.lastKnownGood)return {result:"FAIL",action:"healthy-without-lkg",pid,reason:"no_last_known_good"};
      const observedDigest=h.healthz?.body?.artifactDigest??null;
      if(observedDigest===s.lastKnownGood.digest){
        let managed=null;
        try{managed=await json(path.join(BRIDGE_STATE_ROOT,"bridge-7690.pid.json"));}catch{}
        if(managed?.pid!==pid||managed?.artifactDigest!==observedDigest){
          const lkg=releaseFromRecord(s.lastKnownGood);
          const session=randomUUID();
          await writeManagedBridgeRecord(lkg,pid,null,h);
          await event(session,"healthy_receipt_reconciled",{pid,digest:observedDigest,previousPid:managed?.pid??null});
          return {result:"PASS",action:"unchanged-reconciled",pid,digest:observedDigest};
        }
        return {result:"PASS",action:"unchanged",pid,digest:observedDigest};
      }
      return {result:"FAIL",action:"healthy-non-lkg",pid,observedDigest,expectedDigest:s.lastKnownGood.digest,reason:"explicit_adopt_lkg_required"};
    }

    if(!s.lastKnownGood)fail("no last known good; fail closed");
    const lkg=releaseFromRecord(s.lastKnownGood);
    lkg.manifest=await verifyIntegrity(lkg.path);
    const session=randomUUID(),pf=await preflight(lkg.path);
    await event(session,"ensure_lkg_preflight",{digest:lkg.manifest.digest,preflight:pf});
    if(!pf.passed)fail("LKG preflight failed");

    const existing=await listenerPid(7690);
    if(existing){
      const identity=await productionIdentity();
      if(!identity||identity.pid!==existing)fail("7690 occupied by unknown process");
      await stopExact(identity.pid,7690);
    }

    await cleanupOrphanedPinnedCodex(session);
    const pid=await startRelease(lkg,7690,session);
    let startedHealth;
    try{
      startedHealth=await waitHealth(7690,lkg.manifest.digest,pid);
    }catch(error){
      const finalHealth=await health(7690,lkg.manifest.digest);
      const listener=await listenerPid(7690);
      if(finalHealth.ok&&listener===pid){
        startedHealth=finalHealth;
        await event(session,"ensure_late_ready_reconciled",{pid,digest:lkg.manifest.digest});
      }else{
        let cleanupError=null;
        if(processAlive(pid)||listener===pid){
          try{await stopSpawnedProcessTree(pid,7690);}catch(stopError){cleanupError=stopError.message;}
        }
        await event(session,"ensure_lkg_start_failed",{pid,digest:lkg.manifest.digest,error:error.message,cleanupError});
        if(cleanupError)fail(`${error.message}; cleanup failed: ${cleanupError}`);
        throw error;
      }
    }
    await writeManagedBridgeRecord(lkg,pid,session,startedHealth);
    await event(session,"ensure_lkg_started",{pid,digest:lkg.manifest.digest});
    return {result:"PASS",action:"lkg-started",pid,digest:lkg.manifest.digest};
  });
}
async function restartStable(){
  return withLock(async()=>{
    const state=await store.readState();if(!state.lastKnownGood||state.pending)fail("stable restart requires an idle verified LKG");
    const release=releaseFromRecord(state.lastKnownGood);release.manifest=await verifyIntegrity(release.path);
    const pf=await preflight(release.path);if(!pf.passed)fail("stable restart preflight failed");
    const old=await productionIdentity(),h=await health(7690);
    if(!old||!h.ok||h.healthz?.body?.artifactDigest!==release.manifest.digest)fail("stable restart identity mismatch; use ensure for recovery");
    const session=randomUUID();await event(session,"operator_restart_started",{pid:old.pid,digest:release.manifest.digest});
    await stopExact(old.pid,7690);
    const pid=await startRelease(release,7690,session),next=await waitHealth(7690,release.manifest.digest,pid);
    await writeManagedBridgeRecord(release,pid,session,next);await event(session,"operator_restart_completed",{pid,digest:release.manifest.digest});
    return {result:"PASS",action:"restart",oldPid:old.pid,pid,digest:release.manifest.digest};
  });
}
async function status(){const s=await store.readState(),h=await health(7690),pid=await listenerPid(7690);let identity=false;if(pid)try{identity=Boolean(await productionIdentity());}catch{}let integrity=false;if(s.lastKnownGood)try{await verifyIntegrity(releaseFromRecord(s.lastKnownGood).path);integrity=true;}catch{}const observedDigest=h.healthz?.body?.artifactDigest??null;const lkgActive=Boolean(s.lastKnownGood&&integrity&&observedDigest===s.lastKnownGood.digest);return {result:h.ok&&pid&&identity&&lkgActive?"PASS":"FAIL",pid,healthy:h.ok,identity,lkgIntegrity:integrity,lkgActive,observedDigest,expectedDigest:s.lastKnownGood?.digest??null,lastKnownGood:s.lastKnownGood,circuitBreaker:s.circuitBreaker,healthz:h.healthz?.body,readyz:h.readyz?.body};}
export async function main(argv=process.argv.slice(2)){if(argv.length!==1||!ACTIONS.has(argv[0]))fail(`usage: ${[...ACTIONS].join("|")}`);await mkdir(STATE_ROOT,{recursive:true});await mkdir(LOG_ROOT,{recursive:true});switch(argv[0]){case"init-seed":return initSeed();case"verify":return verifyCurrent();case"fault-test":return faultTest();case"promote":return withOperatorMaintenance(ROOT,()=>promote(),{allowLegacy:process.env.SPIKE_OPERATOR_BOOTSTRAP==="1"});case"restart":return withOperatorMaintenance(ROOT,()=>restartStable());case"adopt-lkg":return adoptLkg();case"ensure":return ensure();case"status":return status();}}
if(path.resolve(process.argv[1]||"")===fileURLToPath(import.meta.url))main().then(x=>{console.log(JSON.stringify(clean(x),null,2));if(x?.result!=="PASS")process.exitCode=1;}).catch(e=>{console.error(JSON.stringify({result:"FAIL",error:clean(e.message)}));process.exitCode=1;});

