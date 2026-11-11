// MC1: component-specific schema negatives for all seven v0 components (design section 2 type
// definitions; src/schemas/components/*.json state the same rules). Each case differs from a valid
// base by exactly one fault and asserts the exact issue list [{code,pointer}].
// The bases are the committed fixtures plus added items (test/helpers/val-fixtures.ts); a positive
// control proves each base valid, so a rejection can only come from the one patched fault.
import { describe, expect, it } from "vitest";
import { validateSubmission } from "./validate.ts";
import { patch, type PatchOp } from "../../test/helpers/patch.ts";
import { calm, expectAccepted, expectRejected, expectTokens, type Expected } from "../../test/helpers/val-check.ts";
import { exampleBase, graphBase, listBase, notebookBase, shapeBase, sourceBase, treeBase } from "../../test/helpers/val-fixtures.ts";

const check = (doc: unknown) => calm(() => validateSubmission(doc), "validateSubmission");

interface Case {
  name: string;
  ops: PatchOp[];
  expected: Expected[];
  hint?: string[];
  constraint?: string[];
}
function table(claim: string, base: () => Record<string, any>, cases: Case[]) {
  it.each(cases)(`[MC1] ${claim}: $name`, ({ ops, expected, hint, constraint }) => {
    const report = check(patch(base(), ...ops));
    expectRejected(report, expected, "envelope");
    if (hint || constraint) expectTokens(report, { hint, constraint });
  });
}

describe("[MC1] the component bases are valid (controls for every negative below)", () => {
  // why: if a base were invalid, every negative derived from it would pass for the wrong reason.
  // proves: CLAIM(MC1)
  it.each([
    ["list", listBase],
    ["tree", treeBase],
    ["graph", graphBase],
    ["source", sourceBase],
    ["shape", shapeBase],
    ["notebook", notebookBase],
    ["example", exampleBase],
  ] as const)("[MC1] the %s base is accepted", (_name, base) => {
    expectAccepted(check(base()), "envelope");
  });
});

describe("[MC1] list", () => {
  // why: list = columns + rows(cells) + order (design 2.1): every required member and enum is checked.
  // proves: CLAIM(MC1)
  table("list", listBase, [
    { name: "no columns is SIZE (at least one column; use one for a plain list)", ops: [{ op: "replace", path: "/data/columns", value: [] }], expected: [{ code: "SIZE", pointer: "/data/columns" }] },
    { name: "column format 'date' is ENUM", ops: [{ op: "replace", path: "/data/columns/0/format", value: "date" }], expected: [{ code: "ENUM", pointer: "/data/columns/0/format" }], hint: ["text", "number", "boolean"] },
    { name: "column without title is REQUIRED", ops: [{ op: "remove", path: "/data/columns/0/title" }], expected: [{ code: "REQUIRED", pointer: "/data/columns/0/title" }] },
    { name: "order.direction 'up' is ENUM naming asc and desc", ops: [{ op: "replace", path: "/data/order/direction", value: "up" }], expected: [{ code: "ENUM", pointer: "/data/order/direction" }], hint: ["asc", "desc"] },
    { name: "missing order is REQUIRED", ops: [{ op: "remove", path: "/data/order" }], expected: [{ code: "REQUIRED", pointer: "/data/order" }] },
    { name: "an object cell value is TYPE (cells are scalars)", ops: [{ op: "replace", path: "/data/rows/0/cells/name", value: { nested: true } }], expected: [{ code: "TYPE", pointer: "/data/rows/0/cells/name" }] },
    { name: "a row without cells is REQUIRED", ops: [{ op: "remove", path: "/data/rows/1/cells" }], expected: [{ code: "REQUIRED", pointer: "/data/rows/1/cells" }] },
    { name: "an empty group label is SIZE", ops: [{ op: "add", path: "/data/rows/0/group", value: "" }], expected: [{ code: "SIZE", pointer: "/data/rows/0/group" }] },
    { name: "an unknown data key is UNKNOWN_PROPERTY", ops: [{ op: "add", path: "/data/footer", value: "x" }], expected: [{ code: "UNKNOWN_PROPERTY", pointer: "/data/footer" }] },
    { name: "rows as an object is TYPE", ops: [{ op: "replace", path: "/data/rows", value: {} }], expected: [{ code: "TYPE", pointer: "/data/rows" }] },
  ]);

  // why: list cells are Scalars; null, boolean and number are legal values (unknown stays null, not "").
  // proves: CLAIM(MC1)
  it.each([null, true, 0, 3.5, ""])("[MC1] list: cell value %j is accepted", (value) => {
    expectAccepted(check(patch(listBase(), { op: "replace", path: "/data/rows/0/cells/name", value })), "envelope");
  });
});

