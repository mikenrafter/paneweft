// MC5 (validation side): provenance cannot disappear or be faked (design 2 'Shared item notation' and MC5):
// an `observed` item needs a source with a run id; an `inferred` item needs `reason` and `basis`, and the
// basis must name known items or sources. Codes/pointers: docs/red-contract.md section 2.
// The `compiled` provenance has no identification rule in the contract: see
// docs/contract-additions/val.md (open question, deliberately not tested).
import { describe, expect, it } from "vitest";
import { validateSubmission } from "./validate.ts";
import { componentFixture } from "../../test/helpers/fixtures.ts";
import { patch } from "../../test/helpers/patch.ts";
import { calm, expectAccepted, expectRejected } from "../../test/helpers/val-check.ts";
import { graphBase, item, listBase, runSource, sourceBase } from "../../test/helpers/val-fixtures.ts";

const check = (doc: unknown) => calm(() => validateSubmission(doc), "validateSubmission");
const withRunSource = (doc: Record<string, any>) => patch(doc, { op: "add", path: "/sources/-", value: runSource() });
const noRunId = { code: "PROVENANCE_RUN_REQUIRED" };

describe("[MC5] observed needs a run", () => {
  // why: "observed requires a source with a run ID" (design 2): an observed claim whose evidence has no runId
  //      would pass off a read fact as a measurement. The issue sits on the item's `provenance`.
  //      The twin below differs only by the run source: with it the same item is accepted.
  // proves: CLAIM(MC5)
  it("[MC5] an observed row whose evidence has no runId is PROVENANCE_RUN_REQUIRED", () => {
    const doc = patch(listBase(), { op: "replace", path: "/data/rows/0/provenance", value: "observed" });
    expectRejected(check(doc), [{ ...noRunId, pointer: "/data/rows/0/provenance" }], "envelope");
  });
  it("[MC5] positive control: the same observed row with a runId source in its evidence is accepted", () => {
    const doc = patch(
      withRunSource(listBase()),
      { op: "replace", path: "/data/rows/0/provenance", value: "observed" },
      { op: "replace", path: "/data/rows/0/evidence", value: ["s2"] },
    );
    expectAccepted(check(doc), "envelope");
  });

  // why: one run-bearing source among several is enough; the rule is about the item's evidence as a whole.
  // proves: CLAIM(MC5)
  it("[MC5] an observed row with evidence [file source, run source] is accepted", () => {
    const doc = patch(
      withRunSource(listBase()),
      { op: "replace", path: "/data/rows/0/provenance", value: "observed" },
      { op: "replace", path: "/data/rows/0/evidence", value: ["s1", "s2"] },
    );
    expectAccepted(check(doc), "envelope");
  });

  // why: a run source elsewhere in the envelope does not vouch for an item that does not cite it: the
  //      rule is per item, over ITS evidence, not "the envelope has some run".
  // proves: CLAIM(MC5)
  it("[MC5] a run source that the observed row does not cite does not satisfy the rule", () => {
    const doc = patch(withRunSource(listBase()), { op: "replace", path: "/data/rows/0/provenance", value: "observed" });
    expectRejected(check(doc), [{ ...noRunId, pointer: "/data/rows/0/provenance" }]);
  });

  // why: the rule applies to every item kind, not only list rows (graph edges, annotations).
  // proves: CLAIM(MC5)
  it("[MC5] an observed graph edge without a runId is rejected on the edge", () => {
    const doc = patch(graphBase(), { op: "replace", path: "/data/edges/1/provenance", value: "observed" });
    expectRejected(check(doc), [{ ...noRunId, pointer: "/data/edges/1/provenance" }]);
  });
  it("[MC5] an observed source annotation without a runId is rejected on the annotation", () => {
    const doc = patch(sourceBase(), { op: "replace", path: "/data/annotations/0/provenance", value: "observed" });
    expectRejected(check(doc), [{ ...noRunId, pointer: "/data/annotations/0/provenance" }]);
  });
  it("[MC5] two observed rows without runIds give two issues, one per row", () => {
    const doc = patch(
      listBase(),
      { op: "replace", path: "/data/rows/0/provenance", value: "observed" },
      { op: "replace", path: "/data/rows/1/provenance", value: "observed" },
    );
    expectRejected(check(doc), [
      { ...noRunId, pointer: "/data/rows/0/provenance" },
      { ...noRunId, pointer: "/data/rows/1/provenance" },
    ]);
  });

  // why: the other provenance values need no run: read/parsed/compiled facts come from files and tools.
  // proves: CLAIM(MC5)
  it.each(["read", "parsed", "compiled"])("[MC5] a %s row without a runId is accepted", (provenance) => {
    expectAccepted(check(patch(listBase(), { op: "replace", path: "/data/rows/0/provenance", value: provenance })), "envelope");
  });
});

