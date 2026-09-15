import { execFile } from "node:child_process";
import { access, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FIXED_GIT = String.raw`C:\Program Files\Git\cmd\git.exe`;
const ACTIVE_REPOS = new Set();
const RESULT_VALUES = new Set(["PASS", "NO_CHANGES", "REFUSED", "FAILED"]);

class GitPrimitiveRefusal extends Error {
  constructor(message, code = "REFUSED") {
    super(message);
    this.name = "GitPrimitiveRefusal";
    this.code = code;
  }
}

function norm(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function cleanStatus(statusText) {
  return String(statusText ?? "").replace(/\r\n/g, "\n").replace(/\n+$/g, "");
}

function parseStatus(statusText) {
  const status = cleanStatus(statusText);
  const lines = status ? status.split("\n") : [];
  const branchLine = lines.find((line) => line.startsWith("## ")) ?? "";
  const branchText = branchLine.slice(3);
  let branch = branchText;
  if (branchText.startsWith("HEAD ")) {
    branch = "HEAD";
  } else {
    branch = branchText.split("...")[0].split(" ")[0] || null;
  }
  const changes = lines.filter((line) => !line.startsWith("## ") && line.trim().length > 0);
  return { status, branch, changes };
}

function validateMessage(message) {
  if (typeof message !== "string") throw new GitPrimitiveRefusal("commit message must be a string", "INVALID_MESSAGE");
  if (message.length < 1 || message.length > 512) {
    throw new GitPrimitiveRefusal("commit message must contain 1..512 characters", "INVALID_MESSAGE");
  }
  if (message.includes("\0") || message.includes("\r") || message.includes("\n")) {
    throw new GitPrimitiveRefusal("commit message must be a single line and may not contain NUL/CR/LF", "INVALID_MESSAGE");
  }
  return message;
}


const GITHUB_BRANCH_RE = /^[A-Za-z0-9._/-]{1,128}$/;
const GITHUB_REMOTE_RE = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\.git$/;

function validateBranch(value) {
  if (typeof value !== "string" || !GITHUB_BRANCH_RE.test(value) || value.includes("..") || value.startsWith("/") || value.endsWith("/")) {
    throw new GitPrimitiveRefusal("sync branch is invalid", "SYNC_POLICY_REFUSED");
  }
  return value;
}

function validateRemoteName(value) {
  if (value !== "origin") {
    throw new GitPrimitiveRefusal("only remote name 'origin' is supported", "SYNC_POLICY_REFUSED");
  }
  return value;
}

function validateGitHubRemoteUrl(value, expectedOwner) {
  if (typeof value !== "string" || typeof expectedOwner !== "string" || !expectedOwner) {
    throw new GitPrimitiveRefusal("GitHub remote policy is invalid", "SYNC_POLICY_REFUSED");
  }
  const match = GITHUB_REMOTE_RE.exec(value);
  if (!match || match[1].toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new GitPrimitiveRefusal(
      `remote must be an HTTPS GitHub repository owned by ${expectedOwner}`,
      "SYNC_POLICY_REFUSED"
    );
  }
  return value;
}

function parseSyncConfig(raw, { repoRoot, expectedOwner }) {
  if (!raw || typeof raw !== "object" || raw.version !== 1 || typeof raw.repos !== "object" || raw.repos === null) {
    throw new GitPrimitiveRefusal("Git sync config must be version 1 with a repos object", "SYNC_POLICY_REFUSED");
  }
  if (raw.github_owner !== expectedOwner) {
    throw new GitPrimitiveRefusal("Git sync config owner does not match fixed owner", "SYNC_POLICY_REFUSED");
  }

  const normalizedRoot = norm(repoRoot);
  let policy = null;
  for (const [configuredRoot, candidate] of Object.entries(raw.repos)) {
    if (norm(configuredRoot) === normalizedRoot) {
      policy = candidate;
      break;
    }
  }
  if (!policy) return null;
  if (!policy || typeof policy !== "object") {
    throw new GitPrimitiveRefusal("repo sync policy must be an object", "SYNC_POLICY_REFUSED");
  }

  const mode = policy.mode;
  if (!["probe", "push"].includes(mode)) {
    throw new GitPrimitiveRefusal("repo sync mode must be probe or push", "SYNC_POLICY_REFUSED");
  }
  const branch = validateBranch(policy.branch ?? "main");
  const remoteName = validateRemoteName(policy.remote_name ?? "origin");
  const remoteUrl = policy.remote_url == null
    ? null
    : validateGitHubRemoteUrl(policy.remote_url, expectedOwner);

  const probeUrls = Array.isArray(policy.probe_urls) ? policy.probe_urls : [];
  if (probeUrls.length > 20) {
    throw new GitPrimitiveRefusal("probe_urls exceeds 20 entries", "SYNC_POLICY_REFUSED");
  }
  const validatedProbeUrls = probeUrls.map((url) => validateGitHubRemoteUrl(url, expectedOwner));

  if (mode === "push" && !remoteUrl) {
    throw new GitPrimitiveRefusal("push mode requires remote_url", "SYNC_POLICY_REFUSED");
  }
  return {
    mode,
    branch,
    remoteName,
    remoteUrl,
    probeUrls: validatedProbeUrls,
  };
}

async function loadSyncPolicy({ syncConfigPath, repoRoot, expectedOwner }) {
  if (!syncConfigPath) return null;

  let info;
  try {
    info = await lstat(syncConfigPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > 128 * 1024) {
    throw new GitPrimitiveRefusal("Git sync config must be a regular file <=128 KiB", "SYNC_POLICY_REFUSED");
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(syncConfigPath, "utf8"));
  } catch (error) {
    throw new GitPrimitiveRefusal(`Git sync config is invalid JSON: ${error.message}`, "SYNC_POLICY_REFUSED");
  }
  return parseSyncConfig(parsed, { repoRoot, expectedOwner });
}

function sameArgv(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function assertAllowedGitArgv(argv) {
  if (!Array.isArray(argv) || !argv.length || !argv.every((value) => typeof value === "string")) {
    throw new GitPrimitiveRefusal("Git argv must be a non-empty string array", "GIT_ARGV_REFUSED");
  }

  const fixed = [
    ["status", "--short", "--branch"],
    ["diff", "--check"],
    ["add", "--all"],
    ["rev-parse", "HEAD"],
    ["log", "-1", "--pretty=%s"],
  ];
  if (fixed.some((candidate) => sameArgv(argv, candidate))) return argv;

  if (argv.length === 3 && argv[0] === "commit" && argv[1] === "-m") {
    validateMessage(argv[2]);
    return argv;
  }

  throw new GitPrimitiveRefusal(`Git argv is outside model_free_git_commit allowlist: ${JSON.stringify(argv)}`, "GIT_ARGV_REFUSED");
}

export async function resolveFixedGitExecutable() {
  if (process.platform !== "win32") {
    throw new GitPrimitiveRefusal("model_free_git_commit is currently pinned to Windows git.exe", "GIT_EXECUTABLE_REFUSED");
  }
  await access(FIXED_GIT);
  const resolved = await realpath(FIXED_GIT);
  if (path.basename(resolved).toLowerCase() !== "git.exe" || norm(resolved) !== norm(FIXED_GIT)) {
    throw new GitPrimitiveRefusal(`fixed Git executable did not resolve exactly to ${FIXED_GIT}`, "GIT_EXECUTABLE_REFUSED");
  }
  return resolved;
}

function gitEnvironment(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_EXEC_PATH",
    "GIT_CONFIG_PARAMETERS",
    "GIT_EXTERNAL_DIFF",
    "GIT_DIFF_OPTS",
    "GIT_TRACE",
    "GIT_TRACE2",
    "GIT_TRACE2_EVENT",
    "GIT_TRACE_PERFORMANCE",
    "GIT_TRACE_SETUP",
    "GIT_TRACE_PACKET",
    "GIT_TRACE_CURL",
  ]) delete env[key];

  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_PAGER: "cat",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "NUL",
    GIT_CONFIG_KEY_1: "commit.gpgSign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "core.fsmonitor",
    GIT_CONFIG_VALUE_2: "false",
    GIT_CONFIG_KEY_3: "core.attributesFile",
    GIT_CONFIG_VALUE_3: "NUL",
  };
}

