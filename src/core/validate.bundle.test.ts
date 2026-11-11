// MC20 / MC12 (bundle validation): a bundle is checked as a unit before anything is registered
// (design section 4: "Bundle import registers entities, definitions, and views together after checking
// all references"; section 7 MC20: "Fail a bundle containing one invalid member"). This suite pins the
// validation half: member issues carry the bundle pointer prefix, every member fault is reported, and
// cross-member references resolve against the bundle plus ReferenceContext (red-contract section 2).
// Bundle layout (fixtures/components/all.bundle.json): views 0 modules(list), 1 layout(tree), 2 delivery-path(graph),
// 3 check-source, 4 watch-shape, 5 cancellation-notebook (entity notes), 6 vigil-one-write; entities 0 watch,
// 1 mcp, 2 notes; definitions 0 def-modules, 1 def-layout, 2 def-delivery, 3 def-source, 4 def-shape,
// 5 def-example, 6 def-story.
import { describe, expect, it } from "vitest";
import { validateSubmission, type ReferenceContext } from "./validate.ts";
import { allBundle, clone } from "../../test/helpers/fixtures.ts";
import { patch, type PatchOp } from "../../test/helpers/patch.ts";
import { calm, expectAccepted, expectRejected } from "../../test/helpers/val-check.ts";
import { item } from "../../test/helpers/val-fixtures.ts";

const check = (doc: unknown, context?: ReferenceContext) => calm(() => validateSubmission(doc, context), "validateSubmission");
const dangling = (pointer: string) => ({ code: "DANGLING_REFERENCE", pointer });
const NOTES = { repository: "r", id: "notes", kind: "notes/page", snapshotId: "snap-1" };

