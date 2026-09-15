import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateReleaseManifest } from "./release-identity.mjs";

export const DEFAULT_ARCHIVE_MAX_ENTRIES = 5_000;
export const DEFAULT_ARCHIVE_MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
export const DEFAULT_ARCHIVE_LIST_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_ARCHIVE_COMMAND_TIMEOUT_MS = 30_000;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "..");
const windowsArchiveHelper = path.join(projectRoot, "scripts", "bootstrap-archive.ps1");
const macArchiveHelper = path.join(projectRoot, "scripts", "bootstrap-archive.sh");
const SAFE_ENTRY_PATH = /^[A-Za-z0-9._/-]+$/;
const SAFE_ENTRY_TYPES = new Set(["file", "directory"]);

export class BootstrapArchiveError extends Error {
  constructor(message, { code = "ARCHIVE_ERROR", stage = "extraction" } = {}) {
    super(message);
    this.name = "BootstrapArchiveError";
    this.code = code;
    this.stage = stage;
  }
}

export function expectedReleaseRootName(version) {
  const value = requireString(version, "release version");
  if (!/^[0-9A-Za-z.-]+$/.test(value)) throw archiveError("release version cannot form a safe archive root", "ARCHIVE_ROOT_INVALID");
  return `codexless-${value}`;
}

export function validateArchiveEntries(entries, {
  platform,
  expectedRoot,
  maxEntries = DEFAULT_ARCHIVE_MAX_ENTRIES,
  maxExpandedBytes = DEFAULT_ARCHIVE_MAX_EXPANDED_BYTES,
} = {}) {
  if (!Array.isArray(entries)) throw archiveError("archive entry list must be an array", "ARCHIVE_LIST_INVALID");
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be positive");
  if (!Number.isInteger(maxExpandedBytes) || maxExpandedBytes < 1) throw new Error("maxExpandedBytes must be positive");
  if (entries.length > maxEntries) throw archiveError("archive has too many entries", "ARCHIVE_TOO_MANY_ENTRIES");
  const root = validateArchivePath(requireString(expectedRoot, "expected archive root"), { allowDirectorySuffix: false });
  const caseInsensitive = platform === "win32";
  const seen = new Set();
  let expandedBytes = 0;
  let sawRoot = false;

  const normalized = entries.map((raw) => {
    const type = requireString(raw?.type, "archive entry type").toLowerCase();
    if (!SAFE_ENTRY_TYPES.has(type)) {
      const code = type === "symlink" ? "ARCHIVE_SYMLINK_REJECTED"
        : type === "hardlink" ? "ARCHIVE_HARDLINK_REJECTED"
          : "ARCHIVE_SPECIAL_ENTRY_REJECTED";
      throw archiveError(`archive entry type is not allowed: ${type}`, code);
    }
    const entryPath = validateArchivePath(raw?.path, { allowDirectorySuffix: type === "directory" });
    const collisionPath = entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath;
    const comparable = caseInsensitive ? collisionPath.toLowerCase() : collisionPath;
    if (seen.has(comparable)) {
      throw archiveError(caseInsensitive ? "archive contains duplicate or case-colliding paths" : "archive contains duplicate paths", caseInsensitive ? "ARCHIVE_CASE_COLLISION" : "ARCHIVE_DUPLICATE_ENTRY");
    }
    seen.add(comparable);
    const size = Number(raw?.size ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) throw archiveError("archive entry size is invalid", "ARCHIVE_LIST_INVALID");
    if (type === "directory" && size !== 0) throw archiveError("archive directory entry has non-zero size", "ARCHIVE_LIST_INVALID");
    expandedBytes += size;
    if (expandedBytes > maxExpandedBytes) throw archiveError("archive expanded bytes exceed limit", "ARCHIVE_EXPANDED_TOO_LARGE");

    const rootPath = entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath;
    if (rootPath === root) sawRoot = true;
    else if (!rootPath.startsWith(`${root}/`)) {
      throw archiveError("archive contains payload outside the expected release root", "ARCHIVE_SIBLING_PAYLOAD");
    }
    return { path: entryPath, type, size };
  });

  if (!sawRoot && !normalized.some((entry) => entry.path.startsWith(`${root}/`))) {
    throw archiveError("archive does not contain expected release root", "ARCHIVE_ROOT_MISSING");
  }
  return { entries: normalized, expandedBytes, expectedRoot: root };
}