async function runGit({ gitExecutable, cwd, argv, baseEnv = process.env }) {
  assertAllowedGitArgv(argv);
  try {
    const result = await execFileAsync(gitExecutable, argv, {
      cwd,
      env: gitEnvironment(baseEnv),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 256 * 1024,
      shell: false,
    });
    return { exitCode: 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (error) {
    const stdout = String(error?.stdout ?? "");
    const stderr = String(error?.stderr ?? error?.message ?? "");
    const exitCode = Number.isInteger(error?.code) ? error.code : 1;
    return { exitCode, stdout, stderr };
  }
}


function networkGitEnvironment(baseEnv, { expectedOwner, dpapiStorePath }) {
  const env = gitEnvironment(baseEnv);
  return {
    ...env,
    GCM_CREDENTIAL_STORE: "dpapi",
    GCM_DPAPI_STORE_PATH: dpapiStorePath,
    GCM_GITHUB_AUTHMODES: "oauth",
    GCM_INTERACTIVE: "Never",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "7",
    GIT_CONFIG_KEY_4: "http.sslBackend",
    GIT_CONFIG_VALUE_4: "openssl",
    GIT_CONFIG_KEY_5: "credential.helper",
    GIT_CONFIG_VALUE_5: "manager",
    GIT_CONFIG_KEY_6: "credential.https://github.com.username",
    GIT_CONFIG_VALUE_6: expectedOwner,
  };
}

function assertAllowedNetworkGitArgv(argv, { expectedOwner, branch }) {
  if (!Array.isArray(argv) || !argv.length || !argv.every((value) => typeof value === "string")) {
    throw new GitPrimitiveRefusal("network Git argv must be a non-empty string array", "GIT_NETWORK_ARGV_REFUSED");
  }

  if (
    argv.length === 4 &&
    argv[0] === "ls-remote" &&
    argv[2] === "HEAD" &&
    argv[3] === `refs/heads/${branch}`
  ) {
    validateGitHubRemoteUrl(argv[1], expectedOwner);
    return argv;
  }
  if (sameArgv(argv, ["remote", "get-url", "origin"])) return argv;
  if (
    argv.length === 4 &&
    argv[0] === "remote" &&
    argv[1] === "add" &&
    argv[2] === "origin"
  ) {
    validateGitHubRemoteUrl(argv[3], expectedOwner);
    return argv;
  }
  if (sameArgv(argv, ["fetch", "--no-tags", "origin", branch])) return argv;
  if (sameArgv(argv, ["merge-base", "--is-ancestor", `origin/${branch}`, "HEAD"])) return argv;
  if (sameArgv(argv, ["push", "--porcelain", "--set-upstream", "origin", branch])) return argv;
  if (sameArgv(argv, ["rev-parse", "HEAD"])) return argv;

  throw new GitPrimitiveRefusal(
    `Git argv is outside host-side sync allowlist: ${JSON.stringify(argv)}`,
    "GIT_NETWORK_ARGV_REFUSED"
  );
}

async function runNetworkGit({
  gitExecutable,
  cwd,
  argv,
  expectedOwner,
  branch,
  dpapiStorePath,
  baseEnv = process.env,
}) {
  assertAllowedNetworkGitArgv(argv, { expectedOwner, branch });
  try {
    const result = await execFileAsync(gitExecutable, argv, {
      cwd,
      env: networkGitEnvironment(baseEnv, { expectedOwner, dpapiStorePath }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 512 * 1024,
      shell: false,
    });
    return {
      exitCode: 0,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? error?.message ?? ""),
    };
  }
}

function parseLsRemote(stdout, branch) {
  let head = null;
  let branchHead = null;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const match = /^([0-9a-f]{40,64})\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    if (match[2] === "HEAD") head = match[1];
    if (match[2] === `refs/heads/${branch}`) branchHead = match[1];
  }
  return { head, branchHead };
}

async function probeGitHubRemote({
  gitExecutable,
  repoRoot,
  url,
  expectedOwner,
  branch,
  dpapiStorePath,
  baseEnv,
}) {
  const probe = await runNetworkGit({
    gitExecutable,
    cwd: repoRoot,
    argv: ["ls-remote", url, "HEAD", `refs/heads/${branch}`],
    expectedOwner,
    branch,
    dpapiStorePath,
    baseEnv,
  });
  if (probe.exitCode !== 0) {
    return {
      url,
      accessible: false,
      head: null,
      branch_head: null,
      error: "REMOTE_UNAVAILABLE_OR_UNAUTHORIZED",
    };
  }
  const refs = parseLsRemote(probe.stdout, branch);
  return {
    url,
    accessible: true,
    head: refs.head,
    branch_head: refs.branchHead,
    error: null,
  };
}

async function performHostGitSync({
  gitExecutable,
  repoRoot,
  branch,
  policy,
  expectedOwner,
  dpapiStorePath,
  baseEnv,
}) {
  const probes = [];
  const probeSet = new Set(policy.probeUrls);
  if (policy.remoteUrl) probeSet.add(policy.remoteUrl);
  for (const url of probeSet) {
    probes.push(
      await probeGitHubRemote({
        gitExecutable,
        repoRoot,
        url,
        expectedOwner,
        branch: policy.branch,
        dpapiStorePath,
        baseEnv,
      })
    );
  }

  if (policy.mode === "probe") {
    return {
      mode: "probe",
      status: "PROBED",
      probes,
      pushed: false,
      local_head: null,
      remote_head: null,
    };
  }

  if (branch !== policy.branch) {
    return {
      mode: "push",
      status: "REFUSED_BRANCH",
      probes,
      pushed: false,
      local_head: null,
      remote_head: null,
    };
  }

  const remoteProbe = probes.find((item) => item.url === policy.remoteUrl);
  if (!remoteProbe?.accessible) {
    return {
      mode: "push",
      status: "REMOTE_UNAVAILABLE",
      probes,
      pushed: false,
      local_head: null,
      remote_head: null,
    };
  }

  const existingRemote = await runNetworkGit({
    gitExecutable,
    cwd: repoRoot,
    argv: ["remote", "get-url", policy.remoteName],
    expectedOwner,
    branch: policy.branch,
    dpapiStorePath,
    baseEnv,
  });
  if (existingRemote.exitCode === 0) {
    const existingUrl = existingRemote.stdout.trim();
    if (existingUrl !== policy.remoteUrl) {
      return {
        mode: "push",
        status: "REFUSED_REMOTE_MISMATCH",
        probes,
        pushed: false,
        local_head: null,
        remote_head: remoteProbe.branch_head,
      };
    }
  } else {
    const added = await runNetworkGit({
      gitExecutable,
      cwd: repoRoot,
      argv: ["remote", "add", policy.remoteName, policy.remoteUrl],
      expectedOwner,
      branch: policy.branch,
      dpapiStorePath,
      baseEnv,
    });
    if (added.exitCode !== 0) {
      return {
        mode: "push",
        status: "REMOTE_ADD_FAILED",
        probes,
        pushed: false,
        local_head: null,
        remote_head: remoteProbe.branch_head,
      };
    }
  }

  if (remoteProbe.branch_head) {
    const fetched = await runNetworkGit({
      gitExecutable,
      cwd: repoRoot,
      argv: ["fetch", "--no-tags", policy.remoteName, policy.branch],
      expectedOwner,
      branch: policy.branch,
      dpapiStorePath,
      baseEnv,
    });
    if (fetched.exitCode !== 0) {
      return {
        mode: "push",
        status: "FETCH_FAILED",
        probes,
        pushed: false,
        local_head: null,
        remote_head: remoteProbe.branch_head,
      };
    }

    const ancestry = await runNetworkGit({
      gitExecutable,
      cwd: repoRoot,
      argv: ["merge-base", "--is-ancestor", `origin/${policy.branch}`, "HEAD"],
      expectedOwner,
      branch: policy.branch,
      dpapiStorePath,
      baseEnv,
    });
    if (ancestry.exitCode !== 0) {
      return {
        mode: "push",
        status: "REFUSED_DIVERGED_OR_BEHIND",
        probes,
        pushed: false,
        local_head: null,
        remote_head: remoteProbe.branch_head,
      };
    }
  }

  const localHeadResult = await runNetworkGit({
    gitExecutable,
    cwd: repoRoot,
    argv: ["rev-parse", "HEAD"],
    expectedOwner,
    branch: policy.branch,
    dpapiStorePath,
    baseEnv,
  });
  const localHead = localHeadResult.stdout.trim();
  if (
    localHeadResult.exitCode !== 0 ||
    !/^[0-9a-f]{40,64}$/i.test(localHead)
  ) {
    return {
      mode: "push",
      status: "LOCAL_HEAD_FAILED",
      probes,
      pushed: false,
      local_head: null,
      remote_head: remoteProbe.branch_head,
    };
  }

  const pushed = await runNetworkGit({
    gitExecutable,
    cwd: repoRoot,
    argv: ["push", "--porcelain", "--set-upstream", policy.remoteName, policy.branch],
    expectedOwner,
    branch: policy.branch,
    dpapiStorePath,
    baseEnv,
  });
  if (pushed.exitCode !== 0) {
    return {
      mode: "push",
      status: "PUSH_FAILED",
      probes,
      pushed: false,
      local_head: localHead,
      remote_head: remoteProbe.branch_head,
    };
  }

  const verified = await probeGitHubRemote({
    gitExecutable,
    repoRoot,
    url: policy.remoteUrl,
    expectedOwner,
    branch: policy.branch,
    dpapiStorePath,
    baseEnv,
  });
  const matched = verified.accessible && verified.branch_head === localHead;
  return {
    mode: "push",
    status: matched ? "SYNCED" : "REMOTE_READBACK_MISMATCH",
    probes,
    pushed: true,
    local_head: localHead,
    remote_head: verified.branch_head,
  };
}

async function rootIgnoredUntrackedDirectories({ repoRoot, gitExecutable, baseEnv = process.env }) {
  const ignored = new Set();
  const ignoreFile = path.join(repoRoot, ".gitignore");
  try {
    const info = await stat(ignoreFile);
    if (!info.isFile() || info.size > 1024 * 1024) return ignored;
    const text = await readFile(ignoreFile, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith("!")) continue;
      const match = line.match(/^\/?([^*?\[\]\\/]+)\/$/);
      if (!match) continue;
      const name = match[1];
      const tracked = await execFileAsync(gitExecutable, ["ls-files", "--", name], {
        cwd: repoRoot,
        env: gitEnvironment(baseEnv),
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        shell: false,
      });
      if (!String(tracked.stdout ?? "").trim()) ignored.add(name);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new GitPrimitiveRefusal(
        `failed to prove ignored directories are untracked: ${String(error?.message ?? error)}`,
        "ATTRIBUTE_SCAN_REFUSED"
      );
    }
  }
  return ignored;
}

