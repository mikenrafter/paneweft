// MC2: semantic checks run after shape validation (design section 5: "referential integrity, unique IDs,
// valid line ranges, contiguous paths, variant rules, and cycle constraints"). Codes and pointers come from
// docs/red-contract.md section 2 (semantic table). Each negative differs from a valid base by one fault, and
// each rule has an accepting twin (a positive control built beside the rejecting case).
// Reference scope: a single envelope is checked intra-document only (red-contract section 2).
import { describe, expect, it } from "vitest";
import { validateSubmission } from "./validate.ts";
import { allBundle } from "../../test/helpers/fixtures.ts";
import { patch, type PatchOp } from "../../test/helpers/patch.ts";
import { calm, expectAccepted, expectRejected, type Expected } from "../../test/helpers/val-check.ts";
import { exampleBase, graphBase, item, listBase, notebookBase, shapeBase, sourceBase, treeBase } from "../../test/helpers/val-fixtures.ts";

const check = (doc: unknown) => calm(() => validateSubmission(doc), "validateSubmission");

interface Case {
  name: string;
  ops: PatchOp[];
  expected: Expected[];
}
/** Each case is built from `base`, which must itself be accepted (checked once per table by the first test). */
function table(base: () => Record<string, any>, cases: Case[]) {
  it.each(cases)("[MC2] $name", ({ ops, expected }) => {
    expectRejected(check(patch(base(), ...ops)), expected, "envelope");
  });
}

describe("[MC2] duplicate item ids (one id namespace per view)", () => {
  // why: ids are opaque but unique within one view across ALL of its arrays (red-contract section 2,
  //      DUPLICATE_ID); the issue sits on the LATER occurrence's `id`.
  // proves: CLAIM(MC2)
  it("[MC2] positive control: the list, tree, graph, source, shape, notebook and example bases are accepted", () => {
    for (const base of [listBase, treeBase, graphBase, sourceBase, shapeBase, notebookBase, exampleBase]) expectAccepted(check(base()), "envelope");
  });

  table(listBase, [
    { name: "list: a repeated row id points at the later row", ops: [{ op: "replace", path: "/data/rows/1/id", value: "mcp" }], expected: [{ code: "DUPLICATE_ID", pointer: "/data/rows/1/id" }] },
  ]);
  table(treeBase, [
    { name: "tree: an extra node repeating a node id points at the later node", ops: [{ op: "add", path: "/data/nodes/-", value: item("a", { cells: { name: "dup" }, children: [], childrenState: "complete" }) }], expected: [{ code: "DUPLICATE_ID", pointer: "/data/nodes/4/id" }] },
  ]);
  table(graphBase, [
    { name: "graph: a node repeating a node id points at the later node", ops: [{ op: "add", path: "/data/nodes/-", value: item("a") }], expected: [{ code: "DUPLICATE_ID", pointer: "/data/nodes/3/id" }] },
    { name: "graph: an EDGE reusing a NODE id clashes (one namespace per view), pointer on the edge", ops: [{ op: "add", path: "/data/edges/-", value: item("a", { from: "a", to: "b", relation: "calls" }) }], expected: [{ code: "DUPLICATE_ID", pointer: "/data/edges/3/id" }] },
    {
      name: "graph: three occurrences give two issues, on the second and third",
      ops: [{ op: "add", path: "/data/nodes/-", value: item("a") }, { op: "add", path: "/data/nodes/-", value: item("a") }],
      expected: [{ code: "DUPLICATE_ID", pointer: "/data/nodes/3/id" }, { code: "DUPLICATE_ID", pointer: "/data/nodes/4/id" }],
    },
  ]);
  table(sourceBase, [
    { name: "source: an annotation reusing the excerpt id points at the annotation", ops: [{ op: "replace", path: "/data/annotations/0/id", value: "x" }], expected: [{ code: "DUPLICATE_ID", pointer: "/data/annotations/0/id" }] },
  ]);
  table(shapeBase, [
    { name: "shape: a field repeating a field id points at the later field", ops: [{ op: "add", path: "/data/fields/-", value: item("f", { path: "other", type: "string", presence: "optional", children: [] }) }], expected: [{ code: "DUPLICATE_ID", pointer: "/data/fields/2/id" }] },
  ]);
  table(notebookBase, [
    { name: "notebook: a block repeating a block id points at the later block", ops: [{ op: "replace", path: "/data/blocks/1/id", value: "b1" }], expected: [{ code: "DUPLICATE_ID", pointer: "/data/blocks/1/id" }] },
  ]);
  table(exampleBase, [
    { name: "example: an assertion reusing the scenario id points at the assertion", ops: [{ op: "replace", path: "/data/runs/0/assertions/0/id", value: "once" }], expected: [{ code: "DUPLICATE_ID", pointer: "/data/runs/0/assertions/0/id" }] },
  ]);

  // why: ids are case-sensitive opaque strings; "A" and "a" are different ids (no normalisation).
  // proves: CLAIM(MC2)
  it("[MC2] ids differing only by case are not duplicates", () => {
    expectAccepted(check(patch(graphBase(), { op: "add", path: "/data/nodes/-", value: item("A") })), "envelope");
  });
});