export async function extractVerifiedReleaseArtifact({
  artifactPath,
  expectedSha256,
  version,
  platform = process.platform,
  arch = process.arch,
  stagingBase = os.tmpdir(),
  maxEntries = DEFAULT_ARCHIVE_MAX_ENTRIES,
  maxExpandedBytes = DEFAULT_ARCHIVE_MAX_EXPANDED_BYTES,
  commandTimeoutMs = DEFAULT_ARCHIVE_COMMAND_TIMEOUT_MS,
} = {}) {
  const artifact = path.resolve(requireString(artifactPath, "artifactPath"));
  const digest = requireSha256(expectedSha256, "expectedSha256");
  const rootName = expectedReleaseRootName(version);
  assertPlatformArchive(platform, arch, artifact);
  if (await sha256File(artifact) !== digest) throw archiveError("verified artifact bytes changed before extraction", "ARTIFACT_DIGEST_DRIFT");

  const stageParent = path.resolve(requireString(stagingBase, "stagingBase"));
  await mkdir(stageParent, { recursive: true });
  const stageDir = await mkdtemp(path.join(stageParent, "codexless-bootstrap-stage-"));
  try {
    const entries = platform === "win32"
      ? await listWindowsZip(artifact, commandTimeoutMs)
      : await listMacTarGz(artifact, commandTimeoutMs);
    validateArchiveEntries(entries, { platform, expectedRoot: rootName, maxEntries, maxExpandedBytes });
    if (await sha256File(artifact) !== digest) throw archiveError("artifact bytes changed after archive validation", "ARTIFACT_DIGEST_DRIFT");

    if (platform === "win32") await extractWindowsZip(artifact, stageDir, commandTimeoutMs);
    else await extractMacTarGz(artifact, stageDir, commandTimeoutMs);

    if (await sha256File(artifact) !== digest) throw archiveError("artifact bytes changed during extraction", "ARTIFACT_DIGEST_DRIFT");
    const releaseRoot = path.join(stageDir, rootName);
    await validateExtractedTree(stageDir, releaseRoot, { platform, maxEntries, maxExpandedBytes });
    const internalManifestPath = path.join(releaseRoot, "config", "release-manifest.json");
    let internalManifestRaw;
    let internalManifest;
    try {
      internalManifestRaw = await readFile(internalManifestPath, "utf8");
      internalManifest = validateReleaseManifest(JSON.parse(internalManifestRaw));
    } catch (error) {
      throw archiveError(`staged internal release manifest is invalid: ${safeMessage(error)}`, "INTERNAL_MANIFEST_INVALID", "manifest-match");
    }
    if (internalManifest.version !== version) throw archiveError("staged internal manifest version does not match selected release", "INTERNAL_MANIFEST_VERSION_MISMATCH", "manifest-match");
    return { stageDir, releaseRoot, internalManifest, internalManifestRaw };
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    throw error instanceof BootstrapArchiveError ? error : archiveError(safeMessage(error), "ARCHIVE_EXTRACTION_FAILED");
  }
}

export async function cleanupExtractedRelease(stageDir) {
  if (!stageDir) return false;
  const resolved = path.resolve(stageDir);
  if (!path.basename(resolved).startsWith("codexless-bootstrap-stage-")) throw archiveError("refusing to clean non-bootstrap staging directory", "INVALID_STAGING_PATH");
  await rm(resolved, { recursive: true, force: true });
  return true;
}

export function parseMacTarListing(listText, namesText) {
  const lines = String(listText ?? "").split(/\r?\n/).filter(Boolean);
  const names = String(namesText ?? "").split(/\r?\n/).filter(Boolean);
  if (lines.length !== names.length) throw archiveError("tar listing/name count mismatch", "ARCHIVE_LIST_INVALID");
  return lines.map((line, index) => {
    const name = names[index];
    const marker = line[0];
    let type;
    if (marker === "-") type = "file";
    else if (marker === "d") type = "directory";
    else if (marker === "l") type = "symlink";
    else if (marker === "h") type = "hardlink";
    else type = "special";
    const metadata = line.match(/^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+/);
    if (!metadata) throw archiveError("tar verbose listing format is unsupported", "ARCHIVE_LIST_INVALID");
    const size = type === "file" ? Number(metadata[1]) : 0;
    return { path: name, type, size };
  });
}

function validateArchivePath(value, { allowDirectorySuffix = false } = {}) {
  const text = requireString(value, "archive entry path").replace(/\\/g, "/").normalize("NFC");
  if (text.includes("\0")) throw archiveError("archive path contains NUL", "ARCHIVE_PATH_INVALID");
  if (text.startsWith("/") || /^[/\\]{2}/.test(text) || /^[A-Za-z]:/.test(text)) throw archiveError("absolute/drive/UNC archive path is not allowed", "ARCHIVE_ABSOLUTE_PATH");
  if (!SAFE_ENTRY_PATH.test(text)) throw archiveError("archive path contains unsupported characters", "ARCHIVE_PATH_INVALID");
  const hadSlash = text.endsWith("/");
  const parts = text.split("/").filter((part) => part.length > 0);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) throw archiveError("archive traversal path is not allowed", "ARCHIVE_TRAVERSAL");
  const normalized = parts.join("/");
  return allowDirectorySuffix && hadSlash ? `${normalized}/` : normalized;
}

