import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const BOOTSTRAP_POINTER_VERSION = 1;
export const BOOTSTRAP_LAUNCHER_VERSION = 1;
export const BOOTSTRAP_GENERATION_FILES = Object.freeze([
  "scripts/bootstrap.mjs",
  "scripts/bootstrap-archive.ps1",
  "scripts/bootstrap-archive.sh",
  "src/bootstrap-updater.mjs",
  "src/bootstrap-archive.mjs",
  "src/bootstrap-persistence.mjs",
  "src/release-discovery.mjs",
  "src/platform-support.mjs",
  "src/release-identity.mjs",
  "src/lifecycle-contract.mjs",
]);

export class BootstrapPersistenceError extends Error {
  constructor(message, { code = "BOOTSTRAP_PERSISTENCE_ERROR", stage = "bootstrap-persistence" } = {}) {
    super(message);
    this.name = "BootstrapPersistenceError";
    this.code = code;
    this.stage = stage;
  }
}

export function defaultBootstrapRoot(home = os.homedir()) {
  return path.join(path.resolve(requireString(home, "home")), ".config", "codexless", "bootstrap");
}

export async function materializeInitialBootstrap({ sourceRoot, bootstrapRoot = defaultBootstrapRoot(), buildId } = {}) {
  const root = path.resolve(requireString(bootstrapRoot, "bootstrapRoot"));
  const source = path.resolve(requireString(sourceRoot, "sourceRoot"));
  const generation = requireBuildId(buildId);
  await mkdir(root, { recursive: true });
  const existingPointer = await readBootstrapPointer(root, { optional: true });
  if (existingPointer) {
    await ensureStableLauncher(root);
    return existingPointer;
  }
  const prepared = await prepareBootstrapGeneration({ sourceRoot: source, bootstrapRoot: root, buildId: generation });
  return commitBootstrapGeneration({ bootstrapRoot: root, prepared });
}

