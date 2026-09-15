import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createModelFreeGitCommitPrimitive, resolveFixedGitExecutable } from "./git-commit-primitive.mjs";
import { runGitCommitSelftest } from "./git-commit-selftest.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const spikeBridgeRoot = process.env.SPIKE_BRIDGE_ROOT?.trim()
  ? path.resolve(process.env.SPIKE_BRIDGE_ROOT)
  : path.resolve(moduleDir, "..", "..");
const housekeepingPluginPath = process.env.SPIKE_BRIDGE_HOUSEKEEPING_PLUGIN?.trim()
  ? path.resolve(process.env.SPIKE_BRIDGE_HOUSEKEEPING_PLUGIN)
  : path.join(spikeBridgeRoot, "plugins", "housekeeping", "index.mjs");
const { createHousekeepingPlugin } = await import(pathToFileURL(housekeepingPluginPath).href);
const defaultInstallRoot = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Codexless");
const installRoot = process.env.SPIKE_HOME_CODEXLESS_RUNTIME_ROOT?.trim()
  ? path.resolve(process.env.SPIKE_HOME_CODEXLESS_RUNTIME_ROOT)
  : defaultInstallRoot;
const requireFromCodexless = createRequire(path.join(installRoot, "package.json"));
const { createMcpHandler } = requireFromCodexless("@modelcontextprotocol/server");
const { localhostHostValidation, localhostOriginValidation, toNodeHandler } = requireFromCodexless("@modelcontextprotocol/node");
const z = requireFromCodexless("zod/v4");

const runtimeModule = await import(pathToFileURL(path.join(installRoot, "src", "codexless-runtime.mjs")).href);
const authorityModule = await import(pathToFileURL(path.join(installRoot, "src", "codex-authority-executor.mjs")).href);
const codexBinModule = await import(pathToFileURL(path.join(installRoot, "src", "codex-bin.mjs")).href);

const { createCodexlessRuntime } = runtimeModule;
const { CodexAuthorityExecutor } = authorityModule;
const { resolveCodexExecutable } = codexBinModule;

