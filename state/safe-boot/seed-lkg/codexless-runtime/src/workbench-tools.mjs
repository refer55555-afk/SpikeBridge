import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

export function registerWorkbenchPreviewTools(
  server,
  workbench,
  { directFormalCodexGuard = null, processDescriptionSuffix = "" } = {}
) {
  if (!workbench) return;

  server.registerTool(
    "codex.project_context",
    {
      title: "Codex Project Context",
      description:
        "Experimental Workbench Preview. Ask the official Codex App Server for a fresh no-turn project bootstrap at cwd and return Codex's current workspace roots, permission profile, instruction sources, approval policy, reviewer, sandbox projection, CLI version, and authoritative implicit Skill routing when stock prompt-input alignment is proven. Implicit routing fails closed locally if Codex debug prompt-input is unavailable or drifts; the rest of project context remains usable. This is capability/dogfood infrastructure, not a separate Codexless workspace authority.",
      inputSchema: z.object({ cwd: z.string().min(1).max(32_768).optional() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => structured(() => workbench.projectContext(input))
  );

  server.registerTool(
    "codex.account_preflight",
    {
      title: "Codex Preview Account Preflight",
      description:
        "Experimental Workbench Preview. Run a model-free account/quota preflight from the selected Codexless toolbox runtime using an independent short-lived Codex App Server client with the same binary/home/config context. Returns only sanitized account-presence/auth/plan and quota status/error facts; it never returns credentials and does not start a model turn. When the explicit managed runtime is selected but its isolated CODEX_HOME is not logged in, the result includes the official ChatGPT login journey without exposing auth URL query data, tokens, cookies, or credential contents.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => structured(() => workbench.accountPreflight())
  );

  server.registerTool(
    "codex.fs_read",
    {
      title: "Codex Structured Filesystem Read/Search",
      description:
        "Experimental Workbench Preview over Codex App Server structured host filesystem/search methods. operation=readText reads one absolute path as UTF-8 text; list lists one absolute directory; metadata reads path metadata; search runs Codex fuzzyFileSearch over supplied absolute roots (or the Workbench default root). Raw host-control-plane semantics are intentional in this isolated capability preview and are not the stable public Codexless permission boundary.",
      inputSchema: z.object({
        operation: z.enum(["readText", "list", "metadata", "search"]),
        target: z.string().min(1).max(32_768).optional(),
        query: z.string().min(1).max(32_768).optional(),
        roots: z.array(z.string().min(1).max(32_768)).max(32).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => structured(() => workbench.fsRead(input))
  );

  server.registerTool(
    "codex.fs_mutate",
    {
      title: "Codex Structured Filesystem Mutation",
      description:
        "Experimental Workbench Preview over Codex App Server structured host filesystem mutation methods. Supports writeText, mkdir, copy, and remove using absolute paths. This is deliberately a broad self-dogfood capability surface, not the stable/live Codexless authority model; use only for explicitly intended construction and disposable or real user-authorized targets.",
      inputSchema: z.object({
        operation: z.enum(["writeText", "mkdir", "copy", "remove"]),
        target: z.string().min(1).max(32_768).optional(),
        text: z.string().max(2_000_000).optional(),
        source: z.string().min(1).max(32_768).optional(),
        destination: z.string().min(1).max(32_768).optional(),
        recursive: z.boolean().default(true),
        force: z.boolean().default(true),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input) => structured(() => workbench.fsMutate(input))
  );

  server.registerTool(
    "codex.process",
    {
      title: "Codex Long Process / PTY",
      description:
        "Experimental Workbench Preview over official Codex App Server process/spawn control. start creates a persistent host process/PTY and returns an opaque processRef plus receiptRef; poll returns new streamed stdout/stderr and exit state; write sends stdin; resize changes PTY rows/cols; kill terminates it. Use this lane for genuine host-process semantics that intentionally need host-visible state outside the sandboxed codex.command_exec lane. This includes explicitly requested Git repository-metadata work on an existing .git directory and authenticated host CLI work that depends on the local Windows credential store. When the task itself requires that host state, select this lane directly. Never use it merely to bypass a Codex permission/trust denial for ordinary project work, and never copy host credentials into the command_exec sandbox. A final exited poll retires the ref. If a later poll is unavailable before reaching Codexless, keep the original receiptRef and read codex.process_receipt after the process is expected to finish instead of replaying writes or starts. The receipt preserves the bounded terminal result while the runner remains alive." + processDescriptionSuffix,
      inputSchema: z.object({
        action: z.enum(["start", "poll", "write", "resize", "kill"]),
        command: z.array(z.string().max(32_768)).min(1).max(128).optional(),
        cwd: z.string().min(1).max(32_768).optional(),
        tty: z.boolean().optional(),
        rows: z.number().int().min(1).max(1000).optional(),
        cols: z.number().int().min(1).max(2000).optional(),
        timeoutMs: z.number().int().positive().max(86_400_000).nullable().optional(),
        processRef: z.string().min(1).max(256).optional(),
        text: z.string().max(2_000_000).optional(),
        closeStdin: z.boolean().optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => {
      if (input.action === "start" && directFormalCodexGuard) {
        const rejection = directFormalCodexGuard(input.command);
        if (rejection) {
          const error = new Error(rejection.message);
          error.code = "FORMAL_CODEX_AGENT_REQUIRED";
          error.nextActions = rejection.nextActions;
          throw error;
        }
      }
      return workbench.processAction(input);
    })
  );

  server.registerTool(
    "codex.process_receipt",
    {
      title: "Read Terminal Completion Receipt",
      description:
        "Read the bounded terminal completion receipt for a codex.process run after its processRef has exited or retired. receiptRef is returned at process start/final poll. The receipt preserves runner-alive final exit/stdout/stderr evidence for up to one hour (bounded to the newest 100 receipts) and does not keep the process alive or survive a Codexless runner restart.",
      inputSchema: z.object({
        receiptRef: z.string().min(1).max(256),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => structured(() => workbench.processReceipt(input))
  );

  server.registerTool(
    "codex.catalog",
    {
      title: "Codex Skills / Plugins / Apps / MCP Catalog",
      description:
        "Read Codex's current maintained capability catalogs instead of maintaining a parallel Codexless registry. kind=skills returns enabled Skill metadata for cwd; apps returns installed connector runtimes; plugins returns marketplace summary or filtered matches; mcp returns configured MCP server/tool inventory, optionally filtered by query.",
      inputSchema: z.object({
        kind: z.enum(["skills", "plugins", "apps", "mcp"]),
        cwd: z.string().min(1).max(32_768).optional(),
        query: z.string().max(32_768).default(""),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => workbench.catalog(input))
  );

  server.registerTool(
    "codex.skill_read",
    {
      title: "Read Current Codex Skill",
      description:
        "Resolve a Skill from Codex skills/list for cwd, then read the exact Skill Markdown path returned by Codex. Exact name is preferred; a unique substring is accepted. This supports lightweight catalog-first, content-on-demand project work.",
      inputSchema: z.object({
        name: z.string().min(1).max(1024),
        cwd: z.string().min(1).max(32_768).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => structured(() => workbench.readSkill(input))
  );

  server.registerTool(
    "codex.mcp_call",
    {
      title: "Call Configured Codex MCP Tool",
      description:
        "Experimental Workbench direct model-free call into a tool already configured/reachable through the same-machine Codex MCP runtime. server and tool must match Codex's current mcpServerStatus catalog. argumentsJson is a JSON object encoded as text and is decoded locally before calling Codex; metaJson is an optional JSON object encoded as text. This may have whatever side effects the selected underlying MCP tool has, so the current reasoning client must apply the same user-intent/confirmation discipline it would use for that tool directly.",
      inputSchema: z.object({
        server: z.string().min(1).max(1024),
        tool: z.string().min(1).max(2048),
        argumentsJson: z.string().max(2_000_000).default("{}"),
        cwd: z.string().min(1).max(32_768).optional(),
        metaJson: z.string().max(2_000_000).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ server, tool, argumentsJson, cwd, metaJson }) => structured(() => workbench.mcpCall({
      server,
      tool,
      arguments: parseJsonObject(argumentsJson, "argumentsJson"),
      cwd,
      meta: metaJson === undefined ? null : parseJsonObject(metaJson, "metaJson"),
    }))
  );
}

function parseJsonObject(value, fieldName) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${fieldName} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${fieldName} must encode a JSON object`);
  }
  return parsed;
}

async function structured(task) {
  try {
    const payload = await task();
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: false,
    };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (error && typeof error === "object" && typeof error.code === "string") payload.errorCode = error.code;
    if (error && typeof error === "object" && Array.isArray(error.nextActions)) payload.nextActions = error.nextActions;
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
}
