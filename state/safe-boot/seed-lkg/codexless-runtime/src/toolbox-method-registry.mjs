import { readFileSync } from "node:fs";

const registryUrl = new URL("../config/toolbox-method-registry.json", import.meta.url);
let registry;
try {
  registry = JSON.parse(readFileSync(registryUrl, "utf8"));
} catch (error) {
  throw new Error(`failed to load Toolbox Cost/Mode Registry: ${error instanceof Error ? error.message : String(error)}`);
}

if (registry?.defaultAction !== "deny") {
  throw new Error("Toolbox Cost/Mode Registry must be fail-closed with defaultAction=deny");
}

export function getToolboxMethodRegistry() {
  return structuredClone(registry);
}

export function assertRemoteModelFreeMethod(method) {
  const entry = registry?.remoteAllowlist?.[method];
  if (!entry || entry.classification !== "model-free") {
    throw new Error(`Codex App Server method is not on the verified model-free remote allowlist: ${method}`);
  }
  return entry;
}

export function assertInternalHostMethod(method, capability) {
  const entry = registry?.internalHostAllowlist?.[method];
  if (!entry || entry.remoteExposure !== "deny" || entry.capability !== capability) {
    throw new Error(`Codex App Server host method is not accepted for internal capability ${capability}: ${method}`);
  }
  return entry;
}
