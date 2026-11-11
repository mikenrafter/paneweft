// Review round 2, S11 [provenance-integrity]: merging a recorded run into an example view renames the run's item ids (`<runId>/<id>`) and colliding sources
// (`<runId>:<id>`) so they stay unique, but only `evidence` followed the renaming. An inferred item's `basis` (ids of the supporting items or sources) kept
// the OLD id, which after the merge names a DIFFERENT thing: the view's own scenario `once`, or another run's source. The merged view still validates, so
// nothing flags that the reasoning now cites the wrong fact.
// A run output is validated on its own (validateRunOutput): its `basis` can name only its own items and sources, so that is the only meaning a basis id has
// here, and the merge must keep it. Every test resolves the references in the MERGED envelope and compares what they resolve to with what the run meant,
// using supporting facts that are told apart by their text (not by their ids, which is what the merge changes).
// proves: CLAIM(derived-valid) CLAIM(recorded-runs-visible)
import { describe, expect, it } from "vitest";
import { deriveExampleEnvelope } from "./example-runs.ts";
import { viewItems } from "./items.ts";
import { validateSubmission } from "./validate.ts";
import type { Envelope } from "./wire.ts";
import { clone, componentFixture } from "../../test/helpers/fixtures.ts";
import { passOutput, type Doc } from "../../test/helpers/store-runner.ts";

const example = (): Envelope => clone(componentFixture("example")) as Envelope;

/** What a reference means in the merged view: an item (by its statement or label) or a source (by its name or path); items win, as in the run's own namespace. */
function meaning(envelope: Envelope, id: string): string {
  const item = viewItems(envelope).find((candidate) => candidate.id === id);
  if (item !== undefined) return `item:${String(item.statement ?? item.label)}`;
  const source = envelope.sources.find((candidate) => candidate.id === id) as { name?: string; path?: string } | undefined;
  return source === undefined ? `nothing:${id}` : `source:${source.name ?? source.path}`;
}
const assertionsOf = (envelope: Envelope, runId: string): Array<Record<string, any>> =>
  ((envelope.data as any).runs as Array<Record<string, any>>).find((run) => run.runId === runId)?.assertions ?? [];
const runOf = (envelope: Envelope, runId: string): Record<string, any> => ((envelope.data as any).runs as Array<Record<string, any>>).find((run) => run.runId === runId) as Record<string, any>;

/** A passing run whose assertion `own` collides with the view's scenario `once`, and an inferred assertion that rests on `own`. */
function collidingRun(runId: string): Doc {
  const output = passOutput(runId);
  output.run.assertions = [
    { id: "once", statement: `${runId} sibling that the reasoning rests on`, passed: true, provenance: "read", evidence: ["s1"] },
    { id: "a-inferred", statement: `${runId} conclusion`, passed: true, provenance: "inferred", reason: "follows from its sibling", basis: ["once"], evidence: ["s1"] },
  ];
  return output;
}