const host = process.env.CODEX_TOOLBOX_PUBLIC_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.CODEX_TOOLBOX_PUBLIC_PORT ?? "7690", 10);
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  throw new Error("Spike Home Codexless overlay may bind only to loopback");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid CODEX_TOOLBOX_PUBLIC_PORT: ${process.env.CODEX_TOOLBOX_PUBLIC_PORT}`);
}

const defaultCwd = process.env.CODEXLESS_DEFAULT_CWD ?? process.cwd();
const profileOverride = process.env.CODEXLESS_PROFILE?.trim() || null;
let configOverrides = [];
const configOverridesFile = process.env.CODEXLESS_CONFIG_OVERRIDES_FILE?.trim();
if (configOverridesFile) {
  const parsed = JSON.parse(await readFile(configOverridesFile, "utf8"));
  configOverrides = parsed?.overrides;
  if (!Array.isArray(configOverrides) || !configOverrides.every((value) => typeof value === "string" && value.trim())) {
    throw new Error("CODEXLESS_CONFIG_OVERRIDES_FILE must contain { overrides: [\"key=value\", ...] }");
  }
}

const runtime = await createCodexlessRuntime({ mode: "public" });
const codexResolution = await resolveCodexExecutable({ env: process.env });
const authorityExecutor = new CodexAuthorityExecutor({
  codexBin: codexResolution.path,
  defaultCwd,
  profileOverride,
  configOverrides,
  maxTimeoutMs: 30_000,
  watchdogGraceMs: 5_000,
  outputBytesCap: 32_768,
  acceptedCodexVersions: null,
});
const authorityValidation = await authorityExecutor.validate();
const gitExecutable = await resolveFixedGitExecutable();

const contextFile = process.env.SPIKE_BRIDGE_CONTEXT_FILE?.trim()
  ? path.resolve(process.env.SPIKE_BRIDGE_CONTEXT_FILE)
  : path.join(spikeBridgeRoot, "config", "context.json");
const spikeContextBridge = contextFile;
const artifactDigest = process.env.SPIKE_HOME_ARTIFACT_DIGEST?.trim() || null;
const housekeeping = createHousekeepingPlugin({
  root: process.env.SPIKE_BRIDGE_ROOT?.trim() ? path.resolve(process.env.SPIKE_BRIDGE_ROOT) : process.cwd(),
  logger: console,
});

async function runSpikeContextBridge(payload = null, { preflight = false } = {}) {
  if (preflight) {
    return { result: "PASS", tool: "spike_context", transport: "local-json", ledger_fixed: false, ledger_scope: "local_config", write_tools: 0 };
  }
  let source = { items: [] };
  try {
    source = JSON.parse(await readFile(contextFile, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const request = payload && typeof payload === "object" ? payload : {};
  const items = Array.isArray(source?.items) ? source.items : [];
  const maxItems = Number.isInteger(request.max_items) ? request.max_items : 32;
  const context = {
    query: typeof request.query === "string" ? request.query : "",
    as_of: typeof request.as_of === "string" ? request.as_of : null,
    items: items.slice(0, Math.max(1, Math.min(64, maxItems))),
  };
  const digest = createHash("sha256").update(JSON.stringify(context)).digest("hex");
  return { context, digest };
}

const primitive = createModelFreeGitCommitPrimitive({
  authorityExecutor,
  gitExecutable,
  baseEnv: process.env,
});

const stateRoot = path.join(process.cwd(), "state");
const selftest = await runGitCommitSelftest({
  authorityExecutor,
  gitExecutable,
  stateRoot,
  baseEnv: process.env,
});
if (selftest?.result !== "PASS" || selftest?.modelCallCount !== 0) {
  throw new Error("model_free_git_commit startup acceptance did not PASS with MODEL_CALL_COUNT=0");
}

const spikeContextSelftest = await runSpikeContextBridge(null, { preflight: true });
if (
  spikeContextSelftest?.result !== "PASS" ||
  spikeContextSelftest?.tool !== "spike_context" ||
  spikeContextSelftest?.write_tools !== 0
) {
  throw new Error("spike_context startup acceptance did not PASS");
}

const baseCreateServer = runtime.createServer;
function createServer() {
  const server = baseCreateServer();
  server.registerTool(
    "model_free_git_commit",
    {
      title: "Model-Free Bounded Git Commit",
      description:
        "Commit all current changes in one already trusted Git repository without a model turn. This bounded primitive provides no push or network operation. Inputs remain only cwd and a single-line commit message; arbitrary remotes, force push, history rewrite, shell execution, and model-controlled credentials are not exposed.",
      inputSchema: z.object({
        cwd: z.string().min(1).max(32_768),
        message: z.string().min(1).max(512),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ cwd, message }) => {
      const payload = await primitive({ cwd, message });
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: false,
      };
    }
  );

  server.registerTool(
    "spike_context",
    {
      title: "Spike OS Bounded Context",
      description:
        "Read optional bounded local context from config/context.json. Read-only. This public build ships with no personal context; users may add their own non-secret local items.",
      inputSchema: z.object({
        query: z.string().max(8_000),
        as_of: z.string().min(1).max(64),
        focus_keys: z.array(z.string().min(1).max(512)).max(64).optional(),
        max_items: z.number().int().min(1).max(64).optional(),
        max_chars: z.number().int().min(256).max(200_000).optional(),
        max_evidence_per_candidate: z.number().int().min(0).max(16).optional(),
        max_excerpt_chars: z.number().int().min(16).max(4_000).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (payload) => {
      const result = await runSpikeContextBridge(payload);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      };
    }
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer, {
  legacy: "stateless",
  maxSubscriptions: 0,
  keepAliveMs: 0,
  onerror: (error) => console.error("[spike-home-codexless-overlay-mcp]", error),
});
const nodeMcpHandler = toNodeHandler(mcpHandler, {
  onerror: (error) => console.error("[spike-home-codexless-overlay-node]", error),
});
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();
const surfaceVersion = `${runtime.surfaceVersion}+model-free-git-commit-v1+spike-context-local-v1`;

const server = http.createServer(async (req, res) => {
  try {
    if (!validateHost(req, res)) return;
    if (!validateOrigin(req, res)) return;
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        service: "spike-home-codexless-overlay",
        transport: "streamable-http",
        version: runtime.version,
        surfaceVersion,
        toolCount: (runtime.toolAllowlist?.length ?? 0) + 2,
        defaultCwd: authorityValidation.defaultCwd ?? defaultCwd,
        modelFreeGitCommit: "PASS",
        spikeContextBridge: "PASS",
        spikeContextTool: "spike_context",
        modelCallCount: 0,
        selftestVersion: selftest.version,
        pid: process.pid,
        artifactDigest,
        housekeeping: housekeeping.status(),
        operator: runtime.operator ? { version: 1, ...runtime.operator.health() } : null,
      }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    await nodeMcpHandler(req, res);
  } catch (error) {
    console.error("[spike-home-codexless-overlay-http]", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
    }
    if (!res.writableEnded) res.end(JSON.stringify({ error: "internal_error" }));
  }
});

server.keepAliveTimeout = 5_000;
server.headersTimeout = 10_000;
server.requestTimeout = 0;
server.maxHeadersCount = 64;

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolve);
});
// Register the exact existing handlers once for the private management pipe.
createServer();
await runtime.operator?.listen({ handlers: runtime.operatorHandlers, housekeeping });
await housekeeping.start();
console.error(`Spike Home Codexless overlay listening on http://${host}:${port}/mcp; surface=${surfaceVersion}`);

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  try {
    await runtime.operator?.close();
    housekeeping.stop();
    await mcpHandler.close();
    await new Promise((resolve) => server.close(() => resolve()));
  } finally {
    await runtime.close();
    console.error(`Spike Home Codexless overlay stopped (${signal})`);
  }
}

process.once("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));
