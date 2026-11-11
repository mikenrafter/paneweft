// Passing runner: one passing assertion and an inspectable json/value result entity.
// Also records what it saw (seen-run-id.txt) so tests can compare paneweft's run id with the one in the output.
import { writeFileSync } from "node:fs";
import { assertion, runDocument, runId, writeOutput } from "./_common.mjs";

writeFileSync("seen-run-id.txt", runId);
writeOutput(runDocument({ status: "passed", assertions: [assertion("a1", "one write fires the first keepalive", true)] }));