describe("[S11] a recorded run's basis follows the renaming of the ids it names", () => {
  // why: the run's basis ["once"] meant its own assertion; after the merge "once" is the view's scenario, a different fact.
  it("a basis naming an item whose id was renamed names the renamed item, not the view's item that took the old id", () => {
    const base = example();
    const scenario = meaning(base, "once");
    const merged = deriveExampleEnvelope(base, [{ contentHash: "h1", output: collidingRun("r1") }]).envelope;
    const [sibling, conclusion] = assertionsOf(merged, "r1") as [Record<string, any>, Record<string, any>];
    expect(sibling.id, "the colliding id was made unique").toBe("r1/once");
    expect(conclusion.basis.map((id: string) => meaning(merged, id))).toEqual(["item:r1 sibling that the reasoning rests on"]);
    expect(meaning(merged, conclusion.basis[0]), "and it is not the view's own scenario").not.toBe(scenario);
    expect(validateSubmission(merged).ok).toBe(true);
  });

  // why: two recorded runs that each reason from their own "once" must not end up resting on each other's, or on the first one's twice.
  it("two runs with the same colliding ids each keep their own basis", () => {
    const merged = deriveExampleEnvelope(example(), [{ contentHash: "h1", output: collidingRun("r1") }, { contentHash: "h2", output: collidingRun("r2") }]).envelope;
    for (const runId of ["r1", "r2"]) {
      const conclusion = assertionsOf(merged, runId)[1] as Record<string, any>;
      expect(conclusion.basis.map((id: string) => meaning(merged, id)), runId).toEqual([`item:${runId} sibling that the reasoning rests on`]);
    }
    expect(viewItems(merged).map((item) => item.id).sort()).toEqual([...new Set(viewItems(merged).map((item) => item.id))].sort());
  });

  // why: the run item itself can be inferred, resting on one of its assertions; its id and its assertions' ids are renamed together.
  it("a run inferred from its own assertion follows that assertion's new id", () => {
    const first = passOutput("r1");
    const second = passOutput("r2"); // its assertion a1 collides with r1's a1 and becomes r2/a1
    Object.assign(second.run, { provenance: "inferred", reason: "it passed", basis: ["a1"] });
    const merged = deriveExampleEnvelope(example(), [{ contentHash: "h1", output: first }, { contentHash: "h2", output: second }]).envelope;
    expect(assertionsOf(merged, "r2")[0]?.id).toBe("r2/a1");
    expect(runOf(merged, "r2").basis).toEqual(["r2/a1"]);
    expect(validateSubmission(merged).ok).toBe(true);
  });

  // why: sources are renamed too, and a basis may name a source; it has to rest on the source the run declared, not on the view's different source of that id.
  it("a basis naming a source that was renamed names the renamed source", () => {
    const output = passOutput("c1");
    output.sources = [{ id: "s1", kind: "tool", name: "other-tool", version: "1.0.0" }];
    output.run.assertions[0] = { ...output.run.assertions[0], provenance: "inferred", reason: "the tool said so", basis: ["s1"] };
    const base = example();
    const merged = deriveExampleEnvelope(base, [{ contentHash: "hc", output }]).envelope;
    const assertion = assertionsOf(merged, "c1")[0] as Record<string, any>;
    expect(assertion.evidence.map((id: string) => meaning(merged, id))).toEqual(["source:other-tool"]);
    expect(assertion.basis.map((id: string) => meaning(merged, id))).toEqual(["source:other-tool"]);
    expect(meaning(base, "s1"), "the view's own s1 is a different source").not.toBe("source:other-tool");
    expect(validateSubmission(merged).ok).toBe(true);
  });

  // why: a source cited only as basis was never declared in the merged view (only evidence pulled sources in), so a valid run was dropped as dangling.
  it("a source the run offers and cites only as basis is declared in the merged view, and the run is kept", () => {
    const output = passOutput("b1");
    output.sources = [{ id: "x9", kind: "tool", name: "basis-only-tool", version: "2.0.0" }];
    output.run.assertions[0] = { ...output.run.assertions[0], provenance: "inferred", reason: "from the tool", basis: ["x9"] };
    const derived = deriveExampleEnvelope(example(), [{ contentHash: "hb", output }]);
    expect(derived.recorded.notice, "the run was not left out").toBeNull();
    const assertion = assertionsOf(derived.envelope, "b1")[0] as Record<string, any>;
    expect(assertion.basis.map((id: string) => meaning(derived.envelope, id))).toEqual(["source:basis-only-tool"]);
    expect(validateSubmission(derived.envelope).ok).toBe(true);
  });

  // control: with nothing colliding, the run is merged exactly as recorded (ids, evidence, basis); the rewrite is not a blanket renaming.
  it("control: a run whose ids and sources collide with nothing is merged unchanged", () => {
    const output = passOutput("n1");
    output.run.assertions = [
      { id: "n1-first", statement: "first", passed: true, provenance: "read", evidence: ["s1"] },
      { id: "n1-second", statement: "second", passed: true, provenance: "inferred", reason: "from the first", basis: ["n1-first", "s1"], evidence: ["s1"] },
    ];
    const merged = deriveExampleEnvelope(example(), [{ contentHash: "hn", output: clone(output) }]).envelope;
    expect(runOf(merged, "n1")).toEqual(output.run);
    expect(validateSubmission(merged).ok).toBe(true);
  });
});
