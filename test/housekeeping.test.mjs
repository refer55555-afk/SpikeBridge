import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHousekeepingPlugin } from "../plugins/housekeeping/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("housekeeping quarantines only allowlisted ephemeral artifacts", async () => {
  await mkdir(path.join(ROOT, "tmp"), { recursive: true });
  const fixture = await mkdtemp(path.join(ROOT, "tmp", "hk-fixture-"));
  try {
    await mkdir(path.join(fixture, "tmp", "old-probe"), { recursive: true });
    await mkdir(path.join(fixture, "logs"), { recursive: true });
    await mkdir(path.join(fixture, "config"), { recursive: true });
    await mkdir(path.join(fixture, "state"), { recursive: true });
    await writeFile(path.join(fixture, "tmp", "old-probe", "probe.txt"), "temp", "utf8");
    await writeFile(path.join(fixture, "logs", "old.log"), "old log", "utf8");
    await writeFile(path.join(fixture, "config", "keep.json"), "{}", "utf8");
    await writeFile(path.join(fixture, "scratch.ps1"), "# spike-housekeeping: ephemeral\nWrite-Output temp\n", "utf8");
    await writeFile(path.join(fixture, "permanent.ps1"), "Write-Output keep\n", "utf8");
    const old = new Date(Date.now() - 3 * 86_400_000);
    await utimes(path.join(fixture, "tmp", "old-probe", "probe.txt"), old, old);
    await utimes(path.join(fixture, "tmp", "old-probe"), old, old);
    await utimes(path.join(fixture, "logs", "old.log"), old, old);
    await utimes(path.join(fixture, "scratch.ps1"), old, old);
    await writeFile(path.join(fixture, "housekeeping.json"), JSON.stringify({enabled:true,intervalMinutes:60,tmpQuarantineAfterHours:1,logQuarantineAfterDays:1,rootEphemeralAfterHours:1,quarantinePurgeAfterDays:2,maxScanEntries:1000,maxHistoryLines:50}), "utf8");
    const plugin = createHousekeepingPlugin({ root: fixture, configPath: path.join(fixture, "housekeeping.json") });
    const result = await plugin.runOnce({ reason: "test" });
    assert.equal(result.result, "PASS");
    assert.equal(result.quarantined, 3);
    await assert.rejects(stat(path.join(fixture, "tmp", "old-probe")));
    await assert.rejects(stat(path.join(fixture, "logs", "old.log")));
    await assert.rejects(stat(path.join(fixture, "scratch.ps1")));
    assert.equal((await stat(path.join(fixture, "config", "keep.json"))).isFile(), true);
    assert.equal((await stat(path.join(fixture, "permanent.ps1"))).isFile(), true);
    const last = JSON.parse(await readFile(path.join(fixture, "state", "housekeeping", "last-run.json"), "utf8"));
    assert.equal(last.result, "PASS");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("housekeeping protected paths survive cleanup and protect descendants", async () => {
  await mkdir(path.join(ROOT, "tmp"), { recursive: true });
  const fixture = await mkdtemp(path.join(ROOT, "tmp", "hk-protected-"));
  try {
    const protectedDir=path.join(fixture,"tmp","protected"),removableDir=path.join(fixture,"tmp","remove-me");
    await mkdir(protectedDir,{recursive:true});await mkdir(removableDir,{recursive:true});await mkdir(path.join(fixture,"logs"),{recursive:true});
    await writeFile(path.join(protectedDir,"keep.txt"),"keep","utf8");await writeFile(path.join(removableDir,"remove.txt"),"remove","utf8");
    await writeFile(path.join(fixture,"logs","keep.log"),"keep log","utf8");await writeFile(path.join(fixture,"logs","remove.log"),"remove log","utf8");
    const old=new Date(Date.now()-3*86_400_000);
    for(const p of [protectedDir,path.join(protectedDir,"keep.txt"),removableDir,path.join(removableDir,"remove.txt"),path.join(fixture,"logs","keep.log"),path.join(fixture,"logs","remove.log")])await utimes(p,old,old);
    await writeFile(path.join(fixture,"housekeeping.json"),JSON.stringify({enabled:true,intervalMinutes:60,tmpQuarantineAfterHours:1,logQuarantineAfterDays:1,rootEphemeralAfterHours:1,quarantinePurgeAfterDays:2,maxScanEntries:1000,maxHistoryLines:50,protectedPaths:["tmp/protected","logs/keep.log"]}),"utf8");
    const plugin=createHousekeepingPlugin({root:fixture,configPath:path.join(fixture,"housekeeping.json")});
    const result=await plugin.runOnce({reason:"protected-test"});
    assert.equal(result.result,"PASS");assert.equal(result.protectedSkipped,2);
    assert.equal((await stat(protectedDir)).isDirectory(),true);assert.equal((await stat(path.join(fixture,"logs","keep.log"))).isFile(),true);
    await assert.rejects(stat(removableDir));await assert.rejects(stat(path.join(fixture,"logs","remove.log")));
  } finally { await rm(fixture,{recursive:true,force:true}); }
});