describe("[MC1] tree", () => {
  // why: tree = columns + roots + nodes(children, childrenState) (design 2.2); not_loaded is a state, never a leaf.
  // proves: CLAIM(MC1)
  table("tree", treeBase, [
    { name: "childrenState 'lazy' is ENUM naming complete and not_loaded", ops: [{ op: "replace", path: "/data/nodes/0/childrenState", value: "lazy" }], expected: [{ code: "ENUM", pointer: "/data/nodes/0/childrenState" }], hint: ["complete", "not_loaded"] },
    { name: "a node without children is REQUIRED", ops: [{ op: "remove", path: "/data/nodes/1/children" }], expected: [{ code: "REQUIRED", pointer: "/data/nodes/1/children" }] },
    { name: "a node without childrenState is REQUIRED", ops: [{ op: "remove", path: "/data/nodes/2/childrenState" }], expected: [{ code: "REQUIRED", pointer: "/data/nodes/2/childrenState" }] },
    { name: "roots as a string is TYPE", ops: [{ op: "replace", path: "/data/roots", value: "a" }], expected: [{ code: "TYPE", pointer: "/data/roots" }] },
    { name: "missing roots is REQUIRED", ops: [{ op: "remove", path: "/data/roots" }], expected: [{ code: "REQUIRED", pointer: "/data/roots" }] },
    { name: "a numeric child id is TYPE", ops: [{ op: "replace", path: "/data/nodes/0/children", value: [5] }], expected: [{ code: "TYPE", pointer: "/data/nodes/0/children/0" }] },
    { name: "missing columns is REQUIRED", ops: [{ op: "remove", path: "/data/columns" }], expected: [{ code: "REQUIRED", pointer: "/data/columns" }] },
  ]);

  // why: not_loaded is legal and means "unexpanded, evidence needed" (design 2.2); control for the ENUM negative.
  // proves: CLAIM(MC1)
  it("[MC1] tree: childrenState not_loaded is accepted", () => {
    expectAccepted(check(patch(treeBase(), { op: "replace", path: "/data/nodes/2/childrenState", value: "not_loaded" })), "envelope");
  });
});

