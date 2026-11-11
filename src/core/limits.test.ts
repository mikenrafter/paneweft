// MC14: the v0 limits, exercised through validateSubmission with exactly-at / one-over pairs
// (design section 4: "v0 accepts at most 2 MiB per view, 8 MiB per bundle, and 10,000 fact items per view;
// its graph budget is 200 nodes and 500 edges. Input checks cap nesting at 32 levels and strings at
// 64 KiB of UTF-8 ... Oversize payloads fail with the applicable limit and a suggestion to scope or
// partition the view."). Every number below is written as a literal with its arithmetic; nothing is
// imported from src/core/limits.ts.
// Placement: this file covers the limit pass of validateSubmission, so it sits beside limits.ts.
// Decisions beyond the design (limit pass short-circuits the schema pass; depth counted from the root
// document = level 1; array-level item counting) are in docs/contract-additions/val.md.
import { assert, describe, expect, it } from "vitest";
import { validateSubmission } from "./validate.ts";
import { allBundle, componentFixture } from "../../test/helpers/fixtures.ts";
import { patch } from "../../test/helpers/patch.ts";
import { calm, expectAccepted, expectRejected } from "../../test/helpers/val-check.ts";
import { MIB, bytes, graphBase, item, nestedArrays, nestedObjects, padListView, paddedBundle, shapeBase, sourceBase, treeBase } from "../../test/helpers/val-fixtures.ts";

const check = (doc: unknown) => calm(() => validateSubmission(doc), "validateSubmission");
const list = () => componentFixture("list");
const limit = (pointer: string) => ({ code: "LIMIT_EXCEEDED", pointer });

/** Every LIMIT_EXCEEDED hint for an item/size limit must suggest narrowing the scope or partitioning the view. */
function expectScopeHint(doc: unknown) {
  const report = check(doc);
  if (report.ok) assert.fail("expected a rejection");
  for (const issue of report.errors) expect(issue.hint.toLowerCase()).toMatch(/scope|partition/);
}

const rowsOf = (count: number) => Array.from({ length: count }, (_, index) => item(`r${index}`, { cells: { name: "v" } }));

describe("[MC14] fact items per view: 10,000", () => {
  // why: boundary pair for the fact-item cap. 10,000 rows are accepted (about 700 KB, below 2 MiB, so only
  //      the item cap is in play); 10,001 are rejected on the rows array - never silently truncated.
  // proves: CLAIM(MC14)
  it("[MC14] exactly 10,000 list rows are accepted", () => {
    const doc = patch(list(), { op: "replace", path: "/data/rows", value: rowsOf(10_000) });
    expect(bytes(doc)).toBeLessThan(2 * MIB);
    expectAccepted(check(doc), "envelope");
  });
  it("[MC14] 10,001 list rows are one LIMIT_EXCEEDED on /data/rows with a scope-or-partition hint", () => {
    const doc = patch(list(), { op: "replace", path: "/data/rows", value: rowsOf(10_001) });
    expect(bytes(doc)).toBeLessThan(2 * MIB);
    expectRejected(check(doc), [limit("/data/rows")], "envelope");
    expectScopeHint(doc);
  });

  // why: the cap is per view for every component's item array, not a list special case.
  // proves: CLAIM(MC14)
  it("[MC14] exactly 10,000 tree nodes (all roots) are accepted", () => {
    const nodes = Array.from({ length: 10_000 }, (_, index) => item(`n${index}`, { cells: { name: "v" }, children: [], childrenState: "complete" }));
    const doc = patch(treeBase(), { op: "replace", path: "/data/nodes", value: nodes }, { op: "replace", path: "/data/roots", value: nodes.map((n) => n.id) });
    expect(bytes(doc)).toBeLessThan(2 * MIB);
    expectAccepted(check(doc), "envelope");
  });
  it.each([
    ["tree nodes", () => patch(treeBase(), { op: "replace", path: "/data/nodes", value: Array.from({ length: 10_001 }, (_, i) => item(`n${i}`, { cells: { name: "v" }, children: [], childrenState: "complete" })) }), "/data/nodes"],
    ["shape fields", () => patch(shapeBase(), { op: "replace", path: "/data/fields", value: Array.from({ length: 10_001 }, (_, i) => item(`f${i}`, { path: "p", type: "t", presence: "optional", children: [] })) }), "/data/fields"],
    ["notebook blocks", () => patch(componentFixture("notebook"), { op: "replace", path: "/data/blocks", value: Array.from({ length: 10_001 }, (_, i) => item(`b${i}`, { kind: "prose", markdown: "m" })) }), "/data/blocks"],
    ["source annotations", () => patch(sourceBase(), { op: "replace", path: "/data/annotations", value: Array.from({ length: 10_001 }, (_, i) => item(`a${i}`, { lines: [4, 4], message: "m", claimIds: [] })) }), "/data/annotations"],
  ])("[MC14] 10,001 %s are one LIMIT_EXCEEDED on the array", (_name, build, pointer) => {
    const doc = build();
    expect(bytes(doc)).toBeLessThan(2 * MIB);
    expectRejected(check(doc), [limit(pointer)], "envelope");
  });
});

