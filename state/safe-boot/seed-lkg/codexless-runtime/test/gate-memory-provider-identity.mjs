import fs from "node:fs";
import path from "node:path";
import { ExperienceMemory } from "../src/memory/index.mjs";

const dir = path.resolve("F:/SpikeBridge/tmp/memory-provider-identity-gate");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const memory = new ExperienceMemory({ dbPath: path.join(dir, "experience.db"), seed: false });
const results = [];
const record = (name, ok, details = {}) => results.push({ name, ...details, ok: ok === true });
try {
  memory.store.putItem({ id: "codex_common", kind: "fact", scope: "provider", provider: "codex", title: "CODEX_COMMON_SENTINEL", summary: "shared", confidence: "verified", status: "active" });
  memory.store.putItem({ id: "codex_a_only", kind: "fact", scope: "provider", provider: "codex-a", title: "CODEX_A_ONLY_SENTINEL", summary: "A", confidence: "verified", status: "active" });
  memory.store.putItem({ id: "codex_b_only", kind: "fact", scope: "provider", provider: "codex-b", title: "CODEX_B_ONLY_SENTINEL", summary: "B", confidence: "verified", status: "active" });
  const legacyMac = memory.store.putItem({ id: "legacy_workbee", kind: "fact", scope: "provider", provider: "workbee", title: "MAC_LEGACY_SENTINEL", summary: "mac", confidence: "verified", status: "active" });

  const ids = (provider, task) => memory.retrieve({ provider, task, limit: 20 }).items.map((x) => x.id);
  const a = ids("codex-a", "SENTINEL");
  const b = ids("codex-b", "SENTINEL");
  const generic = ids("codex", "SENTINEL");
  const z = ids("zcode", "SENTINEL");
  const mac = ids("mac", "SENTINEL");

  record("codex-a.common+specific", a.includes("codex_common") && a.includes("codex_a_only") && !a.includes("codex_b_only"), { a });
  record("codex-b.common+specific", b.includes("codex_common") && b.includes("codex_b_only") && !b.includes("codex_a_only"), { b });
  record("codex-generic.common-only", generic.includes("codex_common") && !generic.includes("codex_a_only") && !generic.includes("codex_b_only"), { generic });
  record("zcode.isolated", !z.includes("codex_common") && !z.includes("codex_a_only") && !z.includes("codex_b_only"), { z });
  record("workbee.canonicalized-to-mac", legacyMac.provider === "mac" && legacyMac.provider_family === "mac" && legacyMac.provider_id === "mac" && mac.includes("legacy_workbee"), { legacyMac, mac });

  const common = memory.store.getItem("codex_common");
  const onlyB = memory.store.getItem("codex_b_only");
  record("schema.family-common", common.provider_family === "codex" && common.provider_id === null, { common });
  record("schema.id-specific", onlyB.provider_family === "codex" && onlyB.provider_id === "codex-b", { onlyB });
} finally {
  memory.close();
}
const passed = results.filter((r) => r.ok).length;
const out = { gate: "memory-provider-identity", result: passed === results.length ? "PASS" : "FAIL", passed, total: results.length, results };
console.log(JSON.stringify(out, null, 2));
if (out.result !== "PASS") process.exitCode = 1;
