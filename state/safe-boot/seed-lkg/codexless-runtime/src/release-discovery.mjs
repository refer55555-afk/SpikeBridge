import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertStateCompatibility,
  readInstalledIdentity,
  requiresHostRefreshForIdentity,
} from "./lifecycle-contract.mjs";
import { validateReleaseManifest } from "./release-identity.mjs";
import { codexlessPlatformSupport } from "./platform-support.mjs";

export const CODEXLESS_GITHUB_REPOSITORY = Object.freeze({
  owner: "liyana31811",
  repo: "Codexless",
});
export const CODEXLESS_GITHUB_API_BASE = `https://api.github.com/repos/${CODEXLESS_GITHUB_REPOSITORY.owner}/${CODEXLESS_GITHUB_REPOSITORY.repo}`;
export const RELEASE_CHANNEL = "preview";
export const DISCOVERY_RECEIPT_VERSION = 1;
export const DEFAULT_METADATA_MAX_BYTES = 1 * 1024 * 1024;
export const DEFAULT_MANIFEST_MAX_BYTES = 512 * 1024;
export const DEFAULT_CHECKSUM_MAX_BYTES = 256 * 1024;
export const DEFAULT_ARTIFACT_MAX_BYTES = 128 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
export const MAX_REDIRECTS = 5;

const PROD_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

export class ReleaseDiscoveryError extends Error {
  constructor(message, { code = "RELEASE_DISCOVERY_ERROR", stage = "discovery", rateLimit = null } = {}) {
    super(message);
    this.name = "ReleaseDiscoveryError";
    this.code = code;
    this.stage = stage;
    this.rateLimit = rateLimit;
  }
}

export function releaseAssetContract(version, platform, arch) {
  const normalizedVersion = requireSemver(version).raw;
  const support = codexlessPlatformSupport({ platform, arch });
  if (support.status !== "supported") {
    throw new ReleaseDiscoveryError(support.reason, {
      code: "UNSUPPORTED_PLATFORM",
      stage: "asset-selection",
    });
  }
  if (platform === "win32" && arch === "x64") {
    return {
      artifactName: `codexless-${normalizedVersion}-windows-x64.zip`,
      manifestName: `codexless-${normalizedVersion}-release-manifest.json`,
      checksumName: `codexless-${normalizedVersion}-SHA256SUMS`,
      platform: "windows",
      arch: "x64",
    };
  }
  if (platform === "darwin" && arch === "arm64") {
    return {
      artifactName: `codexless-${normalizedVersion}-macos-arm64.tar.gz`,
      manifestName: `codexless-${normalizedVersion}-release-manifest.json`,
      checksumName: `codexless-${normalizedVersion}-SHA256SUMS`,
      platform: "macos",
      arch: "arm64",
    };
  }
  throw new ReleaseDiscoveryError(`supported platform has no release asset contract: ${platform}/${arch}`, {
    code: "RELEASE_ASSET_CONTRACT_MISSING",
    stage: "asset-selection",
  });
}

export function selectLatestPreviewRelease(releases) {
  if (!Array.isArray(releases)) throw new ReleaseDiscoveryError("GitHub releases payload must be an array", { code: "MALFORMED_RELEASES", stage: "metadata" });
  const candidates = [];
  for (const release of releases) {
    if (!release || typeof release !== "object" || release.draft === true || release.prerelease !== true) continue;
    let parsed;
    try {
      parsed = requireSemver(release.tag_name);
    } catch {
      continue;
    }
    if (parsed.prerelease[0] !== RELEASE_CHANNEL) continue;
    candidates.push({ release, parsed });
  }
  candidates.sort((left, right) => compareSemver(right.parsed, left.parsed));
  return candidates[0] ?? null;
}

export function compareCurrentToLatest(currentVersion, latestVersion) {
  let current;
  let latest;
  try {
    current = requireSemver(currentVersion);
    latest = requireSemver(latestVersion);
  } catch {
    return "unverified";
  }
  const compared = compareSemver(current, latest);
  if (compared === 0) return "up_to_date";
  return compared < 0 ? "update_available" : "ahead";
}

