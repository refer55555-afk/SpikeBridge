// Spike Agent Card UI v4 (state schema remains spike.agent-card.v1).
//
// The ONE generic agent card surface:
//   resource  ui://spike/agent-card-v4.html        (text/html;profile=mcp-app)
//   mount     spike.agent_start owns the single UI render for a new task
//   refresh   the mounted card calls data-only spike.agent_status on explicit Refresh
//   actions   send/cancel never carry UI metadata or request another mount
//
// Every provider payload is normalized HERE into SpikeAgentCardStateV1 before
// anything reaches the widget. Provider-specific extras may only enter
// `facts[]`; fields a provider cannot observe stay null/false — never guessed.
// The old toolwire Codex Task Card (agent-card-ui.mjs) is untouched legacy.

import {
  acceptAgentCardView,
  agentCardIsTerminalStatus,
  createAgentCardView,
  AGENT_CARD_SCHEMA_VERSION,
} from "./spike-agent-card-lifecycle.mjs";

export { acceptAgentCardView, agentCardIsTerminalStatus, createAgentCardView };

export const SPIKE_AGENT_CARD_URI = "ui://spike/agent-card-v4.html";
export const SPIKE_AGENT_CARD_RESOURCE_NAME = "spike-agent-card-v4";
// Compatibility aliases for already-mounted/cached resources. All live tool
// metadata points at v4. v3/v2/v1 serve the byte-identical v4 HTML so old
// mounted cards fail soft; stale public spike.agent_show tool descriptors are
// broken separately by the public tool-name migration to spike.agent_status.
export const SPIKE_AGENT_CARD_LEGACY_URI = "ui://spike/agent-card-v3.html";
export const SPIKE_AGENT_CARD_LEGACY_RESOURCE_NAME = "spike-agent-card-v3-compat";
export const SPIKE_AGENT_CARD_LEGACY_V2_URI = "ui://spike/agent-card-v2.html";
export const SPIKE_AGENT_CARD_LEGACY_V2_RESOURCE_NAME = "spike-agent-card-v2-compat";
export const SPIKE_AGENT_CARD_LEGACY_V1_URI = "ui://spike/agent-card-v1.html";
export const SPIKE_AGENT_CARD_LEGACY_V1_RESOURCE_NAME = "spike-agent-card-v1-compat";
export const SPIKE_AGENT_CARD_COMPAT_URIS = Object.freeze([
  SPIKE_AGENT_CARD_LEGACY_URI,
  SPIKE_AGENT_CARD_LEGACY_V2_URI,
  SPIKE_AGENT_CARD_LEGACY_V1_URI,
]);
export const AGENT_CARD_SCHEMA_VERSION_EXPORT = AGENT_CARD_SCHEMA_VERSION;
export const AGENT_CARD_RESULT_EXCERPT_MAX_CHARS = 800;

const PROVIDER_LABELS = { codex: "Codex A", "codex-a": "Codex A", "codex-b": "Codex B", zcode: "ZCode", mac: "Mac", workbee: "Mac" };
const PROVIDER_CANCEL = { codex: true, "codex-a": true, "codex-b": true, zcode: true, mac: false, workbee: false };
const isCodexProvider = (providerId) => providerId === "codex" || providerId === "codex-a" || providerId === "codex-b";

export function registerSpikeAgentCardResource(server) {
  const register = (name, uri) => server.registerResource(name, uri, {}, async () => ({
    contents: [{
      uri,
      mimeType: "text/html;profile=mcp-app",
      text: SPIKE_AGENT_CARD_HTML,
      _meta: { ui: { prefersBorder: true } },
    }],
  }));
  register(SPIKE_AGENT_CARD_RESOURCE_NAME, SPIKE_AGENT_CARD_URI);
  register(SPIKE_AGENT_CARD_LEGACY_RESOURCE_NAME, SPIKE_AGENT_CARD_LEGACY_URI);
  register(SPIKE_AGENT_CARD_LEGACY_V2_RESOURCE_NAME, SPIKE_AGENT_CARD_LEGACY_V2_URI);
  register(SPIKE_AGENT_CARD_LEGACY_V1_RESOURCE_NAME, SPIKE_AGENT_CARD_LEGACY_V1_URI);
}

// ---------------------------------------------------------------------------
// Normalization: provider payload -> SpikeAgentCardStateV1
// ---------------------------------------------------------------------------

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function firstString(...values) {
  const value = firstDefined(...values);
  return typeof value === "string" && value.trim() ? value : null;
}

function realObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedText(value, max = AGENT_CARD_RESULT_EXCERPT_MAX_CHARS) {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : String(value);
  const clean = text.trim();
  if (!clean) return null;
  if (clean.length <= max) return clean;
  return clean.slice(0, max);
}

function boundedScalar(value, max = 200) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return boundedText(value, max);
}

function canonicalStatus(payload) {
  const raw = firstString(payload?.status, payload?.agentState?.status, typeof payload?.state === "string" ? payload.state : null);
  if (!raw) return "unknown";
  const lower = raw.toLowerCase();
  if (lower === "idle") return "completed"; // codex executor idle == thread finished
  if (lower === "queued" || lower === "processing") return "running";
  if (lower === "awaitingapproval") return "awaitingApproval";
  if (lower === "consent_required") return "consent_required";
  if (["running", "completed", "failed", "interrupted", "rejected", "lost", "unknown"].includes(lower)) return lower;
  return raw;
}

