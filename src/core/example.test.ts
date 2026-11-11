// Example runs recorded through Session.recordExampleRun (design 2.7, 5; MC17; red-contract 10).
// The run output is a literal paneweft.run/1 document (test/helpers/store-runner.ts: passOutput) and every
// negative case differs from it by exactly one patch, so each rejection names one fault.
// Issue codes and pointers: red-contract 2 (REQUIRED at the missing property, SIZE at the array,
// PASSED_WITH_FAILED_ASSERTION at /run/status, FORBIDDEN_PROPERTY at the forbidden property,
// UNKNOWN_PROPERTY at the unknown property); the /run and /bundle prefixes are the paneweft.run/1 layout.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RecordedRun } from "./session.ts";
import { patch } from "../../test/helpers/patch.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { canonicalSha256 } from "../../test/helpers/store-canon.ts";
import { importAll, openOk } from "../../test/helpers/store-session.ts";
import { EXAMPLE_KEY, passOutput } from "../../test/helpers/store-runner.ts";
import { treeSnapshot } from "../../test/helpers/store-fs.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
const fresh = () => join(tmp("example"), "s");
const resultOf = (runId: string) => ({ repository: "r", id: `result-${runId}`, kind: "json/value" });
const pairs = (error: { errors: Array<{ code: string; pointer: string }> }) => error.errors.map((issue) => [issue.code, issue.pointer]);

async function sessionWithExample(dir = fresh(), options?: Parameters<typeof openOk>[1]) {
  const session = await openOk(dir, options);
  await importAll(session);
  return { dir, session };
}
const failedOutput = (runId: string) =>
  patch(passOutput(runId), { op: "replace", path: "/run/status", value: "failed" }, { op: "replace", path: "/run/assertions/0/passed", value: false });
const errorOutput = (runId: string) =>
  patch(passOutput(runId),
    { op: "replace", path: "/run/status", value: "error" },
    { op: "remove", path: "/run/result" },
    { op: "replace", path: "/run/assertions", value: [] },
    { op: "add", path: "/run/error", value: "fixture adapter could not start the server" },
    { op: "replace", path: "/bundle/entities", value: [] });

