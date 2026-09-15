import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RELEASE_PRODUCT_ID,
  RELEASE_STATE_COMPATIBILITY,
  readReleaseManifest,
} from "./release-identity.mjs";

export const LIFECYCLE_RECEIPT_VERSION = 1;
export const INSTALLER_LOCK_VERSION = 1;
export const INSTALLER_LOCK_DIRNAME = "installer-activation.lock";
export const INSTALLER_LOCK_METADATA_FILENAME = "metadata.json";
export const INSTALLER_LOCK_RECLAIM_PREFIX = `${INSTALLER_LOCK_DIRNAME}.reclaimed-`;
export const INSTALLER_LOCK_MIN_RECLAIM_AGE_MS = 5_000;
export const OWNERSHIP_MARKER_VERSION = 1;
export const OWNERSHIP_MARKER_PREFIX = "install-ownership.";
export const INSTALL_DIR_IDENTITY_ALGORITHM = "sha256-canonical-install-dir-v1";

const LOCK_ACTIONS = new Set(["install", "update", "repair"]);
const LIFECYCLE_ACTIONS = new Set(["installed", "updated", "repaired"]);
const LOCK_METADATA_KEYS = ["action", "installDirHash", "nonce", "pid", "productId", "startedAt"];
const MARKER_KEYS = ["createdAt", "installDirIdentity", "lastKnownBuildId", "lastKnownVersion", "markerVersion", "productId", "updatedAt"];
const MARKER_IDENTITY_KEYS = ["algorithm", "sha256"];
const heldLocks = new Map();

export class LifecycleContractError extends Error {
  constructor(message, { code = "LIFECYCLE_CONTRACT_ERROR", stage = "lifecycle-preflight" } = {}) {
    super(message);
    this.name = "LifecycleContractError";
    this.code = code;
    this.stage = stage;
  }
}

export async function inspectLifecycle({
  targetRoot,
  installedRoot = null,
  mode = null,
  stateRoot = null,
  installDir = null,
} = {}) {
  const target = await readTargetIdentity(targetRoot);
  const normalizedMode = normalizeLifecycleMode(mode, installedRoot);
  let from = null;

  if (normalizedMode === "repair") {
    const repairRoot = requireString(installDir ?? installedRoot, "repair installDir");
    try {
      from = await readInstalledIdentity(installedRoot ?? repairRoot);
    } catch (error) {
      if (!(error instanceof LifecycleContractError) || error.code !== "INSTALLED_IDENTITY_UNAVAILABLE") throw error;
      const marker = await readOwnershipMarkerForInstallDir({ stateRoot, installDir: repairRoot });
      from = {
        version: marker.lastKnownVersion,
        buildId: marker.lastKnownBuildId,
        hostContractVersion: null,
      };
    }
  } else if (installedRoot) {
    from = await readInstalledIdentity(installedRoot);
  }

  assertStateCompatibility(target.stateCompatibility, "target release");

  return {
    ok: true,
    receiptVersion: LIFECYCLE_RECEIPT_VERSION,
    action: normalizedMode === "repair" ? "repaired" : from ? "updated" : "installed",
    from,
    to: publicIdentity(target),
    artifactBuildId: target.buildId,
    state: {
      preserved: true,
      schemaCompatible: true,
      migrated: false,
    },
    requiresRuntimeRestart: requiresRuntimeRestartForIdentity(from, target),
    requiresHostRefresh: requiresHostRefreshForIdentity(from, target),
  };
}

