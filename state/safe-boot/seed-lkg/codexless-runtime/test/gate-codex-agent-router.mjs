import { createCodexAgentRouter } from "../src/codex-agent-router.mjs";
import { createCodexAgentProvider } from "../src/agent-providers/codex.mjs";
import { composeRegisteredToolHandler } from "../src/mcp-server-factory.mjs";

const SPIKE_PROVIDER_INTERNAL = Symbol.for("spike.bridge.agent-provider.internal");
const results = [];
const record = (name, ok, details = {}) => results.push({ name, ...details, ok: ok === true });
const router = createCodexAgentRouter();
let primaryCalls = 0;
let bCalls = 0;
let lastBStartDelegation = null;
const primary = async (input) => { primaryCalls += 1; return { structuredContent: { lane: "a", ...input } }; };
const bHandlers = new Map();
bHandlers.set("codex.agent_start", async ({ delegation }) => { lastBStartDelegation = delegation ?? null; return { structuredContent: { status: "consent_required", taskId: "C-B-ROUTE", shortTaskId: "C-B-ROUTE" } }; });
bHandlers.set("codex.agent_commit", async ({ taskId }) => { bCalls += 1; return { structuredContent: { taskId, agentRef: "agent_b_route", status: "running" } }; });
bHandlers.set("codex.agent_show", async ({ agentRef }) => { bCalls += 1; return { structuredContent: { agentRef, status: "completed", lane: "b" } }; });
bHandlers.set("codex.agent_send", async ({ agentRef }) => ({ structuredContent: { agentRef, status: "running", lane: "b" } }));
bHandlers.set("codex.agent_cancel", async ({ agentRef }) => ({ structuredContent: { agentRef, status: "interrupted", lane: "b" } }));
bHandlers.set("codex.agent_approve", async ({ agentRef }) => ({ structuredContent: { agentRef, status: "running", lane: "b" } }));
bHandlers.set("codex.agent_reject", async ({ agentRef }) => ({ structuredContent: { agentRef, status: "interrupted", lane: "b" } }));
bHandlers.set("codex.model_list", async () => ({ structuredContent: { models: [{ id: "fixture" }] } }));

const bProvider = createCodexAgentProvider({ id: "codex-b", displayName: "Codex B", handlers: bHandlers, agentExecutor: { running: true }, formalAgentAvailable: true, routeRegistry: router });
const providerDelegation = { basis: "user_requested", rationale: "The router fixture explicitly requests Codex B execution." };
const consent = await bProvider.start({ task: "fixture", options: { delegation: providerDelegation } });
record("provider.forwards-delegation", lastBStartDelegation?.basis === "user_requested" && lastBStartDelegation?.rationale === providerDelegation.rationale, { lastBStartDelegation });
record("provider.binds-task", consent.taskId === "C-B-ROUTE" && router.snapshot().taskRoutes === 1, { consent, routes: router.snapshot() });
record("provider.binds-task-identity", router.resolveProvider("codex.agent_commit", { taskId: "C-B-ROUTE" }) === "codex-b", { provider: router.resolveProvider("codex.agent_commit", { taskId: "C-B-ROUTE" }) });

const commit = await router.wrap("codex.agent_commit", primary)({ taskId: "C-B-ROUTE" });
record("commit.routes-b", commit.structuredContent?.agentRef === "agent_b_route" && bCalls === 1 && primaryCalls === 0, { commit, primaryCalls, bCalls });
record("commit.binds-agent", router.snapshot().agentRoutes === 1, { routes: router.snapshot() });
record("commit.binds-agent-identity", router.resolveProvider("codex.agent_show", { agentRef: "agent_b_route" }) === "codex-b", { provider: router.resolveProvider("codex.agent_show", { agentRef: "agent_b_route" }) });

const shown = await router.wrap("codex.agent_show", primary)({ agentRef: "agent_b_route" });
record("show.routes-b", shown.structuredContent?.lane === "b" && bCalls === 2 && primaryCalls === 0, { shown, primaryCalls, bCalls });

let unknownError = null;
try {
  await router.wrap("codex.agent_show", primary)({ agentRef: "agent_a_unknown" });
} catch (error) {
  unknownError = error;
}
record("unknown.fail-closed", unknownError?.code === "AGENT_ROUTE_UNKNOWN" && primaryCalls === 0, {
  errorCode: unknownError?.code ?? null,
  primaryCalls,
});

const internal = await router.wrap("codex.agent_show", primary)({ agentRef: "agent_b_route", [SPIKE_PROVIDER_INTERNAL]: true });
record("provider-internal-no-cross-route", internal.structuredContent?.lane === "a" && primaryCalls === 1, { internal, primaryCalls, bCalls });