describe("[MC20] member issues carry the bundle pointer prefix", () => {
  // why: an agent repairs a bundle by pointer; a member's issue must be addressed from the bundle root, not
  //      from the member (red-contract section 2; brief example /views/N/data/edges/0/to).
  //      The positive control is the untouched bundle.
  // proves: CLAIM(MC20)
  it("[MC20] positive control: the fixture bundle is accepted", () => {
    expectAccepted(check(allBundle()), "bundle");
  });
  it("[MC20] a dangling edge endpoint in view 2 is addressed /views/2/data/edges/0/to", () => {
    expectRejected(check(patch(allBundle(), { op: "replace", path: "/views/2/data/edges/0/to", value: "ghost" })), [dangling("/views/2/data/edges/0/to")], "bundle");
  });
  it("[MC20] a shape fault in view 0 (unknown row key) is addressed /views/0/data/rows/0/colour", () => {
    expectRejected(check(patch(allBundle(), { op: "add", path: "/views/0/data/rows/0/colour", value: "red" })), [{ code: "UNKNOWN_PROPERTY", pointer: "/views/0/data/rows/0/colour" }], "bundle");
  });
  it("[MC20] a duplicate row id inside view 0 is addressed /views/0/data/rows/1/id", () => {
    const doc = patch(allBundle(), { op: "add", path: "/views/0/data/rows/-", value: item("mcp", { cells: { name: "dup" } }) });
    expectRejected(check(doc), [{ code: "DUPLICATE_ID", pointer: "/views/0/data/rows/1/id" }]);
  });
  it("[MC20] a dangling evidence id in view 5 is addressed /views/5/data/blocks/0/evidence/0", () => {
    expectRejected(check(patch(allBundle(), { op: "replace", path: "/views/5/data/blocks/0/evidence", value: ["nope"] })), [dangling("/views/5/data/blocks/0/evidence/0")]);
  });

  // why: ids are unique per view, NOT per bundle: two views of the same shape legitimately reuse row ids
  //      (the fixture's own list rows repeat across padded copies); a bundle-wide id check would reject them.
  // proves: CLAIM(MC20)
  it("[MC20] two views may reuse the same item ids", () => {
    const doc = allBundle();
    const copy = clone(doc.views[0]);
    copy.id = "modules-copy";
    doc.views.push(copy);
    expect(copy.data.rows[0].id).toBe(doc.views[0].data.rows[0].id);
    expectAccepted(check(doc), "bundle");
  });

  // why: bundle members repeat the per-envelope SHAPE rules: a missing title or a bad enum is addressed
  //      from the root of the bundle.
  // proves: CLAIM(MC20), CLAIM(MC1)
  it("[MC20] shape faults in three different members are all reported, sorted by pointer", () => {
    const doc = patch(
      allBundle(),
      { op: "remove", path: "/views/1/title" },
      { op: "replace", path: "/views/3/data/annotations/0/provenance", value: "guess" },
      { op: "replace", path: "/views/6/completeness/status", value: "unknown" },
    );
    expectRejected(check(doc), [
      { code: "REQUIRED", pointer: "/views/1/title" },
      { code: "ENUM", pointer: "/views/3/data/annotations/0/provenance" },
      { code: "ENUM", pointer: "/views/6/completeness/status" },
    ], "bundle");
  });

  // why: one invalid member must not hide the others (repair in one round): four semantic faults across four
  //      members, all reported, in pointer order.
  // proves: CLAIM(MC20)
  it("[MC20] semantic faults in four different members are all reported", () => {
    const doc = patch(
      allBundle(),
      { op: "replace", path: "/views/0/data/rows/0/evidence", value: ["s9"] },
      { op: "replace", path: "/views/2/data/edges/0/to", value: "zz" },
      { op: "add", path: "/views/4/data/fields/0/children", value: ["zz"] },
      { op: "replace", path: "/views/1/data/roots", value: ["zz"] },
    );
    expectRejected(check(doc), [
      dangling("/views/0/data/rows/0/evidence/0"),
      dangling("/views/1/data/roots/0"),
      dangling("/views/2/data/edges/0/to"),
      dangling("/views/4/data/fields/0/children/0"),
    ], "bundle");
  });

  // why: the bundle's own top-level members are shaped too: entities/definitions are checked at their index.
  // proves: CLAIM(MC20), CLAIM(MC1)
  it.each([
    ["entities as an object", [{ op: "replace", path: "/entities", value: {} }], [{ code: "TYPE", pointer: "/entities" }]],
    ["an entity without snapshotId", [{ op: "remove", path: "/entities/1/snapshotId" }], [{ code: "REQUIRED", pointer: "/entities/1/snapshotId" }]],
    ["a definition without dataRole", [{ op: "remove", path: "/definitions/2/dataRole" }], [{ code: "REQUIRED", pointer: "/definitions/2/dataRole" }]],
    ["an entity relation target with a bad kind", [{ op: "replace", path: "/entities/0/relations/0/target/kind", value: "Code" }], [{ code: "PATTERN", pointer: "/entities/0/relations/0/target/kind" }]],
    ["a missing views array", [{ op: "remove", path: "/views" }], [{ code: "REQUIRED", pointer: "/views" }]],
  ] as Array<[string, PatchOp[], Array<{ code: string; pointer: string }>]>)("[MC20] %s", (_name, ops, expected) => {
    expectRejected(check(patch(allBundle(), ...ops)), expected, "bundle");
  });
});

describe("[MC12] view.entity must be registered by the bundle or known to the context", () => {
  // why: a view whose entity is neither in the bundle nor already registered would be unreachable by
  //      navigation; the reference is checked against bundle + ReferenceContext (red-contract section 2).
  //      Entity identity is repository + id + kind within a snapshot (design 4).
  // proves: CLAIM(MC20), CLAIM(MC12)
  const withoutNotes = () => patch(allBundle(), { op: "remove", path: "/entities/2" });

  it("[MC20] a view naming an entity absent from bundle and context is DANGLING at /views/5/entity", () => {
    expectRejected(check(withoutNotes()), [dangling("/views/5/entity")], "bundle");
  });
  it("[MC20] the same bundle is accepted when the context already holds that entity", () => {
    expectAccepted(check(withoutNotes(), { entities: [NOTES] }), "bundle");
  });
  it("[MC20] a context entity from ANOTHER snapshot does not satisfy the reference", () => {
    expectRejected(check(withoutNotes(), { entities: [{ ...NOTES, snapshotId: "snap-0" }] }), [dangling("/views/5/entity")]);
  });
  it("[MC20] a context entity with a different id does not satisfy the reference", () => {
    expectRejected(check(withoutNotes(), { entities: [{ ...NOTES, id: "other" }] }), [dangling("/views/5/entity")]);
  });
});