export async function acquireInstallerLock({
  stateRoot = null,
  installDir,
  action,
  ownerPid = process.pid,
  now = Date.now(),
  pidProbe = probePid,
} = {}) {
  const normalizedAction = requireLockAction(action);
  const normalizedPid = requirePid(ownerPid);
  const resolvedStateRoot = resolveLifecycleStateRoot(stateRoot);
  const installIdentity = await canonicalInstallDirIdentity(installDir);
  const lockPath = path.join(resolvedStateRoot, INSTALLER_LOCK_DIRNAME);
  const existingHeld = heldLocks.get(lockPath);
  if (normalizedPid === process.pid && existingHeld) {
    if (existingHeld.metadata.installDirHash !== installIdentity.sha256 || existingHeld.metadata.action !== normalizedAction) {
      throw installerBusy("This process already holds the Codexless installer activation lock for another lifecycle request.");
    }
    existingHeld.refCount += 1;
    return lockReceipt(existingHeld.metadata, { reentrant: true });
  }

  await ensurePrivateStateRoot(resolvedStateRoot);
  const metadata = {
    productId: RELEASE_PRODUCT_ID,
    pid: normalizedPid,
    startedAt: new Date(requireNow(now)).toISOString(),
    nonce: randomBytes(16).toString("hex"),
    action: normalizedAction,
    installDirHash: installIdentity.sha256,
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const claimPath = path.join(resolvedStateRoot, `.${INSTALLER_LOCK_DIRNAME}.claim-${metadata.nonce}-${attempt}`);
    await createLockClaim(claimPath, metadata);
    try {
      await rename(claimPath, lockPath);
      if (normalizedPid === process.pid) heldLocks.set(lockPath, { metadata, refCount: 1 });
      return lockReceipt(metadata, { reentrant: false });
    } catch (error) {
      await rm(claimPath, { recursive: true, force: true }).catch(() => {});
      const active = await readActiveLockForContention(lockPath);
      if (!active) continue;

      const ownerState = await classifyLockOwner(active, { now: requireNow(now), pidProbe });
      if (ownerState.reclaimable) {
        const reclaimed = await reclaimDeadOwnerLock({
          lockPath,
          stateRoot: resolvedStateRoot,
          expected: active,
          pidProbe,
          now: requireNow(now),
        });
        if (reclaimed) continue;
        const current = await readActiveLockForContention(lockPath);
        if (!current) continue;
        const currentState = await classifyLockOwner(current, { now: requireNow(now), pidProbe });
        throw installerBusy(currentState.reclaimable ? "Another Codexless installer contender changed the activation lock; retry the lifecycle request." : currentState.message);
      }
      throw installerBusy(ownerState.message);
    }
  }
  throw installerBusy("Another Codexless installer lifecycle is active. If no installer is running, use explicit repair/manual recovery instead of deleting the lock by age.");
}

export async function releaseInstallerLock({ stateRoot = null, nonce, ownerPid = process.pid } = {}) {
  const resolvedStateRoot = resolveLifecycleStateRoot(stateRoot);
  const lockPath = path.join(resolvedStateRoot, INSTALLER_LOCK_DIRNAME);
  const normalizedNonce = requireNonce(nonce);
  const normalizedPid = requirePid(ownerPid);
  const existingHeld = heldLocks.get(lockPath);
  if (normalizedPid === process.pid && existingHeld?.metadata.nonce === normalizedNonce && existingHeld.refCount > 1) {
    existingHeld.refCount -= 1;
    return { ok: true, lockVersion: INSTALLER_LOCK_VERSION, released: false, reentrantRemaining: existingHeld.refCount };
  }

  let metadata;
  try {
    metadata = await readInstallerLockMetadata(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      heldLocks.delete(lockPath);
      return { ok: true, lockVersion: INSTALLER_LOCK_VERSION, released: false, reentrantRemaining: 0 };
    }
    throw error;
  }
  if (metadata.nonce !== normalizedNonce || metadata.pid !== normalizedPid) {
    throw new LifecycleContractError("Installer lock release ownership did not match the active lock.", {
      code: "INSTALLER_LOCK_OWNERSHIP_MISMATCH",
      stage: "activation-lock",
    });
  }
  await rm(lockPath, { recursive: true, force: false });
  heldLocks.delete(lockPath);
  return { ok: true, lockVersion: INSTALLER_LOCK_VERSION, released: true, reentrantRemaining: 0 };
}

export async function withInstallerLock(options, task) {
  if (typeof task !== "function") throw new TypeError("withInstallerLock task must be a function");
  const receipt = await acquireInstallerLock(options);
  try {
    return await task(receipt);
  } finally {
    await releaseInstallerLock({
      stateRoot: options?.stateRoot ?? null,
      nonce: receipt.nonce,
      ownerPid: options?.ownerPid ?? process.pid,
    });
  }
}