describe("[MC14] graph budget: 200 nodes, 500 edges", () => {
  const nodes = (count: number) => Array.from({ length: count }, (_, index) => item(`n${index}`));
  const edges = (count: number) => Array.from({ length: count }, (_, index) => item(`e${index}`, { from: "n0", to: "n1", relation: "calls" }));
  const graph = (nodeCount: number, edgeCount: number) => {
    const doc = graphBase();
    doc.data = { nodes: nodes(nodeCount), edges: edges(edgeCount), layout: "layered" };
    return doc;
  };

  // why: boundary pairs 200/201 nodes and 500/501 edges (design 4 / 2.3). Parallel edges n0->n1 are legal,
  //      so the 500-edge graph needs only two nodes.
  // proves: CLAIM(MC14)
  it("[MC14] exactly 200 nodes (no edges) are accepted", () => {
    expectAccepted(check(graph(200, 0)), "envelope");
  });
  it("[MC14] 201 nodes are one LIMIT_EXCEEDED on /data/nodes with a scope-or-partition hint", () => {
    expectRejected(check(graph(201, 0)), [limit("/data/nodes")], "envelope");
    expectScopeHint(graph(201, 0));
  });
  it("[MC14] exactly 500 edges (two nodes) are accepted", () => {
    expectAccepted(check(graph(2, 500)), "envelope");
  });
  it("[MC14] 501 edges are one LIMIT_EXCEEDED on /data/edges with a scope-or-partition hint", () => {
    expectRejected(check(graph(2, 501)), [limit("/data/edges")], "envelope");
    expectScopeHint(graph(2, 501));
  });
  it("[MC14] 201 nodes and 501 edges give both limit issues, sorted by pointer", () => {
    expectRejected(check(graph(201, 501)), [limit("/data/edges"), limit("/data/nodes")]);
  });
});

describe("[MC14] view size: 2 MiB = 2,097,152 bytes of JSON.stringify", () => {
  // why: boundary pair on the whole-view byte size. 2 MiB = 2 * 1024 * 1024 = 2,097,152. The view is padded
  //      with cell strings below 64 KiB to hit the byte count EXACTLY (builder checks its own arithmetic).
  //      Pointer "" = the whole document (red-contract section 2).
  // proves: CLAIM(MC14)
  it("[MC14] a view of exactly 2,097,152 bytes is accepted", () => {
    const doc = padListView(list(), 2_097_152);
    expect(bytes(doc)).toBe(2_097_152);
    expectAccepted(check(doc), "envelope");
  });
  it("[MC14] a view of 2,097,153 bytes is one LIMIT_EXCEEDED on the document with a scope-or-partition hint", () => {
    const doc = padListView(list(), 2_097_153);
    expect(bytes(doc)).toBe(2_097_153);
    expectRejected(check(doc), [limit("")], "envelope");
    expectScopeHint(doc);
  });
  it("[MC14] a view of 3 MiB is also one LIMIT_EXCEEDED on the document", () => {
    expectRejected(check(padListView(list(), 3 * 1024 * 1024)), [limit("")]);
  });

  // why: the size is UTF-8 BYTES, not UTF-16 length: padding with 3-byte characters makes the string length
  //      a third of the byte count, so a length-based check would wrongly accept this over-limit view.
  // proves: CLAIM(MC14)
  it("[MC14] the byte limit counts UTF-8 bytes, not characters", () => {
    // Start 4 bytes under the cap (2,097,148) and append 2 x "€" (6 bytes, 2 UTF-16 units):
    // 2,097,148 + 6 = 2,097,154 bytes (over) but 2,097,148 + 2 = 2,097,150 UTF-16 units (under).
    const doc = padListView(list(), 2_097_152 - 4);
    doc.data.rows[0].cells.name = doc.data.rows[0].cells.name + "€€";
    expect(bytes(doc)).toBe(2_097_154);
    expect(JSON.stringify(doc).length).toBe(2_097_150);
    expectRejected(check(doc), [limit("")]);
  });
});