describe("[MC1] graph", () => {
  // why: graph = nodes + edges(from,to,relation) + layout (+ focus, paths) (design 2.3).
  // proves: CLAIM(MC1)
  table("graph", graphBase, [
    { name: "layout 'force' is ENUM naming layered and grid (v0 has no force layout)", ops: [{ op: "replace", path: "/data/layout", value: "force" }], expected: [{ code: "ENUM", pointer: "/data/layout" }], hint: ["layered", "grid"] },
    { name: "missing layout is REQUIRED", ops: [{ op: "remove", path: "/data/layout" }], expected: [{ code: "REQUIRED", pointer: "/data/layout" }] },
    { name: "focus depth '2' (string) is TYPE integer", ops: [{ op: "replace", path: "/data/focus/depth", value: "2" }], expected: [{ code: "TYPE", pointer: "/data/focus/depth" }], constraint: ["integer"] },
    { name: "focus depth 1.5 is TYPE integer", ops: [{ op: "replace", path: "/data/focus/depth", value: 1.5 }], expected: [{ code: "TYPE", pointer: "/data/focus/depth" }], constraint: ["integer"] },
    { name: "focus depth -1 is OUT_OF_RANGE", ops: [{ op: "replace", path: "/data/focus/depth", value: -1 }], expected: [{ code: "OUT_OF_RANGE", pointer: "/data/focus/depth" }] },
    { name: "focus depth 65 is OUT_OF_RANGE (max 64)", ops: [{ op: "replace", path: "/data/focus/depth", value: 65 }], expected: [{ code: "OUT_OF_RANGE", pointer: "/data/focus/depth" }] },
    { name: "focus direction 'sideways' is ENUM naming in, out and both", ops: [{ op: "replace", path: "/data/focus/direction", value: "sideways" }], expected: [{ code: "ENUM", pointer: "/data/focus/direction" }], hint: ["in", "out", "both"] },
    { name: "focus without depth is REQUIRED at /data/focus/depth", ops: [{ op: "remove", path: "/data/focus/depth" }], expected: [{ code: "REQUIRED", pointer: "/data/focus/depth" }] },
    { name: "an edge without relation is REQUIRED", ops: [{ op: "remove", path: "/data/edges/0/relation" }], expected: [{ code: "REQUIRED", pointer: "/data/edges/0/relation" }] },
    { name: "an edge without from is REQUIRED", ops: [{ op: "remove", path: "/data/edges/1/from" }], expected: [{ code: "REQUIRED", pointer: "/data/edges/1/from" }] },
    { name: "a path with no edges is SIZE", ops: [{ op: "replace", path: "/data/paths/0/edgeIds", value: [] }], expected: [{ code: "SIZE", pointer: "/data/paths/0/edgeIds" }] },
    { name: "a path without id is REQUIRED", ops: [{ op: "remove", path: "/data/paths/0/id" }], expected: [{ code: "REQUIRED", pointer: "/data/paths/0/id" }] },
    { name: "an unknown node key is UNKNOWN_PROPERTY", ops: [{ op: "add", path: "/data/nodes/0/colour", value: "red" }], expected: [{ code: "UNKNOWN_PROPERTY", pointer: "/data/nodes/0/colour" }] },
    { name: "an unknown edge key is UNKNOWN_PROPERTY", ops: [{ op: "add", path: "/data/edges/0/weight", value: 3 }], expected: [{ code: "UNKNOWN_PROPERTY", pointer: "/data/edges/0/weight" }] },
    { name: "an empty node group is SIZE", ops: [{ op: "add", path: "/data/nodes/0/group", value: "" }], expected: [{ code: "SIZE", pointer: "/data/nodes/0/group" }] },
  ]);

  // why: depth bounds 0 and 64 are inclusive (schema minimum 0, maximum 64); controls for the OUT_OF_RANGE pair.
  // proves: CLAIM(MC1)
  it.each([0, 64])("[MC1] graph: focus depth %i is accepted", (depth) => {
    expectAccepted(check(patch(graphBase(), { op: "replace", path: "/data/focus/depth", value: depth })), "envelope");
  });
});

describe("[MC1] source", () => {
  // why: source = excerpt(anchor, language, text) + annotations(lines, message, claimIds) (design 2.4).
  // proves: CLAIM(MC1)
  table("source", sourceBase, [
    { name: "annotation line 'b' is TYPE at the element", ops: [{ op: "replace", path: "/data/annotations/0/lines", value: [4, "b"] }], expected: [{ code: "TYPE", pointer: "/data/annotations/0/lines/1" }] },
    { name: "annotation line 0 is OUT_OF_RANGE", ops: [{ op: "replace", path: "/data/annotations/0/lines", value: [0, 4] }], expected: [{ code: "OUT_OF_RANGE", pointer: "/data/annotations/0/lines/0" }] },
    { name: "annotation lines with one element is SIZE", ops: [{ op: "replace", path: "/data/annotations/0/lines", value: [4] }], expected: [{ code: "SIZE", pointer: "/data/annotations/0/lines" }] },
    { name: "annotation lines as a number is TYPE", ops: [{ op: "replace", path: "/data/annotations/0/lines", value: 4 }], expected: [{ code: "TYPE", pointer: "/data/annotations/0/lines" }] },
    { name: "an excerpt without language is REQUIRED", ops: [{ op: "remove", path: "/data/excerpt/language" }], expected: [{ code: "REQUIRED", pointer: "/data/excerpt/language" }] },
    { name: "an excerpt without anchor is REQUIRED", ops: [{ op: "remove", path: "/data/excerpt/anchor" }], expected: [{ code: "REQUIRED", pointer: "/data/excerpt/anchor" }] },
    { name: "an excerpt without text is REQUIRED", ops: [{ op: "remove", path: "/data/excerpt/text" }], expected: [{ code: "REQUIRED", pointer: "/data/excerpt/text" }] },
    { name: "excerpt text as a number is TYPE", ops: [{ op: "replace", path: "/data/excerpt/text", value: 5 }], expected: [{ code: "TYPE", pointer: "/data/excerpt/text" }] },
    { name: "a fractional excerpt anchor line is TYPE", ops: [{ op: "replace", path: "/data/excerpt/anchor/lines", value: [4.5, 6] }], expected: [{ code: "TYPE", pointer: "/data/excerpt/anchor/lines/0" }] },
    { name: "an annotation without message is REQUIRED", ops: [{ op: "remove", path: "/data/annotations/0/message" }], expected: [{ code: "REQUIRED", pointer: "/data/annotations/0/message" }] },
    { name: "claimIds as a string is TYPE", ops: [{ op: "replace", path: "/data/annotations/0/claimIds", value: "C1" }], expected: [{ code: "TYPE", pointer: "/data/annotations/0/claimIds" }] },
    { name: "a numeric claim id is TYPE", ops: [{ op: "replace", path: "/data/annotations/0/claimIds", value: [5] }], expected: [{ code: "TYPE", pointer: "/data/annotations/0/claimIds/0" }] },
    { name: "missing annotations is REQUIRED", ops: [{ op: "remove", path: "/data/annotations" }], expected: [{ code: "REQUIRED", pointer: "/data/annotations" }] },
    { name: "an empty language is SIZE", ops: [{ op: "replace", path: "/data/excerpt/language", value: "" }], expected: [{ code: "SIZE", pointer: "/data/excerpt/language" }] },
  ]);
});

