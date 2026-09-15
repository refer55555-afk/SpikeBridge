import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanupVerifiedArtifact,
  discoverCodexlessRelease,
} from "./release-discovery.mjs";
import {
  assertStateCompatibility,
  readInstalledIdentity,
  readOwnershipMarkerForInstallDir,
  validateLifecycleReceipt,
} from "./lifecycle-contract.mjs";
import { serializeReleaseManifest } from "./release-identity.mjs";
import {
  cleanupExtractedRelease,
  extractVerifiedReleaseArtifact,
} from "./bootstrap-archive.mjs";
import {
  defaultBootstrapRoot,
  discardPreparedBootstrap,
  prepareBootstrapGeneration,
  readBootstrapPointer,
} from "./bootstrap-persistence.mjs";

export const BOOTSTRAP_UPDATE_RECEIPT_VERSION = 1;
export const DEFAULT_INSTALLER_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_INSTALLER_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;

export class BootstrapUpdateError extends Error {
  constructor(message, {
    code = "BOOTSTRAP_UPDATE_FAILED",
    stage = "discovery",
    lifecycle = null,
    discovery = null,
  } = {}) {
    super(message);
    this.name = "BootstrapUpdateError";
    this.code = code;
    this.stage = stage;
    this.lifecycle = lifecycle;
    this.discovery = discovery;
  }
}

