// A tiny owner runner for the wire tests (MC17). It is independent of src/: plain node, no imports from
// the repository. argv[2] is the absolute workspace directory. It
//   - records that it ran (ran.marker holds the run id it was given),
//   - writes a paneweft.run/1 document to <workspace>/out.json whose run id is $PANEWEFT_RUN_ID.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const workspace = process.argv[2];
const runId = process.env.PANEWEFT_RUN_ID;
if (!workspace || !runId) {
  process.stderr.write("wire-runner: workspace argument or PANEWEFT_RUN_ID missing\n");
  process.exit(3);
}
writeFileSync(join(workspace, "ran.marker"), runId);
const output = {
  schemaVersion: "paneweft.run/1",
  run: {
    id: runId,
    runId,
    status: "passed",
    provenance: "read",
    evidence: ["s1"],
    assertions: [{ id: "as-1", statement: "The runner wrote its result.", passed: true, provenance: "read", evidence: ["s1"] }],
    result: { repository: "r", id: "result-1", kind: "json/value" },
  },
  bundle: {
    schemaVersion: "paneweft.bundle/1",
    entities: [{ repository: "r", id: "result-1", kind: "json/value", snapshotId: "snap-1", label: "result", dataRoles: [], relations: [] }],
    definitions: [],
    views: [],
  },
};
writeFileSync(join(workspace, "out.json"), JSON.stringify(output));