async function assertNoExternalGitDrivers({ repoRoot, gitExecutable, baseEnv = process.env }) {
  const attributeFiles = [];
  const queue = [repoRoot];
  const ignoredUntrackedRoots = await rootIgnoredUntrackedDirectories({
    repoRoot,
    gitExecutable,
    baseEnv,
  });
  let directories = 0;
  let totalAttributeBytes = 0;

  while (queue.length) {
    const current = queue.shift();
    directories += 1;
    if (directories > 5000) {
      throw new GitPrimitiveRefusal("repository attribute scan exceeded the bounded directory limit", "ATTRIBUTE_SCAN_REFUSED");
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (current === repoRoot && ignoredUntrackedRoots.has(entry.name)) continue;
        queue.push(target);
        continue;
      }
      if (entry.name !== ".gitattributes") continue;
      if (entry.isSymbolicLink()) {
        throw new GitPrimitiveRefusal("symlinked .gitattributes is not supported by this bounded primitive", "ATTRIBUTE_SCAN_REFUSED");
      }
      if (entry.isFile()) attributeFiles.push(target);
    }
  }

  const infoAttributes = path.join(repoRoot, ".git", "info", "attributes");
  try {
    const info = await lstat(infoAttributes);
    if (info.isSymbolicLink()) {
      throw new GitPrimitiveRefusal("symlinked .git/info/attributes is not supported", "ATTRIBUTE_SCAN_REFUSED");
    }
    if (info.isFile()) attributeFiles.push(infoAttributes);
  } catch (error) {
    if (error instanceof GitPrimitiveRefusal) throw error;
    if (error?.code !== "ENOENT") throw error;
  }

  for (const file of attributeFiles) {
    const info = await stat(file);
    if (info.size > 1024 * 1024) {
      throw new GitPrimitiveRefusal("Git attributes file exceeds the 1 MiB safety limit", "ATTRIBUTE_SCAN_REFUSED");
    }
    totalAttributeBytes += info.size;
    if (totalAttributeBytes > 4 * 1024 * 1024) {
      throw new GitPrimitiveRefusal("Git attributes scan exceeds the 4 MiB safety limit", "ATTRIBUTE_SCAN_REFUSED");
    }

    const text = await readFile(file, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (/(?:^|\s)(?:filter|diff)(?:=[^\s]+|(?=\s|$))/i.test(line)) {
        throw new GitPrimitiveRefusal(
          `external Git filter/diff attributes are not supported by model_free_git_commit: ${file}`,
          "EXTERNAL_GIT_DRIVER_REFUSED"
        );
      }
    }
  }
}

