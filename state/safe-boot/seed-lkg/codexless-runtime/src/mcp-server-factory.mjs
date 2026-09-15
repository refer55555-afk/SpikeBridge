import { createRequire } from "node:module";
import { registerAgentPreviewTools } from "./agent-tools.mjs";
import { registerSpikeAgentTools } from "./spike-agent-tools.mjs";
import { registerBrowserPreviewTools } from "./browser-tools.mjs";
import { registerConstructionTools } from "./construction-tools.mjs";
import { registerExcelTools } from "./excel-tools.mjs";
import { registerPublicTools } from "./public-tools.mjs";
import { wrapToolHandlerWithRecentCallReceipt } from "./recent-call-receipts.mjs";
import { registerWorkbenchPreviewTools } from "./workbench-tools.mjs";

const require = createRequire(import.meta.url);
const { McpServer } = require("@modelcontextprotocol/server");
const z = require("zod/v4");

const DEFAULT_MAX_TIMEOUT_MS = 30_000;

export function createCommandConcurrencyGate({ maxConcurrent = 2, resolveWriterProjectKey = null, getMaxConcurrent = null } = {}) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) {
    throw new Error("maxConcurrent must be an integer between 1 and 4");
  }
  if (resolveWriterProjectKey !== null && typeof resolveWriterProjectKey !== "function") {
    throw new Error("resolveWriterProjectKey must be null or a function");
  }

  let inFlight = 0;
  const activeWriterProjects = new Set();

  return {
    async acquire({ access = "readOnly", cwd = null, timeoutMs = 10_000 } = {}) {
      const limit = getMaxConcurrent ? getMaxConcurrent() : maxConcurrent;
      if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new Error("invalid dynamic command concurrency limit");
      if (inFlight >= limit) {
        return {
          ok: false,
          code: "GLOBAL_CONCURRENCY_LIMIT",
          message: `bridge concurrency limit reached (${limit})`,
        };
      }

      inFlight += 1;
      let writerProjectKey = null;
      let writerHeld = false;
      let released = false;
      try {
        if (access !== "readOnly" && resolveWriterProjectKey) {
          const resolved = await resolveWriterProjectKey({ access, cwd, timeoutMs });
          if (typeof resolved !== "string" || !resolved.trim()) {
            throw new Error("writer project identity resolution returned no usable project key");
          }
          writerProjectKey = resolved.trim();
          if (activeWriterProjects.has(writerProjectKey)) {
            released = true;
            inFlight -= 1;
            return {
              ok: false,
              code: "PROJECT_WRITER_CONCURRENCY_LIMIT",
              message: "project writer concurrency limit reached (1)",
            };
          }
          activeWriterProjects.add(writerProjectKey);
          writerHeld = true;
        }

        return {
          ok: true,
          release() {
            if (released) return;
            released = true;
            if (writerHeld) activeWriterProjects.delete(writerProjectKey);
            inFlight -= 1;
          },
        };
      } catch (error) {
        if (!released) {
          released = true;
          inFlight -= 1;
        }
        throw error;
      }
    },
    snapshot() {
      return {
        inFlight,
        activeWriterProjects: [...activeWriterProjects],
      };
    },
  };
}

export function composeRegisteredToolHandler({ name, handler, codexAgentRouter = null, experienceMemory = null, recentCallStore = null } = {}) {
  let wrapped = handler;
  if (typeof wrapped === "function" && codexAgentRouter?.wrap) {
    wrapped = codexAgentRouter.wrap(name, wrapped);
  }
  if (typeof wrapped === "function" && experienceMemory) {
    wrapped = wrapToolHandlerWithExperienceMemory({
      toolName: name,
      handler: wrapped,
      memory: experienceMemory,
      codexAgentRouter,
    });
  }
  if (typeof wrapped === "function" && recentCallStore) {
    wrapped = wrapToolHandlerWithRecentCallReceipt({
      toolName: name,
      handler: wrapped,
      store: recentCallStore,
    });
  }
  return wrapped;
}