export function buildInstallerLockFailureReceipt(error) {
  const stage = error instanceof LifecycleContractError ? error.stage : "activation-lock";
  const code = error instanceof LifecycleContractError ? error.code : "INSTALLER_LOCK_FAILED";
  return {
    ok: false,
    lockVersion: INSTALLER_LOCK_VERSION,
    productId: RELEASE_PRODUCT_ID,
    errorStage: stage,
    errorCode: code,
    error: safeLifecycleMessage(error, "Installer activation lock failed."),
  };
}

export function buildOwnershipMarkerFailureReceipt(error) {
  const stage = error instanceof LifecycleContractError ? error.stage : "ownership-marker";
  const code = error instanceof LifecycleContractError ? error.code : "OWNERSHIP_MARKER_FAILED";
  return {
    ok: false,
    markerVersion: OWNERSHIP_MARKER_VERSION,
    productId: RELEASE_PRODUCT_ID,
    errorStage: stage,
    errorCode: code,
    error: safeLifecycleMessage(error, "Ownership marker operation failed."),
  };
}

export async function canonicalInstallDirIdentity(installDir) {
  const absolute = path.resolve(requireString(installDir, "installDir"));
  let canonical;
  try {
    canonical = await realpath(absolute);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    let canonicalParent;
    try {
      canonicalParent = await realpath(parent);
    } catch (parentError) {
      if (parentError?.code !== "ENOENT") throw parentError;
      canonicalParent = path.resolve(parent);
    }
    canonical = path.join(canonicalParent, path.basename(absolute));
  }
  canonical = path.normalize(canonical).normalize("NFC");
  const basename = path.basename(canonical).normalize("NFC");
  const hashInput = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const sha256 = createHash("sha256")
    .update(`codexless-install-dir-v1\n${hashInput}\n`, "utf8")
    .digest("hex");
  return { algorithm: INSTALL_DIR_IDENTITY_ALGORITHM, sha256, basename };
}

export function resolveLifecycleStateRoot(explicitStateRoot = null) {
  if (explicitStateRoot !== null && explicitStateRoot !== undefined) {
    return path.resolve(requireString(explicitStateRoot, "stateRoot"));
  }
  return path.join(os.homedir(), ".config", "codexless");
}

export async function writeOwnershipMarker({
  stateRoot = null,
  installDir,
  buildId,
  version,
  now = Date.now(),
} = {}) {
  const resolvedStateRoot = resolveLifecycleStateRoot(stateRoot);
  const identity = await canonicalInstallDirIdentity(installDir);
  const normalizedBuildId = requireSha256(buildId, "ownership marker buildId");
  const normalizedVersion = requireString(version, "ownership marker version");
  const timestamp = new Date(requireNow(now)).toISOString();
  await ensurePrivateStateRoot(resolvedStateRoot);
  const markerPath = ownershipMarkerPath(resolvedStateRoot, identity.sha256);

  let createdAt = timestamp;
  try {
    const existing = validateOwnershipMarker(JSON.parse(await readFile(markerPath, "utf8")));
    if (existing.installDirIdentity.sha256 === identity.sha256) createdAt = existing.createdAt;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      // A successful, independently verified install/update may repair a damaged external marker.
      createdAt = timestamp;
    }
  }

  const marker = {
    markerVersion: OWNERSHIP_MARKER_VERSION,
    productId: RELEASE_PRODUCT_ID,
    installDirIdentity: {
      algorithm: identity.algorithm,
      sha256: identity.sha256,
    },
    createdAt,
    updatedAt: timestamp,
    lastKnownBuildId: normalizedBuildId,
    lastKnownVersion: normalizedVersion,
  };
  await atomicWritePrivateJson(markerPath, marker);
  return structuredClone(marker);
}

export async function restoreOwnershipMarkerSnapshot({
  stateRoot = null,
  installDir,
  buildId,
  version,
  createdAt,
  updatedAt,
} = {}) {
  const resolvedStateRoot = resolveLifecycleStateRoot(stateRoot);
  const identity = await canonicalInstallDirIdentity(installDir);
  const marker = validateOwnershipMarker({
    markerVersion: OWNERSHIP_MARKER_VERSION,
    productId: RELEASE_PRODUCT_ID,
    installDirIdentity: {
      algorithm: identity.algorithm,
      sha256: identity.sha256,
    },
    createdAt: requireIsoDate(createdAt, "ownership marker snapshot createdAt"),
    updatedAt: requireIsoDate(updatedAt, "ownership marker snapshot updatedAt"),
    lastKnownBuildId: requireSha256(buildId, "ownership marker snapshot buildId"),
    lastKnownVersion: requireString(version, "ownership marker snapshot version"),
  });
  await ensurePrivateStateRoot(resolvedStateRoot);
  await atomicWritePrivateJson(ownershipMarkerPath(resolvedStateRoot, identity.sha256), marker);
  return structuredClone(marker);
}