function quotaWindowLabel(window, limit, index) {
  const mins = Number.isInteger(window?.windowDurationMins) ? window.windowDurationMins : null;
  let duration = null;
  if (mins && mins > 0) {
    if (mins % 1440 === 0) duration = `${mins / 1440}d`;
    else if (mins % 60 === 0) duration = `${mins / 60}h`;
    else duration = `${mins}m`;
  }
  const limitName = typeof limit?.limitName === "string" ? limit.limitName : null;
  const limitKey = typeof limit?.key === "string" ? limit.key : null;
  const named = limitName && limitName.toLowerCase() !== "codex"
    ? limitName
    : (limitKey && limitKey !== "codex" ? limitKey : null);
  if (named && duration && named.toLowerCase() !== duration.toLowerCase()) return `${named} · ${duration}`;
  return named || duration || (typeof window?.kind === "string" ? window.kind : null) || `window ${index + 1}`;
}

function normalizedQuotaModelName(value) {
  const text = firstString(value);
  return text ? text.toLowerCase().replace(/[^a-z0-9]+/g, "") : null;
}

function modelSpecificQuotaLimit(limit) {
  const key = typeof limit?.key === "string" ? limit.key.toLowerCase() : null;
  const name = typeof limit?.limitName === "string" ? limit.limitName.trim() : null;
  if (!name || !key || key === "codex") return false;
  return /^(gpt|o\d|codex)[\s._-]/i.test(name) || /^gpt\d/i.test(name.replace(/[^a-z0-9]+/gi, ""));
}

function quotaLimitAppliesToModels(limit, models) {
  if (!modelSpecificQuotaLimit(limit)) return true;
  const limitName = normalizedQuotaModelName(limit.limitName);
  const modelNames = (Array.isArray(models) ? models : [models])
    .map(normalizedQuotaModelName)
    .filter(Boolean);
  if (!limitName || modelNames.length === 0) return true;
  return modelNames.some((modelName) =>
    modelName === limitName || modelName.includes(limitName) || limitName.includes(modelName)
  );
}

function quotaWindows(snapshot, { models = [] } = {}) {
  const limits = snapshot?.rateLimits?.limits;
  if (!Array.isArray(limits)) return [];
  const windows = [];
  for (const limit of limits) {
    if (!quotaLimitAppliesToModels(limit, models)) continue;
    const list = Array.isArray(limit?.windows) ? limit.windows : [];
    for (const window of list) {
      windows.push({
        label: quotaWindowLabel(window, limit, windows.length),
        usedPercent: Number.isInteger(window?.usedPercent) ? window.usedPercent : null,
        remainingPercent: Number.isInteger(window?.remainingPercent) ? window.remainingPercent : null,
        resetsAt: Number.isInteger(window?.resetsAt) ? window.resetsAt : null,
        windowDurationMins: Number.isInteger(window?.windowDurationMins) ? window.windowDurationMins : null,
      });
    }
  }
  return windows;
}

function quotaPlanType(snapshot) {
  const limits = snapshot?.rateLimits?.limits;
  if (!Array.isArray(limits)) return null;
  for (const limit of limits) {
    const planType = firstString(limit?.planType);
    if (planType) return planType;
  }
  return null;
}

function planLabel(value) {
  const plan = firstString(value);
  if (!plan) return null;
  const known = { free: "Free", go: "Go", plus: "Plus", pro: "Pro", business: "Business", enterprise: "Enterprise", edu: "Edu" };
  return known[plan.toLowerCase()] || plan;
}

function canonicalQuota(payload, models = []) {
  const beforeSnapshot = payload?.meteredConsent?.quota || payload?.taskCard?.quota || null;
  const afterSnapshot = payload?.resourceReceipt?.accountQuota || null;
  const beforeWindows = quotaWindows(beforeSnapshot, { models });
  const afterWindows = quotaWindows(afterSnapshot, { models });
  return {
    available: beforeWindows.length > 0 || afterWindows.length > 0,
    plan: planLabel(quotaPlanType(afterSnapshot) || quotaPlanType(beforeSnapshot)),
    before: beforeWindows.length
      ? { observedAt: firstString(beforeSnapshot?.observedAt), windows: beforeWindows }
      : null,
    after: afterWindows.length
      ? { observedAt: firstString(afterSnapshot?.observedAt), windows: afterWindows }
      : null,
  };
}

function canonicalAccount(providerId, payload, quota) {
  if (!isCodexProvider(providerId)) return null;
  const slot = providerId === "codex-b" ? "B" : "A";
  const observed = realObject(payload?.account) ? payload.account : null;
  return {
    slot,
    label: `Codex ${slot}`,
    plan: firstString(quota?.plan),
    name: firstString(observed?.name, observed?.displayName),
    identifier: firstString(observed?.identifier, observed?.accountId, observed?.userId),
  };
}

function canonicalUsage(payload) {
  const tokenUsage = payload?.resourceReceipt?.tokenUsage;
  if (realObject(tokenUsage) && (tokenUsage.turn || tokenUsage.threadTotal)) {
    return {
      available: true,
      turn: tokenUsage.turn ?? null,
      cumulative: tokenUsage.threadTotal ?? null,
      contextWindow: Number.isFinite(tokenUsage.modelContextWindow) ? tokenUsage.modelContextWindow : null,
    };
  }
  const taskUsage = realObject(payload?.usage) && Object.keys(payload.usage).length > 0 ? payload.usage : null;
  if (taskUsage) return { available: true, turn: taskUsage, cumulative: null, contextWindow: null };
  return { available: false, turn: null, cumulative: null, contextWindow: null };
}

