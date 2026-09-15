import { normalizeFailureSignature } from "./signatures.mjs";
import { memoryScopeMatches } from "./provider-identity.mjs";

function confidenceWeight(value) {
  return value === "verified" ? 32 : value === "medium" ? 12 : 2;
}

function scopeWeight(item, context) {
  if (item.scope === "tool") return 46;
  if (item.scope === "project") return 38;
  if (item.scope === "provider") return 32;
  if (item.scope === "machine") return 24;
  if (item.scope === "global") return 18;
  return 0;
}

function freshnessWeight(item, nowMs) {
  const stamp = Date.parse(item.last_verified_at || item.updated_at || item.created_at || "");
  if (!Number.isFinite(stamp)) return 0;
  const ageDays = Math.max(0, (nowMs - stamp) / 86400000);
  if (ageDays <= 7) return 10;
  if (ageDays <= 30) return 7;
  if (ageDays <= 90) return 4;
  if (ageDays <= 365) return 2;
  return 0;
}

function historicalUseWeight(item, nowMs) {
  const use = Math.min(12, Math.log2(1 + Math.max(0, Number(item.use_count ?? 0))) * 2.5);
  if (!item.last_used_at) return use * 0.35;
  const lastUsed = Date.parse(item.last_used_at);
  if (!Number.isFinite(lastUsed)) return use * 0.35;
  const ageDays = Math.max(0, (nowMs - lastUsed) / 86400000);
  const decay = ageDays <= 30 ? 1 : ageDays <= 180 ? 0.65 : ageDays <= 365 ? 0.4 : 0.2;
  return use * decay;
}

function textualMatch(item, task) {
  const terms = [...new Set(String(task ?? "").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 24);
  if (!terms.length) return 0;
  const haystack = [item.title, item.trigger, item.summary, item.failed_approach, item.root_cause, item.verified_fix, item.do_not_retry, ...(item.tags ?? [])]
    .filter(Boolean).join(" ").toLowerCase();
  let hits = 0;
  for (const term of terms) if (haystack.includes(term)) hits += 1;
  return Math.min(24, hits * 3);
}

function toSignature(value, context) {
  if (!value) return null;
  if (typeof value === "string" && /^[a-z0-9_.-]+(?:\|[a-z0-9_.-]+)*$/i.test(value) && value.length <= 512) return value.toLowerCase();
  if (typeof value === "object") return normalizeFailureSignature({ ...context, ...value });
  return normalizeFailureSignature({ ...context, message: String(value) });
}

export class MemoryRetriever {
  constructor({ store } = {}) {
    if (!store) throw new TypeError("MemoryRetriever requires store");
    this.store = store;
  }

  retrieve({ task = "", provider = null, project = null, tools = [], current_errors = [], limit = 24, markUsed = false } = {}) {
    const signatures = [...new Set((current_errors ?? []).map((value) => toSignature(value, { provider, tool: tools?.[0] ?? null })).filter(Boolean))];
    const candidates = this.store.searchActive({ query: task, signatures, limit: Math.max(100, limit * 8), context: { provider, project, tools } });
    const nowMs = Date.now();
    const signatureSet = new Set(signatures);
    const ranked = [];

    for (const item of candidates) {
      if (item.core) continue;
      if (!memoryScopeMatches(item, { provider, project, tools })) continue;
      let score = 0;
      const exactSignature = Boolean(item.error_signature && signatureSet.has(item.error_signature));
      if (exactSignature) score += 160;
      score += scopeWeight(item, { provider, project, tools });
      score += confidenceWeight(item.confidence);
      score += textualMatch(item, task);
      score += freshnessWeight(item, nowMs);
      score += historicalUseWeight(item, nowMs);
      if (item.kind === "do_not_retry" || item.do_not_retry) score += 22;
      if (item.verified_fix) score += 16;
      if (item.kind === "runbook") score += 6;
      ranked.push({ ...item, _memoryScore: Number(score.toFixed(3)), _exactErrorMatch: exactSignature });
    }

    ranked.sort((a, b) =>
      b._memoryScore - a._memoryScore ||
      String(b.last_verified_at || b.updated_at || "").localeCompare(String(a.last_verified_at || a.updated_at || "")) ||
      String(a.id).localeCompare(String(b.id)));

    const selected = ranked.slice(0, Math.max(1, Math.min(100, limit)));
    if (markUsed) this.store.markUsed(selected.map((item) => item.id));
    return { items: selected, signatures, totalCandidates: ranked.length };
  }

  core({ limit = 50, ...context } = {}) {
    return this.store.listCore({ limit, context });
  }
}
 
