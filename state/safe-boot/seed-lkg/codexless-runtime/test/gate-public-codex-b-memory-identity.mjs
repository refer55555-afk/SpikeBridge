import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAgentRouter } from "../src/codex-agent-router.mjs";
import { composeRegisteredToolHandler } from "../src/mcp-server-factory.mjs";
import { ExperienceMemory } from "../src/memory/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const gateRoot = path.join(path.resolve(here, ".."), "tmp", `public-codex-b-memory-identity-${process.pid}-${Date.now()}`);
fs.mkdirSync(gateRoot, { recursive: true });
const memory = new ExperienceMemory({ dbPath: path.join(gateRoot, "experience.db"), seed: false });
const router = createCodexAgentRouter();
const results = [];
const record = (name, ok, details = {}) => results.push({ name, ok: ok === true, ...details });
const ref = "agent_public_b_memory_gate";
const project = "C:\\Projects\\SpikeBridgeFixture";
let primaryCalls = 0;
const primary = async () => { primaryCalls += 1; return { structuredContent: { status: "wrong-lane" } }; };
const bHandlers = new Map([
  ["codex.agent_show", async ({ agentRef }) => ({ structuredContent: { agentRef, status: "running", lane: "b" } })],
  ["codex.agent_send", async ({ agentRef }) => ({ structuredContent: { agentRef, status: "running", lane: "b" } })],
  ["codex.agent_approve", async ({ agentRef }) => ({ structuredContent: { agentRef, status: "running", lane: "b" } })],
  ["codex.agent_reject", async ({ agentRef }) => ({ structuredContent: { agentRef, status: "interrupted", lane: "b" } })],
]);

try {
  const started = memory.beforeAgentStart({ task: "B memory identity fixture", provider: "codex-b", project, tools: ["codex-b.agent_start"] });
  memory.bindJobRef(started.jobKey, ref);
  router.bind({ agentRef: ref }, bHandlers, "codex-b");

  record("router.resolves-b", router.resolveProvider("codex.agent_show", { agentRef: ref }) === "codex-b", {
    provider: router.resolveProvider("codex.agent_show", { agentRef: ref }),
  });

  const show = composeRegisteredToolHandler({ name: "codex.agent_show", handler: primary, codexAgentRouter: router, experienceMemory: memory });
  const shown = await show({ agentRef: ref });
  const afterShow = memory.jobForRef("codex-b", ref);
  record("public-show.keeps-b-identity", shown?.structuredContent?.lane === "b" && afterShow?.provider_family === "codex" && afterShow?.provider_id === "codex-b" && afterShow?.status === "active" && primaryCalls === 0, {
    lane: shown?.structuredContent?.lane,
    providerFamily: afterShow?.provider_family,
    providerId: afterShow?.provider_id,
    status: afterShow?.status,
    primaryCalls,
  });

  const send = composeRegisteredToolHandler({ name: "codex.agent_send", handler: primary, codexAgentRouter: router, experienceMemory: memory });
  const sent = await send({ agentRef: ref, message: "continue B fixture", requestId: "public-b-memory-send" });
  const afterSend = memory.jobForRef("codex-b", ref);
  record("public-send.reuses-b-job", sent?.structuredContent?.lane === "b" && afterSend?.jobKey === started.jobKey && memory.jobForRef("codex", ref) === null, {
    lane: sent?.structuredContent?.lane,
    jobKey: afterSend?.jobKey,
    expectedJobKey: started.jobKey,
    genericCodexRow: memory.jobForRef("codex", ref),
  });

  const approve = composeRegisteredToolHandler({ name: "codex.agent_approve", handler: primary, codexAgentRouter: router, experienceMemory: memory });
  await approve({ agentRef: ref, approvalRequestId: "approval-fixture", requestId: "approve-fixture" });
  const afterApprove = memory.jobForRef("codex-b", ref);
  record("public-approve.keeps-b-active", afterApprove?.provider_id === "codex-b" && afterApprove?.status === "active", {
    providerId: afterApprove?.provider_id,
    status: afterApprove?.status,
  });

  const reject = composeRegisteredToolHandler({ name: "codex.agent_reject", handler: primary, codexAgentRouter: router, experienceMemory: memory });
  const rejected = await reject({ agentRef: ref, approvalRequestId: "approval-fixture", requestId: "reject-fixture" });
  const terminal = memory.jobForRef("codex-b", ref);
  record("public-reject.closes-b-job", rejected?.structuredContent?.status === "interrupted" && terminal?.provider_family === "codex" && terminal?.provider_id === "codex-b" && terminal?.status === "interrupted" && Boolean(terminal?.completed_at), {
    status: terminal?.status,
    providerFamily: terminal?.provider_family,
    providerId: terminal?.provider_id,
    completedAt: terminal?.completed_at,
  });
  record("public-continuation.no-generic-shadow", memory.jobForRef("codex", ref) === null, { genericCodexRow: memory.jobForRef("codex", ref) });

  const passed = results.filter((x) => x.ok).length;
  const out = { gate: "public-codex-b-memory-identity", result: passed === results.length ? "PASS" : "FAIL", passed, total: results.length, results };
  console.log(JSON.stringify(out, null, 2));
  if (out.result !== "PASS") process.exitCode = 1;
} finally {
  memory.close();
  fs.rmSync(gateRoot, { recursive: true, force: true });
}
