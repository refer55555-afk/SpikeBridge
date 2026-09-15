// Spike Agent Card UI v4 / state-schema-v1 Gate (offline, no server needed).
//
// Validates, against the REAL shipped modules:
//   1. resource registration contract (uri / mime / prefersBorder)
//   2. SpikeAgentCardStateV1 normalization for Codex / ZCode / Mac and a
//      generic WorkBuddy fixture (unknown provider -> conservative mapping)
//   3. single-mount widget contract: manual Refresh uses data-only spike.agent_status
//   4. widget lifecycle rules: multi-turn start->completed->send->running->
//      completed, terminal sticky per turn, stale/superseded/foreign rejection
//   5. manual-refresh-only UX: no timer polling and no parallel status tool
//   6. widget HTML hygiene: lifecycle logic embedded, textContent-only,
//      no external dependencies, result excerpt bounded to 800 chars
// Prints one JSON verdict object.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const here = new URL(".", import.meta.url);
const { registerSpikeAgentCardResource, normalizeAgentCardState, SPIKE_AGENT_CARD_URI, SPIKE_AGENT_CARD_LEGACY_URI, SPIKE_AGENT_CARD_LEGACY_V2_URI, SPIKE_AGENT_CARD_LEGACY_V1_URI, SPIKE_AGENT_CARD_HTML, acceptAgentCardView, createAgentCardView } = await import(new URL("../src/spike-agent-card-ui.mjs", here).href);
const { renderAgentCard } = await import(new URL("../src/agent-card-view.mjs", here).href);

const results = [];
function record(name, ok, details = {}) {
  results.push({ name, ok: ok === true, ...details });
  console.error(`[gate] ${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(details).slice(0, 300)}`);
}

// 1) resource registration ---------------------------------------------------
const registered = [];
const stubServer = { registerResource(name, uri, options, reader) { registered.push({ name, uri, options, reader }); } };
registerSpikeAgentCardResource(stubServer);
const resource = registered.find((entry) => entry.uri === SPIKE_AGENT_CARD_URI);
const legacyV3Resource = registered.find((entry) => entry.uri === SPIKE_AGENT_CARD_LEGACY_URI);
const legacyV2Resource = registered.find((entry) => entry.uri === SPIKE_AGENT_CARD_LEGACY_V2_URI);
const legacyV1Resource = registered.find((entry) => entry.uri === SPIKE_AGENT_CARD_LEGACY_V1_URI);
let read = null;
let legacyV3Read = null;
let legacyV2Read = null;
let legacyV1Read = null;
if (resource) read = await resource.reader();
if (legacyV3Resource) legacyV3Read = await legacyV3Resource.reader();
if (legacyV2Resource) legacyV2Read = await legacyV2Resource.reader();
if (legacyV1Resource) legacyV1Read = await legacyV1Resource.reader();
record("resource.registered", registered.length === 4 && resource?.uri === "ui://spike/agent-card-v4.html", { uris: registered.map((entry) => entry.uri) });
record("resource.legacy-aliases", legacyV3Resource?.uri === "ui://spike/agent-card-v3.html"
  && legacyV2Resource?.uri === "ui://spike/agent-card-v2.html"
  && legacyV1Resource?.uri === "ui://spike/agent-card-v1.html"
  && legacyV3Read?.contents?.[0]?.text === read?.contents?.[0]?.text
  && legacyV2Read?.contents?.[0]?.text === read?.contents?.[0]?.text
  && legacyV1Read?.contents?.[0]?.text === read?.contents?.[0]?.text,
  { legacyUris: [legacyV3Resource?.uri, legacyV2Resource?.uri, legacyV1Resource?.uri] });
record("resource.mime", read?.contents?.[0]?.mimeType === "text/html;profile=mcp-app"
  && legacyV3Read?.contents?.[0]?.mimeType === "text/html;profile=mcp-app"
  && legacyV2Read?.contents?.[0]?.mimeType === "text/html;profile=mcp-app"
  && legacyV1Read?.contents?.[0]?.mimeType === "text/html;profile=mcp-app", { mime: read?.contents?.[0]?.mimeType });
