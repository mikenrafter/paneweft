// Usage: argv-echo-runner.mjs <out> [args...]
// Records the extra arguments EXACTLY as received (JSON array in argv.json) so shell metacharacters can be
// checked for literalness. An argument of the form "touch:NAME" makes the runner create the file NAME in
// its cwd: the positive control proving that the runner CAN create files when asked.
import { closeSync, openSync, writeFileSync } from "node:fs";
import { assertion, extraArgs, runDocument, writeOutput } from "./_common.mjs";

writeFileSync("argv.json", JSON.stringify(extraArgs));
for (const arg of extraArgs) {
  if (arg.startsWith("touch:")) closeSync(openSync(arg.slice("touch:".length), "w"));
}
writeOutput(runDocument({ status: "passed", assertions: [assertion("a1", "argv recorded", true)] }));