export function selectExactAsset(release, assetName) {
  if (!Array.isArray(release?.assets)) throw new ReleaseDiscoveryError("release assets are missing", { code: "MALFORMED_RELEASE_ASSETS", stage: "asset-selection" });
  const matches = release.assets.filter((asset) => asset?.name === assetName && asset?.state === "uploaded");
  if (matches.length === 0) throw new ReleaseDiscoveryError(`required release asset is missing: ${assetName}`, { code: "ASSET_MISSING", stage: "asset-selection" });
  if (matches.length !== 1) throw new ReleaseDiscoveryError(`release asset is ambiguous: ${assetName}`, { code: "ASSET_AMBIGUOUS", stage: "asset-selection" });
  return normalizeAsset(matches[0], assetName);
}

export function parseGithubAssetDigest(value, assetName = "asset") {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new ReleaseDiscoveryError(`invalid GitHub digest for ${assetName}`, { code: "INVALID_ASSET_DIGEST", stage: "checksum" });
  const match = value.match(/^sha256:([0-9a-fA-F]{64})$/);
  if (!match) throw new ReleaseDiscoveryError(`unsupported or malformed GitHub digest for ${assetName}`, { code: "INVALID_ASSET_DIGEST", stage: "checksum" });
  return match[1].toLowerCase();
}

export function parseSha256Sums(text) {
  const rows = new Map();
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([0-9a-fA-F]{64})\s+[* ]?(.+)$/);
    if (!match) throw new ReleaseDiscoveryError("malformed SHA256SUMS line", { code: "MALFORMED_CHECKSUMS", stage: "checksum" });
    const digest = match[1].toLowerCase();
    const name = match[2].trim();
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      throw new ReleaseDiscoveryError("checksum filename must be a basename", { code: "MALFORMED_CHECKSUMS", stage: "checksum" });
    }
    if (rows.has(name)) throw new ReleaseDiscoveryError(`duplicate checksum entry: ${name}`, { code: "CHECKSUM_AMBIGUOUS", stage: "checksum" });
    rows.set(name, digest);
  }
  return rows;
}

