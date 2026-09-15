// spike.agent_* Gate — validates the fixed generic agent tool group over the
// REAL HTTP MCP surface (default http://127.0.0.1:7690/mcp).
//
// Requires the bridge overlay running with the agent provider layer:
//   tools/list must expose exactly the allowlist + spike.agent_* group.
// Exercises: zcode real task (start/show/send/cancel), codex equivalence,
// unknown provider fail-closed, mac honest-unsupported cancel, card shape.

const BASE = process.env.SPIKE_GATE_MCP_BASE ?? "http://127.0.0.1:7690/mcp";

async function callTool(name, args, timeoutMs = 240_000) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const response = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let result = null;
  if (text.startsWith("{")) {
    result = JSON.parse(text).result;
  } else {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data: ")) continue;
      const value = JSON.parse(line.slice(6));
      if (value.error) throw new Error(`RPC error: ${JSON.stringify(value.error)}`);
      if (value.result) result = value.result;
    }
  }
  if (!result) throw new Error(`no result for ${name}`);
  return result;
}

async function listTools() {
  const response = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let result = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const value = JSON.parse(line.slice(6));
    if (value.result) result = value.result;
  }
  return result?.tools?.map((tool) => tool.name) ?? [];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function record(name, ok, details = {}) {
  results.push({ name, ok: ok === true, ...details });
  console.error(`[gate] ${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(details).slice(0, 300)}`);
}

// 1) surface
const names = await listTools();
const spikeTools = ["spike.agent_start", "spike.agent_status", "spike.agent_send", "spike.agent_cancel"];
record("surface.count-50", names.length === 50, { count: names.length });
record("surface.spike-group", spikeTools.every((name) => names.includes(name)), { spikeTools: spikeTools.filter((name) => names.includes(name)) });
record("surface.retired-show-absent", !names.includes("spike.agent_show"), {});

// 2) unknown provider fails closed
const unknown = await callTool("spike.agent_start", { provider: "does-not-exist", task: "x" });
record("unknown-provider", unknown?.isError === true && unknown?.structuredContent?.errorCode === "AGENT_PROVIDER_UNKNOWN", {
  errorCode: unknown?.structuredContent?.errorCode,
});

// 3) mac honest unsupported cancel (no bridge contact needed)
const wbCancel = await callTool("spike.agent_cancel", { provider: "mac", ref: "wb_gate_probe" });
record("mac.cancel-honest", wbCancel?.structuredContent?.status === "UNKNOWN" && !wbCancel?.isError, {
  status: wbCancel?.structuredContent?.status,
});
const wbCard = wbCancel?.structuredContent?.card;
record("card.mac-shape", wbCard?.provider === "mac" && ["provider", "ref", "model", "status", "durationMs", "usage", "quota", "task", "result", "error"].every((key) => key in wbCard), {
  cardKeys: Object.keys(wbCard ?? {}),
});

// 4) zcode real task through spike.agent_start
const marker1 = "SPIKE_AGENT_ZCODE_OK";
const started = await callTool("spike.agent_start", {
  provider: "zcode",
  task: `Reply with exactly this single token and nothing else: ${marker1}`,
  options: { mode: "plan" },
});
const ref1 = started?.structuredContent?.ref;
record("zcode.start-ref", typeof ref1 === "string" && ref1.startsWith("zcode_"), { ref: ref1 });
record("zcode.start-card", started?.structuredContent?.card?.provider === "zcode", { cardProvider: started?.structuredContent?.card?.provider });

let shown = null;
for (let i = 0; i < 80; i += 1) {
  shown = await callTool("spike.agent_status", { provider: "zcode", ref: ref1 });
  const status = shown?.structuredContent?.status;
  if (status && status !== "running") break;
  await sleep(2_000);
}
record("zcode.show-terminal", shown?.structuredContent?.status === "completed", { status: shown?.structuredContent?.status });
record("zcode.marker", String(shown?.structuredContent?.response ?? "").includes(marker1), {});
const card1 = shown?.structuredContent?.card;
record("zcode.card-filled", card1?.model === "glm-5.3-flash" && Number.isFinite(card1?.usage?.totalTokens) && card1?.quota === "UNKNOWN", {
  model: card1?.model, totalTokens: card1?.usage?.totalTokens, quota: card1?.quota,
});

// 5) zcode continue through spike.agent_send
const marker2 = "SPIKE_AGENT_ZCODE_CONT";
const sent = await callTool("spike.agent_send", { provider: "zcode", ref: ref1, message: `Reply with exactly this single token and nothing else: ${marker2}`, options: { mode: "plan" } });
const ref2 = sent?.structuredContent?.ref;
record("zcode.send-ref", typeof ref2 === "string" && ref2 !== ref1, { ref: ref2 });
let shown2 = null;
for (let i = 0; i < 80; i += 1) {
  shown2 = await callTool("spike.agent_status", { provider: "zcode", ref: ref2 });
  const status = shown2?.structuredContent?.status;
  if (status && status !== "running") break;
  await sleep(2_000);
}
record("zcode.send-terminal", shown2?.structuredContent?.status === "completed", { status: shown2?.structuredContent?.status });
record("zcode.send-marker", String(shown2?.structuredContent?.response ?? "").includes(marker2), {});

// 6) zcode cancel through spike.agent_cancel
const longStart = await callTool("spike.agent_start", {
  provider: "zcode",
  task: "Write an extremely long (at least 3000 words) factual essay about the history of mechanical calculators. Do not ask questions.",
  options: { mode: "plan" },
});
await sleep(3_000);
const cancelled = await callTool("spike.agent_cancel", { provider: "zcode", ref: longStart?.structuredContent?.ref });
record("zcode.cancel", cancelled?.structuredContent?.status === "interrupted", { status: cancelled?.structuredContent?.status });

// 7) codex equivalence through spike.agent_start (real Codex, tiny task)
const codexStart = await callTool("spike.agent_start", {
  provider: "codex",
  task: "Reply with exactly this single token and nothing else: SPIKE_AGENT_CODEX_OK",
  options: { reasoningEffort: "low", invocationRationale: "spike.agent gate equivalence check" },
});
const codexRef = codexStart?.structuredContent?.ref;
record("codex.start-ref", typeof codexRef === "string" && codexRef.startsWith("agent_"), { ref: codexRef });
if (codexRef) {
  let codexShown = null;
  for (let i = 0; i < 90; i += 1) {
    codexShown = await callTool("spike.agent_status", { provider: "codex", ref: codexRef });
    const status = codexShown?.structuredContent?.status;
    if (status && !["starting", "running", "awaitingApproval"].includes(status)) break;
    await sleep(2_000);
  }
  record("codex.terminal", ["completed", "idle", "failed", "interrupted"].includes(codexShown?.structuredContent?.status), { status: codexShown?.structuredContent?.status });
  record("codex.marker", JSON.stringify(codexShown?.structuredContent ?? {}).includes("SPIKE_AGENT_CODEX_OK"), {});
  const codexCard = codexShown?.structuredContent?.card;
  record("codex.card-shape", codexCard?.provider === "codex" && codexCard?.ref === codexRef, { provider: codexCard?.provider });
} else {
  record("codex.start-ref", false, { payload: JSON.stringify(codexStart?.structuredContent ?? {}).slice(0, 200) });
}

const pass = results.filter((entry) => entry.ok).length;
const summary = { gate: "spike-agent-tools", result: pass === results.length ? "PASS" : "FAIL", passed: pass, total: results.length, results };
console.log(JSON.stringify(summary, null, 2));
if (summary.result !== "PASS") process.exitCode = 1;
