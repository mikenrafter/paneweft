// Infrastructure-error runner: status "error" with a message and NO result (the output is still valid).
import { runDocument, writeOutput } from "./_common.mjs";

writeOutput(runDocument({ status: "error", assertions: [], withResult: false, error: "fixture adapter could not start the server" }));