record("resource.prefersBorder", read?.contents?.[0]?._meta?.ui?.prefersBorder === true
  && legacyV3Read?.contents?.[0]?._meta?.ui?.prefersBorder === true
  && legacyV2Read?.contents?.[0]?._meta?.ui?.prefersBorder === true
  && legacyV1Read?.contents?.[0]?._meta?.ui?.prefersBorder === true);
record("resource.noExternalDeps", !/\bhttps?:\/\//.test(read?.contents?.[0]?.text ?? "") , {});
record("resource.textContentOnly", !/innerHTML/.test(read?.contents?.[0]?.text ?? ""), {});
record("resource.lifecycleEmbedded", ["function agentCardIsTerminalStatus", "function createAgentCardView", "function acceptAgentCardView"].every((marker) => (read?.contents?.[0]?.text ?? "").includes(marker)), {});
record("resource.manual-refresh-only", (read?.contents?.[0]?.text ?? "").includes('callTool("spike.agent_status"')
  && !(read?.contents?.[0]?.text ?? "").includes('callTool("spike.agent_show"')
  && !(read?.contents?.[0]?.text ?? "").includes("function schedulePoll()")
  && !(read?.contents?.[0]?.text ?? "").includes("spike.agent_poll"), {});
const legacyCodexCardSource = await readFile(new URL("../src/agent-card-ui.mjs", here), "utf8");
record("legacy-codex-card.manual-refresh-only", !legacyCodexCardSource.includes("function schedulePoll()")
  && !legacyCodexCardSource.includes("pollTimer = setTimeout"), {});

// 2) Codex normalization ------------------------------------------------------
const NOW = 1_782_000_000_000;
const codexPayload = {
  taskRef: "task_123",
  taskId: "T-a1b2",
  shortTaskId: "T-a1b2",
  agentRef: "agent_abc",
  turnId: "turn-1",
  status: "completed",
  canSend: true,
  pendingApproval: null,
  finalResult: "x".repeat(1200),
  resourceReceipt: {
    tokenUsage: {
      turn: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 40, reasoningOutputTokens: 10, totalTokens: 140 },
      threadTotal: { inputTokens: 300, cachedInputTokens: 180, outputTokens: 120, reasoningOutputTokens: 30, totalTokens: 420 },
      modelContextWindow: 258400,
    },
    accountQuota: {
      observedAt: "2026-09-11T01:00:00Z",
      rateLimits: { status: "ok", limits: [
        { key: "codex", limitName: "5h", planType: "plus", windows: [{ kind: "primary", usedPercent: 40, remainingPercent: 60, resetsAt: 1_782_100_000, windowDurationMins: 300 }] },
        { key: "codex", limitName: "weekly", planType: "plus", windows: [{ kind: "secondary", usedPercent: 10, remainingPercent: 90, resetsAt: 1_782_700_000, windowDurationMins: 10_080 }] },
      ] },
    },
  },
  timing: { startedAt: NOW - 65_000, endedAt: NOW, durationMs: 65_000 },
  execution: { requestedModel: null, resolvedModel: "gpt-6.2", reasoningEffort: "high" },
  latestError: null,
  events: [],
  nextSeq: 7,
  taskCard: { taskRef: "task_123", title: "Fix the login bug", invocationRationale: "user asked for a fix", shortTaskId: "T-a1b2" },
  meteredConsent: { status: "approved", quota: { observedAt: "2026-09-11T00:00:00Z", rateLimits: { status: "ok", limits: [
    { key: "codex", limitName: "5h", planType: "plus", windows: [{ kind: "primary", usedPercent: 30, remainingPercent: 70, resetsAt: 1_782_090_000, windowDurationMins: 300 }] },
  ] } } },
};
const codexCard = normalizeAgentCardState("codex", codexPayload, { now: NOW });
record("codex.canonical-shape", codexCard.schemaVersion === "spike.agent-card.v1"
  && codexCard.provider.id === "codex" && codexCard.provider.label === "Codex A"
  && codexCard.task.taskRef === "task_123" && codexCard.task.agentRef === "agent_abc"
  && codexCard.task.title === "Fix the login bug"
  && codexCard.turn.turnRef === "turn-1" && codexCard.turn.revision === 7
  && codexCard.state.status === "completed" && codexCard.state.terminal === true
  && codexCard.state.elapsedMs === 65_000
  && codexCard.execution.resolvedModel === "gpt-6.2" && codexCard.execution.reasoningEffort === "high",
  { card: codexCard });
