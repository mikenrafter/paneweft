// MC17 (validation side): "An example produces a tested inspectable result ... Reject passed-without-result
// and passed-with-failed-assertion" (design section 7) and design 2.7: "A passed run requires at least one
// assertion, all passing, and a result entity present in its output bundle. Failed assertions may still
// return an inspectable result; infrastructure errors explain why none exists."
// Two entry points: validateSubmission on an example view (intra-view rules) and validateRunOutput for a
// paneweft.run/1 document (the same run rules, plus the result entity must resolve in the output bundle or
// the ReferenceContext). Codes/pointers: red-contract section 2; shapes: src/schemas/components/example.
import { describe, expect, it } from "vitest";
import { validateRunOutput, validateSubmission, type ReferenceContext } from "./validate.ts";
import { allBundle } from "../../test/helpers/fixtures.ts";
import { patch } from "../../test/helpers/patch.ts";
import { calm, expectAccepted, expectOk, expectRejected } from "../../test/helpers/val-check.ts";
import { exampleBase, item, listBase, passedRun, runKindSource, runSource } from "../../test/helpers/val-fixtures.ts";

const check = (doc: unknown) => calm(() => validateSubmission(doc), "validateSubmission");
const checkRun = (doc: unknown, context?: ReferenceContext) => calm(() => validateRunOutput(doc, context), "validateRunOutput");
const assertion = (id: string, passed: boolean) => item(id, { statement: `statement ${id}`, passed });