export async function prepareBootstrapGeneration({ sourceRoot, bootstrapRoot = defaultBootstrapRoot(), buildId } = {}) {
  const source = path.resolve(requireString(sourceRoot, "sourceRoot"));
  const root = path.resolve(requireString(bootstrapRoot, "bootstrapRoot"));
  const generation = requireBuildId(buildId);
  await mkdir(root, { recursive: true });
  const finalDir = path.join(root, "generations", generation);
  if (await existsDirectory(finalDir)) {
    return { buildId: generation, pendingDir: null, finalDir, reused: true };
  }
  const pendingDir = path.join(root, `.pending-${generation.slice(0, 12)}-${randomUUID()}`);
  await mkdir(pendingDir, { recursive: false });
  try {
    for (const relative of BOOTSTRAP_GENERATION_FILES) {
      const from = path.join(source, ...relative.split("/"));
      const to = path.join(pendingDir, ...relative.split("/"));
      const info = await stat(from);
      if (!info.isFile()) throw persistenceError(`bootstrap source file is not a regular file: ${relative}`, "BOOTSTRAP_SOURCE_INVALID");
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
    }
    await writeFile(path.join(pendingDir, "generation.json"), `${JSON.stringify({
      pointerVersion: BOOTSTRAP_POINTER_VERSION,
      buildId: generation,
      files: BOOTSTRAP_GENERATION_FILES,
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { buildId: generation, pendingDir, finalDir, reused: false };
  } catch (error) {
    await rm(pendingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function commitBootstrapGeneration({ bootstrapRoot = defaultBootstrapRoot(), prepared } = {}) {
  const root = path.resolve(requireString(bootstrapRoot, "bootstrapRoot"));
  if (!prepared || typeof prepared !== "object") throw persistenceError("prepared bootstrap generation is required", "BOOTSTRAP_PREPARED_INVALID");
  const buildId = requireBuildId(prepared.buildId);
  const finalDir = path.join(root, "generations", buildId);
  const existingPointer = await readBootstrapPointer(root, { optional: true });
  if (existingPointer?.buildId === buildId && await existsDirectory(finalDir)) {
    if (prepared.pendingDir && !prepared.reused) await discardPreparedBootstrap(prepared);
    await ensureStableLauncher(root);
    return existingPointer;
  }

  let createdFinal = false;
  if (!prepared.reused) {
    const pendingDir = validatePendingPath(root, prepared.pendingDir);
    await validatePreparedGeneration(pendingDir, buildId);
    await mkdir(path.dirname(finalDir), { recursive: true });
    try {
      await rename(pendingDir, finalDir);
      createdFinal = true;
    } catch (error) {
      if (!(await existsDirectory(finalDir))) throw error;
      await rm(pendingDir, { recursive: true, force: true }).catch(() => {});
    }
  } else if (!(await existsDirectory(finalDir))) {
    throw persistenceError("reused bootstrap generation is missing", "BOOTSTRAP_GENERATION_MISSING");
  }

  try {
    await validatePreparedGeneration(finalDir, buildId);
    await ensureStableLauncher(root);
    const pointer = { pointerVersion: BOOTSTRAP_POINTER_VERSION, buildId };
    await atomicWriteJson(path.join(root, "current.json"), pointer);
    return pointer;
  } catch (error) {
    if (createdFinal) await rm(finalDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function validatePreparedBootstrapGeneration({ bootstrapRoot = defaultBootstrapRoot(), prepared } = {}) {
  const root = path.resolve(requireString(bootstrapRoot, "bootstrapRoot"));
  if (!prepared || typeof prepared !== "object") throw persistenceError("prepared bootstrap generation is required", "BOOTSTRAP_PREPARED_INVALID");
  const buildId = requireBuildId(prepared.buildId);
  if (prepared.reused) {
    const finalDir = path.join(root, "generations", buildId);
    if (!(await existsDirectory(finalDir))) throw persistenceError("reused bootstrap generation is missing", "BOOTSTRAP_GENERATION_MISSING");
    await validatePreparedGeneration(finalDir, buildId);
    return { buildId, pendingDir: null, finalDir, reused: true };
  }
  const pendingDir = validatePendingPath(root, prepared.pendingDir);
  await validatePreparedGeneration(pendingDir, buildId);
  return { buildId, pendingDir, finalDir: path.join(root, "generations", buildId), reused: false };
}

export async function discardPreparedBootstrap(prepared) {
  if (!prepared?.pendingDir || prepared.reused) return false;
  const target = path.resolve(prepared.pendingDir);
  if (!path.basename(target).startsWith(".pending-")) throw persistenceError("refusing to discard non-pending bootstrap directory", "BOOTSTRAP_PREPARED_INVALID");
  await rm(target, { recursive: true, force: true });
  return true;
}

export async function readBootstrapPointer(bootstrapRoot = defaultBootstrapRoot(), { optional = false } = {}) {
  const root = path.resolve(requireString(bootstrapRoot, "bootstrapRoot"));
  try {
    const parsed = JSON.parse(await readFile(path.join(root, "current.json"), "utf8"));
    if (parsed?.pointerVersion !== BOOTSTRAP_POINTER_VERSION) throw persistenceError("unsupported bootstrap pointer version", "BOOTSTRAP_POINTER_INVALID");
    const buildId = requireBuildId(parsed.buildId);
    return { pointerVersion: BOOTSTRAP_POINTER_VERSION, buildId };
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    if (error instanceof BootstrapPersistenceError) throw error;
    throw persistenceError(`bootstrap pointer is unreadable: ${safeMessage(error)}`, "BOOTSTRAP_POINTER_INVALID");
  }
}

export async function resolveCurrentBootstrapEntry(bootstrapRoot = defaultBootstrapRoot()) {
  const root = path.resolve(requireString(bootstrapRoot, "bootstrapRoot"));
  const pointer = await readBootstrapPointer(root);
  const entry = path.join(root, "generations", pointer.buildId, "scripts", "bootstrap.mjs");
  const info = await stat(entry).catch(() => null);
  if (!info?.isFile()) throw persistenceError("current bootstrap generation entry is missing", "BOOTSTRAP_GENERATION_MISSING");
  return { ...pointer, entry };
}

async function validatePreparedGeneration(directory, buildId) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path.join(directory, "generation.json"), "utf8"));
  } catch (error) {
    throw persistenceError(`bootstrap generation metadata is unreadable: ${safeMessage(error)}`, "BOOTSTRAP_PREPARED_INVALID");
  }
  if (parsed?.pointerVersion !== BOOTSTRAP_POINTER_VERSION || parsed?.buildId !== buildId) {
    throw persistenceError("bootstrap generation metadata does not match target build", "BOOTSTRAP_PREPARED_INVALID");
  }
  if (!Array.isArray(parsed.files)
    || parsed.files.length !== BOOTSTRAP_GENERATION_FILES.length
    || parsed.files.some((value, index) => value !== BOOTSTRAP_GENERATION_FILES[index])) {
    throw persistenceError("bootstrap generation file contract is invalid", "BOOTSTRAP_PREPARED_INVALID");
  }
  for (const relative of BOOTSTRAP_GENERATION_FILES) {
    const info = await stat(path.join(directory, ...relative.split("/"))).catch(() => null);
    if (!info?.isFile()) throw persistenceError(`bootstrap generation file is missing: ${relative}`, "BOOTSTRAP_PREPARED_INVALID");
  }
  return true;
}

function validatePendingPath(root, pendingDir) {
  const target = path.resolve(requireString(pendingDir, "prepared.pendingDir"));
  const parent = path.dirname(target);
  const sameParent = process.platform === "win32"
    ? parent.toLowerCase() === root.toLowerCase()
    : parent === root;
  if (!sameParent || !path.basename(target).startsWith(".pending-")) {
    throw persistenceError("prepared bootstrap directory is outside bootstrap root", "BOOTSTRAP_PREPARED_INVALID");
  }
  return target;
}

async function ensureStableLauncher(root) {
  const launcher = path.join(root, "run.mjs");
  try {
    const existing = await readFile(launcher, "utf8");
    if (!existing.includes(`BOOTSTRAP_LAUNCHER_VERSION=${BOOTSTRAP_LAUNCHER_VERSION}`)) {
      throw persistenceError("existing bootstrap launcher has an unsupported protocol", "BOOTSTRAP_LAUNCHER_INCOMPATIBLE");
    }
    return launcher;
  } catch (error) {
    if (error instanceof BootstrapPersistenceError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  const body = [
    `// BOOTSTRAP_LAUNCHER_VERSION=${BOOTSTRAP_LAUNCHER_VERSION}`,
    'import { readFile } from "node:fs/promises";',
    'import path from "node:path";',
    'import { fileURLToPath, pathToFileURL } from "node:url";',
    'const root = path.dirname(fileURLToPath(import.meta.url));',
    'const pointer = JSON.parse(await readFile(path.join(root, "current.json"), "utf8"));',
    'if (pointer?.pointerVersion !== 1 || !/^[0-9a-f]{64}$/.test(String(pointer?.buildId ?? ""))) throw new Error("Codexless bootstrap pointer is invalid");',
    'const entry = path.join(root, "generations", pointer.buildId, "scripts", "bootstrap.mjs");',
    'await import(pathToFileURL(entry).href);',
    '',
  ].join("\n");
  await writeFile(launcher, body, { encoding: "utf8", flag: "wx" });
  return launcher;
}

async function atomicWriteJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function existsDirectory(target) {
  const info = await stat(target).catch(() => null);
  return Boolean(info?.isDirectory());
}

function requireBuildId(value) {
  const text = requireString(value, "buildId").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw persistenceError("bootstrap buildId must be SHA-256", "BOOTSTRAP_BUILD_ID_INVALID");
  return text;
}

function persistenceError(message, code) {
  return new BootstrapPersistenceError(message, { code });
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function safeMessage(error) {
  return String(error instanceof Error ? error.message : error ?? "bootstrap persistence error")
    .replace(/[A-Za-z]:\\[^\s]+/g, "<path>")
    .replace(/\/[^\s]+/g, "<path>")
    .slice(0, 500);
}
