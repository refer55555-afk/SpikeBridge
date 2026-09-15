// Mac Gate — end-to-end validation of the MacProvider against a REAL
// bridge instance (bootstrap/mac-worker-b/bridge.mjs) driven by a simulated
// worker (the role the Mac daemon plays), then an honest probe against the
// production bridge configuration.
//
// The simulated worker registers, heartbeats, claims /worker/next and posts
// /worker/result with usage + session ids — exactly the Mac daemon's protocol.
//
// Prints one JSON verdict object.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHmac, randomBytes } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");
const bridgePath = path.resolve(here, "..", "..", "..", "..", "..", "bootstrap", "mac-worker-b", "bridge.mjs");
const { createAgentProviderRegistry } = await import(pathToFileURL(path.join(srcDir, "agent-provider-registry.mjs")).href);
const { createMacProvider } = await import(pathToFileURL(path.join(srcDir, "agent-providers", "mac.mjs")).href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function record(name, ok, details = {}) {
  results.push({ name, ...details, ok: ok === true });
  console.error(`[gate] ${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(details).slice(0, 400)}`);
}

const stateDir = mkdtempSync(path.join(tmpdir(), "spike-mac-gate-"));
try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
mkdirSync(stateDir, { recursive: true });
const PORT = 18766 + Math.floor(Math.random() * 500);
const bridgeBase = `http://127.0.0.1:${PORT}`;

// Test pairing secret (never touches the production secret file).
const secret = randomBytes(32).toString("hex");
writeFileSync(path.join(stateDir, "pairing.secret"), `${secret}\n`, { mode: 0o600 });

const bridge = spawn(process.execPath, [bridgePath], {
  env: { ...process.env, SPIKE_WORKER_B_STATE_DIR: stateDir, SPIKE_WORKER_B_PORT: String(PORT) },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let bridgeReady = false;
bridge.stdout.on("data", (chunk) => {
  if (String(chunk).includes("listening")) bridgeReady = true;
});
bridge.stderr.on("data", (chunk) => console.error(`[bridge] ${String(chunk).trim().slice(0, 200)}`));
for (let i = 0; i < 50 && !bridgeReady; i += 1) await sleep(100);

const taskBearer = createHmac("sha256", secret).update("task-api-v1").digest("hex");

// Simulated Mac worker: register + heartbeat + claim + result.
const workerState = { running: true, done: false };
const registrationFacts = { host: "gate-mac-sim", platform: "darwin", arch: "arm64", servicePort: 8767, codexVersion: "0.153.0-gate", capabilities: ["codex"] };
async function workerLoop() {
  const auth = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
  // Heartbeats must re-carry the registration facts: the bridge re-sanitizes
  // the heartbeat body, so an empty body would blank the stored facts.
  await fetch(`${bridgeBase}/register`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(registrationFacts),
  }).then((r) => console.error(`[worker] register -> ${r.status}`)).catch((e) => console.error(`[worker] register failed: ${e.message}`));
  let heartbeats = 0;
  while (workerState.running) {
    if (heartbeats++ % 2 === 0) {
      await fetch(`${bridgeBase}/heartbeat`, { method: "POST", headers: auth, body: JSON.stringify(registrationFacts) }).catch(() => {});
    }
    let task = null;
    try {
      const response = await fetch(`${bridgeBase}/worker/next`, { headers: auth });
      if (heartbeats < 4 || heartbeats % 20 === 0) console.error(`[worker] claim #${heartbeats} -> ${response.status}`);
      task = response.status === 200 ? await response.json() : null;
    } catch (e) {
      if (heartbeats < 8) console.error(`[worker] claim failed: ${e.message}`);
    }
    if (task?.taskId) {
      const isLong = /ESSAY/i.test(task.task ?? "");
      await sleep(isLong ? 30_000 : 1_500); // simulate remote execution
      if (!workerState.running) break;
      const completed = workerState.cancelledIds?.has?.(task.taskId) ? false : true;
      await fetch(`${bridgeBase}/worker/result`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          taskId: task.taskId,
          state: completed ? "completed" : "failed",
          lastMessage: completed ? `GATE_RESULT_FOR ${task.taskId}` : "cancelled by gate",
          sessionIds: [`sess_gate_${task.taskId.slice(-8)}`],
          resumeSessionId: `sess_gate_${task.taskId.slice(-8)}`,
          usage: { totalTokens: 1234, inputTokens: 1000, outputTokens: 234 },
          exitCode: completed ? 0 : 1,
        }),
      }).then(async (r) => {
        console.error(`[worker] result POST ${task.taskId} -> ${r.status} ${await r.text()}`);
      }).catch((e) => console.error(`[worker] result POST failed: ${e.message}`));
    }
    await sleep(300);
  }
  workerState.done = true;
}
const workerPromise = workerLoop();

