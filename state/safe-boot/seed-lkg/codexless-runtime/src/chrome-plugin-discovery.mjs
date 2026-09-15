import { readFile, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CHROME_PLUGIN_ID = "chrome@openai-bundled";
const TRUSTED_BUILD = /^[0-9A-Za-z._-]+$/;

function unavailable(reason, source, details = {}) {
  return { status: "unavailable", reason, source, ...details };
}

function isPathWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function trustedBuild(value) {
  return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." && TRUSTED_BUILD.test(value);
}

async function isRegularFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function readManifest(versionRoot) {
  const manifestPath = path.join(versionRoot, ".codex-plugin", "plugin.json");
  try {
    const value = JSON.parse(await readFile(manifestPath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function projectCurrentChromePlugin(result) {
  const matches = (result?.marketplaces ?? [])
    .flatMap((marketplace) => marketplace?.plugins ?? [])
    .filter((plugin) => plugin?.id === CHROME_PLUGIN_ID);
  if (matches.length !== 1) return null;
  const plugin = matches[0];
  const localVersion = typeof plugin.localVersion === "string" && plugin.localVersion.trim()
    ? plugin.localVersion.trim()
    : null;
  if (!localVersion || plugin.installed === false || plugin.enabled === false) return null;
  return {
    status: "ok",
    id: CHROME_PLUGIN_ID,
    name: typeof plugin.name === "string" ? plugin.name : "chrome",
    localVersion,
    source: "codex-plugin-list",
    sourcePath: typeof plugin?.source?.path === "string" ? plugin.source.path : null,
  };
}

export async function discoverCurrentChromePlugin({ pluginListResult = null, env = process.env } = {}) {
  const matches = (pluginListResult?.marketplaces ?? [])
    .flatMap((marketplace) => marketplace?.plugins ?? [])
    .filter((plugin) => plugin?.id === CHROME_PLUGIN_ID);
  if (matches.length > 1) {
    return unavailable("current_chrome_plugin_authoritative_ambiguous", "codex-plugin-list");
  }
  if (matches.length === 1) {
    const projected = projectCurrentChromePlugin(pluginListResult);
    if (projected && trustedBuild(projected.localVersion)) return projected;
    const localVersion = typeof matches[0]?.localVersion === "string" ? matches[0].localVersion.trim() : "";
    return unavailable(
      localVersion && !trustedBuild(localVersion)
        ? "current_chrome_plugin_build_untrusted"
        : "current_chrome_plugin_authoritative_unavailable",
      "codex-plugin-list",
      localVersion ? { localVersion } : {}
    );
  }
  return discoverSingletonCachedChromePlugin({ env });
}

export async function discoverSingletonCachedChromePlugin({ env = process.env } = {}) {
  const codexHome = path.resolve(
    typeof env?.CODEX_HOME === "string" && env.CODEX_HOME.trim()
      ? env.CODEX_HOME
      : path.join(os.homedir(), ".codex")
  );
  const expectedBundleRoot = path.join(codexHome, "plugins", "cache", "openai-bundled");
  const expectedChromeRoot = path.join(expectedBundleRoot, "chrome");
  const expectedBrowserRoot = path.join(expectedBundleRoot, "browser");
  let bundleRoot;
  let chromeRoot;
  let browserRoot;
  try {
    [bundleRoot, chromeRoot, browserRoot] = await Promise.all([
      realpath(expectedBundleRoot),
      realpath(expectedChromeRoot),
      realpath(expectedBrowserRoot),
    ]);
  } catch {
    return unavailable("current_browser_plugin_pair_not_found", "codex-plugin-cache-singleton");
  }
  if (!isPathWithin(bundleRoot, chromeRoot) || !isPathWithin(bundleRoot, browserRoot)) {
    return unavailable("current_browser_plugin_path_escape", "codex-plugin-cache-singleton");
  }

  let entries;
  try {
    entries = await readdir(chromeRoot, { withFileTypes: true });
  } catch {
    return unavailable("current_browser_plugin_pair_not_found", "codex-plugin-cache-singleton");
  }

  const candidateNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (candidateNames.some((build) => !trustedBuild(build))) {
    return unavailable("current_chrome_plugin_build_untrusted", "codex-plugin-cache-singleton");
  }

  const valid = [];
  let invalidReason = null;
  for (const build of candidateNames) {
    const expectedChromeVersionRoot = path.join(chromeRoot, build);
    const expectedBrowserVersionRoot = path.join(browserRoot, build);
    let chromeVersionRoot;
    let browserVersionRoot;
    try {
      [chromeVersionRoot, browserVersionRoot] = await Promise.all([
        realpath(expectedChromeVersionRoot),
        realpath(expectedBrowserVersionRoot),
      ]);
    } catch {
      invalidReason ??= "current_browser_plugin_pair_not_found";
      continue;
    }
    if (!isPathWithin(chromeRoot, chromeVersionRoot) || !isPathWithin(browserRoot, browserVersionRoot)) {
      invalidReason ??= "current_browser_plugin_path_escape";
      continue;
    }
    const [chromeManifest, browserManifest] = await Promise.all([
      readManifest(chromeVersionRoot),
      readManifest(browserVersionRoot),
    ]);
    if (
      chromeManifest?.name !== "chrome" || chromeManifest?.version !== build ||
      browserManifest?.name !== "browser" || browserManifest?.version !== build
    ) {
      invalidReason ??= "current_browser_plugin_manifest_mismatch";
      continue;
    }
    const clientPath = path.join(chromeVersionRoot, "scripts", "browser-client.mjs");
    const servicePath = path.join(browserVersionRoot, "scripts", "browser-service.mjs");
    if (!await isRegularFile(clientPath) || !await isRegularFile(servicePath)) {
      invalidReason ??= "current_browser_plugin_pair_not_found";
      continue;
    }
    let realClientPath;
    let realServicePath;
    try {
      [realClientPath, realServicePath] = await Promise.all([realpath(clientPath), realpath(servicePath)]);
    } catch {
      invalidReason ??= "current_browser_plugin_pair_not_found";
      continue;
    }
    if (!isPathWithin(chromeVersionRoot, realClientPath) || !isPathWithin(browserVersionRoot, realServicePath)) {
      invalidReason ??= "current_browser_plugin_path_escape";
      continue;
    }
    valid.push({ build, chromeVersionRoot });
  }

  if (valid.length > 1) {
    return unavailable("current_chrome_plugin_cache_ambiguous", "codex-plugin-cache-singleton", {
      candidateCount: valid.length,
    });
  }
  if (valid.length === 0) {
    return unavailable(invalidReason ?? "current_browser_plugin_pair_not_found", "codex-plugin-cache-singleton");
  }
  return {
    status: "ok",
    id: CHROME_PLUGIN_ID,
    name: "chrome",
    localVersion: valid[0].build,
    source: "codex-plugin-cache-singleton",
    sourcePath: valid[0].chromeVersionRoot,
  };
}
