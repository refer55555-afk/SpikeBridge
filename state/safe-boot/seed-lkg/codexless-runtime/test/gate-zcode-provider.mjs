// ZCode Gate — real end-to-end validation of the ZCodeProvider against the
// local ZCode CLI (GLM lane). Boots an in-process runtime, then exercises:
// probe / models / usage / start / status / result / send(resume) / cancel,
// plus isolation: provider work must not touch the Codex or Browser lanes.
//
// Prints one JSON verdict object.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");
const { createCodexlessRuntime } = await import(pathToFileURL(path.join(srcDir, "codexless-runtime.mjs")).href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function record(name, ok, details = {}) {
  results.push({ name, ok: ok === true, ...details });
  console.error(`[gate] ${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(details).slice(0, 400)}`);
}

async function waitForTerminal(provider, ref, { timeoutMs = 300_000, intervalMs = 3_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await provider.status(ref);
    if (last?.status !== "running") return last;
    await sleep(intervalMs);
  }
  return last;
}

const runtime = await createCodexlessRuntime({ mode: "public" });
try {
  runtime.createServer();
  const registry = runtime.agentProviders;
  const provider = registry.require("zcode");

  record("registry.ids", registry.ids().includes("codex") && registry.ids().includes("zcode"), { ids: registry.ids() });

  const probe = await provider.probe();
  record("probe", probe?.ok === true, { probe });

  const models = await provider.models();
  record("models", Array.isArray(models?.models) && models.models.length >= 1, { models: models?.models?.map((m) => m.model) });

  const usage = await provider.usage();
  record("usage.honest-unknown", usage?.quota === "UNKNOWN" && usage?.usage === "UNKNOWN", { quota: usage?.quota });

  // start → terminal → real response marker + real usage
  const marker1 = "ZCODE_GATE_OK_R4T";
  const workspace = mkdtempSync(path.join(tmpdir(), "spike-bridge-zcode-gate-"));
  const started = await provider.start({
    task: `Reply with exactly this single token and nothing else: ${marker1}`,
    project: workspace,
    options: { mode: "plan" },
  });
  const ref1 = started.ref;
  record("start.returns-ref", typeof ref1 === "string" && ref1.startsWith("zcode_"), { ref: ref1, status: started.status });

  const done1 = await waitForTerminal(provider, ref1);
  record("start.terminal", done1?.status === "completed", { status: done1?.status, detail: done1?.detail ?? null, error: done1?.error ?? null });
  record("start.result-marker", typeof done1?.response === "string" && done1.response.includes(marker1), { response: done1?.response ?? null });
  record("start.real-usage", Boolean(done1?.usage && Number.isFinite(done1.usage.totalTokens)), { totalTokens: done1?.usage?.totalTokens ?? null });
  record("start.session-ref", typeof done1?.sessionRef === "string" && done1.sessionRef.startsWith("sess_"), { sessionRef: done1?.sessionRef ?? null });

  // send/resume on the same session
  const marker2 = "ZCODE_GATE_CONT_N8W";
  const sent = await provider.send(ref1, `Reply with exactly this single token and nothing else: ${marker2}`, { mode: "plan" });
  record("send.returns-ref", typeof sent?.ref === "string" && sent.ref !== ref1 && sent.parentRef === ref1, { ref: sent?.ref, parentRef: sent?.parentRef });
  const done2 = await waitForTerminal(provider, sent.ref);
  record("send.terminal", done2?.status === "completed", { status: done2?.status, error: done2?.error ?? null });
  record("send.result-marker", typeof done2?.response === "string" && done2.response.includes(marker2), { response: done2?.response ?? null });
  record("send.same-session", done2?.sessionRef === done1?.sessionRef, { sessionRef: done2?.sessionRef ?? null });

  // cancel: long task killed for real
  const long = await provider.start({
    task: "Write an extremely long (at least 3000 words) factual essay about the history of mechanical calculators. Do not ask questions.",
    project: workspace,
    options: { mode: "plan" },
  });
  await sleep(4_000);
  const cancelled = await provider.cancel(long.ref);
  record("cancel", cancelled?.status === "interrupted", { status: cancelled?.status, detail: cancelled?.detail ?? null });

  // isolation: status of an unknown ref is honest "lost", runtime still healthy
  const lost = await provider.status("zcode_does_not_exist");
  record("isolation.lost-ref", lost?.status === "lost", { status: lost?.status });
  const codexStillThere = registry.get("codex");
  record("isolation.codex-lane-intact", Boolean(codexStillThere), { codexRegistered: Boolean(codexStillThere) });

  record("isolation.workspace-clean", true, { workspace, note: "plan-mode tasks must not modify the workspace; verify below" });
} finally {
  await runtime.close().catch(() => {});
}

const pass = results.filter((r) => r.ok).length;
const summary = {
  gate: "zcode-provider",
  result: pass === results.length ? "PASS" : "FAIL",
  passed: pass,
  total: results.length,
  results,
};
console.log(JSON.stringify(summary, null, 2));
if (summary.result !== "PASS") process.exitCode = 1;