record("codex.usage", codexCard.usage.available === true
  && codexCard.usage.cumulative?.totalTokens === 420
  && codexCard.usage.cumulative?.cachedInputTokens === 180
  && codexCard.usage.turn?.totalTokens === 140
  && codexCard.usage.turn?.reasoningOutputTokens === 10
  && codexCard.usage.contextWindow === 258400);
record("codex.quota", codexCard.quota.available === true
  && codexCard.quota.plan === "Plus"
  && codexCard.quota.before?.windows?.length === 1
  && codexCard.quota.after?.windows?.length === 2
  && codexCard.quota.after.windows[0].label.includes("5h")
  && codexCard.quota.after.windows[1].label.includes("weekly")
  && codexCard.quota.after.windows[0].usedPercent === 40
  && codexCard.quota.after.windows[0].remainingPercent === 60,
  { quota: codexCard.quota });
const proQuotaSnapshot = {
  observedAt: "2026-09-11T23:32:15Z",
  rateLimits: { status: "ok", limits: [
    {
      key: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      planType: "pro",
      windows: [
        { kind: "primary", usedPercent: 0, remainingPercent: 100, resetsAt: 1_789_187_542, windowDurationMins: 300 },
        { kind: "secondary", usedPercent: 0, remainingPercent: 100, resetsAt: 1_789_774_342, windowDurationMins: 10_080 },
      ],
    },
    {
      key: "codex",
      limitName: null,
      planType: "pro",
      windows: [
        { kind: "primary", usedPercent: 26, remainingPercent: 74, resetsAt: 1_789_614_970, windowDurationMins: 10_080 },
      ],
    },
  ] },
};
const astraQuotaCard = normalizeAgentCardState("codex-b", {
  status: "running",
  agentRef: "agent_astra_quota",
  execution: { resolvedModel: "gpt-6-astra", reasoningEffort: "xhigh" },
  meteredConsent: { status: "approved", quota: proQuotaSnapshot },
}, { now: NOW });
record("codex.quota-hides-other-model-bucket", astraQuotaCard.quota.plan === "Pro"
  && astraQuotaCard.quota.before?.windows?.length === 1
  && astraQuotaCard.quota.before.windows[0].label === "7d"
  && !astraQuotaCard.quota.before.windows.some((window) => window.label.includes("GPT-5.3-Codex-Spark")),
  { quota: astraQuotaCard.quota });
const sparkQuotaCard = normalizeAgentCardState("codex-b", {
  status: "running",
  agentRef: "agent_spark_quota",
  execution: { resolvedModel: "gpt-5.3-codex-spark", reasoningEffort: "high" },
  meteredConsent: { status: "approved", quota: proQuotaSnapshot },
}, { now: NOW });
record("codex.quota-keeps-current-model-bucket", sparkQuotaCard.quota.before?.windows?.length === 3
  && sparkQuotaCard.quota.before.windows.filter((window) => window.label.includes("GPT-5.3-Codex-Spark")).length === 2
  && sparkQuotaCard.quota.before.windows.some((window) => window.label === "7d"),
  { quota: sparkQuotaCard.quota });
record("codex.account-a", codexCard.account?.slot === "A" && codexCard.account?.label === "Codex A" && codexCard.account?.plan === "Plus", { account: codexCard.account });
const compatCodexCard = renderAgentCard({ provider: "codex-a", ...codexPayload }, codexCard);
record("codex.compat-card-keeps-canonical-data", compatCodexCard.model === "gpt-6.2"
  && compatCodexCard.durationMs === 65_000
  && compatCodexCard.usage?.totalTokens === 140
  && compatCodexCard.quota?.plan === "Plus"
  && compatCodexCard.quota?.after?.windows?.length === 2,
  { compatCard: compatCodexCard });
const codexACard = normalizeAgentCardState("codex-a", codexPayload, { now: NOW });
const codexBCard = normalizeAgentCardState("codex-b", codexPayload, { now: NOW });
record("codex.explicit-a-b-labels", codexACard.provider.label === "Codex A" && codexACard.account?.slot === "A"
  && codexBCard.provider.label === "Codex B" && codexBCard.account?.slot === "B", { a: codexACard.account, b: codexBCard.account });
