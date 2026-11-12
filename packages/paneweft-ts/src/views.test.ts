// The authoring contract in TypeScript: explicit tokens, the symbol protocol, bounded builders and view failures
// (IV1, IV2, S5, IV9 bounds). Expected output is derived from the ContainMarks question and written out literally.
import { describe, expect, it } from "vitest";
import { Capture, defineType, inspect, paneweftViews, withCapture, type ViewBuilders } from "./index.ts";
import { Mapping } from "../../../fixtures/packages/containmarks-lite/src/mappings/containerMappings.paneweft.ts";
import { call, specLimits } from "../test/support.ts";

const record = { firstSeenIndex: 4, cookieStoreId: "firefox-container-3", backupName: "Work" };

function viewOf(graph: any, id: string): any {
  expect(Array.isArray(graph.views), `the graph has a views array: ${JSON.stringify(graph)}`).toBe(true);
  const found = graph.views.find((v: any) => v.viewId === id);
  expect(found, `graph has no view ${id}: ${JSON.stringify(graph)}`).toBeDefined();
  return found;
}

describe("[IV1] a plain record with an explicit type token", () => {
  // why: IV1. The mapping details view selects exactly the three fields of the question, carries run evidence, and is a shape.
  // The expected data is the spec's `mapping.details` example, field by field.
  // proves: CLAIM(IV1) CLAIM(IV2)
  it("mapping.details is a shape with the three declared fields in order", () => {
    const capture = new Capture({ limits: specLimits() });
    const outcome = capture.publish(record, Mapping);
    expect(outcome).toEqual({ status: "published", ref: { object: "o1" } });
    const graph = capture.finish().toJSON() as any;
    const details = viewOf(graph, "mapping.details");
    expect(details.component).toBe("shape");
    expect(details.title).toBe("Container mapping");
    expect(details.question).toBe("Which original index and container does this mapping preserve?");
    expect(details.evidence).toEqual({ provenance: "observed", runId: "run-1" });
    const leaf = (name: string, type: string, example: unknown) => ({ id: `details.${name}`, path: `$.${name}`, type, presence: "required", example, children: [], provenance: "observed", evidence: ["run"] });
    expect(details.data).toEqual({
      basis: "observed",
      root: "details",
      fields: [
        { id: "details", path: "$", type: "object", presence: "required", children: ["details.original index", "details.container ID", "details.backup name"], provenance: "observed", evidence: ["run"] },
        leaf("original index", "number", 4),
        leaf("container ID", "string", "firefox-container-3"),
        leaf("backup name", "string", "Work"),
      ],
    });
    expect(graph.objects[0].typeId).toBe("containmarks::ContainerMappingRecord");
    expect(graph.objects[0].views).toEqual(["mapping.details", "mapping.card"]);
  });

  // why: IV21 mutation control: swapping two mapping fields must change the output (the test above would fail); this pins the
  // pairing of label and value, not just the set of values.
  // proves: CLAIM(IV21)
  it("swapped field values land under their own labels", () => {
    const capture = new Capture({ limits: specLimits() });
    call(() => capture.publish({ firstSeenIndex: 9, cookieStoreId: "firefox-container-9", backupName: "Home" }, Mapping), "publish");
    const fields = viewOf(capture.finish().toJSON(), "mapping.details").data.fields;
    expect(fields.map((f: any) => [f.path, f.example])).toEqual([["$", undefined], ["$.original index", 9], ["$.container ID", "firefox-container-9"], ["$.backup name", "Home"]]);
  });
});

describe("[IV2] how a runtime adapter is selected", () => {
  // why: IV2. A class implements the symbol protocol and needs no token argument; the symbol returns the registered definitions.
  // proves: CLAIM(IV2)
  it("a class selects its definitions through [paneweftViews]", () => {
    const ClassType = defineType<Counter>({ id: "fixture::Counter", source: { path: "x.ts", symbol: "Counter" } });
    class Counter {
      constructor(readonly count: number) {}
      [paneweftViews](_view: ViewBuilders) {
        return { type: ClassType, views: ClassType.views };
      }
    }
    ClassType.view({ id: "counter.details", title: "Counter", question: "How many?", priority: 10, component: "shape", render: (c, view) => view.details().field("count", c.count).done() });
    const capture = new Capture({ limits: specLimits() });
    expect(call(() => capture.publish(new Counter(3)), "publish").status).toBe("published");
    const graph = capture.finish().toJSON() as any;
    expect(graph.objects[0].typeId).toBe("fixture::Counter");
    expect(viewOf(graph, "counter.details").data.fields[1].example).toBe(3);
  });

  // why: IV2. An erased interface name never selects a runtime adapter: a record with exactly the Mapping shape but no token and no
  // symbol is refused (NO_TYPE) and nothing is captured. The positive control is the first test of this file.
  // proves: CLAIM(IV2)
  it("a structurally identical record without a token is refused, not guessed", () => {
    const capture = new Capture({ limits: specLimits() });
    const outcome = capture.publish({ ...record });
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" ? outcome.code : "").toBe("NO_TYPE");
    expect((capture.finish().toJSON() as any).objects).toEqual([]);
  });
});

