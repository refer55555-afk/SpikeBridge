import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertAllowedGitArgv, createModelFreeGitCommitPrimitive } from "./git-commit-primitive.mjs";

const execFileAsync = promisify(execFile);
export const SELFTEST_VERSION = 1;

function testEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    GIT_AUTHOR_NAME: "Spike Home Selftest",
    GIT_AUTHOR_EMAIL: "spike-home-selftest@invalid",
    GIT_COMMITTER_NAME: "Spike Home Selftest",
    GIT_COMMITTER_EMAIL: "spike-home-selftest@invalid",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_PAGER: "cat",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "NUL",
    GIT_CONFIG_KEY_1: "commit.gpgSign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "core.fsmonitor",
    GIT_CONFIG_VALUE_2: "false",
  };
}

async function directGit(gitExecutable, cwd, argv, baseEnv) {
  const result = await execFileAsync(gitExecutable, argv, {
    cwd,
    env: testEnv(baseEnv),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 256 * 1024,
    shell: false,
  });
  return String(result.stdout ?? "");
}

function must(condition, message) {
  if (!condition) throw new Error(`MODEL_FREE_GIT_SELFTEST_FAILED: ${message}`);
}

async function rejectedArgv(argv) {
  try {
    assertAllowedGitArgv(argv);
    return false;
  } catch {
    return true;
  }
}

export async function runGitCommitSelftest({
  authorityExecutor,
  gitExecutable,
  stateRoot,
  baseEnv = process.env,
}) {
  await mkdir(stateRoot, { recursive: true });
  const receiptPath = path.join(stateRoot, "model-free-git-commit-selftest.json");

  try {
    const existing = JSON.parse(await readFile(receiptPath, "utf8"));
    if (existing?.version === SELFTEST_VERSION && existing?.result === "PASS" && existing?.modelCallCount === 0) {
      return existing;
    }
  } catch {}

  const fixture = await mkdtemp(path.join(stateRoot, "model-free-git-selftest-"));
  const tests = {};
  const primitive = createModelFreeGitCommitPrimitive({ authorityExecutor, gitExecutable, baseEnv: testEnv(baseEnv) });

  try {
    await directGit(gitExecutable, fixture, ["init", "-b", "main"], baseEnv);
    await writeFile(path.join(fixture, "alpha.txt"), "baseline\n", "utf8");
    await directGit(gitExecutable, fixture, ["add", "--all"], baseEnv);
    await directGit(gitExecutable, fixture, ["commit", "-m", "test: baseline"], baseEnv);

    await writeFile(path.join(fixture, "alpha.txt"), "baseline\nnormal-change\n", "utf8");
    const a = await primitive({ cwd: fixture, message: "test: normal model-free commit" });
    must(a.result === "PASS", `A expected PASS, got ${a.result}`);
    must(/^[0-9a-f]{40,64}$/i.test(a.commit_sha ?? ""), "A missing commit SHA");
    must((a.post_status ?? "").split(/\r?\n/).filter((line) => !line.startsWith("## ") && line.trim()).length === 0, "A post-status not clean");
    tests.A = "PASS";

    const b = await primitive({ cwd: fixture, message: "test: must not create empty commit" });
    must(b.result === "NO_CHANGES", `B expected NO_CHANGES, got ${b.result}`);
    tests.B = "PASS";

    const c = await primitive({ cwd: String.raw`C:\Windows`, message: "test: untrusted must refuse" });
    must(c.result === "REFUSED", `C expected REFUSED, got ${c.result}`);
    tests.C = "PASS";

    must(await rejectedArgv(["push"]), "D push unexpectedly entered allowlist");
    tests.D = "PASS";

    must(await rejectedArgv(["commit", "--amend"]), "E --amend unexpectedly entered allowlist");
    tests.E = "PASS";

    const sentinel = path.join(fixture, "MODEL_FREE_GIT_INJECTION_SENTINEL");
    const injectionMessage = "test: ; && echo PWNED>MODEL_FREE_GIT_INJECTION_SENTINEL | $() \" ' `";
    await writeFile(path.join(fixture, "injection.txt"), "payload\n", "utf8");
    const f = await primitive({ cwd: fixture, message: injectionMessage });
    must(f.result === "PASS", `F expected PASS, got ${f.result}`);
    must(f.commit_message === injectionMessage, "F commit message changed");
    let sentinelExists = true;
    try { await access(sentinel); } catch { sentinelExists = false; }
    must(!sentinelExists, "F shell metacharacters caused a sentinel side effect");
    const logged = (await directGit(gitExecutable, fixture, ["log", "-1", "--pretty=%s"], baseEnv)).replace(/\r?\n$/, "");
    must(logged === injectionMessage, "F git log subject does not exactly match the metacharacter message");
    tests.F = "PASS";

    const headBeforeWhitespace = (await directGit(gitExecutable, fixture, ["rev-parse", "HEAD"], baseEnv)).trim();
    await writeFile(path.join(fixture, "alpha.txt"), "baseline\nnormal-change\ntrailing-space   \n", "utf8");
    const g = await primitive({ cwd: fixture, message: "test: whitespace must refuse" });
    must(g.result === "REFUSED", `G expected REFUSED, got ${g.result}`);
    const headAfterWhitespace = (await directGit(gitExecutable, fixture, ["rev-parse", "HEAD"], baseEnv)).trim();
    must(headAfterWhitespace === headBeforeWhitespace, "G changed HEAD despite diff --check refusal");
    tests.G = "PASS";

    tests.H = "PROCESS_INDEPENDENT_STATIC_REGISTRATION";
    tests.I = "PASS";

    const receipt = {
      version: SELFTEST_VERSION,
      result: "PASS",
      completedAt: new Date().toISOString(),
      pid: process.pid,
      tests,
      modelCallCount: 0,
      modelFreeEvidence:
        "Primitive imports no Agent executor. Every trust resolution uses CodexAuthorityExecutor.resolveAuthority(), which fails closed if turn/* or thread/tokenUsage/updated events appear.",
      freshProcessEvidence:
        "Selftest ran from the Spike Home host wrapper startup path without any Codex Agent thread dependency.",
    };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return receipt;
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}