describe("[MC17] run status rules inside an example view", () => {
  // why: the controls first: a passed run with a result and passing assertions is the contract's happy path.
  // proves: CLAIM(MC17)
  it("[MC17] positive control: a passed run with a passing assertion and a result is accepted", () => {
    expectAccepted(check(exampleBase()), "envelope");
  });

  // why: "Reject passed-without-result": a passed run that has no inspectable result is a claim of success
  //      with nothing to inspect (design 2.7). REQUIRED at the missing property.
  // proves: CLAIM(MC17)
  it("[MC17] a passed run without a result is REQUIRED at /data/runs/0/result", () => {
    expectRejected(check(patch(exampleBase(), { op: "remove", path: "/data/runs/0/result" })), [{ code: "REQUIRED", pointer: "/data/runs/0/result" }], "envelope");
  });

  // why: "Avoid ... a scenario without assertions as a tested example" (design 2.7): passed with zero assertions
  //      proves nothing; SIZE (minItems 1) on the assertions array.
  // proves: CLAIM(MC17)
  it("[MC17] a passed run with zero assertions is SIZE at /data/runs/0/assertions", () => {
    expectRejected(check(patch(exampleBase(), { op: "replace", path: "/data/runs/0/assertions", value: [] })), [{ code: "SIZE", pointer: "/data/runs/0/assertions" }], "envelope");
  });

  // why: "Reject ... passed-with-failed-assertion": the status must agree with its assertions. One failing
  //      among several passing ones is enough. The issue sits on the run's `status` (red-contract section 2).
  // proves: CLAIM(MC17)
  it("[MC17] a passed run with one failing assertion among passing ones is PASSED_WITH_FAILED_ASSERTION at status", () => {
    const doc = patch(exampleBase(), { op: "add", path: "/data/runs/0/assertions/-", value: assertion("as-2", false) });
    expectRejected(check(doc), [{ code: "PASSED_WITH_FAILED_ASSERTION", pointer: "/data/runs/0/status" }], "envelope");
  });
  it("[MC17] positive control: the same two assertions, both passing, are accepted", () => {
    expectAccepted(check(patch(exampleBase(), { op: "add", path: "/data/runs/0/assertions/-", value: assertion("as-2", true) })), "envelope");
  });
  it("[MC17] on the second run, the issue is addressed at /data/runs/1/status", () => {
    const second = passedRun({
      id: "run-b",
      runId: "run-2",
      assertions: [assertion("as-3", false)],
    });
    expectRejected(check(patch(exampleBase(), { op: "add", path: "/data/runs/-", value: second })), [{ code: "PASSED_WITH_FAILED_ASSERTION", pointer: "/data/runs/1/status" }]);
  });

  // why: "Failed assertions may still return an inspectable result": a failed run with failing assertions AND
  //      a result is valid and is the whole point of the failure-inspection story. A failed run without any
  //      result is also fine (the test failed before producing one).
  // proves: CLAIM(MC17)
  it("[MC17] a failed run with failing assertions and a result is accepted", () => {
    const doc = patch(
      exampleBase(),
      { op: "replace", path: "/data/runs/0/status", value: "failed" },
      { op: "replace", path: "/data/runs/0/assertions", value: [assertion("as-1", false), assertion("as-2", true)] },
    );
    expectAccepted(check(doc), "envelope");
  });
  it("[MC17] a failed run without a result is accepted", () => {
    const doc = patch(exampleBase(), { op: "replace", path: "/data/runs/0/status", value: "failed" }, { op: "remove", path: "/data/runs/0/result" });
    expectAccepted(check(doc), "envelope");
  });
  it("[MC17] a failed run carrying an `error` is FORBIDDEN_PROPERTY (errors belong to the error status)", () => {
    const doc = patch(exampleBase(), { op: "replace", path: "/data/runs/0/status", value: "failed" }, { op: "add", path: "/data/runs/0/error", value: "boom" });
    expectRejected(check(doc), [{ code: "FORBIDDEN_PROPERTY", pointer: "/data/runs/0/error" }]);
  });

  // why: "infrastructure errors explain why none exists": an error run needs `error` and cannot claim a result.
  // proves: CLAIM(MC17)
  const errorRun = (extra: Record<string, unknown> = {}) =>
    patch(exampleBase(), { op: "replace", path: "/data/runs/0/status", value: "error" }, { op: "replace", path: "/data/runs/0/assertions", value: [] }, { op: "remove", path: "/data/runs/0/result" }, ...Object.entries(extra).map(([k, v]) => ({ op: "add" as const, path: `/data/runs/0/${k}`, value: v })));
  it("[MC17] positive control: an error run with an explanation and no result is accepted", () => {
    expectAccepted(check(errorRun({ error: "runner exited with 137" })), "envelope");
  });
  it("[MC17] an error run without `error` is REQUIRED at /data/runs/0/error", () => {
    expectRejected(check(errorRun()), [{ code: "REQUIRED", pointer: "/data/runs/0/error" }]);
  });
  it("[MC17] an error run that also has a result is FORBIDDEN_PROPERTY at /data/runs/0/result", () => {
    expectRejected(check(errorRun({ error: "x", result: { repository: "r", id: "res", kind: "json/value" } })), [{ code: "FORBIDDEN_PROPERTY", pointer: "/data/runs/0/result" }]);
  });
  it("[MC17] a passed run carrying an `error` is FORBIDDEN_PROPERTY", () => {
    expectRejected(check(patch(exampleBase(), { op: "add", path: "/data/runs/0/error", value: "boom" })), [{ code: "FORBIDDEN_PROPERTY", pointer: "/data/runs/0/error" }]);
  });
});

describe("[MC17] run ids within one view", () => {
  const secondRun = (runId: string) => passedRun({ id: "run-b", runId, assertions: [assertion("as-2", true)] });

  // why: "repeated runs with distinct run IDs" (design 7 MC17): a run id names one recorded run, so two runs
  //      sharing it in one view are DUPLICATE_ID on the later run's runId. The twin with distinct ids is accepted.
  // proves: CLAIM(MC17)
  it("[MC17] positive control: two runs with distinct run ids are accepted", () => {
    expectAccepted(check(patch(exampleBase(), { op: "add", path: "/data/runs/-", value: secondRun("run-2") })), "envelope");
  });
  it("[MC17] a repeated runId is DUPLICATE_ID at the later run's runId", () => {
    expectRejected(check(patch(exampleBase(), { op: "add", path: "/data/runs/-", value: secondRun("run-1") })), [{ code: "DUPLICATE_ID", pointer: "/data/runs/1/runId" }], "envelope");
  });
  it("[MC17] a runId colliding with a DIFFERENT item id is not a duplicate (separate namespaces)", () => {
    // run-a is the item id of run 0; reuse that string as the runId of the second run.
    expectAccepted(check(patch(exampleBase(), { op: "add", path: "/data/runs/-", value: secondRun("run-a") })), "envelope");
  });
});

