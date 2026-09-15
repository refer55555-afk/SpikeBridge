const CHROME_SKILL_NAME = "chrome:control-chrome";
const NODE_REPL_SERVER = "node_repl";
const NODE_REPL_TOOL = "js";

export class CodexPublicBrowserWorkbenchAdapter {
  #context;
  #runtimeCwd;

  constructor({ context, runtimeCwd = null }) {
    if (!context) throw new Error("CodexPublicBrowserWorkbenchAdapter requires public context");
    if (runtimeCwd !== null && (typeof runtimeCwd !== "string" || !runtimeCwd.trim())) {
      throw new Error("runtimeCwd must be null or a non-empty string");
    }
    this.#context = context;
    this.#runtimeCwd = runtimeCwd;
  }

  #cwd(requestedCwd) {
    return requestedCwd ?? this.#runtimeCwd;
  }

  get generation() {
    return Number.isInteger(this.#context.generation) ? this.#context.generation : 0;
  }

  async catalog({ kind, cwd }) {
    const prerequisite = await this.#context.browserPrerequisites({ cwd: this.#cwd(cwd) });
    if (kind === "skills") {
      return {
        skills: prerequisite.chromeSkillPath
          ? [{ name: CHROME_SKILL_NAME, path: prerequisite.chromeSkillPath, enabled: true }]
          : [],
      };
    }
    if (kind === "mcp") {
      return {
        servers: [{
          name: NODE_REPL_SERVER,
          tools: prerequisite.nodeRepl ? [{ name: NODE_REPL_TOOL }] : [],
          error: prerequisite.nodeReplError ?? (prerequisite.status === "ok" ? null : prerequisite.reason ?? null),
        }],
      };
    }
    throw new Error(`unsupported Browser adapter catalog kind: ${String(kind)}`);
  }

  async currentChromePlugin({ cwd }) {
    const effectiveCwd = this.#cwd(cwd);
    if (typeof this.#context.currentChromePlugin === "function") {
      return this.#context.currentChromePlugin({ cwd: effectiveCwd });
    }
    const prerequisite = await this.#context.browserPrerequisites({ cwd: effectiveCwd });
    return prerequisite.chromePluginBuild
      ? { status: "ok", localVersion: prerequisite.chromePluginBuild, source: prerequisite.chromePluginSource ?? "codex-plugin-list" }
      : null;
  }

  async mcpCall({ server, tool, cwd, arguments: args = {}, meta = null, expectedGeneration = null }) {
    if (server !== NODE_REPL_SERVER || tool !== NODE_REPL_TOOL) {
      throw new Error("Codexless Browser adapter only exposes node_repl/js to the accepted Browser implementation");
    }
    try {
      return await this.#context.nodeReplCall({ cwd: this.#cwd(cwd), arguments: args, meta, expectedGeneration });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/PUBLIC_CONTEXT_GENERATION_STALE/i.test(message)) {
        throw new Error(`WORKBENCH_GENERATION_STALE:${message}`);
      }
      throw error;
    }
  }
}