export async function discoverCodexlessRelease({
  currentRoot = null,
  platform = process.platform,
  arch = process.arch,
  downloadArtifact = false,
  includeVerifiedManifest = false,
  githubToken = process.env.GITHUB_TOKEN ?? null,
  testEndpoint = null,
  tempRoot = os.tmpdir(),
  metadataMaxBytes = DEFAULT_METADATA_MAX_BYTES,
  manifestMaxBytes = DEFAULT_MANIFEST_MAX_BYTES,
  checksumMaxBytes = DEFAULT_CHECKSUM_MAX_BYTES,
  artifactMaxBytes = DEFAULT_ARTIFACT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
} = {}) {
  const endpoint = buildReleasesEndpoint(testEndpoint);
  const networkPolicy = buildNetworkPolicy(endpoint, Boolean(testEndpoint));
  const headers = githubHeaders(githubToken);
  let tempDir = null;
  try {
    const releasesResponse = await fetchBounded(endpoint, {
      headers,
      maxBytes: metadataMaxBytes,
      timeoutMs,
      networkPolicy,
      stage: "metadata",
      expectJson: true,
    });
    const releases = releasesResponse.json;
    const selected = selectLatestPreviewRelease(releases);
    if (!selected) {
      throw new ReleaseDiscoveryError("no matching Codexless preview release was found", {
        code: "NO_MATCHING_RELEASE",
        stage: "release-selection",
        rateLimit: releasesResponse.rateLimit,
      });
    }

    const version = selected.parsed.raw;
    const release = selected.release;
    const naming = releaseAssetContract(version, platform, arch);
    const artifact = selectExactAsset(release, naming.artifactName);
    const manifestAsset = selectExactAsset(release, naming.manifestName);
    assertAllowedUrl(new URL(artifact.browserDownloadUrl), networkPolicy, "asset-selection");
    assertAllowedUrl(new URL(manifestAsset.browserDownloadUrl), networkPolicy, "asset-selection");
    enforceAssetSize(artifact, artifactMaxBytes, "artifact");
    enforceAssetSize(manifestAsset, manifestMaxBytes, "release manifest");

    const artifactGithubDigest = parseGithubAssetDigest(artifact.digest, artifact.name);
    const manifestGithubDigest = parseGithubAssetDigest(manifestAsset.digest, manifestAsset.name);
    let checksumRows = null;
    if (!artifactGithubDigest || !manifestGithubDigest) {
      const checksumAsset = selectExactAsset(release, naming.checksumName);
      assertAllowedUrl(new URL(checksumAsset.browserDownloadUrl), networkPolicy, "asset-selection");
      enforceAssetSize(checksumAsset, checksumMaxBytes, "checksum asset");
      const checksumGithubDigest = parseGithubAssetDigest(checksumAsset.digest, checksumAsset.name);
      const checksumResponse = await fetchBounded(checksumAsset.browserDownloadUrl, {
        headers,
        maxBytes: checksumMaxBytes,
        timeoutMs,
        networkPolicy,
        stage: "checksum-download",
      });
      if (checksumGithubDigest && sha256(checksumResponse.buffer) !== checksumGithubDigest) {
        throw new ReleaseDiscoveryError("checksum asset SHA-256 does not match its GitHub digest", { code: "DIGEST_MISMATCH", stage: "checksum-verification" });
      }
      checksumRows = parseSha256Sums(checksumResponse.buffer.toString("utf8"));
    }

    if (checksumRows) {
      assertChecksumAgreement(checksumRows, artifact, artifactGithubDigest);
      assertChecksumAgreement(checksumRows, manifestAsset, manifestGithubDigest);
    }
    const artifactExpected = artifactGithubDigest ?? requireChecksum(checksumRows, artifact.name);
    const manifestExpected = manifestGithubDigest ?? requireChecksum(checksumRows, manifestAsset.name);
    const artifactDigestSource = artifactGithubDigest ? "github-asset-digest" : "release-sha256sums";
    const manifestDigestSource = manifestGithubDigest ? "github-asset-digest" : "release-sha256sums";

    const manifestResponse = await fetchBounded(manifestAsset.browserDownloadUrl, {
      headers,
      maxBytes: manifestMaxBytes,
      timeoutMs,
      networkPolicy,
      stage: "manifest-download",
    });
    const actualManifestSha256 = sha256(manifestResponse.buffer);
    if (actualManifestSha256 !== manifestExpected) {
      throw new ReleaseDiscoveryError("release manifest SHA-256 does not match its authoritative digest", { code: "DIGEST_MISMATCH", stage: "manifest-verification" });
    }
    let parsedManifest;
    try {
      parsedManifest = JSON.parse(manifestResponse.buffer.toString("utf8"));
    } catch {
      throw new ReleaseDiscoveryError("release manifest is malformed JSON", { code: "MALFORMED_RELEASE_MANIFEST", stage: "manifest-verification" });
    }
    try {
      assertStateCompatibility(parsedManifest?.stateCompatibility, "target release");
    } catch (error) {
      throw new ReleaseDiscoveryError(safeMessage(error), { code: "STATE_INCOMPATIBLE", stage: "state-compatibility" });
    }
    let targetManifest;
    try {
      targetManifest = validateReleaseManifest(parsedManifest);
    } catch (error) {
      throw new ReleaseDiscoveryError(`release manifest is invalid: ${safeMessage(error)}`, { code: "MALFORMED_RELEASE_MANIFEST", stage: "manifest-verification" });
    }
    if (targetManifest.version !== version) {
      throw new ReleaseDiscoveryError("release tag version does not match release-manifest version", { code: "RELEASE_IDENTITY_MISMATCH", stage: "manifest-verification" });
    }
    const current = currentRoot ? await readInstalledIdentity(currentRoot) : null;
    const currentPublic = current ? {
      version: current.version,
      buildId: current.buildId ?? null,
      hostContractVersion: current.hostContractVersion ?? null,
    } : { version: null, buildId: null, hostContractVersion: null };
    const status = compareCurrentToLatest(currentPublic.version, version);
    const targetPublic = {
      version: targetManifest.version,
      buildId: targetManifest.buildId,
      hostContractVersion: targetManifest.hostContractVersion,
      stateCompatibility: structuredClone(targetManifest.stateCompatibility),
    };

    let verifiedSha256 = null;
    let tempPath = null;
    if (downloadArtifact) {
      tempDir = await mkdtemp(path.join(path.resolve(tempRoot), "codexless-release-"));
      tempPath = path.join(tempDir, artifact.name);
      verifiedSha256 = await downloadFileVerified(artifact.browserDownloadUrl, tempPath, {
        headers,
        expectedSha256: artifactExpected,
        maxBytes: artifactMaxBytes,
        timeoutMs: downloadTimeoutMs,
        networkPolicy,
      });
    }

    return {
      ok: true,
      receiptVersion: DISCOVERY_RECEIPT_VERSION,
      current: currentPublic,
      latest: {
        version,
        tag: String(release.tag_name),
        releaseId: normalizeReleaseId(release.id),
        prerelease: true,
        publishedAt: normalizeNullableDate(release.published_at),
      },
      status,
      asset: {
        name: artifact.name,
        size: artifact.size,
        digestAlgorithm: "sha256",
        digest: artifactExpected,
        digestSource: artifactDigestSource,
        verifiedSha256,
        ...(downloadArtifact ? { tempPath } : {}),
      },
      releaseManifest: targetPublic,
      requiresHostRefresh: current
        ? requiresHostRefreshForIdentity(current, targetManifest)
        : true,
      network: {
        source: "github-releases",
        rateLimit: releasesResponse.rateLimit,
      },
      verification: {
        manifestDigestAlgorithm: "sha256",
        manifestDigest: manifestExpected,
        manifestDigestSource,
        manifestVerifiedSha256: actualManifestSha256,
      },
      ...(includeVerifiedManifest ? { verifiedManifest: structuredClone(targetManifest) } : {}),
    };
  } catch (error) {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw sanitizeDiscoveryError(error);
  }
}

