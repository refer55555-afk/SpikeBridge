import { MemoryStore, defaultMemoryDbPath } from "./store.mjs";
import { MemoryRetriever } from "./retriever.mjs";
import { buildMemoryCapsule } from "./capsule.mjs";
import { MemoryRecorder } from "./recorder.mjs";
import { MemoryGuard, memoryJobKey, redactSecrets } from "./guard.mjs";
import { MemoryCompactor } from "./compactor.mjs";
import { normalizeFailureSignature } from "./signatures.mjs";

import { normalizeMemoryProvider } from "./provider-identity.mjs";

const OPEN = "<experience_memory>";

function injectCapsule(text, capsule) {
  const base = String(text ?? "");
  if (!capsule?.text || capsule.itemCount + capsule.coreIds.length === 0 || base.includes(OPEN)) return base;
  return `${base}\n\n${capsule.text}`;
}

function safeError(error) {
  if (error && typeof error === "object") {
    return { name: error.name ?? null, code: error.code ?? null, message: redactSecrets(error.message ?? String(error)) };
  }
  return { name: null, code: null, message: redactSecrets(String(error ?? "")) };
}

export class ExperienceMemory {
  constructor({ dbPath = defaultMemoryDbPath(), enabled = true, capsuleConfig = {}, seed = true } = {}) {
    this.enabled = enabled !== false;
    this.dbPath = dbPath;
    this.capsuleConfig = capsuleConfig;
    this.store = null;
    this.retriever = null;
    this.recorder = null;
    this.guard = null;
    this.compactor = null;
    this.initError = null;
    if (!this.enabled) return;
    try {
      this.store = new MemoryStore({ dbPath });
      this.retriever = new MemoryRetriever({ store: this.store });
      this.recorder = new MemoryRecorder({ store: this.store });
      this.guard = new MemoryGuard({ store: this.store });
      this.compactor = new MemoryCompactor({ store: this.store });
      if (seed) this.recorder.seedVerifiedLessons();
    } catch (error) {
      this.initError = error;
      this.enabled = false;
      try { this.store?.close(); } catch {}
      this.store = this.retriever = this.recorder = this.guard = this.compactor = null;
    }
  }

  status() {
    return {
      enabled: this.enabled,
      dbPath: this.dbPath,
      initError: this.initError ? safeError(this.initError) : null,
      ...(this.store ? this.store.stats() : {}),
    };
  }

  /**
   * Stable upper-layer entry for a user-explicit memory request.
   * This is intentionally in-process only: it does not register an MCP tool and
   * it never infers intent from arbitrary task/chat prose.
   */
  rememberExplicit({
    explicitUserIntent = false,
    title,
    summary,
    scope,
    provider = null,
    project = null,
    tool = null,
    tags = [],
  } = {}) {
    if (!this.enabled) throw new Error("experience memory is disabled");
    if (explicitUserIntent !== true) throw new Error("explicit user intent required for memory write");
    if (typeof scope !== "string" || !scope.trim()) throw new TypeError("explicit memory scope is required");
    const item = this.write({
      type: "rule",
      title,
      summary,
      scope: scope.trim(),
      provider,
      project,
      tool,
      tags,
      evidence_ref: "user-explicit",
    });
    return {
      receiptVersion: "spike.experience-memory.explicit.v1",
      accepted: true,
      memoryId: item.id,
      kind: item.kind,
      title: item.title,
      summary: item.summary,
      scope: item.scope,
      provider: item.provider,
      project: item.project,
      tool: item.tool,
      confidence: item.confidence,
      status: item.status,
      evidenceRef: item.evidence_ref,
    };
  }

  /**
   * Internal in-process write path. Only trusted callers invoke this explicitly;
   * capsules, task text, and public MCP arguments are never interpreted as writes.
   */
  write({ type, ...input } = {}) {
    if (!this.enabled) throw new Error("experience memory is disabled");
    switch (type) {
      case "rule": return this.recorder.recordExplicitRule(input);
      case "fact": return this.recorder.recordStableFact(input);
      case "lesson": return this.recorder.recordVerifiedLesson(input);
      case "verification": {
        if (!input.memory_id || !this.store.getItem(input.memory_id)) throw new Error("unknown memory candidate");
        return this.recorder.activateVerified(input.memory_id, input);
      }
      default: throw new TypeError("unknown internal memory write type");
    }
  }

