import { createHash } from "node:crypto";
import { normalizeFailureSignature } from "./signatures.mjs";
import { memoryScopeMatches } from "./provider-identity.mjs";

export { redactSecrets } from "./redaction.mjs";

function sameScope(item, { provider = null, project = null, tool = null } = {}) {
  return item?.status === "active" && memoryScopeMatches(item, { provider, project, tools: tool ? [tool] : [] });
}

function approachMatches(memory, approach) {
  const candidate = String(approach ?? "").trim().toLowerCase();
  if (!candidate) return true;
  const bad = [memory.failed_approach, memory.do_not_retry].filter(Boolean).join(" ").toLowerCase();
  if (!bad) return memory.kind === "do_not_retry";
  const tokens = candidate.match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
  return tokens.some((token) => bad.includes(token)) || bad.includes(candidate);
}

export function memoryJobKey({ provider = "", ref = "", project = "", task = "", phase = "" } = {}) {
  const raw = [provider, ref, project, task, phase].join("\u001f");
  return createHash("sha256").update(raw).digest("hex").slice(0, 20);
}

export class MemoryGuard {
  constructor({ store } = {}) {
    if (!store) throw new TypeError("MemoryGuard requires store");
    this.store = store;
  }

  lastSignature(jobKey) {
    return this.store.lastJobFailure(String(jobKey))?.signature ?? null;
  }

  beforeAttempt({ jobKey, signature = null, approach = null, provider = null, project = null, tool = null } = {}) {
    const key = String(jobKey ?? "");
    const effectiveSignature = signature || this.lastSignature(key) || null;
    if (!effectiveSignature) return { blocked: false, action: "proceed", signature: null, memories: [] };

    const memories = this.store.findBySignature(effectiveSignature, { activeOnly: true, limit: 50, context: { provider, project, tool } })
      .filter((item) => sameScope(item, { provider, project, tool }));
    const blockedMemory = memories.find((item) =>
      item.confidence === "verified" && (item.do_not_retry || item.kind === "do_not_retry") && approachMatches(item, approach));
    const fixMemory = memories.find((item) => item.confidence === "verified" && item.verified_fix);

    if (blockedMemory) {
      return {
        blocked: true,
        action: fixMemory ? "prefer_verified_fix" : "surface_blocker",
        reason: "verified_do_not_retry",
        signature: effectiveSignature,
        memoryId: blockedMemory.id,
        recommendedFix: fixMemory?.verified_fix ?? null,
        memories,
      };
    }

    const count = this.store.jobFailureCount(key, effectiveSignature);
    if (count >= 2) {
      return {
        blocked: true,
        action: fixMemory ? "prefer_verified_fix" : "change_strategy_or_surface_blocker",
        reason: "same_signature_count_gte_2",
        signature: effectiveSignature,
        recommendedFix: fixMemory?.verified_fix ?? null,
        memories,
      };
    }

    if (fixMemory) {
      return {
        blocked: false,
        action: "prefer_verified_fix",
        reason: "verified_fix_available",
        signature: effectiveSignature,
        recommendedFix: fixMemory.verified_fix,
        memories,
      };
    }
    return { blocked: false, action: "proceed", signature: effectiveSignature, memories };
  }

  onFailure({ jobKey, provider = null, project = null, tool = null, error = null, message = null, stderr = null, httpStatus = null, exitCode = null, errorCode = null, errorClass = null, knownId = null } = {}) {
    const signature = normalizeFailureSignature({
      provider, tool, message: message ?? error?.message ?? String(error ?? ""), stderr, httpStatus, exitCode,
      errorCode: errorCode ?? error?.code, errorClass: errorClass ?? error?.name, knownId,
    });
    const key = String(jobKey ?? "global");
    const persisted = this.store.recordJobFailure({
      jobKey: key, signature, provider, project, tool,
      error_code: errorCode ?? error?.code ?? null,
      error_excerpt: stderr || message || error?.message || String(error ?? ""),
    });
    const sameJobCount = persisted.sameJobCount;

    const memories = this.store.findBySignature(signature, { activeOnly: true, limit: 50, context: { provider, project, tool } })
      .filter((item) => sameScope(item, { provider, project, tool }));
    const doNotRetry = memories.find((item) => item.confidence === "verified" && (item.do_not_retry || item.kind === "do_not_retry"));
    const fix = memories.find((item) => item.confidence === "verified" && item.verified_fix);

    let action = "handle_normally";
    let blocked = false;
    if (doNotRetry) {
      action = fix ? "prefer_verified_fix" : "surface_blocker";
      blocked = true;
    } else if (sameJobCount >= 2) {
      action = fix ? "prefer_verified_fix" : "change_strategy_or_surface_blocker";
      blocked = true;
    } else if (fix) {
      action = "prefer_verified_fix";
    }

    return {
      signature,
      sameJobCount,
      scopeCount: persisted.scopeCount,
      failureId: persisted.failureId,
      memories,
      blocked,
      action,
      recommendedFix: fix?.verified_fix ?? null,
      doNotRetry: doNotRetry?.do_not_retry ?? null,
    };
  }

  clearJob(jobKey) {
    return this.store.clearJobFailures(String(jobKey ?? ""));
  }
}
 