describe("[MC1] shape", () => {
  // why: shape = basis + root + fields(path,type,presence,children[,ref,example]) (design 2.5); redaction is
  //      a source note, never a string example pretending to be a value.
  // proves: CLAIM(MC1)
  table("shape", shapeBase, [
    { name: "basis 'guessed' is ENUM naming declared and observed", ops: [{ op: "replace", path: "/data/basis", value: "guessed" }], expected: [{ code: "ENUM", pointer: "/data/basis" }], hint: ["declared", "observed"] },
    { name: "presence 'maybe' is ENUM naming required, optional, unknown", ops: [{ op: "replace", path: "/data/fields/0/presence", value: "maybe" }], expected: [{ code: "ENUM", pointer: "/data/fields/0/presence" }], hint: ["required", "optional", "unknown"] },
    { name: "a field without children is REQUIRED", ops: [{ op: "remove", path: "/data/fields/0/children" }], expected: [{ code: "REQUIRED", pointer: "/data/fields/0/children" }] },
    { name: "a field without path is REQUIRED", ops: [{ op: "remove", path: "/data/fields/1/path" }], expected: [{ code: "REQUIRED", pointer: "/data/fields/1/path" }] },
    { name: "a field without presence is REQUIRED", ops: [{ op: "remove", path: "/data/fields/1/presence" }], expected: [{ code: "REQUIRED", pointer: "/data/fields/1/presence" }] },
    { name: "an object example is TYPE (examples are scalars)", ops: [{ op: "replace", path: "/data/fields/1/example", value: { a: 1 } }], expected: [{ code: "TYPE", pointer: "/data/fields/1/example" }] },
    { name: "missing root is REQUIRED", ops: [{ op: "remove", path: "/data/root" }], expected: [{ code: "REQUIRED", pointer: "/data/root" }] },
    { name: "an empty type is SIZE", ops: [{ op: "replace", path: "/data/fields/0/type", value: "" }], expected: [{ code: "SIZE", pointer: "/data/fields/0/type" }] },
    { name: "a numeric ref is TYPE", ops: [{ op: "replace", path: "/data/fields/1/ref", value: 5 }], expected: [{ code: "TYPE", pointer: "/data/fields/1/ref" }] },
  ]);

  // why: example may be null, false, 0 or "" (a real observed value) - 'missing, null, redacted are distinct'.
  // proves: CLAIM(MC1)
  it.each([null, false, 0, ""])("[MC1] shape: example %j is accepted", (value) => {
    expectAccepted(check(patch(shapeBase(), { op: "replace", path: "/data/fields/1/example", value })), "envelope");
  });
});