export function createCodexToolboxServerFactory({
  executor,
  maxConcurrent = 2,
  resolveWriterProjectKey = null,
  maxTimeoutMs = DEFAULT_MAX_TIMEOUT_MS,
  version = "0.0.1-p2",
  serverInstructions = "P2 exposes only codex.command_exec. Each call starts a disposable Docker-isolated Codex App Server. The host chooses one fixed trusted workspace; callers cannot select host paths. Network is disabled and no Docker socket is mounted.",
  commandDescription = "Run one buffered argv command through the official Codex App Server command/exec surface without a Codex model thread/turn. The host fixes the only visible workspace. readOnly mounts that workspace RO; workspaceWrite mounts the same workspace RW. Network is disabled.",
  commandArgDescription = "argv vector passed to Codex command/exec inside the fixed trusted workspace container",
  accessArgDescription = "Choose whether the fixed trusted workspace is mounted read-only or read-write for this one call.",
  timeoutArgDescription = "Bounded command timeout in milliseconds.",
  exposeCwd = false,
  cwdRequired = false,
  cwdArgDescription = "Working directory context passed to Codex command/exec.",
  accessModes = ["readOnly", "workspaceWrite"],
  defaultAccess = "readOnly",
  toolTitle = "Codex Isolated Command",
  openWorldHint = false,
  surfaceVersion = null,
  warnWhenUsingDefaultCwd = false,
  computerUse = null,
  workbench = null,
  browserPreview = null,
  browserElicitationBridge = null,
  agentExecutor = null,
  modelCatalogProvider = null,
  authorityExecutor = null,
  agentAuthorityExecutor = null,
  meteredConsentMode = "off",
  meteredQuotaProvider = null,
  agentPreviewState = null,
  agentPortableCard = false,
  legacyAgentCardInternals = false,
  agentReasoningEffort = false,
  codexCallProfile = false,
  codexCallProfileFile = null,
  formalAgentBlock = null,
  toolAllowlist = null,
  publicPreview = false,
  guardDirectFormalCodex = false,
  recentCallStore = null,
  excelSessionRefs = null,
  toolHandlerSink = null,
  agentProviders = null,
  experienceMemory = null,
  codexAgentRouter = null,
  operatorControl = null,
}) {
  if (!executor) throw new Error("MCP server factory requires an executor");
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) {
    throw new Error("maxConcurrent must be an integer between 1 and 4");
  }
  if (resolveWriterProjectKey !== null && typeof resolveWriterProjectKey !== "function") {
    throw new Error("resolveWriterProjectKey must be null or a function");
  }
  if (!Array.isArray(accessModes) || accessModes.length < 1 || !accessModes.every((value) => typeof value === "string" && value)) {
    throw new Error("accessModes must be a non-empty string array");
  }
  if (!accessModes.includes(defaultAccess)) {
    throw new Error("defaultAccess must be included in accessModes");
  }
  const allowedTools = normalizeToolAllowlist(toolAllowlist);
  const commandConcurrency = createCommandConcurrencyGate({ maxConcurrent, resolveWriterProjectKey, getMaxConcurrent: operatorControl ? () => operatorControl.commandLimit() : null });
  if (operatorControl) operatorControl.commandGate = commandConcurrency;

  const commandShape = {
    command: z.array(z.string().max(32_768)).min(1).max(128)
      .describe(commandArgDescription),
    access: z.enum(accessModes).default(defaultAccess)
      .describe(accessArgDescription),
    timeoutMs: z.number().int().positive().max(maxTimeoutMs).default(10_000)
      .describe(timeoutArgDescription),
  };
  if (exposeCwd) {
    const cwdSchema = z.string().min(1).max(32_768).describe(cwdArgDescription);
    commandShape.cwd = cwdRequired ? cwdSchema : cwdSchema.optional();
  }
  const commandSchema = z.object(commandShape).strict();

  return function createServer() {
    const server = new McpServer(
      {
        name: "codexless",
        title: "Codexless",
        version,
        description: "Thin MCP adapter to model-free tools exposed by the official Codex App Server.",
      },
      {
        instructions: serverInstructions,
        ...(browserElicitationBridge
          ? {
              requestState: {
                verify: (state, ctx) => browserElicitationBridge.verifyRequestState(state, ctx),
              },
            }
          : {}),
      }
    );

    const registeredAllowedTools = new Set();
    const registrationServer = {
      registerTool(name, ...args) {
        if (allowedTools && !allowedTools.has(name)) return undefined;
        if (allowedTools) registeredAllowedTools.add(name);
        const handlerIndex = args.length - 1;
        args[handlerIndex] = composeRegisteredToolHandler({
          name,
          handler: args[handlerIndex],
          codexAgentRouter,
          experienceMemory,
          recentCallStore,
        });
        if (operatorControl && typeof args[handlerIndex] === "function") args[handlerIndex] = operatorControl.wrapTool(name, args[handlerIndex]);
        if (toolHandlerSink && typeof args[handlerIndex] === "function") {
          toolHandlerSink.set(name, args[handlerIndex]);
        }
        return server.registerTool(name, ...args);
      },
      registerResource(...args) {
        return server.registerResource(...args);
      },
    };

    registrationServer.registerTool(
      "codex.command_exec",
      {
        title: toolTitle,
        description: commandDescription,
        inputSchema: commandSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint,
        },
      },
      async ({ command, access, timeoutMs, cwd }) => {
        const directCodexGuard = guardDirectFormalCodex
          ? (publicPreview ? classifyAnyCodexInvocation(command) : classifyFormalCodexInvocation(command))
          : null;
        if (directCodexGuard) {
          return toolError(directCodexGuard.message, {
            errorCode: "FORMAL_CODEX_AGENT_REQUIRED",
            nextActions: directCodexGuard.nextActions,
          });
        }
        let admission;
        try {
          admission = await commandConcurrency.acquire({ access, cwd, timeoutMs });
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
            error && typeof error === "object"
              ? { errorCode: error.code, nextActions: error.nextActions }
              : undefined
          );
        }
        if (!admission.ok) {
          return toolError(admission.message, { errorCode: admission.code });
        }

        try {
          const result = await executor.exec({ command, access, timeoutMs, cwd });
          const payload = {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            access,
          };
          if (typeof result.stdoutTruncated === "boolean") payload.stdoutTruncated = result.stdoutTruncated;
          if (typeof result.stderrTruncated === "boolean") payload.stderrTruncated = result.stderrTruncated;
          if (typeof result.permissionCeiling === "string") payload.permissionCeiling = result.permissionCeiling;
          if (typeof result.permissionProfile === "string") payload.permissionProfile = result.permissionProfile;
          if (typeof result.effectiveCwd === "string") payload.cwd = result.effectiveCwd;
          if (typeof result.authoritySource === "string") payload.authoritySource = result.authoritySource;
          if (typeof result.trustedAncestor === "string") payload.trustedAncestor = result.trustedAncestor;
          if (result.executableResolution && typeof result.executableResolution === "object") payload.executableResolution = result.executableResolution;
          if (typeof result.resolutionSource === "string") payload.resolutionSource = result.resolutionSource;
          if (typeof result.errorCode === "string") payload.errorCode = result.errorCode;
          if (typeof result.diagnostic === "string") payload.diagnostic = result.diagnostic;
          if (Array.isArray(result.nextActions) && result.nextActions.every((value) => typeof value === "string")) {
            payload.nextActions = result.nextActions;
          }
          if (typeof surfaceVersion === "string" && surfaceVersion) payload.surfaceVersion = surfaceVersion;
          if (exposeCwd) payload.cwdSource = typeof cwd === "string" && cwd.trim() ? "remote" : "localDefault";
          if (warnWhenUsingDefaultCwd && exposeCwd && !(typeof cwd === "string" && cwd.trim())) {
            payload.compatibilityWarning =
              "cwd was not provided, so Codexless used its local default cwd. This can indicate a stale ChatGPT App action schema that does not expose the current cwd field; re-scan/recreate the Codexless App before cross-project work.";
            payload.nextActions = [
              "Use this connector only for the reported default cwd until its action schema is refreshed.",
              "Re-scan/recreate the Codexless ChatGPT App against the current compatibility tunnel to expose command/cwd/access/timeoutMs.",
            ];
          }
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            structuredContent: payload,
            isError: result.exitCode !== 0,
          };
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
            error && typeof error === "object"
              ? { errorCode: error.code, nextActions: error.nextActions }
              : undefined
          );
        } finally {
          admission.release();
        }
      }
    );

    if (workbench) {
      registerWorkbenchPreviewTools(registrationServer, workbench, {
        directFormalCodexGuard: guardDirectFormalCodex ? classifyFormalCodexInvocation : null,
        processDescriptionSuffix: guardDirectFormalCodex
          ? " Direct Codex model/control invocation is not a supported fallback on this model-callable process lane: household formal Codex work must use codex.agent_start/codex.agent_send. Required Call Approval returns fixed compact text bound to one exact Task ID; map literal Yes/No only through codex.agent_commit/codex.agent_decline. Running has no mechanical presentation and terminal Result is fixed text. This is an accidental-routing guard, not a claim that a generic process/PTY is an inescapable sandbox against arbitrarily wrapped executables."
          : "",
      });
      registerConstructionTools(registrationServer, { authorityExecutor });
      registerExcelTools(registrationServer, { workbench, sessionRefs: excelSessionRefs });
      if (publicPreview) registerPublicTools(registrationServer, { workbench });
    }
    if (browserPreview) registerBrowserPreviewTools(registrationServer, browserPreview, {
      elicitationBridge: browserElicitationBridge,
    });
    if (agentExecutor) registerAgentPreviewTools(registrationServer, {
      agentExecutor,
      modelCatalogProvider,
      authorityExecutor: agentAuthorityExecutor ?? authorityExecutor,
      meteredConsentMode,
      meteredQuotaProvider,
      agentPreviewState,
      agentPortableCard,
      legacyAgentCardInternals,
      agentReasoningEffort,
      codexCallProfile,
      codexCallProfileFile,
      formalAgentBlock,
    });
    if (agentProviders) registerSpikeAgentTools(registrationServer, { registry: agentProviders, memory: experienceMemory });
    if (computerUse) registerComputerUsePreviewTools(registrationServer, computerUse);

    if (allowedTools) {
      const missing = [...allowedTools].filter((name) => !registeredAllowedTools.has(name));
      if (missing.length) {
        throw new Error(`toolAllowlist contains tools not registered by this server configuration: ${missing.join(", ")}`);
      }
    }

    return server;
  };
}

