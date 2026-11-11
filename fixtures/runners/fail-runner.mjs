// Runner whose assertion fails but which still returns an inspectable result (design 2.7: "Failed
// assertions may still return an inspectable result").
import { assertion, runDocument, writeOutput } from "./_common.mjs";

writeOutput(runDocument({ status: "failed", assertions: [assertion("a1", "one write fires the first keepalive", false)] }));