describe("[S5] bounded builders and references", () => {
  const Many = defineType<{ n: number }>({ id: "fixture::Many", source: { path: "x.ts", symbol: "Many" } });
  Many.view({
    id: "many.rows",
    title: "Rows",
    question: "Which rows?",
    priority: 10,
    component: "list",
    render(value, view) {
      const table = view.table().textColumn("n", "N");
      const results = [];
      for (let index = 0; index < value.n; index += 1) results.push(table.row({ id: `r${index}`, cells: { n: index } }));
      (globalThis as any).__rowResults = results;
      return table.done();
    },
  });

  // why: S5. The third and fourth rows at a limit of two are refused with an omission count; the view stays a partial view with the
  // two retained rows, and the capture names the omission.
  // proves: CLAIM(S5-bounded-builders) CLAIM(IV9)
  it("a full table refuses rows, reports the omission and stays a partial view", () => {
    const capture = new Capture({ limits: specLimits({ viewRows: 2 }) });
    call(() => capture.publish({ n: 4 }, Many), "publish");
    const graph = capture.finish().toJSON() as any;
    const rows = viewOf(graph, "many.rows");
    expect(rows.data.rows).toHaveLength(2);
    expect(rows.completeness).toEqual({ status: "partial", reason: "row-limit", omitted: { rows: { known: true, count: 2 } } });
    expect((globalThis as any).__rowResults).toEqual([{ accepted: true }, { accepted: true }, { accepted: false, omittedSoFar: 1 }, { accepted: false, omittedSoFar: 2 }]);
    expect(graph.completeness).toEqual({ status: "partial", omitted: { rows: { known: true, count: 2 } } });
  });

  const Child = defineType<{ id: string }>({ id: "fixture::Child", source: { path: "x.ts", symbol: "Child" } });
  Child.view({ id: "child.details", title: "Child", question: "Which child?", priority: 10, component: "shape", render: (c, view) => view.details().field("id", c.id).done() });
  const Parent = defineType<{ children: Array<{ id: string }> }>({ id: "fixture::Parent", source: { path: "x.ts", symbol: "Parent" } });
  Parent.view({
    id: "parent.children",
    title: "Children",
    question: "Which children?",
    priority: 10,
    component: "list",
    render(parent, view) {
      const table = view.table().textColumn("id", "Id").orderBy("id", "asc");
      parent.children.forEach((child, index) => table.row({ id: `child-${index}`, cells: { id: child.id }, target: view.reference(child, Child, { key: child.id }) }));
      return table.done();
    },
  });

  // why: S5. A reference beyond the object bound is a not-captured reference, not an error, and not a diagnostic.
  // proves: CLAIM(S5-bounded-builders)
  it("a reference beyond the object limit is not captured and not an error", () => {
    const capture = new Capture({ limits: specLimits({ objects: 1 }) });
    call(() => capture.publish({ children: [{ id: "a" }] }, Parent), "publish");
    const graph = capture.finish().toJSON() as any;
    expect(viewOf(graph, "parent.children").data.rows[0].target).toEqual({ notCaptured: { reason: "object-limit" } });
    expect(graph.objects).toHaveLength(1);
    expect(graph.diagnostics).toEqual([]);
  });

  // why: IV21/IV1: rows are occurrences sorted stably by the declared key; duplicates keep distinct targets.
  // proves: CLAIM(IV1) CLAIM(IV21)
  it("rows are occurrences sorted stably with distinct targets for duplicate keys", () => {
    const capture = new Capture({ limits: specLimits() });
    call(() => capture.publish({ children: [{ id: "b" }, { id: "a" }, { id: "a" }] }, Parent), "publish");
    const graph = capture.finish().toJSON() as any;
    const rows = viewOf(graph, "parent.children").data.rows;
    expect(rows.map((r: any) => [r.id, r.cells.id, r.target.object])).toEqual([["child-1", "a", "o3"], ["child-2", "a", "o4"], ["child-0", "b", "o2"]]);
    expect(graph.objects.filter((o: any) => o.domainKey === "a")).toHaveLength(2);
  });

  // why: spec section 4: rows beyond the page size become content-addressed stored pages readable after the process exits.
  // proves: CLAIM(IV10)
  it("rows beyond the page size become content addressed pages", async () => {
    const { createHash } = await import("node:crypto");
    const capture = new Capture({ limits: specLimits({ pageRows: 2 }) });
    call(() => capture.publish({ children: [0, 1, 2, 3, 4].map((n) => ({ id: `c${n}` })) }, Parent), "publish");
    const graph = capture.finish().toJSON() as any;
    const list = viewOf(graph, "parent.children");
    expect(list.data.rows).toHaveLength(2);
    expect(list.pages.map((p: any) => [p.index, p.rowCount])).toEqual([[1, 2], [2, 1]]);
    expect(list.rowsTotal).toBe(5);
    for (const page of graph.pages) expect(page.pageId).toBe(`sha256:${createHash("sha256").update(JSON.stringify(page.rows)).digest("hex")}`);
  });

  // why: a view that throws fails alone (decision 10): its sibling is preserved, no empty successful record exists for it, and the
  // diagnostic names the view and carries the message.
  // proves: CLAIM(IV1) CLAIM(IV17)
  it("a throwing view is isolated and diagnosed by view id", () => {
    const Mixed = defineType<object>({ id: "fixture::Mixed", source: { path: "x.ts", symbol: "Mixed" } });
    Mixed.view({ id: "mixed.good", title: "Good", question: "Good?", priority: 10, component: "shape", render: (_v, view) => view.details().field("ok", true).done() });
    Mixed.view({ id: "mixed.bad", title: "Bad", question: "Fails?", priority: 20, component: "shape", render: () => { throw new Error("view blew up"); } });
    const capture = new Capture({ limits: specLimits() });
    call(() => capture.publish({}, Mixed), "publish");
    const graph = capture.finish().toJSON() as any;
    expect(Array.isArray(graph.views), "a views array").toBe(true);
    expect(graph.views.map((v: any) => v.viewId)).toEqual(["mixed.good"]);
    expect(graph.diagnostics).toHaveLength(1);
    expect(graph.diagnostics[0]).toMatchObject({ category: "view-exception", viewId: "mixed.bad" });
    expect(graph.diagnostics[0].message).toContain("view blew up");
  });

  // why: an unsupported result is explicit: a reason and no data.
  // proves: CLAIM(IV1)
  it("an unsupported view records a reason and no data", () => {
    const Only = defineType<object>({ id: "fixture::Only", source: { path: "x.ts", symbol: "Only" } });
    Only.view({ id: "only.unsupported", title: "Not here", question: "Applies?", priority: 10, component: "shape", render: (_v, view) => view.unsupported("needs the live process") });
    const capture = new Capture({ limits: specLimits() });
    call(() => capture.publish({}, Only), "publish");
    const record = viewOf(capture.finish().toJSON(), "only.unsupported");
    expect(record.completeness).toEqual({ status: "unsupported", reason: "needs the live process" });
    expect(record.unsupportedReason).toBe("needs the live process");
    expect(record.data).toBeUndefined();
  });
});

describe("[IV4] inspect without a collector", () => {
  // why: spec section 4: with no active collector `inspect` is inactive and no view function runs; a counter proves it, with an
  // active-collector control that runs the view exactly once.
  // proves: CLAIM(IV4) CLAIM(IV1)
  it("is inactive and calls no view; withCapture activates it", () => {
    let calls = 0;
    const Counting = defineType<object>({ id: "fixture::Counting", source: { path: "x.ts", symbol: "Counting" } });
    Counting.view({ id: "counting.v", title: "C", question: "C?", priority: 10, component: "shape", render: (_v, view) => { calls += 1; return view.details().done(); } });
    expect(inspect({}, Counting)).toEqual({ status: "inactive" });
    expect(calls).toBe(0);
    const graph = withCapture({ limits: specLimits() }, () => { inspect({}, Counting); }).toJSON() as any;
    expect(calls).toBe(1);
    expect(graph.objects).toHaveLength(1);
  });
});