export function buildDiscoveryFailureReceipt(error) {
  const sanitized = sanitizeDiscoveryError(error);
  return {
    ok: false,
    receiptVersion: DISCOVERY_RECEIPT_VERSION,
    status: "unverified",
    errorStage: sanitized.stage,
    errorCode: sanitized.code,
    error: sanitized.message,
    network: {
      source: "github-releases",
      rateLimit: sanitized.rateLimit ?? null,
    },
  };
}

export async function cleanupVerifiedArtifact(tempPath) {
  if (typeof tempPath !== "string" || !tempPath.trim()) return false;
  const parent = path.dirname(path.resolve(tempPath));
  if (!path.basename(parent).startsWith("codexless-release-")) {
    throw new ReleaseDiscoveryError("refusing to clean a non-Codexless temp artifact directory", { code: "INVALID_TEMP_PATH", stage: "cleanup" });
  }
  await rm(parent, { recursive: true, force: true });
  return true;
}

function normalizeAsset(asset, expectedName) {
  const size = Number(asset?.size);
  if (!Number.isInteger(size) || size < 0) throw new ReleaseDiscoveryError(`invalid asset size: ${expectedName}`, { code: "MALFORMED_RELEASE_ASSET", stage: "asset-selection" });
  if (typeof asset?.browser_download_url !== "string" || !asset.browser_download_url) {
    throw new ReleaseDiscoveryError(`asset download URL is missing: ${expectedName}`, { code: "MALFORMED_RELEASE_ASSET", stage: "asset-selection" });
  }
  return {
    id: normalizeReleaseId(asset.id),
    name: expectedName,
    size,
    digest: asset.digest ?? null,
    browserDownloadUrl: asset.browser_download_url,
  };
}

function enforceAssetSize(asset, maxBytes, label) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer");
  if (asset.size > maxBytes) {
    throw new ReleaseDiscoveryError(`${label} exceeds the configured size limit`, { code: "ASSET_TOO_LARGE", stage: "asset-selection" });
  }
}

async function downloadFileVerified(url, targetPath, { headers, expectedSha256, maxBytes, timeoutMs, networkPolicy }) {
  const request = await fetchResponse(url, { headers, timeoutMs, networkPolicy, stage: "artifact-download" });
  const contentLength = parseContentLength(request.response.headers.get("content-length"));
  if (contentLength !== null && contentLength > maxBytes) {
    await closeResponseRequest(request, { abort: true });
    throw new ReleaseDiscoveryError("artifact exceeds the configured size limit", { code: "ASSET_TOO_LARGE", stage: "artifact-download" });
  }

  let handle;
  try {
    handle = await open(targetPath, "wx");
  } catch (error) {
    await closeResponseRequest(request, { abort: true });
    throw error;
  }
  const hash = createHash("sha256");
  let total = 0;
  try {
    await consumeResponseBody(request, async (chunk) => {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) throw new ReleaseDiscoveryError("artifact exceeds the configured size limit", { code: "ASSET_TOO_LARGE", stage: "artifact-download" });
      hash.update(bytes);
      await handle.write(bytes);
    });
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
  const actual = hash.digest("hex");
  if (actual !== expectedSha256) {
    await rm(targetPath, { force: true }).catch(() => {});
    throw new ReleaseDiscoveryError("artifact SHA-256 does not match its authoritative digest", { code: "DIGEST_MISMATCH", stage: "artifact-verification" });
  }
  return actual;
}

