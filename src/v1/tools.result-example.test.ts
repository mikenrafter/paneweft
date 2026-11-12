// A value captured by a failed example (field test F24). `result` showed `completeness: complete`, every field `observed`, and nothing about the
// failed example or its failed claim: a reader took the half-built value for an observation that a passing example vouched for.
import { describe, expect, it } from "vitest";
import { must } from "../../test/helpers/must.ts";
import { multiExampleImport } from "../../test/helpers/v1-runs.ts";
import { makeToolWorld } from "../../test/helpers/v1-tool-world.ts";
import { useFakeQex, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { createSessionSource } from "../viewer/session-source.ts";
import { importCollection } from "./import.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const fake = useFakeQex();
const toolWorld = makeToolWorld({ open, tmp, fake });

const BROKEN = [{ claim: "CMX", passed: false, message: "expected 'Work' to be 'Personal'" }, { claim: "CM1", passed: true }];

async function runWith(examples: Parameters<typeof multiExampleImport>[1]) {
  const world = await toolWorld();
  must(await importCollection(world.session, multiExampleImport("run-cmf-1", examples)), "import");
  return world;
}

describe("[F24] a result says which example produced it and how that example ended", () => {
  // why: F24. `run-cmf-1`, example `mapping.broken` (check CMX failed): the result named no example, no outcome, no claim.
  // proves: CLAIM(F24-failed-example)
  it("names the example, its outcome and the failed claims", async () => {
    const { okCall, text } = await runWith([{ id: "mapping.broken", outcome: "failed", checks: BROKEN }]);
    const { payload } = await okCall("view_result", { run: "run-cmf-1", view: "watch.status" });
    expect(payload.details.example).toMatchObject({ id: "mapping.broken", outcome: "failed", verified: false, failedClaims: [{ claim: "CMX", message: "expected 'Work' to be 'Personal'" }] });
    expect(payload.notices.join("\n")).toMatch(/captured by a failed example/);
    const body = (await text("view_result", { run: "run-cmf-1", view: "watch.status" })).body;
    expect(body).toContain("example mapping.broken: failed");
    expect(body).toContain("failed claims: CMX (expected 'Work' to be 'Personal')");
    expect(body).toMatch(/notice: .*captured by a failed example/);
  });

  // why: F24. An example that crashed (error) has no failed claim; the outcome and the message from the runner still have to be there.
  // proves: CLAIM(F24-failed-example)
  it("an example that errored names the outcome and has no failed claim to show", async () => {
    const { okCall } = await runWith([{ id: "mapping.crashed", outcome: "error", checks: [] }]);
    const { payload } = await okCall("view_result", { run: "run-cmf-1", view: "watch.status" });
    expect(payload.details.example).toMatchObject({ id: "mapping.crashed", outcome: "error", failedClaims: [] });
    expect(payload.notices.join("\n")).toMatch(/captured by a failed example/);
  });

  // why: F24. The control: a passing example is named but not marked, and no notice is added to a good result.
  // proves: CLAIM(F24-failed-example)
  it("a passed example is named and carries no failure notice", async () => {
    const { okCall } = await runWith([{ id: "mapping.parsed", checks: [{ claim: "CM1", passed: true }] }]);
    const { payload } = await okCall("view_result", { run: "run-cmf-1", view: "watch.status" });
    expect(payload.details.example).toMatchObject({ id: "mapping.parsed", outcome: "passed", verified: true, failedClaims: [] });
    expect(payload.notices.join("\n")).not.toMatch(/failed example/);
  });

  // why: F24. The nested call of a failed example is a result of the passing (or failing) example that was called; only its OWN outcome counts.
  // proves: CLAIM(F24-failed-example)
  it("reports the outcome of the invocation that made the capture, not of its caller", async () => {
    const { okCall } = await runWith([{ id: "mapping.outer", outcome: "failed", checks: BROKEN, calls: ["mapping.inner"] }]);
    const inner = (await okCall("view_result", { run: "run-cmf-1", view: "inv-2.o1.watch.status" })).payload;
    expect(inner.details.example).toMatchObject({ id: "mapping.inner", nested: true, outcome: "passed" });
    expect(inner.notices.join("\n")).not.toMatch(/failed example/);
  });

  // why: F24. The viewer reads the same facts from the same place: the model it is given for a collected view carries the example.
  // proves: CLAIM(F24-failed-example)
  it("the viewer's model for the view carries the example", async () => {
    const { session, okCall } = await runWith([{ id: "mapping.broken", outcome: "failed", checks: BROKEN }]);
    const key = { viewId: (await okCall("view_result", { run: "run-cmf-1", view: "watch.status" })).payload.details.storedViewId as string, snapshotId: "snap-run-cmf-1" };
    const model = await createSessionSource(session).getView(key);
    expect(model.ok).toBe(true);
    if (model.ok) expect(model.value.example).toMatchObject({ id: "mapping.broken", outcome: "failed", failedClaims: [{ claim: "CMX" }] });
  });
});
