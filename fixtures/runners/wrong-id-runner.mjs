// Valid output, but run.runId is "forged-run" instead of PANEWEFT_RUN_ID.
import { assertion, resultEntity, runDocument, writeOutput } from "./_common.mjs";

writeOutput(runDocument({
  status: "passed",
  assertions: [assertion("a1", "claims success", true)],
  runIdValue: "forged-run",
  entities: [resultEntity("result-forged-run")],
}));
