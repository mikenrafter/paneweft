// Shared helpers of the fixture runners (MC17). Not a runner itself.
//
// Runner calling convention used by every script in this folder (docs/contract-additions/store.md#10):
//   node <script>.mjs <outputPath> [extra args...]
//   * the process is started with cwd = the runner's workspaceRoot, WITHOUT a shell;
//   * argv[2] is the output path relative to cwd (the registry's outputBundlePath);
//   * env PANEWEFT_RUN_ID is the run id paneweft generated; a well-behaved runner copies it to run.runId.
// The scripts never import anything from src/: they are independent of the code under test.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const runId = process.env.PANEWEFT_RUN_ID ?? "no-run-id";
export const outputPath = resolve(process.cwd(), process.argv[2] ?? "out.json");
export const extraArgs = process.argv.slice(3);

const EVIDENCE = ["s1"]; // the example view fixtures/components/example.json has source s1
export const resultRef = (id = `result-${runId}`) => ({ repository: "r", id, kind: "json/value" });

export function resultEntity(id = `result-${runId}`, label = "recorded result") {
  return { repository: "r", id, kind: "json/value", snapshotId: "snap-1", label, dataRoles: ["raw"], relations: [] };
}
export const assertion = (id, statement, passed) => ({ id, statement, passed, provenance: "read", evidence: EVIDENCE });

/** A paneweft.run/1 document. `run` fields can be overridden; `bundle` defaults to the result entity only. */
export function runDocument({ status, assertions, withResult = true, error, runIdValue = runId, entities, definitions = [] }) {
  const run = { id: `run-${runIdValue}`, runId: runIdValue, status, provenance: "read", evidence: EVIDENCE, assertions };
  if (withResult) run.result = resultRef();
  if (error !== undefined) run.error = error;
  return {
    schemaVersion: "paneweft.run/1",
    run,
    bundle: { schemaVersion: "paneweft.bundle/1", entities: entities ?? (withResult ? [resultEntity()] : []), definitions, views: [] },
  };
}
export function writeOutput(document) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, typeof document === "string" ? document : JSON.stringify(document));
}
