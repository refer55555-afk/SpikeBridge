import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const DEFAULTS = Object.freeze({
  enabled: true,
  intervalMinutes: 60,
  tmpQuarantineAfterHours: 6,
  logQuarantineAfterDays: 7,
  rootEphemeralAfterHours: 6,
  quarantinePurgeAfterDays: 2,
  maxScanEntries: 20_000,
  maxHistoryLines: 200,
  protectedPaths: [],
});
const EPHEMERAL_MARKER = "spike-housekeeping: ephemeral";
const ROOT_EPHEMERAL_EXTS = new Set([".ps1", ".cmd", ".bat", ".mjs", ".js", ".cjs", ".py", ".json", ".html"]);

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function boundedNumber(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

async function readConfig(root, configPath, overrides = {}) {
  let file = {};
  try { file = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, "")); } catch {}
  return {
    enabled: overrides.enabled ?? file.enabled ?? DEFAULTS.enabled,
    intervalMinutes: boundedNumber(overrides.intervalMinutes ?? file.intervalMinutes, DEFAULTS.intervalMinutes, 5, 1440),
    tmpQuarantineAfterHours: boundedNumber(overrides.tmpQuarantineAfterHours ?? file.tmpQuarantineAfterHours, DEFAULTS.tmpQuarantineAfterHours, 1, 720),
    logQuarantineAfterDays: boundedNumber(overrides.logQuarantineAfterDays ?? file.logQuarantineAfterDays, DEFAULTS.logQuarantineAfterDays, 1, 365),
    rootEphemeralAfterHours: boundedNumber(overrides.rootEphemeralAfterHours ?? file.rootEphemeralAfterHours, DEFAULTS.rootEphemeralAfterHours, 1, 720),
    quarantinePurgeAfterDays: boundedNumber(overrides.quarantinePurgeAfterDays ?? file.quarantinePurgeAfterDays, DEFAULTS.quarantinePurgeAfterDays, 1, 90),
    maxScanEntries: Math.trunc(boundedNumber(overrides.maxScanEntries ?? file.maxScanEntries, DEFAULTS.maxScanEntries, 100, 100_000)),
    maxHistoryLines: Math.trunc(boundedNumber(overrides.maxHistoryLines ?? file.maxHistoryLines, DEFAULTS.maxHistoryLines, 20, 2_000)),
    protectedPaths: [...new Set((Array.isArray(overrides.protectedPaths ?? file.protectedPaths) ? (overrides.protectedPaths ?? file.protectedPaths) : DEFAULTS.protectedPaths).filter(v => typeof v === "string" && v.trim()).map(v => v.trim()).slice(0, 200))],
  };
}

async function treeStats(target, budget) {
  const info = { newestMtimeMs: 0, bytes: 0, files: 0, entries: 0, truncated: false };
  async function visit(current) {
    if (info.entries >= budget) { info.truncated = true; return; }
    let st;
    try { st = await stat(current); } catch { return; }
    info.entries += 1;
    info.newestMtimeMs = Math.max(info.newestMtimeMs, st.mtimeMs || 0);
    if (!st.isDirectory()) { info.bytes += st.size || 0; info.files += 1; return; }
    let children = [];
    try { children = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      if (info.entries >= budget) { info.truncated = true; break; }
      await visit(path.join(current, child.name));
    }
  }
  await visit(target);
  return info;
}

async function walkFiles(rootDir, budget) {
  const out = [];
  let seen = 0;
  async function visit(dir) {
    if (seen >= budget) return;
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (seen >= budget) break;
      seen += 1;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else out.push(full);
    }
  }
  await visit(rootDir);
  return { files: out, truncated: seen >= budget };
}