export async function readOwnershipMarkerForInstallDir({ stateRoot = null, installDir } = {}) {
  const resolvedStateRoot = resolveLifecycleStateRoot(stateRoot);
  const expectedIdentity = await canonicalInstallDirIdentity(installDir);
  const markerPath = ownershipMarkerPath(resolvedStateRoot, expectedIdentity.sha256);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new LifecycleContractError(
        "Repair ownership evidence is unavailable. Reinstall to a new directory or confirm ownership manually; repair will not guess a target.",
        { code: "REPAIR_OWNERSHIP_UNAVAILABLE", stage: "ownership" }
      );
    }
    throw new LifecycleContractError(
      "Repair ownership marker is damaged. Reinstall to a new directory or confirm ownership manually.",
      { code: "REPAIR_OWNERSHIP_INVALID", stage: "ownership" }
    );
  }
  let marker;
  try {
    marker = validateOwnershipMarker(parsed);
  } catch {
    throw new LifecycleContractError(
      "Repair ownership marker is invalid. Reinstall to a new directory or confirm ownership manually.",
      { code: "REPAIR_OWNERSHIP_INVALID", stage: "ownership" }
    );
  }
  if (marker.productId !== RELEASE_PRODUCT_ID || marker.installDirIdentity.sha256 !== expectedIdentity.sha256) {
    throw new LifecycleContractError("Repair ownership marker does not authorize the requested install directory.", {
      code: "REPAIR_OWNERSHIP_MISMATCH",
      stage: "ownership",
    });
  }
  return marker;
}

export async function removeOwnershipMarkerForInstallDir({ stateRoot = null, installDir } = {}) {
  const resolvedStateRoot = resolveLifecycleStateRoot(stateRoot);
  const identity = await canonicalInstallDirIdentity(installDir);
  await rm(ownershipMarkerPath(resolvedStateRoot, identity.sha256), { force: true });
  return {
    ok: true,
    markerVersion: OWNERSHIP_MARKER_VERSION,
    productId: RELEASE_PRODUCT_ID,
    removed: true,
  };
}

export function buildLifecycleReceipt({
  plan,
  installDir,
  doctorStatus,
  rollbackPerformed = false,
  backupRetained = false,
  backupPath = null,
} = {}) {
  validateLifecyclePlan(plan);
  const normalizedInstallDir = requireString(installDir, "installDir");
  const normalizedDoctorStatus = requireString(doctorStatus, "doctorStatus");
  const retained = Boolean(backupRetained);
  const normalizedBackupPath = retained ? requireString(backupPath, "backupPath") : null;
  if (!retained && backupPath !== null && backupPath !== undefined && String(backupPath).trim()) {
    throw new LifecycleContractError("backupPath must be null when backupRetained is false", { code: "INVALID_BACKUP_RECEIPT", stage: "receipt" });
  }

  return {
    ok: true,
    receiptVersion: LIFECYCLE_RECEIPT_VERSION,
    action: plan.action,
    installDir: normalizedInstallDir,
    from: cloneNullable(plan.from),
    to: structuredClone(plan.to),
    artifactBuildId: plan.artifactBuildId,
    doctorStatus: normalizedDoctorStatus,
    state: structuredClone(plan.state),
    rollback: {
      performed: Boolean(rollbackPerformed),
      backupRetained: retained,
      backupPath: normalizedBackupPath,
    },
    requiresRuntimeRestart: Boolean(plan.requiresRuntimeRestart),
    requiresHostRefresh: Boolean(plan.requiresHostRefresh),
  };
}