// ---- validateRunOutput -------------------------------------------------------------------------------------------
// A paneweft.run/1 document is {schemaVersion, run, bundle}: what a runner writes and example_record accepts
// (src/schemas/run-output.schema.json). The bundle is the fixture bundle's first view and entities plus the
// result entity `res`; run items cite the view's file source s1 with provenance read so the base is valid
// whether a run document resolves evidence against its bundle's sources or not (contract-additions/val.md Q4).
const RESULT = { repository: "r", id: "res", kind: "json/value" };
const resultEntity = { ...RESULT, snapshotId: "snap-1", label: "result", dataRoles: [], relations: [] };
function runOutput(runOverrides: Record<string, unknown> = {}, includeResult = true) {
  const full = allBundle();
  return {
    schemaVersion: "paneweft.run/1",
    run: {
      id: "run-a",
      runId: "run-1",
      status: "passed",
      assertions: [assertion("as-1", true)],
      result: RESULT,
      provenance: "read",
      evidence: ["s1"],
      ...runOverrides,
    },
    bundle: {
      schemaVersion: "paneweft.bundle/1",
      entities: includeResult ? [full.entities[0], resultEntity] : [full.entities[0]],
      definitions: [full.definitions[0]],
      views: [full.views[0]],
    },
  };
}

describe("[MC17] validateRunOutput", () => {
  // why: positive control for everything below: a valid minimal output (one passed run, one assertion, its
  //      result entity registered by the output bundle) is accepted.
  // proves: CLAIM(MC17)
  it("[MC17] a valid minimal run output is accepted", () => {
    expectOk(checkRun(runOutput()));
  });

  // why: the document is versioned like every other wire structure (SCHEMA_VERSION at /schemaVersion).
  // proves: CLAIM(MC17), CLAIM(MC1)
  it("[MC17] a wrong run schemaVersion is one SCHEMA_VERSION issue", () => {
    expectRejected(checkRun(patch(runOutput(), { op: "replace", path: "/schemaVersion", value: "paneweft.run/2" })), [{ code: "SCHEMA_VERSION", pointer: "/schemaVersion" }]);
  });
  it("[MC17] a run output that is not an object is one TYPE issue at the root", () => {
    expectRejected(checkRun("run"), [{ code: "TYPE", pointer: "" }]);
  });
  it("[MC17] a run output without `run` is REQUIRED at /run", () => {
    expectRejected(checkRun(patch(runOutput(), { op: "remove", path: "/run" })), [{ code: "REQUIRED", pointer: "/run" }]);
  });
  it("[MC17] a run output without `bundle` is REQUIRED at /bundle", () => {
    expectRejected(checkRun(patch(runOutput(), { op: "remove", path: "/bundle" })), [{ code: "REQUIRED", pointer: "/bundle" }]);
  });

  // why: the result must be inspectable: its entity has to be registered by the output bundle (design 2.7
  //      "a result entity present in its output bundle") or already known to the session (ReferenceContext).
  //      Absent from both: DANGLING_REFERENCE on /run/result. The twins show each way of resolving it.
  // proves: CLAIM(MC17)
  it("[MC17] a result entity absent from the output bundle and the context is DANGLING at /run/result", () => {
    expectRejected(checkRun(runOutput({}, false)), [{ code: "DANGLING_REFERENCE", pointer: "/run/result" }]);
  });
  it("[MC17] the same output is accepted when the context already holds the result entity", () => {
    expectOk(checkRun(runOutput({}, false), { entities: [{ ...RESULT, snapshotId: "snap-1" }] }));
  });
  it("[MC17] a result naming a different entity id than the bundle registers is DANGLING", () => {
    expectRejected(checkRun(runOutput({ result: { ...RESULT, id: "other" } })), [{ code: "DANGLING_REFERENCE", pointer: "/run/result" }]);
  });

  // why: the run rules are the same as in a view, addressed from /run: the same four rejections.
  // proves: CLAIM(MC17)
  it("[MC17] a passed run without a result is REQUIRED at /run/result", () => {
    const doc = patch(runOutput(), { op: "remove", path: "/run/result" });
    expectRejected(checkRun(doc), [{ code: "REQUIRED", pointer: "/run/result" }]);
  });
  it("[MC17] a passed run with zero assertions is SIZE at /run/assertions", () => {
    expectRejected(checkRun(runOutput({ assertions: [] })), [{ code: "SIZE", pointer: "/run/assertions" }]);
  });
  it("[MC17] a passed run with a failing assertion is PASSED_WITH_FAILED_ASSERTION at /run/status", () => {
    expectRejected(checkRun(runOutput({ assertions: [assertion("as-1", true), assertion("as-2", false)] })), [{ code: "PASSED_WITH_FAILED_ASSERTION", pointer: "/run/status" }]);
  });
  it("[MC17] a failed run with failing assertions and a result is accepted", () => {
    expectOk(checkRun(runOutput({ status: "failed", assertions: [assertion("as-1", false)] })));
  });
  it("[MC17] an error run without `error` is REQUIRED at /run/error", () => {
    const doc = patch(runOutput({ status: "error", assertions: [] }), { op: "remove", path: "/run/result" });
    expectRejected(checkRun(doc), [{ code: "REQUIRED", pointer: "/run/error" }]);
  });

  // why: the output bundle is validated with bundle rules, addressed under /bundle (MC20 prefix rule).
  // proves: CLAIM(MC17), CLAIM(MC20)
  it("[MC17] a fault inside the output bundle is addressed under /bundle", () => {
    const doc = patch(runOutput(), { op: "replace", path: "/bundle/views/0/data/rows/0/evidence", value: ["s9"] });
    expectRejected(checkRun(doc), [{ code: "DANGLING_REFERENCE", pointer: "/bundle/views/0/data/rows/0/evidence/0" }]);
  });
});