describe("[MC1] notebook", () => {
  // why: notebook blocks are a tagged union on `kind` (design 2.6): each kind requires its members and
  //      FORBIDS the other kinds' members (FORBIDDEN_PROPERTY), so a prose block cannot carry a claim status.
  // proves: CLAIM(MC1)
  table("notebook", notebookBase, [
    { name: "block kind 'table' is ENUM naming the four kinds", ops: [{ op: "replace", path: "/data/blocks/0/kind", value: "table" }], expected: [{ code: "ENUM", pointer: "/data/blocks/0/kind" }], hint: ["prose", "claim", "view", "example"] },
    { name: "a prose block without markdown is REQUIRED", ops: [{ op: "remove", path: "/data/blocks/0/markdown" }], expected: [{ code: "REQUIRED", pointer: "/data/blocks/0/markdown" }] },
    { name: "a prose block with a statement is FORBIDDEN_PROPERTY", ops: [{ op: "add", path: "/data/blocks/0/statement", value: "x" }], expected: [{ code: "FORBIDDEN_PROPERTY", pointer: "/data/blocks/0/statement" }] },
    { name: "a view block with a statement is FORBIDDEN_PROPERTY", ops: [{ op: "add", path: "/data/blocks/1/statement", value: "x" }], expected: [{ code: "FORBIDDEN_PROPERTY", pointer: "/data/blocks/1/statement" }] },
    { name: "a view block without viewId is REQUIRED", ops: [{ op: "remove", path: "/data/blocks/1/viewId" }], expected: [{ code: "REQUIRED", pointer: "/data/blocks/1/viewId" }] },
    { name: "a view block with markdown is FORBIDDEN_PROPERTY", ops: [{ op: "add", path: "/data/blocks/1/markdown", value: "x" }], expected: [{ code: "FORBIDDEN_PROPERTY", pointer: "/data/blocks/1/markdown" }] },
    { name: "a claim without status is REQUIRED", ops: [{ op: "remove", path: "/data/blocks/2/status" }], expected: [{ code: "REQUIRED", pointer: "/data/blocks/2/status" }] },
    { name: "claim status 'maybe' is ENUM naming supported, disputed, open", ops: [{ op: "replace", path: "/data/blocks/2/status", value: "maybe" }], expected: [{ code: "ENUM", pointer: "/data/blocks/2/status" }], hint: ["supported", "disputed", "open"] },
    { name: "a claim without supports is REQUIRED", ops: [{ op: "remove", path: "/data/blocks/2/supports" }], expected: [{ code: "REQUIRED", pointer: "/data/blocks/2/supports" }] },
    { name: "a claim without contradicts is REQUIRED", ops: [{ op: "remove", path: "/data/blocks/2/contradicts" }], expected: [{ code: "REQUIRED", pointer: "/data/blocks/2/contradicts" }] },
    { name: "a claim without statement is REQUIRED", ops: [{ op: "remove", path: "/data/blocks/2/statement" }], expected: [{ code: "REQUIRED", pointer: "/data/blocks/2/statement" }] },
    { name: "a claim with a viewId is FORBIDDEN_PROPERTY", ops: [{ op: "add", path: "/data/blocks/2/viewId", value: "delivery-path" }], expected: [{ code: "FORBIDDEN_PROPERTY", pointer: "/data/blocks/2/viewId" }] },
    { name: "an example block without exampleId is REQUIRED", ops: [{ op: "remove", path: "/data/blocks/3/exampleId" }], expected: [{ code: "REQUIRED", pointer: "/data/blocks/3/exampleId" }] },
    { name: "an example block with markdown is FORBIDDEN_PROPERTY", ops: [{ op: "add", path: "/data/blocks/3/markdown", value: "x" }], expected: [{ code: "FORBIDDEN_PROPERTY", pointer: "/data/blocks/3/markdown" }] },
    { name: "a {viewId} support without itemId is REQUIRED", ops: [{ op: "replace", path: "/data/blocks/2/supports", value: [{ viewId: "delivery-path" }] }], expected: [{ code: "REQUIRED", pointer: "/data/blocks/2/supports/0/itemId" }] },
    { name: "a numeric support target is TYPE", ops: [{ op: "replace", path: "/data/blocks/2/supports", value: [5] }], expected: [{ code: "TYPE", pointer: "/data/blocks/2/supports/0" }] },
    { name: "a support target object with an extra key is UNKNOWN_PROPERTY", ops: [{ op: "replace", path: "/data/blocks/2/supports", value: [{ viewId: "v", itemId: "i", extra: 1 }] }], expected: [{ code: "UNKNOWN_PROPERTY", pointer: "/data/blocks/2/supports/0/extra" }] },
    { name: "an empty-string contradicts target is SIZE", ops: [{ op: "replace", path: "/data/blocks/2/contradicts", value: [""] }], expected: [{ code: "SIZE", pointer: "/data/blocks/2/contradicts/0" }] },
  ]);

  // why: evidence targets are source ids or {viewId,itemId} (design 4); both forms are legal in one list.
  // proves: CLAIM(MC1)
  it("[MC1] notebook: supports may mix a source id and a {viewId,itemId} target", () => {
    const doc = patch(notebookBase(), { op: "replace", path: "/data/blocks/2/supports", value: ["s1", { viewId: "delivery-path", itemId: "a" }] });
    expectAccepted(check(doc), "envelope");
  });
});