export function buildLifecycleFailureReceipt({
  action = "install-failed",
  installDir,
  errorStage,
  errorCode,
  error,
  rollbackPerformed = false,
  schemaCompatible = false,
} = {}) {
  return {
    ok: false,
    receiptVersion: LIFECYCLE_RECEIPT_VERSION,
    action: requireString(action, "action"),
    installDir: requireString(installDir, "installDir"),
    from: null,
    to: null,
    artifactBuildId: null,
    doctorStatus: null,
    state: {
      preserved: true,
      schemaCompatible: Boolean(schemaCompatible),
      migrated: false,
    },
    rollback: {
      performed: Boolean(rollbackPerformed),
      backupRetained: false,
      backupPath: null,
    },
    requiresRuntimeRestart: false,
    requiresHostRefresh: false,
    errorStage: requireString(errorStage, "errorStage"),
    errorCode: requireString(errorCode, "errorCode"),
    error: requireString(error, "error"),
  };
}

export function validateLifecycleReceipt(receipt, { expectOk = null } = {}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("lifecycle receipt must be an object");
  if (receipt.receiptVersion !== LIFECYCLE_RECEIPT_VERSION) throw new Error(`unsupported lifecycle receipt version ${String(receipt.receiptVersion)}`);
  if (typeof receipt.ok !== "boolean") throw new Error("lifecycle receipt ok must be boolean");
  if (expectOk !== null && receipt.ok !== expectOk) throw new Error(`lifecycle receipt expected ok=${expectOk}`);
  requireString(receipt.action, "lifecycle receipt action");
  requireString(receipt.installDir, "lifecycle receipt installDir");
  validateIdentityOrNull(receipt.from, "lifecycle receipt from");
  validateIdentityOrNull(receipt.to, "lifecycle receipt to");
  if (receipt.artifactBuildId !== null && !isSha256(receipt.artifactBuildId)) throw new Error("lifecycle receipt artifactBuildId must be SHA-256 or null");
  if (receipt.doctorStatus !== null) requireString(receipt.doctorStatus, "lifecycle receipt doctorStatus");
  validateStateReceipt(receipt.state);
  validateRollbackReceipt(receipt.rollback);
  if (typeof receipt.requiresRuntimeRestart !== "boolean") throw new Error("lifecycle receipt requiresRuntimeRestart must be boolean");
  if (typeof receipt.requiresHostRefresh !== "boolean") throw new Error("lifecycle receipt requiresHostRefresh must be boolean");

  if (receipt.ok) {
    if (!receipt.to) throw new Error("successful lifecycle receipt requires to identity");
    if (!isSha256(receipt.artifactBuildId)) throw new Error("successful lifecycle receipt requires artifactBuildId");
    if (receipt.artifactBuildId !== receipt.to.buildId) throw new Error("artifactBuildId must equal to.buildId");
    requireString(receipt.doctorStatus, "successful lifecycle receipt doctorStatus");
    if (receipt.state.schemaCompatible !== true || receipt.state.migrated !== false || receipt.state.preserved !== true) {
      throw new Error("successful lifecycle receipt requires preserved compatible non-migrated state");
    }
  } else {
    requireString(receipt.errorStage, "failed lifecycle receipt errorStage");
    requireString(receipt.errorCode, "failed lifecycle receipt errorCode");
    requireString(receipt.error, "failed lifecycle receipt error");
  }
  return structuredClone(receipt);
}

export async function readInstalledIdentity(root) {
  const installedRoot = path.resolve(requireString(root, "installed root"));
  let manifestProblem = null;
  try {
    const manifest = await readReleaseManifest(installedRoot);
    assertStateCompatibility(manifest.stateCompatibility, "installed release");
    return publicIdentity(manifest);
  } catch (error) {
    if (looksLikeProductMismatch(error)) {
      throw new LifecycleContractError("Installed release ownership contradicts Codexless product identity.", {
        code: "INSTALL_OWNERSHIP_MISMATCH",
        stage: "ownership",
      });
    }
    if (looksLikeStateCompatibilityError(error)) {
      throw new LifecycleContractError(`installed release state compatibility is unsupported: ${error.message}`, {
        code: "STATE_INCOMPATIBLE",
        stage: "state-compatibility",
      });
    }
    if (error?.code !== "ENOENT") manifestProblem = error;
  }

  const packagePath = path.join(installedRoot, "package.json");
  try {
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    if (packageJson?.name !== RELEASE_PRODUCT_ID) {
      throw new LifecycleContractError("Installed package ownership contradicts Codexless product identity.", {
        code: "INSTALL_OWNERSHIP_MISMATCH",
        stage: "ownership",
      });
    }
    return {
      version: typeof packageJson.version === "string" && packageJson.version.trim() ? packageJson.version.trim() : null,
      buildId: null,
      hostContractVersion: null,
    };
  } catch (error) {
    if (error instanceof LifecycleContractError) throw error;
    const detail = manifestProblem ? "manifest and package ownership evidence are unavailable or damaged" : "package ownership evidence is unavailable or damaged";
    throw new LifecycleContractError(`installed ${detail}`, {
      code: "INSTALLED_IDENTITY_UNAVAILABLE",
      stage: "ownership",
    });
  }
}

