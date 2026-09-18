import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExperienceMemory } from "../src/memory/index.mjs";
import { registerSpikeAgentTools } from "../src/spike-agent-tools.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const gateRoot = path.join(path.resolve(here, ".."), "tmp", `memory-integration-${process.pid}-${Date.now()}`);
fs.mkdirSync(gateRoot, { recursive: true });
const memory = new ExperienceMemory({ dbPath: path.join(gateRoot, "experience.db"), seed: true });
const handlers = new Map();
const fakeServer = {
  registerTool(name, _meta, handler) { handlers.set(name, handler); },
};

const state = { startCalls: 0, sendCalls: 0, lastTask: null, status: "running", failure: null, learning: null };
const provider = {
  id: "codex",
  async start({ task }) {
    state.startCalls += 1;
    state.lastTask = task;
    return { provider: "codex", ref: state.startCalls === 1 ? "agent_memory_gate" : "agent_memory_gate_" + state.startCalls, status: "running", task };
  },
  async status(ref) {
    if (state.status === "failed") {
      return { provider: "codex", ref, status: "failed", error: "httpx localhost returned HTTP 502 through proxy", errorCode: "HTTP_502", ...state.failure };
    }
    return { provider: "codex", ref, status: state.status, ...state.learning };
  },
  async send(ref, message) {
    state.sendCalls += 1;
    return { provider: "codex", ref, status: "running", response: message };
  },
  async cancel(ref) { return { provider: "codex", ref, status: "interrupted" }; },
};
const registry = {
  require(id) {
    if (id !== "codex") {
      const error = new Error(`unknown provider: ${id}`);
      error.code = "AGENT_PROVIDER_UNKNOWN";
      throw error;
    }
    return provider;
  },
};

registerSpikeAgentTools(fakeServer, { registry, memory });
const results = [];
function record(name, ok, details = {}) {
  results.push({ name, ok: ok === true, ...details });
  console.error(`[memory-integration] ${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(details).slice(0, 500)}`);
}

const USER_REQUESTED_DELEGATION = Object.freeze({
  basis: "user_requested",
  rationale: "This integration fixture explicitly requests Agent execution.",
});

