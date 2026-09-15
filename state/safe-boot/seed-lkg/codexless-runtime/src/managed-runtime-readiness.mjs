import path from "node:path";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import {
  activateDualRuntimePolicy,
  defaultCodexlessStateRoot,
  DUAL_READY_ACTIVATION,
  PENDING_MANAGED_ACTIVATION,
  readRuntimeRoutingState,
} from "./runtime-routing-policy.mjs";

export async function probeManagedRuntimeReadiness({
  runtime,
  cwd = process.cwd(),
  requestTimeoutMs = 20_000,
} = {}) {
  if (!runtime || runtime.lane !== "managed") throw new Error("Managed runtime readiness requires a resolved Managed runtime");
  const resolvedCwd = path.resolve(cwd);
  const client = new CodexAppServerClient({
    cwd: resolvedCwd,
    launch: () => ({
      command: runtime.bin,
      args: ["app-server", "--stdio"],
      options: { cwd: resolvedCwd, env: runtime.launchEnv },
    }),
    requestTimeoutMs,
    initializeCapabilities: { experimentalApi: true },
    stderrHandler: () => {},
    clientInfo: { name: "codexless_managed_readiness", title: "Codexless Managed Readiness", version: "1" },
  });

  try {
    await client.start();
    const account = await client.request("account/read", { refreshToken: false });
    const authMode = account?.account?.type ?? null;
    const planType = account?.account?.planType ?? null;
    if (!account?.account || authMode !== "chatgpt") {
      return {
        status: "not_ready",
        reason: "official_chatgpt_login_required",
        accountRead: true,
        modelList: false,
        configRead: false,
        account: { accountPresent: Boolean(account?.account), authMode, planType },
        nextAction: "Complete the official ChatGPT login with the Codexless managed-login helper, then retry readiness.",
        noFallbackPerformed: true,
      };
    }

    const [models, config] = await Promise.all([
      client.request("model/list", { limit: 1, includeHidden: false }),
      client.request("config/read", { cwd: resolvedCwd, includeLayers: false }),
    ]);
    const modelList = Array.isArray(models?.data) && models.data.length > 0;
    const configRead = Boolean(config && typeof config === "object" && "config" in config);
    if (!modelList || !configRead) {
      return {
        status: "not_ready",
        reason: !modelList ? "managed_model_list_unavailable" : "managed_config_read_unavailable",
        accountRead: true,
        modelList,
        configRead,
        account: { accountPresent: true, authMode, planType },
        nextAction: "Run the Codexless managed-login/readiness helper again. If readiness still fails, repair/reinstall Codexless; no Existing fallback is used after dual activation.",
        noFallbackPerformed: true,
      };
    }

    return {
      status: "ready",
      reason: "managed_readiness_passed",
      accountRead: true,
      modelList: true,
      configRead: true,
      account: { accountPresent: true, authMode: "chatgpt", planType },
      noModelTurnStarted: true,
      noFallbackPerformed: true,
    };
  } catch (error) {
    return {
      status: "not_ready",
      reason: "managed_readiness_probe_failed",
      accountRead: false,
      modelList: false,
      configRead: false,
      account: { accountPresent: false, authMode: null, planType: null },
      error: safeReadinessError(error),
      nextAction: "Run the Codexless managed-login/readiness helper again. If the Managed runtime is damaged, repair/reinstall Codexless.",
      noFallbackPerformed: true,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

export async function activateManagedRuntimeIfReady({
  runtime,
  cwd = process.cwd(),
  stateRoot = defaultCodexlessStateRoot(),
  probe = probeManagedRuntimeReadiness,
} = {}) {
  if (typeof probe !== "function") throw new TypeError("Managed readiness probe must be a function");
  const previousState = await readRuntimeRoutingState({ stateRoot });
  const readiness = await probe({ runtime, cwd });
  if (readiness.status !== "ready") {
    const dualRemainsActive = previousState.activation === DUAL_READY_ACTIVATION && previousState.managedReady === true;
    return {
      ok: true,
      activated: dualRemainsActive,
      activation: dualRemainsActive ? DUAL_READY_ACTIVATION : PENDING_MANAGED_ACTIVATION,
      readinessStatus: dualRemainsActive ? "degraded" : "pending",
      readiness,
      stateUnchanged: true,
      noFallbackPerformed: true,
      nextAction: dualRemainsActive
        ? "Managed dual policy remains active. Repair Managed readiness with the Codexless managed-login/readiness helper or repair/reinstall Codexless; do not route this call to Existing as fallback."
        : readiness.nextAction,
      priorState: {
        activation: previousState.activation,
        managedReady: previousState.managedReady,
        persisted: previousState.persisted,
        updatedAt: previousState.updatedAt,
      },
    };
  }
  const state = await activateDualRuntimePolicy({ stateRoot, managedRuntime: runtime, readiness });
  return {
    ok: true,
    activated: true,
    activation: state.activation,
    readiness,
    state: {
      schemaVersion: state.schemaVersion,
      activation: state.activation,
      managedReady: state.managedReady,
      managedRuntime: state.managedRuntime,
      readiness: state.readiness,
      updatedAt: state.updatedAt,
      statePath: state.statePath,
    },
  };
}

function safeReadinessError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/gi, "[official-login-url-redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]");
}