let memoryObserved = 0;
let memoryObservedProvider = null;
const composedShow = composeRegisteredToolHandler({
  name: "codex.agent_show",
  handler: primary,
  codexAgentRouter: router,
  experienceMemory: { observeAgentStatus: ({ provider }) => { memoryObserved += 1; memoryObservedProvider = provider; } },
});
const composed = await composedShow({ agentRef: "agent_b_route" });
record("factory-composition.router-survives-memory", composed.structuredContent?.lane === "b" && bCalls === 3 && primaryCalls === 1 && memoryObserved === 1, { composed, primaryCalls, bCalls, memoryObserved });
record("factory-composition.memory-keeps-b-identity", memoryObservedProvider === "codex-b", { memoryObservedProvider });

// Public Codex A must now register explicit ownership so unknown refs can fail closed safely.
const primaryRouter = createCodexAgentRouter();
let directACalls = 0;
const directAStart = async () => {
  directACalls += 1;
  return { structuredContent: { status: "consent_required", taskId: "C-A-ROUTE", shortTaskId: "C-A-ROUTE" } };
};
const directACommit = async ({ taskId }) => {
  directACalls += 1;
  return { structuredContent: { taskId, agentRef: "agent_a_route", status: "running", lane: "a" } };
};
const directAShow = async ({ agentRef }) => {
  directACalls += 1;
  return { structuredContent: { agentRef, status: "completed", lane: "a" } };
};
const directAConsent = await primaryRouter.wrap("codex.agent_start", directAStart)({ prompt: "fixture-a" });
record("primary.start-binds-a-task", directAConsent.structuredContent?.taskId === "C-A-ROUTE"
  && primaryRouter.resolveProvider("codex.agent_commit", { taskId: "C-A-ROUTE" }) === "codex-a", {
  provider: primaryRouter.resolveProvider("codex.agent_commit", { taskId: "C-A-ROUTE" }),
});
const directACommitted = await primaryRouter.wrap("codex.agent_commit", directACommit)({ taskId: "C-A-ROUTE" });
record("primary.commit-binds-a-agent", directACommitted.structuredContent?.agentRef === "agent_a_route"
  && primaryRouter.resolveProvider("codex.agent_show", { agentRef: "agent_a_route" }) === "codex-a", {
  provider: primaryRouter.resolveProvider("codex.agent_show", { agentRef: "agent_a_route" }),
  directACalls,
});
const directAShown = await primaryRouter.wrap("codex.agent_show", directAShow)({ agentRef: "agent_a_route" });
record("primary.known-a-routes-primary", directAShown.structuredContent?.lane === "a" && directACalls === 3, { directAShown, directACalls });

// Restart recovery: persisted Codex B identities must be rebound before public status/control routing.
const restartRouter = createCodexAgentRouter();
let restartBCalls = 0;
const restartBHandlers = new Map();
restartBHandlers.set("codex.agent_show", async ({ agentRef }) => {
  restartBCalls += 1;
  return { structuredContent: { agentRef, status: "running", lane: "b-recovered" } };
});
restartRouter.bind({
  taskRef: "task_b_persisted",
  shortTaskId: "C-B-PERSISTED",
  agentRef: "agent_b_persisted",
  phase: "active",
}, restartBHandlers, "codex-b");
const restartRouted = await restartRouter.wrap("codex.agent_show", primary)({ agentRef: "agent_b_persisted" });
record("restart.persisted-b-routes-b", restartRouted.structuredContent?.lane === "b-recovered" && restartBCalls === 1, {
  payload: restartRouted.structuredContent,
  restartBCalls,
});
record("restart.persisted-b-keeps-identity", restartRouter.resolveProvider("codex.agent_show", { agentRef: "agent_b_persisted" }) === "codex-b", {
  provider: restartRouter.resolveProvider("codex.agent_show", { agentRef: "agent_b_persisted" }),
});

const restartARouter = createCodexAgentRouter();
restartARouter.bindPrimary({
  taskRef: "task_a_persisted",
  shortTaskId: "C-A-PERSISTED",
  agentRef: "agent_a_persisted",
  phase: "active",
}, "codex-a");
const restartARouted = await restartARouter.wrap("codex.agent_show", primary)({ agentRef: "agent_a_persisted" });
record("restart.persisted-a-routes-a", restartARouted.structuredContent?.lane === "a"
  && restartARouter.resolveProvider("codex.agent_show", { agentRef: "agent_a_persisted" }) === "codex-a", {
  payload: restartARouted.structuredContent,
  provider: restartARouter.resolveProvider("codex.agent_show", { agentRef: "agent_a_persisted" }),
});

const passed = results.filter((r) => r.ok).length;
const out = { gate: "codex-agent-router", result: passed === results.length ? "PASS" : "FAIL", passed, total: results.length, results };
console.log(JSON.stringify(out, null, 2));
if (out.result !== "PASS") process.exitCode = 1;