describe("[MC1] example", () => {
  // why: example = scenario(runnerId, parameters) + runs(runId,status,assertions) (design 2.7).
  // proves: CLAIM(MC1)
  table("example", exampleBase, [
    { name: "run status 'running' is ENUM naming passed, failed, error", ops: [{ op: "replace", path: "/data/runs/0/status", value: "running" }], expected: [{ code: "ENUM", pointer: "/data/runs/0/status" }], hint: ["passed", "failed", "error"] },
    { name: "a scenario without runnerId is REQUIRED", ops: [{ op: "remove", path: "/data/scenario/runnerId" }], expected: [{ code: "REQUIRED", pointer: "/data/scenario/runnerId" }] },
    { name: "a scenario without parameters is REQUIRED", ops: [{ op: "remove", path: "/data/scenario/parameters" }], expected: [{ code: "REQUIRED", pointer: "/data/scenario/parameters" }] },
    { name: "an assertion without passed is REQUIRED", ops: [{ op: "remove", path: "/data/runs/0/assertions/0/passed" }], expected: [{ code: "REQUIRED", pointer: "/data/runs/0/assertions/0/passed" }] },
    { name: "assertion passed 'yes' is TYPE", ops: [{ op: "replace", path: "/data/runs/0/assertions/0/passed", value: "yes" }], expected: [{ code: "TYPE", pointer: "/data/runs/0/assertions/0/passed" }] },
    { name: "an assertion without statement is REQUIRED", ops: [{ op: "remove", path: "/data/runs/0/assertions/0/statement" }], expected: [{ code: "REQUIRED", pointer: "/data/runs/0/assertions/0/statement" }] },
    { name: "a run without runId is REQUIRED", ops: [{ op: "remove", path: "/data/runs/0/runId" }], expected: [{ code: "REQUIRED", pointer: "/data/runs/0/runId" }] },
    { name: "a run without assertions is REQUIRED", ops: [{ op: "remove", path: "/data/runs/0/assertions" }], expected: [{ code: "REQUIRED", pointer: "/data/runs/0/assertions" }] },
    { name: "runs as an object is TYPE", ops: [{ op: "replace", path: "/data/runs", value: {} }], expected: [{ code: "TYPE", pointer: "/data/runs" }] },
    { name: "an unknown run key is UNKNOWN_PROPERTY", ops: [{ op: "add", path: "/data/runs/0/exitCode", value: 0 }], expected: [{ code: "UNKNOWN_PROPERTY", pointer: "/data/runs/0/exitCode" }] },
    { name: "a result entity with a bad kind is PATTERN", ops: [{ op: "replace", path: "/data/runs/0/result/kind", value: "Json/Value" }], expected: [{ code: "PATTERN", pointer: "/data/runs/0/result/kind" }] },
    { name: "a scenario cell that is an array is TYPE", ops: [{ op: "add", path: "/data/scenario/parameters/depth", value: [1] }], expected: [{ code: "TYPE", pointer: "/data/scenario/parameters/depth" }] },
  ]);

  // why: an empty runs array means "not run" and is valid (design 2.7); the shipped fixture is that case.
  // proves: CLAIM(MC1)
  it("[MC1] example: an empty runs array is accepted", () => {
    expectAccepted(check(patch(exampleBase(), { op: "replace", path: "/data/runs", value: [] })), "envelope");
  });
});
