import { CodexAgentExecutor } from "../src/codex-agent-executor.mjs";
import {
  assertAgentTaskCapabilityMatch,
  createAgentPreviewState,
  durableAgentCheckpoint,
  durableAtomicJsonWrite,
  inferAgentTaskCapabilities,
  registerAgentPreviewTools,
} from "../src/agent-tools.mjs";
import { preciseEditAuthorized } from "../src/construction-tools.mjs";
import { assertReadOnlyCommandAllowed } from "../src/public-command-policy.mjs";
import { managedLaunchEnv } from "../src/codex-runtime-provider.mjs";
import { createZCodeAgentProvider } from "../src/agent-providers/zcode.mjs";
import { createMacProvider } from "../src/agent-providers/workbee.mjs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePinnedCodex } from "../../../../../runtime/safe-boot/codex-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const codexBin = resolvePinnedCodex(root);
const codexHome = path.join(root, "accounts", "codex-b");
const baseEnv = { ...process.env };
const launchEnv = managedLaunchEnv(baseEnv, codexHome);
const results = [];
const record = (name, ok, details = {}) => results.push({ name, ...details, ok: ok === true });
let executor = null;
try {
  record("identity.home", launchEnv.CODEX_HOME?.toLowerCase() === codexHome.toLowerCase(), { codexHome: launchEnv.CODEX_HOME });
  record("identity.no-api-key", !launchEnv.OPENAI_API_KEY && !launchEnv.CODEX_API_KEY && !launchEnv.AZURE_OPENAI_API_KEY);
  executor = new CodexAgentExecutor({ codexBin, defaultCwd: root, launchEnv, requestTimeoutMs: 20_000 });
  const opened = await executor.open();
  record("app-server.open", executor.running === true, { initialized: Boolean(opened) });
  const catalog = await executor.listModels({ limit: 20, includeHidden: false });
  const ids = Array.isArray(catalog?.models) ? catalog.models.map((m) => m.model || m.id).filter(Boolean) : [];
  record("app-server.models", ids.length > 0, { count: ids.length, first: ids[0] ?? null });
} catch (error) {
  record("runtime.error", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  await executor?.close().catch(() => {});
}

let fakeServerRequestHandler = null;
let fakeRunning = true;
const fakeClient = {
  get running() { return fakeRunning; },
  initializedResult: { ok: true },
  async start() { return this.initializedResult; },
  onNotification() { return () => {}; },
  async request(method) {
    if (method === "thread/start") return { thread: { id: "thread-elicitation" } };
    if (method === "turn/start") return { turn: { id: "turn-elicitation", status: "inProgress" } };
    if (method === "thread/turns/list") return { data: [{ id: "turn-elicitation", status: "inProgress", items: [] }] };
    throw new Error(`unexpected fake App Server method: ${method}`);
  },
  async close() { fakeRunning = false; },
};
const makeServerRequest = ({ id, method = "mcpServer/elicitation/request", request }) => {
  const record = { settled: false, settlement: null };
  const handle = {
    id,
    method,
    params: {
      threadId: "thread-elicitation",
      turnId: "turn-elicitation",
      serverName: "node_repl",
      ...(request ? { request } : {}),
    },
    get settled() { return record.settled; },
    resolve(result) { record.settled = true; record.settlement = { kind: "resolve", result }; },
    reject(error) { record.settled = true; record.settlement = { kind: "reject", error }; },
  };
  return { handle, record };
};
let fakeExecutor = null;
try {
  fakeExecutor = new CodexAgentExecutor({
    defaultCwd: root,
    clientFactory: ({ serverRequestHandler }) => {
      fakeServerRequestHandler = serverRequestHandler;
      return fakeClient;
    },
  });
  await fakeExecutor.open();
  const started = await fakeExecutor.start({ task: "elicitation gate", clientRequestId: "elicitation-gate-start" });
  const agentRef = started.agentRef;

  const binary = makeServerRequest({
    id: "elic-binary",
    request: {
      mode: "form",
      message: "Allow Browser Use to access this origin?",
      requestedSchema: { type: "object", properties: {}, additionalProperties: false },
      _meta: { codex_approval_kind: "mcp_tool_call", codex_sensitive_action: true },
    },
  });
  fakeServerRequestHandler(binary.handle);
  const binaryPending = await fakeExecutor.show({ agentRef });
  record("elicitation.binary.pending", binaryPending.pendingApproval?.method === "mcpServer/elicitation/request"
    && binaryPending.pendingApproval?.details?.kind === "elicitation"
    && binaryPending.pendingApproval?.details?.requiresContent === false,
    { pending: binaryPending.pendingApproval });
  await fakeExecutor.resolveApproval({
    agentRef,
    approvalRequestId: "elic-binary",
    clientRequestId: "elic-binary-approve",
    decision: "approve",
  });
  record("elicitation.binary.approve", binary.record.settlement?.kind === "resolve"
    && binary.record.settlement?.result?.action === "accept"
    && JSON.stringify(binary.record.settlement?.result?.content) === "{}",
    { settlement: binary.record.settlement });

  const form = makeServerRequest({
    id: "elic-form",
    request: {
      mode: "form",
      message: "Choose a workspace label",
      requestedSchema: {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
        additionalProperties: false,
      },
    },
  });
  fakeServerRequestHandler(form.handle);
  const formPending = await fakeExecutor.show({ agentRef });
  record("elicitation.form.pending", formPending.pendingApproval?.details?.requiresContent === true
    && formPending.pendingApproval?.details?.requestedFields?.includes("label"),
    { pending: formPending.pendingApproval });
  let missingContentError = null;
  try {
    await fakeExecutor.resolveApproval({
      agentRef,
      approvalRequestId: "elic-form",
      clientRequestId: "elic-form-missing",
      decision: "approve",
    });
  } catch (error) {
    missingContentError = error instanceof Error ? error.message : String(error);
  }
  record("elicitation.form.missing-content-fails-closed", /requires structured content/i.test(missingContentError ?? "")
    && form.record.settled === false,
    { error: missingContentError });
  await fakeExecutor.resolveApproval({
    agentRef,
    approvalRequestId: "elic-form",
    clientRequestId: "elic-form-approve",
    decision: "approve",
    elicitationContent: { label: "Atlas" },
  });
  record("elicitation.form.approve-with-content", form.record.settlement?.result?.action === "accept"
    && form.record.settlement?.result?.content?.label === "Atlas",
    { settlement: form.record.settlement });

  const rejected = makeServerRequest({
    id: "elic-reject",
    request: {
      mode: "form",
      message: "Allow a sensitive MCP action?",
      requestedSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  });
  fakeServerRequestHandler(rejected.handle);
  await fakeExecutor.resolveApproval({
    agentRef,
    approvalRequestId: "elic-reject",
    clientRequestId: "elic-reject-decline",
    decision: "reject",
  });
  record("elicitation.reject", rejected.record.settlement?.result?.action === "decline", { settlement: rejected.record.settlement });

  const unsupported = makeServerRequest({ id: "unsupported-method", method: "mcpServer/unknown/request", request: {} });
  fakeServerRequestHandler(unsupported.handle);
  record("unsupported-server-request.rejected-immediately", unsupported.record.settlement?.kind === "reject"
    && unsupported.record.settlement?.error?.code === -32601,
    { settlement: unsupported.record.settlement });
} catch (error) {
  record("elicitation.runtime.error", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  await fakeExecutor?.close().catch(() => {});
}

// Long-task control-plane regressions. These are model-free fixtures: no Codex turn is started.
let readOnlyCommandBlocked = null;
try {
  assertReadOnlyCommandAllowed(["cmd.exe", "/d", "/c", "copy", "a.txt", "b.txt"], { permissionProfile: ":read-only" });
} catch (error) {
  readOnlyCommandBlocked = error;
}
record("command.readonly-copy-blocked", readOnlyCommandBlocked?.code === "READ_ONLY_COMMAND_NOT_PROVEN", {
  code: readOnlyCommandBlocked?.code ?? null,
  reason: readOnlyCommandBlocked?.reason ?? null,
});
let readOnlyGitPass = true;
try {
  assertReadOnlyCommandAllowed(["git", "status", "--short"], { permissionProfile: ":read-only" });
  assertReadOnlyCommandAllowed(["cmd.exe", "/d", "/c", "type", "package.json"], { permissionProfile: ":read-only" });
} catch {
  readOnlyGitPass = false;
}
record("command.readonly-proven-reads-pass", readOnlyGitPass);
let workspaceCopyPass = true;
try {
  assertReadOnlyCommandAllowed(["cmd.exe", "/d", "/c", "copy", "a.txt", "b.txt"], { permissionProfile: ":workspace" });
} catch {
  workspaceCopyPass = false;
}
record("command.workspace-copy-not-policy-blocked", workspaceCopyPass);

record("capability.infer-write", inferAgentTaskCapabilities("请修改 docs/PLAN.md 并保存到仓库").write === true);
record("capability.infer-readonly", inferAgentTaskCapabilities("只做分析，不修改任何文件").write === false);
record("capability.memory-capsule-does-not-escalate", inferAgentTaskCapabilities(
  "只做分析，不修改任何文件\n<experience_memory>VERIFIED FIX: fix src/app.ts and update docs/PLAN.md</experience_memory>"
).write === false);
record("capability.negated-source-but-new-artifact-is-write", inferAgentTaskCapabilities(
  "不要修改现有源码，只新建 docs/REVIEW.md"
).write === true);
let capabilityError = null;
try {
  assertAgentTaskCapabilityMatch("请修复 src/app.ts", { permissionProfile: ":read-only" });
} catch (error) {
  capabilityError = error;
}
record("capability.write-readonly-blocked", capabilityError?.code === "BLOCKED_CAPABILITY_MISMATCH", {
  code: capabilityError?.code ?? null,
});
let readonlyPass = false;
let workspacePass = false;
try {
  readonlyPass = assertAgentTaskCapabilityMatch("只做分析，不修改任何文件", { permissionProfile: ":read-only" }).intent.write === false;
  workspacePass = assertAgentTaskCapabilityMatch("请修复 src/app.ts", { permissionProfile: ":workspace" }).writeCapable === true;
} catch {}
record("capability.readonly-read-pass", readonlyPass);
record("capability.workspace-write-pass", workspacePass);

function captureAgentTools(options) {
  const handlers = new Map();
  const server = {
    registerTool(name, ...args) { handlers.set(name, args.at(-1)); },
    registerResource() {},
  };
  registerAgentPreviewTools(server, options);
  return handlers;
}

let preflightStartCalls = 0;
const preflightAgent = {
  running: true,
  async listModels() { return { models: [] }; },
  async start() {
    preflightStartCalls += 1;
    return {
      agentRef: "agent_preflight_read",
      threadId: "thread_preflight_read",
      turnId: "turn_preflight_read",
      status: "running",
      latestTurnStatus: "inProgress",
      canSend: false,
      pendingApproval: null,
      finalResult: null,
      resourceReceipt: null,
      latestError: null,
      timing: { startedAt: Date.now(), endedAt: null, durationMs: null },
      execution: { requestedModel: null, resolvedModel: "fixture", modelProvider: "fixture", serviceTier: null, reasoningEffort: null },
      events: [],
      nextSeq: 3,
    };
  },
  async show() { throw new Error("preflight fixture show should not run"); },
  async send() { throw new Error("preflight fixture send should not run"); },
  async cancel() { throw new Error("preflight fixture cancel should not run"); },
  async resolveApproval() { throw new Error("preflight fixture approval should not run"); },
};
const readOnlyAuthority = {
  async resolveAuthority({ cwd }) {
    return {
      effectiveCwd: path.resolve(cwd ?? root),
      permissionProfile: ":read-only",
      permissionCeiling: ":read-only",
      authoritySource: "fixture-read-only",
      trustedAncestor: path.resolve(cwd ?? root),
    };
  },
};
const preflightHandlers = captureAgentTools({
  agentExecutor: preflightAgent,
  authorityExecutor: readOnlyAuthority,
  meteredConsentMode: "off",
  agentPreviewState: createAgentPreviewState({ meteredConsentMode: "off" }),
});
const blockedStart = await preflightHandlers.get("codex.agent_start")({
  prompt: "请修改 docs/P0.md 并保存到仓库",
  requestId: "preflight-write-blocked",
  cwd: root,
});
record("preflight.write-blocks-before-agent-start", blockedStart?.structuredContent?.errorCode === "BLOCKED_CAPABILITY_MISMATCH" && preflightStartCalls === 0, {
  errorCode: blockedStart?.structuredContent?.errorCode ?? null,
  startCalls: preflightStartCalls,
});
const allowedReadStart = await preflightHandlers.get("codex.agent_start")({
  prompt: "只做分析，不修改任何文件",
  requestId: "preflight-read-allowed",
  cwd: root,
});
record("preflight.readonly-task-can-start", allowedReadStart?.structuredContent?.status === "running" && preflightStartCalls === 1, {
  status: allowedReadStart?.structuredContent?.status ?? null,
  startCalls: preflightStartCalls,
});
const ambiguousHandlers = captureAgentTools({
  agentExecutor: preflightAgent,
  authorityExecutor: {
    async resolveAuthority() {
      throw new Error("authority resolver capability gate failed closed: activePermissionProfile is null and config/read provides no explicit default_permissions provenance");
    },
  },
  meteredConsentMode: "off",
  agentPreviewState: createAgentPreviewState({ meteredConsentMode: "off" }),
});
const ambiguousStart = await ambiguousHandlers.get("codex.agent_start")({
  prompt: "只做分析，不修改任何文件",
  requestId: "preflight-ambiguous-blocked",
  cwd: root,
});
record("preflight.ambiguous-authority-blocks-before-start", ambiguousStart?.structuredContent?.errorCode === "BLOCKED_AMBIGUOUS_AUTHORITY"
  && preflightStartCalls === 1, {
  errorCode: ambiguousStart?.structuredContent?.errorCode ?? null,
  startCalls: preflightStartCalls,
});

let supervisionLiveness = "STALLED";
const supervisionHandlers = captureAgentTools({
  agentExecutor: {
    running: true,
    async listModels() { return { models: [] }; },
    async show({ agentRef }) {
      return {
        agentRef,
        threadId: "thread-supervision",
        turnId: "turn-supervision",
        status: "running",
        latestTurnStatus: "inProgress",
        liveness: { state: supervisionLiveness },
        canSend: false,
        pendingApproval: null,
        finalResult: null,
        resourceReceipt: null,
        latestError: null,
        lastErrorEvent: null,
        timing: { startedAt: Date.now() - 10_000, endedAt: null, durationMs: null },
        execution: { requestedModel: null, resolvedModel: "fixture", modelProvider: "fixture", serviceTier: null, reasoningEffort: null },
        events: [],
        nextSeq: 1,
      };
    },
    async start() { throw new Error("not used"); },
    async send() { throw new Error("not used"); },
    async cancel() { throw new Error("not used"); },
    async resolveApproval() { throw new Error("not used"); },
  },
  authorityExecutor: readOnlyAuthority,
  meteredConsentMode: "off",
  agentPreviewState: createAgentPreviewState({ meteredConsentMode: "off" }),
});
const stalledSupervision = await supervisionHandlers.get("codex.agent_show")({ agentRef: "agent-supervision", afterSeq: 0 });
record("supervision.stalled-reconciles", stalledSupervision?.structuredContent?.nextAction?.kind === "reconcile_agent"
  && stalledSupervision?.structuredContent?.supervisionRequired === true, {
  nextAction: stalledSupervision?.structuredContent?.nextAction,
});
supervisionLiveness = "COMPLETING";
const completingSupervision = await supervisionHandlers.get("codex.agent_show")({ agentRef: "agent-supervision", afterSeq: 0 });
record("supervision.completing-rechecks-terminal", completingSupervision?.structuredContent?.nextAction?.kind === "recheck_terminal", {
  nextAction: completingSupervision?.structuredContent?.nextAction,
});

const longResult = "完整长任务结果\n".repeat(4_000);
const checkpointEvents = Array.from({ length: 40 }, (_, index) => ({
  seq: index + 1,
  type: "fixture/event",
  at: 1_000 + index,
  turnId: "turn_checkpoint",
  text: `event-${index + 1}`,
  secretField: "must-not-persist",
}));
const checkpoint = durableAgentCheckpoint({
  taskRef: "task_checkpoint",
  agentRef: "agent_checkpoint",
  threadId: "thread_checkpoint",
  turnId: "turn_checkpoint",
  status: "running",
  latestTurnStatus: "inProgress",
  finalResult: longResult,
  latestError: null,
  liveness: { state: "RUNNING_QUIET", lastProviderEventAt: 1234 },
  events: checkpointEvents,
  nextSeq: 95_257,
});
record("checkpoint.full-result", checkpoint?.checkpointVersion === 2
  && checkpoint?.resultCompleteness === "full"
  && checkpoint?.finalResult === longResult, {
  checkpointVersion: checkpoint?.checkpointVersion ?? null,
  completeness: checkpoint?.resultCompleteness ?? null,
  length: checkpoint?.finalResult?.length ?? 0,
});
record("checkpoint.thread-turn-cursor", checkpoint?.threadId === "thread_checkpoint" && checkpoint?.turnId === "turn_checkpoint" && checkpoint?.nextSeq === 95_257, {
  threadId: checkpoint?.threadId,
  turnId: checkpoint?.turnId,
  nextSeq: checkpoint?.nextSeq,
});
record("checkpoint.event-tail-bounded", checkpoint?.events?.length === 32
  && checkpoint.events[0]?.seq === 9
  && checkpoint.events.at(-1)?.seq === 40
  && !Object.hasOwn(checkpoint.events[0] ?? {}, "secretField"), {
  length: checkpoint?.events?.length ?? null,
  firstSeq: checkpoint?.events?.[0]?.seq ?? null,
  lastSeq: checkpoint?.events?.at(-1)?.seq ?? null,
});
record("checkpoint.error-not-result", durableAgentCheckpoint({ latestError: "provider failed" })?.finalResult === null);

const durableWriteTrace = [];
let durableTmpPresent = false;
const durableWriteOps = {
  mkdirSync() { durableWriteTrace.push("mkdir"); },
  openSync(_path, flags) {
    durableWriteTrace.push(`open:${flags}`);
    if (flags === "wx") {
      durableTmpPresent = true;
      return 10;
    }
    return 11;
  },
  writeFileSync(fd, data) { durableWriteTrace.push(`write:${fd}:${String(data).includes('"ok":true')}`); },
  fsyncSync(fd) { durableWriteTrace.push(`fsync:${fd}`); },
  closeSync(fd) { durableWriteTrace.push(`close:${fd}`); },
  renameSync() { durableWriteTrace.push("rename"); durableTmpPresent = false; },
  existsSync() { return durableTmpPresent; },
  unlinkSync() { durableWriteTrace.push("unlink"); durableTmpPresent = false; },
};
durableAtomicJsonWrite(path.join(os.tmpdir(), "durable-agent-state-fixture.json"), { ok: true }, durableWriteOps);
record("persistence.durable-write-order", durableWriteTrace.join(",") === [
  "mkdir",
  "open:wx",
  "write:10:true",
  "fsync:10",
  "close:10",
  "rename",
  "open:r+",
  "fsync:11",
  "close:11",
].join(","), { trace: durableWriteTrace });

const durableFailureTrace = [];
let failureTmpPresent = false;
const durableFailureOps = {
  mkdirSync() { durableFailureTrace.push("mkdir"); },
  openSync(_path, flags) { failureTmpPresent = true; durableFailureTrace.push(`open:${flags}`); return 20; },
  writeFileSync() { durableFailureTrace.push("write"); },
  fsyncSync() { durableFailureTrace.push("fsync"); },
  closeSync() { durableFailureTrace.push("close"); },
  renameSync() { durableFailureTrace.push("rename"); throw new Error("fixture rename failure"); },
  existsSync() { return failureTmpPresent; },
  unlinkSync() { durableFailureTrace.push("unlink"); failureTmpPresent = false; },
};
let durableFailure = null;
try {
  durableAtomicJsonWrite(path.join(os.tmpdir(), "durable-agent-state-failure.json"), { ok: false }, durableFailureOps);
} catch (error) {
  durableFailure = error;
}
record("persistence.durable-write-cleans-temp-on-failure", durableFailure?.message === "fixture rename failure"
  && failureTmpPresent === false
  && durableFailureTrace.at(-1) === "unlink", {
  trace: durableFailureTrace,
  error: durableFailure?.message ?? null,
});

let lifecycleNotification = null;
let lifecycleTurn = { id: "turn-lifecycle", status: "inProgress", items: [] };
let lifecycleRuntimeStatus = { type: "active", activeFlags: [] };
const lifecycleCalls = [];
const lifecycleTurnListParams = [];
const lifecycleClient = {
  running: true,
  initializedResult: { ok: true },
  serverRequestMethods: [],
  async start() { return this.initializedResult; },
  onNotification(listener) { lifecycleNotification = listener; return () => {}; },
  async request(method, params) {
    lifecycleCalls.push(method);
    if (method === "thread/start") return { thread: { id: "thread-lifecycle" }, activePermissionProfile: { id: ":read-only" } };
    if (method === "turn/start") return { turn: { id: "turn-lifecycle", status: "inProgress" } };
    if (method === "thread/read") return { thread: { id: "thread-lifecycle", status: structuredClone(lifecycleRuntimeStatus) } };
    if (method === "thread/turns/list") {
      lifecycleTurnListParams.push(structuredClone(params ?? {}));
      return { data: [structuredClone(lifecycleTurn)] };
    }
    if (method === "model/list") return { data: [] };
    throw new Error(`unexpected lifecycle method: ${method}`);
  },
  async close() {},
};
let lifecycleExecutor = null;
try {
  lifecycleExecutor = new CodexAgentExecutor({ defaultCwd: root, clientFactory: () => lifecycleClient });
  await lifecycleExecutor.open();
  const startedLifecycle = await lifecycleExecutor.start({
    task: "只读生命周期 fixture",
    clientRequestId: "lifecycle-start",
    permissionProfile: ":read-only",
  });
  const lifecycleRef = startedLifecycle.agentRef;
  lifecycleNotification({
    method: "error",
    params: { threadId: "thread-lifecycle", turnId: "turn-lifecycle", error: { message: "fixture transient error" }, willRetry: true },
  });
  let lifecycleShown = await lifecycleExecutor.show({ agentRef: lifecycleRef });
  record("lifecycle.error-visible", lifecycleShown.latestError === "fixture transient error"
    && lifecycleShown.lastErrorEvent?.retryable === true
    && lifecycleShown.liveness?.state === "RUNNING_DEGRADED", {
    latestError: lifecycleShown.latestError,
    liveness: lifecycleShown.liveness?.state,
  });
  lifecycleNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-lifecycle", turnId: "turn-lifecycle", delta: "recovered" },
  });
  lifecycleShown = await lifecycleExecutor.show({ agentRef: lifecycleRef });
  record("lifecycle.retryable-error-clears-after-activity", lifecycleShown.latestError === null
    && lifecycleShown.lastErrorEvent?.message === "fixture transient error"
    && lifecycleShown.liveness?.state === "RUNNING_ACTIVE", {
    latestError: lifecycleShown.latestError,
    lastError: lifecycleShown.lastErrorEvent?.message,
    liveness: lifecycleShown.liveness?.state,
  });

  const finalBody = "最终正文\n".repeat(2_000);
  lifecycleNotification({
    method: "item/completed",
    params: {
      threadId: "thread-lifecycle",
      turnId: "turn-lifecycle",
      item: { id: "answer-final", type: "agentMessage", phase: "final_answer", text: finalBody },
    },
  });
  lifecycleRuntimeStatus = { type: "idle" };
  lifecycleNotification({
    method: "thread/status/changed",
    params: { threadId: "thread-lifecycle", status: { type: "idle" } },
  });
  lifecycleShown = await lifecycleExecutor.show({ agentRef: lifecycleRef });
  record("lifecycle.idle-is-completing-not-terminal", lifecycleShown.status === "running"
    && lifecycleShown.canSend === false
    && lifecycleShown.liveness?.state === "COMPLETING"
    && lifecycleShown.finalResult === finalBody, {
    status: lifecycleShown.status,
    liveness: lifecycleShown.liveness?.state,
  });

  lifecycleNotification({
    method: "item/completed",
    params: {
      threadId: "thread-lifecycle",
      turnId: "old-turn",
      item: { id: "stale-answer", type: "agentMessage", phase: "final_answer", text: "STALE_POISON" },
    },
  });
  lifecycleShown = await lifecycleExecutor.show({ agentRef: lifecycleRef });
  record("lifecycle.stale-turn-cannot-overwrite", lifecycleShown.finalResult === finalBody);

  lifecycleTurn = {
    id: "turn-lifecycle",
    status: "completed",
    items: [{ id: "commentary-only", type: "agentMessage", phase: "commentary", text: "commentary" }],
  };
  lifecycleNotification({
    method: "turn/completed",
    params: { threadId: "thread-lifecycle", turn: { id: "turn-lifecycle", status: "completed", items: [] } },
  });
  lifecycleShown = await lifecycleExecutor.show({ agentRef: lifecycleRef });
  record("lifecycle.terminal-does-not-erase-final", lifecycleShown.status === "idle" && lifecycleShown.finalResult === finalBody, {
    status: lifecycleShown.status,
    resultLength: lifecycleShown.finalResult?.length ?? 0,
  });
  record("lifecycle.status-read-no-resume", !lifecycleCalls.includes("thread/resume"), { calls: lifecycleCalls });
  record("lifecycle.turn-history-is-full", lifecycleTurnListParams.length > 0
    && lifecycleTurnListParams.every((params) => params.itemsView === "full"), { params: lifecycleTurnListParams });
} catch (error) {
  record("lifecycle.runtime.error", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  await lifecycleExecutor?.close().catch(() => {});
}

let reattachTurnStartCalls = 0;
const reattachClient = {
  running: true,
  initializedResult: { ok: true },
  serverRequestMethods: [],
  async start() { return this.initializedResult; },
  onNotification() { return () => {}; },
  async request(method, params) {
    if (method === "turn/start") { reattachTurnStartCalls += 1; throw new Error("reattach must never start a turn"); }
    if (method === "thread/read") return { thread: { id: "thread-reattach", status: { type: "active", activeFlags: [] } } };
    if (method === "thread/turns/list") {
      if (params?.itemsView !== "full") throw new Error("reattach requires full turn items");
      return { data: [{ id: "turn-reattach", status: "inProgress", items: [] }] };
    }
    throw new Error(`unexpected reattach method: ${method}`);
  },
  async close() {},
};
let reattachExecutor = null;
try {
  reattachExecutor = new CodexAgentExecutor({ defaultCwd: root, clientFactory: () => reattachClient });
  await reattachExecutor.open();
  const reattached = await reattachExecutor.reattach({
    agentRef: "agent-reattach",
    threadId: "thread-reattach",
    turnId: "turn-reattach",
    cwd: root,
    permissionProfile: ":read-only",
    timing: { startedAt: Date.now() - 10_000, endedAt: null, durationMs: null },
    execution: { requestedModel: "fixture", resolvedModel: "fixture", reasoningEffort: "low" },
    nextSeq: 91,
  });
  record("reattach.same-ref-turn-no-replay", reattached.agentRef === "agent-reattach"
    && reattached.threadId === "thread-reattach"
    && reattached.turnId === "turn-reattach"
    && reattached.status === "running"
    && reattachTurnStartCalls === 0, {
    status: reattached.status,
    turnStartCalls: reattachTurnStartCalls,
  });
} catch (error) {
  record("reattach.runtime.error", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  await reattachExecutor?.close().catch(() => {});
}

let missingTurnStartCalls = 0;
const missingTurnClient = {
  running: true,
  initializedResult: { ok: true },
  serverRequestMethods: [],
  async start() { return this.initializedResult; },
  onNotification() { return () => {}; },
  async request(method, params) {
    if (method === "turn/start") { missingTurnStartCalls += 1; throw new Error("missing-turn reconciliation must not replay"); }
    if (method === "thread/read") return { thread: { id: "thread-missing-turn", status: { type: "notLoaded" } } };
    if (method === "thread/turns/list") {
      if (params?.itemsView !== "full") throw new Error("missing-turn reconciliation requires full turn items");
      return { data: [] };
    }
    throw new Error(`unexpected missing-turn method: ${method}`);
  },
  async close() {},
};
let missingTurnExecutor = null;
try {
  missingTurnExecutor = new CodexAgentExecutor({ defaultCwd: root, clientFactory: () => missingTurnClient });
  await missingTurnExecutor.open();
  const uncertain = await missingTurnExecutor.reattach({
    agentRef: "agent-missing-turn",
    threadId: "thread-missing-turn",
    turnId: "turn-missing-turn",
    cwd: root,
    permissionProfile: ":read-only",
    timing: { startedAt: Date.now() - 10_000, endedAt: null, durationMs: null },
    nextSeq: 12,
  });
  record("reattach.missing-turn-becomes-uncertain", uncertain.status === "unknown"
    && uncertain.canSend === false
    && /no longer contains the current turn/i.test(uncertain.latestError ?? "")
    && missingTurnStartCalls === 0, {
    status: uncertain.status,
    error: uncertain.latestError,
    turnStartCalls: missingTurnStartCalls,
  });
} catch (error) {
  record("reattach.missing-turn.runtime.error", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  await missingTurnExecutor?.close().catch(() => {});
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "spike-bridge-p0-"));
try {
  const target = path.join(tempRoot, "guard.txt");
  await writeFile(target, "before", "utf8");
  const guardAuthority = {
    async resolveAuthority() {
      return { effectiveCwd: tempRoot, trustedAncestor: tempRoot, permissionProfile: ":read-only" };
    },
  };
  let editError = null;
  try {
    await preciseEditAuthorized({
      authorityExecutor: guardAuthority,
      path: target,
      expectedText: "before",
      replacementText: "after",
      cwd: tempRoot,
    });
  } catch (error) {
    editError = error;
  }
  record("construction.readonly-write-blocked", editError?.code === "PERMISSION_APPROVAL_REQUIRED"
    && await readFile(target, "utf8") === "before", { code: editError?.code ?? null });
  const preview = await preciseEditAuthorized({
    authorityExecutor: guardAuthority,
    path: target,
    expectedText: "before",
    replacementText: "after",
    cwd: tempRoot,
    previewOnly: true,
  });
  record("construction.readonly-preview-allowed", preview?.status === "preview" && await readFile(target, "utf8") === "before");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

const legacyPersistenceRoot = await mkdtemp(path.join(os.tmpdir(), "spike-bridge-legacy-task-state-"));
try {
  const legacyStateFile = path.join(legacyPersistenceRoot, "agent-task-cards.json");
  const legacySummary = "L".repeat(600);
  await writeFile(legacyStateFile, JSON.stringify({
    version: 1,
    records: [
      {
        taskRef: "task-legacy-terminal",
        phase: "terminal",
        updatedAt: Date.now(),
        terminalSnapshot: {
          agentRef: "agent-legacy-terminal",
          turnId: "turn-legacy-terminal",
          status: "completed",
          finalResult: legacySummary,
          resultSummary: legacySummary,
          terminal: true,
          events: [],
          nextSeq: 0,
        },
      },
      {
        taskRef: "task-legacy-active",
        phase: "active",
        updatedAt: Date.now(),
        terminalSnapshot: {
          agentRef: "agent-legacy-active",
          turnId: "turn-legacy-active",
          status: "running",
          finalResult: null,
          resultSummary: null,
          terminal: false,
          events: [],
          nextSeq: 0,
        },
      },
    ],
  }));
  const legacyState = createAgentPreviewState({ meteredConsentMode: "off", taskStateFile: legacyStateFile });
  const legacyTerminal = legacyState.taskPersistence.get("task-legacy-terminal")?.terminalSnapshot;
  record("persistence.legacy-v1-summary-not-full-result", legacyTerminal?.checkpointVersion === 1
    && legacyTerminal?.finalResult === null
    && legacyTerminal?.resultSummary === legacySummary
    && legacyTerminal?.resultCompleteness === "summary_only_legacy_v1", {
    checkpointVersion: legacyTerminal?.checkpointVersion ?? null,
    completeness: legacyTerminal?.resultCompleteness ?? null,
    finalResult: legacyTerminal?.finalResult ?? null,
    summaryLength: legacyTerminal?.resultSummary?.length ?? null,
  });
  const legacyActive = legacyState.taskPersistence.get("task-legacy-active");
  record("persistence.legacy-v1-active-slot-normalized", legacyActive?.activeSnapshot?.status === "running"
    && legacyActive?.terminalSnapshot === null
    && legacyActive?.activeSnapshot?.checkpointVersion === 1, {
    activeStatus: legacyActive?.activeSnapshot?.status ?? null,
    terminalSnapshot: legacyActive?.terminalSnapshot ?? null,
  });
} finally {
  await rm(legacyPersistenceRoot, { recursive: true, force: true });
}

const persistenceRoot = await mkdtemp(path.join(os.tmpdir(), "spike-bridge-reattach-"));
try {
  const taskStateFile = path.join(persistenceRoot, "agent-task-cards.json");
  const persistedSnapshot = {
    agentRef: "agent-persisted",
    threadId: "thread-persisted",
    turnId: "turn-persisted",
    status: "running",
    latestTurnStatus: "inProgress",
    canSend: false,
    pendingApproval: null,
    finalResult: null,
    resourceReceipt: null,
    latestError: null,
    lastErrorEvent: null,
    liveness: { state: "RUNNING_ACTIVE", lastProviderEventAt: Date.now(), lastMeaningfulEventAt: Date.now() },
    timing: { startedAt: Date.now() - 5_000, endedAt: null, durationMs: null },
    execution: { requestedModel: null, resolvedModel: "fixture", modelProvider: "fixture", serviceTier: null, reasoningEffort: null },
    events: [],
    nextSeq: 77,
  };
  let firstStartCalls = 0;
  const firstAgent = {
    running: true,
    async listModels() { return { models: [] }; },
    async start() { firstStartCalls += 1; return structuredClone(persistedSnapshot); },
    async show() { return structuredClone(persistedSnapshot); },
    async send() { throw new Error("not used"); },
    async cancel() { throw new Error("not used"); },
    async resolveApproval() { throw new Error("not used"); },
  };
  const firstHandlers = captureAgentTools({
    agentExecutor: firstAgent,
    authorityExecutor: readOnlyAuthority,
    meteredConsentMode: "off",
    agentPreviewState: createAgentPreviewState({ meteredConsentMode: "off", taskStateFile }),
  });
  const firstStart = await firstHandlers.get("codex.agent_start")({
    prompt: "只做分析，不修改任何文件",
    requestId: "persisted-start",
    cwd: root,
  });
  record("persistence.active-checkpoint-written", firstStart?.structuredContent?.agentRef === "agent-persisted" && firstStartCalls === 1);
  const persistedFile = JSON.parse(await readFile(taskStateFile, "utf8"));
  const persistedRecord = persistedFile.records?.find((entry) => entry?.agentRef === "agent-persisted");
  record("persistence.checkpoint-v2-keeps-rollback-envelope", persistedFile.version === 1
    && persistedRecord?.activeSnapshot?.checkpointVersion === 2
    && persistedRecord?.activeSnapshot?.threadId === "thread-persisted"
    && persistedRecord?.activeSnapshot?.turnId === "turn-persisted"
    && persistedRecord?.activeSnapshot?.nextSeq === 77, {
    storeVersion: persistedFile.version ?? null,
    checkpointVersion: persistedRecord?.activeSnapshot?.checkpointVersion ?? null,
    threadId: persistedRecord?.activeSnapshot?.threadId ?? null,
    turnId: persistedRecord?.activeSnapshot?.turnId ?? null,
    nextSeq: persistedRecord?.activeSnapshot?.nextSeq ?? null,
  });

  let restartStartCalls = 0;
  let restartReattachCalls = 0;
  const restartAgent = {
    running: true,
    async listModels() { return { models: [] }; },
    async start() { restartStartCalls += 1; throw new Error("restart recovery must not replay start"); },
    async reattach(input) {
      restartReattachCalls += 1;
      return { ...structuredClone(persistedSnapshot), ...input, status: "running", latestTurnStatus: "inProgress", reattached: true };
    },
    async show() { return structuredClone(persistedSnapshot); },
    async send() { throw new Error("not used"); },
    async cancel() { throw new Error("not used"); },
    async resolveApproval() { throw new Error("not used"); },
  };
  const restartHandlers = captureAgentTools({
    agentExecutor: restartAgent,
    authorityExecutor: readOnlyAuthority,
    meteredConsentMode: "off",
    agentPreviewState: createAgentPreviewState({ meteredConsentMode: "off", taskStateFile }),
  });
  const recoveredStatus = await restartHandlers.get("codex.agent_show")({ agentRef: "agent-persisted", afterSeq: 0 });
  record("persistence.restart-reattaches-not-lost", recoveredStatus?.structuredContent?.status === "running"
    && recoveredStatus?.structuredContent?.threadId === "thread-persisted"
    && restartReattachCalls === 1
    && restartStartCalls === 0, {
    status: recoveredStatus?.structuredContent?.status ?? null,
    reattachCalls: restartReattachCalls,
    startCalls: restartStartCalls,
  });
} finally {
  await rm(persistenceRoot, { recursive: true, force: true });
}

const zcodeDurableRoot = await mkdtemp(path.join(os.tmpdir(), "spike-zcode-idempotency-"));
try {
  const cli = path.join(zcodeDurableRoot, "fake.cjs");
  const countFile = path.join(zcodeDurableRoot, "count.txt");
  const stateFile = path.join(zcodeDurableRoot, "jobs.json");
  await writeFile(cli, `const fs=require('fs');const p=${JSON.stringify(countFile)};let n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));console.log(JSON.stringify({sessionId:'sess-1',response:'ok'}));`);
  const makeProvider = () => createZCodeAgentProvider({ cliPath: cli, nodePath: process.execPath, defaultCwd: zcodeDurableRoot, stateFile, legacyStateFile: path.join(zcodeDurableRoot, "none.json"), defaultMode: "plan" });
  const firstProvider = makeProvider();
  const first = await firstProvider.start({ task: "same task", project: zcodeDurableRoot, options: { mode: "plan", requestId: "zcode-durable-1" } });
  let firstDone = null;
  let countText = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    firstDone = await firstProvider.status(first.ref);
    countText = await readFile(countFile, "utf8").catch(() => null);
    if (firstDone.status === "completed" && countText !== null) break;
  }
  const restartedProvider = makeProvider();
  const replay = await restartedProvider.start({ task: "same task", project: zcodeDurableRoot, options: { mode: "plan", requestId: "zcode-durable-1" } });
  let conflictCode = null;
  try {
    await restartedProvider.start({ task: "different task", project: zcodeDurableRoot, options: { mode: "plan", requestId: "zcode-durable-1" } });
  } catch (error) {
    conflictCode = error?.code ?? null;
  }
  const spawnCount = Number(countText ?? await readFile(countFile, "utf8"));
  record("zcode.restart-idempotency", spawnCount === 1 && replay.ref === first.ref && firstDone.status === "completed" && conflictCode === "AGENT_REQUEST_ID_CONFLICT", {
    spawnCount, firstRef: first.ref, replayRef: replay.ref, conflictCode,
  });
} finally {
  await rm(zcodeDurableRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

const macDurableRoot = await mkdtemp(path.join(os.tmpdir(), "spike-mac-idempotency-"));
let macFixtureServer = null;
try {
  const secretFile = path.join(macDurableRoot, "pairing.secret");
  await writeFile(secretFile, "fixture-secret");
  const tasks = new Map();
  let submitCount = 0;
  macFixtureServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    if (req.method === "POST" && req.url === "/api/submit") {
      submitCount += 1;
      if (tasks.has(body.taskId)) { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, duplicate: true })); return; }
      tasks.set(body.taskId, body); res.writeHead(202, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, taskId: body.taskId })); return;
    }
    const poll = req.url?.match(/^\/api\/poll\/(.+)$/);
    if (req.method === "GET" && poll) {
      const id = decodeURIComponent(poll[1]);
      if (!tasks.has(id)) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
      res.writeHead(202, { "content-type": "application/json" }); res.end(JSON.stringify({ state: "queued" })); return;
    }
    if (req.method === "GET" && /^\/api\/card\//.test(req.url ?? "")) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
    res.writeHead(404, { "content-type": "application/json" }); res.end("{}");
  });
  await new Promise((resolve) => macFixtureServer.listen(0, "127.0.0.1", resolve));
  const port = macFixtureServer.address().port;
  const makeProvider = () => createMacProvider({ bridgeBase: `http://127.0.0.1:${port}`, secretFile, defaultCwd: macDurableRoot, bridgeRoot: macDurableRoot });
  const first = await makeProvider().start({ task: "same task", project: macDurableRoot, options: { requestId: "mac-durable-1" } });
  const replay = await makeProvider().start({ task: "different ignored params", project: path.join(macDurableRoot, "other"), options: { requestId: "mac-durable-1" } });
  record("mac.restart-idempotency", first.ref === replay.ref && tasks.size === 1 && replay.idempotentReplay === true, {
    submitCount, uniqueTasks: tasks.size, firstRef: first.ref, replayRef: replay.ref,
  });
} finally {
  if (macFixtureServer) await new Promise((resolve) => macFixtureServer.close(resolve));
  await rm(macDurableRoot, { recursive: true, force: true });
}

const passed = results.filter((r) => r.ok).length;
const out = { gate: "codex-b-runtime", result: passed === results.length ? "PASS" : "FAIL", passed, total: results.length, results };
console.log(JSON.stringify(out, null, 2));
if (out.result !== "PASS") process.exitCode = 1;