describe("[MC14] bundle size: 8 MiB = 8,388,608 bytes", () => {
  // why: boundary pair on the bundle. 8 MiB = 8 * 1024 * 1024 = 8,388,608. The bundle holds the seven fixture
  //      views and four padded list views (each below the 2 MiB view cap), so only the bundle cap can fire.
  //      Pointer "" = the whole bundle.
  // proves: CLAIM(MC14)
  it("[MC14] a bundle of exactly 8,388,608 bytes made of valid views is accepted", () => {
    const bundle = paddedBundle(8_388_608);
    expect(bytes(bundle)).toBe(8_388_608);
    for (const view of bundle.views) expect(bytes(view)).toBeLessThanOrEqual(2_097_152);
    expectAccepted(check(bundle), "bundle");
  });
  it("[MC14] a bundle of 8,388,609 bytes is one LIMIT_EXCEEDED on the bundle with a scope-or-partition hint", () => {
    const bundle = paddedBundle(8_388_609);
    expect(bytes(bundle)).toBe(8_388_609);
    for (const view of bundle.views) expect(bytes(view)).toBeLessThanOrEqual(2_097_152);
    expectRejected(check(bundle), [limit("")], "bundle");
    expectScopeHint(bundle);
  });

  // why: the per-view cap also applies to a bundle member, and the issue must point at the member, not
  //      the whole bundle (the bundle itself, about 2.1 MiB, is far below 8 MiB).
  // proves: CLAIM(MC14), CLAIM(MC20)
  it("[MC14] a bundle member of 2,097,153 bytes is LIMIT_EXCEEDED on /views/7", () => {
    const bundle = allBundle();
    bundle.views.push(padListView({ ...list(), id: "huge" }, 2_097_153)); // index 7: after the seven fixture views
    expect(bytes(bundle.views[7])).toBe(2_097_153);
    expect(bytes(bundle)).toBeLessThan(8_388_608);
    expectRejected(check(bundle), [limit("/views/7")], "bundle");
  });
});

describe("[MC14] nesting: 32 levels, root document = level 1", () => {
  // Pointer arithmetic. The envelope is level 1. A wrapper chain is attached as the unknown top-level key
  // `extra`: wrapper k (k = 1 is the outermost) is at level 1 + k, at pointer "/extra" + "/0"*(k-1) for arrays
  // and "/extra" + "/a"*(k-1) for objects. 31 wrappers end at level 32 (allowed); 32 wrappers end at level 33,
  // so the FIRST container beyond the cap is wrapper 32 at "/extra" + 31 tokens.
  // why: boundary pair for the nesting cap. At 31 wrappers the limit pass must let the document through to
  //      the schema, which then rejects the unknown key (UNKNOWN_PROPERTY, NOT LIMIT_EXCEEDED); at 32 it must
  //      stop at the first container at level 33.
  // proves: CLAIM(MC14)
  const withExtra = (value: unknown) => patch(list(), { op: "add", path: "/extra", value });

  it.each([
    ["arrays", nestedArrays],
    ["objects", nestedObjects],
  ] as const)("[MC14] 31 nested %s pass the limit pass and fail only as an unknown property", (_name, build) => {
    expectRejected(check(withExtra(build(31))), [{ code: "UNKNOWN_PROPERTY", pointer: "/extra" }], "envelope");
  });
  it.each([
    ["arrays", nestedArrays, "0"],
    ["objects", nestedObjects, "a"],
  ] as const)("[MC14] 32 nested %s are LIMIT_EXCEEDED at the first container on level 33", (_name, build, token) => {
    expectRejected(check(withExtra(build(32))), [limit("/extra" + `/${token}`.repeat(31))], "envelope");
  });

  // why: depth is measured from the submitted document's root, so inside a bundle a view member starts at
  //      level 3 (bundle 1, views array 2, view 3): wrapper k is at level 3 + k. 29 wrappers -> level 32 OK;
  //      30 wrappers -> level 33, first offender wrapper 30 at "/views/0/extra" + 29 tokens.
  // proves: CLAIM(MC14)
  const bundleWithExtra = (value: unknown) => patch(allBundle(), { op: "add", path: "/views/0/extra", value });
  it("[MC14] in a bundle, 29 nested arrays inside a view pass the limit pass", () => {
    expectRejected(check(bundleWithExtra(nestedArrays(29))), [{ code: "UNKNOWN_PROPERTY", pointer: "/views/0/extra" }], "bundle");
  });
  it("[MC14] in a bundle, 30 nested arrays inside a view are LIMIT_EXCEEDED at level 33", () => {
    expectRejected(check(bundleWithExtra(nestedArrays(30))), [limit("/views/0/extra" + "/0".repeat(29))], "bundle");
  });

  // why: a hostile document 2,000 levels deep must produce the same bounded answer, not a stack overflow
  //      or a thrown RangeError (the helper turns a throw into an assertion failure).
  // proves: CLAIM(MC14)
  it("[MC14] 2,000 nested arrays give the same issue as 32 (first container at level 33)", () => {
    expectRejected(check(withExtra(nestedArrays(2000))), [limit("/extra" + "/0".repeat(31))], "envelope");
  });
});