async function fetchBounded(url, { headers, maxBytes, timeoutMs, networkPolicy, stage, expectJson = false }) {
  const request = await fetchResponse(url, { headers, timeoutMs, networkPolicy, stage });
  const contentLength = parseContentLength(request.response.headers.get("content-length"));
  if (contentLength !== null && contentLength > maxBytes) {
    await closeResponseRequest(request, { abort: true });
    throw new ReleaseDiscoveryError("response exceeds the configured size limit", { code: "RESPONSE_TOO_LARGE", stage });
  }
  const chunks = [];
  let total = 0;
  await consumeResponseBody(request, (chunk) => {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) throw new ReleaseDiscoveryError("response exceeds the configured size limit", { code: "RESPONSE_TOO_LARGE", stage });
    chunks.push(bytes);
  });
  const buffer = Buffer.concat(chunks);
  const rateLimit = rateLimitFromHeaders(request.response.headers);
  let json = null;
  if (expectJson) {
    try { json = JSON.parse(buffer.toString("utf8")); }
    catch { throw new ReleaseDiscoveryError("GitHub release metadata is malformed JSON", { code: "MALFORMED_JSON", stage, rateLimit }); }
  }
  return { buffer, json, rateLimit };
}

async function fetchResponse(url, { headers, timeoutMs, networkPolicy, stage }) {
  let current = new URL(url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    assertAllowedUrl(current, networkPolicy, stage);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let response;
    try {
      response = await fetch(current, { headers: headersForUrl(headers, current, networkPolicy), redirect: "manual", signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      if (timedOut || error?.name === "AbortError") throw new ReleaseDiscoveryError("network request timed out", { code: "NETWORK_TIMEOUT", stage });
      throw new ReleaseDiscoveryError("network request failed", { code: "NETWORK_OFFLINE", stage });
    }

    const request = {
      response,
      controller,
      timer,
      stage,
      timedOut: () => timedOut,
      closed: false,
    };
    const rateLimit = rateLimitFromHeaders(response.headers);
    if (response.status === 403 || response.status === 429) {
      await closeResponseRequest(request, { abort: true });
      throw new ReleaseDiscoveryError(`GitHub request was rate limited (${response.status})`, { code: "GITHUB_RATE_LIMIT", stage, rateLimit });
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        await closeResponseRequest(request, { abort: true });
        throw new ReleaseDiscoveryError("redirect response is missing Location", { code: "REDIRECT_INVALID", stage });
      }
      if (redirects >= MAX_REDIRECTS) {
        await closeResponseRequest(request, { abort: true });
        throw new ReleaseDiscoveryError("too many release download redirects", { code: "REDIRECT_LIMIT", stage });
      }
      await closeResponseRequest(request, { abort: true });
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      await closeResponseRequest(request, { abort: true });
      throw new ReleaseDiscoveryError(`GitHub request failed with HTTP ${response.status}`, { code: "GITHUB_HTTP_ERROR", stage, rateLimit });
    }
    return request;
  }
  throw new ReleaseDiscoveryError("too many release download redirects", { code: "REDIRECT_LIMIT", stage });
}

async function consumeResponseBody(request, onChunk) {
  const body = request.response.body;
  if (!body) {
    await closeResponseRequest(request);
    return;
  }
  const reader = body.getReader();
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await onChunk(value);
    }
    completed = true;
  } catch (error) {
    if (error instanceof ReleaseDiscoveryError) throw error;
    if (request.timedOut() || error?.name === "AbortError") {
      throw new ReleaseDiscoveryError("network response body timed out", { code: "NETWORK_TIMEOUT", stage: request.stage });
    }
    throw new ReleaseDiscoveryError("network response body failed", { code: "NETWORK_OFFLINE", stage: request.stage });
  } finally {
    if (!completed) {
      request.controller.abort();
      await reader.cancel().catch(() => {});
    }
    try { reader.releaseLock(); } catch {}
    await closeResponseRequest(request, { abort: !completed, cancelBody: false });
  }
}

async function closeResponseRequest(request, { abort = false, cancelBody = true } = {}) {
  if (!request || request.closed) return;
  request.closed = true;
  clearTimeout(request.timer);
  if (abort) request.controller.abort();
  if (cancelBody && request.response?.body && !request.response.body.locked) {
    await request.response.body.cancel().catch(() => {});
  }
}

function buildReleasesEndpoint(testEndpoint) {
  if (!testEndpoint) return `${CODEXLESS_GITHUB_API_BASE}/releases?per_page=100`;
  const url = new URL(testEndpoint);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    throw new ReleaseDiscoveryError("test endpoint must be loopback", { code: "TEST_ENDPOINT_REJECTED", stage: "configuration" });
  }
  return url.toString();
}

