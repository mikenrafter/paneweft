// Writes JSON that fails the paneweft.run/1 schema in exactly one way: status "passed" but no `result`
// (pointer /run/result, code REQUIRED). The bundle holds no entity.
import { assertion, runDocument, writeOutput } from "./_common.mjs";

writeOutput(runDocument({ status: "passed", assertions: [assertion("a1", "claims success", true)], withResult: false }));