describe("[MC12] view.viewDefinitionId must be registered by the bundle or known to the context", () => {
  // why: a view must be openable through a definition (design 3: an instance is validated against a
  //      definition); an unknown definition is DANGLING on /views/N/viewDefinitionId.
  // proves: CLAIM(MC20), CLAIM(MC12)
  const ghost = () => patch(allBundle(), { op: "replace", path: "/views/0/viewDefinitionId", value: "def-ghost" });
  it("[MC12] an unknown viewDefinitionId is DANGLING at /views/0/viewDefinitionId", () => {
    expectRejected(check(ghost()), [dangling("/views/0/viewDefinitionId")], "bundle");
  });
  it("[MC12] the same id is accepted when the context lists that definition", () => {
    expectAccepted(check(ghost(), { definitionIds: ["def-ghost"] }), "bundle");
  });
  it("[MC12] removing a definition from the bundle dangles exactly the views that use it", () => {
    expectRejected(check(patch(allBundle(), { op: "remove", path: "/definitions/0" })), [dangling("/views/0/viewDefinitionId")]);
  });
  it("[MC12] a definition forwarding to an unknown definition is DANGLING at its forward.viewDefinitionId", () => {
    const doc = patch(allBundle(), { op: "add", path: "/definitions/0/forward", value: { entityId: "watch", viewDefinitionId: "def-ghost" } });
    expectRejected(check(doc), [dangling("/definitions/0/forward/viewDefinitionId")]);
  });
});

describe("[MC12] definitions use only the seven v0 components", () => {
  // why: deferred components (matrix, state, timeline, boundary, diff, heat) are not v0 (design 5/7): a
  //      definition naming one is UNKNOWN_COMPONENT at /definitions/N/component, as a view would be at /component.
  // proves: CLAIM(MC12), CLAIM(MC1)
  it.each(["matrix", "state", "timeline", "heat"])("[MC12] a definition with component '%s' is UNKNOWN_COMPONENT", (component) => {
    expectRejected(check(patch(allBundle(), { op: "replace", path: "/definitions/3/component", value: component })), [{ code: "UNKNOWN_COMPONENT", pointer: "/definitions/3/component" }], "bundle");
  });
  it("[MC12] a view with a deferred component is UNKNOWN_COMPONENT at /views/N/component", () => {
    expectRejected(check(patch(allBundle(), { op: "replace", path: "/views/0/component", value: "matrix" })), [{ code: "UNKNOWN_COMPONENT", pointer: "/views/0/component" }], "bundle");
  });
});