describe("[MC14] strings: 64 KiB of UTF-8 = 65,536 bytes", () => {
  // Arithmetic. 64 KiB = 64 * 1024 = 65,536 bytes. ASCII: 1 byte/char. "€" (U+20AC): 3 bytes, so
  // 21,845 chars = 65,535 bytes (ok) and 21,846 = 65,538 (over). "😀" (U+1F600): 4 bytes and 2 UTF-16 units,
  // so 16,384 chars = 65,536 bytes (ok) and 16,385 = 65,540 (over). In all cases the JS string length stays
  // below 65,536 for the multibyte rows, so only a BYTE check can reject them.
  // why: boundary pair for the string cap measured in UTF-8 bytes (design 4), at a cell, which the schema
  //      itself bounds at 65,536 characters.
  // proves: CLAIM(MC14)
  const cell = (text: string) => patch(list(), { op: "replace", path: "/data/rows/0/cells/name", value: text });
  it.each([
    ["65,536 ASCII bytes", "x".repeat(65_536)],
    ["21,845 euro signs (65,535 bytes)", "€".repeat(21_845)],
    ["16,384 emoji (65,536 bytes)", "😀".repeat(16_384)],
  ])("[MC14] a cell of %s is accepted", (_name, text) => {
    expectAccepted(check(cell(text)), "envelope");
  });
  it.each([
    ["65,537 ASCII bytes", "x".repeat(65_537)],
    ["21,846 euro signs (65,538 bytes)", "€".repeat(21_846)],
    ["16,385 emoji (65,540 bytes)", "😀".repeat(16_385)],
  ])("[MC14] a cell of %s is one LIMIT_EXCEEDED on that cell", (_name, text) => {
    expectRejected(check(cell(text)), [limit("/data/rows/0/cells/name")], "envelope");
  });
});

describe("[MC14] limits are reported before, and instead of, shape errors", () => {
  // why: a limit breach must never be masked or buried: validating a hostile oversize document against the
  //      full schema first is the cost the limit pass exists to avoid, and an over-limit document must never
  //      be reported as merely invalid-or-valid. With a schema fault ALSO present, only the limit issue is
  //      returned (contract-additions/val.md Q1). Each pair below has the same extra fault.
  // proves: CLAIM(MC14)
  it("[MC14] 10,001 rows plus a title fault report only the row limit", () => {
    const doc = patch(list(), { op: "replace", path: "/data/rows", value: rowsOf(10_001) }, { op: "replace", path: "/title", value: "" });
    expectRejected(check(doc), [limit("/data/rows")]);
  });
  it("[MC14] a 65,537-character label reports LIMIT_EXCEEDED, not the 256-character label bound", () => {
    const doc = patch(list(), { op: "add", path: "/data/rows/0/label", value: "l".repeat(65_537) });
    expectRejected(check(doc), [limit("/data/rows/0/label")]);
  });
  it("[MC14] 32 nested arrays plus a missing title report only the nesting limit", () => {
    const doc = patch(list(), { op: "add", path: "/extra", value: nestedArrays(32) }, { op: "remove", path: "/title" });
    expectRejected(check(doc), [limit("/extra" + "/0".repeat(31))]);
  });
  it("[MC14] a string breach and a row breach are both reported, sorted by pointer", () => {
    const doc = patch(
      list(),
      { op: "replace", path: "/data/rows", value: rowsOf(10_001) },
      { op: "replace", path: "/data/rows/0/cells/name", value: "x".repeat(65_537) },
    );
    expectRejected(check(doc), [limit("/data/rows"), limit("/data/rows/0/cells/name")]);
  });
  // proves the contrast: just inside every limit, the same title fault IS reported as the schema issue.
  it("[MC14] control: at 10,000 rows the same title fault is the ordinary SIZE issue", () => {
    const doc = patch(list(), { op: "replace", path: "/data/rows", value: rowsOf(10_000) }, { op: "replace", path: "/title", value: "" });
    expectRejected(check(doc), [{ code: "SIZE", pointer: "/title" }]);
  });
});