export async function runBootstrapUpdate({
  installDir,
  bootstrapRoot = defaultBootstrapRoot(),
  stateRoot = null,
  platform = process.platform,
  arch = process.arch,
  verbose = false,
  tempRoot = os.tmpdir(),
  stagingBase = os.tmpdir(),
  discoveryOptions = {},
  installerTimeoutMs = DEFAULT_INSTALLER_TIMEOUT_MS,
  installerEnv = process.env,
} = {}) {
  const targetInstallDir = path.resolve(requireString(installDir, "installDir"));
  const persistentBootstrapRoot = path.resolve(requireString(bootstrapRoot, "bootstrapRoot"));
  const lifecycleStateRoot = stateRoot === null || stateRoot === undefined
    ? null
    : path.resolve(requireString(stateRoot, "stateRoot"));
  let current = null;
  let currentIdentityError = null;
  let repairCandidate = false;
  const installExists = await pathExists(targetInstallDir);
  if (installExists) {
    try { current = await readInstalledIdentity(targetInstallDir); }
    catch (error) { currentIdentityError = error; }
  }

  let check;
  try {
    check = await discoverCodexlessRelease({
      currentRoot: current ? targetInstallDir : null,
      platform,
      arch,
      downloadArtifact: false,
      ...discoveryOptions,
    });
  } catch (error) {
    throw bootstrapError(safeMessage(error), "DISCOVERY_FAILED", "discovery", { discovery: error });
  }

  if (currentIdentityError) {
    if (currentIdentityError?.code !== "INSTALLED_IDENTITY_UNAVAILABLE") {
      throw bootstrapError(
        safeMessage(currentIdentityError),
        typeof currentIdentityError?.code === "string" ? currentIdentityError.code : "CURRENT_IDENTITY_UNVERIFIED",
        typeof currentIdentityError?.stage === "string" ? currentIdentityError.stage : "ownership"
      );
    }
    try {
      await readOwnershipMarkerForInstallDir({ stateRoot: lifecycleStateRoot, installDir: targetInstallDir });
    } catch (error) {
      throw bootstrapError(
        safeMessage(error),
        typeof error?.code === "string" ? error.code : "REPAIR_OWNERSHIP_UNAVAILABLE",
        typeof error?.stage === "string" ? error.stage : "ownership"
      );
    }
    repairCandidate = true;
  }

  const checkDecision = updateDecision({ current, discovery: check });
  if (checkDecision.noop) return buildNoopReceipt(check, current, checkDecision.reason, { verbose, installDir: targetInstallDir, bootstrapRoot: persistentBootstrapRoot });

  let verified = null;
  let extracted = null;
  let preparedBootstrap = null;
  try {
    try {
      verified = await discoverCodexlessRelease({
        currentRoot: current ? targetInstallDir : null,
        platform,
        arch,
        downloadArtifact: true,
        includeVerifiedManifest: true,
        tempRoot,
        ...discoveryOptions,
      });
    } catch (error) {
      throw bootstrapError(safeMessage(error), "DISCOVERY_VERIFY_FAILED", "discovery", { discovery: error });
    }

    const verifyDecision = updateDecision({ current, discovery: verified });
    if (verifyDecision.noop) return buildNoopReceipt(verified, current, verifyDecision.reason, { verbose, installDir: targetInstallDir, bootstrapRoot: persistentBootstrapRoot });
    if (!verified.asset?.tempPath || verified.asset.verifiedSha256 !== verified.asset.digest) {
      throw bootstrapError("release artifact did not produce a verified local payload", "ARTIFACT_NOT_VERIFIED", "discovery");
    }
    if (!verified.verifiedManifest) throw bootstrapError("release discovery did not retain the verified sidecar manifest", "SIDECAR_MANIFEST_UNAVAILABLE", "manifest-match");

    try {
      extracted = await extractVerifiedReleaseArtifact({
        artifactPath: verified.asset.tempPath,
        expectedSha256: verified.asset.verifiedSha256,
        version: verified.latest.version,
        platform,
        arch,
        stagingBase,
      });
    } catch (error) {
      if (error?.stage === "manifest-match") throw bootstrapError(safeMessage(error), error.code ?? "INTERNAL_MANIFEST_INVALID", "manifest-match");
      throw bootstrapError(safeMessage(error), error.code ?? "EXTRACTION_FAILED", "extraction");
    }

    assertManifestMatch(verified.verifiedManifest, extracted.internalManifest);
    assertStateCompatibility(extracted.internalManifest.stateCompatibility, "staged internal release");
    if (extracted.internalManifest.buildId !== verified.releaseManifest.buildId) {
      throw bootstrapError("staged internal buildId does not match discovered target buildId", "ARTIFACT_MANIFEST_MISMATCH", "manifest-match");
    }

    try {
      preparedBootstrap = await prepareBootstrapGeneration({
        sourceRoot: extracted.releaseRoot,
        bootstrapRoot: persistentBootstrapRoot,
        buildId: extracted.internalManifest.buildId,
      });
    } catch (error) {
      throw bootstrapError(`staged release cannot prepare the external bootstrap generation: ${safeMessage(error)}`, "BOOTSTRAP_GENERATION_PREPARE_FAILED", "installer-invoke");
    }

    const installer = await invokeStagedInstaller({
      releaseRoot: extracted.releaseRoot,
      installDir: targetInstallDir,
      bootstrapRoot: persistentBootstrapRoot,
      preparedBootstrap,
      repair: repairCandidate,
      platform,
      arch,
      timeoutMs: installerTimeoutMs,
      env: installerEnv,
    });
    const lifecycle = parseInstallerReceipt(installer);
    assertLifecycleMatchesInternal(lifecycle, extracted.internalManifest);
    if (repairCandidate && lifecycle.action !== "repaired") {
      throw bootstrapError("repair candidate installer receipt did not report action=repaired", "INSTALLER_RECEIPT_ACTION_MISMATCH", "installer-receipt", { lifecycle });
    }

    let pointer;
    try {
      pointer = await readBootstrapPointer(persistentBootstrapRoot);
    } catch (error) {
      throw bootstrapError(`installer returned success without a readable bootstrap pointer: ${safeMessage(error)}`, "BOOTSTRAP_GENERATION_COMMIT_FAILED", "installer-receipt", { lifecycle });
    }
    if (pointer.buildId !== extracted.internalManifest.buildId) {
      throw bootstrapError("installer returned success without committing the prepared bootstrap generation", "BOOTSTRAP_GENERATION_COMMIT_FAILED", "installer-receipt", { lifecycle });
    }
    preparedBootstrap = null;

    return {
      ok: true,
      receiptVersion: BOOTSTRAP_UPDATE_RECEIPT_VERSION,
      action: lifecycle.action,
      status: "updated",
      current: publicIdentity(current),
      latest: structuredClone(verified.latest),
      artifact: {
        name: verified.asset.name,
        sha256: verified.asset.verifiedSha256,
      },
      staged: {
        version: extracted.internalManifest.version,
        buildId: extracted.internalManifest.buildId,
        hostContractVersion: extracted.internalManifest.hostContractVersion,
        stateCompatibility: structuredClone(extracted.internalManifest.stateCompatibility),
      },
      lifecycle: publicLifecycleReceipt(lifecycle),
      requiresRuntimeRestart: lifecycle.requiresRuntimeRestart,
      requiresHostRefresh: lifecycle.requiresHostRefresh,
      network: structuredClone(verified.network),
      bootstrap: {
        persistent: true,
        buildId: pointer.buildId,
      },
      ...(verbose ? {
        paths: {
          installDir: targetInstallDir,
          bootstrapRoot: persistentBootstrapRoot,
          artifactTempPath: verified.asset.tempPath,
          stagingDir: extracted.stageDir,
        },
      } : {}),
    };
  } finally {
    if (preparedBootstrap) await discardPreparedBootstrap(preparedBootstrap).catch(() => {});
    if (extracted?.stageDir) await cleanupExtractedRelease(extracted.stageDir).catch(() => {});
    if (verified?.asset?.tempPath) await cleanupVerifiedArtifact(verified.asset.tempPath).catch(() => {});
  }
}