record("codex.result-excerpt-bound", typeof codexCard.result.summary === "string" && codexCard.result.summary.length <= 800, { length: codexCard.result.summary?.length });
record("codex.capabilities+facts", codexCard.capabilities.cancel === true && codexCard.capabilities.resume === true
  && codexCard.facts.some((fact) => fact.key === "shortTaskId" && fact.value === "T-a1b2"), { facts: codexCard.facts });

const codexConsent = normalizeAgentCardState("codex", {
  status: "consent_required",
  agentRef: null,
  taskId: "T-consent-1",
  shortTaskId: "T-consent-1",
  meteredConsent: { status: "pending", quota: null },
}, { now: NOW });
record("codex.consent-approval", codexConsent.approval.kind === "consent" && codexConsent.approval.taskId === "T-consent-1"
  && codexConsent.approval.approveTool === "codex.agent_commit" && codexConsent.approval.rejectTool === "codex.agent_decline"
  && codexConsent.capabilities.approval === true && codexConsent.state.terminal === false
  && codexConsent.quota.available === false,
  { approval: codexConsent.approval });

const runningStartCard = normalizeAgentCardState("codex-a", {
  agentRef: "agent_live",
  turnId: "turn-live",
  status: "running",
  nextSeq: 7,
  execution: { requestedModel: "gpt-5.6-luna", resolvedModel: "gpt-5.6-luna", reasoningEffort: "low" },
  meteredConsent: codexPayload.meteredConsent,
}, {
  now: NOW,
  taskTitle: "Live task title",
  projectOverride: "C:\\Projects\\SpikeBridgeFixture",
  invocationRationaleOverride: "live card stability gate",
});
let runningView = acceptAgentCardView(createAgentCardView(), runningStartCard).view;
const runningShowCard = normalizeAgentCardState("codex-a", {
  agentRef: "agent_live",
  turnId: "turn-live",
  status: "running",
  nextSeq: 12,
  execution: { requestedModel: "gpt-5.6-luna", resolvedModel: "gpt-5.6-luna", reasoningEffort: "low" },
}, { now: NOW + 10 });
const runningShowOutcome = acceptAgentCardView(runningView, runningShowCard);
runningView = runningShowOutcome.view;
record("lifecycle.running-show-preserves-start-fields", runningShowOutcome.ok === true
  && runningView.card?.quota?.available === true
  && runningView.card?.quota?.plan === "Plus"
  && runningView.card?.quota?.before?.windows?.length === 1
  && runningView.card?.account?.plan === "Plus"
  && runningView.card?.task?.title === "Live task title"
  && runningView.card?.task?.project === "C:\\Projects\\SpikeBridgeFixture"
  && runningView.card?.task?.invocationRationale === "live card stability gate",
  { card: runningView.card });

// 3) ZCode normalization ------------------------------------------------------
const zcodeDone = normalizeAgentCardState("zcode", {
  ref: "zcode_u1", provider: "zcode", status: "completed", sessionRef: "s-99", parentRef: null,
  exitCode: 0, startedAt: NOW - 5000, finishedAt: NOW, durationMs: 5000,
  mode: "yolo", workspace: "F:\\proj", model: "glm-5.3-flash",
  response: "CARD-OK", usage: { input_tokens: 900, output_tokens: 120, total_tokens: 1020 },
}, { now: NOW });
record("zcode.canonical", zcodeDone.provider.label === "ZCode"
  && zcodeDone.execution.resolvedModel === "glm-5.3-flash"
  && zcodeDone.execution.sessionId === "s-99"
  && zcodeDone.state.status === "completed" && zcodeDone.state.terminal === true
  && zcodeDone.state.elapsedMs === 5000
  && zcodeDone.usage.available === true && zcodeDone.usage.turn?.total_tokens === 1020
  && zcodeDone.quota.available === false
  && zcodeDone.task.taskRef === "zcode_u1"
  && zcodeDone.result.summary === "CARD-OK"
  && zcodeDone.capabilities.cancel === true,
  { card: zcodeDone });
record("zcode.facts", zcodeDone.facts.some((f) => f.key === "mode" && f.value === "yolo") && zcodeDone.facts.some((f) => f.key === "exitCode" && f.value === 0));