async function canonicalTrustedRepo({ authorityExecutor, cwd }) {
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new GitPrimitiveRefusal("cwd must be a non-empty string", "INVALID_CWD");
  }

  // Trust is authoritative and is resolved before any host Git process is started.
  const authority = await authorityExecutor.resolveAuthority({ cwd, access: "inherit", timeoutMs: 10_000 });
  if (!authority?.trustedAncestor) {
    throw new GitPrimitiveRefusal("cwd is not covered by an explicitly trusted Codex root", "UNTRUSTED_CWD");
  }
  if (authority.permissionProfile !== ":workspace" || authority.permissionCeiling !== ":workspace") {
    throw new GitPrimitiveRefusal(
      `model_free_git_commit requires the existing :workspace authority ceiling; got profile=${String(authority.permissionProfile)} ceiling=${String(authority.permissionCeiling)}`,
      "AUTHORITY_REFUSED"
    );
  }

  const repoRoot = await realpath(path.resolve(cwd));
  const repoInfo = await stat(repoRoot);
  if (!repoInfo.isDirectory()) throw new GitPrimitiveRefusal("cwd is not a directory", "INVALID_CWD");

  const trustedRoot = await realpath(authority.trustedAncestor);
  if (!isInside(trustedRoot, repoRoot)) {
    throw new GitPrimitiveRefusal("resolved repo root escapes the trusted Codex root", "TRUST_BOUNDARY_REFUSED");
  }

  const dotGit = path.join(repoRoot, ".git");
  let dotGitInfo;
  try {
    dotGitInfo = await stat(dotGit);
  } catch {
    throw new GitPrimitiveRefusal("cwd must be the repository root and contain a .git directory", "NOT_REPO_ROOT");
  }
  if (!dotGitInfo.isDirectory()) {
    throw new GitPrimitiveRefusal("Git worktrees/submodules with a .git file are not supported by this primitive", "GITDIR_REFUSED");
  }

  const gitDir = await realpath(dotGit);
  if (!isInside(repoRoot, gitDir) || !isInside(trustedRoot, gitDir)) {
    throw new GitPrimitiveRefusal("Git metadata directory escapes the trusted repository root", "GITDIR_REFUSED");
  }

  await assertNoExternalGitDrivers({
    repoRoot,
    gitExecutable: FIXED_GIT,
    baseEnv: process.env,
  });
  return { repoRoot, trustedRoot, authority };
}