function buildNetworkPolicy(endpoint, testMode) {
  const endpointUrl = new URL(endpoint);
  if (testMode) return { testMode: true, testOrigin: endpointUrl.origin };
  return { testMode: false, testOrigin: null };
}

function assertAllowedUrl(url, policy, stage) {
  if (!(url instanceof URL)) url = new URL(url);
  if (policy.testMode) {
    if (url.origin !== policy.testOrigin) throw new ReleaseDiscoveryError("test redirect escaped the fixture origin", { code: "REDIRECT_HOST_REJECTED", stage });
    return;
  }
  if (url.protocol !== "https:" || !PROD_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new ReleaseDiscoveryError("release network destination is not an allowed GitHub host", { code: "REDIRECT_HOST_REJECTED", stage });
  }
}

function headersForUrl(headers, url, policy) {
  const next = { ...headers };
  if (policy.testMode || url.hostname !== "api.github.com") delete next.Authorization;
  return next;
}

function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "codexless-release-discovery/1",
    "X-GitHub-Api-Version": "2026-03-10",
  };
  if (typeof token === "string" && token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

function assertChecksumAgreement(rows, asset, githubDigest) {
  if (!(rows instanceof Map) || !githubDigest) return;
  const sidecarDigest = rows.get(asset.name);
  if (sidecarDigest && sidecarDigest !== githubDigest) {
    throw new ReleaseDiscoveryError(`checksum conflicts with GitHub digest for ${asset.name}`, { code: "CHECKSUM_CONFLICT", stage: "checksum" });
  }
}

function requireChecksum(rows, name) {
  if (!(rows instanceof Map)) throw new ReleaseDiscoveryError(`authoritative SHA-256 is unavailable for ${name}`, { code: "CHECKSUM_MISSING", stage: "checksum" });
  const digest = rows.get(name);
  if (!digest) throw new ReleaseDiscoveryError(`checksum is missing for ${name}`, { code: "CHECKSUM_MISSING", stage: "checksum" });
  return digest;
}

function rateLimitFromHeaders(headers) {
  const limit = parseIntegerHeader(headers.get("x-ratelimit-limit"));
  const remaining = parseIntegerHeader(headers.get("x-ratelimit-remaining"));
  const reset = parseIntegerHeader(headers.get("x-ratelimit-reset"));
  const retryAfter = parseIntegerHeader(headers.get("retry-after"));
  if ([limit, remaining, reset, retryAfter].every((value) => value === null)) return null;
  return { limit, remaining, resetEpochSeconds: reset, retryAfterSeconds: retryAfter };
}

function parseIntegerHeader(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseContentLength(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeReleaseId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  throw new ReleaseDiscoveryError("release metadata has an invalid id", { code: "MALFORMED_RELEASES", stage: "metadata" });
}

function normalizeNullableDate(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new ReleaseDiscoveryError("release published_at is invalid", { code: "MALFORMED_RELEASES", stage: "metadata" });
  return value;
}

function requireSemver(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) throw new ReleaseDiscoveryError(`invalid semantic version: ${text || "<missing>"}`, { code: "INVALID_SEMVER", stage: "release-selection" });
  const prerelease = match[4] ? match[4].split(".") : [];
  for (const identifier of prerelease) {
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
      throw new ReleaseDiscoveryError(`invalid semantic version: ${text}`, { code: "INVALID_SEMVER", stage: "release-selection" });
    }
  }
  return {
    raw: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function compareSemver(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= left.prerelease.length) return -1;
    if (index >= right.prerelease.length) return 1;
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) continue;
    const aNum = /^\d+$/.test(a) ? Number(a) : null;
    const bNum = /^\d+$/.test(b) ? Number(b) : null;
    if (aNum !== null && bNum !== null) return aNum < bNum ? -1 : 1;
    if (aNum !== null) return -1;
    if (bNum !== null) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function sanitizeDiscoveryError(error) {
  if (error instanceof ReleaseDiscoveryError) return error;
  return new ReleaseDiscoveryError(safeMessage(error), { code: "RELEASE_DISCOVERY_ERROR", stage: "discovery" });
}

function safeMessage(error) {
  return String(error instanceof Error ? error.message : error ?? "release discovery failed")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer <redacted>")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "<redacted>")
    .replace(/https?:\/\/[^\s]+/gi, "<url>")
    .slice(0, 1000);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