const zcodeResumed = normalizeAgentCardState("zcode", {
  ref: "zcode_u2", provider: "zcode", status: "running", sessionRef: "s-99", parentRef: "zcode_u1",
  startedAt: NOW, durationMs: null, mode: "yolo", workspace: "F:\\proj", model: "glm-5.3-flash",
}, { linkRef: "zcode_u1", now: NOW });
record("zcode.send-links-task", zcodeResumed.task.taskRef === "zcode_u1" && zcodeResumed.task.parentTaskRef === "zcode_u1"
  && zcodeResumed.turn.turnRef === "zcode_u2" && zcodeResumed.state.status === "running", { card: zcodeResumed });

// 4) Mac normalization ----------------------------------------------------
const macDone = normalizeAgentCardState("mac", {
  ref: "wb_1", provider: "mac", status: "completed", sessionRef: "remote-session-7",
  response: "ok", usage: { totalTokens: 55 }, model: "gpt-5.6-luna", exitCode: 0,
}, { now: NOW });
record("mac.canonical", macDone.provider.label === "Mac"
  && macDone.execution.host === "Mac"
  && macDone.execution.sessionId === "remote-session-7"
  && macDone.execution.resolvedModel === "gpt-5.6-luna"
  && macDone.quota.available === false
  && macDone.usage.available === true
  && macDone.capabilities.cancel === false
  && macDone.capabilities.resume === true,
  { card: macDone });
const macNoModel = normalizeAgentCardState("mac", { ref: "wb_2", provider: "mac", status: "running", model: null }, { now: NOW });
record("mac.model-only-when-real", macNoModel.execution.resolvedModel === null && macNoModel.usage.available === false && macNoModel.execution.host === "Mac");
const macCancelCard = normalizeAgentCardState("mac", {
  ref: "mac_cancel_probe", provider: "mac", status: "UNKNOWN",
  error: "Mac bridge protocol has no per-task cancel", code: "AGENT_PROVIDER_CANCEL_UNSUPPORTED",
}, { linkRef: "mac_cancel_probe", now: NOW });
record("cancel.cardV1", macCancelCard.schemaVersion === "spike.agent-card.v1"
  && macCancelCard.provider.label === "Mac"
  && macCancelCard.state.status === "unknown"
  && macCancelCard.execution.host === "Mac"
  && macCancelCard.quota.available === false
  && macCancelCard.capabilities.cancel === false,
  { card: macCancelCard });

// 5) WorkBuddy fixture (generic unknown provider) -----------------------------
const workbuddy = normalizeAgentCardState("workbuddy", {
  provider: "workbuddy", ref: "wbud_1", status: "running",
  model: "glm-4-flash", session: "sess-1", usage: { totalTokens: 10 }, host: "workbuddy-host",
}, { now: NOW });
record("workbuddy.fixture", workbuddy.schemaVersion === "spike.agent-card.v1"
  && workbuddy.provider.label === "workbuddy"
  && workbuddy.execution.resolvedModel === "glm-4-flash"
  && workbuddy.execution.sessionId === "sess-1"
  && workbuddy.execution.host === "workbuddy-host"
  && workbuddy.usage.available === true && workbuddy.usage.turn?.totalTokens === 10
  && workbuddy.quota.available === false
  && workbuddy.capabilities.cancel === false && workbuddy.capabilities.refresh === true
  && Array.isArray(workbuddy.facts),
  { card: workbuddy });

// 6) lifecycle: multi-turn + ordering -----------------------------------------
function step(view, card) { return acceptAgentCardView(view, card); }
function zc(ref, status, extra = {}) {
  return normalizeAgentCardState("zcode", {
    ref, provider: "zcode", status, sessionRef: "s-9", model: "glm-5.3-flash",
    startedAt: NOW - 1000, durationMs: status === "completed" ? 1000 : null,
    response: status === "completed" ? "done-" + ref : null, usage: { total_tokens: 1 },
    parentRef: extra.parentRef ?? null,
  }, { linkRef: extra.linkRef ?? null, now: extra.now ?? NOW });
}

