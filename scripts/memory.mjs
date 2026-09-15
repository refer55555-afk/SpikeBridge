#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const runtimeRoot = path.join(root, "state", "safe-boot", "seed-lkg", "codexless-runtime");
const { ExperienceMemory } = await import(pathToFileURL(path.join(runtimeRoot, "src", "memory", "index.mjs")).href);

function usage() {
  console.error(`Usage:
  node scripts/memory.mjs status
  node scripts/memory.mjs search "<query>" [provider] [project]
  node scripts/memory.mjs inspect <id>
  node scripts/memory.mjs rule --title "<title>" --summary "<summary>" [--scope global|machine|provider|project|tool] [--provider <id>] [--project <path>] [--tool <name>] [--core] [--evidence-ref <ref>] [--tags a,b,c]
  node scripts/memory.mjs compact [--vacuum]
  node scripts/memory.mjs forget <id>
  node scripts/memory.mjs export`);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function option(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (name === "--core") return true;
  return args[index + 1] ?? fallback;
}

const [command, ...args] = process.argv.slice(2);
if (!command || ["-h", "--help", "help"].includes(command)) {
  usage();
  process.exit(command ? 0 : 2);
}

const memory = new ExperienceMemory({ seed: true });
try {
  if (!memory.enabled) {
    print({ result: "BLOCKED", error: memory.status().initError, dbPath: memory.status().dbPath });
    process.exitCode = 1;
  } else if (command === "status") {
    print({ result: "PASS", ...memory.status() });
  } else if (command === "search") {
    const query = args[0];
    if (!query) throw new Error("search requires a query");
    const provider = args[1] || null;
    const project = args[2] || null;
    const items = memory.search(query, { provider, project, limit: 50 }).map((item) => ({
      id: item.id,
      kind: item.kind,
      scope: item.scope,
      provider: item.provider,
      project: item.project,
      tool: item.tool,
      title: item.title,
      trigger: item.trigger,
      summary: item.summary,
      failed_approach: item.failed_approach,
      root_cause: item.root_cause,
      verified_fix: item.verified_fix,
      do_not_retry: item.do_not_retry,
      error_signature: item.error_signature,
      confidence: item.confidence,
      status: item.status,
      evidence_ref: item.evidence_ref,
      last_verified_at: item.last_verified_at,
      last_used_at: item.last_used_at,
      use_count: item.use_count,
      _memoryScore: item._memoryScore,
    }));
    print({ result: "PASS", query, count: items.length, items });
  } else if (command === "inspect") {
    const id = args[0];
    if (!id) throw new Error("inspect requires a memory id");
    const inspected = memory.inspect(id);
    if (!inspected) {
      print({ result: "NOT_FOUND", id });
      process.exitCode = 1;
    } else print({ result: "PASS", ...inspected });
  } else if (command === "rule") {
    const title = option("--title");
    const summary = option("--summary");
    if (!title || !summary) throw new Error("rule requires --title and --summary");
    const tagsRaw = option("--tags", "");
    const item = memory.write({
      type: "rule",
      title,
      summary,
      scope: option("--scope", "global"),
      provider: option("--provider"),
      project: option("--project"),
      tool: option("--tool"),
      core: Boolean(option("--core", false)),
      evidence_ref: option("--evidence-ref"),
      tags: tagsRaw ? tagsRaw.split(",").map((value) => value.trim()).filter(Boolean) : [],
    });
    print({ result: "PASS", item });
  } else if (command === "compact") {
    print({ result: "PASS", ...memory.compact({ vacuum: args.includes("--vacuum") }) });
  } else if (command === "forget") {
    const id = args[0];
    if (!id) throw new Error("forget requires a memory id");
    const deleted = memory.forget(id);
    print({ result: deleted ? "PASS" : "NOT_FOUND", id, deleted });
    if (!deleted) process.exitCode = 1;
  } else if (command === "export") {
    print({ result: "PASS", ...memory.exportSanitized() });
  } else {
    usage();
    throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  print({ result: "FAIL", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  memory.close();
}

