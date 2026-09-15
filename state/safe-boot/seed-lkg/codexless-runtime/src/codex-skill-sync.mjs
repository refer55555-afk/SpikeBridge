import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultManagedCodexHome } from "./codex-runtime-provider.mjs";

export const CODEXLESS_BROWSER_REPAIR_SKILL = "codexless-browser-repair";
export const CODEXLESS_MANAGED_SKILL_MARKER = ".codexless-managed-skill.json";
export const CODEXLESS_MANAGED_SKILL_SCHEMA = 1;
export const CODEXLESS_SKILL_TRANSACTION_SCHEMA = 1;
export const CODEXLESS_BROWSER_REPAIR_TARGET_LANE = "existing";

const TRANSACTION_PREFIX = `.${CODEXLESS_BROWSER_REPAIR_SKILL}.txn-`;
const TRANSACTION_STATE_FILE = "transaction.json";
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "..");

export class CodexSkillSyncError extends Error {
  constructor(message, { code, stage }) {
    super(message);
    this.name = "CodexSkillSyncError";
    this.code = code;
    this.stage = stage;
  }
}

export function defaultCodexHome(env = process.env) {
  const explicit = typeof env?.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  return path.resolve(explicit || path.join(os.homedir(), ".codex"));
}

export function defaultBrowserRepairSkillSource() {
  return path.join(projectRoot, "skills", CODEXLESS_BROWSER_REPAIR_SKILL);
}

export function checkBrowserRepairSkill({
  codexHome = defaultCodexHome(),
  sourceDir = defaultBrowserRepairSkillSource(),
  targetLane = CODEXLESS_BROWSER_REPAIR_TARGET_LANE,
  managedCodexHome = defaultManagedCodexHome(),
} = {}) {
  assertBrowserRepairExistingLane({ codexHome, targetLane, managedCodexHome });
  const source = inspectSource(sourceDir);
  const targetDir = targetFor(codexHome);
  if (!existsSync(targetDir)) {
    return resultBase({ status: "missing", action: "install", source, targetDir });
  }
  const targetStat = lstatSync(targetDir);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    return resultBase({
      status: "conflict",
      action: "blocked",
      source,
      targetDir,
      reason: "target-is-not-a-managed-directory",
    });
  }

  const marker = readMarker(targetDir);
  if (!marker || marker.product !== "codexless" || marker.skill !== CODEXLESS_BROWSER_REPAIR_SKILL) {
    return resultBase({
      status: "conflict",
      action: "blocked",
      source,
      targetDir,
      reason: "target-not-owned-by-codexless",
    });
  }

  const target = inspectTree(targetDir, { excludeMarker: true });
  if (marker.contentHash !== target.contentHash) {
    return resultBase({
      status: "drifted",
      action: "blocked",
      source,
      targetDir,
      target,
      marker,
      reason: "managed-skill-content-changed-outside-sync",
    });
  }
  if (source.contentHash === target.contentHash) {
    return resultBase({
      status: "current",
      action: "no-op",
      source,
      targetDir,
      target,
      marker,
    });
  }
  return resultBase({
    status: "update_available",
    action: "update",
    source,
    targetDir,
    target,
    marker,
  });
}

