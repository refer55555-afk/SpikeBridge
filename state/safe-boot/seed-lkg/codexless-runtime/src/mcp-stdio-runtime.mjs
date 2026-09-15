import { createRequire } from "node:module";
import { createCodexlessRuntime } from "./codexless-runtime.mjs";

const require = createRequire(import.meta.url);
const { serveStdio } = require("@modelcontextprotocol/server/stdio");

const runtime = await createCodexlessRuntime();
const handle = serveStdio(runtime.createServer, {
  legacy: "serve",
  onerror: (error) => console.error("[mcp]", error),
});

const runtimeLabel = runtime.mode === "public"
  ? "Codexless public"
  : runtime.mode === "household"
    ? "Codexless household"
    : "Codexless Workbench";

console.error(
  `${runtimeLabel} running; ` +
  `defaultCwd=${runtime.authorityValidation.defaultCwd ?? "none"}; ` +
  `profile=${runtime.authorityValidation.profileOverride ?? "codex-resolved"}; ` +
  `consent=${runtime.meteredConsentMode}; ` +
  `cua=${runtime.cuaValidation ? `${runtime.cuaValidation.codexVersion}/${runtime.cuaValidation.skyVersion}` : "off"}; ` +
  `surface=${runtime.surfaceVersion}`
);

let shutdownPromise = null;
function shutdown() {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      try {
        await handle.close();
      } finally {
        await runtime.close();
      }
    })();
  }
  return shutdownPromise;
}

function shutdownAndExit() {
  void shutdown().finally(() => process.exit(0));
}

process.once("SIGINT", shutdownAndExit);
process.once("SIGTERM", shutdownAndExit);
process.stdin.once("end", shutdownAndExit);
process.stdin.once("close", shutdownAndExit);
