import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { assertInternalHostMethod } from "./toolbox-method-registry.mjs";

const execFileAsync = promisify(execFile);
const CUA_CAPABILITY = "computer-use-preview";
const APPROVED_APP_META_KEY = "x-oai-cua-approved-app";
const REQUEST_BUDGET_META_KEY = "x-oai-cua-request-budget-ms";
const DEFAULT_CODEX_VERSION = "0.147.0";
const DEFAULT_SKY_VERSION = "0.6.17-202608171537-pr-1300023-7efba775c041";
const DEFAULT_HELPER_SHA256 = "db8f4486d527c91b80266faf77fdc38266b1d3960efbba35d0a6aab4caaf6aee";
const DEFAULT_REF_TTL_MS = 120_000;
const DEFAULT_APPROVAL_TTL_MS = 120_000;
const DEFAULT_OBSERVATION_TTL_MS = 120_000;
const DEFAULT_HELPER_TIMEOUT_MS = 15_000;
const DEFAULT_HELPER_OUTPUT_CAP = 2 * 1024 * 1024;
const MAX_ACCESSIBILITY_BYTES = 128 * 1024;

function normalizeHash(value) {
  return String(value ?? "").trim().toLowerCase();
}

function truncateUtf8(value, byteCap) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= byteCap) return { text, truncated: false };
  return { text: bytes.subarray(0, byteCap).toString("utf8"), truncated: true };
}

function accessibilityElementDescriptors(treeText) {
  const descriptors = new Map();
  for (const line of String(treeText ?? "").split(/\r?\n/)) {
    const match = line.match(/^\s*\[?(\d+)\]?\s+(.+?)\s*$/);
    if (!match) continue;
    descriptors.set(Number(match[1]), match[2]);
  }
  return descriptors;
}

function publicWindowTitle(window) {
  return typeof window?.title === "string" && window.title.trim() ? window.title.trim() : null;
}

function parseApprovalRequest(response) {
  const request = response?.approvalRequest;
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const app = typeof request.app === "string" ? request.app.trim() : "";
  if (!app) return null;
  const displayName = typeof request.displayName === "string" && request.displayName.trim()
    ? request.displayName.trim()
    : app;
  const riskLevel = request.riskLevel === "high" || request.riskLevel === "low"
    ? request.riskLevel
    : "low";
  return { app, displayName, riskLevel };
}

function assertNoModelTurn(client) {
  const methods = client.notificationMethods ?? [];
  if (methods.some((method) => method.startsWith("turn/") || method === "thread/tokenUsage/updated")) {
    throw new Error("Computer Use preview failed closed: model turn/token usage appeared on the host process lane");
  }
}