describe("[MC2] dangling references", () => {
  // why: every id used as a reference must resolve inside the document (red-contract section 2,
  //      DANGLING_REFERENCE); the issue sits on the referring value.
  // proves: CLAIM(MC2)
  table(listBase, [
    { name: "evidence naming an unknown source id", ops: [{ op: "replace", path: "/data/rows/0/evidence", value: ["s9"] }], expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/rows/0/evidence/0" }] },
    { name: "the second of two evidence ids is unknown", ops: [{ op: "replace", path: "/data/rows/0/evidence", value: ["s1", "s9"] }], expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/rows/0/evidence/1" }] },
    { name: "a cell for a column that does not exist", ops: [{ op: "add", path: "/data/rows/0/cells/ghost", value: 1 }], expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/rows/0/cells/ghost" }] },
    { name: "order.key naming an unknown column", ops: [{ op: "replace", path: "/data/order/key", value: "ghost" }], expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/order/key" }] },
  ]);
  table(graphBase, [
    // e3 (c->a) is on no path, so a broken endpoint on it cannot also break path continuity.
    { name: "an edge whose `from` is unknown", ops: [{ op: "replace", path: "/data/edges/2/from", value: "zz" }], expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/edges/2/from" }] },
    { name: "an edge whose `to` is unknown", ops: [{ op: "replace", path: "/data/edges/2/to", value: "zz" }], expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/edges/2/to" }] },
    {
      name: "both endpoints unknown give two issues, from before to",
      ops: [{ op: "replace", path: "/data/edges/2/from", value: "y" }, { op: "replace", path: "/data/edges/2/to", value: "z" }],
      expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/edges/2/from" }, { code: "DANGLING_REFERENCE", pointer: "/data/edges/2/to" }],
    },
    { name: "an edge endpoint that is an EDGE id (endpoints must be nodes)", ops: [{ op: "replace", path: "/data/edges/2/to", value: "e2" }], expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/edges/2/to" }] },
    { name: "focus.node unknown", ops: [{ op: "replace", path: "/data/focus/node", value: "zz" }], expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/focus/node" }] },
    { name: "a path naming an unknown edge", ops: [{ op: "replace", path: "/data/paths/0/edgeIds", value: ["e1", "zz"] }], expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/paths/0/edgeIds/1" }] },
    { name: "a path naming a node id instead of an edge id", ops: [{ op: "replace", path: "/data/paths/0/edgeIds", value: ["a"] }], expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/paths/0/edgeIds/0" }] },
    {
      name: "an unknown edge in the middle of a path hides no other fault and adds no continuity issue",
      ops: [{ op: "replace", path: "/data/paths/0/edgeIds", value: ["e1", "zz", "e3"] }],
      expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/paths/0/edgeIds/1" }],
    },
  ]);
  table(treeBase, [
    { name: "a root naming an unknown node", ops: [{ op: "replace", path: "/data/roots", value: ["zz"] }], expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/roots/0" }] },
    { name: "a child naming an unknown node", ops: [{ op: "replace", path: "/data/nodes/2/children", value: ["zz"] }], expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/nodes/2/children/0" }] },
    { name: "a tree cell for an unknown column", ops: [{ op: "add", path: "/data/nodes/0/cells/ghost", value: 1 }], expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/nodes/0/cells/ghost" }] },
  ]);
  table(shapeBase, [
    { name: "a field child naming an unknown field", ops: [{ op: "replace", path: "/data/fields/0/children", value: ["zz"] }], expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/fields/0/children/0" }] },
    { name: "a field ref naming an unknown field", ops: [{ op: "replace", path: "/data/fields/1/ref", value: "zz" }], expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/fields/1/ref" }] },
  ]);
  table(sourceBase, [
    { name: "an annotation's evidence naming an unknown source id", ops: [{ op: "replace", path: "/data/annotations/0/evidence", value: ["s7"] }], expected: [{ code: "DANGLING_REFERENCE", pointer: "/data/annotations/0/evidence/0" }] },
  ]);

  // why: the accepting twins: sparse cells, a recursive shape ref (to itself or an ancestor), and a root
  //      that is also reachable as a child are legitimate; none is dangling.
  // proves: CLAIM(MC2)
  it("[MC2] a row may omit cells for some columns", () => {
    expectAccepted(check(patch(listBase(), { op: "replace", path: "/data/rows/0/cells", value: {} })), "envelope");
  });
  it("[MC2] a shape field may reference itself (recursive type)", () => {
    expectAccepted(check(patch(shapeBase(), { op: "replace", path: "/data/fields/1/ref", value: "g" })), "envelope");
  });
});

describe("[MC2] single-envelope scope: cross-view references are deferred", () => {
  // why: red-contract section 2: a single envelope is checked intra-document only; notebook viewId and
  //      {viewId,itemId} targets resolve at render/import against the registry, so they are NOT errors here.
  // proves: CLAIM(MC2), CLAIM(MC8)
  it("[MC2] a notebook view block and claim target naming views not in the envelope are accepted", () => {
    const doc = patch(
      notebookBase(),
      { op: "replace", path: "/data/blocks/1/viewId", value: "some-other-view" },
      { op: "replace", path: "/data/blocks/2/supports", value: [{ viewId: "another-view", itemId: "any-item" }] },
    );
    expectAccepted(check(doc), "envelope");
  });
});

describe("[MC2] path continuity (graph e1: a->b, e2: b->c, e3: c->a)", () => {
  // why: a path is a walk: edge N+1 must start where edge N ends (design 5 'contiguous paths'); direction
  //      matters. The issue sits on the offending edgeIds/N, the first edge that does not connect.
  // proves: CLAIM(MC2)
  table(graphBase, [
    { name: "[e1,e3] skips b->c: e3 starts at c, e1 ended at b", ops: [{ op: "replace", path: "/data/paths/0/edgeIds", value: ["e1", "e3"] }], expected: [{ code: "PATH_DISCONTINUOUS", pointer: "/data/paths/0/edgeIds/1" }] },
    { name: "[e2,e1] reverses the order: e1 starts at a, e2 ended at c", ops: [{ op: "replace", path: "/data/paths/0/edgeIds", value: ["e2", "e1"] }], expected: [{ code: "PATH_DISCONTINUOUS", pointer: "/data/paths/0/edgeIds/1" }] },
    { name: "[e1,e2,e1] is broken only at index 2", ops: [{ op: "replace", path: "/data/paths/0/edgeIds", value: ["e1", "e2", "e1"] }], expected: [{ code: "PATH_DISCONTINUOUS", pointer: "/data/paths/0/edgeIds/2" }] },
    {
      name: "[e1,e3,e3] is broken at index 1 and again at index 2",
      ops: [{ op: "replace", path: "/data/paths/0/edgeIds", value: ["e1", "e3", "e3"] }],
      expected: [{ code: "PATH_DISCONTINUOUS", pointer: "/data/paths/0/edgeIds/1" }, { code: "PATH_DISCONTINUOUS", pointer: "/data/paths/0/edgeIds/2" }],
    },
  ]);

  it.each([
    ["a single edge", ["e1"]],
    ["two connected edges", ["e1", "e2"]],
    ["the whole cycle and back to its start", ["e1", "e2", "e3", "e1"]],
    ["a walk around the cycle more than once", ["e1", "e2", "e3", "e1", "e2"]],
  ])("[MC2] positive control: a path of %s is accepted", (_name, edgeIds) => {
    expectAccepted(check(patch(graphBase(), { op: "replace", path: "/data/paths/0/edgeIds", value: edgeIds })), "envelope");
  });
});

describe("[MC2] line ranges", () => {
  // why: lines are [first,last], one-based inclusive, first <= last (design 2); a reversed range is
  //      INVALID_LINE_RANGE on the `lines` array (red-contract section 2) - on an item anchor AND on an annotation.
  // proves: CLAIM(MC2)
  table(listBase, [
    { name: "an item anchor [5,3] is reversed", ops: [{ op: "add", path: "/data/rows/0/anchor", value: { repository: "r", path: "src/mcp.rs", lines: [5, 3] } }], expected: [{ code: "INVALID_LINE_RANGE", pointer: "/data/rows/0/anchor/lines" }] },
  ]);
  table(graphBase, [
    { name: "a graph node anchor [9,2] is reversed", ops: [{ op: "add", path: "/data/nodes/0/anchor", value: { repository: "r", path: "src/mcp.rs", lines: [9, 2] } }], expected: [{ code: "INVALID_LINE_RANGE", pointer: "/data/nodes/0/anchor/lines" }] },
  ]);
  table(sourceBase, [
    // excerpt anchor is [4,6]; [6,5] lies inside it, so no second issue can arise.
    { name: "an annotation [6,5] is reversed", ops: [{ op: "replace", path: "/data/annotations/0/lines", value: [6, 5] }], expected: [{ code: "INVALID_LINE_RANGE", pointer: "/data/annotations/0/lines" }] },
    // The reversed excerpt range makes containment meaningless; the single fault is the range itself.
    { name: "the excerpt anchor [6,4] is reversed and the annotation is not additionally reported", ops: [{ op: "replace", path: "/data/excerpt/anchor/lines", value: [6, 4] }], expected: [{ code: "INVALID_LINE_RANGE", pointer: "/data/excerpt/anchor/lines" }] },
  ]);

  // why: equal bounds are one line, inclusive: [5,5] is valid (a reversed-range check using <= would reject it).
  // proves: CLAIM(MC2)
  it("[MC2] a one-line anchor [5,5] is accepted", () => {
    expectAccepted(check(patch(listBase(), { op: "add", path: "/data/rows/0/anchor", value: { repository: "r", path: "src/mcp.rs", lines: [5, 5] } })), "envelope");
  });
});

describe("[MC2] annotations must lie inside the excerpt (excerpt anchor lines [4,6])", () => {
  // why: an annotation outside the stored excerpt cannot be shown against stored bytes (design 2.4: "expand only
  //      within stored source bounds"); ANNOTATION_OUTSIDE_EXCERPT sits on the annotation's `lines`.
  //      Boundary pairs: [3,4] starts one before, [6,7] ends one after; [4,6], [5,5], [4,4], [6,6] are inside.
  // proves: CLAIM(MC2)
  it.each([
    ["starts one line before the excerpt", [3, 4]],
    ["ends one line after the excerpt", [6, 7]],
    ["encloses the excerpt and more", [1, 9]],
    ["lies wholly above", [1, 2]],
    ["lies wholly below", [8, 9]],
  ])("[MC2] an annotation that %s is rejected", (_name, lines) => {
    expectRejected(
      check(patch(sourceBase(), { op: "replace", path: "/data/annotations/0/lines", value: lines })),
      [{ code: "ANNOTATION_OUTSIDE_EXCERPT", pointer: "/data/annotations/0/lines" }],
      "envelope",
    );
  });
  it.each([
    ["exactly the excerpt", [4, 6]],
    ["its first line", [4, 4]],
    ["its last line", [6, 6]],
    ["a middle line", [5, 5]],
  ])("[MC2] an annotation covering %s is accepted", (_name, lines) => {
    expectAccepted(check(patch(sourceBase(), { op: "replace", path: "/data/annotations/0/lines", value: lines })), "envelope");
  });
});

describe("[MC2] tree cycles", () => {
  // why: node ids are occurrences and a node being its own descendant is a structural cycle, rejected
  //      (design 2.2). The issue sits on the children/N value that CLOSES the cycle (red-contract section 2),
  //      once per cycle, not once per member. Base: a->b->{c,a2}, roots [a].
  // proves: CLAIM(MC2)
  table(treeBase, [
    { name: "a self-loop c->c closes at c's own child", ops: [{ op: "replace", path: "/data/nodes/2/children", value: ["c"] }], expected: [{ code: "TREE_CYCLE", pointer: "/data/nodes/2/children/0" }] },
    { name: "a 2-cycle b->c->b closes at c's child", ops: [{ op: "replace", path: "/data/nodes/2/children", value: ["b"] }], expected: [{ code: "TREE_CYCLE", pointer: "/data/nodes/2/children/0" }] },
    { name: "a 3-cycle a->b->c->a closes at c's child", ops: [{ op: "replace", path: "/data/nodes/2/children", value: ["a"] }], expected: [{ code: "TREE_CYCLE", pointer: "/data/nodes/2/children/0" }] },
  ]);

  // why: repeated ENTITY occurrences are legal: the base has two nodes (a, a2) for the same entity
  //      code/module:mcp, and graphs may contain cycles (design 2.2 and 2.3). Both are accepted.
  // proves: CLAIM(MC2)
  it("[MC2] positive control: two tree nodes for one entity are accepted", () => {
    const doc = treeBase();
    expect(doc.data.nodes[0].entity).toEqual(doc.data.nodes[3].entity);
    expectAccepted(check(doc), "envelope");
  });
  it("[MC2] positive control: a 3-cycle in a graph is accepted", () => {
    const doc = graphBase();
    expect(doc.data.edges.map((e: any) => [e.from, e.to])).toEqual([["a", "b"], ["b", "c"], ["c", "a"]]);
    expectAccepted(check(doc), "envelope");
  });
  it("[MC2] positive control: a graph self-loop and parallel edges are accepted", () => {
    const doc = patch(
      graphBase(),
      { op: "add", path: "/data/edges/-", value: item("e4", { from: "a", to: "a", relation: "retries" }) },
      { op: "add", path: "/data/edges/-", value: item("e5", { from: "a", to: "b", relation: "also" }) },
    );
    expectAccepted(check(doc), "envelope");
  });
});

describe("[MC2] bundle alias (forward) cycles", () => {
  // why: forwarding aliases reject cycles (design 3); ALIAS_CYCLE sits on /definitions/N/forward of EVERY
  //      definition whose forward chain returns to itself (order independent), never on a tail leading in.
  // proves: CLAIM(MC2)
  const bundle = () => allBundle();
  const fwd = (index: number, target: string): PatchOp => ({ op: "add", path: `/definitions/${index}/forward`, value: { entityId: "watch", viewDefinitionId: target } });

  it("[MC2] a definition forwarding to itself is one ALIAS_CYCLE", () => {
    expectRejected(check(patch(bundle(), fwd(0, "def-modules"))), [{ code: "ALIAS_CYCLE", pointer: "/definitions/0/forward" }], "bundle");
  });
  it("[MC2] a 2-cycle def-modules <-> def-layout reports both members", () => {
    expectRejected(
      check(patch(bundle(), fwd(0, "def-layout"), fwd(1, "def-modules"))),
      [{ code: "ALIAS_CYCLE", pointer: "/definitions/0/forward" }, { code: "ALIAS_CYCLE", pointer: "/definitions/1/forward" }],
      "bundle",
    );
  });
  it("[MC2] a tail leading into a cycle reports the cycle members only", () => {
    // def-modules(0) -> def-layout(1) -> def-delivery(2) -> def-layout(1): members 1 and 2; 0 only leads in.
    expectRejected(
      check(patch(bundle(), fwd(0, "def-layout"), fwd(1, "def-delivery"), fwd(2, "def-layout"))),
      [{ code: "ALIAS_CYCLE", pointer: "/definitions/1/forward" }, { code: "ALIAS_CYCLE", pointer: "/definitions/2/forward" }],
      "bundle",
    );
  });
  it("[MC2] positive control: an acyclic chain, forward and backward in definition order, is accepted", () => {
    // 0 -> 3 (later) and 3 -> 1 (earlier) and 1 -> 2: a chain 0,3,1,2 without a repeat.
    expectAccepted(check(patch(bundle(), fwd(0, "def-source"), fwd(3, "def-layout"), fwd(1, "def-delivery"))), "bundle");
  });
});

describe("[S8] every source anchor carries a recorded content hash", () => {
  // why: S8 / design 4: "Source anchors must resolve to a recorded file hash". An anchor (an item's, or a source excerpt's)
  //   names (repository, path); freshness.repositories[repository].files must hold that path, or nothing could ever tell
  //   whether the quoted bytes changed. The issue is DANGLING_REFERENCE at the anchor's `path` (docs/contract-additions/round2.md).
  //   The control uses the recorded path; the twins change only the path, the repository, or remove the record.
  // proves: CLAIM(S8-anchor-hash) CLAIM(MC6) CLAIM(MC2)
  const anchored = (path: string, repository = "r") =>
    patch(listBase(), { op: "add", path: "/data/rows/0/anchor", value: { repository, path, lines: [1, 3] } });
  it("[S8] a row anchor on a path with a recorded hash is accepted", () => {
    expectAccepted(check(anchored("src/mcp.rs")), "envelope");
  });
  it("[S8] a row anchor on an unrecorded path is DANGLING_REFERENCE at the anchor's path", () => {
    expectRejected(check(anchored("src/other.rs")), [{ code: "DANGLING_REFERENCE", pointer: "/data/rows/0/anchor/path" }], "envelope");
  });
  it("[S8] the same path under a repository that recorded nothing is DANGLING_REFERENCE (hashes are per repository)", () => {
    expectRejected(check(anchored("src/mcp.rs", "other-repo")), [{ code: "DANGLING_REFERENCE", pointer: "/data/rows/0/anchor/path" }]);
  });
  it("[S8] a source excerpt anchor on an unrecorded path is DANGLING_REFERENCE at /data/excerpt/anchor/path", () => {
    expectAccepted(check(sourceBase()), "envelope");
    expectRejected(check(patch(sourceBase(), { op: "replace", path: "/data/excerpt/anchor/path", value: "src/unrecorded.ts" })), [{ code: "DANGLING_REFERENCE", pointer: "/data/excerpt/anchor/path" }]);
  });
  it("[S8] removing the recorded hash from freshness rejects the anchor that relied on it", () => {
    const doc = patch(sourceBase(), { op: "replace", path: "/freshness/repositories/0/files", value: {} });
    expectRejected(check(doc), [{ code: "DANGLING_REFERENCE", pointer: "/data/excerpt/anchor/path" }]);
  });
});