export function requiresRuntimeRestartForIdentity(current, target) {
  if (!current) return false;
  return current.buildId === null || current.buildId === undefined || current.buildId !== target?.buildId;
}

export function requiresHostRefreshForIdentity(current, target) {
  if (!current) return false;
  return current.hostContractVersion === null
    || current.hostContractVersion === undefined
    || current.hostContractVersion !== target?.hostContractVersion;
}

export function assertStateCompatibility(value, label = "release") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LifecycleContractError(`${label} stateCompatibility must be an object`, { code: "STATE_INCOMPATIBLE", stage: "state-compatibility" });
  }
  if (value.migration !== "none") {
    throw new LifecycleContractError(`${label} state migration must be none`, { code: "STATE_INCOMPATIBLE", stage: "state-compatibility" });
  }
  const expected = RELEASE_STATE_COMPATIBILITY.stores;
  for (const storeName of ["recent-calls", "agent-task-cards"]) {
    if (value.stores?.[storeName]?.schemaVersion !== expected[storeName].schemaVersion) {
      throw new LifecycleContractError(`${label} ${storeName} schema must be v${expected[storeName].schemaVersion}`, {
        code: "STATE_INCOMPATIBLE",
        stage: "state-compatibility",
      });
    }
  }
  return true;
}

async function readTargetIdentity(root) {
  try {
    const manifest = await readReleaseManifest(path.resolve(requireString(root, "target root")));
    assertStateCompatibility(manifest.stateCompatibility, "target release");
    return manifest;
  } catch (error) {
    if (error instanceof LifecycleContractError) throw error;
    if (looksLikeStateCompatibilityError(error)) {
      throw new LifecycleContractError(`target release state compatibility is unsupported: ${error.message}`, {
        code: "STATE_INCOMPATIBLE",
        stage: "state-compatibility",
      });
    }
    throw new LifecycleContractError(`target release manifest is invalid: ${error instanceof Error ? error.message : String(error)}`, {
      code: "TARGET_MANIFEST_INVALID",
      stage: "lifecycle-preflight",
    });
  }
}

async function ensurePrivateStateRoot(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => {});
}

async function createLockClaim(claimPath, metadata) {
  await mkdir(claimPath, { mode: 0o700 });
  const metadataPath = path.join(claimPath, INSTALLER_LOCK_METADATA_FILENAME);
  const handle = await open(metadataPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(metadataPath, 0o600).catch(() => {});
}

async function readActiveLockForContention(lockPath) {
  try {
    return await readInstallerLockMetadata(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof LifecycleContractError) throw error;
    throw installerBusy("Installer lock metadata cannot be verified safely. Run explicit repair/manual recovery after confirming no installer is active.");
  }
}

async function readInstallerLockMetadata(lockPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path.join(lockPath, INSTALLER_LOCK_METADATA_FILENAME), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    throw installerBusy("Installer lock metadata cannot be verified safely. Run explicit repair/manual recovery after confirming no installer is active.");
  }
  try {
    return validateLockMetadata(parsed);
  } catch {
    throw installerBusy("Installer lock metadata is invalid. Run explicit repair/manual recovery after confirming no installer is active.");
  }
}

