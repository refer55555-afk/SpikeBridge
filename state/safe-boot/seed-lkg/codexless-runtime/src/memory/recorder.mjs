import { createHash } from "node:crypto";
import { redactSecrets } from "./redaction.mjs";
import { normalizeFailureSignature } from "./signatures.mjs";

const DAY = 86_400_000;
function inDays(days) { return new Date(Date.now() + days * DAY).toISOString(); }

const VERIFIED_SEEDS = Object.freeze([
  {
    id: "seed_provider_failure_boundary",
    kind: "fact", scope: "global", core: true,
    title: "Provider failure is not whole Bridge failure",
    summary: "One provider being offline or failed is provider state; it must not be treated as evidence that the whole Bridge is down.",
    confidence: "verified", status: "active", evidence_ref: "public-seed:v1",
  },
  {
    id: "seed_localhost_no_proxy",
    kind: "lesson", scope: "machine", core: true,
    title: "Loopback proxy bypass",
    trigger: "localhost HTTP/fetch traffic fails or returns proxy 502 while a system proxy is active",
    failed_approach: "Repeatedly restart the local Bridge without first checking loopback proxy bypass.",
    root_cause: "Loopback traffic may be sent through a configured proxy when NO_PROXY does not explicitly include localhost addresses.",
    verified_fix: "Ensure NO_PROXY includes 127.0.0.1,localhost,::1, then retry the original loopback request once.",
    do_not_retry: "Do not repeatedly restart a healthy local service for a localhost proxy 502 before checking NO_PROXY.",
    error_signature: "localhost_httpx_502",
    confidence: "verified", status: "active", evidence_ref: "public-seed:v1",
    tags: ["proxy", "localhost", "NO_PROXY"],
  },
  {
    id: "seed_safe_boot_lkg",
    kind: "procedure", scope: "global", core: true,
    title: "Promote only a verified immutable release",
    trigger: "A working-tree change is ready to become production",
    failed_approach: "Point production directly at a mutable working tree and rely on manual rollback.",
    root_cause: "Mutable production makes identity, rollback and recovery ambiguous.",
    verified_fix: "Freeze the candidate, verify it independently, then promote it through Safe-Boot and retain the previous LKG for recovery.",
    do_not_retry: "Do not bypass the release verification chain for normal deployment.",
    confidence: "verified", status: "active", evidence_ref: "public-seed:v1",
  },
  {
    id: "seed_browser_stale_refs",
    kind: "lesson", scope: "tool", tool: "codex.browser_tabs",
    title: "Refresh Browser references after backend recovery",
    trigger: "Browser backend restarts or reconnects after an error",
    failed_approach: "Replay a mutation with tab or element references captured before the backend changed.",
    root_cause: "Browser references are session/backend scoped and can become stale after recovery.",
    verified_fix: "Refresh browser tabs and page state, then prepare a new exact action using fresh references.",
    do_not_retry: "Do not auto-replay stale Browser mutations after a reconnect.",
    error_signature: "browser_tabs_fetch_failed",
    confidence: "verified", status: "active", evidence_ref: "public-seed:v1",
  },
  {
    id: "seed_account_home_isolation",
    kind: "fact", scope: "global",
    title: "Codex account homes stay isolated",
    summary: "Separate Codex identities must use separate CODEX_HOME directories and must not share auth state implicitly.",
    confidence: "verified", status: "active", evidence_ref: "public-seed:v1",
    tags: ["codex", "identity", "account"],
  },
  {
    id: "seed_tunnel_identity_isolation",
    kind: "fact", scope: "global",
    title: "Tunnel identities stay isolated",
    summary: "Multiple remote tunnel lanes may share one local MCP target, but each lane must keep its own tunnel identity, credentials, profile, state and logs.",
    confidence: "verified", status: "active", evidence_ref: "public-seed:v1",
    tags: ["tunnel", "identity", "multi-account"],
  },
  {
    id: "seed_zcode_unknown_quota",
    kind: "fact", scope: "provider", provider: "zcode",
    title: "Do not invent unavailable ZCode quota",
    summary: "Per-task usage may be observable from provider results, while account-level quota can remain unavailable; unavailable quota must stay UNKNOWN rather than being guessed.",
    confidence: "verified", status: "active", evidence_ref: "public-seed:v1",
    tags: ["zcode", "usage", "quota"],
  },
  {
    id: "seed_mac_offline_boundary",
    kind: "fact", scope: "provider", provider: "mac",
    title: "Mac offline is provider state",
    summary: "A remote Mac being offline is Mac provider state, not evidence that the local Bridge service is down.",
    confidence: "verified", status: "active", evidence_ref: "public-seed:v1",
    tags: ["mac", "offline", "provider"],
  },
  {
    id: "seed_secret_local_only",
    kind: "rule", scope: "global",
    title: "Keep credentials and runtime state local",
    summary: "Auth files, API keys, tunnel credentials, Memory databases, task state and logs are local runtime data and must not be committed to a public repository.",
    confidence: "verified", status: "active", evidence_ref: "public-seed:v1",
    tags: ["privacy", "secrets", "git"],
  },
  {
    id: "seed_authority_boundary",
    kind: "rule", scope: "global",
    title: "Task intent cannot widen authority",
    summary: "A task request cannot grant itself filesystem, command, network or approval authority beyond the active trusted project and permission profile.",
    confidence: "verified", status: "active", evidence_ref: "public-seed:v1",
    tags: ["authority", "permissions"],
  },
  {
    id: "seed_memory_scope_isolation",
    kind: "rule", scope: "global",
    title: "Memory respects provider and project scope",
    summary: "Provider-, project- and tool-scoped Memory entries must not leak into unrelated identities or projects.",
    confidence: "verified", status: "active", evidence_ref: "public-seed:v1",
    tags: ["memory", "scope", "isolation"],
  },
  {
    id: "seed_loopback_boundary",
    kind: "fact", scope: "global",
    title: "Management services stay on loopback by default",
    summary: "The Bridge MCP and local Operator are intended to bind to loopback by default; remote access should use an explicit authenticated tunnel rather than direct public exposure.",
    confidence: "verified", status: "active", evidence_ref: "public-seed:v1",
    tags: ["network", "loopback"],
  },
]);

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function required(value, name) {
  if (!text(value)) throw new TypeError(`memory write requires ${name}`);
  return value;
}
function scopeOf(input, fallback = "global") {
  const provider = input.provider_id || input.provider || input.provider_family || null;
  const project = input.project || null;
  const tool = input.tool || null;
  const scope = input.scope || (tool ? "tool" : provider ? "provider" : project ? "project" : fallback);
  if (!["global", "machine", "provider", "project", "tool"].includes(scope)) throw new TypeError("invalid memory scope");
  if (scope === "provider" && !provider || scope === "project" && !project || scope === "tool" && !tool) {
    throw new TypeError(`memory ${scope} scope requires its qualifier`);
  }
  return { scope, provider, project, tool };
}
function verificationOf(verification, evidence) {
  const structured = verification && typeof verification === "object";
  const signals = structured ? [verification.status, verification.result, verification.ok].filter((v) => v !== undefined) : [];
  const passed = signals.length > 0 && signals.every((v) => v === "PASS" || v === true);
  const evidence_ref = text(verification?.evidence_ref) || text(evidence?.evidence_ref);
  const result_excerpt = text(verification?.result_excerpt) || text(evidence?.result_excerpt);
  return { passed: Boolean(passed && evidence_ref && result_excerpt), evidence_ref, result_excerpt };
}
function completeLesson(item) {
  return ["title", "trigger", "failed_approach", "root_cause", "verified_fix"].every((key) => text(item[key]));
}