export function buildBootstrapFailureReceipt(error, { verbose = false } = {}) {
  const normalized = error instanceof BootstrapUpdateError
    ? error
    : bootstrapError(safeMessage(error), "BOOTSTRAP_UPDATE_FAILED", "discovery");
  const receipt = {
    ok: false,
    receiptVersion: BOOTSTRAP_UPDATE_RECEIPT_VERSION,
    status: "unverified",
    errorStage: normalized.stage,
    errorCode: normalized.code,
    error: safeMessage(normalized),
    lifecycle: normalized.lifecycle ? publicLifecycleReceipt(normalized.lifecycle) : null,
    network: normalized.discovery?.rateLimit ? { source: "github-releases", rateLimit: normalized.discovery.rateLimit } : null,
  };
  if (verbose && normalized.lifecycle?.installDir) receipt.installDir = normalized.lifecycle.installDir;
  return receipt;
}

function updateDecision({ current, discovery }) {
  if (current?.buildId && discovery.releaseManifest?.buildId === current.buildId) return { noop: true, reason: "same_build" };
  if (discovery.status === "up_to_date") return { noop: true, reason: "up_to_date" };
  if (discovery.status === "ahead") return { noop: true, reason: "ahead" };
  if (current && discovery.status === "unverified") throw bootstrapError("installed version cannot be safely compared with the selected release", "CURRENT_VERSION_UNVERIFIED", "discovery");
  return { noop: false, reason: null };
}

function buildNoopReceipt(discovery, current, reason, { verbose, installDir, bootstrapRoot }) {
  return {
    ok: true,
    receiptVersion: BOOTSTRAP_UPDATE_RECEIPT_VERSION,
    action: "no-op",
    status: reason,
    current: publicIdentity(current),
    latest: structuredClone(discovery.latest),
    artifact: {
      name: discovery.asset.name,
      sha256: discovery.asset.digest,
    },
    staged: null,
    lifecycle: null,
    requiresRuntimeRestart: false,
    requiresHostRefresh: false,
    network: structuredClone(discovery.network),
    bootstrap: { persistent: true, buildId: current?.buildId ?? null },
    ...(verbose ? { paths: { installDir, bootstrapRoot } } : {}),
  };
}

function assertManifestMatch(sidecar, internal) {
  let sidecarCanonical;
  let internalCanonical;
  try {
    sidecarCanonical = serializeReleaseManifest(sidecar);
    internalCanonical = serializeReleaseManifest(internal);
  } catch (error) {
    throw bootstrapError(`release manifest comparison failed: ${safeMessage(error)}`, "ARTIFACT_MANIFEST_MISMATCH", "manifest-match");
  }
  if (sidecarCanonical !== internalCanonical) {
    throw bootstrapError("digest-verified sidecar manifest does not match staged internal release manifest", "ARTIFACT_MANIFEST_MISMATCH", "manifest-match");
  }
}

async function invokeStagedInstaller({ releaseRoot, installDir, bootstrapRoot, preparedBootstrap, repair, platform, arch, timeoutMs, env }) {
  let command;
  let args;
  if (platform === "win32" && arch === "x64") {
    command = "powershell.exe";
    args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(releaseRoot, "scripts", "install.ps1"), "-InstallDir", installDir, "-Json"];
    if (repair) args.push("-Repair");
  } else if (platform === "darwin" && arch === "arm64") {
    command = "/bin/sh";
    args = [path.join(releaseRoot, "scripts", "install.sh"), "--install-dir", installDir, "--json"];
    if (repair) args.push("--repair");
  } else {
    throw bootstrapError(`unsupported installer platform: ${platform}/${arch}`, "UNSUPPORTED_PLATFORM", "installer-invoke");
  }
  const installerEnv = {
    ...env,
    CODEXLESS_BOOTSTRAP_ROOT: bootstrapRoot,
    CODEXLESS_BOOTSTRAP_PREPARED_BUILD_ID: preparedBootstrap.buildId,
    CODEXLESS_BOOTSTRAP_PREPARED_REUSED: preparedBootstrap.reused ? "true" : "false",
  };
  if (preparedBootstrap.reused) delete installerEnv.CODEXLESS_BOOTSTRAP_PREPARED_PENDING_DIR;
  else installerEnv.CODEXLESS_BOOTSTRAP_PREPARED_PENDING_DIR = preparedBootstrap.pendingDir;
  const result = await runProcess(command, args, { timeoutMs, env: installerEnv });
  if (result.exitCode !== 0) {
    let lifecycle = null;
    try {
      lifecycle = JSON.parse(result.stdout.trim());
      validateLifecycleReceipt(lifecycle, { expectOk: false });
    } catch { lifecycle = null; }
    throw bootstrapError("staged installer failed; bootstrap will not replay or perform its own rollback", "INSTALLER_FAILED", "installer-invoke", { lifecycle });
  }
  return result;
}

