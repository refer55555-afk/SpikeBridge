import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentProviderRegistry } from "../src/agent-provider-registry.mjs";
import { createCodexAgentProvider } from "../src/agent-providers/codex.mjs";
import { createZCodeAgentProvider } from "../src/agent-providers/zcode.mjs";
import { createMacProvider } from "../src/agent-providers/mac.mjs";
import { registerSpikeAgentTools } from "../src/spike-agent-tools.mjs";
import {
  resolveSpikeBridgeRoot,
  spikeAccountHome,
  spikeAgentTaskStateFile,
  spikeZCodeStateFile,
  spikeMacStateDir,
  spikeMacSecretFile,
  spikeMemoryDbFile,
} from "../src/spike-paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "src");
const root = resolveSpikeBridgeRoot({ env: { SPIKE_BRIDGE_ROOT: "C:\\Projects\\SpikeBridgeFixture" }, defaultCwd: "C:\\Wrong" });
const results = [];
const record = (name, ok, details = {}) => results.push({ name, ...details, ok: ok === true });

record("root.canonical", root.toLowerCase() === path.resolve("C:\\Projects\\SpikeBridgeFixture").toLowerCase(), { root });
record("paths.codex-a", spikeAccountHome(root, "codex-a").endsWith(path.join("accounts", "codex-a")));
record("paths.codex-b", spikeAccountHome(root, "codex-b").endsWith(path.join("accounts", "codex-b")));
record("paths.state-a", spikeAgentTaskStateFile(root, "codex-a").endsWith(path.join("state", "agents", "codex-a", "agent-task-cards.json")));
record("paths.state-b", spikeAgentTaskStateFile(root, "codex-b").endsWith(path.join("state", "agents", "codex-b", "agent-task-cards.json")));
record("paths.zcode", spikeZCodeStateFile(root).endsWith(path.join("state", "agents", "zcode", "jobs.json")));
record("paths.mac-state", spikeMacStateDir(root).endsWith(path.join("state", "agents", "mac")));
record("paths.mac-secret", spikeMacSecretFile(root).endsWith(path.join("secrets", "mac", "pairing.secret")));
record("paths.memory", spikeMemoryDbFile(root).endsWith(path.join("data", "memory", "experience.db")));

const emptyHandlers = () => new Map();
const fakeExecutor = { running: true };
const registry = createAgentProviderRegistry({ providers: [
  createCodexAgentProvider({ id: "codex", displayName: "Codex A", handlers: emptyHandlers(), agentExecutor: fakeExecutor, defaultCwd: root, formalAgentAvailable: true }),
  createCodexAgentProvider({ id: "codex-a", displayName: "Codex A", handlers: emptyHandlers(), agentExecutor: fakeExecutor, defaultCwd: root, formalAgentAvailable: true }),
  createCodexAgentProvider({ id: "codex-b", displayName: "Codex B", handlers: emptyHandlers(), agentExecutor: fakeExecutor, defaultCwd: root, formalAgentAvailable: true }),
  createZCodeAgentProvider({ defaultCwd: root, bridgeRoot: root, stateFile: spikeZCodeStateFile(root), legacyStateFile: path.join(root, "state", "agent-providers", "zcode-jobs.json") }),
  createMacProvider({ defaultCwd: root, bridgeRoot: root, secretFile: path.join(root, "secrets", "mac", "pairing.secret") }),
] });
const ids = registry.ids();
record("providers.primary", ["codex", "codex-a", "codex-b", "zcode", "mac"].every((id) => ids.includes(id)), { ids });
record("providers.no-workbee", !ids.includes("workbee"), { ids });
record("providers.mac-label", registry.get("mac")?.displayName === "Mac");
record("providers.codex-labels", registry.get("codex")?.displayName === "Codex A" && registry.get("codex-a")?.displayName === "Codex A" && registry.get("codex-b")?.displayName === "Codex B");

const toolNames = [];
const toolDefs = new Map();
const fakeServer = {
  registerResource() {},
  registerTool(name, definition) { toolNames.push(name); toolDefs.set(name, definition); },
};
registerSpikeAgentTools(fakeServer, { registry });
toolNames.sort();
const expectedTools = ["spike.agent_cancel", "spike.agent_send", "spike.agent_start", "spike.agent_status"];
record("tools.exact-four", JSON.stringify(toolNames) === JSON.stringify(expectedTools), { toolNames });
record("tools.retired-show-absent", !toolNames.includes("spike.agent_show"), { toolNames });
const startMeta = toolDefs.get("spike.agent_start")?._meta ?? {};
const statusMeta = toolDefs.get("spike.agent_status")?._meta ?? {};
record("tools.single-ui-owner", startMeta?.ui?.resourceUri === "ui://spike/agent-card-v4.html"
  && startMeta?.["openai/outputTemplate"] === "ui://spike/agent-card-v4.html"
  && !statusMeta?.ui?.resourceUri && !statusMeta?.["openai/outputTemplate"], { startMeta, statusMeta });

const runtimeSource = readFileSync(path.join(src, "codexless-runtime.mjs"), "utf8");
record("runtime.codex-b-isolated-home", runtimeSource.includes('spikeAccountHome(bridgeRoot, "codex-b")') && runtimeSource.includes("codexBLaunchEnv") && runtimeSource.includes("codexBExecutor = new CodexAgentExecutor"));
record("runtime.codex-b-own-state", runtimeSource.includes('spikeAgentTaskStateFile(bridgeRoot, "codex-b")'));
record("runtime.mac-primary", runtimeSource.includes("createMacProvider({ defaultCwd, bridgeRoot })") && !runtimeSource.includes("createWorkBeeProvider({ defaultCwd"));
record("runtime.zcode-canonical-state", runtimeSource.includes("spikeZCodeStateFile(bridgeRoot)"));

const zcodeSource = readFileSync(path.join(src, "agent-providers", "zcode.mjs"), "utf8");
record("zcode.external-runtime-preserved", zcodeSource.includes('"E:\\\\zcode\\\\resources\\\\glm\\\\zcode.cjs"'));
const macSource = readFileSync(path.join(src, "agent-providers", "workbee.mjs"), "utf8");
record("mac.compat-only-workbee", macSource.includes("export const createWorkBeeProvider = createMacProvider") && macSource.includes('id: "mac"'));

const passed = results.filter((r) => r.ok).length;
const out = { gate: "provider-layout", result: passed === results.length ? "PASS" : "FAIL", passed, total: results.length, results };
console.log(JSON.stringify(out, null, 2));
if (out.result !== "PASS") process.exitCode = 1;