describe("recordExampleRun: accepted runs", () => {
  // why: MC17: a passed run with an assertion and a result entity is recorded; the RecordedRun carries the
  //   run id, the view key, the status and a content hash of the output (canonical JSON, store.md#11).
  // proves: CLAIM(MC17)
  it("[MC17] a passing run is recorded with status passed and the canonical hash of its output; listRuns returns it", async () => {
    const { session } = await sessionWithExample();
    const output = passOutput("run-1");
    const recorded = must(await session.recordExampleRun(EXAMPLE_KEY, output));
    expect(recorded).toEqual<RecordedRun>({ runId: "run-1", viewId: "vigil-one-write", snapshotId: "snap-1", status: "passed", contentHash: canonicalSha256(output) });
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([recorded]);
  });

  // why: "an example produces a tested INSPECTABLE result": the result entity from the output bundle is
  //   registered in the session and resolvable by its reference, with the data the bundle gave it.
  // proves: CLAIM(MC17)
  it("[MC17] the result entity of a passed run is registered and resolvable", async () => {
    const { session } = await sessionWithExample();
    const output = passOutput("run-1");
    must(await session.recordExampleRun(EXAMPLE_KEY, output));
    const entity = must(await session.getEntity(resultOf("run-1"), "snap-1"));
    expect(entity).toEqual(output.bundle.entities[0]);
    expect((await session.listEntities("snap-1")).map((e) => e.id)).toEqual(["mcp", "notes", "result-run-1", "watch"]);
  });

  // why: design 2.7: "Failed assertions may still return an inspectable result". A failed run with a
  //   result is accepted, recorded as failed, and its result is registered.
  // proves: CLAIM(MC17)
  it("[MC17] a failed run (failing assertion) with a result is accepted and recorded as failed", async () => {
    const { session } = await sessionWithExample();
    const recorded = must(await session.recordExampleRun(EXAMPLE_KEY, failedOutput("run-f")));
    expect(recorded.status).toBe("failed");
    expect(must(await session.getEntity(resultOf("run-f"), "snap-1")).id).toBe("result-run-f");
  });

  // why: design 2.7: "infrastructure errors explain why none exists". An error run has a message and no
  //   result; it is accepted and registers no entity.
  // proves: CLAIM(MC17)
  it("[MC17] an error run (message, no result) is accepted and registers no entity", async () => {
    const { session } = await sessionWithExample();
    const recorded = must(await session.recordExampleRun(EXAMPLE_KEY, errorOutput("run-e")));
    expect(recorded.status).toBe("error");
    expect((await session.listEntities("snap-1")).map((e) => e.id)).toEqual(["mcp", "notes", "watch"]);
  });

  // why: control for the "result must exist" rejection: when the result entity is already registered in the
  //   session, the output bundle need not carry it again (red-contract 10: "bundle or the session").
  // proves: CLAIM(MC17)
  it("[MC17] a result that resolves to an entity already in the session is accepted with an empty bundle", async () => {
    const { session } = await sessionWithExample();
    const output = patch(passOutput("run-s"), { op: "replace", path: "/run/result", value: { repository: "r", id: "mcp", kind: "code/module" } }, { op: "replace", path: "/bundle/entities", value: [] });
    expect(must(await session.recordExampleRun(EXAMPLE_KEY, output)).status).toBe("passed");
  });

  // why: runs are appended, never edited: several runs of one example are all listed, in recording order,
  //   each with its own run id (design 2.7: "repeated runs with distinct run IDs").
  // proves: CLAIM(MC17)
  it("[MC17] two runs of the same example are both listed, in recording order, with distinct run ids", async () => {
    const { session } = await sessionWithExample();
    const first = must(await session.recordExampleRun(EXAMPLE_KEY, passOutput("run-b")));
    const second = must(await session.recordExampleRun(EXAMPLE_KEY, failedOutput("run-a")));
    expect(first.runId).not.toBe(second.runId);
    expect(must(await session.listRuns(EXAMPLE_KEY)).map((run) => [run.runId, run.status])).toEqual([["run-b", "passed"], ["run-a", "failed"]]);
  });

  // why: a view with no recorded run lists no runs (design 2.7: an empty runs array says "not run").
  // proves: CLAIM(MC17)
  it("[MC17] listRuns of an example view without runs is an empty list, not an error", async () => {
    const { session } = await sessionWithExample();
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
  });

  // why: snapshot immutability (design 4): recording a run must not rewrite the stored example view; the
  //   view still says runs: [] and keeps its content hash. Runs live beside it, append-only.
  // proves: CLAIM(MC17) CLAIM(MC20)
  it("[MC17] recording a run does not change the stored example view or its content hash", async () => {
    const { session } = await sessionWithExample();
    const before = must(await session.getView(EXAMPLE_KEY));
    must(await session.recordExampleRun(EXAMPLE_KEY, passOutput("run-1")));
    const after = must(await session.getView(EXAMPLE_KEY));
    expect(after).toEqual(before);
    expect((after.envelope.data as { runs: unknown[] }).runs).toEqual([]);
  });

  // why: runs and their result entities are durable like everything else in the session.
  // proves: CLAIM(MC17)
  it("[MC17] recorded runs and result entities survive close and openSession", async () => {
    const { dir, session } = await sessionWithExample();
    const recorded = must(await session.recordExampleRun(EXAMPLE_KEY, passOutput("run-1")));
    await session.close();
    const reopened = await openOk(dir);
    expect(must(await reopened.listRuns(EXAMPLE_KEY))).toEqual([recorded]);
    expect(must(await reopened.getEntity(resultOf("run-1"), "snap-1")).label).toBe("recorded result");
  });
});

