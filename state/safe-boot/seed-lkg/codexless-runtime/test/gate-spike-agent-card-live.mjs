// Spike Agent Card UI v4 / state-schema-v1 Gate — LIVE HTTP MCP surface (default http://127.0.0.1:7690/mcp).
//
// Validates the shipped bridge surface, not just modules:
//   1. tool surface: exactly the four spike.agent_* tools; spike.agent_start is
//      the ONLY one carrying ui.resourceUri / openai/outputTemplate, and it
//      points at ui://spike/agent-card-v4.html; retired spike.agent_show is absent
//   2. resources: the card resource is listed and readable with the MCP-app
//      mime type and prefersBorder
//   3. action payloads: only start can request a one-time card mount; send/cancel do not remount
//   4. real ZCode lane: start -> cardV1 (ZCode / glm-5.3-flash / quota
//      unavailable) -> completed, then send(resume) -> new turn runs -> completes
// Prints one JSON verdict object.

const BASE = process.env.SPIKE_GATE_MCP_BASE ?? "http://127.0.0.1:7690/mcp";
const FULL = process.env.SPIKE_GATE_CARD_LIVE_FULL !== "0";

async function rpc(method, params, timeoutMs = 240_000) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const response = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let result = null;
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text);
    if (parsed.error) throw new Error(`RPC error: ${JSON.stringify(parsed.error)}`);
    result = parsed.result;
  } else {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data: ")) continue;
      const value = JSON.parse(line.slice(6));
      if (value.error) throw new Error(`RPC error: ${JSON.stringify(value.error)}`);
      if (value.result) result = value.result;
    }
  }
  if (result === null) throw new Error(`no result for ${method}`);
  return result;
}

