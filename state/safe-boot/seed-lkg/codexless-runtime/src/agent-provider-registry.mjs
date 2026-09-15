// Generic Agent Provider layer (Spike Bridge).
//
// Thin registry over provider modules. A provider adapts one agent runtime
// (Codex, ZCode, WorkBee, ...) to the minimal contract:
//
//   probe()                     -> { ok, provider, ...details }   (no model turn, no quota cost)
//   start({ task, project, options }) -> payload with .ref         (may return consent/taskId instead)
//   status(ref)                 -> payload
//   send(ref, message, options) -> payload
//   cancel(ref, options)        -> payload
//   models(options)             -> payload (optional, capability-gated)
//   usage()                     -> payload (optional; UNKNOWN when not really observable)
//
// Providers declare capabilities (resume/cancel/approval/models/usage/quota/
// streaming/remote) as plain booleans. Missing data is reported as UNKNOWN,
// never guessed. This module intentionally implements no capability engine,
// no scheduling, and no persistence.

const REQUIRED_METHODS = ["probe", "start", "status", "send", "cancel"];

function assertProviderShape(provider) {
  if (!provider || typeof provider !== "object") throw new TypeError("agent provider must be an object");
  if (typeof provider.id !== "string" || !provider.id.trim()) throw new TypeError("agent provider requires a non-empty string id");
  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== "function") throw new TypeError(`agent provider "${provider.id}" is missing ${method}()`);
  }
  if (provider.capabilities && (typeof provider.capabilities !== "object" || Array.isArray(provider.capabilities))) {
    throw new TypeError(`agent provider "${provider.id}" capabilities must be an object when present`);
  }
}

export function createAgentProviderRegistry({ providers = [], onError = null } = {}) {
  const map = new Map();
  const log = (event) => { if (typeof onError === "function") try { onError(event); } catch {} };

  function register(provider) {
    assertProviderShape(provider);
    if (map.has(provider.id)) throw new Error(`agent provider id already registered: ${provider.id}`);
    map.set(provider.id, provider);
    log({ event: "provider_registered", id: provider.id });
    return provider;
  }

  for (const provider of providers) register(provider);

  return {
    register,
    ids() { return [...map.keys()]; },
    get(id) { return typeof id === "string" ? map.get(id) ?? null : null; },
    require(id) {
      const provider = this.get(id);
      if (!provider) {
        const error = new Error(`unknown agent provider: ${String(id)}; registered: ${[...map.keys()].join(", ") || "none"}`);
        error.code = "AGENT_PROVIDER_UNKNOWN";
        throw error;
      }
      return provider;
    },
    list() {
      return [...map.values()].map((provider) => ({
        id: provider.id,
        displayName: provider.displayName ?? provider.id,
        capabilities: { ...(provider.capabilities ?? {}) },
      }));
    },
    async probeAll() {
      const results = {};
      for (const [id, provider] of map.entries()) {
        try {
          results[id] = await provider.probe();
        } catch (error) {
          results[id] = { ok: false, provider: id, error: error instanceof Error ? error.message : String(error) };
        }
      }
      return results;
    },
  };
}