function parseInstallerReceipt(result) {
  let parsed;
  try { parsed = JSON.parse(String(result.stdout ?? "").trim()); }
  catch { throw bootstrapError("staged installer returned malformed JSON receipt", "INSTALLER_RECEIPT_MALFORMED", "installer-receipt"); }
  try { return validateLifecycleReceipt(parsed, { expectOk: true }); }
  catch (error) { throw bootstrapError(`staged installer receipt is invalid: ${safeMessage(error)}`, "INSTALLER_RECEIPT_INVALID", "installer-receipt"); }
}

function assertLifecycleMatchesInternal(lifecycle, internal) {
  if (lifecycle.to?.version !== internal.version
    || lifecycle.to?.buildId !== internal.buildId
    || lifecycle.to?.hostContractVersion !== internal.hostContractVersion
    || lifecycle.artifactBuildId !== internal.buildId) {
    throw bootstrapError("installer receipt target identity does not match staged internal manifest", "INSTALLER_RECEIPT_IDENTITY_MISMATCH", "installer-receipt", { lifecycle });
  }
}

function publicLifecycleReceipt(receipt) {
  return {
    ok: receipt.ok,
    receiptVersion: receipt.receiptVersion,
    action: receipt.action,
    from: receipt.from ? structuredClone(receipt.from) : null,
    to: receipt.to ? structuredClone(receipt.to) : null,
    artifactBuildId: receipt.artifactBuildId,
    doctorStatus: receipt.doctorStatus,
    state: structuredClone(receipt.state),
    rollback: {
      performed: receipt.rollback.performed,
      backupRetained: receipt.rollback.backupRetained,
    },
    requiresRuntimeRestart: receipt.requiresRuntimeRestart,
    requiresHostRefresh: receipt.requiresHostRefresh,
    ...(receipt.ok ? {} : {
      errorStage: receipt.errorStage,
      errorCode: receipt.errorCode,
      error: safeMessage(receipt.error),
    }),
  };
}

function publicIdentity(current) {
  if (!current) return { version: null, buildId: null, hostContractVersion: null };
  return {
    version: current.version ?? null,
    buildId: current.buildId ?? null,
    hostContractVersion: current.hostContractVersion ?? null,
  };
}

async function runProcess(command, args, { timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...env }, windowsHide: true });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(bootstrapError("staged installer timed out", "INSTALLER_TIMEOUT", "installer-invoke"));
    }, timeoutMs);
    const append = (current, chunk) => {
      const next = Buffer.concat([current, Buffer.from(chunk)]);
      if (next.length > DEFAULT_INSTALLER_OUTPUT_MAX_BYTES) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill();
          reject(bootstrapError("staged installer output exceeded limit", "INSTALLER_OUTPUT_TOO_LARGE", "installer-invoke"));
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
      reject(bootstrapError(`staged installer could not start: ${safeMessage(error)}`, "INSTALLER_START_FAILED", "installer-invoke"));
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    });
  });
}

async function pathExists(target) {
  return Boolean(await stat(target).catch(() => null));
}

function bootstrapError(message, code, stage, extras = {}) {
  return new BootstrapUpdateError(message, { code, stage, ...extras });
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function safeMessage(error) {
  return String(error instanceof Error ? error.message : error ?? "bootstrap update failed")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer <redacted>")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "<redacted>")
    .replace(/https?:\/\/[^\s]+/gi, "<url>")
    .replace(/[A-Za-z]:\\[^\r\n]*/g, "<path>")
    .replace(/\/(?!\/)[^\r\n]*/g, "<path>")
    .slice(0, 1000);
}
