import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

export function registerPublicTools(server, { workbench }) {
  if (!workbench) return;

  server.registerTool(
    "codex.skill_list",
    {
      title: "List Current Codex Skills",
      description:
        "List enabled Codex Skills for the current project context through Codex's maintained skills catalog. This public Codexless tool is intentionally Skills-only: it does not expose the broader Workbench plugin, app, or MCP inventories. Use codex.skill_read to read one selected Skill after discovery.",
      inputSchema: z.object({
        cwd: z.string().min(1).max(32_768).optional(),
        query: z.string().max(32_768).default(""),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ cwd, query }) => structured(() => workbench.catalog({ kind: "skills", cwd, query }))
  );
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
    if (typeof error?.code === "string") payload.errorCode = error.code;
    if (Array.isArray(error?.nextActions)) payload.nextActions = error.nextActions;
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
}