describe("recordExampleRun: rejected outputs name exactly one issue", () => {
  // why: MC17: "Reject passed-without-result". REQUIRED at the missing property; the run is not recorded and
  //   no entity appears.
  // proves: CLAIM(MC17)
  it("[MC17] passed without a result: VALIDATION_FAILED, REQUIRED at /run/result, nothing recorded", async () => {
    const { session } = await sessionWithExample();
    const output = patch(passOutput("run-1"), { op: "remove", path: "/run/result" });
    const error = mustFail(await session.recordExampleRun(EXAMPLE_KEY, output));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(pairs(error)).toEqual([["REQUIRED", "/run/result"]]);
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
  });

  // why: MC17: "Reject ... passed-with-failed-assertion": status says passed, an assertion says it did not.
  // proves: CLAIM(MC17)
  it("[MC17] passed with a failed assertion: PASSED_WITH_FAILED_ASSERTION at /run/status", async () => {
    const { session } = await sessionWithExample();
    const output = patch(passOutput("run-1"), { op: "replace", path: "/run/assertions/0/passed", value: false });
    const error = mustFail(await session.recordExampleRun(EXAMPLE_KEY, output));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(pairs(error)).toEqual([["PASSED_WITH_FAILED_ASSERTION", "/run/status"]]);
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
  });

  // why: design 2.7: "Avoid ... a scenario without assertions as a tested example": a passed run needs at
  //   least one assertion (minItems 1 -> SIZE at the array).
  // proves: CLAIM(MC17)
  it("[MC17] passed with zero assertions: SIZE at /run/assertions", async () => {
    const { session } = await sessionWithExample();
    const output = patch(passOutput("run-1"), { op: "replace", path: "/run/assertions", value: [] });
    const error = mustFail(await session.recordExampleRun(EXAMPLE_KEY, output));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(pairs(error)).toEqual([["SIZE", "/run/assertions"]]);
  });

  // why: an error run explains why no result exists; carrying a result contradicts that.
  // proves: CLAIM(MC17)
  it("[MC17] an error run that also has a result: FORBIDDEN_PROPERTY at /run/result", async () => {
    const { session } = await sessionWithExample();
    const output = patch(errorOutput("run-e"), { op: "add", path: "/run/result", value: resultOf("run-e") });
    const error = mustFail(await session.recordExampleRun(EXAMPLE_KEY, output));
    expect(pairs(error)).toEqual([["FORBIDDEN_PROPERTY", "/run/result"]]);
  });

  // why: an error run without its explanation is useless to a reader: REQUIRED at /run/error.
  // proves: CLAIM(MC17)
  it("[MC17] an error run without a message: REQUIRED at /run/error", async () => {
    const { session } = await sessionWithExample();
    const output = patch(errorOutput("run-e"), { op: "remove", path: "/run/error" });
    const error = mustFail(await session.recordExampleRun(EXAMPLE_KEY, output));
    expect(pairs(error)).toEqual([["REQUIRED", "/run/error"]]);
  });

  // why: only error runs carry an error message; a failed run with one is mixing the two outcomes.
  // proves: CLAIM(MC17)
  it("[MC17] a failed run that carries an error message: FORBIDDEN_PROPERTY at /run/error", async () => {
    const { session } = await sessionWithExample();
    const output = patch(failedOutput("run-f"), { op: "add", path: "/run/error", value: "oops" });
    const error = mustFail(await session.recordExampleRun(EXAMPLE_KEY, output));
    expect(pairs(error)).toEqual([["FORBIDDEN_PROPERTY", "/run/error"]]);
  });

  // why: the wrong document version is a version fault, not a shape fault.
  // proves: CLAIM(MC17)
  it("[MC17] schemaVersion paneweft.run/2: SCHEMA_VERSION at /schemaVersion", async () => {
    const { session } = await sessionWithExample();
    const output = patch(passOutput("run-1"), { op: "replace", path: "/schemaVersion", value: "paneweft.run/2" });
    const error = mustFail(await session.recordExampleRun(EXAMPLE_KEY, output));
    expect(pairs(error)).toEqual([["SCHEMA_VERSION", "/schemaVersion"]]);
  });

  // why: the result must resolve to an entity in the bundle or the session (red-contract 10); a reference
  //   to nothing is DANGLING_REFERENCE at the referring value, and the run is not recorded.
  // proves: CLAIM(MC17)
  it("[MC17] a result that is in neither the bundle nor the session: DANGLING_REFERENCE at /run/result", async () => {
    const { session } = await sessionWithExample();
    const output = patch(passOutput("run-1"), { op: "replace", path: "/bundle/entities", value: [] });
    const error = mustFail(await session.recordExampleRun(EXAMPLE_KEY, output));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(pairs(error)).toEqual([["DANGLING_REFERENCE", "/run/result"]]);
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
  });

  // why: the run's evidence ids resolve against the example view's sources (store.md#12); an unknown source
  //   id is DANGLING_REFERENCE at the evidence entry.
  // proves: CLAIM(MC17)
  it("[MC17] run evidence naming an unknown source: DANGLING_REFERENCE at /run/evidence/0", async () => {
    const { session } = await sessionWithExample();
    const output = patch(passOutput("run-1"), { op: "replace", path: "/run/evidence/0", value: "s-unknown" });
    const error = mustFail(await session.recordExampleRun(EXAMPLE_KEY, output));
    expect(pairs(error)).toEqual([["DANGLING_REFERENCE", "/run/evidence/0"]]);
  });
});