describe("[S4] a run is observed only through a run source of its own run id", () => {
  // why: S4 "example results: add a run source kind carrying the run id, so example evidence is honestly observed".
  //   An observed run must cite a declared `run` source whose run_id equals the run's runId: a run source of ANOTHER
  //   run, or a file source, would let an observation be claimed from evidence that never saw this execution.
  //   Positive control first (view form), then the output-document form, then the two dishonest twins.
  // proves: CLAIM(S4-run-source) CLAIM(MC17) CLAIM(MC5)
  it("[S4] example view: observed run citing a run source with the same run id is accepted; another run's id is PROVENANCE_RUN_REQUIRED", () => {
    const view = (runId: string) => patch(
      exampleBase(),
      { op: "add", path: "/sources/-", value: runKindSource("s3", runId) },
      { op: "replace", path: "/data/runs/0/evidence", value: ["s3"] },
    );
    expectAccepted(check(view("run-1")), "envelope");
    expectRejected(check(view("run-2")), [{ code: "PROVENANCE_RUN_REQUIRED", pointer: "/data/runs/0/provenance" }], "envelope");
  });
  it("[S4] run output: observed run with its own declared run source is accepted; with another run's id or a file source it is PROVENANCE_RUN_REQUIRED at /run/provenance", () => {
    const observed = (runSourceId: string, evidence: string[]) =>
      patch(runOutput({ provenance: "observed", evidence }), { op: "add", path: "/sources", value: [runKindSource("s3", runSourceId)] });
    expectOk(checkRun(observed("run-1", ["s3"])));
    expectRejected(checkRun(observed("run-2", ["s3"])), [{ code: "PROVENANCE_RUN_REQUIRED", pointer: "/run/provenance" }]);
    expectRejected(checkRun(observed("run-1", ["s1"])), [{ code: "PROVENANCE_RUN_REQUIRED", pointer: "/run/provenance" }]);
  });

  // why: S4 "evidence references must resolve to declared sources (dangling -> validation error)". The run and each of its
  //   assertions are items with evidence: an undeclared source id is DANGLING at the exact evidence entry, and a run source
  //   declared by the output resolves (the control).
  // proves: CLAIM(S4-dangling-evidence) CLAIM(MC17)
  it("[S4] run output: dangling evidence on the run and on an assertion is addressed at the entry; a declared output source resolves", () => {
    expectOk(checkRun(patch(runOutput({ evidence: ["s1", "s3"] }), { op: "add", path: "/sources", value: [runKindSource("s3", "run-1")] })));
    expectRejected(checkRun(runOutput({ evidence: ["s1", "s9"] })), [{ code: "DANGLING_REFERENCE", pointer: "/run/evidence/1" }]);
    const badAssertion = runOutput({ assertions: [item("as-1", { statement: "x", passed: true, evidence: ["s9"] })] });
    expectRejected(checkRun(badAssertion), [{ code: "DANGLING_REFERENCE", pointer: "/run/assertions/0/evidence/0" }]);
  });
  it("[S4] run output: a malformed run source in the output's sources is a shape issue under /sources", () => {
    const broken = runKindSource("s3", "run-1");
    delete (broken as any).run_id;
    expectRejected(checkRun(patch(runOutput(), { op: "add", path: "/sources", value: [broken] })), [{ code: "REQUIRED", pointer: "/sources/0/run_id" }]);
  });
});