describe("[MC20] notebook references resolve against the bundle and the context", () => {
  // The fixture notebook is views[5]; its block 1 shows view `delivery-path` (views[2], items a, b, e).
  const noteOnly = () => {
    const bundle = allBundle();
    return {
      schemaVersion: "paneweft.bundle/1",
      entities: [bundle.entities[2]],
      definitions: [bundle.definitions[6]],
      views: [bundle.views[5]],
    };
  };
  const GRAPH_CONTEXT: ReferenceContext = { views: [{ id: "delivery-path", snapshotId: "snap-1", itemIds: ["a", "b", "e"] }] };
  const claim = (supports: unknown[], contradicts: unknown[] = []) =>
    item("c1", { kind: "claim", statement: "s", status: "supported", supports, contradicts });
  const withClaim = (supports: unknown[], contradicts: unknown[] = []) =>
    patch(allBundle(), { op: "add", path: "/views/5/data/blocks/-", value: claim(supports, contradicts) });

  // why: a `view` block must show a view that exists: in the same bundle, or already registered (context).
  //      Standing alone, the notebook's reference dangles; with the context entry it resolves.
  // proves: CLAIM(MC20), CLAIM(MC8)
  it("[MC20] a notebook view block naming a view absent from bundle and context is DANGLING", () => {
    expectRejected(check(patch(allBundle(), { op: "replace", path: "/views/5/data/blocks/1/viewId", value: "ghost" })), [dangling("/views/5/data/blocks/1/viewId")], "bundle");
  });
  it("[MC20] a notebook bundle without its target view is DANGLING without context", () => {
    expectRejected(check(noteOnly()), [dangling("/views/0/data/blocks/1/viewId")], "bundle");
  });
  it("[MC20] the same notebook bundle is accepted when the context holds the target view", () => {
    expectAccepted(check(noteOnly(), GRAPH_CONTEXT), "bundle");
  });
  it("[MC20] a context view with a different id does not satisfy the reference", () => {
    expectRejected(check(noteOnly(), { views: [{ id: "other-view", snapshotId: "snap-1", itemIds: [] }] }), [dangling("/views/0/data/blocks/1/viewId")]);
  });

  // why: claim supports/contradicts accept a source id or {viewId,itemId}; the item must exist in that view
  //      (bundle or context). Pointer: the target entry. Positive controls precede each negative family.
  // proves: CLAIM(MC20), CLAIM(MC8)
  it("[MC20] positive control: supports with a node, an edge and a source id are accepted", () => {
    expectAccepted(check(withClaim([{ viewId: "delivery-path", itemId: "a" }, { viewId: "delivery-path", itemId: "e" }, "s1"])), "bundle");
  });
  it("[MC20] a {viewId,itemId} support naming an unknown item is DANGLING at that entry", () => {
    expectRejected(check(withClaim([{ viewId: "delivery-path", itemId: "zz" }])), [dangling("/views/5/data/blocks/2/supports/0")]);
  });
  it("[MC20] a {viewId,itemId} support naming an unknown view is DANGLING at that entry", () => {
    expectRejected(check(withClaim([{ viewId: "ghost", itemId: "a" }])), [dangling("/views/5/data/blocks/2/supports/0")]);
  });
  it("[MC20] a contradicts entry is checked like a supports entry", () => {
    expectRejected(check(withClaim([], [{ viewId: "delivery-path", itemId: "zz" }])), [dangling("/views/5/data/blocks/2/contradicts/0")]);
  });
  it("[MC20] the second of two supports entries being bad is addressed by its index", () => {
    expectRejected(check(withClaim([{ viewId: "delivery-path", itemId: "a" }, { viewId: "delivery-path", itemId: "zz" }])), [dangling("/views/5/data/blocks/2/supports/1")]);
  });

  // why: items are checked in context views too: itemIds come from ReferenceContext.views.
  // proves: CLAIM(MC20), CLAIM(MC8)
  it("[MC20] a support naming an item listed by the context is accepted, an unlisted one is DANGLING", () => {
    const standalone = (itemId: string) => {
      const doc = noteOnly();
      (doc.views[0] as any).data.blocks.push(claim([{ viewId: "delivery-path", itemId }]));
      return doc;
    };
    expectAccepted(check(standalone("a"), GRAPH_CONTEXT), "bundle");
    expectRejected(check(standalone("zz"), GRAPH_CONTEXT), [dangling("/views/0/data/blocks/2/supports/0")]);
  });

  // why: "never ambiguous bare item ids across views" (design 4): a bare string in supports is a SOURCE id.
  //      A bare id that is a real item id of some view ("a" a graph node, "mcp" a list row) is still rejected.
  // proves: CLAIM(MC20), CLAIM(MC8)
  it.each([
    ["a graph node id", "a"],
    ["a list row id", "mcp"],
    ["an unknown id", "zz"],
  ])("[MC20] a bare %s in supports is DANGLING (not a source id)", (_name, id) => {
    expectRejected(check(withClaim([id])), [dangling("/views/5/data/blocks/2/supports/0")]);
  });
  it("[MC20] a bare source id of the notebook's own sources in supports is accepted", () => {
    expectAccepted(check(withClaim(["s1"])), "bundle");
  });
});

describe("[MC20] run-output bundles are validated with the same rules", () => {
  // The run-output document is covered in validate.example.test.ts; this pins only that the bundle path
  // used for run outputs resolves entities against the context too (shared code path).
  // why: bundle semantics must not differ between import and run output.
  // proves: CLAIM(MC20)
  it("[MC20] an entity-less bundle view is dangling and a context entity repairs it", () => {
    const solo = () => {
      const bundle = allBundle();
      return { schemaVersion: "paneweft.bundle/1", entities: [], definitions: [bundle.definitions[0]], views: [bundle.views[0]] };
    };
    expectRejected(check(solo()), [dangling("/views/0/entity")], "bundle");
    expectAccepted(check(solo(), { entities: [{ repository: "r", id: "watch", kind: "vigil/watch", snapshotId: "snap-1" }] }), "bundle");
  });
});