let view = createAgentCardView();
let outcome = step(view, zc("zcode_r0", "running"));
view = outcome.view;
record("lifecycle.mount", outcome.ok === true && outcome.reason === "new-turn" && view.taskRef === "zcode_r0");
outcome = step(view, zc("zcode_r0", "completed", { now: NOW + 10 }));
view = outcome.view;
record("lifecycle.start-completes", outcome.ok === true && view.terminal === true && view.turnRef === "zcode_r0");
// send -> NEW turn, same task/session: completed -> running must be legal
outcome = step(view, zc("zcode_r1", "running", { parentRef: "zcode_r0", linkRef: "zcode_r0", now: NOW + 20 }));
view = outcome.view;
record("lifecycle.send-new-turn-runs", outcome.ok === true && outcome.reason === "new-turn" && view.terminal === false && view.status === "running" && view.taskRef === "zcode_r0");
outcome = step(view, zc("zcode_r1", "completed", { parentRef: "zcode_r0", now: NOW + 30 }));
view = outcome.view;
record("lifecycle.second-turn-completes", outcome.ok === true && view.terminal === true && view.turnRef === "zcode_r1");
// the superseded first turn must never repaint the card
outcome = step(view, zc("zcode_r0", "running", { now: NOW + 40 }));
record("lifecycle.superseded-turn-rejected", outcome.ok === false && outcome.reason === "superseded-turn", { outcome });
// same-turn terminal sticky: a late running payload for the finished turn loses
outcome = step(view, zc("zcode_r1", "running", { parentRef: "zcode_r0", now: NOW + 50 }));
record("lifecycle.terminal-sticky", outcome.ok === false && outcome.reason === "terminal-sticky", { outcome });
// foreign task must not pollute
const foreign = normalizeAgentCardState("zcode", { ref: "zcode_OTHER", provider: "zcode", status: "running", model: "glm-5.3-flash", startedAt: NOW }, { now: NOW + 60 });
outcome = step(view, foreign);
record("lifecycle.foreign-task-rejected", outcome.ok === false && outcome.reason === "foreign-task", { outcome });

// codex multi-turn on one taskRef
let cview = createAgentCardView();
const codexTurn = (turnId, status, revision, updatedAt) => normalizeAgentCardState("codex", {
  taskRef: "task_123", agentRef: "agent_abc", turnId, status,
  nextSeq: revision, timing: { startedAt: updatedAt, durationMs: null },
  execution: { resolvedModel: "gpt-6.2", reasoningEffort: "high" },
}, { now: updatedAt });
let coutcome = step(cview, codexTurn("turn-1", "completed", 8, NOW));
cview = coutcome.view;
coutcome = step(cview, codexTurn("turn-2", "running", 2, NOW + 10));
cview = coutcome.view;
record("lifecycle.codex-multiturn", coutcome.ok === true && cview.turnRef === "turn-2" && cview.terminal === false && cview.taskRef === "task_123");
const duplicateSameRevision = codexTurn("turn-2", "running", 2, NOW + 20);
coutcome = step(cview, duplicateSameRevision);
record("lifecycle.same-revision-no-repaint", coutcome.ok === false && coutcome.reason === "stale", { outcome: coutcome });
const stale = codexTurn("turn-2", "running", 1, NOW - 100);
coutcome = step(cview, stale);
record("lifecycle.stale-revision-rejected", coutcome.ok === false && coutcome.reason === "stale", { outcome: coutcome });
const codexForeign = normalizeAgentCardState("codex", { taskRef: "task_999", agentRef: "agent_other", turnId: "turn-x", status: "running" }, { now: NOW + 20 });
coutcome = step(cview, codexForeign);
record("lifecycle.codex-foreign-rejected", coutcome.ok === false && coutcome.reason === "foreign-task", { outcome: coutcome });

// unlinked new turn (provider without ancestry) still follows send linkage
let wview = createAgentCardView();
const wb0 = normalizeAgentCardState("mac", { ref: "wb_0", provider: "mac", status: "completed", sessionRef: "rs" }, { now: NOW });
wview = step(wview, wb0).view;
const wb1 = normalizeAgentCardState("mac", { ref: "wb_1", provider: "mac", status: "running" }, { linkRef: "wb_0", now: NOW + 10 });
const woutcome = step(wview, wb1);
record("lifecycle.unlinked-send-adopted", woutcome.ok === true && woutcome.view.taskRef === "wb_0" && woutcome.view.turnRef === "wb_1", { outcome: woutcome });

const failed = results.filter((entry) => !entry.ok);
console.log(JSON.stringify({ gate: "spike-agent-card", total: results.length, failed: failed.length, results }, null, 2));
process.exit(failed.length ? 1 : 0);
