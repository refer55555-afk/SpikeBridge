import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const SAFE_BOOT_SCHEMA_VERSION = 1;
export const SAFE_BOOT_CANDIDATE_ID = "7691";
export const CIRCUIT_CLOSED = "closed";
export const CIRCUIT_OPEN = "open";
export const CIRCUIT_HALF_OPEN = "half_open";

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;
const STATE_FILENAME = "safe-boot-state.json";
const SESSION_DIRNAME = "boot-sessions";

/**
 * Small file-backed state store for the Safe Boot spike.
 *
 * State writes are replace-atomic. Session events are append-only JSONL, so a
 * failed boot remains diagnosable even when the process exits mid-activation.
 */
export class SafeBootStore {
  constructor({ rootDir, now = () => Date.now() } = {}) {
    if (typeof rootDir !== "string" || !rootDir.trim()) {
      throw new TypeError("SafeBootStore requires a rootDir");
    }
    this.rootDir = path.resolve(rootDir);
    this.statePath = path.join(this.rootDir, STATE_FILENAME);
    this.sessionsDir = path.join(this.rootDir, SESSION_DIRNAME);
    this.now = now;
  }

  async readState() {
    let raw;
    try {
      raw = await readFile(this.statePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return defaultState();
      throw error;
    }
    return validateState(JSON.parse(raw));
  }

  async writeState(state) {
    const valid = validateState(state);
    await mkdir(this.rootDir, { recursive: true });
    const tempPath = path.join(this.rootDir, `.${STATE_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, `${JSON.stringify(valid, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.statePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
    return valid;
  }

  async appendEvent(sessionId, type, data = {}) {
    assertSessionId(sessionId);
    if (typeof type !== "string" || !type.trim()) throw new TypeError("boot event type is required");
    await mkdir(this.sessionsDir, { recursive: true });
    const event = {
      at: new Date(Number(this.now())).toISOString(),
      sessionId,
      type: type.trim(),
      ...sanitizeValue(data),
    };
    const sessionPath = this.sessionPath(sessionId);
    await appendFile(sessionPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    return event;
  }

  sessionPath(sessionId) {
    assertSessionId(sessionId);
    return path.join(this.sessionsDir, `boot-${sessionId}.jsonl`);
  }
}

/**
 * Run independent dependency probes before candidate activation.
 *
 * A probe may return true/false or a structured result with status "pass" /
 * "fail". Probe exceptions are converted to failed checks and never escape
 * as unstructured boot errors.
 */
export async function runDependencyPreflight({ candidate, dependencies = {}, context = {} } = {}) {
  const entries = Array.isArray(dependencies)
    ? dependencies.map((entry, index) => [entry?.name ?? `dependency-${index + 1}`, entry?.check ?? entry])
    : Object.entries(dependencies);

  const checks = [];
  for (const [name, probe] of entries) {
    if (typeof probe !== "function") {
      checks.push({ name: String(name), status: "fail", reason: "probe_not_callable" });
      continue;
    }
    try {
      const result = await probe({ candidate, context });
      checks.push(normalizeCheck(name, result));
    } catch (error) {
      checks.push({
        name: String(name),
        status: "fail",
        reason: "probe_threw",
        error: safeError(error),
      });
    }
  }

  const passed = checks.every((check) => check.status === "pass");
  return {
    status: passed ? "ready" : "not_ready",
    checks,
    passed,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Safe Boot controller.
 *
 * Adapter contract:
 * - dependencyPreflight({ candidate, sessionId, context }) -> preflight result
 * - activate({ candidate, sessionId, context }) -> runtime handle
 * - readiness({ candidate, handle, sessionId, context }) -> ready/not_ready
 * - deactivate({ candidate, handle, reason, sessionId, context }) -> void
 * - rollback({ from, to, reason, sessionId, context }) -> { restored?: boolean }
 *
 * Feature state is deliberately an input/output field separate from the
 * readiness result. A disabled feature can have a ready runtime, and an
 * enabled feature can be not ready; neither value is rewritten by the other.
 */
export class SafeBootController {
  constructor({
    store,
    candidateId = SAFE_BOOT_CANDIDATE_ID,
    failureThreshold = DEFAULT_FAILURE_THRESHOLD,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    dependencyPreflight = ({ candidate, context }) => runDependencyPreflight({ candidate, context }),
    activate,
    readiness,
    deactivate = async () => {},
    rollback = async () => ({ restored: true }),
    now = () => Date.now(),
  } = {}) {
    if (!(store instanceof SafeBootStore)) throw new TypeError("SafeBootController requires a SafeBootStore");
    if (typeof activate !== "function") throw new TypeError("SafeBootController requires an activate adapter");
    if (typeof readiness !== "function") throw new TypeError("SafeBootController requires a readiness adapter");
    if (typeof dependencyPreflight !== "function") throw new TypeError("dependencyPreflight must be a function");
    if (typeof deactivate !== "function" || typeof rollback !== "function") throw new TypeError("deactivate and rollback must be functions");
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) throw new RangeError("failureThreshold must be a positive integer");
    if (!Number.isFinite(cooldownMs) || cooldownMs < 0) throw new RangeError("cooldownMs must be non-negative");

    this.store = store;
    this.candidateId = requireCandidateId(candidateId);
    if (this.candidateId !== SAFE_BOOT_CANDIDATE_ID) throw new Error(`Safe Boot V1 is fixed to candidate ${SAFE_BOOT_CANDIDATE_ID}`);
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.dependencyPreflight = dependencyPreflight;
    this.activate = activate;
    this.readiness = readiness;
    this.deactivate = deactivate;
    this.rollback = rollback;
    this.now = now;
  }

  async boot({ candidate, featureEnabled = true, context = {} } = {}) {
    assertCandidate(candidate, this.candidateId);
    const sessionId = randomUUID();
    let state = await this.store.readState();
    const feature = { enabled: Boolean(featureEnabled) };
    const now = Number(this.now());

    await this.store.appendEvent(sessionId, "session_started", {
      candidate: candidateSnapshot(candidate),
      feature,
    });
    await this.store.appendEvent(sessionId, "feature_state", feature);

    if (state.pending) {
      await this.store.appendEvent(sessionId, "interrupted_boot_detected", { pending: state.pending });
      state = await this.recoverPending({ state, sessionId, context });
    }

    const gate = circuitGate(state.circuitBreaker, now);
    if (!gate.allowed) {
      await this.store.appendEvent(sessionId, "circuit_breaker_blocked", {
        candidateId: this.candidateId,
        nextRetryAt: state.circuitBreaker.nextRetryAt,
      });
      const fallback = await this.bootLastKnownGood({ state, sessionId, feature, context, reason: "circuit_breaker_open" });
      return this.finish({
        ok: fallback.ok,
        sessionId,
        candidateId: this.candidateId,
        booted: fallback.booted,
        usedRollback: false,
        feature,
        readiness: fallback.readiness,
        preflight: null,
        circuitBreaker: fallback.state.circuitBreaker,
        reason: fallback.ok ? "circuit_breaker_open_using_last_known_good" : "circuit_breaker_open_no_usable_last_known_good",
        error: fallback.error,
      });
    }
    if (gate.stateChanged) {
      state = await this.store.writeState({ ...state, circuitBreaker: gate.breaker, updatedAt: nowIso(now) });
      await this.store.appendEvent(sessionId, "circuit_breaker_half_open", { candidateId: this.candidateId });
    }

    const preflight = await this.runPreflight(candidate, sessionId, context);
    await this.store.appendEvent(sessionId, "dependency_preflight", preflight);
    if (!isReady(preflight)) {
      state = await this.recordFailure(state, sessionId, "dependency_preflight", preflight.error ?? "dependency_preflight_not_ready");
      const fallback = await this.bootLastKnownGood({ state, sessionId, feature, context, reason: "candidate_preflight_failed" });
      return this.finish({
        ok: fallback.ok,
        sessionId,
        candidateId: this.candidateId,
        booted: fallback.booted,
        usedRollback: false,
        feature,
        readiness: fallback.readiness,
        preflight,
        circuitBreaker: fallback.state.circuitBreaker,
        reason: fallback.ok ? "candidate_preflight_failed_using_last_known_good" : "candidate_preflight_failed",
        error: fallback.error ?? preflight.error ?? "candidate dependency preflight failed",
      });
    }

    const previousLkg = state.lastKnownGood;
    state = await this.store.writeState({
      ...state,
      pending: {
        sessionId,
        candidate: candidateSnapshot(candidate),
        previousLastKnownGood: previousLkg,
        startedAt: nowIso(now),
      },
      updatedAt: nowIso(now),
    });
    await this.store.appendEvent(sessionId, "activation_started", { candidate: candidateSnapshot(candidate) });

    let handle;
    try {
      handle = await this.activate({ candidate, sessionId, context });
      await this.store.appendEvent(sessionId, "candidate_activated", { candidate: candidateSnapshot(candidate) });
    } catch (error) {
      const failure = safeError(error);
      await this.store.appendEvent(sessionId, "activation_failed", { error: failure });
      await this.safeDeactivate({ candidate, handle, sessionId, context, reason: "activation_failed" });
      state = await this.recordFailure(state, sessionId, "activation", failure);
      const recovered = await this.restoreLastKnownGood({ state, candidate, sessionId, context, feature, reason: "activation_failed" });
      return this.finish({
        ok: recovered.ok,
        sessionId,
        candidateId: this.candidateId,
        booted: recovered.booted,
        usedRollback: recovered.rollbackPerformed,
        feature,
        readiness: { status: "not_ready", reason: "activation_failed" },
        preflight,
        circuitBreaker: recovered.state.circuitBreaker,
        reason: recovered.reason,
        error: recovered.error ?? failure,
      });
    }

    let readiness;
    try {
      readiness = await this.readiness({ candidate, handle, sessionId, context });
      readiness = normalizeReadiness(readiness);
    } catch (error) {
      readiness = { status: "not_ready", reason: "readiness_probe_threw", error: safeError(error) };
    }
    await this.store.appendEvent(sessionId, "readiness_result", readiness);

    if (!isReady(readiness)) {
      await this.safeDeactivate({ candidate, handle, sessionId, context, reason: "readiness_failed" });
      state = await this.recordFailure(state, sessionId, "readiness", readiness.error ?? readiness.reason);
      const recovered = await this.restoreLastKnownGood({ state, candidate, sessionId, context, feature, reason: "readiness_failed" });
      return this.finish({
        ok: recovered.ok,
        sessionId,
        candidateId: this.candidateId,
        booted: recovered.booted,
        usedRollback: recovered.rollbackPerformed,
        feature,
        readiness,
        preflight,
        circuitBreaker: recovered.state.circuitBreaker,
        reason: recovered.reason,
        error: recovered.error ?? readiness.error ?? "candidate readiness failed",
      });
    }

    state = await this.store.writeState({
      ...state,
      lastKnownGood: candidateSnapshot(candidate),
      pending: null,
      circuitBreaker: closedBreaker(),
      updatedAt: nowIso(Number(this.now())),
    });
    await this.store.appendEvent(sessionId, "last_known_good_promoted", { candidate: candidateSnapshot(candidate) });
    await this.store.appendEvent(sessionId, "session_succeeded", { booted: "candidate", readiness, feature });
    return this.finish({
      ok: true,
      sessionId,
      candidateId: this.candidateId,
      booted: "candidate",
      usedRollback: false,
      feature,
      readiness,
      preflight,
      circuitBreaker: state.circuitBreaker,
      reason: "candidate_ready",
    });
  }

  async runPreflight(candidate, sessionId, context) {
    try {
      const result = await this.dependencyPreflight({ candidate, sessionId, context });
      return normalizePreflight(result);
    } catch (error) {
      return { status: "not_ready", passed: false, checks: [], reason: "preflight_threw", error: safeError(error) };
    }
  }

  async recordFailure(state, sessionId, stage, error) {
    const current = state.circuitBreaker;
    const consecutiveFailures = current.consecutiveFailures + 1;
    const opened = consecutiveFailures >= this.failureThreshold;
    const breaker = {
      state: opened ? CIRCUIT_OPEN : CIRCUIT_CLOSED,
      consecutiveFailures,
      lastFailureAt: nowIso(Number(this.now())),
      lastFailureStage: stage,
      openedAt: opened ? (current.openedAt ?? nowIso(Number(this.now()))) : null,
      nextRetryAt: opened ? new Date(Number(this.now()) + this.cooldownMs).toISOString() : null,
    };
    await this.store.appendEvent(sessionId, "circuit_breaker_failure", { stage, error, breaker });
    return this.store.writeState({ ...state, circuitBreaker: breaker, updatedAt: nowIso(Number(this.now())) });
  }

  async restoreLastKnownGood({ state, candidate, sessionId, context, feature, reason }) {
    const target = state.lastKnownGood;
    if (!target) {
      const cleared = await this.store.writeState({ ...state, pending: null, updatedAt: nowIso(Number(this.now())) });
      await this.store.appendEvent(sessionId, "rollback_skipped", { reason: "no_last_known_good", failedCandidate: candidateSnapshot(candidate) });
      await this.store.appendEvent(sessionId, "session_failed", { reason, error: "no_last_known_good" });
      return { ok: false, booted: null, rollbackPerformed: false, state: cleared, reason, error: "no_last_known_good" };
    }

    let rollbackResult;
    try {
      rollbackResult = await this.rollback({
        from: candidate,
        to: target,
        reason,
        sessionId,
        context,
      });
      if (rollbackResult?.restored === false) throw new Error("rollback_adapter_reported_not_restored");
      await this.store.appendEvent(sessionId, "rollback_succeeded", { from: candidateSnapshot(candidate), to: target, reason });
    } catch (error) {
      const failure = safeError(error);
      await this.store.appendEvent(sessionId, "rollback_failed", { from: candidateSnapshot(candidate), to: target, reason, error: failure });
      const failed = await this.store.writeState({ ...state, pending: null, updatedAt: nowIso(Number(this.now())) });
      await this.store.appendEvent(sessionId, "session_failed", { reason: "rollback_failed", error: failure });
      return { ok: false, booted: null, rollbackPerformed: false, state: failed, reason: "rollback_failed", error: failure };
    }

    const fallback = await this.bootLastKnownGood({ state: { ...state, pending: null }, sessionId, feature, context, reason });
    return {
      ok: fallback.ok,
      booted: fallback.booted,
      rollbackPerformed: true,
      state: fallback.state,
      reason: fallback.ok ? "rolled_back_to_last_known_good" : "rollback_target_not_ready",
      error: fallback.error,
    };
  }

  async bootLastKnownGood({ state, sessionId, feature, context, reason }) {
    const target = state.lastKnownGood;
    if (!target) {
      await this.store.writeState({ ...state, pending: null, updatedAt: nowIso(Number(this.now())) });
      await this.store.appendEvent(sessionId, "last_known_good_unavailable", { reason });
      return { ok: false, booted: null, readiness: { status: "not_ready", reason: "no_last_known_good" }, state, error: "no_last_known_good" };
    }

    let handle;
    try {
      handle = await this.activate({ candidate: target, sessionId, context, lastKnownGood: true });
      const readiness = normalizeReadiness(await this.readiness({ candidate: target, handle, sessionId, context, lastKnownGood: true }));
      await this.store.appendEvent(sessionId, "last_known_good_readiness", { candidate: target, readiness, reason });
      if (!isReady(readiness)) {
        await this.safeDeactivate({ candidate: target, handle, sessionId, context, reason: "last_known_good_not_ready" });
        await this.store.appendEvent(sessionId, "session_failed", { reason: "last_known_good_not_ready", readiness });
        const failed = await this.store.writeState({ ...state, pending: null, updatedAt: nowIso(Number(this.now())) });
        return { ok: false, booted: null, readiness, state: failed, error: readiness.error ?? readiness.reason };
      }
      const persisted = await this.store.writeState({ ...state, pending: null, updatedAt: nowIso(Number(this.now())) });
      await this.store.appendEvent(sessionId, "session_succeeded", { booted: "last-known-good", readiness, feature, reason });
      return { ok: true, booted: "last-known-good", readiness, state: persisted };
    } catch (error) {
      const failure = safeError(error);
      await this.safeDeactivate({ candidate: target, handle, sessionId, context, reason: "last_known_good_boot_failed" });
      await this.store.appendEvent(sessionId, "last_known_good_boot_failed", { candidate: target, error: failure, reason });
      const failed = await this.store.writeState({ ...state, pending: null, updatedAt: nowIso(Number(this.now())) });
      await this.store.appendEvent(sessionId, "session_failed", { reason: "last_known_good_boot_failed", error: failure });
      return { ok: false, booted: null, readiness: { status: "not_ready", reason: "last_known_good_boot_failed", error: failure }, state: failed, error: failure };
    }
  }

  async recoverPending({ state, sessionId, context }) {
    const pending = state.pending;
    if (!pending) return state;
    if (!pending.previousLastKnownGood) {
      const cleared = await this.store.writeState({ ...state, pending: null, updatedAt: nowIso(Number(this.now())) });
      await this.store.appendEvent(sessionId, "interrupted_boot_cleared", { reason: "no_previous_last_known_good" });
      return cleared;
    }
    try {
      const result = await this.rollback({
        from: pending.candidate,
        to: pending.previousLastKnownGood,
        reason: "interrupted_boot_recovery",
        sessionId,
        context,
      });
      if (result?.restored === false) throw new Error("rollback_adapter_reported_not_restored");
      await this.store.appendEvent(sessionId, "interrupted_boot_rolled_back", {
        from: pending.candidate,
        to: pending.previousLastKnownGood,
      });
      return this.store.writeState({ ...state, pending: null, updatedAt: nowIso(Number(this.now())) });
    } catch (error) {
      await this.store.appendEvent(sessionId, "interrupted_boot_rollback_failed", { error: safeError(error) });
      return state;
    }
  }

  async safeDeactivate({ candidate, handle, sessionId, context, reason }) {
    try {
      await this.deactivate({ candidate, handle, sessionId, context, reason });
      await this.store.appendEvent(sessionId, "candidate_deactivated", { candidate: candidateSnapshot(candidate), reason });
    } catch (error) {
      await this.store.appendEvent(sessionId, "deactivation_failed", { candidate: candidateSnapshot(candidate), reason, error: safeError(error) });
    }
  }

  finish(result) {
    return {
      ...result,
      feature: result.feature ?? { enabled: false },
      readiness: result.readiness ?? { status: "not_ready", reason: "not_evaluated" },
      circuitBreaker: validateBreaker(result.circuitBreaker),
    };
  }
}

export function defaultState() {
  return {
    schemaVersion: SAFE_BOOT_SCHEMA_VERSION,
    lastKnownGood: null,
    pending: null,
    circuitBreaker: closedBreaker(),
    updatedAt: null,
  };
}

export function validateState(state) {
  if (!state || typeof state !== "object" || state.schemaVersion !== SAFE_BOOT_SCHEMA_VERSION) {
    throw new Error(`safe boot state schemaVersion must be ${SAFE_BOOT_SCHEMA_VERSION}`);
  }
  if (state.lastKnownGood !== null) validateCandidateSnapshot(state.lastKnownGood, "lastKnownGood");
  if (state.pending !== null) {
    if (!state.pending || typeof state.pending !== "object") throw new Error("safe boot pending must be an object or null");
    assertSessionId(state.pending.sessionId);
    validateCandidateSnapshot(state.pending.candidate, "pending.candidate");
    if (state.pending.previousLastKnownGood !== null) validateCandidateSnapshot(state.pending.previousLastKnownGood, "pending.previousLastKnownGood");
  }
  return {
    schemaVersion: SAFE_BOOT_SCHEMA_VERSION,
    lastKnownGood: state.lastKnownGood ? structuredClone(state.lastKnownGood) : null,
    pending: state.pending ? structuredClone(state.pending) : null,
    circuitBreaker: validateBreaker(state.circuitBreaker),
    updatedAt: state.updatedAt === null ? null : requireIso(state.updatedAt, "updatedAt"),
  };
}

function closedBreaker() {
  return {
    state: CIRCUIT_CLOSED,
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastFailureStage: null,
    openedAt: null,
    nextRetryAt: null,
  };
}

function validateBreaker(breaker) {
  if (!breaker || typeof breaker !== "object") throw new Error("safe boot circuit breaker must be an object");
  if (![CIRCUIT_CLOSED, CIRCUIT_OPEN, CIRCUIT_HALF_OPEN].includes(breaker.state)) throw new Error("safe boot circuit breaker state is invalid");
  if (!Number.isInteger(breaker.consecutiveFailures) || breaker.consecutiveFailures < 0) throw new Error("safe boot circuit breaker failure count is invalid");
  for (const key of ["lastFailureAt", "openedAt", "nextRetryAt"]) {
    if (breaker[key] !== null && typeof breaker[key] !== "string") throw new Error(`safe boot circuit breaker ${key} must be string or null`);
  }
  for (const key of ["lastFailureAt", "openedAt", "nextRetryAt"]) {
    if (breaker[key] !== null) requireIso(breaker[key], `circuit breaker ${key}`);
  }
  if (breaker.lastFailureStage !== null && typeof breaker.lastFailureStage !== "string") throw new Error("safe boot circuit breaker lastFailureStage must be string or null");
  return {
    state: breaker.state,
    consecutiveFailures: breaker.consecutiveFailures,
    lastFailureAt: breaker.lastFailureAt,
    lastFailureStage: breaker.lastFailureStage,
    openedAt: breaker.openedAt,
    nextRetryAt: breaker.nextRetryAt,
  };
}

function circuitGate(breaker, now) {
  if (breaker.state === CIRCUIT_OPEN) {
    const retryAt = Date.parse(breaker.nextRetryAt ?? "");
    if (!Number.isFinite(retryAt) || retryAt > now) return { allowed: false, stateChanged: false, breaker };
    return {
      allowed: true,
      stateChanged: true,
      breaker: { ...breaker, state: CIRCUIT_HALF_OPEN },
    };
  }
  return { allowed: true, stateChanged: false, breaker };
}

function normalizeCheck(name, result) {
  if (result === true) return { name: String(name), status: "pass" };
  if (result === false || result === null || result === undefined) return { name: String(name), status: "fail", reason: "probe_returned_false" };
  if (typeof result !== "object") return { name: String(name), status: "fail", reason: "probe_returned_invalid_result" };
  const status = result.status === "pass" || result.ok === true ? "pass" : "fail";
  const sanitized = sanitizeValue(result);
  if (typeof sanitized.error === "string") sanitized.error = safeError(sanitized.error);
  return { name: String(name), ...sanitized, status };
}

function normalizePreflight(result) {
  if (result === true) return { status: "ready", passed: true, checks: [] };
  if (result === false || result === null || result === undefined) return { status: "not_ready", passed: false, checks: [], reason: "preflight_returned_false" };
  if (typeof result !== "object") return { status: "not_ready", passed: false, checks: [], reason: "preflight_returned_invalid_result" };
  const passed = result.passed === true || result.ok === true || result.status === "ready" || result.status === "pass";
  const sanitized = sanitizeValue(result);
  if (typeof sanitized.error === "string") sanitized.error = safeError(sanitized.error);
  return { ...sanitized, status: passed ? "ready" : "not_ready", passed };
}

function normalizeReadiness(result) {
  if (result === true) return { status: "ready" };
  if (result === false || result === null || result === undefined) return { status: "not_ready", reason: "readiness_returned_false" };
  if (typeof result !== "object") return { status: "not_ready", reason: "readiness_returned_invalid_result" };
  const ready = result.ready === true || result.ok === true || result.status === "ready" || result.status === "pass";
  const sanitized = sanitizeValue(result);
  if (typeof sanitized.error === "string") sanitized.error = safeError(sanitized.error);
  return { ...sanitized, status: ready ? "ready" : "not_ready" };
}

function isReady(result) {
  return result?.status === "ready" || result?.status === "pass" || result?.passed === true || result?.ok === true;
}

function assertCandidate(candidate, expectedId) {
  if (!candidate || typeof candidate !== "object") throw new TypeError("candidate must be an object");
  if (requireCandidateId(candidate.id) !== expectedId) {
    throw new Error(`safe boot only accepts candidate ${expectedId}`);
  }
}

function candidateSnapshot(candidate) {
  assertCandidate(candidate, requireCandidateId(candidate.id));
  return {
    id: requireCandidateId(candidate.id),
    version: nullableString(candidate.version),
    artifactPath: nullableString(candidate.artifactPath),
    digest: nullableString(candidate.digest),
  };
}

function validateCandidateSnapshot(value, label) {
  if (!value || typeof value !== "object") throw new Error(`safe boot ${label} must be an object`);
  requireCandidateId(value.id);
  for (const key of ["version", "artifactPath", "digest"]) nullableString(value[key]);
}

function requireCandidateId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.trim())) throw new Error("candidate id must be a non-empty safe identifier");
  return value.trim();
}

function nullableString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("candidate metadata must be string or null");
  return value;
}

function assertSessionId(value) {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value)) throw new Error("boot session id is invalid");
}

function requireIso(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`safe boot ${label} must be an ISO timestamp`);
  return value;
}

function nowIso(value) {
  return new Date(Number(value)).toISOString();
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/gi, "[url-redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/([?&](?:token|code|secret|key|password)=)[^&\s]+/gi, "$1[redacted]");
}

function sanitizeValue(value) {
  if (typeof value === "string") return safeError(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/token|secret|password|cookie|authorization|credential/i.test(key)) result[key] = "[redacted]";
    else result[key] = sanitizeValue(nested);
  }
  return result;
}
