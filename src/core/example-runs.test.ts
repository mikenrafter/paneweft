// why: review S8. deriveExampleEnvelope is pure, so its edge cases are tested directly: an envelope run wins over a recorded run of the same runId,
// a recorded run that cannot be merged validly is left out and named (never merged half-way), and a recorded source that collides with a different
// source of the view is renamed with its evidence. Expected ids are derived by the rule in the module header: `<runId>/<id>` and `<runId>:<id>`.
// proves: CLAIM(recorded-runs-visible) CLAIM(derived-valid)
import { describe, expect, it } from "vitest";
import { deriveExampleEnvelope } from "./example-runs.ts";
import { validateSubmission } from "./validate.ts";
import type { Envelope } from "./wire.ts";
import { clone, componentFixture } from "../../test/helpers/fixtures.ts";
import { passOutput } from "../../test/helpers/store-runner.ts";

const example = (): Envelope => clone(componentFixture("example")) as Envelope;
const runsOf = (envelope: Envelope): Array<{ id: string; runId: string; assertions: Array<{ id: string; evidence: string[] }> }> => (envelope.data as unknown as { runs: Array<{ id: string; runId: string; assertions: Array<{ id: string; evidence: string[] }> }> }).runs;

describe("deriveExampleEnvelope", () => {
  it("control: no recorded run leaves the envelope as it is and reports nothing recorded", () => {
    const base = example();
    const derived = deriveExampleEnvelope(base, []);
    expect(derived.envelope).toEqual(base);
    expect(derived.recorded.byItemId.size).toBe(0);
    expect(derived.recorded.notice).toBeNull();
  });

  it("appends recorded runs after the envelope's, keeps the result valid, and identifies each by its run item id", () => {
    const derived = deriveExampleEnvelope(example(), [{ contentHash: "h1", output: passOutput("r1") }, { contentHash: "h2", output: passOutput("r2") }]);
    expect(runsOf(derived.envelope).map((run) => run.runId)).toEqual(["r1", "r2"]);
    expect([...derived.recorded.byItemId]).toEqual([["run-r1", { runId: "r1", contentHash: "h1" }], ["run-r2", { runId: "r2", contentHash: "h2" }]]);
    expect(validateSubmission(derived.envelope).ok).toBe(true);
    expect(runsOf(derived.envelope).map((run) => run.assertions[0]?.id), "the second a1 collides with the first and is renamed").toEqual(["a1", "r2/a1"]);
  });

  it("a recorded run whose runId the envelope already shows is not added twice", () => {
    const first = deriveExampleEnvelope(example(), [{ contentHash: "h1", output: passOutput("r1") }]).envelope;
    const again = deriveExampleEnvelope(first, [{ contentHash: "h1", output: passOutput("r1") }]);
    expect(runsOf(again.envelope).map((run) => run.runId)).toEqual(["r1"]);
    expect(again.recorded.byItemId.size).toBe(0);
  });

  it("a recorded run citing a source nobody declares is left out and named in the notice", () => {
    const bad = passOutput("bad");
    bad.run.evidence = ["no-such-source"];
    const derived = deriveExampleEnvelope(example(), [{ contentHash: "hb", output: bad }, { contentHash: "h1", output: passOutput("r1") }]);
    expect(runsOf(derived.envelope).map((run) => run.runId)).toEqual(["r1"]);
    expect(derived.recorded.notice).toContain("bad");
    expect(derived.recorded.notice).toContain("DANGLING_REFERENCE");
  });

  it("a recorded source that collides with a different source of the view is renamed and the evidence follows", () => {
    const colliding = passOutput("c1");
    colliding.sources = [{ id: "s1", kind: "tool", name: "other-tool", version: "1.0.0" }];
    const derived = deriveExampleEnvelope(example(), [{ contentHash: "hc", output: colliding }]);
    expect(derived.recorded.notice).toBeNull();
    expect(derived.envelope.sources.map((source) => source.id)).toEqual(["s1", "c1:s1"]);
    expect(runsOf(derived.envelope)[0]?.assertions[0]?.evidence).toEqual(["c1:s1"]);
    expect(validateSubmission(derived.envelope).ok).toBe(true);
  });
});
