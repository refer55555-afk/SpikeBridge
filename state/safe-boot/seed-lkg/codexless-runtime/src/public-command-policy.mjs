const CODEX_EXECUTABLE_RE = /^codex(?:\.(?:exe|com|cmd|bat|ps1))?$/i;
const CODEX_COMMAND_TOKEN_RE = /(?:^|[\s"'`;&|(),])(?:[^\s"'`;&|(),]*[\\/])?codex(?:\.(?:exe|com|cmd|bat|ps1))?(?=$|[\s"'`;&|(),])/i;

const COMMAND_STRING_WRAPPERS = new Set([
  "cmd",
  "powershell",
  "pwsh",
  "sh",
  "bash",
  "zsh",
  "fish",
]);

const INLINE_CODE_WRAPPERS = new Set([
  "node",
  "nodejs",
  "python",
  "python3",
  "py",
  "ruby",
  "perl",
  "deno",
  "bun",
]);

const EXECUTABLE_LAUNCH_WRAPPERS = new Set([
  "env",
  "sudo",
  "wsl",
  "nohup",
  "timeout",
  "nice",
  "stdbuf",
  "xargs",
  "npx",
  "npm",
  "pnpm",
  "yarn",
]);

function portableBasename(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return (index >= 0 ? normalized.slice(index + 1) : normalized).toLowerCase();
}

function executableStem(value) {
  return portableBasename(value).replace(/\.(?:exe|com|cmd|bat|ps1)$/i, "");
}

function normalizedPortablePath(value) {
  return String(value ?? "").trim().replaceAll("\\", "/").toLowerCase();
}

function isCodexExecutableToken(value, codexBin = null) {
  const raw = String(value ?? "").trim().replace(/^['"]|['"]$/g, "");
  if (!raw) return false;
  if (CODEX_EXECUTABLE_RE.test(portableBasename(raw))) return true;
  return Boolean(codexBin && normalizedPortablePath(raw) === normalizedPortablePath(codexBin));
}

function containsCodexCommandToken(value, codexBin = null) {
  const text = String(value ?? "");
  if (CODEX_COMMAND_TOKEN_RE.test(text)) return true;
  if (!codexBin) return false;
  return normalizedPortablePath(text).includes(normalizedPortablePath(codexBin));
}

function wrapperCarriesNestedCodex(command, wrapper, codexBin) {
  const args = command.slice(1);
  if (COMMAND_STRING_WRAPPERS.has(wrapper)) {
    return args.some((arg) => containsCodexCommandToken(arg, codexBin));
  }

  if (INLINE_CODE_WRAPPERS.has(wrapper)) {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const prior = args[index - 1];
      const inlineCode = ["-e", "--eval", "-c", "-Command", "--command", "-p", "--print"].includes(prior)
        || /^-(?:e|c|p)=/.test(arg)
        || /^--(?:eval|command|print)=/.test(arg)
        || (wrapper === "deno" && prior === "eval");
      if (inlineCode && containsCodexCommandToken(arg, codexBin)) return true;
    }
    return false;
  }

  if (EXECUTABLE_LAUNCH_WRAPPERS.has(wrapper)) {
    return args.some((arg) => isCodexExecutableToken(arg, codexBin) || containsCodexCommandToken(arg, codexBin));
  }

  return false;
}

export function nestedCodexInvocationReason(command, { codexBin = null } = {}) {
  if (!Array.isArray(command) || command.length === 0) return null;
  if (isCodexExecutableToken(command[0], codexBin)) return "direct-codex-executable";
  const wrapper = executableStem(command[0]);
  if (wrapperCarriesNestedCodex(command, wrapper, codexBin)) return `codex-via-${wrapper}`;
  return null;
}

const READ_ONLY_SIMPLE_EXECUTABLES = new Set([
  "rg",
  "ripgrep",
  "where",
  "whoami",
  "hostname",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "realpath",
  "ls",
  "findstr",
]);
const READ_ONLY_CMD_BUILTINS = new Set(["dir", "type", "ver", "cd"]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "grep"]);
const SHELL_META_RE = /[|><;&]/;

function commandHasShellMeta(command) {
  return command.some((arg) => SHELL_META_RE.test(String(arg ?? "")));
}

function gitReadOnlyReason(args) {
  if (!args.length) return "git-subcommand-missing";
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] ?? "");
    if (arg === "-c" || arg.startsWith("-c") || arg === "--config-env" || arg.startsWith("--config-env=")) {
      return "git-config-override-not-proven-read-only";
    }
    if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree"
      || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      return "git-repository-redirect-not-proven-read-only";
    }
  }
  const index = args.findIndex((arg) => !String(arg).startsWith("-"));
  const subcommand = String(index >= 0 ? args[index] : "").toLowerCase();
  if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return null;
  if (subcommand === "branch") {
    const branchArgs = args.slice(index + 1);
    return branchArgs.length === 1 && branchArgs[0] === "--show-current" ? null : "git-branch-not-proven-read-only";
  }
  return `git-${subcommand || "unknown"}-not-proven-read-only`;
}

function cmdNestedCommand(command) {
  const args = command.slice(1);
  const controlIndex = args.findIndex((arg) => ["/c", "/k"].includes(String(arg).toLowerCase()));
  if (controlIndex < 0) return null;
  const nested = args.slice(controlIndex + 1);
  if (!nested.length) return null;
  if (nested.length === 1 && /\s/.test(nested[0])) return null;
  return nested;
}

export function readOnlyCommandRejectionReason(command) {
  if (!Array.isArray(command) || command.length === 0 || !command.every((item) => typeof item === "string")) {
    return "invalid-command";
  }
  if (commandHasShellMeta(command)) return "shell-metacharacters-not-allowed";

  const executable = executableStem(command[0]);
  const args = command.slice(1);
  if (READ_ONLY_SIMPLE_EXECUTABLES.has(executable)) return null;
  if (executable === "git") return gitReadOnlyReason(args);
  if (["node", "nodejs"].includes(executable)) {
    if (args.length === 1 && ["--version", "-v"].includes(args[0])) return null;
    if (args.length >= 2 && args[0] === "--check" && !args.slice(1).some((arg) => arg.startsWith("-"))) return null;
    return "node-code-execution-not-proven-read-only";
  }
  if (["python", "python3", "py"].includes(executable)) {
    return args.length === 1 && ["--version", "-V"].includes(args[0]) ? null : "python-code-execution-not-proven-read-only";
  }
  if (["npm", "pnpm", "yarn"].includes(executable)) {
    return args.length === 1 && ["--version", "-v"].includes(args[0]) ? null : `${executable}-command-not-proven-read-only`;
  }
  if (executable === "cmd") {
    const nested = cmdNestedCommand(command);
    if (!nested) return "cmd-command-string-not-proven-read-only";
    const nestedExecutable = executableStem(nested[0]);
    if (READ_ONLY_CMD_BUILTINS.has(nestedExecutable)) return null;
    return readOnlyCommandRejectionReason(nested);
  }
  if (["powershell", "pwsh", "sh", "bash", "zsh", "fish"].includes(executable)) {
    return `${executable}-wrapper-not-proven-read-only`;
  }
  return `${executable || "unknown"}-not-proven-read-only`;
}

export function assertReadOnlyCommandAllowed(command, { permissionProfile = null } = {}) {
  if (permissionProfile !== ":read-only") return;
  const reason = readOnlyCommandRejectionReason(command);
  if (!reason) return;
  const error = new Error(
    `Codexless command_exec refused a command under :read-only because it is not proven non-mutating (${reason}).`
  );
  error.code = "READ_ONLY_COMMAND_NOT_PROVEN";
  error.nextActions = [
    "Use a model-free read primitive such as codex.read_many for project inspection, or a proven read-only command.",
    "For an authorized project mutation, use access=inherit only when the host-resolved permission ceiling is explicitly write-capable.",
    "Do not rely on the upstream command sandbox alone to enforce read-only filesystem semantics.",
  ];
  error.reason = reason;
  throw error;
}

export function assertNoNestedCodexInvocation(command, { codexBin = null } = {}) {
  const reason = nestedCodexInvocationReason(command, { codexBin });
  if (!reason) return;
  const error = new Error(
    "Codexless command_exec refuses to launch Codex CLI from the model-free command lane. " +
    "Use codex.agent_start / codex.agent_send so metered Codex work keeps its Task Card, quota state, and explicit lifecycle."
  );
  error.code = "METERED_CODEX_REQUIRES_AGENT_CARD";
  error.nextActions = [
    "Use codex.agent_start for a new formal Codex task.",
    "Use codex.agent_send only for an existing Codexless agentRef follow-up.",
    "Keep codex.command_exec for model-free local commands; do not use shell/interpreter wrappers to launch Codex.",
  ];
  error.reason = reason;
  throw error;
}
