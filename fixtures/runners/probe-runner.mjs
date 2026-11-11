// Records, as its very first act, whether the output file already existed when it started
// (stale-seen.txt = "yes" | "no"), then behaves like pass-runner. Proves a stale output file is removed BEFORE the run.
import { existsSync, writeFileSync } from "node:fs";
import { assertion, outputPath, runDocument, writeOutput } from "./_common.mjs";

writeFileSync("stale-seen.txt", existsSync(outputPath) ? "yes" : "no");
writeOutput(runDocument({ status: "passed", assertions: [assertion("a1", "probe ran", true)] }));