async function classifyLockOwner(metadata, { now, pidProbe }) {
  const started = Date.parse(metadata.startedAt);
  const ageMs = now - started;
  if (!Number.isFinite(started) || !Number.isFinite(ageMs) || ageMs < 0) {
    return {
      reclaimable: false,
      message: "Installer lock age cannot be verified safely. Run explicit repair/manual recovery after confirming no installer is active.",
    };
  }
  let status;
  try {
    status = normalizePidStatus(await pidProbe(metadata.pid));
  } catch {
    status = "unknown";
  }
  if (status === "alive") {
    return { reclaimable: false, message: "Another Codexless installer lifecycle is active." };
  }
  if (status !== "dead") {
    return {
      reclaimable: false,
      message: "Installer lock owner liveness cannot be verified safely. Run explicit repair/manual recovery after confirming no installer is active.",
    };
  }
  if (ageMs < INSTALLER_LOCK_MIN_RECLAIM_AGE_MS) {
    return {
      reclaimable: false,
      message: "A recently created installer lock has a dead-looking PID; refusing immediate reclaim to reduce PID-race risk. Retry repair after confirming no installer is active.",
    };
  }
  return { reclaimable: true, message: "dead owner lock is reclaimable" };
}

async function reclaimDeadOwnerLock({ lockPath, stateRoot, expected, pidProbe, now }) {
  const current = await readActiveLockForContention(lockPath);
  if (!current || current.nonce !== expected.nonce) return false;
  const secondCheck = await classifyLockOwner(current, { now, pidProbe });
  if (!secondCheck.reclaimable) return false;
  const tombstonePath = path.join(stateRoot, `${INSTALLER_LOCK_RECLAIM_PREFIX}${current.nonce}`);
  try {
    await rename(lockPath, tombstonePath);
    return true;
  } catch {
    // Tombstones are intentionally retained. If another reclaimer already moved this exact
    // stale nonce, its tombstone prevents this stale snapshot from ever renaming a new lock.
    return false;
  }
}

async function probePid(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") return "dead";
    if (error?.code === "EPERM") return "alive";
    return "unknown";
  }
}

function validateLockMetadata(value) {
  assertExactKeys(value, LOCK_METADATA_KEYS, "installer lock metadata");
  if (value.productId !== RELEASE_PRODUCT_ID) throw new Error("installer lock productId mismatch");
  requirePid(value.pid);
  requireIsoDate(value.startedAt, "installer lock startedAt");
  requireNonce(value.nonce);
  requireLockAction(value.action);
  requireSha256(value.installDirHash, "installer lock installDirHash");
  return structuredClone(value);
}

function lockReceipt(metadata, { reentrant }) {
  return {
    ok: true,
    lockVersion: INSTALLER_LOCK_VERSION,
    productId: metadata.productId,
    pid: metadata.pid,
    startedAt: metadata.startedAt,
    nonce: metadata.nonce,
    action: metadata.action,
    installDirHash: metadata.installDirHash,
    reentrant: Boolean(reentrant),
  };
}

function installerBusy(message) {
  return new LifecycleContractError(message, { code: "INSTALLER_BUSY", stage: "activation-lock" });
}

function ownershipMarkerPath(stateRoot, installDirHash) {
  return path.join(stateRoot, `${OWNERSHIP_MARKER_PREFIX}${requireSha256(installDirHash, "installDirHash")}.json`);
}

function validateOwnershipMarker(value) {
  assertExactKeys(value, MARKER_KEYS, "ownership marker");
  if (value.markerVersion !== OWNERSHIP_MARKER_VERSION) throw new Error("unsupported ownership marker version");
  if (value.productId !== RELEASE_PRODUCT_ID) throw new Error("ownership marker productId mismatch");
  assertExactKeys(value.installDirIdentity, MARKER_IDENTITY_KEYS, "ownership marker installDirIdentity");
  if (value.installDirIdentity.algorithm !== INSTALL_DIR_IDENTITY_ALGORITHM) throw new Error("ownership marker identity algorithm mismatch");
  requireSha256(value.installDirIdentity.sha256, "ownership marker installDirIdentity.sha256");
  requireIsoDate(value.createdAt, "ownership marker createdAt");
  requireIsoDate(value.updatedAt, "ownership marker updatedAt");
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) throw new Error("ownership marker updatedAt predates createdAt");
  requireSha256(value.lastKnownBuildId, "ownership marker lastKnownBuildId");
  requireString(value.lastKnownVersion, "ownership marker lastKnownVersion");
  return structuredClone(value);
}

