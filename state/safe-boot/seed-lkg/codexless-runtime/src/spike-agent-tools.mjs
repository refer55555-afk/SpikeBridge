// spike.agent_* — the fixed generic agent tool group (Spike Bridge).
//
// Exactly four tools, registered once for ALL providers. `provider` is a plain
// string resolved through the AgentProvider registry: adding a provider never
// adds a new MCP tool. Codex dispatch inherits the full codex.agent_* behavior
// (consent, Task Card, Call Profile) because CodexProvider re-issues those very
// handlers. Every structured payload carries a normalized generic Agent Card
// (`cardV1`, SpikeAgentCardStateV1).
//
// Card surface: spike.agent_start owns the one-time UI mount. spike.agent_status
// is the data-only status tool for the already-mounted card and for model supervision.
// The old public spike.agent_show name is intentionally absent: stale ChatGPT tool
// snapshots used to associate that name with a UI template and could remount cards
// forever. send/cancel never mount UI.

import { z } from "zod/v4";
import { renderAgentCard } from "./agent-card-view.mjs";
import {
  SPIKE_AGENT_CARD_URI,
  normalizeAgentCardState,
  registerSpikeAgentCardResource,
} from "./spike-agent-card-ui.mjs";

function providerError(error, details = {}) {
  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : details.errorCode || "AGENT_PROVIDER_FAILED";
  const structuredContent = {
    error: error instanceof Error ? error.message : String(error),
    errorCode: code,
    ...(details.recommendedFix ? { recommendedFix: details.recommendedFix } : {}),
    ...(details.memoryReason ? { memoryReason: details.memoryReason } : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

function memoryBlocked(guard) {
  const error = new Error(`Experience Memory blocked a repeated known-bad attempt (${guard?.reason ?? "guard"}).`);
  error.code = "EXPERIENCE_MEMORY_RETRY_BLOCKED";
  return providerError(error, { recommendedFix: guard?.recommendedFix ?? null, memoryReason: guard?.reason ?? null });
}

function payloadRef(payload, fallback = null) {
  return payload?.ref || payload?.agentRef || payload?.taskCard?.agentRef || fallback || null;
}

function agentResult(payload, {
  providerId,
  providerLabel,
  linkRef = null,
  taskTitle = null,
  projectOverride = null,
  invocationRationaleOverride = null,
}) {
  const cardV1 = normalizeAgentCardState(providerId, payload, {
    providerLabel,
    linkRef,
    taskTitle,
    projectOverride,
    invocationRationaleOverride,
  });
  const structured = {
    ...payload,
    card: renderAgentCard(payload, cardV1),
    cardV1,
  };
  const isError = Boolean(payload?.error || payload?.errorCode || payload?.status === "failed");
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError,
  };
}


export function registerSpikeAgentTools(server, { registry, memory = null }) {
  if (!registry || typeof registry.require !== "function") {
    throw new Error("registerSpikeAgentTools requires an agent provider registry");
  }
  // Real surfaces carry the factory's registerResource passthrough; bare test
  // fakes may not, and the card resource must never block tool registration.
  if (typeof server.registerResource === "function") registerSpikeAgentCardResource(server);
  const labelFor = (providerId) => {
    try {
      const listed = registry.list?.()?.find((entry) => entry?.id === providerId);
      if (listed?.displayName) return listed.displayName;
    } catch {}
    return null;
  };
  const providerSchema = z.string().min(1).max(64)
    .describe("Agent provider id resolved through the provider registry (for example codex-a, codex-b, zcode, mac). Plain string on purpose: new providers never add new tools.");

  server.registerTool(
    "spike.agent_start",
    {
      title: "Start Agent (Provider-Agnostic)",
      description:
        "Start one agent task on the requested provider. Routing is decided by the provider registry, not by this tool. Codex tasks keep the full codex.agent_start lifecycle (Call Profile, Call Approval consent, fixed-text Task IDs, usage receipts); other providers follow their own capability contract as declared in the registry. When a payload reports UNKNOWN, that fact is not observable through the provider — do not guess it. The start result is the one and only Spike Agent Card mount for this task. NEVER retry this UI-owning tool merely to supervise a running task; later status reads must use spike.agent_status, which is data-only. The retired public name spike.agent_show must not be used because stale ChatGPT snapshots associated it with a UI template.",
      inputSchema: z.object({
        provider: providerSchema,
        task: z.string().min(1).max(200_000),
        requestId: z.string().min(1).max(512)
          .describe("Caller-stable idempotency key for this logical agent start. Reuse it only when retrying the exact same logical request."),
        project: z.string().min(1).max(32_768).optional()
          .describe("Optional working-directory context for the task."),
        options: z.object({
          mode: z.string().min(1).max(32).optional(),
          model: z.string().min(1).max(512).optional(),
          reasoningEffort: z.string().min(1).max(128).optional(),
          invocationRationale: z.string().min(1).max(4_000).optional(),
        }).strict().optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: {
        ui: { resourceUri: SPIKE_AGENT_CARD_URI, visibility: ["model", "app"] },
        "openai/outputTemplate": SPIKE_AGENT_CARD_URI,
        "openai/toolInvocation/invoking": "Preparing agent task…",
        "openai/toolInvocation/invoked": "Agent task ready.",
      },
    },
    async ({ provider, task, requestId, project, options }) => {
      let target;
      try {
        target = registry.require(provider);
      } catch (error) {
        return providerError(error);
      }
      let payload;
      const memoryState = memory?.beforeAgentStart?.({ task, provider, project, tools: [`${provider}.agent_start`] }) ?? { task, jobKey: null, guard: { blocked: false } };
      if (memoryState.guard?.blocked) return memoryBlocked(memoryState.guard);
      try {
        payload = await target.start({ task: memoryState.task, project, options: { ...(options ?? {}), requestId } });
      } catch (error) {
        memory?.onProviderFailure?.({ jobKey: memoryState.jobKey, provider, project, tool: `${provider}.agent_start`, error });
        return providerError(error);
      }
      const ref = payloadRef(payload);
      if (ref && memoryState.jobKey) memory?.bindJobRef?.(memoryState.jobKey, ref);
      if (payload?.error || payload?.errorCode) memory?.onProviderFailure?.({ jobKey: memoryState.jobKey, provider, project, tool: `${provider}.agent_start`, payload });
      return agentResult(payload, {
        providerId: provider,
        providerLabel: labelFor(provider),
        taskTitle: task,
        projectOverride: project ?? null,
        invocationRationaleOverride: options?.invocationRationale ?? null,
      });
    }
  );

  server.registerTool(
    "spike.agent_status",
    {
      title: "Read Agent Status (Provider-Agnostic)",
      description:
        "Read one agent task's current normalized Agent Card state. This is the only public generic status-read tool. It is data-only and carries no UI template, so repeated model supervision or in-card Refresh calls do not create additional ChatGPT cards. Do not call the retired spike.agent_show name.",
      inputSchema: z.object({
        provider: providerSchema,
        ref: z.string().min(1).max(512),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "Refreshing agent state…",
        "openai/toolInvocation/invoked": "Agent state refreshed.",
      },
    },
    async ({ provider, ref }) => {
      let payload;
      try {
        payload = await registry.require(provider).status(ref);
      } catch (error) {
        const prior = memory?.jobForRef?.(provider, ref);
        memory?.onProviderFailure?.({ jobKey: prior?.jobKey, provider, project: prior?.project ?? null, tool: `${provider}.agent_show`, error });
        return providerError(error);
      }
      memory?.observeAgentStatus?.({ provider, ref, payload });
      return agentResult(payload, { providerId: provider, providerLabel: labelFor(provider), linkRef: ref });
    }
  );

  server.registerTool(
    "spike.agent_send",
    {
      title: "Continue Agent (Provider-Agnostic)",
      description:
        "Send a follow-up message to one existing agent task. Providers without resume capability, or tasks without a resumable session, fail visibly with an errorCode instead of improvising. The existing Spike Agent Card is not remounted; its Refresh control reads the new state through spike.agent_status.",
      inputSchema: z.object({
        provider: providerSchema,
        ref: z.string().min(1).max(512),
        message: z.string().min(1).max(200_000),
        requestId: z.string().min(1).max(512)
          .describe("Caller-stable idempotency key for this logical follow-up. Reuse it only when retrying the exact same logical send."),
        options: z.object({
          mode: z.string().min(1).max(32).optional(),
          model: z.string().min(1).max(512).optional(),
          reasoningEffort: z.string().min(1).max(128).optional(),
          project: z.string().min(1).max(32_768).optional(),
        }).strict().optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Preparing agent follow-up…",
        "openai/toolInvocation/invoked": "Agent follow-up ready.",
      },
    },
    async ({ provider, ref, message, requestId, options }) => {
      if (["codex", "codex-a", "codex-b"].includes(provider) && options?.project) {
        const error = new Error("Codex continuation cannot change project/cwd on an existing thread; start a new task for a different project.");
        error.code = "AGENT_PROJECT_OVERRIDE_UNSUPPORTED";
        return providerError(error);
      }
      let payload;
      const memoryState = memory?.beforeAgentSend?.({ ref, message, provider, project: options?.project, tools: [`${provider}.agent_send`], approach: message }) ?? { message, jobKey: null, guard: { blocked: false }, project: options?.project };
      if (memoryState.guard?.blocked) return memoryBlocked(memoryState.guard);
      try {
        payload = await registry.require(provider).send(ref, memoryState.message, { ...(options ?? {}), requestId });
      } catch (error) {
        memory?.onProviderFailure?.({ jobKey: memoryState.jobKey, provider, project: memoryState.project ?? options?.project ?? null, tool: `${provider}.agent_send`, error });
        return providerError(error);
      }
      const nextRef = payloadRef(payload, ref);
      if (nextRef && memoryState.jobKey) memory?.bindJobRef?.(memoryState.jobKey, nextRef);
      if (payload?.error || payload?.errorCode) memory?.onProviderFailure?.({ jobKey: memoryState.jobKey, provider, project: memoryState.project ?? options?.project ?? null, tool: `${provider}.agent_send`, payload });
      return agentResult(payload, { providerId: provider, providerLabel: labelFor(provider), linkRef: ref });
    }
  );

  server.registerTool(
    "spike.agent_cancel",
    {
      title: "Cancel Agent (Provider-Agnostic)",
      description:
        "Request cancellation of one agent task. Callers must provide a stable requestId; Codex providers also require expectedTurnId so a stale cancellation cannot stop a newer turn. Providers without cancellation capability return an honest UNSUPPORTED result; they never fake a stop. The existing Spike Agent Card is not remounted; its Refresh control reads the final state through spike.agent_status.",
      inputSchema: z.object({
        provider: providerSchema,
        ref: z.string().min(1).max(512),
        requestId: z.string().min(1).max(512)
          .describe("Caller-stable idempotency key for this logical cancellation request."),
        expectedTurnId: z.string().min(1).max(512).optional()
          .describe("Required for Codex providers: exact current turn id observed immediately before cancellation, preventing a stale cancel from stopping a newer turn."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Stopping agent task…",
        "openai/toolInvocation/invoked": "Agent task stop requested.",
      },
    },
    async ({ provider, ref, requestId, expectedTurnId }) => {
      let target;
      try {
        target = registry.require(provider);
      } catch (error) {
        return providerError(error);
      }
      if (["codex", "codex-a", "codex-b"].includes(provider) && !expectedTurnId) {
        const error = new Error("Codex cancellation requires expectedTurnId from the latest agent status so a stale request cannot stop a newer turn.");
        error.code = "AGENT_TURN_GUARD_REQUIRED";
        return providerError(error);
      }
      let payload;
      try {
        payload = await target.cancel(ref, {
          requestId,
          ...(expectedTurnId ? { expectedTurnId } : {}),
        });
      } catch (error) {
        return providerError(error);
      }
      memory?.observeAgentStatus?.({ provider, ref, payload });
      return agentResult(payload, { providerId: provider, providerLabel: labelFor(provider), linkRef: ref });
    }
  );
}