describe("recordExampleRun: a payload cannot install a runner", () => {
  const evil = { id: "vigil-one-write", executable: "/bin/sh", argv: ["-c", "touch PWNED"], workspaceRoot: "/", parameterSchema: {}, timeoutMs: 1000, outputBundlePath: "x.json" };

  // why: MC17: "A payload cannot install or execute a runner." Runner definitions come only from the owner's
  //   registry file (design 5). An extra `runners`/`runner` key anywhere in the output is an unknown property.
  // proves: CLAIM(MC17)
  it.each([
    ["top-level runners", [{ op: "add", path: "/runners", value: [evil] }], "/runners"],
    ["top-level runner", [{ op: "add", path: "/runner", value: evil }], "/runner"],
    ["runner inside the run", [{ op: "add", path: "/run/runner", value: evil }], "/run/runner"],
    ["runners inside the bundle", [{ op: "add", path: "/bundle/runners", value: [evil] }], "/bundle/runners"],
  ] as const)("[MC17] %s: VALIDATION_FAILED UNKNOWN_PROPERTY and nothing is stored", async (_name, ops, pointer) => {
    const { dir, session } = await sessionWithExample();
    const treeBefore = treeSnapshot(dir);
    const error = mustFail(await session.recordExampleRun(EXAMPLE_KEY, patch(passOutput("run-1"), ...ops)));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(pairs(error)).toEqual([["UNKNOWN_PROPERTY", pointer]]);
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
    expect(treeSnapshot(dir)).toEqual(treeBefore);
  });
});