function canonicalApproval(providerId, payload, status) {
  if (status === "consent_required") {
    const taskId = firstString(payload?.taskId, payload?.shortTaskId, payload?.taskCard?.taskId);
    return {
      required: true,
      kind: "consent",
      taskId,
      approveTool: isCodexProvider(providerId) ? "codex.agent_commit" : null,
      rejectTool: isCodexProvider(providerId) ? "codex.agent_decline" : null,
      note: taskId
        ? null
        : "Call Approval consent is pending; resolve it through the provider consent flow, then show the started agent.",
    };
  }
  if (status === "awaitingApproval") {
    return {
      required: true,
      kind: "in_turn",
      taskId: null,
      approveTool: null, // V1 adds no generic approval tools; reuse the provider's existing in-turn surface
      rejectTool: null,
      note: "In-turn approval pending; resolve it through the provider's existing approval surface.",
    };
  }
  return { required: false, kind: null, taskId: null, approveTool: null, rejectTool: null, note: null };
}

function canonicalCapabilities(providerId, payload, status, sessionId) {
  return {
    refresh: true,
    cancel: PROVIDER_CANCEL[providerId] === true && status !== "consent_required",
    resume: isCodexProvider(providerId)
      ? payload?.canSend === true
      : Boolean(sessionId),
    approval: status === "consent_required",
    reject: status === "consent_required",
  };
}

function canonicalFacts(providerId, payload) {
  const facts = [];
  const push = (key, value) => {
    if (value === null || value === undefined || value === "") return;
    if (facts.length >= 8) return;
    facts.push({ key, value: typeof value === "object" ? boundedText(JSON.stringify(value), 120) : value });
  };
  push("shortTaskId", firstString(payload?.shortTaskId, payload?.taskCard?.shortTaskId));
  if (providerId === "zcode") {
    push("mode", firstString(payload?.mode));
    if (Number.isInteger(payload?.exitCode)) push("exitCode", payload.exitCode);
  }
  if ((providerId === "mac" || providerId === "workbee") && Number.isInteger(payload?.exitCode)) push("exitCode", payload.exitCode);
  if (payload?.duplicate === true) push("duplicate", true);
  return facts;
}

export function normalizeAgentCardState(providerId, rawPayload, {
  providerLabel = null,
  linkRef = null,
  taskTitle = null,
  projectOverride = null,
  invocationRationaleOverride = null,
  now = Date.now(),
} = {}) {
  const payload = realObject(rawPayload) ? rawPayload : {};
  const id = typeof providerId === "string" && providerId.trim() ? providerId : "unknown";
  const label = id === "codex" ? PROVIDER_LABELS.codex : (providerLabel || PROVIDER_LABELS[id] || id);
  const status = canonicalStatus(payload);
  const terminal = agentCardIsTerminalStatus(status);

  const ref = firstString(payload?.ref, payload?.agentRef, payload?.taskCard?.agentRef);
  const agentRef = firstString(payload?.agentRef, ref);
  const codexTaskRef = firstString(payload?.taskCard?.taskRef, payload?.taskRef);
  const parentRef = firstString(payload?.parentRef, payload?.parentTaskRef);
  const taskRef = codexTaskRef ?? (isCodexProvider(id) ? null : (parentRef ?? (typeof linkRef === "string" && linkRef ? linkRef : ref)));
  const parentTaskRef = parentRef ?? (linkRef && linkRef !== ref ? linkRef : null);

  const timing = realObject(payload?.timing) ? payload.timing : {};
  const startedAt = Number.isFinite(timing.startedAt) ? timing.startedAt : (Number.isFinite(payload?.startedAt) ? payload.startedAt : null);
  const endedAt = Number.isFinite(timing.endedAt) ? timing.endedAt : (Number.isFinite(payload?.finishedAt) ? payload.finishedAt : null);
  const elapsedMs = Number.isFinite(timing.durationMs) ? timing.durationMs : (Number.isFinite(payload?.durationMs) ? payload.durationMs : null);

  const execution = realObject(payload?.execution) ? payload.execution : {};
  const requestedModel = firstString(execution.requestedModel);
  const resolvedModel = firstString(execution.resolvedModel, payload?.model);
  const reasoningEffort = firstString(execution.reasoningEffort, execution.requestedReasoningEffort, payload?.taskCard?.requestedReasoningEffort);
  const sessionId = firstString(payload?.sessionRef, payload?.sessionId, payload?.session);
  const host = firstString(payload?.host) ?? ((id === "mac" || id === "workbee") ? "Mac" : null);

  const evidence = realObject(payload?.terminalEvidence) ? payload.terminalEvidence : {};
  const turnRef = firstString(payload?.turnId, ref, payload?.taskId) ?? `card:${now}`;
  const quota = canonicalQuota(payload, [resolvedModel, requestedModel]);

  return {
    schemaVersion: AGENT_CARD_SCHEMA_VERSION,
    provider: { id, label, health: "UNKNOWN" },
    task: {
      taskRef,
      agentRef,
      parentTaskRef,
      title: firstString(taskTitle, payload?.taskCard?.title, payload?.taskCard?.summary, payload?.task, payload?.prompt),
      project: firstString(projectOverride, payload?.workspace, payload?.cwd, payload?.project),
      cwd: firstString(payload?.cwd, payload?.workspace, projectOverride),
      invocationRationale: firstString(invocationRationaleOverride, payload?.taskCard?.invocationRationale),
    },
    turn: {
      turnRef,
      revision: Number.isInteger(payload?.nextSeq) ? payload.nextSeq : now,
    },
    state: {
      status,
      terminal,
      startedAt,
      updatedAt: now,
      endedAt,
      elapsedMs,
    },
    execution: {
      requestedModel,
      resolvedModel,
      reasoningEffort,
      sessionId,
      host,
    },
    usage: canonicalUsage(payload),
    quota,
    account: canonicalAccount(id, payload, quota),
    approval: canonicalApproval(id, payload, status),
    result: {
      summary: terminal
        ? boundedText(firstDefined(payload?.finalResult, payload?.response, payload?.lastMessage, payload?.result))
        : null,
      error: boundedText(firstDefined(payload?.latestError, payload?.error, payload?.detail), 400),
      changedFiles: boundedScalar(evidence.changes),
      verification: boundedScalar(evidence.verification),
    },
    capabilities: canonicalCapabilities(id, payload, status, sessionId),
    facts: canonicalFacts(id, payload),
  };
}

