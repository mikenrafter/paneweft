// view_result against runs of several examples (field test F8, F9). Object ids restart in every capture, so in a run of three examples
// "o1" names three objects; the selector that names ONE of them is the example (or the stored view id), and the reply says which example it
// answers, so the recollect command repeats that example and no other.
import { describe, expect, it } from "vitest";
import { Capture, defineType } from "../../packages/paneweft-ts/src/index.ts";
import { specLimits } from "../../packages/paneweft-ts/test/support.ts";
import { runCliInProcess } from "../../test/helpers/cli.ts";
import { must } from "../../test/helpers/must.ts";
import { multiExampleImport } from "../../test/helpers/v1-runs.ts";
import { makeToolWorld } from "../../test/helpers/v1-tool-world.ts";
import { collectionFixture, useFakeQex, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { importCollection } from "./import.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const fake = useFakeQex();
const toolWorld = makeToolWorld({ open, tmp, fake });

/** Three selected examples; the first calls a fourth (a nested invocation with its own capture), as `watch.cancelled` calls `pending_watch()`. */
async function threeExamples() {
  const world = await toolWorld();
  must(await importCollection(world.session, multiExampleImport("run-v-1", [{ id: "watch.pending", calls: ["watch.nested"] }, { id: "watch.cancelled" }, { id: "watch.redelivered" }])), "import");
  return world;
}

describe("[F8] a run of several examples is addressable by example", () => {
  // why: F8. `result --run R --view V` failed with "3 stored views match: name one with observation" and every candidate was `o1`. The example the
  // agent selected must pick its own result, nested calls of other examples included in the run.
  // proves: CLAIM(F8-example-selector)
  it("view_result with an example returns that example's own capture", async () => {
    const { okCall } = await threeExamples();
    for (const [example, capture] of [["watch.pending", "inv-1"], ["watch.cancelled", "inv-3"], ["watch.redelivered", "inv-4"]] as const) {
      const { payload } = await okCall("view_result", { run: "run-v-1", view: "watch.events", example });
      expect(payload.details.storedViewId, example).toBe(`${capture}.o1.watch.events`);
      expect(payload.details.example, example).toMatchObject({ id: example });
    }
  });

  // why: F8. The nested call of watch.nested is a result of its own example: selecting it names the nested capture (inv-2), not the caller's.
  // proves: CLAIM(F8-example-selector)
  it("an example that only ran nested is selected by its nested capture", async () => {
    const { okCall } = await threeExamples();
    const { payload } = await okCall("view_result", { run: "run-v-1", view: "watch.events", example: "watch.nested" });
    expect(payload.details.storedViewId).toBe("inv-2.o1.watch.events");
    expect(payload.details.example).toMatchObject({ id: "watch.nested", nested: true });
  });

  // why: F8. An example that is not in the run, or one that is but has no such view, is an error that lists what the run has, not a silent pick.
  // proves: CLAIM(F8-example-selector)
  it("an example the run does not hold lists the examples it does", async () => {
    const { call } = await threeExamples();
    const { outcome, payload } = await call("view_result", { run: "run-v-1", view: "watch.events", example: "watch.missing" });
    expect(outcome.ok).toBe(false);
    expect(payload.code).toBe("NOT_FOUND");
    expect(payload.message).toMatch(/watch\.missing/);
    expect(payload.details.examples).toEqual(["watch.cancelled", "watch.nested", "watch.pending", "watch.redelivered"]);
  });

  // why: NIT-STASH (review field r1). The cursor query of `view_result` omitted the example, and the captures of two examples can hold equal rows: a cursor issued for one example
  // continued the other instead of being refused. The example is part of what a cursor continues.
  // proves: CLAIM(cursor-content-bound)
  it("a cursor issued for one example is refused for another", async () => {
    const Row = defineType<{ n: number }>({ id: "vigil::watch::Row", source: { path: "src/watch.rs", symbol: "Row" } });
    Row.view({ id: "watch.rows", title: "Rows", question: "Which rows?", priority: 10, component: "list", render(_row, view) {
      const table = view.table().textColumn("n", "N");
      for (let index = 0; index < 60; index += 1) table.row({ id: `r${index}`, cells: { n: `row ${index}` } });
      return table.done();
    } });
    const capture = new Capture({ captureId: "inv-1", runId: "run-1", invocationId: "inv-1", limits: specLimits() });
    capture.publish({ n: 1 }, Row);
    const world = await toolWorld();
    const base = collectionFixture("vigil-redelivered");
    must(await importCollection(world.session, multiExampleImport("run-v-1", [{ id: "watch.cancelled" }, { id: "watch.redelivered" }], { ...base, graphs: [capture.finish().toJSON()] })), "import");
    const ask = (example: string, cursor?: string) => world.call("view_result", { run: "run-v-1", view: "watch.rows", example, maxBytes: 4096, ...(cursor === undefined ? {} : { cursor }) });
    const page = await ask("watch.cancelled");
    expect(page.outcome.ok, page.outcome.body.slice(0, 300)).toBe(true);
    expect(page.payload.cursor, "60 rows do not fit one page").not.toBeNull();
    const other = await ask("watch.redelivered", page.payload.cursor);
    expect(other.outcome.ok).toBe(false);
    expect(other.payload.code).toBe("CURSOR_MISMATCH");
    expect((await ask("watch.cancelled", page.payload.cursor)).outcome.ok, "the same example continues").toBe(true);
  });

  // why: F8. The error of an ambiguous selector must say something that can be followed: the old hint asked for "observation (an object id)" and all
  // three candidates had the object id o1. The hint now names the example values that are in the run, and following it works.
  // proves: CLAIM(F8-usable-hint)
  it("the ambiguity error names a value that resolves it, and following it succeeds", async () => {
    const { call, okCall } = await threeExamples();
    const first = await call("view_result", { run: "run-v-1", view: "watch.events" });
    expect(first.outcome.ok).toBe(false);
    expect(first.payload.code).toBe("UNRESOLVED_TARGET");
    const hint = JSON.stringify(first.payload);
    expect(hint, "the old advice cannot be followed").not.toMatch(/name one with observation \(an object id\)/);
    expect(hint).toMatch(/Pass example \(one of watch\.pending, watch\.nested/);
    const candidates = first.payload.details.candidates as Array<{ exampleId: string; storedViewId: string; object: string; nested: boolean }>;
    expect(candidates.map((candidate) => candidate.object), "the object ids do collide, which is why the hint cannot ask for one").toEqual(["o1", "o1", "o1", "o1"]);
    // the first candidate's own words, followed literally
    const byExample = await okCall("view_result", { run: "run-v-1", view: "watch.events", example: candidates[0]!.exampleId });
    expect(byExample.payload.details.storedViewId).toBe(candidates[0]!.storedViewId);
    const byId = await okCall("view_result", { run: "run-v-1", view: candidates[1]!.storedViewId });
    expect(byId.payload.details.storedViewId).toBe(candidates[1]!.storedViewId);
  });

  // why: F8, field data (`run-cm-3`: mapping.renamed calls mapping.parsed, and mapping.parsed also ran on its own). The example `mapping.parsed` has two captures, but its own,
  // top-level one is what `example` selects, so the hint still names the examples; asking for the stored view id instead would send the reader to a longer way.
  // proves: CLAIM(F8-usable-hint)
  it("names the examples when each of them resolves to one capture, nested duplicates included", async () => {
    const world = await toolWorld();
    must(await importCollection(world.session, multiExampleImport("run-cm-3", [{ id: "mapping.renamed", calls: ["mapping.parsed"] }, { id: "mapping.parsed" }])), "import");
    const refused = await world.call("view_result", { run: "run-cm-3", view: "watch.events" });
    expect(refused.payload.code).toBe("UNRESOLVED_TARGET");
    expect(refused.payload.message).toMatch(/Pass example \(one of mapping\.renamed, mapping\.parsed\)/);
    const own = await world.okCall("view_result", { run: "run-cm-3", view: "watch.events", example: "mapping.parsed" });
    expect(own.payload.details.storedViewId, "the top-level capture, not the one nested in mapping.renamed").toBe("inv-3.o1.watch.events");
  });

  // why: F8. The candidates say which one is the selected example's own result and which a nested call, so the agent can choose.
  // proves: CLAIM(F8-usable-hint)
  it("each candidate says whether it was a nested call", async () => {
    const { call } = await threeExamples();
    const { payload } = await call("view_result", { run: "run-v-1", view: "watch.events" });
    expect(payload.details.candidates.map((c: any) => [c.exampleId, c.nested])).toEqual([["watch.pending", false], ["watch.nested", true], ["watch.cancelled", false], ["watch.redelivered", false]]);
  });

  // why: F8. `--args '{"observation":"o1"}'` returned the same ambiguity. An observation that is an object id shared by several captures says so and
  // names the qualified form that picks one (capture.object).
  // proves: CLAIM(F8-usable-hint)
  it("an object id shared by several captures is refused with the qualified ids", async () => {
    const { call, okCall } = await threeExamples();
    const shared = await call("view_result", { run: "run-v-1", view: "watch.events", observation: "o1" });
    expect(shared.outcome.ok).toBe(false);
    expect(shared.payload.code).toBe("UNRESOLVED_TARGET");
    expect(shared.payload.message, "the refusal explains why an object id does not pick one").toMatch(/restart in every capture/);
    expect(JSON.stringify(shared.payload.errors)).toMatch(/inv-3\.o1/);
    const qualified = await okCall("view_result", { run: "run-v-1", view: "watch.events", observation: "inv-3.o1" });
    expect(qualified.payload.details.storedViewId).toBe("inv-3.o1.watch.events");
  });

  // why: F8. The CLI has no --example/--observation flag: help listed --run --job --view only. Flags and tool arguments must be the same set.
  // proves: CLAIM(F8-cli-flags)
  it("the CLI takes --example and --observation", async () => {
    const world = await threeExamples();
    await world.session.close();
    const byExample = await runCliInProcess(["result", "--run", "run-v-1", "--view", "watch.events", "--example", "watch.cancelled", "--format", "json"], { env: { PANEWEFT_SESSION: world.dir } });
    expect(byExample.exitCode, byExample.stderr + byExample.stdout.slice(0, 300)).toBe(0);
    expect(JSON.parse(byExample.stdout).details.storedViewId).toBe("inv-3.o1.watch.events");
    const byObservation = await runCliInProcess(["result", "--run", "run-v-1", "--view", "watch.events", "--observation", "inv-4.o1", "--format", "json"], { env: { PANEWEFT_SESSION: world.dir } });
    expect(byObservation.exitCode, byObservation.stderr + byObservation.stdout.slice(0, 300)).toBe(0);
    expect(JSON.parse(byObservation.stdout).details.storedViewId).toBe("inv-4.o1.watch.events");
  });
});

describe("[F9] recollect names the example that produced the result", () => {
  // why: F9. `recollect.command` named the first passed example of the run (watch.cancelled) for a view that watch.redelivered captured.
  // proves: CLAIM(F9-recollect-example)
  it("repeats the example of the capture the view belongs to", async () => {
    const { okCall } = await threeExamples();
    for (const [example, capture] of [["watch.pending", "inv-1"], ["watch.nested", "inv-2"], ["watch.cancelled", "inv-3"], ["watch.redelivered", "inv-4"]] as const) {
      const { payload } = await okCall("view_result", { run: "run-v-1", view: `${capture}.o1.watch.events` });
      expect(payload.details.recollect.command, example).toMatch(new RegExp(`--example ${example.replace(".", "\\.")}$`));
    }
  });
});