export class MemoryRecorder {
  constructor({ store } = {}) {
    if (!store) throw new TypeError("MemoryRecorder requires store");
    this.store = store;
  }

  seedVerifiedLessons() {
    return VERIFIED_SEEDS.map((seed) => this.store.ensureItem(seed));
  }

  // Explicit writes are internal, trusted caller operations. Task prose is never parsed as a write.
  recordExplicitRule(input = {}) {
    return this.recordStableFact({ ...input, scope: scopeOf(input).scope, verified: true, evidence_ref: input.evidence_ref || "user-explicit" });
  }

  recordStableFact(input = {}) {
    required(input.title, "title");
    required(input.summary, "summary");
    const identity = scopeOf(input, "machine");
    const verified = input.verified === true;
    if (verified) required(input.evidence_ref, "evidence_ref");
    return this.store.transaction(() => {
      const prior = this.store.findMatchingItems({ ...identity, title: input.title, kind: "fact" })
        .find((item) => item.summary === redactSecrets(input.summary).trim());
      // Repeating an observation cannot downgrade an already verified fact.
      if (prior?.status === "active") return prior;
      const item = this.store.putItem({
        ...prior, ...identity, kind: "fact", title: input.title, summary: input.summary,
        core: input.core === true, tags: input.tags || [],
        confidence: verified ? "verified" : "medium", status: verified ? "active" : "candidate",
        evidence_ref: input.evidence_ref || null,
        expires_at: verified ? null : inDays(7), valid_to: null,
        last_verified_at: verified ? new Date().toISOString() : null,
      });
      this.#evidence(item, {
        event_type: verified ? "explicit_fact" : "observation",
        result_excerpt: input.evidence_ref || input.summary,
      });
      return item;
    });
  }


  recordFailure({ provider = null, project = null, tool = null, error = null, message = null, stderr = null, errorCode = null, httpStatus = null, exitCode = null, signature = null } = {}) {
    const normalized = signature || normalizeFailureSignature({
      provider, tool, message: message ?? error?.message ?? String(error ?? ""), stderr,
      errorCode: errorCode ?? error?.code, httpStatus, exitCode, errorClass: error?.name,
    });
    const identity = scopeOf({ provider, project, tool }, "machine");
    return this.store.transaction(() => {
      // The threshold is durable evidence, never a caller's claimed occurrence count.
      const failures = this.store.scopedFailures(normalized, identity);
      const count = failures.length;
      if (count < 2) return { signature: normalized, count, candidate: null, item: null };
      const matches = this.store.findMatchingItems({ ...identity, error_signature: normalized })
        .filter((item) => ["lesson", "do_not_retry"].includes(item.kind));
      let item = matches.find((entry) => entry.status === "active" && entry.confidence === "verified")
        || matches.find((entry) => entry.status === "candidate");
      if (!item) item = this.store.putItem({
        kind: "lesson", ...identity,
        title: `Repeated failure: ${normalized}`,
        trigger: `The normalized failure signature ${normalized} repeated.`,
        summary: "Repeated failure observed; root cause and fix not yet verified.",
        error_signature: normalized, confidence: "low", status: "candidate",
        expires_at: inDays(7), tags: ["repeated-failure"],
      });
      this.store.linkFailureEvidence(item.id);
      return { signature: normalized, count, candidate: item.status === "candidate" ? item : null, item };
    });
  }

  recordVerifiedLesson(input = {}) {
    const priorById = input.memory_id ? this.store.getItem(input.memory_id) : null;
    if (input.memory_id && !priorById) throw new Error("unknown memory candidate");
    if (priorById && (!["candidate", "active"].includes(priorById.status) || !["lesson", "do_not_retry"].includes(priorById.kind))) {
      throw new Error("memory item cannot be promoted");
    }
    const identity = scopeOf({ ...priorById, provider_id: undefined, provider_family: undefined, ...input });
    if (priorById && !this.store.sameItemIdentity(priorById, identity)) throw new Error("memory promotion scope mismatch");
    if (priorById?.error_signature && input.error_signature && priorById.error_signature !== input.error_signature) {
      throw new Error("memory promotion signature mismatch");
    }
    const signature = input.error_signature || priorById?.error_signature || null;
    if (!priorById && !signature) required(input.title, "title");
    const matches = signature ? this.store.findMatchingItems({ ...identity, error_signature: signature }) : [];
    const prior = priorById || matches.find((item) => item.status === "candidate" && ["lesson", "do_not_retry"].includes(item.kind))
      || this.store.findMatchingItems({ ...identity, title: input.title, error_signature: signature, kind: input.do_not_retry ? "do_not_retry" : "lesson" })[0];
    const episode = { ...prior, ...identity };
    for (const key of ["title", "trigger", "failed_approach", "root_cause", "verified_fix", "do_not_retry"]) {
      if (input[key] !== undefined) episode[key] = input[key];
    }
    required(episode.title, "title");
    episode.error_signature = signature;
    const verification = verificationOf(input.verification, input.evidence);
    const passed = verification.passed && completeLesson(episode);
    const failures = this.store.scopedFailures(signature, identity);
    // An incomplete episode after one observed failure must not bypass the threshold.
    if (!prior && signature && !passed && failures.length < 2) return null;
    // A new incomplete or failed verification never overwrites a verified lesson.
    if (prior?.status === "active" && prior.confidence === "verified" && !passed) return prior;
    return this.store.transaction(() => {
      const item = this.store.putItem({
        ...episode, summary: input.summary ?? (passed ? null : prior?.summary), kind: episode.do_not_retry ? "do_not_retry" : "lesson",
        tags: input.tags || prior?.tags || [],
        confidence: passed ? "verified" : "medium", status: passed ? "active" : "candidate",
        evidence_ref: passed ? verification.evidence_ref : null,
        expires_at: passed ? null : inDays(30), valid_to: null,
        valid_from: passed ? prior?.valid_from || new Date().toISOString() : null,
        last_verified_at: passed ? new Date().toISOString() : null,
      });
      this.store.linkFailureEvidence(item.id);
      this.#evidence(item, {
        job_id: input.job_id || input.evidence?.job_id || null,
        event_type: passed ? "verification_pass" : "episode",
        error_excerpt: episode.failed_approach,
        result_excerpt: [verification.evidence_ref, verification.result_excerpt].filter(Boolean).join("\n") || episode.verified_fix,
      });
      return item;
    });
  }

  activateVerified(id, options = {}) {
    const item = this.store.getItem(id);
    if (!item) return null;
    return this.recordVerifiedLesson({ ...options, memory_id: id });
  }

  #evidence(item, input) {
    // Idempotent completion observations preserve one durable verification receipt.
    const clean = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value == null ? null : redactSecrets(value)]));
    const id = "ev_" + createHash("sha256").update(JSON.stringify([item.id, clean])).digest("hex");
    if (this.store.db.prepare("SELECT id FROM memory_evidence WHERE id=?").get(id)) return;
    this.store.addEvidence(item.id, { ...clean, id, provider: item.provider, project: item.project, tool: item.tool });
  }
}

export function verifiedSeedDefinitions() {
  return VERIFIED_SEEDS.map((entry) => structuredClone(entry));
}
