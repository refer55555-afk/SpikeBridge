// Durable Job Gate (Phase F) — minimal durability for the generic agent layer.
//
// Codex lane: durable by production design (agentPreviewState.taskPersistence,
// terminal snapshots survive restarts, non-terminal -> LOST/uncertain, never replayed).
// WorkBee lane: durable by construction (bridge queue is files on disk).
// ZCode lane: this gate proves the new persisted job store across a REAL
// provider restart: terminal replay, running->lost, and cross-restart resume.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");
const { createCodexlessRuntime } = await import(pathToFileURL(path.join(srcDir, "codexless-runtime.mjs")).href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function record(name, ok, details = {}) {
  results.push({ name, ok: ok === true, ...details });
  console.error(`[gate] ${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(details).slice(0, 300)}`);
}

const stateRoot = mkdtempSync(path.join(tmpdir(), "spike-bridge-durable-gate-"));
const stateFile = path.join(stateRoot, "zcode-jobs.json");
process.env.SPIKE_BRIDGE_ZCODE_STATE_FILE = stateFile;

async function bootRuntime() {
  const runtime = await createCodexlessRuntime({ mode: "public" });
  runtime.createServer();
  return runtime;
}
async function waitTerminal(provider, ref, { timeoutMs = 300_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await provider.status(ref);
    if (last?.status !== "running") return last;
    await sleep(2_500);
  }
  return last;
}

const marker1 = "DURABLE_GATE_OK";
const runtimeA = await bootRuntime();
try {
  const providerA = runtimeA.agentProviders.require("zcode");
  const started = await providerA.start({
    task: `Reply with exactly this single token and nothing else: ${marker1}`,
    options: { mode: "plan" },
  });
  const done = await waitTerminal(providerA, started.ref);
  record("A.task-completed", done?.status === "completed" && String(done?.response ?? "").includes(marker1), { ref: started.ref, status: done?.status });
  globalThis.__ref = started.ref;
  globalThis.__session = done?.sessionRef;
} finally {
  await runtimeA.close().catch(() => {});
}
const ref = globalThis.__ref;
const sessionA = globalThis.__session;

// Inject a fake "running" record to prove the running->lost recovery branch.
const store = JSON.parse(readFileSync(stateFile, "utf8"));
store.records.push({ ref: "zcode_fake_running", provider: "zcode", status: "running", startedAt: Date.now(), mode: "plan" });
writeFileSync(stateFile, `${JSON.stringify(store, null, 2)}\n`);

// Provider restart: same state file, fresh runtime.
const runtimeB = await bootRuntime();
try {
  const providerB = runtimeB.agentProviders.require("zcode");

  const recovered = await providerB.status(ref);
  record("B.terminal-replayed", recovered?.recovered === true && recovered?.status === "completed", { status: recovered?.status, recovered: recovered?.recovered });
  record("B.session-preserved", recovered?.sessionRef === sessionA, { sessionRef: recovered?.sessionRef });

  const lost = await providerB.status("zcode_fake_running");
  record("B.running-becomes-lost", lost?.status === "lost" && lost?.recovered === true, { status: lost?.status });

  // Cross-restart resume on the same remote session.
  const marker2 = "DURABLE_GATE_CONT";
  const sent = await providerB.send(ref, `Reply with exactly this single token and nothing else: ${marker2}`, { mode: "plan" });
  record("B.send-new-live-ref", typeof sent?.ref === "string" && sent.ref !== ref && sent.parentRef === ref, { ref: sent?.ref });
  const done2 = await waitTerminal(providerB, sent.ref);
  record("B.send-terminal", done2?.status === "completed", { status: done2?.status });
  record("B.send-marker", String(done2?.response ?? "").includes(marker2), {});
  record("B.send-same-session", done2?.sessionRef === sessionA, { sessionRef: done2?.sessionRef });

  // Persisted store contains the new terminal record after the resume.
  const storeAfter = JSON.parse(readFileSync(stateFile, "utf8"));
  const resumedRecord = storeAfter.records.find((entry) => entry.ref === sent.ref);
  record("B.resume-persisted", resumedRecord?.status === "completed" && resumedRecord?.sessionRef === sessionA, { status: resumedRecord?.status ?? null });
} finally {
  await runtimeB.close().catch(() => {});
}

const pass = results.filter((entry) => entry.ok).length;
const summary = { gate: "durable-zcode", result: pass === results.length ? "PASS" : "FAIL", passed: pass, total: results.length, results };
console.log(JSON.stringify(summary, null, 2));
if (summary.result !== "PASS") process.exitCode = 1;