describe("recordExampleRun: identity, scope and atomicity", () => {
  // why: run ids are unique per example: recording the same run id twice is DUPLICATE_RUN, and the first
  //   record stays untouched even when the second carries different content (append-only).
  // proves: CLAIM(MC17)
  it("[MC17] the same runId twice is DUPLICATE_RUN; the first record is unchanged", async () => {
    const { session } = await sessionWithExample();
    const first = must(await session.recordExampleRun(EXAMPLE_KEY, passOutput("run-1")));
    expect(mustFail(await session.recordExampleRun(EXAMPLE_KEY, passOutput("run-1"))).code).toBe("DUPLICATE_RUN");
    expect(mustFail(await session.recordExampleRun(EXAMPLE_KEY, failedOutput("run-1"))).code).toBe("DUPLICATE_RUN");
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([first]);
  });

  // why: a run is recorded against a view that exists; an unknown (view, snapshot) is NOT_FOUND and never
  //   falls back to another snapshot.
  // proves: CLAIM(MC17)
  it("[MC17] recording against an unknown view or snapshot is NOT_FOUND", async () => {
    const { session } = await sessionWithExample();
    expect(mustFail(await session.recordExampleRun({ viewId: "no-such", snapshotId: "snap-1" }, passOutput("run-1"))).code).toBe("NOT_FOUND");
    expect(mustFail(await session.recordExampleRun({ viewId: "vigil-one-write", snapshotId: "snap-2" }, passOutput("run-1"))).code).toBe("NOT_FOUND");
  });

  // why: only an example view has scenarios and runs; recording against a list view is an argument fault
  //   (store.md#13, a proposal).
  // proves: CLAIM(MC17)
  it("[MC17] recording against a view that is not an example view is INVALID_ARGUMENT", async () => {
    const { session } = await sessionWithExample();
    const error = mustFail(await session.recordExampleRun({ viewId: "modules", snapshotId: "snap-1" }, passOutput("run-1")));
    expect(error.code).toBe("INVALID_ARGUMENT");
  });

  // why: red-contract 10: the output bundle is registered "with the same atomicity as importBundle". A run
  //   whose bundle holds an invalid member (alias cycle in the definitions) is rejected as a whole: the run is
  //   not recorded, the result entity is not registered, and the directory tree is untouched.
  // proves: CLAIM(MC17) CLAIM(MC20)
  it("[MC17] an invalid member in the output bundle rejects the whole run: no run, no entity, tree identical", async () => {
    const { dir, session } = await sessionWithExample();
    const forward = (id: string, other: string) => ({ id, entityKind: "json/value", title: id, component: "list", requires: [], dataRole: "raw", forward: { entityId: "watch", viewDefinitionId: other } });
    const output = patch(passOutput("run-1"), { op: "replace", path: "/bundle/definitions", value: [forward("loop-a", "loop-b"), forward("loop-b", "loop-a")] });
    const treeBefore = treeSnapshot(dir);
    const error = mustFail(await session.recordExampleRun(EXAMPLE_KEY, output));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect([...new Set(error.errors.map((issue) => issue.code))]).toEqual(["ALIAS_CYCLE"]);
    expect(error.errors.every((issue) => issue.pointer === "/bundle/definitions/0/forward" || issue.pointer === "/bundle/definitions/1/forward")).toBe(true);
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
    expect(mustFail(await session.getEntity(resultOf("run-1"), "snap-1")).code).toBe("NOT_FOUND");
    expect(treeSnapshot(dir)).toEqual(treeBefore);
  });

  // why: a failed save (injected) records nothing - neither run nor entity - and, because nothing was
  //   recorded, the same run id can be retried (it is not DUPLICATE_RUN).
  // proves: CLAIM(MC17) CLAIM(MC20)
  it("[MC17] a failing manifest swap: STORAGE_FAILED, no run, no entity, and the same runId succeeds on retry", async () => {
    let armed = false;
    const { session } = await sessionWithExample(fresh(), { testHooks: { beforeManifestSwap: () => { if (armed) throw new Error("boom"); } } });
    armed = true;
    expect(mustFail(await session.recordExampleRun(EXAMPLE_KEY, passOutput("run-1"))).code).toBe("STORAGE_FAILED");
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
    expect(mustFail(await session.getEntity(resultOf("run-1"), "snap-1")).code).toBe("NOT_FOUND");
    armed = false;
    expect(must(await session.recordExampleRun(EXAMPLE_KEY, passOutput("run-1"))).status).toBe("passed");
  });
});
