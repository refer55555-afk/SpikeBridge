import path from "node:path";
import { fileURLToPath } from "node:url";

export async function main(argv = process.argv.slice(2)) {
  const { main: canonicalMain } = await import("./spike-home-production.g3.mjs");
  return canonicalMain(argv);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (result?.result !== "PASS") process.exitCode = 1;
  }).catch((error) => {
    console.error(JSON.stringify({ result: "FAIL", error: error?.message ?? String(error) }));
    process.exitCode = 1;
  });
}