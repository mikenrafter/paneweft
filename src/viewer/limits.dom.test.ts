// @vitest-environment jsdom
// MC14 (rendering at the limit): the design's graph budget is 200 nodes and 500 edges; a graph AT the limit must render every
// node and edge ("do not silently render the first N facts"), in both fixed layouts. Focus mode must say how many nodes it left out.
// The big graph is built programmatically (allowed for MC14); everything else is a literal fixture.
import { describe, expect, it } from "vitest";
import {
  SUBJECT, fixedFresh, goldenBundle, ids, need, openBundle, qa, q, text, useViewerCleanup, byId,
} from "../../test/helpers/dom-harness.ts";
import { patch } from "../../test/helpers/patch.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
useViewerCleanup();

const pad = (n: number): string => String(n).padStart(3, "0");
/** 200 nodes n000..n199 and 500 edges e000..e499: edge k goes n(k mod 200) -> n((7k+1) mod 200), relation rel(k mod 5). Cycles and parallel edges occur (legal). */
function bigGraphBundle(layout: "layered" | "grid"): unknown {
  const base = goldenBundle("graph");
  base.views[0].data = {
    nodes: Array.from({ length: 200 }, (_, i) => ({ id: `n${pad(i)}`, label: `Node ${i}`, provenance: "read", evidence: ["s1"] })),
    edges: Array.from({ length: 500 }, (_, k) => ({ id: `e${pad(k)}`, from: `n${pad(k % 200)}`, to: `n${pad((7 * k + 1) % 200)}`, relation: `rel${k % 5}`, provenance: "read", evidence: ["s1"] })),
    layout,
  };
  base.views[0].sources = base.views[0].sources.filter((s: any) => s.id === "s1");
  return base;
}

describe("[MC14] a graph at the budget renders completely", () => {
  for (const layout of ["layered", "grid"] as const) {
    // why: design 4 "Oversize payloads fail ... They are never silently dropped by the renderer" - at exactly 200/500 nothing may be cut.
    // proves: CLAIM(MC14)
    it(`[MC14] ${layout}: exactly 200 graph-node, 500 graph-edge and 500 graph-edge-item elements, ids complete, counts 500 of 500`, async () => {
      const v = await openBundle(tmp(layout), bigGraphBundle(layout), SUBJECT, "d-graph", { decorate: fixedFresh });
      const nodes = qa(v.container, "graph-node");
      const edges = qa(need(v.container, "graph"), "graph-edge");
      expect([nodes.length, edges.length, qa(v.container, "graph-edge-item").length]).toEqual([200, 500, 500]);
      expect(ids(nodes)).toEqual(Array.from({ length: 200 }, (_, i) => `n${pad(i)}`));
      expect(ids(edges)).toEqual(Array.from({ length: 500 }, (_, k) => `e${pad(k)}`));
      const count = need(v.container, "match-count");
      expect([count.getAttribute("data-matched"), count.getAttribute("data-total"), text(count)]).toEqual(["500", "500", "500 of 500 match"]);
      expect(text(need(v.container, "provenance-summary"))).toBe("read=700 parsed=0 compiled=0 observed=0 inferred=0");
      expect(qa(v.container, "relation-filter")).toHaveLength(5);
      expect(q(v.container, "omitted-neighborhood")).toBeNull();
    }, 90_000);
  }
  // why: the grid size is a closed formula (red-contract 6): n=200 -> cols=ceil(sqrt(200))=15, rows=ceil(200/15)=14.
  // proves: CLAIM(MC14) / CLAIM(MC9)
  it("[MC14] grid at the limit reports 3552 x 904", async () => {
    // width = 2*16 + 15*160 + 14*80 = 32 + 2400 + 1120 = 3552 ; height = 2*16 + 14*40 + 13*24 = 32 + 560 + 312 = 904
    // node n199: i=199 -> col = 199 % 15 = 4, row = floor(199/15) = 13 -> x = 16 + 4*240 = 976, y = 16 + 13*64 = 848
    const v = await openBundle(tmp("grid-size"), bigGraphBundle("grid"), SUBJECT, "d-graph", { decorate: fixedFresh });
    expect(text(need(v.container, "layout-info"))).toBe("3552 x 904");
    const last = byId(v.container, "graph-node", "n199");
    expect([last.getAttribute("data-x"), last.getAttribute("data-y")]).toEqual(["976", "848"]);
  }, 90_000);
});

describe("[MC14] focus mode states what it omitted", () => {
  // Graph golden edges: e1 a->b, e2 b->c, e3 c->b, e4 b->d, e5 a->e, e6 d->d.
  // out from b, depth 1: nodes b, c, d (e2, e4 traversed) -> a and e omitted = 2.
  // depth 0: only b -> a, c, d, e omitted = 4.  both directions, depth 1: b + a (e1) + c (e2/e3) + d (e4) -> only e omitted = 1.
  const CASES: Array<{ focus: { node: string; direction: "in" | "out" | "both"; depth: number }; nodes: string[]; omitted: number }> = [
    { focus: { node: "b", direction: "out", depth: 1 }, nodes: ["b", "c", "d"], omitted: 2 },
    { focus: { node: "b", direction: "out", depth: 0 }, nodes: ["b"], omitted: 4 },
    { focus: { node: "b", direction: "both", depth: 1 }, nodes: ["a", "b", "c", "d"], omitted: 1 },
  ];
  for (const c of CASES) {
    // why: design 2.3 "Text returns ... counts, and omitted neighborhoods"; the browser must not hide nodes without saying how many.
    // proves: CLAIM(MC14)
    it(`[MC14] focus ${c.focus.direction} depth ${c.focus.depth} on b renders ${c.nodes.join(",")} and says ${c.omitted} nodes were omitted`, async () => {
      const bundle = patch(goldenBundle("graph"), { op: "add", path: "/views/0/data/focus", value: c.focus });
      const v = await openBundle(tmp("focus"), bundle, SUBJECT, "d-graph", { decorate: fixedFresh });
      const nodes = qa(v.container, "graph-node");
      expect(ids(nodes)).toEqual(c.nodes);
      expect(nodes.filter((n) => n.getAttribute("data-status") === "focus").map((n) => n.getAttribute("data-id"))).toEqual(["b"]);
      const note = text(need(v.container, "omitted-neighborhood"));
      expect(note).toMatch(new RegExp(`^${c.omitted} nodes? omitted`));
      // no edge may dangle: every rendered edge connects two rendered nodes (e.g. e1 a->b is absent when a is omitted)
      const endpoints: Record<string, [string, string]> = { e1: ["a", "b"], e2: ["b", "c"], e3: ["c", "b"], e4: ["b", "d"], e5: ["a", "e"], e6: ["d", "d"] };
      for (const id of ids(qa(need(v.container, "graph"), "graph-edge"))) for (const end of endpoints[id as string]!) expect(c.nodes, `edge ${id} endpoint ${end}`).toContain(end);
    });
  }
  // why: without a focus the whole graph is shown and no omission note exists (negative control).
  // proves: CLAIM(MC14)
  it("[MC14] without focus there is no omitted-neighborhood element and all five nodes are rendered", async () => {
    const v = await openBundle(tmp("nofocus"), goldenBundle("graph"), SUBJECT, "d-graph", { decorate: fixedFresh });
    expect(q(v.container, "omitted-neighborhood")).toBeNull();
    expect(qa(v.container, "graph-node")).toHaveLength(5);
    expect(qa(v.container, "graph-node").filter((n) => n.hasAttribute("data-status"))).toHaveLength(0);
  });
});
