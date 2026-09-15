// Codex Gate — real end-to-end validation of the CodexProvider wrapper.
//
// Boots an in-process Codexless runtime (same lane/env as production), then
// exercises the generic provider contract against the REAL Codex App Server:
// probe / models / usage / start / status / send / cancel / card.
//
// Run from the repository with production-like env (CODEX_BIN,
// CODEXLESS_DEFAULT_CWD, ...). Prints one JSON verdict object.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const { createCodexlessRuntime } = await import(pathToFileURL(path.join(srcDir, "codexless-runtime.mjs")).href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TERMINAL = new Set(["idle", "completed", "failed", "interrupted", "rejected", "lost"]);

function verdict(name, ok, details = {}) {
  return { name, ok: ok === true, ...details };
}

async function waitForTerminal(provider, ref, { timeoutMs = 240_000, intervalMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await provider.status(ref);
    const status = last?.status ?? last?.agentState?.status ?? null;
    if (typeof status === "string" && TERMINAL.has(status)) return { status, payload: last };
    await sleep(intervalMs);
  }
  return { status: `timeout(last=${last?.status ?? "unknown"})`, payload: last };
}

const results = [];
function record(name, ok, details = {}) {
  const entry = verdict(name, ok, details);
  results.push(entry);
  console.error(`[gate] ${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(details).slice(0, 400)}`);
  return entry;
}

const runtime = await createCodexlessRuntime({ mode: "public" });
try {
  runtime.createServer(); // populate the tool-handler sink captured by CodexProvider
  const registry = runtime.agentProviders;
  const provider = registry.require("codex");

  // 1) registry surface
  record("registry.ids", JSON.stringify(registry.ids()) === JSON.stringify(["codex"]), { ids: registry.ids() });

  // 2) probe (real App Server reachability, no model turn)
  const probe = await provider.probe();
  record("probe", probe?.ok === true, { probe });

  // 3) models (real catalog)
  const models = await provider.models({ limit: 50 });
  const modelCount = Array.isArray(models?.models) ? models.models.length : 0;
  record("models", modelCount > 0, { modelCount, first: models?.models?.[0]?.model ?? null });

  // 4) usage / quota (real snapshot; UNKNOWN is acceptable, guessing is not)
  const usage = await provider.usage();
  record("usage", Boolean(usage) && !("error" in usage && usage.error), { usage });

  // 5) start → terminal → result contains marker
  const marker1 = "BRIDGE_GATE_OK_P7X";
  const started = await provider.start({
    task: `Reply with exactly this single token and nothing else: ${marker1}`,
    options: { reasoningEffort: "low" },
  });
  const ref1 = started.ref;
  record("start.returns-ref", typeof ref1 === "string" && ref1.length > 0, {
    ref: ref1,
    startStatus: started.status ?? null,
    consentRequired: started.consentRequired ?? null,
    taskId: started.taskId ?? null,
  });

  let ref1effective = ref1;
  if (!ref1effective && started.taskId) {
    // Call Approval required: commit the prepared task, then read the ref.
    const committed = await provider.commit(started.taskId);
    ref1effective = committed.ref;
    record("start.commit", typeof ref1effective === "string", { ref: ref1effective, status: committed.status ?? null });
  }
  if (ref1effective) {
    const terminal1 = await waitForTerminal(provider, ref1effective);
    const text = JSON.stringify(terminal1.payload);
    record("start.terminal", TERMINAL.has(terminal1.status), { status: terminal1.status });
    record("start.result-marker", text.includes(marker1), { marker: marker1, status: terminal1.status });

    // 6) card (Task Card state; honest UNKNOWN when the surface lacks the tool)
    try {
      const card = await provider.card(ref1effective);
      const honestUnknown = card?.status === "UNKNOWN" && typeof card?.reason === "string";
      record("card", Boolean(card) && (!card.error || honestUnknown), { cardStatus: card?.status ?? null, reason: card?.reason ?? null });
    } catch (error) {
      record("card", false, { error: error.message });
    }

    // 7) send/continue on the same thread
    const marker2 = "BRIDGE_GATE_CONT_Q3M";
    const sent = await provider.send(ref1effective, `Reply with exactly this single token and nothing else: ${marker2}`, { reasoningEffort: "low" });
    let sentTaskId = sent?.taskId ?? null;
    record("send.accepted", !sent?.error, { status: sent.status ?? null, taskId: sentTaskId, consentRequired: sent.consentRequired ?? null });
    if (sentTaskId) {
      const committedSend = await provider.commit(sentTaskId);
      record("send.commit", !committedSend?.error, { status: committedSend.status ?? null });
    }
    const terminal2 = await waitForTerminal(provider, ref1effective);
    const text2 = JSON.stringify(terminal2.payload);
    record("send.terminal", TERMINAL.has(terminal2.status), { status: terminal2.status });
    record("send.result-marker", text2.includes(marker2), { marker: marker2, status: terminal2.status });
  }

  // 8) cancel: start a longer task and cancel it while running
  try {
    const long = await provider.start({
      task: "Without asking anything, write a very long (at least 1500 words) factual summary of the history of mechanical calculators.",
      options: { reasoningEffort: "low" },
    });
    let longRef = long.ref;
    if (!longRef && long.taskId) longRef = (await provider.commit(long.taskId)).ref;
    if (typeof longRef === "string" && longRef) {
      await sleep(3_000);
      const cancelled = await provider.cancel(longRef);
      const cancelStatus = cancelled?.status ?? cancelled?.agentState?.status ?? null;
      record("cancel", !cancelled?.error, { cancelStatus, ref: longRef, error: cancelled?.error ?? null });
      const terminal3 = await waitForTerminal(provider, longRef, { timeoutMs: 60_000 });
      record("cancel.terminal", TERMINAL.has(terminal3.status), { status: terminal3.status });
    } else {
      record("cancel", false, { error: "no ref for long task", startPayloadKeys: Object.keys(long ?? {}) });
    }
  } catch (error) {
    record("cancel", false, { error: error.message });
  }
} finally {
  await runtime.close().catch(() => {});
}

const pass = results.filter((r) => r.ok).length;
const summary = {
  gate: "codex-provider",
  result: pass === results.length ? "PASS" : "FAIL",
  passed: pass,
  total: results.length,
  results,
};
console.log(JSON.stringify(summary, null, 2));
if (summary.result !== "PASS") process.exitCode = 1;
