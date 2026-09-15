// ZCodeProvider — async headless ZCode CLI lane for the generic Agent layer.
//
// Protocol migrated from the verified Spike-Connect ZCode adapter + the
// ZCode-supervisor zcodectl controller: one headless prompt per process,
//   node <zcodeCli> --cwd <workspace> --prompt <text> --mode <mode> --json
//   node <zcodeCli> ... --resume <sessionId>          (continue)
// stdout ends with one JSON object: { sessionId, response, usage, projection }.
//
// Differences from Codex lane (by nature of the CLI): a task is one OS child
// process, so start/status/send/cancel are process-backed. Account-level
// quota is not observable through this protocol and is reported as UNKNOWN —
// per-task usage returned by the CLI is real provider data and is preserved.

import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveSpikeBridgeRoot, spikeZCodeStateFile } from "../spike-paths.mjs";

const ZCODE_MODES = new Set(["plan", "build", "edit", "yolo"]);
const STDOUT_CAP_BYTES = 2_000_000;
const STDERR_CAP_BYTES = 200_000;

function extractLastJsonObject(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const trimmed = text.trim();
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === "object") return direct;
  } catch {}
  // The CLI may emit non-JSON lines first; scan lines from the end.
  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") return value;
    } catch {}
  }
  return null;
}

function looksLikeResultJson(value) {
  return Boolean(value && typeof value === "object" && (value.sessionId || value.response || value.usage || value.projection));
}

function requestFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createZCodeAgentProvider({
  cliPath = process.env.SPIKE_BRIDGE_ZCODE_CLI?.trim() || "E:\\zcode\\resources\\glm\\zcode.cjs",
  nodePath = process.env.SPIKE_BRIDGE_ZCODE_NODE?.trim() || process.execPath,
  defaultCwd = process.cwd(),
  modelLabel = process.env.SPIKE_BRIDGE_ZCODE_MODEL?.trim() || "glm-5.3-flash",
  defaultMode = process.env.SPIKE_BRIDGE_ZCODE_MODE?.trim() || "yolo",
  defaultTimeoutMs = 1_800_000,
  bridgeRoot = resolveSpikeBridgeRoot({ defaultCwd }),
  stateFile = process.env.SPIKE_BRIDGE_ZCODE_STATE_FILE?.trim()
    || spikeZCodeStateFile(bridgeRoot),
  legacyStateFile = path.join(path.resolve(bridgeRoot), "state", "agent-providers", "zcode-jobs.json"),
} = {}) {
  const jobs = new Map();
  const recentUsage = [];
  const PERSISTED_LIMIT = 200;

  // Durable task state: terminal job summaries survive provider restarts;
  // persisted "running" entries recover as "lost" (the child process died with
  // the previous provider instance and is never replayed). Same semantics as
  // the Codex Task Card persistence.
  const persistedRecords = new Map();
  for (const candidate of [...new Set([legacyStateFile, stateFile].filter(Boolean))]) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      for (const record of Array.isArray(parsed?.records) ? parsed.records : []) {
        if (record && typeof record.ref === "string") persistedRecords.set(record.ref, record);
      }
    } catch {
      // A corrupt legacy/current state file must never block the provider.
    }
  }

  function findByRequestId(requestId) {
    if (typeof requestId !== "string" || !requestId) return null;
    let found = null;
    for (const record of persistedRecords.values()) {
      if (record?.requestId !== requestId) continue;
      if (!found || (record.startedAt ?? 0) > (found.startedAt ?? 0)) found = record;
    }
    return found;
  }

  function assertRequestReplay(requestId, requestHash, action) {
    const existing = findByRequestId(requestId);
    if (!existing) return null;
    if (existing.requestHash !== requestHash || existing.requestAction !== action) {
      const error = new Error(`ZCode requestId ${requestId} was already used for different parameters.`);
      error.code = "AGENT_REQUEST_ID_CONFLICT";
      throw error;
    }
    return existing;
  }

  function persistRecord(record) {
    persistedRecords.set(record.ref, record);
    if (persistedRecords.size > PERSISTED_LIMIT) {
      const disposable = [...persistedRecords.values()]
        .filter((entry) => entry?.status !== "running")
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
      let excess = persistedRecords.size - PERSISTED_LIMIT;
      for (const entry of disposable) {
        if (excess <= 0) break;
        persistedRecords.delete(entry.ref);
        excess -= 1;
      }
    }
    try {
      mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.tmp-${randomUUID()}`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, records: [...persistedRecords.values()] }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, stateFile);
    } catch {
      // Best-effort persistence; live behavior is unaffected.
    }
  }

  function summarizeJob(job) {
    const result = job.result;
    return {
      ref: job.ref,
      provider: "zcode",
      status: job.state,
      sessionRef: result?.sessionId ?? job.sessionId ?? null,
      parentRef: job.parentRef ?? null,
      requestId: job.requestId ?? null,
      requestHash: job.requestHash ?? null,
      requestAction: job.requestAction ?? null,
      exitCode: job.exitCode,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt ?? null,
      durationMs: job.finishedAt ? job.finishedAt - job.startedAt : null,
      mode: job.mode,
      workspace: job.workspace,
      model: modelLabel,
      response: result?.response ?? null,
      usage: result?.usage ?? null,
      projection: result?.projection ?? null,
      ...(job.error ? { error: job.error } : {}),
      ...(job.detail ? { detail: job.detail } : {}),
    };
  }

  function launch({ prompt, workspace, mode, resumeSessionId = null, parentRef = null, requestId = null, requestHash = null, requestAction = null }) {
    const ref = `zcode_${randomUUID()}`;
    const cliArgs = ["--cwd", workspace, "--prompt", prompt, "--mode", mode, "--json"];
    if (resumeSessionId) cliArgs.push("--resume", resumeSessionId);
    const child = spawn(nodePath, [cliPath, ...cliArgs], {
      cwd: workspace,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const job = {
      ref,
      parentRef,
      requestId,
      requestHash,
      requestAction,
      child,
      state: "running",
      mode,
      workspace,
      sessionId: resumeSessionId,
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      result: null,
      error: null,
      detail: null,
      timer: null,
    };
    jobs.set(ref, job);
    persistRecord(summarizeJob(job));

    child.stdout.on("data", (chunk) => {
      job.stdoutBytes += chunk.length;
      if (job.stdoutBytes <= STDOUT_CAP_BYTES) job.stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      job.stderrBytes += chunk.length;
      if (job.stderrBytes <= STDERR_CAP_BYTES) job.stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (job.state === "running") {
        job.state = "failed";
        job.error = error.message;
        job.finishedAt = Date.now();
        persistRecord(summarizeJob(job));
      }
    });
    child.once("close", (code) => {
      if (job.timer) clearTimeout(job.timer);
      job.exitCode = code;
      job.finishedAt = Date.now();
      if (job.state !== "running") return; // already terminal via cancel/timeout
      const parsed = extractLastJsonObject(job.stdout);
      if (looksLikeResultJson(parsed)) {
        job.result = parsed;
        job.state = code === 0 ? "completed" : "unknown";
        if (code !== 0) job.detail = "ZCode prompt exited non-zero after dispatch; preserved output requires verification before retry";
        if (parsed.sessionId) job.sessionId = parsed.sessionId;
        if (parsed.usage) {
          recentUsage.push({ ref: job.ref, at: job.finishedAt, usage: parsed.usage, sessionRef: job.sessionId });
          if (recentUsage.length > 20) recentUsage.shift();
        }
      } else if (code === 0) {
        job.state = "unknown";
        job.detail = "ZCode exited 0 but returned no parseable result JSON";
      } else {
        job.state = "failed";
        job.error = (job.stderr || job.stdout || "zcode cli exited non-zero").slice(0, 2000);
      }
      persistRecord(summarizeJob(job));
    });
    job.timer = setTimeout(() => {
      if (job.state !== "running") return;
      killJobTree(job);
      job.state = "unknown";
      job.detail = `zcode task timed out after ${defaultTimeoutMs}ms and was terminated; output was not authoritative`;
      job.finishedAt = Date.now();
      persistRecord(summarizeJob(job));
    }, defaultTimeoutMs);
    child.unref?.();
    return summarizeJob(job);
  }

  function killJobTree(job) {
    const pid = job.child?.pid;
    if (!pid) return false;
    if (process.platform === "win32") {
      // Detached kills are unreliable on Windows; kill the whole tree.
      const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      return result.status === 0;
    }
    try {
      job.child.kill("SIGTERM");
      return true;
    } catch {
      return false;
    }
  }

  return {
    id: "zcode",
    displayName: "ZCode",
    capabilities: Object.freeze({
      resume: true,      // --resume <sessionId> continues a session
      cancel: true,      // process-tree kill
      approval: false,   // no server-side approval concept; mode is chosen at start
      models: true,      // single CLI-configured model lane
      usage: false,      // account-level usage is not observable; per-task usage is real
      quota: false,
      streaming: false,
      remote: false,
    }),

    async probe() {
      const details = { provider: "zcode", cliPath, nodePath };
      if (!existsSync(cliPath)) return { ok: false, ...details, reason: `zcode cli not found: ${cliPath}` };
      const version = spawnSync(nodePath, [cliPath, "--version"], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
      if (version.status !== 0) {
        return { ok: false, ...details, reason: `zcode --version failed: ${(version.stderr || version.stdout || "").slice(0, 300)}` };
      }
      details.cliVersion = String(version.stdout || "").trim().split(/\r?\n/)[0] ?? null;
      return { ok: true, ...details, modelLabel };
    },

    async start({ task, project, options } = {}) {
      if (typeof task !== "string" || !task.trim()) throw new TypeError("ZCodeProvider.start requires a non-empty task string");
      const workspace = typeof project === "string" && project.trim() ? project : defaultCwd;
      const mode = ZCODE_MODES.has(options?.mode) ? options.mode : ZCODE_MODES.has(defaultMode) ? defaultMode : "yolo";
      const requestId = typeof options?.requestId === "string" && options.requestId ? options.requestId : null;
      const requestHash = requestId ? requestFingerprint({ action: "start", task, project: project ?? null, mode: options?.mode ?? null }) : null;
      const existing = requestId ? assertRequestReplay(requestId, requestHash, "start") : null;
      if (existing) {
        const live = jobs.get(existing.ref);
        return live ? summarizeJob(live) : this.status(existing.ref);
      }
      return launch({ prompt: task, workspace, mode, requestId, requestHash, requestAction: requestId ? "start" : null });
    },

    async status(ref) {
      const job = jobs.get(ref);
      if (job) return summarizeJob(job);
      const persisted = persistedRecords.get(ref);
      if (persisted) {
        // Durable recovery: terminal records replay as-is; a persisted
        // "running" job died with the previous provider instance -> "lost".
        if (persisted.status === "running") {
          return { ...persisted, status: "lost", error: "provider restarted while this task was running; the child process is gone and the task is not replayed", recovered: true };
        }
        return { ...persisted, recovered: true };
      }
      return { ref, provider: "zcode", status: "lost", error: "unknown zcode task reference (provider restarted or invalid ref)" };
    },

    async send(ref, message, options = {}) {
      if (typeof ref !== "string" || !ref.trim()) throw new TypeError("ZCodeProvider.send requires a ref string");
      if (typeof message !== "string" || !message.trim()) throw new TypeError("ZCodeProvider.send requires a non-empty message string");
      const requestId = typeof options?.requestId === "string" && options.requestId ? options.requestId : null;
      const requestHash = requestId ? requestFingerprint({ action: "send", ref, message, mode: options?.mode ?? null, project: options?.project ?? null }) : null;
      const existing = requestId ? assertRequestReplay(requestId, requestHash, "send") : null;
      if (existing) {
        const live = jobs.get(existing.ref);
        return live ? summarizeJob(live) : this.status(existing.ref);
      }
      let job = jobs.get(ref);
      let priorSessionId = null;
      let priorMode = defaultMode;
      let priorWorkspace = defaultCwd;
      let priorState = null;
      if (job) {
        priorSessionId = job.sessionId ?? job.result?.sessionId ?? null;
        priorMode = job.mode;
        priorWorkspace = job.workspace;
        priorState = job.state;
      } else {
        const persisted = persistedRecords.get(ref);
        if (!persisted) {
          const error = new Error(`unknown zcode task reference: ${ref}`);
          error.code = "AGENT_PROVIDER_REF_UNKNOWN";
          throw error;
        }
        priorSessionId = persisted.sessionRef ?? null;
        priorMode = persisted.mode;
        priorWorkspace = persisted.workspace;
        priorState = persisted.status;
      }
      if (priorState === "running") {
        const error = new Error(`zcode task is still running: ${ref}; cancel it or wait for a terminal state before continuing`);
        error.code = "AGENT_PROVIDER_BUSY";
        throw error;
      }
      if (!priorSessionId) {
        const error = new Error(`zcode task has no session to resume (status=${priorState})`);
        error.code = "AGENT_PROVIDER_RESUME_UNAVAILABLE";
        throw error;
      }
      const mode = ZCODE_MODES.has(options?.mode) ? options.mode : ZCODE_MODES.has(priorMode) ? priorMode : "yolo";
      const workspace = typeof options?.project === "string" && options.project.trim() ? options.project : priorWorkspace;
      return launch({ prompt: message, workspace, mode, resumeSessionId: priorSessionId, parentRef: ref, requestId, requestHash, requestAction: requestId ? "send" : null });
    },

    async cancel(ref) {
      const job = jobs.get(ref);
      if (!job) {
        const persisted = persistedRecords.get(ref);
        if (persisted) {
          return { ...persisted, status: persisted.status === "running" ? "lost" : persisted.status, error: "task is not live in this provider instance; nothing to cancel", recovered: true };
        }
        return { ref, provider: "zcode", status: "lost", error: "unknown zcode task reference" };
      }
      if (job.state !== "running") return summarizeJob(job);
      const killed = killJobTree(job);
      if (!killed) {
        job.detail = "cancel requested; process kill could not be confirmed and the task remains under supervision";
        persistRecord(summarizeJob(job));
        return summarizeJob(job);
      }
      job.state = "interrupted";
      job.finishedAt = Date.now();
      job.detail = "cancelled via process-tree kill";
      // Partial output may still contain a parseable result; mark honest state.
      const parsed = extractLastJsonObject(job.stdout);
      if (looksLikeResultJson(parsed)) job.result = parsed;
      persistRecord(summarizeJob(job));
      return summarizeJob(job);
    },

    async models() {
      // The ZCode CLI lane uses whatever model the local login/config pins;
      // the bridge labels it with the configured expectation, not a probe.
      return {
        provider: "zcode",
        models: [{ model: modelLabel, isDefault: true, source: "cli-configured-pin" }],
        note: "model selection follows the local ZCode CLI configuration; per-task usage reports the served model's real token counts",
      };
    },

    async usage() {
      return {
        provider: "zcode",
        quota: "UNKNOWN",
        usage: "UNKNOWN",
        recentTaskUsage: recentUsage.slice(-10),
        note: "account-level quota is not observable through the zcode CLI protocol; per-task usage in task results is real provider data",
      };
    },

    listJobs() {
      return [...jobs.values()].map(summarizeJob);
    },
  };
}
