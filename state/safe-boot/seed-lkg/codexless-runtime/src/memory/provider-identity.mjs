export function normalizeMemoryProvider(provider) {
  const raw = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  if (!raw) return { provider: null, provider_family: null, provider_id: null };
  if (raw === "codex") return { provider: "codex", provider_family: "codex", provider_id: null };
  if (raw === "codex-a" || raw === "codex-b") return { provider: raw, provider_family: "codex", provider_id: raw };
  if (raw === "workbee" || raw === "mac") return { provider: "mac", provider_family: "mac", provider_id: "mac" };
  return { provider: raw, provider_family: raw, provider_id: raw };
}

export function memoryProviderMatches(item, provider) {
  const current = normalizeMemoryProvider(provider);
  const family = item?.provider_family || normalizeMemoryProvider(item?.provider).provider_family;
  const id = item?.provider_id || normalizeMemoryProvider(item?.provider).provider_id;
  if (!family && !id && !item?.provider) return true;
  if (id) return Boolean(current.provider_id && current.provider_id === id);
  return Boolean(family && current.provider_family === family);
}


// All populated qualifiers constrain retrieval, regardless of the primary scope.
export function memoryScopeMatches(item, { provider = null, project = null, tools = [] } = {}) {
  if (!item || !memoryProviderMatches(item, provider)) return false;
  if (item.project && item.project !== project) return false;
  if (item.tool && !tools.includes(item.tool)) return false;
  if (item.scope === "provider") return Boolean(provider && (item.provider || item.provider_family || item.provider_id));
  if (item.scope === "project") return Boolean(project && item.project);
  if (item.scope === "tool") return Boolean(item.tool && tools.includes(item.tool));
  return item.scope === "global" || item.scope === "machine";
}