const gateProvider = createMacProvider({ bridgeBase, secretFile: path.join(stateDir, "pairing.secret") });
const fakeProvider = (id) => ({
  id,
  displayName: id,
  capabilities: {},
  async probe() { return { ok: true, provider: id }; },
  async start() { return { provider: id, ref: `${id}_fixture` }; },
  async status(ref) { return { provider: id, ref, status: "completed" }; },
  async send(ref) { return { provider: id, ref, status: "completed" }; },
  async cancel(ref) { return { provider: id, ref, status: "completed" }; },
});
const registry = createAgentProviderRegistry({ providers: [fakeProvider("codex"), fakeProvider("codex-a"), fakeProvider("codex-b"), fakeProvider("zcode"), gateProvider] });
try {
  record("registry.ids", ["codex", "codex-a", "codex-b", "mac", "zcode"].every((id) => registry.ids().includes(id)), { ids: registry.ids() });
  record("registry.mac-registered", Boolean(registry.get("mac")));

  let probe = null;
  for (let i = 0; i < 30; i += 1) {
    probe = await gateProvider.probe();
    if (probe?.ok === true && probe?.workerReady === true) break;
    await sleep(100);
  }
  record("probe.bridge-live", probe?.ok === true && probe?.workerReady === true, { probeOk: probe?.ok, workerReady: probe?.workerReady });

  const models = await gateProvider.models();
  record("models", models?.models?.[0]?.model === "gpt-5.6-luna", { models: models?.models });

  // start → queued → running → completed with usage + session
  const started = await gateProvider.start({
    task: "Reply with exactly: GATE_OK",
    project: "C:\\Projects\\SpikeBridgeFixture",
  });
  const ref1 = started.ref;
  record("start.queued", started?.status === "queued" && ref1?.startsWith("mac_"), { ref: ref1, status: started?.status });

  let status = null;
  for (let i = 0; i < 60; i += 1) {
    status = await gateProvider.status(ref1);
    if (["completed", "failed", "lost"].includes(status?.status)) break;
    await sleep(500);
  }
  record("start.terminal", status?.status === "completed", { status: status?.status, raw: JSON.stringify(status?.raw)?.slice(0, 300), cardRaw: JSON.stringify(status?.card)?.slice(0, 300) });
  record("start.session", typeof status?.sessionRef === "string" && status.sessionRef.startsWith("sess_gate_"), { sessionRef: status?.sessionRef });
  record("start.usage", status?.usage?.totalTokens === 1234, { usage: status?.usage });
  record("start.model", status?.model === null, { model: status?.model, note: "bridge card model stays unproven until the Mac daemon dispatches" });

  // send/resume → new ref, resumed session
  const sent = await gateProvider.send(ref1, "Continue: reply GATE_CONT");
  record("send.new-ref", typeof sent?.ref === "string" && sent.ref !== ref1, { ref: sent?.ref });
  let status2 = null;
  for (let i = 0; i < 60; i += 1) {
    status2 = await gateProvider.status(sent.ref);
    if (["completed", "failed", "lost"].includes(status2?.status)) break;
    await sleep(500);
  }
  record("send.terminal", status2?.status === "completed", { status: status2?.status });
  record("send.resume-carried", Boolean(sent) && status2?.sessionRef?.startsWith("sess_gate_"), { sessionRef: status2?.sessionRef });

  // cancel honesty: unsupported by protocol, reported not faked
  const cancel = await gateProvider.cancel(ref1);
  record("cancel.honest-unsupported", cancel?.status === "UNKNOWN" && cancel?.code === "AGENT_PROVIDER_CANCEL_UNSUPPORTED", { code: cancel?.code });

  const usage = await gateProvider.usage();
  record("usage.honest-unknown", usage?.quota === "UNKNOWN" && usage?.usage === "UNKNOWN", {});

  // lost ref honesty
  const lost = await gateProvider.status("mac_missing");
  record("lost-ref", lost?.status === "lost", { status: lost?.status });
} finally {
  workerState.running = false;
  await sleep(300);
  try { bridge.kill(); } catch {}
  await sleep(300);
  try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
}

// Production-config honesty probe: bridge expected OFFLINE right now; the
// provider must report ok:false with a reason, never fake readiness.
try {
  const { createMacProvider } = await import(pathToFileURL(path.join(srcDir, "agent-providers", "mac.mjs")).href);
  const prodProvider = createMacProvider({});
  const prodProbe = await prodProvider.probe();
  results.push({
    name: "prod-probe.honest",
    ok: typeof prodProbe?.ok === "boolean",
    prodProbeOk: prodProbe?.ok,
    reason: prodProbe?.reason ?? null,
    note: "prodProbeOk=true means the production bridge+Mac are live; false is honest while offline",
  });
  console.error(`[gate] INFO prod-probe ok=${prodProbe?.ok} reason=${prodProbe?.reason ?? "n/a"}`);
} catch (error) {
  results.push({ name: "prod-probe.honest", ok: false, error: error.message });
}

const pass = results.filter((r) => r.ok).length;
const summary = {
  gate: "mac-provider",
  result: pass === results.length ? "PASS" : "FAIL",
  passed: pass,
  total: results.length,
  results,
};
console.log(JSON.stringify(summary, null, 2));
if (summary.result !== "PASS") process.exitCode = 1;
