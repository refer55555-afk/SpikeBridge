// CodexProvider — thin wrapper over the existing, production Codex agent lane.
//
// The provider does NOT reimplement any Codex behavior. It re-issues the exact
// MCP tool handlers registered for codex.agent_* / codex.model_list with the
// same arguments the MCP surface would pass, so consent gating, Task Card
// bookkeeping, Call Profile binding, idempotency, and usage receipts stay
// byte-for-byte identical to the codex.agent_* tools. The handler map is
// captured by the server factory (toolHandlerSink) at runtime lifetime.
//
// Every method returns the tool's structuredContent payload verbatim
// (model-visible shape). Terminal/consent/usage facts inside the payload are
// the single source of truth; this wrapper adds only `ref` extraction and
// UNKNOWN-safe usage.

import { randomUUID } from "node:crypto";

const SPIKE_PROVIDER_INTERNAL = Symbol.for("spike.bridge.agent-provider.internal");

const REQUIRED_HANDLERS = [
  "codex.agent_start",
  "codex.agent_show",
  "codex.agent_send",
  "codex.agent_cancel",
  "codex.model_list",
];

function extractRef(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.agentRef === "string" && payload.agentRef) return payload.agentRef;
  if (typeof payload.taskCard?.agentRef === "string" && payload.taskCard.agentRef) return payload.taskCard.agentRef;
  return null;
}

export function createCodexAgentProvider({
  id = "codex",
  displayName = "Codex",
  handlers,
  agentExecutor = null,
  resourceSnapshotProvider = null,
  defaultCwd = null,
  formalAgentAvailable = true,
  routeRegistry = null,
} = {}) {
  if (!handlers || typeof handlers.get !== "function") {
    throw new TypeError("createCodexAgentProvider requires the captured tool handler map");
  }
  // Handler presence is validated lazily (probe/call time), not at construction:
  // the sink is populated by the server factory on the first createServer(),
  // which happens after the runtime (and therefore this provider) is built.

  async function call(name, args) {
    const handler = handlers.get(name);
    if (typeof handler !== "function") {
      const error = new Error(`codex tool handler unavailable: ${name}`);
      error.code = "AGENT_PROVIDER_HANDLER_MISSING";
      throw error;
    }
    const result = await handler({ ...(args ?? {}), [SPIKE_PROVIDER_INTERNAL]: true });
    const payload = result?.structuredContent ?? { error: "codex tool returned no structured content" };
    routeRegistry?.bind?.(payload, handlers, id);
    return payload;
  }

  return {
    id,
    displayName,
    capabilities: Object.freeze({
      resume: true,      // codex.agent_send continues an existing agentRef
      cancel: true,
      approval: true,    // Call Approval consent flow + commit/decline
      models: true,
      usage: true,
      quota: true,
      streaming: false,
      remote: false,
    }),

    async probe() {
      const details = {
        provider: id,
        formalAgentAvailable: formalAgentAvailable === true,
        handlers: REQUIRED_HANDLERS.every((name) => typeof handlers.get(name) === "function"),
        executorOpen: Boolean(agentExecutor?.running),
      };
      if (!formalAgentAvailable) return { ok: false, ...details, reason: "formal agent lane unavailable in this runtime" };
      if (!details.handlers) return { ok: false, ...details, reason: "codex agent tool handlers are not all captured" };
      try {
        const catalog = await call("codex.model_list", { limit: 1 });
        details.modelCatalogReachable = !catalog?.error;
      } catch (error) {
        return { ok: false, ...details, reason: error instanceof Error ? error.message : String(error) };
      }
      return { ok: true, ...details };
    },

    async start({ task, project, options } = {}) {
      if (typeof task !== "string" || !task.trim()) throw new TypeError("CodexProvider.start requires a non-empty task string");
      const payload = await call("codex.agent_start", {
        prompt: task,
        requestId: options?.requestId ?? `bridge-start-${randomUUID()}`,
        ...(project ? { cwd: project } : {}),
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options?.presentationLocale ? { presentationLocale: options.presentationLocale } : {}),
        invocationRationale: options?.invocationRationale ?? "Dispatched through the Spike Bridge agent provider layer.",
      });
      return { ref: extractRef(payload), provider: id, ...payload };
    },

    async status(ref) {
      if (typeof ref !== "string" || !ref.trim()) throw new TypeError("CodexProvider.status requires an agentRef string");
      const payload = await call("codex.agent_show", { agentRef: ref });
      return { ref, provider: id, ...payload };
    },

    async send(ref, message, options = {}) {
      if (typeof ref !== "string" || !ref.trim()) throw new TypeError("CodexProvider.send requires an agentRef string");
      if (typeof message !== "string" || !message.trim()) throw new TypeError("CodexProvider.send requires a non-empty message string");
      const payload = await call("codex.agent_send", {
        agentRef: ref,
        message,
        requestId: options?.requestId ?? `bridge-send-${randomUUID()}`,
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options?.presentationLocale ? { presentationLocale: options.presentationLocale } : {}),
      });
      return { ref, provider: id, ...payload };
    },

    async cancel(ref, options = {}) {
      if (typeof ref !== "string" || !ref.trim()) throw new TypeError("CodexProvider.cancel requires an agentRef string");
      const payload = await call("codex.agent_cancel", {
        agentRef: ref,
        requestId: options?.requestId ?? `bridge-cancel-${randomUUID()}`,
        ...(options?.expectedTurnId ? { expectedTurnId: options.expectedTurnId } : {}),
      });
      return { ref, provider: id, ...payload };
    },

    async models(options = {}) {
      return call("codex.model_list", {
        ...(options?.cursor ? { cursor: options.cursor } : {}),
        ...(Number.isInteger(options?.limit) ? { limit: options.limit } : {}),
        ...(options?.includeHidden === true ? { includeHidden: true } : {}),
      });
    },

    async usage() {
      if (typeof resourceSnapshotProvider !== "function") {
        return { provider: id, quota: "UNKNOWN", usage: "UNKNOWN", reason: "no resource snapshot provider configured" };
      }
      try {
        const snapshot = await resourceSnapshotProvider();
        if (!snapshot) return { provider: id, quota: "UNKNOWN", usage: "UNKNOWN" };
        return { provider: id, ...snapshot };
      } catch (error) {
        return { provider: id, quota: "UNKNOWN", usage: "UNKNOWN", error: error instanceof Error ? error.message : String(error) };
      }
    },

    // Approval capability (capabilities.approval). Task IDs come from the
    // consent_required payloads returned by start/send.
    async commit(taskId) {
      if (typeof taskId !== "string" || !taskId.trim()) throw new TypeError("CodexProvider.commit requires a taskId string");
      const payload = await call("codex.agent_commit", { taskId });
      return { taskId, provider: id, ref: extractRef(payload), ...payload };
    },

    async decline(taskId) {
      if (typeof taskId !== "string" || !taskId.trim()) throw new TypeError("CodexProvider.decline requires a taskId string");
      const payload = await call("codex.agent_decline", { taskId });
      return { taskId, provider: id, ...payload };
    },

    async card(taskRef) {
      if (typeof taskRef !== "string" || !taskRef.trim()) throw new TypeError("CodexProvider.card requires a taskRef string");
      if (typeof handlers.get("codex.agent_card_state") !== "function") {
        // This surface does not register the card-state tool; report honestly
        // instead of guessing (UNKNOWN is the contract for unavailable data).
        return { taskRef, provider: id, status: "UNKNOWN", reason: "codex.agent_card_state is not registered on this surface" };
      }
      return call("codex.agent_card_state", { taskRef });
    },
  };
}
