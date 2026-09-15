import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePinnedCodex } from "../../../../../runtime/safe-boot/codex-runtime.mjs";
import { CodexAgentExecutor } from "../src/codex-agent-executor.mjs";
import { managedLaunchEnv } from "../src/codex-runtime-provider.mjs";
import { readPreviewAccountPreflight } from "../src/codex-preview-account-preflight.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const codexBin = resolvePinnedCodex(root);
const codexHome = path.join(root, "accounts", "codex-a");
const authFile = path.join(codexHome, "auth.json");
const baseEnv = { ...process.env };
const launchEnv = managedLaunchEnv(baseEnv, codexHome);
const results = [];
const record = (name, ok, details = {}) => results.push({ name, ...details, ok: ok === true });
let executor = null;
try {
  record("identity.home", launchEnv.CODEX_HOME?.toLowerCase() === codexHome.toLowerCase(), { codexHome: launchEnv.CODEX_HOME });
  record("identity.auth-file", existsSync(authFile), { authFilePresent: existsSync(authFile) });
  record("identity.no-api-key", !launchEnv.OPENAI_API_KEY && !launchEnv.CODEX_API_KEY && !launchEnv.AZURE_OPENAI_API_KEY);
  const preflight = await readPreviewAccountPreflight({ codexBin, defaultCwd: root, launchEnv });
  record("account.chatgpt", preflight?.account?.status === "ok" && preflight.account.accountPresent === true && preflight.account.authMode === "chatgpt", {
    accountStatus: preflight?.account?.status ?? null,
    accountPresent: preflight?.account?.accountPresent ?? null,
    authMode: preflight?.account?.authMode ?? null,
    plan: preflight?.account?.plan ?? null,
  });
  record("quota.telemetry-advisory", true, { quotaStatus: preflight?.quota?.status ?? null, warning: preflight?.quota?.status === "unavailable" ? "quota telemetry unavailable; identity activation remains valid and live provider verification will preserve UNKNOWN if still unavailable" : null });
  executor = new CodexAgentExecutor({ codexBin, defaultCwd: root, launchEnv, requestTimeoutMs: 20_000 });
  const opened = await executor.open();
  record("app-server.open", executor.running === true, { initialized: Boolean(opened) });
  const catalog = await executor.listModels({ limit: 20, includeHidden: false });
  const ids = Array.isArray(catalog?.models) ? catalog.models.map((m) => m.model || m.id).filter(Boolean) : [];
  record("app-server.models", ids.length > 0, { count: ids.length, first: ids[0] ?? null });
} catch (error) {
  record("runtime.error", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  await executor?.close().catch(() => {});
}
const passed = results.filter((r) => r.ok).length;
const out = { gate: "codex-a-runtime", result: passed === results.length ? "PASS" : "FAIL", passed, total: results.length, results };
console.log(JSON.stringify(out, null, 2));
if (out.result !== "PASS") process.exitCode = 1;