export function prepareBrowserRepairSkillSync(options = {}) {
  const check = checkBrowserRepairSkill(options);
  if (check.action === "no-op") {
    return { ...check, changed: false, transactionId: null, transactionStatus: "no-op" };
  }
  assertSyncAllowed(check);

  const codexHome = path.resolve(options.codexHome ?? defaultCodexHome());
  const sourceDir = path.resolve(options.sourceDir ?? defaultBrowserRepairSkillSource());
  const skillsRoot = path.join(codexHome, "skills");
  const targetDir = targetFor(codexHome);
  mkdirSync(skillsRoot, { recursive: true });

  const transactionId = randomUUID();
  const transactionRoot = transactionRootFor(codexHome, transactionId);
  const stageDir = path.join(transactionRoot, "staged");
  const backupDir = path.join(transactionRoot, "previous");
  const hadExistingTarget = existsSync(targetDir);
  mkdirSync(transactionRoot, { recursive: false });

  let oldTargetMoved = false;
  let activated = false;
  try {
    copyRegularTree(sourceDir, stageDir);
    const staged = inspectTree(stageDir, { excludeMarker: true });
    if (staged.contentHash !== check.sourceHash) {
      throw new CodexSkillSyncError("Staged Browser Repair Skill does not match the source hash.", {
        code: "CODEXLESS_SKILL_STAGE_MISMATCH",
        stage: "stage",
      });
    }
    writeManagedMarker(stageDir, staged);

    if (hadExistingTarget) {
      renameSync(targetDir, backupDir);
      oldTargetMoved = true;
    }
    renameSync(stageDir, targetDir);
    activated = true;

    const final = checkBrowserRepairSkill({ codexHome, sourceDir });
    if (final.status !== "current") {
      throw new CodexSkillSyncError("Browser Repair Skill did not validate as current after prepare.", {
        code: "CODEXLESS_SKILL_POSTCHECK_FAILED",
        stage: "postcheck",
      });
    }

    const state = {
      schemaVersion: CODEXLESS_SKILL_TRANSACTION_SCHEMA,
      product: "codexless",
      skill: CODEXLESS_BROWSER_REPAIR_SKILL,
      transactionId,
      hadExistingTarget,
      sourceHash: check.sourceHash,
      previousStatus: check.status,
      previousAction: check.action,
    };
    writeFileSync(path.join(transactionRoot, TRANSACTION_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return {
      ...final,
      changed: true,
      transactionId,
      transactionStatus: "prepared",
      previousStatus: check.status,
      previousAction: check.action,
    };
  } catch (error) {
    const rollbackFailure = rollbackInMemory({ targetDir, backupDir, transactionRoot, oldTargetMoved, activated, sourceHash: check.sourceHash });
    if (rollbackFailure) {
      throw new CodexSkillSyncError(`Browser Repair Skill prepare failed and rollback could not restore the previous target: ${rollbackFailure}`, {
        code: "CODEXLESS_SKILL_ROLLBACK_FAILED",
        stage: "rollback",
      });
    }
    if (error instanceof CodexSkillSyncError) throw error;
    throw new CodexSkillSyncError(error instanceof Error ? error.message : String(error), {
      code: "CODEXLESS_SKILL_SYNC_FAILED",
      stage: "prepare",
    });
  }
}

export function finalizeBrowserRepairSkillSync({
  codexHome = defaultCodexHome(),
  transactionId,
} = {}) {
  const state = readTransaction(codexHome, transactionId);
  const targetDir = targetFor(codexHome);
  const target = inspectManagedTarget(targetDir);
  if (target.contentHash !== state.sourceHash) {
    throw new CodexSkillSyncError("Prepared Browser Repair Skill changed before transaction finalize; preserving rollback state.", {
      code: "CODEXLESS_SKILL_TRANSACTION_DRIFT",
      stage: "finalize",
    });
  }
  rmSync(transactionRootFor(codexHome, transactionId), { recursive: true, force: true });
  return {
    ok: true,
    skill: CODEXLESS_BROWSER_REPAIR_SKILL,
    status: "current",
    action: "no-op",
    changed: true,
    transactionId,
    transactionStatus: "finalized",
    targetDir,
    targetHash: target.contentHash,
  };
}

export function rollbackBrowserRepairSkillSync({
  codexHome = defaultCodexHome(),
  transactionId,
} = {}) {
  const resolvedHome = path.resolve(codexHome);
  const state = readTransaction(resolvedHome, transactionId);
  const transactionRoot = transactionRootFor(resolvedHome, transactionId);
  const backupDir = path.join(transactionRoot, "previous");
  const targetDir = targetFor(resolvedHome);

  if (existsSync(targetDir)) {
    const target = inspectManagedTarget(targetDir);
    if (target.contentHash !== state.sourceHash) {
      throw new CodexSkillSyncError("Prepared Browser Repair Skill changed before rollback; refusing to delete unexpected local content.", {
        code: "CODEXLESS_SKILL_TRANSACTION_DRIFT",
        stage: "rollback",
      });
    }
    rmSync(targetDir, { recursive: true, force: true });
  }

  if (state.hadExistingTarget) {
    if (!existsSync(backupDir)) {
      throw new CodexSkillSyncError("Browser Repair Skill rollback backup is missing.", {
        code: "CODEXLESS_SKILL_ROLLBACK_FAILED",
        stage: "rollback",
      });
    }
    renameSync(backupDir, targetDir);
  }
  rmSync(transactionRoot, { recursive: true, force: true });
  return {
    ok: true,
    skill: CODEXLESS_BROWSER_REPAIR_SKILL,
    status: state.hadExistingTarget ? "restored" : "missing",
    action: "rollback",
    changed: true,
    transactionId,
    transactionStatus: "rolled_back",
    targetDir,
  };
}

export function syncBrowserRepairSkill(options = {}) {
  const prepared = prepareBrowserRepairSkillSync(options);
  if (!prepared.transactionId) return prepared;
  try {
    const finalized = finalizeBrowserRepairSkillSync({
      codexHome: options.codexHome ?? defaultCodexHome(),
      transactionId: prepared.transactionId,
    });
    return {
      ...prepared,
      transactionStatus: finalized.transactionStatus,
    };
  } catch (error) {
    return {
      ...prepared,
      transactionStatus: "prepared_cleanup_pending",
      warnings: [`The new Skill is active, but transaction cleanup could not complete: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function assertBrowserRepairExistingLane({ codexHome, targetLane, managedCodexHome }) {
  if (targetLane !== CODEXLESS_BROWSER_REPAIR_TARGET_LANE) {
    throw new CodexSkillSyncError("Browser Repair is Existing-specific and cannot target Managed/Both.", {
      code: "CODEXLESS_SKILL_LANE_UNSUPPORTED",
      stage: "lane-policy",
    });
  }
  if (path.resolve(codexHome) === path.resolve(managedCodexHome)) {
    throw new CodexSkillSyncError("Browser Repair must not be installed into the isolated Managed CODEX_HOME.", {
      code: "CODEXLESS_SKILL_MANAGED_HOME_FORBIDDEN",
      stage: "lane-policy",
    });
  }
}

function assertSyncAllowed(check) {
  if (check.action !== "blocked") return;
  throw new CodexSkillSyncError(
    check.reason === "target-not-owned-by-codexless"
      ? "A same-name Codex Skill already exists but is not owned by Codexless; refusing to overwrite it."
      : check.reason === "managed-skill-content-changed-outside-sync"
        ? "The Codexless-managed Browser Repair Skill was edited outside the sync path; refusing to overwrite local changes."
        : "The Browser Repair Skill target conflicts with the Codexless-managed install path.",
    { code: "CODEXLESS_SKILL_TARGET_CONFLICT", stage: "preflight" }
  );
}

function targetFor(codexHome) {
  return path.join(path.resolve(codexHome), "skills", CODEXLESS_BROWSER_REPAIR_SKILL);
}

function transactionRootFor(codexHome, transactionId) {
  if (typeof transactionId !== "string" || !/^[0-9a-f-]{36}$/i.test(transactionId)) {
    throw new CodexSkillSyncError("A valid Browser Repair Skill transactionId is required.", {
      code: "CODEXLESS_SKILL_TRANSACTION_INVALID",
      stage: "transaction",
    });
  }
  return path.join(path.resolve(codexHome), "skills", `${TRANSACTION_PREFIX}${transactionId}`);
}

function readTransaction(codexHome, transactionId) {
  const transactionRoot = transactionRootFor(codexHome, transactionId);
  const statePath = path.join(transactionRoot, TRANSACTION_STATE_FILE);
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (
      state?.schemaVersion !== CODEXLESS_SKILL_TRANSACTION_SCHEMA
      || state?.product !== "codexless"
      || state?.skill !== CODEXLESS_BROWSER_REPAIR_SKILL
      || state?.transactionId !== transactionId
      || typeof state?.hadExistingTarget !== "boolean"
      || typeof state?.sourceHash !== "string"
      || !/^[0-9a-f]{64}$/.test(state.sourceHash)
    ) throw new Error("invalid transaction state");
    return state;
  } catch (error) {
    throw new CodexSkillSyncError(`Browser Repair Skill transaction state is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`, {
      code: "CODEXLESS_SKILL_TRANSACTION_INVALID",
      stage: "transaction",
    });
  }
}

function rollbackInMemory({ targetDir, backupDir, transactionRoot, oldTargetMoved, activated, sourceHash }) {
  try {
    if (activated && existsSync(targetDir)) {
      const target = inspectManagedTarget(targetDir);
      if (target.contentHash !== sourceHash) throw new Error("activated target drifted during rollback");
      rmSync(targetDir, { recursive: true, force: true });
    }
    if (oldTargetMoved && existsSync(backupDir) && !existsSync(targetDir)) renameSync(backupDir, targetDir);
    rmSync(transactionRoot, { recursive: true, force: true });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function resultBase({ status, action, source, targetDir, target = null, marker = null, reason = null }) {
  return {
    ok: !new Set(["conflict", "drifted"]).has(status),
    skill: CODEXLESS_BROWSER_REPAIR_SKILL,
    targetLane: CODEXLESS_BROWSER_REPAIR_TARGET_LANE,
    status,
    action,
    reason,
    sourceDir: source.sourceDir,
    sourceHash: source.contentHash,
    sourceFiles: source.files,
    targetDir,
    targetHash: target?.contentHash ?? null,
    marker,
  };
}

function inspectSource(sourceDir) {
  const resolved = path.resolve(sourceDir);
  if (!existsSync(resolved)) {
    throw new CodexSkillSyncError("Codexless Browser Repair Skill source directory is missing.", {
      code: "CODEXLESS_SKILL_SOURCE_MISSING",
      stage: "source",
    });
  }
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CodexSkillSyncError("Codexless Browser Repair Skill source must be a real directory.", {
      code: "CODEXLESS_SKILL_SOURCE_INVALID",
      stage: "source",
    });
  }
  const skillMd = path.join(resolved, "SKILL.md");
  if (!existsSync(skillMd) || !lstatSync(skillMd).isFile()) {
    throw new CodexSkillSyncError("Codexless Browser Repair Skill source is missing SKILL.md.", {
      code: "CODEXLESS_SKILL_SOURCE_INVALID",
      stage: "source",
    });
  }
  return { sourceDir: resolved, ...inspectTree(resolved, { excludeMarker: true }) };
}

function inspectManagedTarget(targetDir) {
  if (!existsSync(targetDir)) {
    throw new CodexSkillSyncError("Browser Repair Skill managed target is missing.", {
      code: "CODEXLESS_SKILL_TRANSACTION_DRIFT",
      stage: "transaction",
    });
  }
  const marker = readMarker(targetDir);
  if (!marker || marker.product !== "codexless" || marker.skill !== CODEXLESS_BROWSER_REPAIR_SKILL) {
    throw new CodexSkillSyncError("Browser Repair Skill target is no longer Codexless-managed.", {
      code: "CODEXLESS_SKILL_TRANSACTION_DRIFT",
      stage: "transaction",
    });
  }
  const target = inspectTree(targetDir, { excludeMarker: true });
  if (marker.contentHash !== target.contentHash) {
    throw new CodexSkillSyncError("Browser Repair Skill target content no longer matches its ownership marker.", {
      code: "CODEXLESS_SKILL_TRANSACTION_DRIFT",
      stage: "transaction",
    });
  }
  return target;
}

function inspectTree(root, { excludeMarker = false } = {}) {
  const files = listRegularFiles(root, { excludeMarker });
  const hash = createHash("sha256");
  for (const relative of files) {
    const bytes = readFileSync(path.join(root, ...relative.split("/")));
    hash.update(relative, "utf8");
    hash.update("\0", "utf8");
    hash.update(createHash("sha256").update(bytes).digest("hex"), "utf8");
    hash.update("\n", "utf8");
  }
  return { files, contentHash: hash.digest("hex") };
}

function listRegularFiles(root, { excludeMarker = false } = {}) {
  const result = [];
  walk(root, "");
  return result.sort(compareStrings);

  function walk(current, relativeDir) {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => compareStrings(a.name, b.name));
    for (const entry of entries) {
      if (excludeMarker && !relativeDir && entry.name === CODEXLESS_MANAGED_SKILL_MARKER) continue;
      const absolute = path.join(current, entry.name);
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new CodexSkillSyncError(`Skill trees must not contain symlinks: ${relative}`, {
          code: "CODEXLESS_SKILL_SYMLINK_REFUSED",
          stage: "tree-inspection",
        });
      }
      if (stat.isDirectory()) walk(absolute, relative);
      else if (stat.isFile()) result.push(relative.replaceAll("\\", "/"));
      else {
        throw new CodexSkillSyncError(`Skill tree contains unsupported entry: ${relative}`, {
          code: "CODEXLESS_SKILL_TREE_INVALID",
          stage: "tree-inspection",
        });
      }
    }
  }
}

function copyRegularTree(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: false });
  const files = listRegularFiles(sourceDir, { excludeMarker: true });
  for (const relative of files) {
    const source = path.join(sourceDir, ...relative.split("/"));
    const target = path.join(targetDir, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
  }
}

function writeManagedMarker(targetDir, tree) {
  const marker = {
    schemaVersion: CODEXLESS_MANAGED_SKILL_SCHEMA,
    product: "codexless",
    skill: CODEXLESS_BROWSER_REPAIR_SKILL,
    contentHash: tree.contentHash,
    files: tree.files,
  };
  writeFileSync(path.join(targetDir, CODEXLESS_MANAGED_SKILL_MARKER), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

function readMarker(targetDir) {
  const markerPath = path.join(targetDir, CODEXLESS_MANAGED_SKILL_MARKER);
  if (!existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
    if (
      parsed?.schemaVersion !== CODEXLESS_MANAGED_SKILL_SCHEMA
      || typeof parsed?.product !== "string"
      || typeof parsed?.skill !== "string"
      || typeof parsed?.contentHash !== "string"
      || !/^[0-9a-f]{64}$/.test(parsed.contentHash)
      || !Array.isArray(parsed.files)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