function exactResult({
  repoRoot = null,
  branch = null,
  preStatus = "",
  commitSha = null,
  commitMessage = null,
  postStatus = "",
  sync = null,
  result,
}) {
  if (!RESULT_VALUES.has(result)) throw new Error(`invalid primitive result: ${result}`);
  return {
    repo_root: repoRoot,
    branch,
    pre_status: preStatus,
    commit_sha: commitSha,
    commit_message: commitMessage,
    post_status: postStatus,
    sync,
    result,
  };
}

function logRefusal(error) {
  const code = typeof error?.code === "string" ? error.code : "REFUSED";
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[model_free_git_commit] ${code}: ${message}`);
}

export function createModelFreeGitCommitPrimitive({
  authorityExecutor,
  gitExecutable,
  baseEnv = process.env,
  syncConfigPath = null,
  expectedOwner = null,
  dpapiStorePath = null,
}) {
  if (!authorityExecutor || typeof authorityExecutor.resolveAuthority !== "function") {
    throw new TypeError("model_free_git_commit requires Codex authorityExecutor.resolveAuthority");
  }
  if (typeof gitExecutable !== "string" || !gitExecutable) {
    throw new TypeError("model_free_git_commit requires a fixed git.exe path");
  }
  if (norm(gitExecutable) !== norm(FIXED_GIT) || path.basename(gitExecutable).toLowerCase() !== "git.exe") {
    throw new TypeError(`model_free_git_commit executable is pinned to ${FIXED_GIT}`);
  }
  if (syncConfigPath !== null) {
    if (typeof syncConfigPath !== "string" || !syncConfigPath) {
      throw new TypeError("syncConfigPath must be null or a fixed non-empty path");
    }
    if (typeof expectedOwner !== "string" || !expectedOwner) {
      throw new TypeError("host-side Git sync requires expectedOwner");
    }
    if (typeof dpapiStorePath !== "string" || !dpapiStorePath) {
      throw new TypeError("host-side Git sync requires dpapiStorePath");
    }
  }

  return async function modelFreeGitCommit({ cwd, message }) {
    let repoRoot = null;
    let branch = null;
    let preStatus = "";
    let postStatus = "";
    let syncPolicy = null;
    let sync = null;
    let locked = false;

    try {
      const validatedMessage = validateMessage(message);
      const trusted = await canonicalTrustedRepo({ authorityExecutor, cwd });
      repoRoot = trusted.repoRoot;
      const lockKey = norm(repoRoot);
      if (ACTIVE_REPOS.has(lockKey)) {
        throw new GitPrimitiveRefusal("another model_free_git_commit call is already active for this repository", "REPO_BUSY");
      }
      ACTIVE_REPOS.add(lockKey);
      locked = true;

      syncPolicy = await loadSyncPolicy({
        syncConfigPath,
        repoRoot,
        expectedOwner,
      });

      const pre = await runGit({
        gitExecutable,
        cwd: repoRoot,
        argv: ["status", "--short", "--branch"],
        baseEnv,
      });
      if (pre.exitCode !== 0) {
        return exactResult({ repoRoot, preStatus: cleanStatus(pre.stdout), postStatus: cleanStatus(pre.stdout), result: "FAILED" });
      }
      const parsedPre = parseStatus(pre.stdout);
      preStatus = parsedPre.status;
      branch = parsedPre.branch;

      if (parsedPre.changes.length === 0) {
        if (syncPolicy) {
          sync = await performHostGitSync({
            gitExecutable,
            repoRoot,
            branch,
            policy: syncPolicy,
            expectedOwner,
            dpapiStorePath,
            baseEnv,
          });
        }
        const result =
          syncPolicy?.mode === "push" && sync?.status !== "SYNCED"
            ? "FAILED"
            : "NO_CHANGES";
        return exactResult({
          repoRoot,
          branch,
          preStatus,
          postStatus: preStatus,
          sync,
          result,
        });
      }

      const diffCheck = await runGit({
        gitExecutable,
        cwd: repoRoot,
        argv: ["diff", "--check"],
        baseEnv,
      });
      if (diffCheck.exitCode !== 0) {
        return exactResult({
          repoRoot,
          branch,
          preStatus,
          postStatus: preStatus,
          result: "REFUSED",
        });
      }

      const add = await runGit({
        gitExecutable,
        cwd: repoRoot,
        argv: ["add", "--all"],
        baseEnv,
      });
      if (add.exitCode !== 0) {
        const after = await runGit({ gitExecutable, cwd: repoRoot, argv: ["status", "--short", "--branch"], baseEnv });
        postStatus = after.exitCode === 0 ? parseStatus(after.stdout).status : preStatus;
        return exactResult({ repoRoot, branch, preStatus, postStatus, result: "FAILED" });
      }

      const commit = await runGit({
        gitExecutable,
        cwd: repoRoot,
        argv: ["commit", "-m", validatedMessage],
        baseEnv,
      });
      if (commit.exitCode !== 0) {
        const after = await runGit({ gitExecutable, cwd: repoRoot, argv: ["status", "--short", "--branch"], baseEnv });
        postStatus = after.exitCode === 0 ? parseStatus(after.stdout).status : preStatus;
        return exactResult({ repoRoot, branch, preStatus, postStatus, result: "FAILED" });
      }

      const sha = await runGit({
        gitExecutable,
        cwd: repoRoot,
        argv: ["rev-parse", "HEAD"],
        baseEnv,
      });
      if (sha.exitCode !== 0 || !/^[0-9a-f]{40,64}$/i.test(sha.stdout.trim())) {
        const after = await runGit({ gitExecutable, cwd: repoRoot, argv: ["status", "--short", "--branch"], baseEnv });
        postStatus = after.exitCode === 0 ? parseStatus(after.stdout).status : preStatus;
        return exactResult({ repoRoot, branch, preStatus, postStatus, result: "FAILED" });
      }

      const subject = await runGit({
        gitExecutable,
        cwd: repoRoot,
        argv: ["log", "-1", "--pretty=%s"],
        baseEnv,
      });
      if (subject.exitCode !== 0 || subject.stdout.replace(/\r?\n$/, "") !== validatedMessage) {
        const after = await runGit({ gitExecutable, cwd: repoRoot, argv: ["status", "--short", "--branch"], baseEnv });
        postStatus = after.exitCode === 0 ? parseStatus(after.stdout).status : preStatus;
        return exactResult({
          repoRoot,
          branch,
          preStatus,
          commitSha: sha.stdout.trim(),
          postStatus,
          result: "FAILED",
        });
      }

      const post = await runGit({
        gitExecutable,
        cwd: repoRoot,
        argv: ["status", "--short", "--branch"],
        baseEnv,
      });
      if (post.exitCode !== 0) {
        return exactResult({
          repoRoot,
          branch,
          preStatus,
          commitSha: sha.stdout.trim(),
          commitMessage: validatedMessage,
          postStatus: cleanStatus(post.stdout),
          result: "FAILED",
        });
      }

      const parsedPost = parseStatus(post.stdout);
      postStatus = parsedPost.status;
      if (parsedPost.changes.length !== 0) {
        return exactResult({
          repoRoot,
          branch,
          preStatus,
          commitSha: sha.stdout.trim(),
          commitMessage: validatedMessage,
          postStatus,
          result: "FAILED",
        });
      }

      if (syncPolicy) {
        sync = await performHostGitSync({
          gitExecutable,
          repoRoot,
          branch,
          policy: syncPolicy,
          expectedOwner,
          dpapiStorePath,
          baseEnv,
        });
      }
      const result =
        syncPolicy?.mode === "push" && sync?.status !== "SYNCED"
          ? "FAILED"
          : "PASS";
      return exactResult({
        repoRoot,
        branch,
        preStatus,
        commitSha: sha.stdout.trim(),
        commitMessage: validatedMessage,
        postStatus,
        sync,
        result,
      });
    } catch (error) {
      logRefusal(error);
      const result = error instanceof GitPrimitiveRefusal || error?.code === "PERMISSION_APPROVAL_REQUIRED" ? "REFUSED" : "FAILED";
      return exactResult({ repoRoot, branch, preStatus, postStatus: postStatus || preStatus, sync, result });
    } finally {
      if (locked && repoRoot) ACTIVE_REPOS.delete(norm(repoRoot));
    }
  };
}
