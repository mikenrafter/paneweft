// Usage: sleep-runner.mjs <out> <pidFile> [sleepMs=30000]
// Writes its own pid to <pidFile>, prints "ready <pid>" on stdout, sleeps, then writes a passing output.
// With the default 30 s it exists to be killed by a timeout; with a small sleepMs it is the positive control.
import { writeFileSync } from "node:fs";
import { assertion, extraArgs, runDocument, writeOutput } from "./_common.mjs";

const [pidFile, sleepMs = "30000"] = extraArgs;
writeFileSync(pidFile, String(process.pid));
process.stdout.write(`ready ${process.pid}\n`);
setTimeout(() => {
  writeOutput(runDocument({ status: "passed", assertions: [assertion("a1", "woke up", true)] }));
}, Number(sleepMs));
