const SPIKE_PROVIDER_INTERNAL = Symbol.for("spike.bridge.agent-provider.internal");

function structuredPayload(result) {
  if (!result || typeof result !== "object") return null;
  return result.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : result;
}

function taskIds(payload) {
  return [payload?.taskId, payload?.shortTaskId, payload?.taskRef]
    .filter((value) => typeof value === "string" && value.trim());
}

function agentRefs(payload) {
  return [payload?.agentRef, payload?.ref, payload?.taskCard?.agentRef]
    .filter((value) => typeof value === "string" && value.trim());
}

export function createCodexAgentRouter() {
  const taskOwners = new Map();
  const agentOwners = new Map();
  const routedControls = new Set([
    "codex.agent_commit",
    "codex.agent_decline",
    "codex.agent_show",
    "codex.agent_send",
    "codex.agent_cancel",
    "codex.agent_approve",
    "codex.agent_reject",
  ]);

  function ownerRecord(handlers, providerId = null) {
    if (!handlers || typeof handlers.get !== "function") return null;
    return {
      handlers,
      providerId: typeof providerId === "string" && providerId.trim() ? providerId.trim() : null,
      primary: false,
    };
  }

  function primaryOwnerRecord(providerId = "codex-a") {
    return {
      handlers: null,
      providerId: typeof providerId === "string" && providerId.trim() ? providerId.trim() : "codex-a",
      primary: true,
    };
  }

  function bindOwner(payload, owner) {
    if (!owner) return;
    const value = structuredPayload(payload);
    if (!value) return;
    for (const taskId of taskIds(value)) taskOwners.set(taskId, owner);
    for (const agentRef of agentRefs(value)) agentOwners.set(agentRef, owner);
  }

  function bind(payload, handlers, providerId = null) {
    bindOwner(payload, ownerRecord(handlers, providerId));
  }

  function bindPrimary(payload, providerId = "codex-a") {
    bindOwner(payload, primaryOwnerRecord(providerId));
  }

  function resolveOwner(name, input = {}) {
    if (input?.[SPIKE_PROVIDER_INTERNAL] === true) return null;
    if (name === "codex.agent_commit" || name === "codex.agent_decline") {
      return typeof input.taskId === "string" ? taskOwners.get(input.taskId) ?? null : null;
    }
    if (["codex.agent_show", "codex.agent_send", "codex.agent_cancel", "codex.agent_approve", "codex.agent_reject"].includes(name)) {
      return typeof input.agentRef === "string" ? agentOwners.get(input.agentRef) ?? null : null;
    }
    return null;
  }

  function resolve(name, input = {}) {
    return resolveOwner(name, input)?.handlers ?? null;
  }

  function resolveProvider(name, input = {}) {
    return resolveOwner(name, input)?.providerId ?? null;
  }

  function unknownRouteError(name, input = {}) {
    const identity = typeof input.taskId === "string" && input.taskId.trim()
      ? `taskId=${input.taskId.trim()}`
      : typeof input.agentRef === "string" && input.agentRef.trim()
        ? `agentRef=${input.agentRef.trim()}`
        : "missing identity";
    const error = new Error(`Codex agent route is unknown for ${name} (${identity}); refusing to guess Codex A/B ownership.`);
    error.code = "AGENT_ROUTE_UNKNOWN";
    error.nextActions = [
      "Use the generic Spike agent surface with an explicit provider when the owner is known.",
      "If this task should survive restart, restore its persisted owner mapping before retrying the public codex.agent_* control.",
      "Do not default an unknown agentRef/taskId to Codex A.",
    ];
    return error;
  }

  function wrap(name, primaryHandler) {
    if (typeof primaryHandler !== "function") return primaryHandler;
    if (!name.startsWith("codex.agent_")) return primaryHandler;
    return async (input = {}, ...rest) => {
      const internal = input?.[SPIKE_PROVIDER_INTERNAL] === true;
      const owner = resolveOwner(name, input);
      if (!owner && !internal && routedControls.has(name)) throw unknownRouteError(name, input);

      let handler = primaryHandler;
      if (owner && owner.primary !== true) {
        const routed = owner.handlers?.get?.(name);
        if (typeof routed !== "function") {
          const error = new Error(`Codex agent owner ${owner.providerId ?? "unknown"} has no handler for ${name}.`);
          error.code = "AGENT_ROUTE_HANDLER_MISSING";
          throw error;
        }
        handler = routed;
      }

      const result = await handler(input, ...rest);
      if (owner?.primary === true) bindPrimary(result, owner.providerId ?? "codex-a");
      else if (owner) bind(result, owner.handlers, owner.providerId);
      else if (!internal && name === "codex.agent_start") bindPrimary(result, "codex-a");
      return result;
    };
  }

  return {
    bind,
    bindPrimary,
    resolve,
    resolveProvider,
    wrap,
    snapshot() { return { taskRoutes: taskOwners.size, agentRoutes: agentOwners.size }; },
  };
}
