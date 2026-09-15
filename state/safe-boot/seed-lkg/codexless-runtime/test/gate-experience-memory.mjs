import "./gate-experience-memory-acceptance.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ExperienceMemory, MemoryStore, MemoryRetriever, MemoryGuard, buildMemoryCapsule, redactSecrets } from "../src/memory/index.mjs";
import { PUBLIC_TOOL_ALLOWLIST } from "../src/surface-contracts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(here, "..");
const gateRoot = path.join(runtimeRoot, "tmp", `experience-memory-gate-${process.pid}-${Date.now()}`);
fs.mkdirSync(gateRoot, { recursive: true });
const dbPath = path.join(gateRoot, "experience.db");
const results = [];
function record(name, ok, details = {}) {
  const row = { name, ok: ok === true, ...details };
  results.push(row);
  console.error(`[memory-gate] ${row.ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(details).slice(0, 600)}`);
}
function p(values, percentile) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1))] ?? 0;
}

let memory = new ExperienceMemory({ dbPath, seed: true });
try {
  record("sqlite.available", memory.enabled && memory.status().fts5 === true, { status: memory.status() });

  const seedStatus = memory.status();
  record("seed.verified", (seedStatus.statuses?.active ?? 0) >= 10, { active: seedStatus.statuses?.active ?? 0 });
  const coreCapsule = buildMemoryCapsule({ coreItems: memory.retriever.core(), items: [] });
  record("core.le600", coreCapsule.coreTokens <= 600, { coreTokens: coreCapsule.coreTokens, coreIds: coreCapsule.coreIds });

  const projectA = "F:\\Projects\\A";
  const projectB = "F:\\Projects\\B";
  memory.store.putItem({ id: "iso_project_a", kind: "lesson", scope: "project", project: projectA, title: "Alpha project only", summary: "ALPHA_PROJECT_ONLY_SENTINEL", confidence: "verified", status: "active", tags: ["sentinel"] });
  memory.store.putItem({ id: "iso_machine", kind: "lesson", scope: "machine", title: "Machine shared", summary: "MACHINE_SHARED_SENTINEL", confidence: "verified", status: "active", tags: ["sentinel"] });
  memory.store.putItem({ id: "iso_zcode", kind: "lesson", scope: "provider", provider: "zcode", title: "ZCode only", summary: "ZCODE_ONLY_SENTINEL", confidence: "verified", status: "active", tags: ["sentinel"] });

  const aItems = memory.retrieve({ task: "ALPHA_PROJECT_ONLY_SENTINEL MACHINE_SHARED_SENTINEL", project: projectA, provider: "codex" }).items;
  const bItems = memory.retrieve({ task: "ALPHA_PROJECT_ONLY_SENTINEL MACHINE_SHARED_SENTINEL", project: projectB, provider: "codex" }).items;
  record("isolation.project", aItems.some((x) => x.id === "iso_project_a") && !bItems.some((x) => x.id === "iso_project_a") && bItems.some((x) => x.id === "iso_machine"), {
    a: aItems.map((x) => x.id).slice(0, 12), b: bItems.map((x) => x.id).slice(0, 12),
  });
  const zItems = memory.retrieve({ task: "ZCODE_ONLY_SENTINEL", provider: "zcode", project: projectA }).items;
  const cItems = memory.retrieve({ task: "ZCODE_ONLY_SENTINEL", provider: "codex", project: projectA }).items;
  record("isolation.provider", zItems.some((x) => x.id === "iso_zcode") && !cItems.some((x) => x.id === "iso_zcode"), { z: zItems.map((x) => x.id), codex: cItems.map((x) => x.id) });

  memory.store.putItem({ id: "fact_v1", kind: "fact", scope: "machine", title: "Browser extension state", summary: "browser extension broken", confidence: "verified", status: "active" });
  memory.store.putItem({ id: "fact_v2", kind: "fact", scope: "machine", title: "Browser extension state", summary: "browser extension repaired", confidence: "verified", status: "active" });
  const v1 = memory.store.getItem("fact_v1");
  const v2 = memory.store.getItem("fact_v2");
  const normalFacts = memory.retrieve({ task: "Browser extension state repaired", provider: "codex" }).items;
  record("supersession", v1?.status === "superseded" && Boolean(v1?.valid_to) && v2?.status === "active" && normalFacts.some((x) => x.id === "fact_v2") && !normalFacts.some((x) => x.id === "fact_v1"), { v1: v1?.status, v2: v2?.status, retrieved: normalFacts.map((x) => x.id) });

  const retryJob = "retry_gate_job";
  const first = memory.guard.onFailure({ jobKey: retryJob, provider: "codex", tool: "mcp", message: "httpx fetch localhost returned HTTP 502 through proxy" });
  const beforeSecond = memory.guard.beforeAttempt({ jobKey: retryJob, signature: first.signature, approach: "restart MCP server repeatedly", provider: "codex", tool: "mcp" });
  record("retry-prevention.known-memory", first.signature === "localhost_httpx_502" && beforeSecond.blocked === true && beforeSecond.recommendedFix?.includes("NO_PROXY") && beforeSecond.reason === "verified_do_not_retry", { first, beforeSecond });

  const unknownJob = "retry_gate_unknown";
  const f1 = memory.guard.onFailure({ jobKey: unknownJob, provider: "codex", tool: "example", message: "CustomStableFailure magic frobnicator" });
  const f2 = memory.guard.onFailure({ jobKey: unknownJob, provider: "codex", tool: "example", message: "CustomStableFailure magic frobnicator PID=998877" });
  const beforeThird = memory.guard.beforeAttempt({ jobKey: unknownJob, signature: f2.signature, approach: "same operation", provider: "codex", tool: "example" });
  record("retry-prevention.local-count", f1.signature === f2.signature && beforeThird.blocked === true && beforeThird.reason === "same_signature_count_gte_2", { signature1: f1.signature, signature2: f2.signature, beforeThird });

  const secret = ["sk", "proj", "THISISASECRETVALUE123456"].join("-");
  const redactedItem = memory.store.putItem({ id: "secret_test", kind: "lesson", scope: "machine", title: `credential ${secret}`, summary: `Authorization: ${["Bearer", "secret-bearer-token-12345"].join(" ")}\npassword=hunter2`, confidence: "medium", status: "candidate" });
  const secretJson = JSON.stringify(redactedItem);
  record("security.secret-redaction", !secretJson.includes("THISISASECRETVALUE") && !secretJson.includes("hunter2") && !secretJson.includes("secret-bearer-token"), { redacted: secretJson.slice(0, 280) });

  const oldIso = new Date(Date.now() - 40 * 86400000).toISOString();
  memory.store.putItem({ id: "retention_candidate", kind: "lesson", scope: "machine", title: "old candidate", summary: "expire me", confidence: "low", status: "candidate", created_at: oldIso, expires_at: new Date(Date.now() - 1_000).toISOString() });
  memory.store.addEvidence("retention_candidate", { id: "old_evidence", event_type: "failure", created_at: oldIso, expires_at: new Date(Date.now() - 1_000).toISOString(), error_excerpt: "old" });
  const compact = memory.compact();
  record("retention.cleanup", memory.store.getItem("retention_candidate")?.status === "expired" && memory.store.getEvidence("retention_candidate").length === 0 && compact.evidenceDeleted >= 1, { compact });

  const baseCount = memory.status().items;
  const insertStart = performance.now();
  memory.store.transaction(() => {
    const stmt = memory.store.db.prepare(`
      INSERT INTO memory_items (
        id,kind,scope,provider,project,tool,title,trigger,summary,failed_approach,root_cause,verified_fix,do_not_retry,error_signature,tags_json,confidence,status,core,evidence_ref,valid_from,valid_to,created_at,updated_at,last_verified_at,last_used_at,use_count,expires_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const now = new Date().toISOString();
    for (let i = 0; i < 10000; i += 1) {
      const needle = i % 500 === 0 ? " common-memory-task-widget " : "";
      stmt.run(`perf_${i}`, "lesson", "machine", null, null, null, `Historical lesson ${i}${needle}`, "routine failure", `bounded memory item ${i}${needle}`, "old path", "known cause", `verified fix ${i}`, null, null, '["perf"]', "verified", "active", 0, "gate:10k", now, null, now, now, now, null, i % 11, null);
    }
  });
  // Direct bulk insert bypasses FTS triggers only if a SQLite build behaves unusually; triggers normally keep it synchronized.
  const insertMs = performance.now() - insertStart;
  const countAfter = memory.status().items;
  record("10k.inserted", countAfter >= baseCount + 10000, { baseCount, countAfter, insertMs: Number(insertMs.toFixed(2)) });

  const latencies = [];
  let lastRetrieval = null;
  for (let i = 0; i < 60; i += 1) {
    const t0 = performance.now();
    lastRetrieval = memory.retrieve({ task: "common-memory-task-widget", provider: "codex", project: projectB, limit: 24 });
    latencies.push(performance.now() - t0);
  }
  const perfP50 = p(latencies, 0.50);
  const perfP95 = p(latencies, 0.95);
  const capsule = memory.buildCapsule({ task: "common-memory-task-widget", provider: "codex", project: projectB, current_errors: ["localhost_httpx_502"] });
  record("10k.retrieval-bounded", lastRetrieval.items.length <= 24 && capsule.itemCount <= 6 && capsule.runbookCount <= 1 && capsule.tokens <= 1800 && !capsule.text.includes("perf_9999"), {
    retrievalCount: lastRetrieval.items.length, capsuleItems: capsule.itemCount, capsuleTokens: capsule.tokens, p50: Number(perfP50.toFixed(3)), p95: Number(perfP95.toFixed(3)), dbBytes: fs.statSync(dbPath).size,
  });

  const persistedId = memory.store.putItem({ id: "restart_persist", kind: "lesson", scope: "machine", title: "Restart persist", summary: "RESTART_PERSIST_SENTINEL", confidence: "verified", status: "active" }).id;
  const sharedRef = "agent_shared_ref_restart_gate";
  const aJob = memory.beforeAgentStart({ task: "restart scoped job", provider: "codex-a", project: "C:\\Projects\\SpikeBridgeFixture", tools: ["codex-a.agent_start"] });
  const bJob = memory.beforeAgentStart({ task: "restart scoped job", provider: "codex-b", project: "C:\\Projects\\SpikeBridgeFixture", tools: ["codex-b.agent_start"] });
  memory.bindJobRef(aJob.jobKey, sharedRef);
  memory.bindJobRef(bJob.jobKey, sharedRef);
  memory.onProviderFailure({ jobKey: aJob.jobKey, provider: "codex-a", project: "C:\\Projects\\SpikeBridgeFixture", tool: "codex-a.agent_send", payload: { errorCode: "PERSIST_GATE", error: "same persisted failure" } });
  memory.onProviderFailure({ jobKey: bJob.jobKey, provider: "codex-b", project: "C:\\Projects\\SpikeBridgeFixture", tool: "codex-b.agent_send", payload: { errorCode: "PERSIST_GATE", error: "same persisted failure" } });
  const dbBytesBefore = fs.statSync(dbPath).size;
  memory.close();
  memory = new ExperienceMemory({ dbPath, seed: true });
  const persisted = memory.store.getItem(persistedId);
  record("restart.persistence", persisted?.summary === "RESTART_PERSIST_SENTINEL" && memory.status().items >= countAfter, { persisted: persisted?.id, count: memory.status().items, dbBytesBefore, dbBytesAfter: fs.statSync(dbPath).size });

  const recoveredA = memory.jobForRef("codex-a", sharedRef);
  const recoveredB = memory.jobForRef("codex-b", sharedRef);
  const aBeforeRetry = memory.beforeAgentSend({ ref: sharedRef, message: "retry A", provider: "codex-a", project: "C:\\Projects\\SpikeBridgeFixture", tools: ["codex-a.agent_send"], approach: "same operation" });
  const bBeforeRetry = memory.beforeAgentSend({ ref: sharedRef, message: "retry B", provider: "codex-b", project: "C:\\Projects\\SpikeBridgeFixture", tools: ["codex-b.agent_send"], approach: "same operation" });
  memory.onProviderFailure({ jobKey: recoveredA?.jobKey, provider: "codex-a", project: "C:\\Projects\\SpikeBridgeFixture", tool: "codex-a.agent_send", payload: { errorCode: "PERSIST_GATE", error: "same persisted failure" } });
  const aBlockedAfterSecond = memory.beforeAgentSend({ ref: sharedRef, message: "retry A again", provider: "codex-a", project: "C:\\Projects\\SpikeBridgeFixture", tools: ["codex-a.agent_send"], approach: "same operation" });
  const bStillIndependent = memory.beforeAgentSend({ ref: sharedRef, message: "retry B again", provider: "codex-b", project: "C:\\Projects\\SpikeBridgeFixture", tools: ["codex-b.agent_send"], approach: "same operation" });
  record("restart.operational-state", recoveredA?.jobKey === aJob.jobKey && recoveredB?.jobKey === bJob.jobKey && recoveredA?.jobKey !== recoveredB?.jobKey && aBeforeRetry.guard.blocked === false && bBeforeRetry.guard.blocked === false && aBlockedAfterSecond.guard.blocked === true && aBlockedAfterSecond.guard.reason === "same_signature_count_gte_2" && bStillIndependent.guard.blocked === false, {
    recoveredA: recoveredA?.jobKey, recoveredB: recoveredB?.jobKey, aBlocked: aBlockedAfterSecond.guard.reason ?? null, bBlocked: bStillIndependent.guard.blocked,
  });

  record("public-tools.unchanged", PUBLIC_TOOL_ALLOWLIST.length === 48 && !PUBLIC_TOOL_ALLOWLIST.some((name) => name.includes("memory")), { publicRuntimeTools: PUBLIC_TOOL_ALLOWLIST.length, overlayExpected: PUBLIC_TOOL_ALLOWLIST.length + 2 });
  record("redactor.direct", !redactSecrets("cookie: SID=abcdef123456\napi_key=ABCDEFG123456789").includes("abcdef123456"), {});

  const summary = {
    gate: "experience-memory-v1",
    result: results.every((x) => x.ok) ? "PASS" : "FAIL",
    passed: results.filter((x) => x.ok).length,
    total: results.length,
    metrics: {
      p50Ms: Number(perfP50.toFixed(3)),
      p95Ms: Number(perfP95.toFixed(3)),
      capsuleTokens: capsule.tokens,
      capsuleItems: capsule.itemCount,
      coreTokens: coreCapsule.coreTokens,
      dbBytes: fs.statSync(dbPath).size,
      fts5: memory.status().fts5,
    },
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.result !== "PASS") process.exitCode = 1;
} finally {
  try { memory?.close(); } catch {}
}

