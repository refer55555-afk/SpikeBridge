import path from "node:path";
import { createHousekeepingPlugin } from "../plugins/housekeeping/index.mjs";

const rootArg = process.argv.indexOf("--root");
const root = rootArg >= 0 && process.argv[rootArg + 1] ? path.resolve(process.argv[rootArg + 1]) : path.resolve(process.cwd());
const dryRun = process.argv.includes("--dry-run");
const plugin = createHousekeepingPlugin({ root });
const result = await plugin.runOnce({ dryRun, reason: dryRun ? "manual-dry-run" : "manual" });
console.log(JSON.stringify(result));
if (result.result === "ERROR") process.exitCode = 1;