const WRAPPED_CODEX_COMMAND_TOKEN_RE = /(?:^|[\s\"'`;&|(),])(?:[^\s\"'`;&|(),]*[\\/])?codex(?:\.(?:exe|com|cmd|bat|ps1))?(?=$|[\s\"'`;&|(),])/i;
const SHELL_CODEX_COMMAND_HEAD_RE = /(?:^|(?:&&|\|\||[;|])\s*|(?:^|\s)&\s*)[\"']?(?:[^\s\"'`;&|(),]*[\\/])?codex(?:\.(?:exe|com|cmd|bat|ps1))?[\"']?(?=$|[\s\"'`;&|(),])/i;
const COMMAND_STRING_CODEX_WRAPPERS = new Set(["cmd", "powershell", "pwsh", "sh", "bash", "zsh", "fish"]);
const INLINE_CODEX_WRAPPERS = new Set(["node", "nodejs", "python", "python3", "py", "ruby", "perl", "deno", "bun"]);
const EXECUTABLE_CODEX_WRAPPERS = new Set(["env", "sudo", "wsl", "nohup", "timeout", "nice", "stdbuf", "xargs", "npx", "npm", "pnpm", "yarn"]);

function classifyAnyCodexInvocation(command) {
  if (!Array.isArray(command) || command.length < 1) return null;
  const executable = commandExecutableStem(command[0]);
  if (["codex", "codex.exe", "codex.cmd", "codex.bat"].includes(commandExecutableBasename(command[0]))) {
    return directFormalCodexRejection("direct-codex-executable");
  }
  if (!wrapperCarriesCodexInvocation(command, executable)) return null;
  return directFormalCodexRejection(`wrapped-${executable}`);
}

function classifyFormalCodexInvocation(command) {
  if (!Array.isArray(command) || command.length < 1) return null;
  const executable = commandExecutableStem(command[0]);
  if (["codex", "codex.exe", "codex.cmd", "codex.bat"].includes(commandExecutableBasename(command[0]))) {
    return classifyDirectFormalCodexInvocation(command);
  }
  if (!wrapperCarriesCodexInvocation(command, executable)) return null;
  return directFormalCodexRejection(`wrapped-${executable}`);
}

function wrapperCarriesCodexInvocation(command, wrapper) {
  const args = command.slice(1).map((value) => String(value));
  if (COMMAND_STRING_CODEX_WRAPPERS.has(wrapper)) {
    const commandText = shellWrapperCommandText(args, wrapper);
    return commandText ? SHELL_CODEX_COMMAND_HEAD_RE.test(commandText) : false;
  }
  if (INLINE_CODEX_WRAPPERS.has(wrapper)) {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const prior = args[index - 1];
      const inlineCode = ["-e", "--eval", "-c", "-Command", "--command", "-p", "--print"].includes(prior)
        || /^-(?:e|c|p)=/.test(arg)
        || /^--(?:eval|command|print)=/.test(arg)
        || (wrapper === "deno" && prior === "eval");
      if (inlineCode && WRAPPED_CODEX_COMMAND_TOKEN_RE.test(arg)) return true;
    }
    return false;
  }
  if (EXECUTABLE_CODEX_WRAPPERS.has(wrapper)) {
    return args.some((arg) => commandExecutableStem(arg) === "codex" || WRAPPED_CODEX_COMMAND_TOKEN_RE.test(arg));
  }
  return false;
}

function shellWrapperCommandText(args, wrapper) {
  if (wrapper === "cmd") {
    const commandIndex = args.findIndex((arg) => ["/c", "/k"].includes(arg.toLowerCase()));
    return commandIndex >= 0 ? args.slice(commandIndex + 1).join(" ").trim() : null;
  }
  if (["powershell", "pwsh"].includes(wrapper)) {
    const commandIndex = args.findIndex((arg) => ["-command", "-c"].includes(arg.toLowerCase()));
    return commandIndex >= 0 ? args.slice(commandIndex + 1).join(" ").trim() : null;
  }
  const commandIndex = args.findIndex((arg) => ["-c", "-lc"].includes(arg.toLowerCase()));
  return commandIndex >= 0 ? String(args[commandIndex + 1] ?? "").trim() : null;
}

function commandExecutableBasename(value) {
  const normalized = String(value ?? "").trim().replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function commandExecutableStem(value) {
  return commandExecutableBasename(value).replace(/\.(?:exe|com|cmd|bat|ps1)$/i, "");
}

const DIRECT_CODEX_BLOCKED_SUBCOMMANDS = new Set([
  "exec", "e", "review", "resume", "fork", "app-server", "mcp-server", "remote-control", "exec-server",
]);
const DIRECT_CODEX_SAFE_SUBCOMMANDS = new Set([
  "login", "logout", "mcp", "plugin", "app", "completion", "update", "doctor", "sandbox", "debug",
  "apply", "a", "archive", "delete", "unarchive", "cloud", "features", "help",
]);
const DIRECT_CODEX_OPTIONS_WITH_VALUE = new Set([
  "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env", "-i", "--image",
  "-m", "--model", "--local-provider", "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir",
  "-a", "--ask-for-approval",
]);

function classifyDirectFormalCodexInvocation(command) {
  if (!Array.isArray(command) || command.length < 1) return null;
  const executable = String(command[0]).trim().split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (!["codex", "codex.exe", "codex.cmd", "codex.bat"].includes(executable)) return null;

  const args = command.slice(1).map((value) => String(value));
  let sawHelpOrVersion = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const lower = arg.toLowerCase();
    if (["--help", "-h", "--version", "-v"].includes(lower)) {
      sawHelpOrVersion = true;
      continue;
    }
    if (arg === "--") return directFormalCodexRejection("interactive/default-prompt");
    if (arg.startsWith("-")) {
      const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (DIRECT_CODEX_OPTIONS_WITH_VALUE.has(optionName) && !arg.includes("=")) index += 1;
      continue;
    }
    if (DIRECT_CODEX_BLOCKED_SUBCOMMANDS.has(lower)) return directFormalCodexRejection(lower);
    if (DIRECT_CODEX_SAFE_SUBCOMMANDS.has(lower)) return null;
    return directFormalCodexRejection("interactive/default-prompt");
  }

  if (sawHelpOrVersion) return null;
  return directFormalCodexRejection("interactive/default-prompt");
}

function directFormalCodexRejection(kind) {
  return {
    kind,
    message:
      "Direct Codex model/control invocation is blocked on this model-free Codexless lane because it can bypass the visible household Codex decision flow. Formal Codex work must use codex.agent_start/codex.agent_send and the fixed-text exact-Task-ID approval/result lifecycle.",
    nextActions: [
      "Use codex.agent_start for a new formal Codex task, or codex.agent_send for an existing Codexless-owned agent.",
      "If the Agent call returns consent_required, present its fixed compact approval text and bind literal Yes/No only to that exact Task ID through codex.agent_commit or codex.agent_decline. Do not retry through command_exec or codex.process.",
      "This guard prevents obvious accidental/automatic direct Codex routing; generic process/PTY is not claimed to be an inescapable security sandbox against arbitrarily wrapped executables.",
    ],
  };
}

const SPIKE_PROVIDER_INTERNAL = Symbol.for("spike.bridge.agent-provider.internal");

function experienceMemoryBlockedResult(guard) {
  const payload = {
    error: `Experience Memory blocked a repeated known-bad attempt (${guard?.reason ?? "guard"}).`,
    errorCode: "EXPERIENCE_MEMORY_RETRY_BLOCKED",
    ...(guard?.recommendedFix ? { recommendedFix: guard.recommendedFix } : {}),
    ...(guard?.reason ? { memoryReason: guard.reason } : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function codexAgentRef(payload, fallback = null) {
  return payload?.agentRef || payload?.ref || payload?.taskCard?.agentRef || fallback || null;
}

function wrapToolHandlerWithExperienceMemory({ toolName, handler, memory, codexAgentRouter = null }) {
  return async (input = {}, ...rest) => {
    if (input?.[SPIKE_PROVIDER_INTERNAL] === true) return handler(input, ...rest);

    const memoryProvider = toolName === "codex.agent_start"
      ? "codex"
      : toolName.startsWith("codex.agent_")
        ? codexAgentRouter?.resolveProvider?.(toolName, input) ?? "codex"
        : null;
    let args = input;
    let memoryState = null;
    try {
      if (toolName === "codex.agent_start" && typeof input?.prompt === "string") {
        memoryState = memory.beforeAgentStart?.({
          task: input.prompt,
          provider: memoryProvider,
          project: input.cwd ?? null,
          tools: ["codex.agent_start"],
        });
        if (memoryState?.guard?.blocked) return experienceMemoryBlockedResult(memoryState.guard);
        if (memoryState?.task) args = { ...input, prompt: memoryState.task };
      } else if (toolName === "codex.agent_send" && typeof input?.message === "string") {
        memoryState = memory.beforeAgentSend?.({
          ref: input.agentRef,
          message: input.message,
          provider: memoryProvider,
          project: null,
          tools: ["codex.agent_send"],
          approach: input.message,
        });
        if (memoryState?.guard?.blocked) return experienceMemoryBlockedResult(memoryState.guard);
        if (memoryState?.message) args = { ...input, message: memoryState.message };
      }
    } catch {
      // Memory is an internal aid. A Memory read/build failure must never turn
      // an otherwise-valid Bridge tool call into a Bridge outage.
      memoryState = null;
      args = input;
    }

    let result;
    try {
      result = await handler(args, ...rest);
    } catch (error) {
      try {
        if (toolName.startsWith("codex.agent_")) {
          memory.onProviderFailure?.({
            jobKey: memoryState?.jobKey,
            provider: memoryProvider,
            project: input?.cwd ?? memoryState?.project ?? null,
            tool: toolName,
            error,
          });
        } else {
          memory.onToolFailure?.({ jobKey: `mcp:${toolName}`, tool: toolName, error });
        }
      } catch {}
      throw error;
    }

    const payload = result?.structuredContent ?? null;
    try {
      if (toolName === "codex.agent_start") {
        const ref = codexAgentRef(payload);
        if (ref && memoryState?.jobKey) memory.bindJobRef?.(memoryState.jobKey, ref);
      } else if (toolName === "codex.agent_send") {
        const ref = codexAgentRef(payload, input?.agentRef ?? null);
        if (ref && memoryState?.jobKey) memory.bindJobRef?.(memoryState.jobKey, ref);
      } else if (["codex.agent_show", "codex.agent_cancel", "codex.agent_approve", "codex.agent_reject"].includes(toolName) && input?.agentRef) {
        memory.observeAgentStatus?.({ provider: memoryProvider, ref: input.agentRef, payload });
      }

      if (result?.isError === true) {
        if (toolName.startsWith("codex.agent_")) {
          memory.onProviderFailure?.({
            jobKey: memoryState?.jobKey || memory.jobForRef?.(memoryProvider, input?.agentRef)?.jobKey,
            provider: memoryProvider,
            project: input?.cwd ?? memoryState?.project ?? null,
            tool: toolName,
            payload,
          });
        } else {
          memory.onToolFailure?.({ jobKey: `mcp:${toolName}`, tool: toolName, payload });
        }
      }
    } catch {}
    return result;
  };
}

function normalizeToolAllowlist(toolAllowlist) {
  if (toolAllowlist === null || toolAllowlist === undefined) return null;
  if (!Array.isArray(toolAllowlist) || toolAllowlist.length < 1) {
    throw new Error("toolAllowlist must be null or a non-empty string array");
  }
  if (!toolAllowlist.every((value) => typeof value === "string" && value.trim() === value && value.length > 0)) {
    throw new Error("toolAllowlist entries must be non-empty trimmed strings");
  }
  const allowed = new Set(toolAllowlist);
  if (allowed.size !== toolAllowlist.length) {
    throw new Error("toolAllowlist entries must be unique");
  }
  return allowed;
}

function registerComputerUsePreviewTools(server, computerUse) {
  const noArgsSchema = z.object({}).strict();
  const inspectSchema = z.object({
    windowRef: z.string().min(1).max(256)
      .describe("Opaque window reference returned by computer.list_apps or computer.list_windows. Raw app IDs, process paths, and window handles are not accepted."),
    approvalRef: z.string().min(1).max(256).optional()
      .describe("Optional single-use app-access approval reference returned by the immediately preceding inspect_window call. Supply it only after the user explicitly approves that exact read-only inspection."),
  }).strict();
  const prepareClickSchema = z.object({
    observationRef: z.string().min(1).max(256)
      .describe("Fresh opaque observation reference returned by computer.inspect_window. The observation is consumed after a successful click."),
    elementIndex: z.number().int().min(0).max(100_000)
      .describe("Accessibility element index from the fresh observation. The preview performs exactly one left click and accepts no raw coordinates, window IDs, or double-click count."),
  }).strict();
  const executeClickSchema = z.object({
    actionApprovalRef: z.string().min(1).max(256)
      .describe("Single-use exact-action reference returned by computer.prepare_click. Supply it only after the user explicitly approves the prepared element descriptor and single-left-click action."),
  }).strict();

  server.registerTool(
    "computer.list_apps",
    {
      title: "List Windows Apps",
      description:
        "List Windows applications and their currently targetable windows through the pinned official Codex Computer Use helper. Returns opaque windowRef values instead of raw app identifiers, process paths, or OS window handles. This is discovery only and does not inspect an app's window contents.",
      inputSchema: noArgsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => toStructuredToolResult(() => computerUse.listApps())
  );

  server.registerTool(
    "computer.list_windows",
    {
      title: "List Windows",
      description:
        "List currently targetable Windows windows through the pinned official Codex Computer Use helper. Returns opaque windowRef values and user-visible titles only; raw app identifiers, process paths, and OS window handles are withheld.",
      inputSchema: noArgsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => toStructuredToolResult(() => computerUse.listWindows())
  );

  server.registerTool(
    "computer.inspect_window",
    {
      title: "Inspect Windows App Window",
      description:
        "Read a fresh accessibility snapshot for one opaque windowRef using the pinned official Codex Computer Use helper. The preview requests text only and explicitly disables screenshots. If app access is required, the first call returns status=approval_required plus a one-time approvalRef and no window contents. After the user explicitly approves that exact read-only inspection, retry this same tool with the same windowRef plus that approvalRef. The approvalRef is consumed by the retry; no separate approval/write tool is used.",
      inputSchema: inspectSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ windowRef, approvalRef }) => toStructuredToolResult(() => computerUse.inspectWindow({ windowRef, approvalRef }))
  );

  server.registerTool(
    "computer.prepare_click",
    {
      title: "Prepare Exact Windows Click",
      description:
        "Prepare, but do not execute, exactly one left click on one accessibility element from a fresh approved observation. This is read-only and sends no click to Windows. It resolves the elementIndex to the exact observed element descriptor and returns a single-use actionApprovalRef. Ask the user to approve that exact descriptor/action before calling computer.click. No coordinates, raw handles, double-click, keyboard input, scroll, drag, or launch are accepted.",
      inputSchema: prepareClickSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ observationRef, elementIndex }) => toStructuredToolResult(() => computerUse.prepareClick({ observationRef, elementIndex }))
  );

  server.registerTool(
    "computer.click",
    {
      title: "Execute Prepared Windows Click",
      description:
        "Execute exactly one previously prepared single-left-click action identified only by a single-use actionApprovalRef. Call this only after the user explicitly approves the exact element descriptor returned by computer.prepare_click. Before dispatch Codexless re-reads the current accessibility tree and refuses the click if the indexed element changed. The actionApprovalRef is consumed before dispatch, the source observation is consumed, screenshots remain disabled, and uncertain action results must never be auto-retried. No coordinates, raw handles, double-click, keyboard input, scroll, drag, or launch are exposed.",
      inputSchema: executeClickSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ actionApprovalRef }) => toStructuredToolResult(() => computerUse.click({ actionApprovalRef }))
  );
}

async function toStructuredToolResult(task) {
  try {
    const payload = await task();
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: false,
    };
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

function toolError(message, details = {}) {
  const structuredContent = { error: message };
  if (typeof details?.errorCode === "string") structuredContent.errorCode = details.errorCode;
  if (Array.isArray(details?.nextActions) && details.nextActions.every((value) => typeof value === "string")) {
    structuredContent.nextActions = details.nextActions;
  }
  return {
    content: [{ type: "text", text: message }],
    structuredContent,
    isError: true,
  };
}