async function inspectInstalledRuntime({ codexBin, helperPath }) {
  const { stdout } = await execFileAsync(codexBin, ["--version"], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const match = String(stdout).match(/codex-cli\s+([^\s]+)/i);
  if (!match) throw new Error(`unable to parse Codex CLI version from: ${String(stdout).trim()}`);

  const helperRealPath = await realpath(helperPath);
  const helperInfo = await stat(helperRealPath);
  if (!helperInfo.isFile()) throw new Error(`Computer Use helper is not a file: ${helperRealPath}`);
  if (path.basename(helperRealPath).toLowerCase() !== "codex-computer-use.exe") {
    throw new Error(`unexpected Computer Use helper filename: ${helperRealPath}`);
  }

  const helperBytes = await readFile(helperRealPath);
  const helperSha256 = createHash("sha256").update(helperBytes).digest("hex");
  const skyRoot = path.resolve(path.dirname(helperRealPath), "..", "..");
  const skyPackage = JSON.parse(await readFile(path.join(skyRoot, "package.json"), "utf8"));
  const skyVersion = typeof skyPackage?.version === "string" ? skyPackage.version : null;
  if (!skyVersion) throw new Error(`unable to read @oai/sky version from ${skyRoot}`);

  return {
    codexVersion: match[1],
    helperPath: helperRealPath,
    helperSha256,
    skyVersion,
    skyRoot,
  };
}

export class CodexComputerUseExecutor {
  #codexBin;
  #helperPath;
  #defaultCwd;
  #acceptedCodexVersion;
  #acceptedSkyVersion;
  #acceptedHelperSha256;
  #helperTimeoutMs;
  #helperOutputBytesCap;
  #refTtlMs;
  #approvalTtlMs;
  #observationTtlMs;
  #runtimeInspector;
  #clientFactory;
  #runtime = null;
  #windowRefs = new Map();
  #approvalRefs = new Map();
  #actionApprovalRefs = new Map();
  #observationRefs = new Map();
  #appDisplayNames = new Map();

  constructor({
    codexBin,
    helperPath,
    defaultCwd,
    acceptedCodexVersion = DEFAULT_CODEX_VERSION,
    acceptedSkyVersion = DEFAULT_SKY_VERSION,
    acceptedHelperSha256 = DEFAULT_HELPER_SHA256,
    helperTimeoutMs = DEFAULT_HELPER_TIMEOUT_MS,
    helperOutputBytesCap = DEFAULT_HELPER_OUTPUT_CAP,
    refTtlMs = DEFAULT_REF_TTL_MS,
    approvalTtlMs = DEFAULT_APPROVAL_TTL_MS,
    observationTtlMs = DEFAULT_OBSERVATION_TTL_MS,
    runtimeInspector = inspectInstalledRuntime,
    clientFactory = null,
  }) {
    if (!codexBin) throw new Error("CodexComputerUseExecutor requires codexBin");
    if (!helperPath) throw new Error("CodexComputerUseExecutor requires helperPath");
    if (!defaultCwd) throw new Error("CodexComputerUseExecutor requires defaultCwd");
    if (!Number.isInteger(helperTimeoutMs) || helperTimeoutMs < 1_000 || helperTimeoutMs > 60_000) {
      throw new Error("helperTimeoutMs must be between 1000 and 60000");
    }
    if (!Number.isInteger(helperOutputBytesCap) || helperOutputBytesCap < 64 * 1024) {
      throw new Error("helperOutputBytesCap must be at least 65536 bytes");
    }

    this.#codexBin = codexBin;
    this.#helperPath = helperPath;
    this.#defaultCwd = path.resolve(defaultCwd);
    this.#acceptedCodexVersion = acceptedCodexVersion;
    this.#acceptedSkyVersion = acceptedSkyVersion;
    this.#acceptedHelperSha256 = normalizeHash(acceptedHelperSha256);
    this.#helperTimeoutMs = helperTimeoutMs;
    this.#helperOutputBytesCap = helperOutputBytesCap;
    this.#refTtlMs = refTtlMs;
    this.#approvalTtlMs = approvalTtlMs;
    this.#observationTtlMs = observationTtlMs;
    this.#runtimeInspector = runtimeInspector;
    this.#clientFactory = clientFactory;
  }

  get runtime() {
    return this.#runtime ? { ...this.#runtime } : null;
  }

  async validate() {
    const runtime = await this.#runtimeInspector({
      codexBin: this.#codexBin,
      helperPath: this.#helperPath,
    });
    if (runtime.codexVersion !== this.#acceptedCodexVersion) {
      throw new Error(`Computer Use preview rejected Codex ${runtime.codexVersion}; accepted=${this.#acceptedCodexVersion}`);
    }
    if (runtime.skyVersion !== this.#acceptedSkyVersion) {
      throw new Error(`Computer Use preview rejected @oai/sky ${runtime.skyVersion}; accepted=${this.#acceptedSkyVersion}`);
    }
    if (normalizeHash(runtime.helperSha256) !== this.#acceptedHelperSha256) {
      throw new Error(
        `Computer Use preview rejected helper SHA-256 ${runtime.helperSha256}; accepted=${this.#acceptedHelperSha256}`
      );
    }
    this.#runtime = {
      codexVersion: runtime.codexVersion,
      skyVersion: runtime.skyVersion,
      helperSha256: normalizeHash(runtime.helperSha256),
      helperPath: runtime.helperPath,
    };
    return this.runtime;
  }

  async listApps() {
    await this.#assertReadyAndPinned();
    this.#pruneRefs();
    const response = await this.#runHelperRequest("list_apps", {});
    if (!response.ok || !Array.isArray(response.result)) {
      throw new Error(`Computer Use list_apps failed: ${response.error ?? JSON.stringify(response)}`);
    }

    const apps = response.result.map((app) => {
      const displayName = typeof app?.displayName === "string" && app.displayName.trim()
        ? app.displayName.trim()
        : "Unknown app";
      if (typeof app?.id === "string" && app.id) this.#appDisplayNames.set(app.id, displayName);
      const windows = Array.isArray(app?.windows)
        ? app.windows.map((window) => this.#publicWindow(window, displayName))
        : [];
      return {
        displayName,
        isRunning: app?.isRunning === true,
        windows,
      };
    });

    return {
      apps,
      runtime: this.#publicRuntime(),
      authority: "official-codex-app-server-process-host-lane",
    };
  }

  async listWindows() {
    await this.#assertReadyAndPinned();
    this.#pruneRefs();
    const response = await this.#runHelperRequest("list_windows", {});
    if (!response.ok || !Array.isArray(response.result)) {
      throw new Error(`Computer Use list_windows failed: ${response.error ?? JSON.stringify(response)}`);
    }

    return {
      windows: response.result.map((window) => this.#publicWindow(
        window,
        typeof window?.app === "string" ? this.#appDisplayNames.get(window.app) ?? null : null
      )),
      runtime: this.#publicRuntime(),
      authority: "official-codex-app-server-process-host-lane",
    };
  }

  async inspectWindow({ windowRef, approvalRef = null }) {
    await this.#assertReadyAndPinned();
    this.#pruneRefs();
    const target = this.#resolveWindowRef(windowRef);
    let approvedApp = null;
    if (approvalRef !== null && approvalRef !== undefined) {
      if (typeof approvalRef !== "string" || !approvalRef.startsWith("approval_")) {
        throw new Error("approvalRef must be the opaque reference returned by the immediately preceding inspect_window approval request");
      }
      const approval = this.#approvalRefs.get(approvalRef);
      if (!approval || approval.expiresAt <= Date.now()) {
        this.#approvalRefs.delete(approvalRef);
        throw new Error("approvalRef is invalid or expired; inspect the window again to obtain a fresh approval request");
      }
      if (approval.windowRef !== windowRef || approval.operation !== "inspect") {
        throw new Error("approvalRef does not match this exact inspect_window operation");
      }
      this.#approvalRefs.delete(approvalRef);
      approvedApp = approval.app;
    }
    const response = await this.#runHelperRequest(
      "get_window_state",
      {
        window: target.window,
        include_screenshot: false,
        include_text: true,
      },
      { approvedApp }
    );

    if (!response.ok) {
      const approval = parseApprovalRequest(response);
      if (approval && !approvedApp) {
        const nextApprovalRef = `approval_${randomUUID()}`;
        this.#approvalRefs.set(nextApprovalRef, {
          app: approval.app,
          displayName: approval.displayName,
          riskLevel: approval.riskLevel,
          windowRef,
          operation: "inspect",
          expiresAt: Date.now() + this.#approvalTtlMs,
        });
        return {
          status: "approval_required",
          errorCode: "APP_APPROVAL_REQUIRED",
          approvalRef: nextApprovalRef,
          windowRef,
          app: {
            displayName: approval.displayName,
            riskLevel: approval.riskLevel,
          },
          message: `Allow Codexless Computer Use to inspect ${approval.displayName}?`,
          nextAction: "Ask the user for explicit approval, then retry computer.inspect_window with the same windowRef and this approvalRef. No separate approval tool is required.",
        };
      }
      if (approval && approvedApp) {
        throw new Error("Computer Use inspect remained approval-blocked after consuming the exact approved inspect token; obtain a fresh windowRef and approval request before retrying");
      }
      throw new Error(`Computer Use get_window_state failed: ${response.error ?? JSON.stringify(response)}`);
    }

    const state = response.result ?? {};
    const accessibility = state.accessibility && typeof state.accessibility === "object"
      ? state.accessibility
      : null;
    const tree = truncateUtf8(accessibility?.tree ?? "", MAX_ACCESSIBILITY_BYTES);
    const documentText = truncateUtf8(accessibility?.document_text ?? "", MAX_ACCESSIBILITY_BYTES);
    const selectedText = truncateUtf8(accessibility?.selected_text ?? "", 16 * 1024);
    const observationRef = `obs_${randomUUID()}`;
    this.#observationRefs.set(observationRef, {
      windowRef,
      app: target.window.app,
      helperApprovedApp: approvedApp,
      elementDescriptors: accessibilityElementDescriptors(tree.text),
      expiresAt: Date.now() + this.#observationTtlMs,
    });

    return {
      status: "ok",
      windowRef,
      observationRef,
      observationExpiresInMs: this.#observationTtlMs,
      app: {
        displayName: target.displayName ?? this.#appDisplayNames.get(target.window.app) ?? "Unknown app",
      },
      title: publicWindowTitle(state.window ?? target.window),
      accessibility: {
        tree: tree.text,
        treeTruncated: tree.truncated,
        documentText: documentText.text || null,
        documentTextTruncated: documentText.truncated,
        focusedElement: typeof accessibility?.focused_element === "string" ? accessibility.focused_element : null,
        selectedElements: Array.isArray(accessibility?.selected_elements)
          ? accessibility.selected_elements.filter((value) => typeof value === "string").slice(0, 50)
          : [],
        selectedText: selectedText.text || null,
        selectedTextTruncated: selectedText.truncated,
      },
      screenshotsReturned: Array.isArray(state.screenshots) ? state.screenshots.length : 0,
      runtime: this.#publicRuntime(),
    };
  }

  async prepareClick({ observationRef, elementIndex }) {
    await this.#assertReadyAndPinned();
    this.#pruneRefs();
    if (!Number.isInteger(elementIndex) || elementIndex < 0 || elementIndex > 100_000) {
      throw new Error("elementIndex must be an integer between 0 and 100000 from the fresh accessibility observation");
    }
    const observation = this.#resolveObservationRef(observationRef);
    const target = this.#resolveWindowRef(observation.windowRef);
    if (target.window.app !== observation.app) {
      throw new Error("observationRef no longer matches the target window; inspect the window again");
    }
    if (!observation.helperApprovedApp) {
      throw new Error("computer.prepare_click requires an observation created by an explicitly approved inspect_window retry");
    }
    const elementDescriptor = observation.elementDescriptors?.get(elementIndex) ?? null;
    if (!elementDescriptor) {
      throw new Error("elementIndex was not present in the referenced accessibility observation");
    }

    const actionApprovalRef = `action_${randomUUID()}`;
    this.#actionApprovalRefs.set(actionApprovalRef, {
      app: observation.helperApprovedApp,
      windowRef: observation.windowRef,
      observationRef,
      elementIndex,
      elementDescriptor,
      action: "single_left_click",
      expiresAt: Date.now() + this.#approvalTtlMs,
    });
    return {
      status: "approval_required",
      errorCode: "ACTION_APPROVAL_REQUIRED",
      actionApprovalRef,
      observationRef,
      elementIndex,
      elementDescriptor,
      action: "single_left_click",
      app: {
        displayName: target.displayName ?? this.#appDisplayNames.get(target.window.app) ?? "Unknown app",
        riskLevel: "high",
      },
      message: `Allow one single left click on accessibility element ${elementIndex}: ${elementDescriptor}?`,
      nextAction: "Ask the user for explicit approval of this exact prepared click. Only after approval call computer.click with this actionApprovalRef. Preparing the click performs no action.",
    };
  }

  async click({ actionApprovalRef }) {
    await this.#assertReadyAndPinned();
    this.#pruneRefs();
    if (typeof actionApprovalRef !== "string" || !actionApprovalRef.startsWith("action_")) {
      throw new Error("actionApprovalRef must be the opaque reference returned by computer.prepare_click");
    }
    const approval = this.#actionApprovalRefs.get(actionApprovalRef);
    if (!approval || approval.expiresAt <= Date.now()) {
      this.#actionApprovalRefs.delete(actionApprovalRef);
      throw new Error("actionApprovalRef is invalid or expired; inspect and prepare the click again");
    }
    this.#actionApprovalRefs.delete(actionApprovalRef);

    const { observationRef, elementIndex, elementDescriptor: expectedElementDescriptor } = approval;
    const approvedApp = approval.app;
    const observation = this.#resolveObservationRef(observationRef);
    const target = this.#resolveWindowRef(observation.windowRef);
    if (approval.windowRef !== observation.windowRef || target.window.app !== observation.app) {
      this.#observationRefs.delete(observationRef);
      throw new Error("actionApprovalRef no longer matches the inspected target window; inspect and prepare the click again");
    }
    if (observation.helperApprovedApp !== approvedApp) {
      this.#observationRefs.delete(observationRef);
      throw new Error("actionApprovalRef no longer matches the approved app-access context; inspect and prepare the click again");
    }

    const preStateResponse = await this.#runHelperRequest(
      "get_window_state",
      {
        window: target.window,
        include_screenshot: false,
        include_text: true,
      },
      { approvedApp }
    );
    if (!preStateResponse.ok) {
      this.#observationRefs.delete(observationRef);
      return {
        status: "action_precondition_failed",
        action: "single_left_click",
        actionDispatched: false,
        retrySafe: false,
        elementIndex,
        elementDescriptor: expectedElementDescriptor,
        windowRef: observation.windowRef,
        error: `Fresh pre-click observation failed: ${preStateResponse.error ?? JSON.stringify(preStateResponse)}`,
        message: "No click was dispatched. The one-shot action approval has been consumed; inspect again and obtain a new action approval before any click.",
        runtime: this.#publicRuntime(),
      };
    }
    const preAccessibility = preStateResponse.result?.accessibility;
    const preTree = truncateUtf8(preAccessibility?.tree ?? "", MAX_ACCESSIBILITY_BYTES);
    const currentElementDescriptor = accessibilityElementDescriptors(preTree.text).get(elementIndex) ?? null;
    if (currentElementDescriptor !== expectedElementDescriptor) {
      this.#observationRefs.delete(observationRef);
      return {
        status: "stale_observation",
        action: "single_left_click",
        actionDispatched: false,
        retrySafe: false,
        elementIndex,
        expectedElementDescriptor,
        currentElementDescriptor,
        windowRef: observation.windowRef,
        message: "No click was dispatched because the accessibility element changed after approval. Inspect again and obtain a new action approval before any click.",
        runtime: this.#publicRuntime(),
      };
    }

    const response = await this.#runHelperRequest(
      "click_element",
      {
        window: target.window,
        element_index: elementIndex,
        click_count: 1,
        mouse_button: "left",
      },
      { approvedApp }
    );

    if (!response.ok) {
      this.#observationRefs.delete(observationRef);
      const approval = parseApprovalRequest(response);
      return {
        status: "action_failed_or_blocked",
        action: "single_left_click",
        actionCompleted: "unknown",
        retrySafe: false,
        elementIndex,
        windowRef: observation.windowRef,
        helperApprovalRequired: Boolean(approval),
        error: `Approved click did not return success: ${response.error ?? JSON.stringify(response)}`,
        message: "The approved click request was dispatched but did not return success. Do not retry automatically; inspect again and obtain a new action approval before any further click.",
        runtime: this.#publicRuntime(),
      };
    }

    this.#observationRefs.delete(observationRef);

    const postStateResponse = await this.#runHelperRequest(
      "get_window_state",
      {
        window: target.window,
        include_screenshot: false,
        include_text: true,
      },
      { approvedApp }
    );
    if (!postStateResponse.ok) {
      return {
        status: "action_completed_observation_failed",
        action: "single_left_click",
        actionCompleted: true,
        retrySafe: false,
        elementIndex,
        windowRef: observation.windowRef,
        error: `Post-click observation failed after the click completed: ${postStateResponse.error ?? JSON.stringify(postStateResponse)}`,
        message: "The click already completed. Do not retry the click automatically; inspect the window again before deciding any next action.",
        runtime: this.#publicRuntime(),
      };
    }

    const state = postStateResponse.result ?? {};
    const accessibility = state.accessibility && typeof state.accessibility === "object"
      ? state.accessibility
      : null;
    const tree = truncateUtf8(accessibility?.tree ?? "", MAX_ACCESSIBILITY_BYTES);
    const documentText = truncateUtf8(accessibility?.document_text ?? "", MAX_ACCESSIBILITY_BYTES);
    const selectedText = truncateUtf8(accessibility?.selected_text ?? "", 16 * 1024);
    const postObservationRef = `obs_${randomUUID()}`;
    this.#observationRefs.set(postObservationRef, {
      windowRef: observation.windowRef,
      app: target.window.app,
      helperApprovedApp: approvedApp,
      elementDescriptors: accessibilityElementDescriptors(tree.text),
      expiresAt: Date.now() + this.#observationTtlMs,
    });

    return {
      status: "ok",
      action: "single_left_click",
      elementIndex,
      windowRef: observation.windowRef,
      postObservationRef,
      observationExpiresInMs: this.#observationTtlMs,
      title: publicWindowTitle(state.window ?? target.window),
      accessibility: {
        tree: tree.text,
        treeTruncated: tree.truncated,
        documentText: documentText.text || null,
        documentTextTruncated: documentText.truncated,
        focusedElement: typeof accessibility?.focused_element === "string" ? accessibility.focused_element : null,
        selectedElements: Array.isArray(accessibility?.selected_elements)
          ? accessibility.selected_elements.filter((value) => typeof value === "string").slice(0, 50)
          : [],
        selectedText: selectedText.text || null,
        selectedTextTruncated: selectedText.truncated,
      },
      screenshotsReturned: Array.isArray(state.screenshots) ? state.screenshots.length : 0,
      runtime: this.#publicRuntime(),
    };
  }

  #publicWindow(window, displayName) {
    if (!window || typeof window !== "object" || typeof window.app !== "string" || !Number.isInteger(window.id)) {
      throw new Error(`Computer Use returned an invalid Window: ${JSON.stringify(window)}`);
    }
    const windowRef = `win_${randomUUID()}`;
    this.#windowRefs.set(windowRef, {
      window: { app: window.app, id: window.id, ...(typeof window.title === "string" ? { title: window.title } : {}) },
      displayName,
      expiresAt: Date.now() + this.#refTtlMs,
    });
    return {
      windowRef,
      title: publicWindowTitle(window),
      appDisplayName: displayName,
      expiresInMs: this.#refTtlMs,
    };
  }

  #resolveObservationRef(observationRef) {
    if (typeof observationRef !== "string" || !observationRef.startsWith("obs_")) {
      throw new Error("observationRef must be a fresh opaque reference returned by computer.inspect_window or computer.click");
    }
    const observation = this.#observationRefs.get(observationRef);
    if (!observation || observation.expiresAt <= Date.now()) {
      this.#observationRefs.delete(observationRef);
      throw new Error("observationRef is invalid or expired; inspect the window again before acting");
    }
    return observation;
  }

  #resolveWindowRef(windowRef) {
    if (typeof windowRef !== "string" || !windowRef.startsWith("win_")) {
      throw new Error("windowRef must be an opaque reference returned by computer.list_apps or computer.list_windows");
    }
    const target = this.#windowRefs.get(windowRef);
    if (!target || target.expiresAt <= Date.now()) {
      this.#windowRefs.delete(windowRef);
      throw new Error("windowRef is invalid or expired; call computer.list_apps/list_windows again");
    }
    return target;
  }

  #pruneRefs() {
    const now = Date.now();
    for (const [ref, value] of this.#windowRefs) if (value.expiresAt <= now) this.#windowRefs.delete(ref);
    for (const [ref, value] of this.#approvalRefs) if (value.expiresAt <= now) this.#approvalRefs.delete(ref);
    for (const [ref, value] of this.#actionApprovalRefs) if (value.expiresAt <= now) this.#actionApprovalRefs.delete(ref);
    for (const [ref, value] of this.#observationRefs) if (value.expiresAt <= now) this.#observationRefs.delete(ref);
  }

  #publicRuntime() {
    if (!this.#runtime) return null;
    return {
      codexVersion: this.#runtime.codexVersion,
      skyVersion: this.#runtime.skyVersion,
      helperSha256: this.#runtime.helperSha256,
    };
  }

  async #assertReadyAndPinned() {
    if (!this.#runtime) throw new Error("CodexComputerUseExecutor.validate() must succeed before use");
    const latest = await this.#runtimeInspector({
      codexBin: this.#codexBin,
      helperPath: this.#helperPath,
    });
    if (
      latest.codexVersion !== this.#runtime.codexVersion ||
      latest.skyVersion !== this.#runtime.skyVersion ||
      normalizeHash(latest.helperSha256) !== this.#runtime.helperSha256
    ) {
      throw new Error("Computer Use runtime changed after validation; restart/re-accept the preview before use");
    }
  }

  async #runHelperRequest(method, params, { approvedApp = null } = {}) {
    assertInternalHostMethod("process/spawn", CUA_CAPABILITY);
    assertInternalHostMethod("process/writeStdin", CUA_CAPABILITY);
    assertInternalHostMethod("process/kill", CUA_CAPABILITY);

    const client = this.#newClient();
    await client.start();
    const processHandle = `toolwire-cua-${randomUUID()}`;
    const helperRequestId = 1;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    let resolver;
    let rejecter;
    let timer;

    const responsePromise = new Promise((resolve, reject) => {
      resolver = resolve;
      rejecter = reject;
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Computer Use helper request timed out: ${method}`));
      }, this.#helperTimeoutMs);
      timer.unref?.();
    });

    const unsubscribe = client.onNotification((message) => {
      if (message.method === "process/outputDelta" && message.params?.processHandle === processHandle) {
        const chunk = Buffer.from(message.params?.deltaBase64 ?? "", "base64").toString("utf8");
        if (message.params?.stream === "stdout") {
          stdoutBuffer += chunk;
          while (true) {
            const newline = stdoutBuffer.indexOf("\n");
            if (newline < 0) break;
            const line = stdoutBuffer.slice(0, newline).trim();
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            if (!line) continue;
            let parsed;
            try {
              parsed = JSON.parse(line);
            } catch (error) {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                rejecter(new Error(`Computer Use helper emitted invalid JSON: ${line}; ${error.message}`));
              }
              return;
            }
            if (parsed?.id === helperRequestId && !settled) {
              settled = true;
              clearTimeout(timer);
              resolver(parsed);
              return;
            }
          }
        } else if (message.params?.stream === "stderr") {
          stderrBuffer += chunk;
        }
        return;
      }

      if (message.method === "process/exited" && message.params?.processHandle === processHandle && !settled) {
        settled = true;
        clearTimeout(timer);
        rejecter(new Error(
          `Computer Use helper exited before response: code=${message.params?.exitCode}; stderr=${stderrBuffer.trim()}`
        ));
      }
    });

    try {
      await client.request("process/spawn", {
        command: [this.#runtime.helperPath],
        processHandle,
        cwd: path.dirname(this.#runtime.helperPath),
        streamStdin: true,
        streamStdoutStderr: true,
        outputBytesCap: this.#helperOutputBytesCap,
        timeoutMs: this.#helperTimeoutMs + 2_000,
      });

      const meta = { [REQUEST_BUDGET_META_KEY]: this.#helperTimeoutMs };
      if (approvedApp) meta[APPROVED_APP_META_KEY] = approvedApp;
      const wireRequest = `${JSON.stringify({ id: helperRequestId, method, params, meta })}\n`;
      await client.request("process/writeStdin", {
        processHandle,
        deltaBase64: Buffer.from(wireRequest, "utf8").toString("base64"),
      });

      const response = await responsePromise;
      assertNoModelTurn(client);
      return response;
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
      try {
        await client.request("process/kill", { processHandle }, { timeoutMs: 2_000 });
      } catch {}
      await client.close();
    }
  }

  #newClient() {
    if (this.#clientFactory) return this.#clientFactory();
    return new CodexAppServerClient({
      bin: this.#codexBin,
      cwd: this.#defaultCwd,
      requestTimeoutMs: this.#helperTimeoutMs + 5_000,
      initializeCapabilities: { experimentalApi: true },
      clientInfo: {
        name: "codexless_cua_preview",
        title: "Codexless CUA Preview",
        version: "0.1.50-household-workspace",
      },
    });
  }
}
