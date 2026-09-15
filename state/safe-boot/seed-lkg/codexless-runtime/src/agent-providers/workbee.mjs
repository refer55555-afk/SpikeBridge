// MacProvider — client of the verified mac-worker-b bridge (second computer).
//
// The remote machine (Mac "Worker B") runs a LaunchAgent daemon that pulls
// tasks from this machine's bridge file queue and executes them with its local
// Codex CLI. The bridge itself is a local Node server
// (bootstrap/mac-worker-b/bridge.mjs, default :8766) with an HMAC-bearer API:
//   POST /api/submit   {taskId, task, targetCwd?, resumeSessionId?} -> 202 queued
//   GET  /api/poll/:id  -> 202 (queued/running) | 200 (completed/failed) | 404
//   GET  /api/card/:id  -> task card {state, model, sessionIds, usage, ...}
//   GET  /api/status    -> {bridge, counts, ready (worker heartbeat live), registration}
// Bearer = HMAC-SHA256(pairingSecret, "task-api-v1").
//
// The provider is only a client: bridge lifecycle and the Mac itself are
// external. Whatever is not observable through this protocol is reported as
// UNKNOWN, never guessed.

import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolveSpikeBridgeRoot, spikeMacSecretFile } from "../spike-paths.mjs";

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

function taskIdForRequest(requestId) {
  if (typeof requestId !== "string" || !requestId) return `mac_${randomUUID()}`;
  const digest = createHash("sha256").update(requestId).digest("hex").slice(0, 40);
  return `mac_req_${digest}`;
}