async function atomicWritePrivateJson(targetPath, value) {
  const tempPath = `${targetPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, targetPath);
    await chmod(targetPath, 0o600).catch(() => {});
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function normalizeLifecycleMode(mode, installedRoot) {
  if (mode === null || mode === undefined || mode === "") return installedRoot ? "update" : "install";
  const normalized = requireLockAction(mode);
  if (normalized === "install" && installedRoot) return "update";
  return normalized;
}

function publicIdentity(manifest) {
  return {
    version: manifest.version ?? null,
    buildId: manifest.buildId ?? null,
    hostContractVersion: manifest.hostContractVersion ?? null,
  };
}

function validateLifecyclePlan(plan) {
  if (!plan || typeof plan !== "object" || plan.ok !== true) throw new Error("successful lifecycle plan is required");
  if (!LIFECYCLE_ACTIONS.has(plan.action)) throw new Error(`unsupported lifecycle action ${String(plan.action)}`);
  validateIdentityOrNull(plan.from, "lifecycle plan from");
  validateIdentityOrNull(plan.to, "lifecycle plan to");
  if (!plan.to || !isSha256(plan.to.buildId)) throw new Error("lifecycle plan requires target buildId");
  if (plan.artifactBuildId !== plan.to.buildId) throw new Error("lifecycle plan artifactBuildId must equal target buildId");
  validateStateReceipt(plan.state);
  if (typeof plan.requiresRuntimeRestart !== "boolean" || typeof plan.requiresHostRefresh !== "boolean") {
    throw new Error("lifecycle plan restart/refresh flags must be boolean");
  }
}

function validateIdentityOrNull(value, label) {
  if (value === null) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be object or null`);
  if (value.version !== null) requireString(value.version, `${label}.version`);
  if (value.buildId !== null && !isSha256(value.buildId)) throw new Error(`${label}.buildId must be SHA-256 or null`);
  if (value.hostContractVersion !== null) requireString(value.hostContractVersion, `${label}.hostContractVersion`);
}

function validateStateReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lifecycle state receipt must be an object");
  for (const key of ["preserved", "schemaCompatible", "migrated"]) {
    if (typeof value[key] !== "boolean") throw new Error(`lifecycle state ${key} must be boolean`);
  }
}

function validateRollbackReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lifecycle rollback receipt must be an object");
  if (typeof value.performed !== "boolean" || typeof value.backupRetained !== "boolean") throw new Error("lifecycle rollback flags must be boolean");
  if (value.backupRetained) requireString(value.backupPath, "lifecycle rollback backupPath");
  else if (value.backupPath !== null) throw new Error("lifecycle rollback backupPath must be null when not retained");
}

function cloneNullable(value) {
  return value === null ? null : structuredClone(value);
}

function looksLikeStateCompatibilityError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return /stateCompatibility|state compatibility|recent-calls|agent-task-cards|migration must be none/i.test(text);
}

function looksLikeProductMismatch(error) {
  const text = error instanceof Error ? error.message : String(error);
  return /productId must be codexless|package name must be codexless|productId mismatch/i.test(text);
}

function safeLifecycleMessage(error, fallback) {
  const text = error instanceof Error ? error.message : String(error ?? fallback);
  return text
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<path>")
    .replace(/\/(?:[^\s"']+\/)+[^\s"']*/g, "<path>")
    .replace(/(token|secret|password)=\S+/gi, "$1=<redacted>")
    .slice(0, 1000) || fallback;
}

function normalizePidStatus(value) {
  if (value === true) return "alive";
  if (value === false) return "dead";
  return new Set(["alive", "dead", "unknown"]).has(value) ? value : "unknown";
}

function requireNow(value) {
  const number = typeof value === "function" ? Number(value()) : Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("now must be a finite epoch-millisecond value");
  return number;
}

function requireLockAction(value) {
  const action = requireString(value, "lifecycle action");
  if (!LOCK_ACTIONS.has(action)) throw new Error(`unsupported lifecycle action ${action}`);
  return action;
}

function requirePid(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) throw new Error("pid must be a positive 32-bit integer");
  return pid;
}

function requireNonce(value) {
  const nonce = requireString(value, "installer lock nonce").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error("installer lock nonce must be 128-bit lowercase hex");
  return nonce;
}

function requireIsoDate(value, label) {
  const text = requireString(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO date`);
  return text;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function requireSha256(value, label) {
  const text = requireString(value, label).toLowerCase();
  if (!isSha256(text)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return text;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}