async function callTool(name, args, timeoutMs = 240_000) {
  return rpc("tools/call", { name, arguments: args }, timeoutMs);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function record(name, ok, details = {}) {
  results.push({ name, ok: ok === true, ...details });
  console.error(`[gate] ${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(details).slice(0, 300)}`);
}
const USER_REQUESTED_DELEGATION = Object.freeze({
  basis: "user_requested",
  rationale: "This live card acceptance gate explicitly requests Agent execution.",
});

// 1) tool surface metadata ----------------------------------------------------
const listed = await rpc("tools/list", {});
const tools = listed?.tools ?? [];
const spikeTools = ["spike.agent_start", "spike.agent_status", "spike.agent_send", "spike.agent_cancel"];
record("surface.spike-group", spikeTools.every((name) => tools.some((tool) => tool.name === name)), { count: tools.length });
record("surface.retired-show-absent", !tools.some((tool) => tool.name === "spike.agent_show"), {});
const startTool = tools.find((tool) => tool.name === "spike.agent_start");
const statusTool = tools.find((tool) => tool.name === "spike.agent_status");
const CARD_URI = "ui://spike/agent-card-v4.html";
const LEGACY_V3_CARD_URI = "ui://spike/agent-card-v3.html";
const LEGACY_V2_CARD_URI = "ui://spike/agent-card-v2.html";
const LEGACY_V1_CARD_URI = "ui://spike/agent-card-v1.html";
record("start.ui.resourceUri", startTool?._meta?.ui?.resourceUri === CARD_URI, { meta: startTool?._meta });
record("start.outputTemplate", startTool?._meta?.["openai/outputTemplate"] === CARD_URI);
record("start.model-visible", Array.isArray(startTool?._meta?.ui?.visibility)
  ? startTool._meta.ui.visibility.includes("model")
  : true, { visibility: startTool?._meta?.ui?.visibility });
for (const name of ["spike.agent_status", "spike.agent_send", "spike.agent_cancel"]) {
  const tool = tools.find((entry) => entry.name === name);
  record(`${name}.no-ui-template`, !tool?._meta?.ui?.resourceUri && !tool?._meta?.["openai/outputTemplate"], { meta: tool?._meta });
}
record("start.describes-single-mount", typeof startTool?.description === "string" && startTool.description.includes("one and only Spike Agent Card mount"), {});
record("status.data-only", typeof statusTool?.description === "string"
  && statusTool.description.includes("data-only")
  && statusTool.description.includes("retired spike.agent_show")
  && !tools.some((tool) => tool.name === "spike.agent_poll"), {});

// 2) resources ------------------------------------------------------------------
let resourceListed = null;
try { resourceListed = await rpc("resources/list", {}, 30_000); } catch (error) { record("resources.list", false, { error: String(error).slice(0, 200) }); }
record("resources.list", Array.isArray(resourceListed?.resources)
  && resourceListed.resources.some((entry) => entry.uri === CARD_URI)
  && resourceListed.resources.some((entry) => entry.uri === LEGACY_V3_CARD_URI)
  && resourceListed.resources.some((entry) => entry.uri === LEGACY_V2_CARD_URI)
  && resourceListed.resources.some((entry) => entry.uri === LEGACY_V1_CARD_URI),
  { uris: resourceListed?.resources?.map((entry) => entry.uri) });
let resourceRead = null;
try { resourceRead = await rpc("resources/read", { uri: CARD_URI }, 30_000); } catch (error) { record("resources.read", false, { error: String(error).slice(0, 200) }); }
const resourceContent = resourceRead?.contents?.[0];
record("resources.read", resourceContent?.uri === CARD_URI
  && resourceContent?.mimeType === "text/html;profile=mcp-app"
  && resourceContent?._meta?.ui?.prefersBorder === true
  && typeof resourceContent?.text === "string"
  && resourceContent.text.includes("acceptAgentCardView"),
  { mime: resourceContent?.mimeType, bytes: resourceContent?.text?.length });
let legacyV3ResourceRead = null;
let legacyV2ResourceRead = null;
let legacyV1ResourceRead = null;
try { legacyV3ResourceRead = await rpc("resources/read", { uri: LEGACY_V3_CARD_URI }, 30_000); } catch (error) { record("resources.legacy-v3-read", false, { error: String(error).slice(0, 200) }); }
try { legacyV2ResourceRead = await rpc("resources/read", { uri: LEGACY_V2_CARD_URI }, 30_000); } catch (error) { record("resources.legacy-v2-read", false, { error: String(error).slice(0, 200) }); }
try { legacyV1ResourceRead = await rpc("resources/read", { uri: LEGACY_V1_CARD_URI }, 30_000); } catch (error) { record("resources.legacy-v1-read", false, { error: String(error).slice(0, 200) }); }
const legacyV3ResourceContent = legacyV3ResourceRead?.contents?.[0];
const legacyV2ResourceContent = legacyV2ResourceRead?.contents?.[0];
const legacyV1ResourceContent = legacyV1ResourceRead?.contents?.[0];
record("resources.legacy-v3-read", legacyV3ResourceContent?.uri === LEGACY_V3_CARD_URI
  && legacyV3ResourceContent?.mimeType === "text/html;profile=mcp-app"
  && legacyV3ResourceContent?._meta?.ui?.prefersBorder === true
  && legacyV3ResourceContent?.text === resourceContent?.text,
  { mime: legacyV3ResourceContent?.mimeType, bytes: legacyV3ResourceContent?.text?.length });
record("resources.legacy-v2-read", legacyV2ResourceContent?.uri === LEGACY_V2_CARD_URI
  && legacyV2ResourceContent?.mimeType === "text/html;profile=mcp-app"
  && legacyV2ResourceContent?._meta?.ui?.prefersBorder === true
  && legacyV2ResourceContent?.text === resourceContent?.text,
  { mime: legacyV2ResourceContent?.mimeType, bytes: legacyV2ResourceContent?.text?.length });
record("resources.legacy-v1-read", legacyV1ResourceContent?.uri === LEGACY_V1_CARD_URI
  && legacyV1ResourceContent?.mimeType === "text/html;profile=mcp-app"
  && legacyV1ResourceContent?._meta?.ui?.prefersBorder === true
  && legacyV1ResourceContent?.text === resourceContent?.text,
  { mime: legacyV1ResourceContent?.mimeType, bytes: legacyV1ResourceContent?.text?.length });

// 3) action payload does not remount card (Mac honest-unsupported cancel) -----
const macCancel = await callTool("spike.agent_cancel", { provider: "mac", ref: "mac_card_gate_probe", requestId: "card-gate-mac-cancel" });
record("cancel.no-cardRender", macCancel?.structuredContent?.cardRender === undefined,
  { cardRender: macCancel?.structuredContent?.cardRender });
const macCardV1 = macCancel?.structuredContent?.cardV1;
record("cancel.cardV1", macCardV1?.schemaVersion === "spike.agent-card.v1"
  && macCardV1?.provider?.label === "Mac"
  && macCardV1?.state?.status === "unknown"
  && macCardV1?.execution?.host === "Mac"
  && macCardV1?.quota?.available === false
  && macCardV1?.capabilities?.cancel === false,
  { cardV1: macCardV1 });

// unknown provider still fails closed, and must NOT fake a card
const unknown = await callTool("spike.agent_start", { provider: "does-not-exist", task: "x", requestId: "card-gate-unknown-provider", delegation: USER_REQUESTED_DELEGATION });
record("unknown-provider-fails-closed", unknown?.isError === true && unknown?.structuredContent?.errorCode === "AGENT_PROVIDER_UNKNOWN", {});

// 4) real ZCode lane --------------------------------------------------------------
const start = await callTool("spike.agent_start", {
  provider: "zcode",
  task: "Reply with exactly one line: CARD-GATE-OK",
  requestId: "card-gate-zcode-start-1",
  delegation: USER_REQUESTED_DELEGATION,
  options: { mode: "plan" },
});
const startCard = start?.structuredContent?.cardV1;
const startRef = start?.structuredContent?.ref ?? start?.structuredContent?.agentRef ?? null;
record("zcode.start-card", start?.isError !== true && startCard?.provider?.label === "ZCode"
  && startCard?.execution?.resolvedModel === "glm-5.3-flash"
  && startCard?.state?.status === "running"
  && startCard?.quota?.available === false,
  { cardV1: startCard, error: start?.structuredContent?.error });
record("zcode.start-single-mount-payload", start?.structuredContent?.cardRender === undefined
  && typeof startRef === "string" && startRef.startsWith("zcode_"),
  { ref: startRef });

async function waitTerminal(ref, { timeoutMs = 420_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await callTool("spike.agent_status", { provider: "zcode", ref });
    const card = last?.structuredContent?.cardV1;
    if (card && card.state.terminal === true) return last;
    await sleep(3000);
  }
  return last;
}

if (startRef) {
  const doneShow = await waitTerminal(startRef);
  const doneCard = doneShow?.structuredContent?.cardV1;
  record("zcode.completes", doneCard?.state?.terminal === true && doneCard?.state?.status === "completed", { cardV1: doneCard });
  record("zcode.duration+usage", Number.isFinite(doneCard?.state?.elapsedMs) === true
    && doneCard?.usage?.available === true && doneCard?.usage?.turn !== null,
    { elapsedMs: doneCard?.state?.elapsedMs, usage: doneCard?.usage });
  record("zcode.status-no-cardRender-field", doneShow?.structuredContent?.cardRender === undefined, {});

  if (FULL && doneCard?.state?.status === "completed") {
    const send = await callTool("spike.agent_send", {
      provider: "zcode",
      ref: startRef,
      message: "Continue this session and reply with exactly one line: CARD-GATE-TURN-2",
      requestId: "card-gate-zcode-send-1",
    });
    const sendCard = send?.structuredContent?.cardV1;
    const sendRef = send?.structuredContent?.ref ?? send?.structuredContent?.agentRef ?? null;
    record("zcode.send-new-turn-running", send?.isError !== true && sendCard?.state?.status === "running"
      && sendCard?.task?.parentTaskRef === startRef
      && sendCard?.turn?.turnRef === sendRef && sendRef !== startRef,
      { cardV1: sendCard, error: send?.structuredContent?.error });
    if (sendRef) {
      const done2 = await waitTerminal(sendRef);
      const done2Card = done2?.structuredContent?.cardV1;
      record("zcode.second-turn-completes", done2Card?.state?.terminal === true && done2Card?.state?.status === "completed"
        && done2Card?.turn?.turnRef === sendRef
        && done2Card?.task?.taskRef === startRef,
        { cardV1: done2Card });
    }
  } else if (FULL) {
    record("zcode.send-new-turn-running", false, { reason: "first turn did not complete; resume leg skipped" });
  }
} else {
  record("zcode.start-card", false, { reason: "no startRef" });
}

const failed = results.filter((entry) => !entry.ok);
console.log(JSON.stringify({ gate: "spike-agent-card-live", base: BASE, total: results.length, failed: failed.length, results }, null, 2));
process.exit(failed.length ? 1 : 0);