async function fetchJson(url, { method = "GET", headers = {}, body = null, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 500) }; }
    return { status: response.status, ok: response.ok, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

export function createMacProvider({
  bridgeBase = process.env.SPIKE_BRIDGE_MAC_BRIDGE?.trim()
    || process.env.SPIKE_BRIDGE_WORKBEE_BRIDGE?.trim()
    || "http://127.0.0.1:8766",
  secretFile = null,
  defaultCwd = process.cwd(),
  bridgeRoot = resolveSpikeBridgeRoot({ defaultCwd }),
} = {}) {
  const canonicalSecret = spikeMacSecretFile(bridgeRoot);
  secretFile = secretFile
    || process.env.SPIKE_BRIDGE_MAC_SECRET_FILE?.trim()
    || process.env.SPIKE_BRIDGE_WORKBEE_SECRET_FILE?.trim()
    || canonicalSecret;
  function bearer() {
    if (!existsSync(secretFile)) return null;
    const secret = readFileSync(secretFile, "utf8").trim();
    if (!secret) return null;
    return createHmac("sha256", secret).update("task-api-v1").digest("hex");
  }

  async function call(path, { method = "GET", body = null, timeoutMs } = {}) {
    const token = bearer();
    if (!token) {
      const error = new Error(`Mac pairing secret unavailable: ${secretFile}`);
      error.code = "MAC_SECRET_MISSING";
      throw error;
    }
    return fetchJson(`${bridgeBase.replace(/\/$/, "")}${path}`, {
      method,
      body,
      timeoutMs,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  return {
    id: "mac",
    displayName: "Mac",
    capabilities: Object.freeze({
      resume: true,      // submit-with-resumeSessionId (new task, same remote session)
      cancel: false,     // bridge exposes no per-task cancel; only worker-level stop
      approval: false,
      models: true,      // from pairing/registration metadata only
      usage: false,      // account quota unknown; per-task usage arrives in results
      quota: false,
      streaming: false,
      remote: true,
    }),

    async probe() {
      const details = { provider: "mac", bridgeBase, secretFile: existsSync(secretFile) };
      if (!details.secretFile) return { ok: false, ...details, reason: `pairing secret missing: ${secretFile}` };
      let status;
      try {
        status = await call("/api/status", { timeoutMs: 5_000 });
      } catch (error) {
        return { ok: false, ...details, reason: `bridge unreachable: ${error.message}`, hint: "start the bridge via bootstrap/mac-worker-b/start.ps1" };
      }
      if (status.status === 401) return { ok: false, ...details, reason: "bridge rejected the pairing bearer (secret mismatch)" };
      if (!status.ok || !status.body?.bridge) return { ok: false, ...details, reason: `bridge status unexpected: HTTP ${status.status}` };
      details.bridge = status.body;
      details.workerReady = status.body.ready === true;
      return { ok: true, ...details };
    },

    async start({ task, project, options } = {}) {
      if (typeof task !== "string" || !task.trim()) throw new TypeError("MacProvider.start requires a non-empty task string");
      if (options?.resumeSessionId !== undefined && options.resumeSessionId !== null && !TASK_ID_RE.test(options.resumeSessionId)) {
        throw new TypeError("MacProvider.start resumeSessionId is invalid");
      }
      const taskId = taskIdForRequest(options?.requestId);
      const payload = {
        taskId,
        task,
        ...(typeof project === "string" && project.trim() ? { targetCwd: project } : {}),
        ...(options?.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
      };
      const response = await call("/api/submit", { method: "POST", body: payload });
      if (response.status === 409) {
        if (typeof options?.requestId === "string" && options.requestId) {
          const existing = await this.status(taskId);
          return { ...existing, idempotentReplay: true };
        }
        const error = new Error(`Mac bridge reports duplicate taskId: ${taskId}`);
        error.code = "MAC_DUPLICATE_TASK";
        throw error;
      }
      if (response.status !== 202 || !response.body?.ok) {
        const error = new Error(`Mac submit failed: HTTP ${response.status} ${JSON.stringify(response.body)?.slice(0, 300)}`);
        error.code = "MAC_SUBMIT_FAILED";
        throw error;
      }
      return { ref: taskId, provider: "mac", status: "queued", queuedAtUtc: new Date().toISOString() };
    },

    async status(ref) {
      if (typeof ref !== "string" || !TASK_ID_RE.test(ref)) throw new TypeError("MacProvider.status requires a valid taskId ref");
      const polled = await call(`/api/poll/${encodeURIComponent(ref)}`);
      if (polled.status === 404) return { ref, provider: "mac", status: "lost", error: "unknown taskId on bridge" };
      const body = polled.body ?? {};
      // Bridge contract: 200 = terminal (completed/failed), 202 = queued/processing.
      // Do NOT use fetch's `ok` here — it is true for 202 as well.
      const state = typeof body.state === "string" && ["queued", "processing", "completed", "failed"].includes(body.state)
        ? body.state
        : polled.status === 200 ? "completed"
          : polled.status === 202 ? "running"
            : "unknown";
      let card = null;
      try {
        const cardResponse = await call(`/api/card/${encodeURIComponent(ref)}`);
        if (cardResponse.ok || cardResponse.status === 202) card = cardResponse.body;
      } catch {}
      return {
        ref,
        provider: "mac",
        status: state === "queued" || state === "processing" ? "running" : state,
        sessionRef: card?.sessionIds?.[card.sessionIds.length - 1] ?? body.resumeSessionId ?? null,
        response: body.lastMessage ?? card?.lastMessagePreview ?? null,
        usage: body.usage ?? card?.usage ?? null,
        model: card?.model || null,
        exitCode: body.exitCode ?? card?.exitCode ?? null,
        card,
        raw: body,
      };
    },

    async send(ref, message, options = {}) {
      if (typeof ref !== "string" || !TASK_ID_RE.test(ref)) throw new TypeError("MacProvider.send requires a valid taskId ref");
      if (typeof message !== "string" || !message.trim()) throw new TypeError("MacProvider.send requires a non-empty message string");
      const previous = await this.status(ref);
      const sessionId = previous?.card?.resumeSessionId ?? previous?.sessionRef ?? null;
      if (!sessionId) {
        const error = new Error(`Mac task has no resumable session yet (status=${previous?.status ?? "unknown"})`);
        error.code = "AGENT_PROVIDER_RESUME_UNAVAILABLE";
        throw error;
      }
      return this.start({ task: message, project: options?.project, options: { resumeSessionId: sessionId, requestId: options?.requestId } });
    },

    async cancel(ref) {
      const error = new Error("Mac bridge protocol has no per-task cancel; only worker-level stop (/api/worker/stop) exists");
      error.code = "AGENT_PROVIDER_CANCEL_UNSUPPORTED";
      return { ref, provider: "mac", status: "UNKNOWN", error: error.message, code: error.code };
    },

    async models() {
      const probe = await this.probe();
      const defaultModel = probe?.bridge?.registration?.capabilities?.includes("codex")
        ? "gpt-5.6-luna"
        : null;
      if (!defaultModel) {
        return { provider: "mac", models: [{ model: "UNKNOWN", source: "unproven" }], note: "no live worker registration to prove the served model" };
      }
      return {
        provider: "mac",
        models: [{ model: defaultModel, isDefault: true, source: "mac-worker-b-pairing-default" }],
      };
    },

    async usage() {
      return {
        provider: "mac",
        quota: "UNKNOWN",
        usage: "UNKNOWN",
        note: "remote account quota is not observable through the bridge protocol; per-task usage arrives in status() results",
      };
    },
  };
}

// Temporary source-level compatibility for old internal imports. The active
// provider identity is `mac`; new code should import createMacProvider.
export const createWorkBeeProvider = createMacProvider;