try {
  const jobsBeforeDelegationBlock = memory.status().operationalJobs;
  const startsBeforeDelegationBlock = state.startCalls;
  const delegationBlocked = await handlers.get("spike.agent_start")({
    provider: "codex",
    task: "this must be blocked before provider or memory work",
    requestId: "memory-delegation-block",
  });
  record("delegation.blocks-before-provider-and-memory", delegationBlocked?.isError === true
    && delegationBlocked?.structuredContent?.errorCode === "AGENT_DELEGATION_NOT_JUSTIFIED"
    && state.startCalls === startsBeforeDelegationBlock
    && memory.status().operationalJobs === jobsBeforeDelegationBlock, {
    errorCode: delegationBlocked?.structuredContent?.errorCode,
    startCalls: state.startCalls,
    jobsBefore: jobsBeforeDelegationBlock,
    jobsAfter: memory.status().operationalJobs,
  });

  const jobsBeforeUnknown = memory.status().operationalJobs;
  const unknown = await handlers.get("spike.agent_start")({ provider: "missing-provider", task: "must fail before memory job creation", requestId: "memory-unknown-start", delegation: USER_REQUESTED_DELEGATION });
  record("unknown-provider.no-memory-job", unknown?.isError === true && unknown?.structuredContent?.errorCode === "AGENT_PROVIDER_UNKNOWN" && memory.status().operationalJobs === jobsBeforeUnknown, {
    errorCode: unknown?.structuredContent?.errorCode,
    before: jobsBeforeUnknown,
    after: memory.status().operationalJobs,
  });

  const start = await handlers.get("spike.agent_start")({
    provider: "codex",
    task: "Investigate localhost HTTP 502 proxy failure",
    requestId: "memory-start-proxy",
    delegation: USER_REQUESTED_DELEGATION,
    project: "F:\\SpikeBridge",
    options: {},
  });
  record("start.called-once", state.startCalls === 1 && start?.isError === false, { calls: state.startCalls, ref: start?.structuredContent?.ref });
  record("start.capsule-injected", state.lastTask?.includes("<experience_memory>") && state.lastTask?.includes("DO NOT RETRY") && state.lastTask?.includes("NO_PROXY") && state.lastTask?.includes("historical experience/evidence"), { preview: state.lastTask?.slice(-1400) });

  state.status = "failed";
  const shown = await handlers.get("spike.agent_status")({ provider: "codex", ref: "agent_memory_gate" });
  record("failure.observed", shown?.structuredContent?.status === "failed", { status: shown?.structuredContent?.status });

  const sent = await handlers.get("spike.agent_send")({
    provider: "codex",
    ref: "agent_memory_gate",
    message: "restart MCP server repeatedly",
    requestId: "memory-send-retry-block",
    options: {},
  });
  record("retry.blocked-before-provider", sent?.isError === true && sent?.structuredContent?.errorCode === "EXPERIENCE_MEMORY_RETRY_BLOCKED" && sent?.structuredContent?.recommendedFix?.includes("NO_PROXY") && state.sendCalls === 0, {
    sendCalls: state.sendCalls,
    payload: sent?.structuredContent,
  });

  const beforeCompletion = memory.status().items;
  const activeBeforeCompletion = memory.status().statuses.active || 0;
  state.status = "completed";
  const completed = await handlers.get("spike.agent_status")({ provider: "codex", ref: "agent_memory_gate" });
  record("completion.does-not-invent-lesson", completed?.structuredContent?.status === "completed" && memory.status().items === beforeCompletion && (memory.status().statuses.active || 0) === activeBeforeCompletion, { items: memory.status().items });

  state.status = "running";
  const cancelStart = await handlers.get("spike.agent_start")({ provider: "codex", task: "cancel memory lifecycle gate", requestId: "memory-cancel-start", delegation: USER_REQUESTED_DELEGATION, project: "F:\\SpikeBridge", options: {} });
  const cancelRef = cancelStart?.structuredContent?.ref;
  const cancelled = await handlers.get("spike.agent_cancel")({ provider: "codex", ref: cancelRef, requestId: "memory-cancel-stop", expectedTurnId: "fixture-turn" });
  const cancelledJob = memory.jobForRef("codex", cancelRef);
  record("cancel.closes-memory-job", cancelled?.structuredContent?.status === "interrupted" && cancelledJob?.status === "interrupted" && Boolean(cancelledJob?.completed_at), {
    status: cancelled?.structuredContent?.status,
    memoryStatus: cancelledJob?.status,
    completedAt: cancelledJob?.completed_at,
  });


  state.status = "running";
  const learningStart = await handlers.get("spike.agent_start")({ provider: "codex", task: "learn a new fixture repair", requestId: "memory-learning-start", delegation: USER_REQUESTED_DELEGATION, project: "F:\\SpikeBridge", options: {} });
  const learningRef = learningStart.structuredContent.ref;
  const itemsBeforeLearningFailure = memory.status().items;
  state.status = "failed";
  state.failure = { error: "widget fixture obsolete setting", errorCode: "WIDGET_FIXTURE" };
  await handlers.get("spike.agent_status")({ provider: "codex", ref: learningRef });
  const learningJob = memory.jobForRef("codex", learningRef);
  const observed = memory.store.lastJobFailure(learningJob.jobKey);
  record("first-failure.raw-only", memory.status().items === itemsBeforeLearningFailure
    && memory.store.itemsForJob(learningJob.jobKey).length === 0
    && observed.error_code === "WIDGET_FIXTURE" && observed.error_excerpt.includes("obsolete setting"), { failureId: observed.id });
  state.status = "running";
  await handlers.get("spike.agent_send")({ provider: "codex", ref: learningRef, message: "apply a revised fixture setting", requestId: "memory-learning-send", options: {} });
  state.status = "failed";
  await handlers.get("spike.agent_status")({ provider: "codex", ref: learningRef });
  const candidate = memory.store.findBySignature(observed.signature, { activeOnly: false })
    .find((item) => item.status === "candidate" && item.project === "F:\\SpikeBridge");
  record("second-failure.links-two-observations", Boolean(candidate) && memory.status().items === itemsBeforeLearningFailure + 1
    && candidate.confidence === "low" && memory.inspect(candidate.id).evidence.filter((row) => row.event_type === "failure").length === 2
    && memory.inspect(candidate.id).evidence.some((row) => row.failure_id === observed.id), { candidateId: candidate?.id });
  state.status = "completed";
  state.learning = {
    memoryLesson: {
      title: "Verified widget fixture repair", trigger: "widget fixture obsolete setting",
      failed_approach: "blind restart", root_cause: "fixture reads obsolete setting",
      verified_fix: "update the fixture setting and check the result", do_not_retry: "Do not blind restart",
    },
    verification: { status: "PASS", evidence_ref: "gate:integration-widget", result_excerpt: "expected widget output and exit 0" },
  };
  const learnedStatus = await handlers.get("spike.agent_status")({ provider: "codex", ref: learningRef });
  const learned = memory.inspect(candidate.id);
  record("completion.promotes-linked-candidate", learnedStatus.isError === false && learned.item.status === "active"
    && learned.item.confidence === "verified" && learned.item.expires_at === null
    && learned.evidence.some((entry) => entry.event_type === "failure" && entry.job_id === learningJob.jobKey)
    && learned.evidence.some((entry) => entry.event_type === "verification_pass" && entry.job_id === learningJob.jobKey),
    { candidateId: candidate.id, learnedId: learned.item.id, status: learned.item.status });

  const itemsAfterLearning = memory.status().items;
  const evidenceAfterLearning = memory.inspect(candidate.id).evidence.length;
  await handlers.get("spike.agent_status")({ provider: "codex", ref: learningRef });
  record("completion.replay-is-idempotent", memory.status().items === itemsAfterLearning
    && memory.inspect(candidate.id).evidence.length === evidenceAfterLearning, { items: memory.status().items });
  record("learning.retrieved-on-next-start", memory.beforeAgentStart({ task: "widget fixture obsolete setting", provider: "codex", project: "F:\\SpikeBridge" })
    .task.includes(state.learning.memoryLesson.verified_fix), { id: learned.item.id });


  state.status = "running";
  state.learning = null;
  const directStart = await handlers.get("spike.agent_start")({ provider: "codex", task: "verify after one failure", requestId: "memory-direct-start", delegation: USER_REQUESTED_DELEGATION, project: "F:\\SpikeBridge", options: {} });
  const directRef = directStart.structuredContent.ref;
  const beforeDirect = memory.status().items;
  state.status = "failed";
  state.failure = { error: "one-off direct widget fixture failure", errorCode: "DIRECT_WIDGET_FIXTURE" };
  await handlers.get("spike.agent_status")({ provider: "codex", ref: directRef });
  const directJob = memory.jobForRef("codex", directRef);
  const directRaw = memory.store.lastJobFailure(directJob.jobKey);
  record("direct-learning.first-failure-raw-only", memory.status().items === beforeDirect
    && memory.store.itemsForJob(directJob.jobKey).length === 0, { failureId: directRaw.id });
  state.status = "completed";
  state.learning = {
    memoryLesson: {
      title: "Direct verified widget repair", trigger: "one-off widget fixture failure",
      failed_approach: "repeat obsolete fixture", root_cause: "obsolete fixture setting",
      verified_fix: "repair fixture setting and check expected output", do_not_retry: "Do not repeat obsolete fixture",
    },
    verification: { status: "PASS", evidence_ref: "gate:direct-widget", result_excerpt: "expected widget output and exit 0" },
  };
  await handlers.get("spike.agent_status")({ provider: "codex", ref: directRef });
  const directLesson = memory.store.itemsForJob(directJob.jobKey)[0];
  const directEvidence = directLesson ? memory.inspect(directLesson.id).evidence : [];
  record("direct-learning.verified-with-raw-backlink", directLesson?.status === "active" && directLesson.confidence === "verified"
    && memory.status().items === beforeDirect + 1 && directEvidence.length === 2
    && directEvidence.some((row) => row.event_type === "failure" && row.failure_id === directRaw.id), { id: directLesson?.id });
  await handlers.get("spike.agent_status")({ provider: "codex", ref: directRef });
  record("direct-learning.replay-idempotent", memory.status().items === beforeDirect + 1
    && memory.inspect(directLesson.id).evidence.length === 2, { id: directLesson.id });

  const names = [...handlers.keys()].sort();
  record("public-group.fixed", names.length === 4 && names.join(",") === ["spike.agent_cancel", "spike.agent_send", "spike.agent_start", "spike.agent_status"].join(","), { names });
  record("public-group.retired-show-absent", !names.includes("spike.agent_show"), { names });

  const summary = { gate: "experience-memory-integration", result: results.every((x) => x.ok) ? "PASS" : "FAIL", passed: results.filter((x) => x.ok).length, total: results.length, results };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.result !== "PASS") process.exitCode = 1;
} finally {
  memory.close();
}

