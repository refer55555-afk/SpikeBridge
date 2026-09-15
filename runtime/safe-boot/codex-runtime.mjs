import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readLocalConfig(root) {
  const file = path.join(root, "config", "local.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { if (error?.code === "ENOENT") return {}; throw error; }
}

export function resolvePinnedCodex(projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")) {
  const configured = process.env.CODEX_BIN?.trim() || readLocalConfig(projectRoot).codexBin;
  if (typeof configured !== "string" || !configured.trim()) {
    throw new Error("Codex executable is not configured. Run bootstrap/setup.ps1 or set CODEX_BIN.");
  }
  const resolved = path.resolve(configured.trim());
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Configured Codex executable does not exist: ${resolved}`);
  return resolved;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(resolvePinnedCodex(process.argv[2])); }
  catch (error) { process.stderr.write(`Spike Bridge Codex unavailable: ${error.message}\n`); process.exitCode = 1; }
}