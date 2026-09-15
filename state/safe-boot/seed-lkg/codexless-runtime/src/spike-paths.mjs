import path from "node:path";

export function resolveSpikeBridgeRoot({ env = process.env, defaultCwd = process.cwd() } = {}) {
  const explicit = typeof env?.SPIKE_BRIDGE_ROOT === "string" ? env.SPIKE_BRIDGE_ROOT.trim() : "";
  return path.resolve(explicit || defaultCwd);
}

export function spikeAccountHome(root, accountId) {
  return path.join(path.resolve(root), "accounts", String(accountId));
}

export function spikeAgentStateDir(root, providerId) {
  return path.join(path.resolve(root), "state", "agents", String(providerId));
}

export function spikeAgentTaskStateFile(root, providerId) {
  return path.join(spikeAgentStateDir(root, providerId), "agent-task-cards.json");
}

export function spikeZCodeStateFile(root) {
  return path.join(spikeAgentStateDir(root, "zcode"), "jobs.json");
}

export function spikeMacStateDir(root) {
  return spikeAgentStateDir(root, "mac");
}

export function spikeMacSecretFile(root) {
  return path.join(path.resolve(root), "secrets", "mac", "pairing.secret");
}

export function spikeMemoryDbFile(root) {
  return path.join(path.resolve(root), "data", "memory", "experience.db");
}

export function spikeCodexCallProfileFile(root) {
  return path.join(path.resolve(root), "config", "codex-call-profile.md");
}