  #jobContext({ jobKey = null, provider = null, project = null, tool = null } = {}) {
    const prior = jobKey ? this.store.getJob(jobKey) : null;
    if (prior && ((provider && prior.provider && normalizeMemoryProvider(provider).provider !== prior.provider)
      || (project && prior.project && project !== prior.project))) {
      throw new Error("memory job scope mismatch");
    }
    provider = prior?.provider || provider;
    project = prior?.project || project;
    return { jobKey: jobKey || memoryJobKey({ provider, project, task: tool, phase: "failure" }), provider, project, tool };
  }

  retrieve(context = {}) {
    if (!this.enabled) return { items: [], signatures: [], totalCandidates: 0 };
    return this.retriever.retrieve(context);
  }

  buildCapsule(context = {}) {
    if (!this.enabled) return { text: "", tokens: 0, coreTokens: 0, itemCount: 0, runbookCount: 0, itemIds: [], coreIds: [] };
    const found = this.retriever.retrieve({ ...context, markUsed: false });
    const capsule = buildMemoryCapsule({ coreItems: this.retriever.core(context), items: found.items, config: this.capsuleConfig });
    if (capsule.itemIds.length) this.store.markUsed(capsule.itemIds);
    return { ...capsule, signatures: found.signatures };
  }

  beforeAgentStart({ task, provider, project = null, tools = [], current_errors = [] } = {}) {
    if (!this.enabled) return { task, capsule: null, jobKey: memoryJobKey({ provider, project, task, phase: "start" }), guard: { blocked: false, action: "proceed" } };
    const jobKey = memoryJobKey({ provider, project, task, phase: "start" });
    const capsule = this.buildCapsule({ task, provider, project, tools, current_errors });
    const guardState = this.guard.beforeAttempt({ jobKey, provider, project, tool: tools?.[0] ?? null });
    if (!guardState.blocked) this.store.upsertJob({ jobKey, provider, project, task, status: "active" });
    return { task: injectCapsule(task, capsule), capsule, jobKey, guard: guardState };
  }

  bindJobRef(jobKey, ref) {
    if (!this.enabled || !jobKey || !ref) return;
    this.store.bindJobRef(jobKey, ref);
  }

  jobForRef(provider, ref) {
    if (!this.enabled || !ref) return null;
    const row = this.store.findJobForRef(provider, ref);
    return row ? { ...row, jobKey: row.job_key, ref: row.ref } : null;
  }

  observeAgentStatus({ provider, ref, project = null, payload = null } = {}) {
    if (!this.enabled || !payload) return null;
    const prior = this.jobForRef(provider, ref) ?? {};
    const jobKey = prior.jobKey || memoryJobKey({ provider, ref, project: project || prior.project || null, phase: "status" });
    const effectiveProject = project || prior.project || null;
    const status = String(payload.status ?? payload.agentState?.status ?? "").toLowerCase();
    const failed = ["failed", "lost", "error", "unknown"].includes(status) && Boolean(payload.error || payload.detail || payload.errorCode || payload.exitCode);
    const completed = ["completed", "idle", "interrupted"].includes(status);
    if (failed && prior.completed_at && prior.status === status) return { completed: true, jobKey, repeatedObservation: true };
    if (failed) {
      return this.store.transaction(() => {
        if (!prior.jobKey) this.store.upsertJob({ jobKey, provider, project: effectiveProject, ref });
        const failure = this.onProviderFailure({ jobKey, provider, project: effectiveProject, payload });
        this.store.finishJob(jobKey, status || "failed");
        return { ...failure, completed: true, jobKey };
      });
    }
    if (completed) {
      this.onJobCompleted({ jobKey, provider, project: effectiveProject, payload });
      return { completed: true, jobKey };
    }
    return { completed: false, jobKey };
  }

  beforeAgentSend({ ref, message, provider, project = null, tools = [], current_errors = [], approach = null } = {}) {
    const prior = this.enabled ? (this.jobForRef(provider, ref) ?? {}) : {};
    const effectiveProject = project || prior.project || null;
    const jobKey = prior.jobKey || memoryJobKey({ provider, ref, project: effectiveProject, phase: "send" });
    if (!this.enabled) return { message, capsule: null, jobKey, guard: { blocked: false, action: "proceed" } };
    this.#jobContext({ jobKey, provider, project: effectiveProject });
    const lastSignature = this.guard.lastSignature(jobKey);
    const errors = [...(current_errors ?? []), ...(lastSignature ? [lastSignature] : [])];
    const guardState = this.guard.beforeAttempt({ jobKey, signature: lastSignature, approach, provider, project: effectiveProject, tool: tools?.[0] ?? null });
    const capsule = this.buildCapsule({ task: message, provider, project: effectiveProject, tools, current_errors: errors });
    if (!guardState.blocked) this.store.upsertJob({ jobKey, provider, project: effectiveProject, ref, status: "active" });
    return { message: injectCapsule(message, capsule), capsule, jobKey, guard: guardState, project: effectiveProject };
  }

  beforeProviderAttempt({ jobKey, signature = null, approach = null, provider = null, project = null, tool = null } = {}) {
    if (!this.enabled) return { blocked: false, action: "proceed", signature };
    return this.guard.beforeAttempt({ jobKey, signature, approach, provider, project, tool });
  }

  onProviderFailure({ jobKey, provider = null, project = null, tool = null, error = null, payload = null } = {}) {
    if (!this.enabled) return { blocked: false, action: "handle_normally", signature: null };
    ({ jobKey, provider, project, tool } = this.#jobContext({ jobKey, provider, project, tool }));
    const message = error?.message || payload?.error || payload?.detail || payload?.message || null;
    return this.store.transaction(() => {
      const failure = this.guard.onFailure({
        jobKey, provider, project, tool, error, message,
        stderr: payload?.stderr, httpStatus: payload?.httpStatus ?? payload?.statusCode,
        exitCode: payload?.exitCode, errorCode: payload?.errorCode ?? payload?.code,
      });
      const recorded = this.recorder.recordFailure({
        job_id: jobKey, provider, project, tool, error, message, stderr: payload?.stderr,
        errorCode: payload?.errorCode ?? payload?.code, httpStatus: payload?.httpStatus ?? payload?.statusCode,
        exitCode: payload?.exitCode, signature: failure.signature,
      });
      return { ...failure, memoryId: recorded.item?.id ?? null, candidateId: recorded.candidate?.id ?? null };
    });
  }

  onToolFailure({ jobKey = null, provider = null, project = null, tool = null, error = null, payload = null } = {}) {
    return this.onProviderFailure({ jobKey, provider, project, tool, error, payload });
  }

  onJobCompleted({ jobKey = null, provider = null, project = null, tool = null, payload = null } = {}) {
    if (!this.enabled) return null;
    const context = this.#jobContext({ jobKey, provider, project, tool });
    const terminalStatus = String(payload?.status ?? "completed").toLowerCase() || "completed";
    let lesson = null;
    this.store.transaction(() => {
      // Only an explicit, complete, evidenced episode can activate learning.
      if (["completed", "idle"].includes(terminalStatus) && payload?.memoryLesson && payload?.verification) {
        const input = payload.memoryLesson;
        const failure = jobKey ? this.store.lastJobFailure(jobKey, { includeResolved: true }) : null;
        const linked = jobKey ? this.store.itemsForJob(jobKey) : [];
        const signature = input.error_signature || failure?.signature;
        const candidate = input.memory_id ? this.store.getItem(input.memory_id)
          : linked.find((item) => signature ? item.error_signature === signature : item.title === input.title);
        if (candidate && !linked.some((item) => item.id === candidate.id)) {
          throw new Error("memory candidate is not linked to this job");
        }
        const lessonProvider = context.provider || candidate?.provider || failure?.provider_id || failure?.provider_family || null;
        const lessonProject = context.project || candidate?.project || failure?.project || null;
        const lessonTool = context.tool || candidate?.tool || failure?.tool || null;
        if (!candidate && failure && (signature !== failure.signature
          || !this.store.scopedFailures(signature, { provider: lessonProvider, project: lessonProject, tool: lessonTool })
            .some((row) => row.id === failure.id))) {
          throw new Error("memory verification failure scope or signature mismatch");
        }
        lesson = this.write({
          ...input, type: "lesson", memory_id: input.memory_id || candidate?.id,
          // The operational job owns the identity, including when input claims a broader scope.
          provider: lessonProvider, provider_id: undefined, provider_family: undefined,
          project: lessonProject, tool: lessonTool,
          scope: candidate?.scope || (lessonTool ? "tool" : lessonProvider ? "provider" : lessonProject ? "project" : "machine"),
          error_signature: input.error_signature || candidate?.error_signature || failure?.signature || null,
          job_id: jobKey, verification: payload.verification, evidence: payload.evidence,
        });
      }
      if (jobKey) {
        this.store.finishJob(jobKey, terminalStatus);
        this.guard.clearJob(jobKey);
      }
    });
    return lesson;
  }

  onJobFailed(context = {}) {
    const failure = this.onProviderFailure(context);
    if (this.enabled && context?.jobKey) this.store.finishJob(context.jobKey, "failed");
    return failure;
  }

  compact(options = {}) {
    if (!this.enabled) return { skipped: true, reason: "memory_disabled" };
    return this.compactor.compact(options);
  }

  search(query, context = {}) {
    if (!this.enabled) return [];
    return this.retriever.retrieve({ task: query, ...context, limit: context.limit ?? 50 }).items;
  }

  inspect(id) {
    if (!this.enabled) return null;
    const item = this.store.getItem(id);
    if (!item) return null;
    return { item, evidence: this.store.getEvidence(id, { limit: 100 }) };
  }

  forget(id) {
    if (!this.enabled) return false;
    return this.store.deleteItem(id);
  }

  exportSanitized() {
    if (!this.enabled) return { version: 1, items: [] };
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      items: this.store.allItems({ includeRejected: true, limit: 100000 }).map((item) => ({
        ...item,
        title: redactSecrets(item.title), trigger: redactSecrets(item.trigger), summary: redactSecrets(item.summary),
        failed_approach: redactSecrets(item.failed_approach), root_cause: redactSecrets(item.root_cause),
        verified_fix: redactSecrets(item.verified_fix), do_not_retry: redactSecrets(item.do_not_retry),
      })),
    };
  }

  close() {
    try { this.store?.close(); } catch {}
  }
}

export function createExperienceMemory(options = {}) {
  return new ExperienceMemory(options);
}

export { MemoryStore, MemoryRetriever, MemoryRecorder, MemoryGuard, MemoryCompactor, buildMemoryCapsule, normalizeFailureSignature, redactSecrets, memoryJobKey };
 