describe("[N2] an observed example run has no command-only mode", () => {
  // why: N2 (final spec review). S4 added the `run` source so that example evidence is honestly observed; v0 keeps no compatibility mode
  //   for the older shape. A captured command that merely carries the run's id (`kind: command`, `runId: run-1`) says "something ran with
  //   this label", not "the runner execution this run record describes", so an observed RUN citing only that is PROVENANCE_RUN_REQUIRED
  //   at the run's provenance. The controls pin what stays valid: the migrated base, mixed file + run-source evidence, and an observed
  //   fact OUTSIDE an example (a list row) that cites a captured command with a run id.
  // proves: CLAIM(N2-no-compat) CLAIM(S4-run-source) CLAIM(MC5)
  const commandOnly = (evidence: string[]) =>
    patch(exampleBase(), { op: "replace", path: "/sources/1", value: runSource("s2", "run-1") }, { op: "replace", path: "/data/runs/0/evidence", value: evidence });
  it("[N2] positive control: the migrated base cites a run source for run-1 and is accepted", () => {
    const view = exampleBase();
    expect(view.sources.map((source: { id: string; kind: string }) => [source.id, source.kind])).toEqual([["s1", "file"], ["s2", "run"]]);
    expectAccepted(check(view), "envelope");
  });
  it("[N2] an observed run citing only a command source that carries its run id is PROVENANCE_RUN_REQUIRED at /data/runs/0/provenance", () => {
    expectRejected(check(commandOnly(["s2"])), [{ code: "PROVENANCE_RUN_REQUIRED", pointer: "/data/runs/0/provenance" }], "envelope");
  });
  it("[N2] mixing the file source with that command source does not help; mixing it with the run source does", () => {
    expectRejected(check(commandOnly(["s1", "s2"])), [{ code: "PROVENANCE_RUN_REQUIRED", pointer: "/data/runs/0/provenance" }], "envelope");
    expectAccepted(check(patch(exampleBase(), { op: "replace", path: "/data/runs/0/evidence", value: ["s1", "s2"] })), "envelope");
  });
  it("[N2] the same command-only rule holds for a paneweft.run/1 output", () => {
    const doc = patch(runOutput({ provenance: "observed", evidence: ["s3"] }), { op: "add", path: "/sources", value: [runSource("s3", "run-1")] });
    expectRejected(checkRun(doc), [{ code: "PROVENANCE_RUN_REQUIRED", pointer: "/run/provenance" }]);
  });
  it("[N2] outside an example nothing changed: an observed list row citing a captured command with a run id is still accepted", () => {
    const row = patch(
      listBase(),
      { op: "add", path: "/sources/-", value: runSource("s2", "run-1") },
      { op: "replace", path: "/data/rows/0/provenance", value: "observed" },
      { op: "replace", path: "/data/rows/0/evidence", value: ["s2"] },
    );
    expectAccepted(check(row), "envelope");
  });
});