// ---------------------------------------------------------------------------
// Widget HTML — composed from the lifecycle sources so gates and the widget
// run byte-identical acceptance logic. No external JS/CSS/fonts/network.
// ---------------------------------------------------------------------------

const LIFECYCLE_SOURCES = [
  agentCardIsTerminalStatus,
  createAgentCardView,
  acceptAgentCardView,
].map((fn) => fn.toString()).join("\n\n");

export const SPIKE_AGENT_CARD_HTML = `
<style>
  #actions button {
    appearance:none;
    -webkit-appearance:none;
    font-family:inherit;
    background:rgba(127,127,127,.10);
    color:inherit !important;
    border:1px solid rgba(127,127,127,.38);
    box-shadow:none;
  }
  #yes, #no {
    flex:1;
    min-width:0;
    min-height:44px;
    padding:8px 12px;
    border-radius:9px;
    font-size:15px;
    font-weight:650;
  }
  #stop {
    flex:1;
    min-height:44px;
    padding:8px 14px;
    border-radius:10px;
    font-size:15px;
    font-weight:650;
  }
  #refresh {
    min-width:50px;
    min-height:44px;
    border-radius:10px;
    font-size:18px;
  }
  #actions button:active { background:rgba(127,127,127,.18); }
  #actions button:disabled { opacity:.48; cursor:wait; }
  @media (min-width:640px) {
    #actions { justify-content:flex-end; gap:8px; }
    #yes, #no { flex:0 0 96px; min-height:38px; padding:7px 12px; font-size:14px; }
    #stop { flex:0 0 112px; min-height:40px; padding:8px 14px; }
    #refresh { min-width:44px; min-height:40px; }
  }
</style>
<div id="card" style="font-family:inherit;padding:12px 14px;line-height:1.45;color:inherit">
  <div style="display:flex;align-items:center;gap:8px">
    <span id="dot" style="width:8px;height:8px;border-radius:50%;background:rgba(127,127,127,.6);flex:0 0 auto"></span>
    <span id="providerLabel" style="font-size:16px;font-weight:750;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</span>
    <span id="statusChip" style="margin-left:auto;font-size:12px;font-weight:750;letter-spacing:.4px;text-transform:uppercase;padding:3px 9px;border-radius:999px;border:1px solid rgba(127,127,127,.35);white-space:nowrap">—</span>
  </div>
  <div id="accountLine" style="display:none;margin-top:5px;font-size:12.5px;opacity:.72;word-break:break-word"></div>
  <div id="taskLine" style="display:none;margin-top:7px;font-size:14px;opacity:.9;word-break:break-word"></div>
  <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-top:9px;font-size:13.5px">
    <span id="modelReasoning" style="min-width:0;word-break:break-word">—</span>
    <span id="duration" style="opacity:.75;white-space:nowrap"></span>
  </div>
  <div id="quotaBox" style="margin-top:11px;padding-top:9px;border-top:1px solid rgba(128,128,128,.22);font-size:13px">
    <div id="quotaTitle" style="font-weight:700;font-size:12.5px;opacity:.8">Quota</div>
    <div id="quotaRows" style="margin-top:5px;display:grid;gap:4px"></div>
  </div>
  <div id="usageLine" style="display:none;margin-top:8px;font-size:13px;opacity:.8;word-break:break-word"></div>
  <div id="resultBox" style="display:none;margin-top:9px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word"></div>
  <div id="detailsLine" style="display:none;margin-top:8px;font-size:11.5px;opacity:.55;word-break:break-all"></div>
  <div id="actions" style="display:flex;gap:10px;margin-top:12px;width:100%">
    <button id="yes" type="button" style="display:none"></button>
    <button id="no" type="button" style="display:none"></button>
    <button id="stop" type="button" style="display:none"></button>
    <button id="refresh" type="button" aria-label="Refresh" style="display:none">↻</button>
  </div>
  <div id="errorBox" style="display:none;margin-top:8px;font-size:12px;opacity:.85;word-break:break-word"></div>
</div>
<script>
${LIFECYCLE_SOURCES}

(() => {
  var view = createAgentCardView();
  var clockTimer = null;
  var locale = (window.openai && window.openai.locale) || navigator.language || "en";
  var pending = new Map();
  var seq = 1;
  var recoverAttempt = "";
  var hostPollAttempts = 0;
  var hostPoll = null;

  var ACCENTS = { codex: "#e8833a", "codex-a": "#e8833a", "codex-b": "#e8833a", zcode: "#4f8ef7", mac: "#2ea97e", workbee: "#2ea97e" };

  var I18N = {
    en: { call: "Call {p}?", approval: "Awaiting approval", running: "Running", done: "Completed", failed: "Failed", stopped: "Stopped", rejected: "Declined", uncertain: "State uncertain", account: "Account", plan: "Plan", task: "Task", reasoning: "Reasoning", requested: "requested", quota: "Quota", notProvided: "not provided by provider", before: "Before call", after: "After observed", reset: "reset", used: "used", left: "left", usage: "Usage", thisTurn: "this turn", cumulative: "cumulative", tokens: "tokens", input: "input", cached: "cached", output: "output", reasoningTokens: "reasoning", context: "context", result: "Result", approve: "Yes", decline: "No", stop: "Stop", starting: "Starting…", cancelling: "Cancelling…", session: "Session", host: "Host" },
    zh: { call: "调用 {p}？", approval: "等待批准", running: "运行中", done: "已完成", failed: "失败", stopped: "已停止", rejected: "已拒绝", uncertain: "状态不确定", account: "账户", plan: "会员", task: "任务", reasoning: "推理", requested: "请求", quota: "额度", notProvided: "Provider 未提供", before: "调用前", after: "调用后观测", reset: "重置", used: "已用", left: "剩余", usage: "用量", thisTurn: "本次", cumulative: "累计", tokens: "tokens", input: "输入", cached: "缓存", output: "输出", reasoningTokens: "推理", context: "上下文", result: "结果", approve: "批准", decline: "拒绝", stop: "停止", starting: "正在启动…", cancelling: "正在停止…", session: "会话", host: "主机" },
    ja: { call: "{p}を呼びますか？", approval: "承認待ち", running: "実行中", done: "完了", failed: "失敗", stopped: "停止済み", rejected: "拒否済み", uncertain: "状態不明", account: "アカウント", plan: "プラン", task: "タスク", reasoning: "推論", requested: "指定", quota: "利用枠", notProvided: "プロバイダ未提供", before: "呼び出し前", after: "呼び出し後", reset: "リセット", used: "使用済み", left: "残り", usage: "使用量", thisTurn: "今回", cumulative: "累計", tokens: "tokens", input: "入力", cached: "キャッシュ", output: "出力", reasoningTokens: "推論", context: "コンテキスト", result: "結果", approve: "はい", decline: "いいえ", stop: "停止", starting: "起動中…", cancelling: "停止中…", session: "セッション", host: "ホスト" }
  };

  function langKey() {
    var v = String(locale || "en").toLowerCase();
    if (v.startsWith("zh")) return "zh";
    if (v.startsWith("ja")) return "ja";
    return "en";
  }
  function txt(key) { return I18N[langKey()][key] || I18N.en[key] || key; }

  var providerEl = document.getElementById("providerLabel");
  var dotEl = document.getElementById("dot");
  var chipEl = document.getElementById("statusChip");
  var accountLineEl = document.getElementById("accountLine");
  var taskLineEl = document.getElementById("taskLine");
  var modelEl = document.getElementById("modelReasoning");
  var durationEl = document.getElementById("duration");
  var quotaRowsEl = document.getElementById("quotaRows");
  var usageEl = document.getElementById("usageLine");
  var resultEl = document.getElementById("resultBox");
  var detailsEl = document.getElementById("detailsLine");
  var errorEl = document.getElementById("errorBox");
  var yesBtn = document.getElementById("yes");
  var noBtn = document.getElementById("no");
  var stopBtn = document.getElementById("stop");
  var refreshBtn = document.getElementById("refresh");

  function request(method, params) {
    var id = seq++;
    window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
    return new Promise((resolve, reject) => pending.set(id, { resolve: resolve, reject: reject }));
  }

  function callTool(name, args) {
    errorEl.style.display = "none";
    var base = window.openai && typeof window.openai.callTool === "function"
      ? window.openai.callTool(name, args)
      : request("tools/call", { name: name, arguments: args });
    return Promise.resolve(base).then(digestResult);
  }

  function digestResult(result) {
    if (result && result.isError) throw new Error((result.content && result.content[0] && result.content[0].text) || "Tool call failed");
    var card = findCard(result);
    if (card) render(card);
    return result;
  }

  function findCard(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.cardV1 && raw.cardV1.schemaVersion === "spike.agent-card.v1") return raw.cardV1;
    if (raw.structuredContent) { var nested = findCard(raw.structuredContent); if (nested) return nested; }
    var keys = ["mcp_tool_result", "call_tool_result", "toolOutput", "toolResponseMetadata"];
    for (var i = 0; i < keys.length; i++) {
      if (raw[keys[i]]) { var found = findCard(raw[keys[i]]); if (found) return found; }
    }
    return null;
  }

  function normalizeInput(raw) {
    var node = raw;
    for (var depth = 0; node && typeof node === "object" && depth < 4; depth++) {
      var candidate = node.arguments && typeof node.arguments === "object"
        ? node.arguments
        : (node.toolInput && typeof node.toolInput === "object" ? node.toolInput : node);
      var provider = typeof candidate.provider === "string" && candidate.provider ? candidate.provider : null;
      var ref = typeof candidate.ref === "string" && candidate.ref
        ? candidate.ref
        : (typeof candidate.taskRef === "string" && candidate.taskRef ? candidate.taskRef : (typeof candidate.agentRef === "string" && candidate.agentRef ? candidate.agentRef : null));
      if (provider && ref) return { provider: provider, ref: ref };
      node = candidate;
    }
    return null;
  }

  function readToolInput() {
    if (window.openai && window.openai.toolInput) return normalizeInput(window.openai.toolInput);
    return null;
  }

  function statusText(status, providerLabel) {
    if (status === "consent_required") return txt("call").replace("{p}", providerLabel || "Agent");
    if (status === "awaitingApproval") return txt("approval");
    if (status === "running") return txt("running");
    if (status === "completed") return txt("done");
    if (status === "failed") return txt("failed");
    if (status === "interrupted") return txt("stopped");
    if (status === "rejected") return txt("rejected");
    if (status === "lost") return txt("uncertain");
    return String(status || "unknown").toUpperCase();
  }

  function durationText(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h) return h + "h " + m + "m " + s + "s";
    if (m) return m + "m " + s + "s";
    return s + "s";
  }

  function fmtInt(value) {
    try { return Number(value).toLocaleString(locale || undefined); }
    catch { return String(value); }
  }

  function pickNumber(object, keys) {
    for (var i = 0; i < keys.length; i++) {
      var value = object ? object[keys[i]] : null;
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  function fmtTokens(object) {
    if (!object || typeof object !== "object") return null;
    var total = pickNumber(object, ["totalTokens", "total_tokens"]);
    var input = pickNumber(object, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
    var cached = pickNumber(object, ["cachedInputTokens", "cached_input_tokens"]);
    var output = pickNumber(object, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
    var reasoning = pickNumber(object, ["reasoningOutputTokens", "reasoning_output_tokens"]);
    var parts = [];
    if (total !== null) parts.push(fmtInt(total) + " " + txt("tokens"));
    if (input !== null) parts.push(txt("input") + " " + fmtInt(input));
    if (cached !== null) parts.push(txt("cached") + " " + fmtInt(cached));
    if (output !== null) parts.push(txt("output") + " " + fmtInt(output));
    if (reasoning !== null) parts.push(txt("reasoningTokens") + " " + fmtInt(reasoning));
    if (parts.length) return parts.join(" · ");
    var extras = [];
    for (var key in object) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
      if (!Number.isFinite(object[key])) continue;
      extras.push(key + " " + fmtInt(object[key]));
      if (extras.length >= 3) break;
    }
    return extras.length ? extras.join(" · ") : null;
  }

  function clockText(iso) {
    if (typeof iso !== "string" || !iso) return "";
    var date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return "";
    try {
      return new Intl.DateTimeFormat(locale || undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
    } catch {
      return date.toLocaleTimeString();
    }
  }

  function resetText(unixSeconds) {
    if (!Number.isFinite(unixSeconds)) return "";
    try {
      return new Intl.DateTimeFormat(locale || undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(unixSeconds * 1000));
    } catch {
      return new Date(unixSeconds * 1000).toLocaleString();
    }
  }

  function quotaRowText(w) {
    var usageParts = [];
    if (Number.isFinite(w.usedPercent)) usageParts.push(w.usedPercent + "% " + txt("used"));
    if (Number.isFinite(w.remainingPercent)) usageParts.push(w.remainingPercent + "% " + txt("left"));
    if (!usageParts.length) usageParts.push(txt("notProvided"));
    var reset = resetText(w.resetsAt);
    return (w.label || "") + "：" + usageParts.join(" · ") + (reset ? " · " + reset + " " + txt("reset") : "");
  }

  function appendQuotaRow(text, dim) {
    var row = document.createElement("div");
    row.textContent = text;
    if (dim) row.style.opacity = ".58";
    quotaRowsEl.appendChild(row);
  }

  function appendQuotaHeading(text) {
    var heading = document.createElement("div");
    heading.textContent = text;
    heading.style.fontWeight = "650";
    heading.style.opacity = ".72";
    heading.style.marginTop = quotaRowsEl.childElementCount ? "4px" : "0";
    quotaRowsEl.appendChild(heading);
  }

  function paintQuota(quota) {
    quotaRowsEl.replaceChildren();
    if (!quota || quota.available !== true) {
      appendQuotaRow(txt("notProvided"), true);
      return;
    }
    var painted = false;
    var groups = [];
    if (quota.before && Array.isArray(quota.before.windows) && quota.before.windows.length) {
      groups.push({ observedAt: quota.before.observedAt, label: txt("before"), windows: quota.before.windows });
    }
    if (quota.after && Array.isArray(quota.after.windows) && quota.after.windows.length) {
      groups.push({ observedAt: quota.after.observedAt, label: txt("after"), windows: quota.after.windows });
    }
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      var observed = clockText(group.observedAt);
      appendQuotaHeading(observed ? group.label + " · " + observed : group.label);
      for (var j = 0; j < group.windows.length; j++) appendQuotaRow(quotaRowText(group.windows[j]), false);
      painted = true;
    }
    if (!painted) appendQuotaRow(txt("notProvided"), true);
  }

  function paintDuration() {
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    var card = view.card;
    if (!card) return;
    var st = card.state || {};
    if (view.terminal) {
      durationEl.textContent = Number.isFinite(st.elapsedMs) && st.elapsedMs >= 0 ? durationText(st.elapsedMs) : "";
    } else if (Number.isFinite(st.startedAt) && st.startedAt > 0) {
      durationEl.textContent = durationText(Date.now() - st.startedAt);
      clockTimer = setInterval(paintDuration, 1000);
    } else {
      durationEl.textContent = "";
    }
  }

  function paint() {
    var card = view.card;
    if (!card) return;
    var label = card.provider && card.provider.label ? card.provider.label : view.provider;
    var accent = ACCENTS[view.provider] || "rgba(127,127,127,.85)";
    providerEl.textContent = label;
    dotEl.style.background = accent;
    chipEl.textContent = statusText(view.status, label);
    if (!view.terminal) {
      chipEl.style.borderColor = accent;
      chipEl.style.color = accent;
    } else {
      chipEl.style.borderColor = "rgba(127,127,127,.35)";
      chipEl.style.color = "inherit";
    }

    var account = card.account;
    if (account && account.label) {
      var accountParts = [txt("account") + "：" + account.label];
      if (account.name) accountParts.push(String(account.name));
      if (account.identifier) accountParts.push(String(account.identifier));
      if (account.plan) accountParts.push(txt("plan") + " " + account.plan);
      accountLineEl.textContent = accountParts.join(" · ");
      accountLineEl.style.display = "block";
    } else {
      accountLineEl.textContent = "";
      accountLineEl.style.display = "none";
    }

    var task = card.task || {};
    var taskText = task.title
      ? txt("task") + "：" + task.title
      : (task.project ? txt("task") + "：" + task.project : (task.invocationRationale || ""));
    taskLineEl.textContent = taskText;
    taskLineEl.style.display = taskText ? "block" : "none";

    var ex = card.execution || {};
    var modelText = "";
    if (ex.resolvedModel) {
      modelText = ex.resolvedModel;
      if (ex.requestedModel && ex.requestedModel !== ex.resolvedModel) modelText += " (" + txt("requested") + " " + ex.requestedModel + ")";
    } else if (ex.requestedModel) {
      modelText = ex.requestedModel + " (" + txt("requested") + ")";
    }
    if (ex.reasoningEffort) modelText += (modelText ? " · " : "") + txt("reasoning") + " " + ex.reasoningEffort;
    modelEl.textContent = modelText || "—";

    paintDuration();
    paintQuota(card.quota);

    var usage = card.usage;
    if (usage && usage.available === true) {
      var usageParts = [];
      var turnText = fmtTokens(usage.turn);
      usageParts.push(txt("usage") + "：" + (turnText ? txt("thisTurn") + " " + turnText : txt("notProvided")));
      var cumulativeText = fmtTokens(usage.cumulative);
      if (cumulativeText) usageParts.push(txt("cumulative") + " " + cumulativeText);
      if (Number.isFinite(usage.contextWindow)) usageParts.push(txt("context") + " " + fmtInt(usage.contextWindow));
      usageEl.textContent = usageParts.join(" · ");
      usageEl.style.display = "block";
    } else {
      usageEl.style.display = "none";
    }

    var result = card.result || {};
    var resultText = "";
    if (view.terminal && result.summary) resultText = txt("result") + "：" + String(result.summary).slice(0, 800);
    else if (view.terminal && result.error) resultText = txt("result") + "：" + result.error;
    resultEl.textContent = resultText;
    resultEl.style.display = resultText ? "block" : "none";

    var detailParts = [];
    var facts = Array.isArray(card.facts) ? card.facts : [];
    for (var i = 0; i < facts.length; i++) {
      var fact = facts[i];
      if (fact && fact.key === "shortTaskId" && fact.value) detailParts.push(txt("task") + " " + String(fact.value).slice(0, 24));
    }
    if (ex.sessionId) detailParts.push(txt("session") + " …" + String(ex.sessionId).slice(-6));
    if (ex.host) detailParts.push(txt("host") + " " + String(ex.host).slice(0, 40));
    detailsEl.textContent = detailParts.join(" · ");
    detailsEl.style.display = detailParts.length ? "block" : "none";

    var consent = view.approval && view.approval.kind === "consent" && view.approval.approveTool && view.approval.taskId;
    var cancellable = !view.terminal && view.status !== "consent_required" && view.capabilities && view.capabilities.cancel === true && view.opRef;
    var refreshable = !view.terminal && (view.status === "running" || view.status === "awaitingApproval") && view.capabilities && view.capabilities.refresh !== false && view.opRef;
    yesBtn.textContent = txt("approve");
    noBtn.textContent = txt("decline");
    stopBtn.textContent = txt("stop");
    yesBtn.style.display = consent ? "inline-block" : "none";
    noBtn.style.display = consent ? "inline-block" : "none";
    stopBtn.style.display = cancellable ? "inline-block" : "none";
    refreshBtn.style.display = refreshable ? "inline-block" : "none";
  }

  function render(card) {
    var outcome = acceptAgentCardView(view, card);
    if (!outcome.ok) return outcome;
    view = outcome.view; // the state machine is pure: adopt the returned view
    errorEl.style.display = "none";
    paint();
    return outcome;
  }

  function showError(error) {
    errorEl.textContent = (error && error.message) || String(error);
    errorEl.style.display = "block";
  }

  async function pollRef(ref) {
    if (!view.provider || !ref) return;
    try { await callTool("spike.agent_status", { provider: view.provider, ref: ref }); }
    catch (e) { if (!view.terminal) showError(e); }
  }

  async function pollNow() {
    if (!view.provider || !view.opRef) return;
    await pollRef(view.opRef);
  }

  async function recover(input) {
    if (!input) return;
    var signature = input.provider + ":" + input.ref;
    if (view.card && view.provider === input.provider && view.opRef === input.ref) return;
    if (signature === recoverAttempt && view.card) return;
    recoverAttempt = signature;
    await pollRef(input.ref);
  }

  yesBtn.onclick = async () => {
    var ap = view.approval;
    if (!ap || !ap.approveTool || !ap.taskId || yesBtn.disabled || noBtn.disabled) return;
    yesBtn.disabled = noBtn.disabled = true;
    chipEl.textContent = txt("starting");
    try {
      var result = await callTool(ap.approveTool, { taskId: ap.taskId });
      var payload = result && result.structuredContent ? result.structuredContent : null;
      var ref = payload ? (payload.agentRef || payload.ref || (payload.taskCard && payload.taskCard.agentRef)) : null;
      if (ref) await pollRef(ref);
      else await pollNow();
    } catch (e) {
      showError(e);
      paint();
    } finally {
      yesBtn.disabled = noBtn.disabled = false;
    }
  };

  noBtn.onclick = async () => {
    var ap = view.approval;
    if (!ap || !ap.rejectTool || !ap.taskId || yesBtn.disabled || noBtn.disabled) return;
    yesBtn.disabled = noBtn.disabled = true;
    try { await callTool(ap.rejectTool, { taskId: ap.taskId }); }
    catch (e) { showError(e); }
    finally {
      yesBtn.disabled = noBtn.disabled = false;
      paint();
    }
  };

  stopBtn.onclick = async () => {
    if (!view.provider || !view.opRef || view.terminal || stopBtn.disabled) return;
    stopBtn.disabled = true;
    chipEl.textContent = txt("cancelling");
    try {
      var cancelRequestId = "agent-card-cancel-" + ((window.crypto && typeof window.crypto.randomUUID === "function") ? window.crypto.randomUUID() : (Date.now() + "-" + Math.random().toString(16).slice(2)));
      await callTool("spike.agent_cancel", { provider: view.provider, ref: view.opRef, requestId: cancelRequestId, expectedTurnId: view.turnRef || view.opRef });
      await pollNow();
    } catch (e) {
      showError(e);
      paint();
    } finally {
      stopBtn.disabled = false;
    }
  };

  refreshBtn.onclick = () => { if (refreshBtn.disabled) return; pollNow(); };

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && pending.has(msg.id)) {
      var entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) entry.reject(msg.error);
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method === "ui/notifications/tool-input" && msg.params) {
      var input = normalizeInput(msg.params.arguments || msg.params);
      if (input) recover(input);
    }
    if (msg.method === "ui/notifications/tool-result" && msg.params) {
      var card = findCard(msg.params);
      if (card) render(card);
    }
    if (/host-context|context-changed/i.test(String(msg.method || ""))) {
      var params = msg.params || {};
      var context = params.context || {};
      var candidate = params.locale || params.language || params.userLocale || context.locale || context.language;
      if (typeof candidate === "string" && candidate) {
        locale = candidate;
        if (view.card) paint();
      }
    }
  }, { passive: true });

  window.addEventListener("openai:set_globals", (event) => {
    var globals = event && event.detail && event.detail.globals || {};
    if (typeof globals.locale === "string" && globals.locale) {
      locale = globals.locale;
      if (view.card) paint();
    }
    if (globals.toolInput) {
      var input = normalizeInput(globals.toolInput);
      if (input) recover(input);
    }
    if (globals.toolOutput) {
      var card = findCard(globals.toolOutput) || findCard(globals);
      if (card) render(card);
    }
  }, { passive: true });

  var initialCard = null;
  if (window.openai) {
    initialCard = findCard(window.openai.toolOutput) || findCard(window.openai.toolResponseMetadata);
  }
  if (initialCard) render(initialCard);
  var initialInput = readToolInput();
  if (initialInput) recover(initialInput);

  hostPoll = setInterval(() => {
    hostPollAttempts += 1;
    if (window.openai && typeof window.openai.locale === "string" && window.openai.locale && window.openai.locale !== locale) {
      locale = window.openai.locale;
      if (view.card) paint();
    }
    var current = window.openai ? (findCard(window.openai.toolOutput) || findCard(window.openai.toolResponseMetadata)) : null;
    if (current) render(current);
    if (!view.card) {
      var lateInput = readToolInput();
      if (lateInput) recover(lateInput);
    }
    if ((current && view.card) || hostPollAttempts >= 40) clearInterval(hostPoll);
  }, 250);
})();
</script>
`.trim();
