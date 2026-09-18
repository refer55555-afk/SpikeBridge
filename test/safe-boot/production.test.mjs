import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SafeBootStore } from "../../runtime/safe-boot/safe-boot.mjs";
import {
  ROOT,
  RELEASES_ROOT,
  breakerAfterFailure,
  breakerGateDecision,
  closedCircuitBreaker,
  candidateBrowserStatusAccepted,
  candidateBrowserStatusRetryable,
  frozenDepsForPackage,
  runtimeDependencyProbes,
  main,
  pendingHealthDecision,
} from "../../runtime/safe-boot/spike-home-production.g3.mjs";

test("production adapter rejects non-canonical actions", async()=>{await assert.rejects(main([]),/usage:/);await assert.rejects(main(["verify","extra"]),/usage:/);await assert.rejects(main(["arbitrary"]),/usage:/);});
test("legacy production entrypoint delegates operational main to G3",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.mjs"),"utf8");assert.match(s,/import\("\.\/spike-home-production\.g3\.mjs"\)/);assert.match(s,/return canonicalMain\(argv\)/);});
test("candidate and production ports are fixed",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8");assert.match(s,/\[7690,7691\]\.includes\(port\)/);assert.match(s,/listenerPid\(7691\)/);assert.equal(RELEASES_ROOT,path.join(ROOT,"state","safe-boot","releases"));});
test("Safe-Boot supplies an explicit workspace ceiling for trusted Bridge projects",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8"),body=s.slice(s.indexOf("function runtimeEnv("),s.indexOf("async function startRelease"));assert.match(body,/CODEXLESS_PROFILE:\":workspace\"/);assert.match(body,/CODEXLESS_DEFAULT_CWD:ROOT/);});
test("reviewed candidate freezes reviewed housekeeping instead of dirty working-tree plugin",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8"),body=s.slice(s.indexOf("async function freeze("),s.indexOf("async function sourceWithRuntimeConfig"));assert.match(body,/reviewedHousekeeping=path\.join\(source,\"plugins\",\"housekeeping\"\)/);assert.match(body,/housekeepingSource=await exists\(reviewedHousekeeping\)\?reviewedHousekeeping:path\.join\(ROOT,\"plugins\",\"housekeeping\"\)/);});
test("verify can reuse an explicitly selected immutable release without re-freezing",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8"),candidate=s.slice(s.indexOf("async function verificationCandidate"),s.indexOf("function run(")),verify=s.slice(s.indexOf("async function verifyCurrent"),s.indexOf("async function faultTest"));assert.match(candidate,/SPIKE_SAFE_BOOT_VERIFY_DIGEST/);assert.match(candidate,/verifyIntegrity\(releasePath\)/);assert.match(candidate,/\^\[a-f0-9\]\{64\}\$/);assert.match(verify,/verifyRelease\(await verificationCandidate\(\),\"current\"\)/);});
test("verify supports crash-visible staged start core finish and safe abort without weakening final receipt",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8"),stage=s.slice(s.indexOf("async function stageCandidateVerification"),s.indexOf("async function lockOwnerIsActive")),verify=s.slice(s.indexOf("async function verifyCurrent"),s.indexOf("async function faultTest"));assert.match(s,/VERIFY_PENDING_PATH/);assert.match(stage,/candidate_staged/);assert.match(stage,/candidateSurfaceAcceptance\(release,7691,pending\.sessionId,\{includeBrowser:false\}\)/);assert.match(stage,/candidateBrowserAcceptance\(7691,pending\.sessionId\)/);assert.match(stage,/candidate_core_verified/);assert.match(stage,/production changed during staged candidate validation/);assert.match(stage,/atomicJson\(VERIFIED_PATH,receipt\)/);assert.match(stage,/async function abortCandidateVerification\(\)/);assert.match(stage,/listenerPid\(7691\)/);assert.match(stage,/stopExact\(pending\.candidatePid,7691\)/);assert.match(stage,/clearVerifyPending\(\)/);assert.match(stage,/candidate_verify_aborted/);assert.match(verify,/SPIKE_SAFE_BOOT_VERIFY_PHASE/);assert.match(verify,/phase===\"start\"/);assert.match(verify,/phase===\"core\"/);assert.match(verify,/phase===\"finish\"/);assert.match(verify,/phase===\"abort\"/);assert.match(verify,/coreCandidateVerification\(\)/);assert.match(verify,/finishCandidateVerification\(\)/);assert.match(verify,/abortCandidateVerification\(\)/);});
test("frozen runtime includes 0.1.2 PDF construction dependencies",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8");for(const dep of ["@napi-rs/canvas","pdfjs-dist"])assert.match(s,new RegExp(dep.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));assert.match(s,/pdfjs-dist\/legacy\/build\/pdf\.mjs/);});
test("release dependency contracts are package-driven across 0.1.1 and 0.1.2",()=>{const oldPkg={dependencies:{"@modelcontextprotocol/node":"2.0.0","@modelcontextprotocol/server":"2.0.0","@openai/codex":"0.147.0","zod":"4.4.3"}},newPkg={dependencies:{...oldPkg.dependencies,"@napi-rs/canvas":"1.0.8","pdfjs-dist":"6.3.289"}};const oldFrozen=frozenDepsForPackage(oldPkg),newFrozen=frozenDepsForPackage(newPkg),oldProbes=runtimeDependencyProbes(oldPkg),newProbes=runtimeDependencyProbes(newPkg);assert.equal(oldFrozen.includes("@napi-rs/canvas"),false);assert.equal(oldFrozen.includes("pdfjs-dist"),false);assert.equal(oldProbes.includes("@napi-rs/canvas"),false);assert.equal(oldProbes.includes("pdfjs-dist/legacy/build/pdf.mjs"),false);assert.equal(newFrozen.includes("@napi-rs/canvas"),true);assert.equal(newFrozen.includes("pdfjs-dist"),true);assert.equal(newProbes.includes("@napi-rs/canvas"),true);assert.equal(newProbes.includes("pdfjs-dist/legacy/build/pdf.mjs"),true);for(const required of ["@modelcontextprotocol/server","@modelcontextprotocol/node","@modelcontextprotocol/core","@hono/node-server","zod"])assert.ok(oldFrozen.includes(required)&&newFrozen.includes(required));});
test("candidate gate requires exact release-derived MCP surface and Browser availability",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8");assert.match(s,/PUBLIC_TOOL_ALLOWLIST/);assert.match(s,/OVERLAY_TOOL_NAMES/);assert.match(s,/candidateSurfaceAcceptance\(release,7691,session\)/);assert.match(s,/candidate MCP tool contract mismatch/);assert.doesNotMatch(s,/names\.length!==44/);assert.doesNotMatch(s,/names\.length!==46/);assert.match(s,/codex\.browser_status/);assert.match(s,/candidateBrowserStatusAccepted/);assert.match(s,/current_chrome_skill_unavailable/);});
test("candidate provider probe accepts honest zcode missing-ref error",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8"),body=s.slice(s.indexOf("providerProbe(23,\"spike.agent_status\",\"zcode\""),s.indexOf("const macCard="));assert.match(body,/!providerProbes\.zcode\.isError/);assert.match(body,/providerProbes\.zcode\.value\?\.provider!==\"zcode\"/);assert.match(body,/providerProbes\.zcode\.value\?\.status!==\"lost\"/);assert.match(body,/typeof providerProbes\.zcode\.value\?\.error!==\"string\"/);assert.match(body,/candidate zcode missing-ref contract failed/);});
test("candidate Agent Card contract is release-derived and keeps single UI ownership",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8"),body=s.slice(s.indexOf("async function candidateSurfaceAcceptance"),s.indexOf("const providerProbe",s.indexOf("async function candidateSurfaceAcceptance")));assert.match(body,/spike-agent-card-ui\.mjs/);assert.match(body,/SPIKE_AGENT_CARD_URI/);assert.match(body,/SPIKE_AGENT_CARD_COMPAT_URIS/);assert.match(body,/start metadata does not match the frozen canonical resource/);assert.match(body,/spike\.agent_status/);assert.match(body,/retired public spike\.agent_show must remain absent/);assert.match(body,/must remain data-only without App template metadata/);assert.match(body,/byte-identical canonical App HTML/);assert.doesNotMatch(body,/canonical v2/);});
test("candidate start tools require the deny-by-default Agent Delegation Gate",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8"),body=s.slice(s.indexOf("async function candidateSurfaceAcceptance"),s.indexOf("const providerProbe",s.indexOf("async function candidateSurfaceAcceptance")));assert.match(body,/expectedDelegationBases=\["user_requested","capability_required","materially_faster"\]/);assert.match(body,/\["spike\.agent_start","codex\.agent_start"\]/);assert.match(body,/topRequired\.includes\("delegation"\)/);assert.match(body,/delegationRequired\.includes\("basis"\)/);assert.match(body,/delegationRequired\.includes\("rationale"\)/);assert.match(body,/missing the deny-by-default Agent Delegation Gate contract/);});
test("candidate gate requires MCP elicitation approval controls",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8"),body=s.slice(s.indexOf("async function candidateSurfaceAcceptance"),s.indexOf("const cardContractPath"));assert.match(body,/codex\.agent_approve/);assert.match(body,/elicitationContent/);assert.match(body,/mcpServer\/elicitation\/request/);assert.match(body,/codex\.agent_reject/);assert.match(body,/MCP elicitation control contract/);assert.match(body,/MCP elicitation decline contract/);});
test("tunnel tasks have independent recurring watchdog recovery",async t=>{const files=["INSTALL-TUNNEL-ACCOUNT-A-TASK.ps1","INSTALL-TUNNEL-ACCOUNT-B-TASK.ps1"];if(files.some(file=>!existsSync(path.join(ROOT,"scripts","admin",file)))){t.skip("private tunnel task installers are intentionally excluded from the public build");return;}for(const file of files){const s=await readFile(path.join(ROOT,"scripts","admin",file),"utf8");assert.match(s,/New-ScheduledTaskTrigger -AtLogOn/);assert.match(s,/New-ScheduledTaskTrigger -Once/);assert.match(s,/-RepetitionInterval \(New-TimeSpan -Minutes 1\)/);assert.match(s,/-RepetitionDuration \(New-TimeSpan -Days 3650\)/);assert.match(s,/-MultipleInstances IgnoreNew/);assert.match(s,/-Trigger \$triggers/);}});

test("tunnel task owners preserve verified existing runtimes and monitor health after ready",async t=>{
  const files=["RUN-TUNNEL-ACCOUNT-A-TASK.ps1","RUN-TUNNEL-ACCOUNT-B-TASK.ps1"];
  if(files.some(file=>!existsSync(path.join(ROOT,file)))){t.skip("private tunnel task owners are intentionally excluded from the public build");return;}
  for(const file of files){
    const s=await readFile(path.join(ROOT,file),"utf8");
    assert.doesNotMatch(s,/Get-CimInstance Win32_Process/);
    assert.match(s,/Get-Process -Id \$candidatePid/);
    assert.match(s,/adopted-existing/);
    const adoption=s.slice(s.indexOf("  $existingPid=Find-ExistingBRunProcess"),s.indexOf("  if(!(Test-Path -LiteralPath $secretPath))"));
    assert.doesNotMatch(adoption,/Stop-Process|\.Kill\(/);
    assert.match(adoption,/snapshot\.tunnel -eq \$tunnelId/);
    assert.match(adoption,/snapshot\.target -eq \$target/);
    assert.match(s,/\$healthFailures=0;\$healthRestart=\$false/);
    assert.match(s,/Start-Sleep -Seconds 10/);
    assert.match(s,/if\(\$healthFailures -ge 3\)/);
    assert.match(s,/TotalSeconds -ge 30/);
    assert.match(s,/Runtime remained alive but failed exact health verification three consecutive times/);
  }
});
test("candidate Browser accepts the 0.1.2 healthy status contract",()=>{assert.equal(candidateBrowserStatusAccepted({status:"ok",nodeRepl:"ok",chrome:{family:"chrome",name:"Chrome",type:"extension"},chromeSkill:"not_required",connectedBrowsers:[{family:"chrome"}],authState:"site_specific_unknown"}),true);assert.equal(candidateBrowserStatusAccepted({status:"ok",nodeRepl:"ok",chrome:{family:"chrome"},chromeSkill:"ok"}),true);});
test("candidate Browser rejects unavailable or ambiguous/incomplete status",()=>{for(const value of [{status:"unavailable",reason:"chrome_not_connected",nodeRepl:"ok",chromeSkill:"not_required"},{status:"ok",nodeRepl:"unknown",chrome:{family:"chrome"},chromeSkill:"not_required"},{status:"ok",nodeRepl:"ok",chrome:{family:"edge"},chromeSkill:"not_required"},{status:"ok",nodeRepl:"ok",chrome:{family:"chrome"},chromeSkill:"missing"},{status:"ok",nodeRepl:"ok",chrome:{family:"chrome"},chromeSkill:"not_required",reason:"current_chrome_skill_unavailable"}])assert.equal(candidateBrowserStatusAccepted(value),false);});
test("candidate Browser retries only generic read-only runtime errors",()=>{assert.equal(candidateBrowserStatusRetryable({status:"unavailable",reason:"BROWSER_RUNTIME_ERROR",error:"transient runtime"}),true);for(const value of [{status:"unavailable",reason:"chrome_not_connected"},{status:"unavailable",reason:"BROWSER_CHROME_BACKEND_AMBIGUOUS"},{status:"unavailable",reason:"node_repl_unavailable"},{status:"ok",reason:null}])assert.equal(candidateBrowserStatusRetryable(value),false);});
test("candidate Browser bounded retry is exactly one five-second read-only status retry",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8"),body=s.slice(s.indexOf("async function candidateBrowserAcceptance"),s.indexOf("async function candidateSurfaceAcceptance"));assert.match(body,/candidateBrowserStatusRetryable\(browser\)/);assert.match(body,/setTimeout\(resolve,5000\)/);assert.match(body,/readCandidateBrowserStatus\(port,2\)/);assert.match(body,/readCandidateBrowserStatus\(port,3\)/);assert.match(body,/browserAttempts/);});
test("verify and promotion are separate transactions",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8");assert.match(s,/verified-current\.json/);assert.match(s,/promotion_succeeded/);assert.match(s,/rollback_succeeded/);});
test("staged promotion keeps maintenance across start/core and releases only after finish or rollback",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8"),m=await readFile(path.join(ROOT,"runtime","safe-boot","operator-maintenance.mjs"),"utf8"),start=s.slice(s.indexOf("async function stagedPromotionStart"),s.indexOf("async function stagedPromotionCore")),core=s.slice(s.indexOf("async function stagedPromotionCore"),s.indexOf("async function stagedPromotionFinish")),finish=s.slice(s.indexOf("async function stagedPromotionFinish"),s.indexOf("async function promote()")),rollback=s.slice(s.indexOf("async function rollbackStagedPromotion"),s.indexOf("async function stagedPromotionStart"));assert.match(start,/setProductionMaintenance\(true\)/);assert.match(start,/maintenanceHeld:true/);assert.match(core,/maintenanceHeld:true/);assert.match(finish,/setProductionMaintenance\(false\)/);assert.match(rollback,/setProductionMaintenance\(false\)/);assert.match(m,/keepEnabled=result\?\.maintenanceHeld===true/);assert.match(m,/if\(acquired&&!keepEnabled\)await runtimeCall\(root,'maintenance',\{enabled:false\}\)/);});
test("ensure never freezes or promotes working tree",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8"),body=s.slice(s.indexOf("async function ensure()"),s.indexOf("async function status()"));assert.doesNotMatch(body,/freezeCurrent|verifyRelease|lastKnownGood:/);assert.match(body,/action:\"unchanged\"/);});

test("healthy production identity uses health and listener PID before CIM fallback",async()=>{
  const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8");
  const body=s.slice(s.indexOf("async function productionIdentity"),s.indexOf("async function health"));
  assert.match(body,/knownHealth\?\?await health\(7690\)/);
  assert.match(body,/healthPid===pid&&readyPid===pid/);
  assert.match(body,/method:\"health-listener-pid\"/);
  assert.match(body,/return assertOverlayIdentity\(pid,7690\)/);
  assert.doesNotMatch(body,/Get-CimInstance/);
});

test("process identity fallbacks are hard-time-bounded",async()=>{
  const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8");
  const body=s.slice(s.indexOf("async function commandLine"),s.indexOf("async function assertOverlayIdentity"));
  assert.match(body,/OperationTimeoutSec 2/);
  assert.match(body,/\{timeout:5000\}/);
  assert.match(body,/async function processStartedAt/);
});

test("verified Bridge stop terminates its managed process tree but remains identity-bounded",async()=>{
  const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8");
  const body=s.slice(s.indexOf("async function stopSpawnedProcessTree"),s.indexOf("async function event"));
  assert.match(body,/assertOverlayIdentity\(pid,port\)/);
  assert.match(body,/processPath\(pid\)/);
  assert.match(body,/ENTRYPOINT/);
  assert.match(body,/taskkill\.exe/);
  assert.match(body,/\["\/PID",String\(pid\),"\/T","\/F"\]/);
  assert.match(body,/port \$\{port\} is owned by unexpected pid/);
});

test("ensure orphan cleanup is pinned-binary dead-parent bounded and CIM-time-bounded",async()=>{
  const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8");
  const body=s.slice(s.indexOf("async function cleanupOrphanedPinnedCodex"),s.indexOf("async function waitHealth"));
  assert.match(body,/resolvePinnedCodex\(\)/);
  assert.match(body,/ExecutablePath -eq \$expected/);
  assert.match(body,/app-server\\\\s\+--stdio/);
  assert.match(body,/OperationTimeoutSec 2/);
  assert.match(body,/\{timeout:5000\}/);
  assert.match(body,/orphaned_codex_inspection_unavailable/);
  assert.match(body,/processAlive\(parentPid\)\)continue/);
  assert.match(body,/taskkill\.exe/);
  assert.match(body,/\["\/PID",String\(pid\),"\/T","\/F"\]/);
});

test("readiness has a bounded late-ready reconciliation window",async()=>{
  const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8");
  const body=s.slice(s.indexOf("async function waitHealth"),s.indexOf("async function stopSpawnedProcessTree"));
  assert.match(body,/lateGraceMs=15000/);
  assert.match(body,/processAlive\(pid\)/);
  assert.match(body,/late readiness reconciliation/);
  assert.match(body,/const finalHealth=await health\(port,digest\)/);
});

test("ensure reconciles stale healthy receipts and cleans failed spawned runtimes",async()=>{
  const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8");
  const body=s.slice(s.indexOf("async function ensure()"),s.indexOf("async function restartStable"));
  const healthyBranch=body.slice(body.indexOf("if(h.ok){"),body.indexOf("if(!s.lastKnownGood)fail"));
  assert.match(body,/healthy_receipt_reconciled/);
  assert.match(body,/action:\"unchanged-reconciled\"/);
  assert.match(body,/writeManagedBridgeRecord\(lkg,pid,null,h\)/);
  assert.doesNotMatch(healthyBranch,/verifyIntegrity/);
  assert.match(body,/cleanupOrphanedPinnedCodex\(session\)/);
  assert.match(body,/ensure_late_ready_reconciled/);
  assert.match(body,/stopSpawnedProcessTree\(pid,7690\)/);
  assert.match(body,/ensure_lkg_start_failed/);
});

test("stale production lock detects PID reuse without depending on CIM",async()=>{
  const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8");
  const body=s.slice(s.indexOf("async function lockOwnerIsActive"),s.indexOf("async function stateUpdate"));
  assert.match(body,/processAlive\(owner\.pid\)/);
  assert.match(body,/processStartedAt\(owner\.pid\)/);
  assert.match(body,/startedAt<=lockAt/);
  assert.match(body,/commandLine\(owner\.pid\)/);
  assert.match(body,/if\(await lockOwnerIsActive\(owner\)\)fail\("safe-boot production lock is held"\)/);
  assert.match(body,/rm\(LOCK_PATH,\{recursive:true,force:true\}\)/);
});

test("circuit breaker opens on third operational failure",()=>{
  const t=1780000000000;
  const b0=closedCircuitBreaker();
  const b1=breakerAfterFailure(b0,"verify",t);
  assert.equal(b1.state,"closed");
  assert.equal(b1.consecutiveFailures,1);
  const b2=breakerAfterFailure(b1,"verify",t+1);
  assert.equal(b2.state,"closed");
  assert.equal(b2.consecutiveFailures,2);
  const b3=breakerAfterFailure(b2,"verify",t+2);
  assert.equal(b3.state,"open");
  assert.equal(b3.consecutiveFailures,3);
  assert.equal(Date.parse(b3.nextRetryAt),t+30002);
});

test("open circuit refuses before cooldown then becomes half-open",()=>{
  const t=1780000000000;
  let b=closedCircuitBreaker();
  b=breakerAfterFailure(b,"verify",t);
  b=breakerAfterFailure(b,"verify",t+1);
  b=breakerAfterFailure(b,"verify",t+2);
  const blocked=breakerGateDecision(b,t+29999);
  assert.equal(blocked.allowed,false);
  assert.equal(blocked.breaker.state,"open");
  const retry=breakerGateDecision(b,t+30002);
  assert.equal(retry.allowed,true);
  assert.equal(retry.transition,"half_open");
  assert.equal(retry.breaker.state,"half_open");
  const reopened=breakerAfterFailure(retry.breaker,"verify",t+30003);
  assert.equal(reopened.state,"open");
  assert.equal(Date.parse(reopened.nextRetryAt),t+60003);
});

test("closed breaker reset clears all failure state",()=>{
  assert.deepEqual(closedCircuitBreaker(),{
    state:"closed",
    consecutiveFailures:0,
    lastFailureAt:null,
    lastFailureStage:null,
    openedAt:null,
    nextRetryAt:null,
  });
});

test("fault-test is test-only and does not touch operational breaker",async()=>{
  const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8");
  const body=s.slice(s.indexOf("async function faultTest()"),s.indexOf("function releaseFromRecord"));
  assert.match(body,/test_only_fault/);
  assert.doesNotMatch(body,/recordOperationalFailure|gateOperationalCircuit/);
});

test("pending health decision recognizes candidate, previous LKG, mismatch, and down",()=>{
  for(const phase of ["prepared","old_stopped","candidate_started","candidate_core_verified","candidate_verified"]){
    const pending={
      schemaVersion:1,
      phase,
      sessionId:"session-"+phase,
      candidate:{id:"7691",version:"candidate",artifactPath:"C:\\candidate",digest:"candidate-digest"},
      previousLastKnownGood:{id:"7691",version:"previous",artifactPath:"C:\\previous",digest:"previous-digest"},
      oldProductionPid:1234,
      ...(phase.startsWith("candidate_")?{candidatePid:5678}:{}),
      ...(phase==="candidate_core_verified"?{candidateToolCount:50,candidateCoreVerifiedAt:"2026-09-05T00:00:01.000Z"}:{}),
      startedAt:"2026-09-05T00:00:00.000Z",
      updatedAt:"2026-09-05T00:00:01.000Z",
    };
    assert.equal(pendingHealthDecision(pending,{ok:true,artifactDigest:"candidate-digest"}),"candidate");
    assert.equal(pendingHealthDecision(pending,{ok:true,artifactDigest:"previous-digest"}),"previous_lkg");
    assert.equal(pendingHealthDecision(pending,{ok:true,artifactDigest:"other"}),"mismatch");
    assert.equal(pendingHealthDecision(pending,null),"production_down");
  }
});

test("pending promotion phases survive atomic SafeBootStore round-trips",async()=>{
  const base=path.join(ROOT,".tmp","safe-boot-production-tests");
  await mkdir(base,{recursive:true});
  const temp=await mkdtemp(path.join(base,"pending-"));
  try{
    const testStore=new SafeBootStore({rootDir:temp});
    const previous={id:"7691",version:"previous",artifactPath:"C:\\previous",digest:"previous-digest"};
    const candidate={id:"7691",version:"candidate",artifactPath:"C:\\candidate",digest:"candidate-digest"};
    for(const phase of ["prepared","old_stopped","candidate_started","candidate_core_verified","candidate_verified"]){
      const state=await testStore.readState();
      const pending={
        schemaVersion:1,
        phase,
        sessionId:"00000000-0000-4000-8000-000000000001",
        candidate,
        previousLastKnownGood:previous,
        oldProductionPid:1234,
        ...(phase.startsWith("candidate_")?{candidatePid:5678}:{}),
        ...(phase==="candidate_core_verified"?{candidateToolCount:50,candidateCoreVerifiedAt:"2026-09-05T00:00:01.000Z"}:{}),
        startedAt:"2026-09-05T00:00:00.000Z",
        updatedAt:"2026-09-05T00:00:01.000Z",
      };
      await testStore.writeState({...state,lastKnownGood:previous,pending,updatedAt:"2026-09-05T00:00:01.000Z"});
      const reread=await testStore.readState();
      assert.equal(reread.pending.phase,phase);
      assert.deepEqual(reread.pending.candidate,candidate);
      assert.deepEqual(reread.pending.previousLastKnownGood,previous);
    }
  }finally{
    await rm(temp,{recursive:true,force:true});
  }
});

test("ensure reconciles pending before healthy-production shortcut",async()=>{
  const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8");
  const body=s.slice(s.indexOf("async function ensure()"),s.indexOf("async function status()"));
  const pendingIndex=body.indexOf("if(s.pending)return reconcilePending(s)");
  const healthyIndex=body.indexOf("if(h.ok){");
  assert.ok(pendingIndex>=0);
  assert.ok(healthyIndex>=0);
  assert.ok(pendingIndex<healthyIndex);
});

test("promotion persists staged phases in monotonic crash-safe order",async()=>{
  const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8");
  const start=s.slice(s.indexOf("async function stagedPromotionStart"),s.indexOf("async function stagedPromotionCore"));
  const core=s.slice(s.indexOf("async function stagedPromotionCore"),s.indexOf("async function stagedPromotionFinish"));
  const finish=s.slice(s.indexOf("async function stagedPromotionFinish"),s.indexOf("async function promote()"));
  const prepared=start.indexOf('phase:"prepared"');
  const stopOld=start.indexOf("stopExact(old.pid,7690)");
  const oldStopped=start.indexOf('"old_stopped"');
  const startCandidate=start.indexOf("startRelease(release,7690");
  const candidateStarted=start.indexOf('"candidate_started"');
  const waitCandidate=start.indexOf("waitHealth(7690,receipt.digest,newPid)");
  const coreSurface=core.indexOf("candidateSurfaceAcceptance(candidate,7690,pending.sessionId,{includeBrowser:false})");
  const candidateCoreVerified=core.indexOf('writePendingPhase(state,state.pending,"candidate_core_verified"');
  const browserGate=finish.indexOf("candidateBrowserAcceptance(7690,pending.sessionId)");
  const candidateVerified=finish.indexOf('writePendingPhase(state,state.pending,"candidate_verified"');
  const lkgCommit=finish.indexOf("lastKnownGood:pending.candidate");
  for(const value of [prepared,stopOld,oldStopped,startCandidate,candidateStarted,waitCandidate,coreSurface,candidateCoreVerified,browserGate,candidateVerified,lkgCommit]) assert.ok(value>=0);
  assert.ok(prepared<stopOld);
  assert.ok(stopOld<oldStopped);
  assert.ok(oldStopped<startCandidate);
  assert.ok(startCandidate<candidateStarted);
  assert.ok(candidateStarted<waitCandidate);
  assert.ok(coreSurface<candidateCoreVerified);
  assert.ok(browserGate<candidateVerified);
  assert.ok(candidateVerified<lkgCommit);
});

test("pending recovery invalid or mismatched release fails closed",async()=>{
  const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8");
  const body=s.slice(s.indexOf("async function reconcilePending"),s.indexOf("async function verifyRelease"));
  assert.match(body,/pending_release_invalid/);
  assert.match(body,/healthy_production_digest_mismatch/);
  const preserves=(body.match(/pendingPreserved:true/g)||[]).length;
  assert.ok(preserves>=3);
});

test("pending is cleared only after staged candidate finalize or verified LKG recovery",async()=>{
  const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8");
  const body=s.slice(s.indexOf("async function reconcilePending"),s.indexOf("async function verifyRelease"));
  assert.match(body,/candidateSurfaceAcceptance\(candidate,7690,session,\{includeBrowser:false\}\)/);
  assert.match(body,/candidateBrowserAcceptance\(7690,session\)/);
  assert.match(body,/pending_candidate_core_verified/);
  assert.match(body,/pending_candidate_surface_failed/);
  assert.match(body,/pending_candidate_finalized/);
  assert.match(body,/pending_rollback_recognized/);
  assert.match(body,/pending_lkg_restored/);
  assert.match(body,/setProductionMaintenance\(true\)/);
  const invalidBranch=body.slice(body.indexOf("pending_recovery_invalid_release"),body.indexOf("const current=await health(7690)"));
  assert.doesNotMatch(invalidBranch,/store\.writeState|pending:null/);
});
test("promotion revalidates exact MCP and Browser surface on production before LKG commit",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8"),start=s.slice(s.indexOf("async function stagedPromotionStart"),s.indexOf("async function stagedPromotionCore")),core=s.slice(s.indexOf("async function stagedPromotionCore"),s.indexOf("async function stagedPromotionFinish")),finish=s.slice(s.indexOf("async function stagedPromotionFinish"),s.indexOf("async function promote()"));const wait=start.indexOf("waitHealth(7690,receipt.digest,newPid)"),surface=core.indexOf("candidateSurfaceAcceptance(candidate,7690,pending.sessionId,{includeBrowser:false})"),coreVerified=core.indexOf('writePendingPhase(state,state.pending,"candidate_core_verified"'),browser=finish.indexOf("candidateBrowserAcceptance(7690,pending.sessionId)"),verified=finish.indexOf('writePendingPhase(state,state.pending,"candidate_verified"'),commit=finish.indexOf("lastKnownGood:pending.candidate");for(const value of [wait,surface,coreVerified,browser,verified,commit])assert.ok(value>=0);assert.ok(surface<coreVerified);assert.ok(browser<verified);assert.ok(verified<commit);});
test("promotion rejects stale verification or production/LKG drift before cutover",async()=>{const s=await readFile(path.join(ROOT,"runtime","safe-boot","spike-home-production.g3.mjs"),"utf8"),body=s.slice(s.indexOf("async function stagedPromotionPrecheck"),s.indexOf("async function rollbackStagedPromotion"));assert.match(body,/receipt\.kind!==\"current\"/);assert.match(body,/verified candidate receipt is too old for staged promotion/);assert.match(body,/receipt\.productionPid!==old\.pid/);assert.match(body,/production changed since verification/);assert.match(body,/oldHealth\.healthz\?\.body\?\.artifactDigest!==priorRecord\.digest/);assert.match(body,/production artifact drifted from recorded LKG/);});