function runId(now) {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

async function trimHistory(historyPath, maxLines) {
  try {
    const text = await readFile(historyPath, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length <= maxLines) return;
    await writeFile(historyPath, `${lines.slice(-maxLines).join("\n")}\n`, "utf8");
  } catch {}
}

export function createHousekeepingPlugin({ root, configPath = null, logger = console } = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const resolvedConfig = path.resolve(configPath || path.join(resolvedRoot, "config", "housekeeping.json"));
  const stateDir = path.join(resolvedRoot, "state", "housekeeping");
  const quarantineRoot = path.join(stateDir, "quarantine");
  const lastRunPath = path.join(stateDir, "last-run.json");
  const historyPath = path.join(stateDir, "history.jsonl");
  let timer = null;
  let running = false;
  let lastSummary = null;

  async function quarantine(full, relative, qRunRoot, summary, dryRun) {
    if (!isInside(resolvedRoot, full)) throw new Error(`housekeeping path escape: ${full}`);
    const dest = path.join(qRunRoot, relative);
    if (!isInside(qRunRoot, dest)) throw new Error(`housekeeping quarantine path escape: ${relative}`);
    let st;
    try { st = await stat(full); } catch { return; }
    if (!dryRun) {
      await mkdir(path.dirname(dest), { recursive: true });
      await rename(full, dest);
    }
    summary.quarantined += 1;
    summary.bytes += st.isFile() ? st.size : 0;
    summary.sample.push(relative);
  }

  async function runOnce({ dryRun = false, reason = "manual", overrides = {} } = {}) {
    if (running) return { result: "SKIP", reason: "already_running" };
    running = true;
    const startedAt = Date.now();
    try {
      const cfg = await readConfig(resolvedRoot, resolvedConfig, overrides);
      const protectedRoots=cfg.protectedPaths.map(value=>path.isAbsolute(value)?path.resolve(value):path.resolve(resolvedRoot,value));
      for(const protectedRoot of protectedRoots)if(!isInside(resolvedRoot,protectedRoot))throw new Error(`housekeeping protected path escape: ${protectedRoot}`);
      const isProtected=full=>protectedRoots.some(protectedRoot=>isInside(protectedRoot,full)||isInside(full,protectedRoot));
      const summary = {
        result: "PASS", reason, dryRun, enabled: cfg.enabled,
        startedAt: new Date(startedAt).toISOString(), finishedAt: null,
        quarantined: 0, purgedQuarantineRuns: 0, skippedBusy: 0, protectedSkipped: 0,
        bytes: 0, scanTruncated: false, sample: [], protectedPaths: cfg.protectedPaths,
      };
      if (!cfg.enabled) {
        summary.result = "SKIP"; summary.finishedAt = new Date().toISOString(); lastSummary = summary; return summary;
      }
      if (!dryRun) await mkdir(quarantineRoot, { recursive: true });
      const qRunRoot = path.join(quarantineRoot, runId(startedAt));
      const now = Date.now();

      // tmp/: only whole top-level entries whose newest descendant is old enough.
      const tmpDir = path.join(resolvedRoot, "tmp");
      let tmpEntries = [];
      try { tmpEntries = await readdir(tmpDir, { withFileTypes: true }); } catch {}
      for (const entry of tmpEntries) {
        if (entry.name === ".gitkeep") continue;
        const full = path.join(tmpDir, entry.name);
        if(isProtected(full)){summary.protectedSkipped+=1;continue;}
        const tree = await treeStats(full, cfg.maxScanEntries);
        summary.scanTruncated ||= tree.truncated;
        if (tree.truncated) continue;
        if (now - tree.newestMtimeMs < cfg.tmpQuarantineAfterHours * HOUR) continue;
        try { await quarantine(full, path.join("tmp", entry.name), qRunRoot, summary, dryRun); }
        catch { summary.skippedBusy += 1; }
      }

      // logs/: only *.log, file-by-file, and only after the log retention window.
      const logs = await walkFiles(path.join(resolvedRoot, "logs"), cfg.maxScanEntries);
      summary.scanTruncated ||= logs.truncated;
      for (const full of logs.files) {
        if (!full.toLowerCase().endsWith(".log")) continue;
        if(isProtected(full)){summary.protectedSkipped+=1;continue;}
        let st; try { st = await stat(full); } catch { continue; }
        if (now - st.mtimeMs < cfg.logQuarantineAfterDays * DAY) continue;
        const rel = path.relative(resolvedRoot, full);
        try { await quarantine(full, rel, qRunRoot, summary, dryRun); }
        catch { summary.skippedBusy += 1; }
      }

      // Repository root: never guess. Only explicit ephemeral marker opts a file into cleanup.
      let rootEntries = [];
      try { rootEntries = await readdir(resolvedRoot, { withFileTypes: true }); } catch {}
      for (const entry of rootEntries) {
        if (!entry.isFile() || !ROOT_EPHEMERAL_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
        const full = path.join(resolvedRoot, entry.name);
        if(isProtected(full)){summary.protectedSkipped+=1;continue;}
        let st; try { st = await stat(full); } catch { continue; }
        if (now - st.mtimeMs < cfg.rootEphemeralAfterHours * HOUR) continue;
        let head = ""; try { head = (await readFile(full, "utf8")).slice(0, 1024); } catch { continue; }
        if (!head.toLowerCase().includes(EPHEMERAL_MARKER)) continue;
        try { await quarantine(full, entry.name, qRunRoot, summary, dryRun); }
        catch { summary.skippedBusy += 1; }
      }

      // Purge only old quarantine run directories. Current run is never directly deleted.
      let qEntries = [];
      try { qEntries = await readdir(quarantineRoot, { withFileTypes: true }); } catch {}
      for (const entry of qEntries) {
        if (!entry.isDirectory()) continue;
        const full = path.join(quarantineRoot, entry.name);
        if (full === qRunRoot) continue;
        let st; try { st = await stat(full); } catch { continue; }
        if (now - st.mtimeMs < cfg.quarantinePurgeAfterDays * DAY) continue;
        if (!dryRun) await rm(full, { recursive: true, force: true });
        summary.purgedQuarantineRuns += 1;
      }

      summary.sample = summary.sample.slice(0, 30);
      summary.finishedAt = new Date().toISOString();
      lastSummary = summary;
      if (!dryRun) {
        await mkdir(stateDir, { recursive: true });
        await writeFile(lastRunPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
        await appendFile(historyPath, `${JSON.stringify(summary)}\n`, "utf8");
        await trimHistory(historyPath, cfg.maxHistoryLines);
      }
      return summary;
    } catch (error) {
      const failed = { result: "ERROR", reason, dryRun, error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() };
      lastSummary = failed;
      logger?.error?.(`[housekeeping] ${failed.error}`);
      return failed;
    } finally {
      running = false;
    }
  }

  async function start({ runOnStart = true } = {}) {
    const cfg = await readConfig(resolvedRoot, resolvedConfig);
    if (!cfg.enabled || timer) return status();
    if (runOnStart) void runOnce({ reason: "startup" });
    timer = setInterval(() => { void runOnce({ reason: "interval" }); }, cfg.intervalMinutes * 60_000);
    timer.unref?.();
    return status();
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }
  function status() {
    return { enabled: Boolean(timer), running, intervalActive: Boolean(timer), lastRun: lastSummary };
  }

  return { runOnce, start, stop, status, root: resolvedRoot, configPath: resolvedConfig };
}