async function listWindowsZip(artifact, timeoutMs) {
  const result = await runCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", windowsArchiveHelper, "-Action", "list", "-Archive", artifact], { timeoutMs });
  let parsed;
  try { parsed = JSON.parse(result.stdout || "[]"); } catch { throw archiveError("Windows ZIP listing is malformed", "ARCHIVE_LIST_INVALID"); }
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function extractWindowsZip(artifact, destination, timeoutMs) {
  await runCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", windowsArchiveHelper, "-Action", "extract", "-Archive", artifact, "-Destination", destination], { timeoutMs, maxOutputBytes: 64 * 1024 });
}

async function listMacTarGz(artifact, timeoutMs) {
  const list = await runCommand("/bin/sh", [macArchiveHelper, "list", artifact], { timeoutMs });
  const names = await runCommand("/bin/sh", [macArchiveHelper, "names", artifact], { timeoutMs });
  return parseMacTarListing(list.stdout, names.stdout);
}

async function extractMacTarGz(artifact, destination, timeoutMs) {
  await runCommand("/bin/sh", [macArchiveHelper, "extract", artifact, destination], { timeoutMs, maxOutputBytes: 64 * 1024 });
}

async function validateExtractedTree(stageDir, releaseRoot, { platform, maxEntries, maxExpandedBytes }) {
  const stageEntries = await readdir(stageDir, { withFileTypes: true });
  if (stageEntries.length !== 1 || stageEntries[0].name !== path.basename(releaseRoot) || !stageEntries[0].isDirectory()) {
    throw archiveError("staging directory must contain exactly one expected release root", "ARCHIVE_SIBLING_PAYLOAD");
  }
  let entries = 0;
  let bytes = 0;
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      entries += 1;
      if (entries > maxEntries) throw archiveError("extracted tree has too many entries", "ARCHIVE_TOO_MANY_ENTRIES");
      const target = path.join(current, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw archiveError("extracted tree contains symlink", "ARCHIVE_SYMLINK_REJECTED");
      if (info.isDirectory()) await walk(target);
      else if (info.isFile()) {
        bytes += info.size;
        if (bytes > maxExpandedBytes) throw archiveError("extracted tree exceeds expanded byte limit", "ARCHIVE_EXPANDED_TOO_LARGE");
      } else throw archiveError("extracted tree contains special entry", "ARCHIVE_SPECIAL_ENTRY_REJECTED");
    }
  }
  await walk(releaseRoot);
  if (platform === "win32") await assertNoCaseCollisions(releaseRoot);
}

async function assertNoCaseCollisions(root) {
  const seen = new Set();
  async function walk(current, prefix = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const key = relative.normalize("NFC").toLowerCase();
      if (seen.has(key)) throw archiveError("extracted tree has Windows case collision", "ARCHIVE_CASE_COLLISION");
      seen.add(key);
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative);
    }
  }
  await walk(root);
}

async function sha256File(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

function assertPlatformArchive(platform, arch, artifact) {
  const lower = artifact.toLowerCase();
  if (platform === "win32" && arch === "x64" && lower.endsWith(".zip")) return;
  if (platform === "darwin" && arch === "arm64" && lower.endsWith(".tar.gz")) return;
  throw archiveError(`unsupported bootstrap artifact platform: ${platform}/${arch}`, "UNSUPPORTED_PLATFORM");
}

async function runCommand(command, args, { timeoutMs, maxOutputBytes = DEFAULT_ARCHIVE_LIST_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(archiveError("archive helper timed out", "ARCHIVE_HELPER_TIMEOUT"));
    }, timeoutMs);
    const append = (current, chunk) => {
      const next = Buffer.concat([current, Buffer.from(chunk)]);
      if (next.length > maxOutputBytes) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill();
          reject(archiveError("archive helper output exceeded limit", "ARCHIVE_LIST_TOO_LARGE"));
        }
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(archiveError(`archive helper failed: ${safeMessage(error)}`, "ARCHIVE_HELPER_FAILED"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(archiveError(`archive helper exited ${code}: ${safeMessage(stderr.toString("utf8"))}`, "ARCHIVE_HELPER_FAILED"));
      resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    });
  });
}

function archiveError(message, code, stage = "extraction") {
  return new BootstrapArchiveError(message, { code, stage });
}

function requireSha256(value, label) {
  const text = requireString(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${label} must be SHA-256 hex`);
  return text;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function safeMessage(error) {
  return String(error instanceof Error ? error.message : error ?? "archive error")
    .replace(/[A-Za-z]:\\[^\s]+/g, "<path>")
    .replace(/\/[^\s]+/g, "<path>")
    .slice(0, 500);
}