describe("[MC5] inferred needs a reason and a basis", () => {
  const inferred = (extra: Record<string, unknown> = {}) =>
    patch(listBase(), { op: "replace", path: "/data/rows/0/provenance", value: "inferred" }, ...Object.entries(extra).map(([k, v]) => ({ op: "add" as const, path: `/data/rows/0/${k}`, value: v })));

  // why: inferred = a claim not read or observed; without the reason and the supporting basis it is an
  //      unexplained guess (design 2: "An inferred item also requires reason and basis"). Both missing
  //      -> two REQUIRED issues, sorted: basis before reason.
  // proves: CLAIM(MC5)
  it("[MC5] an inferred row without reason and basis gives two REQUIRED issues", () => {
    expectRejected(check(inferred()), [
      { code: "REQUIRED", pointer: "/data/rows/0/basis" },
      { code: "REQUIRED", pointer: "/data/rows/0/reason" },
    ], "envelope");
  });
  it("[MC5] an inferred row without a basis is one REQUIRED issue", () => {
    expectRejected(check(inferred({ reason: "naming convention" })), [{ code: "REQUIRED", pointer: "/data/rows/0/basis" }]);
  });
  it("[MC5] an inferred row without a reason is one REQUIRED issue", () => {
    expectRejected(check(inferred({ basis: ["s1"] })), [{ code: "REQUIRED", pointer: "/data/rows/0/reason" }]);
  });
  it("[MC5] an inferred row with an empty basis list is SIZE", () => {
    expectRejected(check(inferred({ reason: "naming convention", basis: [] })), [{ code: "SIZE", pointer: "/data/rows/0/basis" }]);
  });
  it("[MC5] positive control: an inferred row with reason and a source basis is accepted", () => {
    expectAccepted(check(inferred({ reason: "naming convention", basis: ["s1"] })), "envelope");
  });

  // why: the basis names "supporting item or source IDs" (design 2): a source id and an item id of the same
  //      view both resolve; an unknown id is DANGLING_REFERENCE on that basis entry.
  // proves: CLAIM(MC5), CLAIM(MC2)
  it("[MC5] positive control: a basis naming another item of the same view is accepted", () => {
    expectAccepted(check(inferred({ reason: "follows the sibling row", basis: ["second"] })), "envelope");
  });
  it("[MC5] a basis naming an unknown id is DANGLING_REFERENCE on that entry", () => {
    expectRejected(check(inferred({ reason: "naming convention", basis: ["s1", "ghost"] })), [{ code: "DANGLING_REFERENCE", pointer: "/data/rows/0/basis/1" }]);
  });
});

describe("[MC5] a view may mix every provenance", () => {
  // why: "A view mixing read, compiled, and observed facts shows all of them" (design 4): the validator must
  //      accept the mix when each item satisfies its own rule, and a regression that only allowed
  //      one provenance per view would reject this. Rows: read, parsed, compiled, observed (run), inferred.
  // proves: CLAIM(MC5)
  it("[MC5] read + parsed + compiled + observed + inferred in one list validates", () => {
    const view = withRunSource(componentFixture("list"));
    view.data.rows = [
      item("r-read", { cells: { name: "a" } }),
      item("r-parsed", { cells: { name: "b" }, provenance: "parsed" }),
      item("r-compiled", { cells: { name: "c" }, provenance: "compiled" }),
      item("r-observed", { cells: { name: "d" }, provenance: "observed", evidence: ["s2"] }),
      item("r-inferred", { cells: { name: "e" }, provenance: "inferred", reason: "same naming as r-read", basis: ["r-read", "s1"] }),
    ];
    expectAccepted(check(view), "envelope");
    expect(new Set(view.data.rows.map((r: any) => r.provenance)).size).toBe(5);
  });
});
