// MC9 deterministic graph layout (computeGraphLayout, graphNeighborhood). Normative: docs/red-contract.md section 6
// "Layout v1" (design section 5: fixed layered or grid layout, groups strongly connected nodes, stable ids, no force
// simulation). Every golden below was derived BY HAND from that section; the arithmetic is in the comments.
//
// Constants used in the arithmetic (written as literals on purpose, not imported):
//   node 160 x 40, gapX 80, gapY 24, margin 16  ->  x = 16 + layer*240, y = 16 + row*64
//   width  = 32 + (maxLayer+1)*160 + maxLayer*80       height = 32 + maxRows*40 + (maxRows-1)*24     (empty graph: 32 x 32)
//   forward edge (layer(from) < layer(to)):  M {fx+160} {fy+20} L {tx} {ty+20}
//   same layer / SCC member / back edge:     M {fx+80} {fy+40} L {fx+80} {yb} L {tx+80} {yb} L {tx+80} {ty+40},  yb = max(fy,ty)+52
//   self loop:  M {fx+160} {fy+20} L {fx+200} {fy+20} L {fx+200} {fy+52} L {fx+80} {fy+52} L {fx+80} {fy+40}
//   grid edge:  centre to centre, centre = (x+80, y+20)
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeGraphLayout, graphNeighborhood } from "./layout.ts";
import type { GraphLayout, GraphLayoutInput } from "./layout.ts";

type E = { id: string; from: string; to: string };
const edge = (id: string, from: string, to: string): E => ({ id, from, to });
const layoutOf = (nodeIds: string[], edges: E[], layout: "layered" | "grid" = "layered"): GraphLayout =>
  computeGraphLayout({ nodes: nodeIds.map((id) => ({ id })), edges, layout });
const node = (id: string, x: number, y: number, layer: number, row: number) => ({ id, x, y, layer, row });

describe("layered layout, hand-computed goldens", () => {
  // why: the design's own two-node graph (section 2.3 example). a -> b: a has no incoming group => layer 0, b => 1 + 0 = 1.
  //      a (16,16), b (16+240, 16) = (256,16). maxLayer 1, maxRows 1: width 32+2*160+1*80 = 432, height 32+1*40+0 = 72.
  //      edge e is forward: M (16+160) (16+20) L 256 (16+20) = "M 176 36 L 256 36".
  //      Input is given in reverse id order: output must be sorted by id.
  // proves: CLAIM(MC9)
  it("[MC9] the two-node chain from the design", () => {
    expect(layoutOf(["b", "a"], [edge("e", "a", "b")])).toStrictEqual({
      version: "layout/1",
      layout: "layered",
      width: 432,
      height: 72,
      nodes: [node("a", 16, 16, 0, 0), node("b", 256, 16, 1, 0)],
      edges: [{ id: "e", d: "M 176 36 L 256 36" }],
    });
  });

  // why: parallel edges between the same nodes get the same path and are both kept (ids are the identity, sorted).
  // proves: CLAIM(MC9)
  it("[MC9] two edges between the same pair share a path and stay separate entries, sorted by id", () => {
    const out = layoutOf(["a", "b"], [edge("f", "a", "b"), edge("e", "a", "b")]);
    expect(out.edges).toStrictEqual([{ id: "e", d: "M 176 36 L 256 36" }, { id: "f", d: "M 176 36 L 256 36" }]);
  });

  // why: diamond a->b, a->c, b->d, c->d. layers: a 0; b,c 1 (rows 0,1 by id); d = 1 + max(1,1) = 2 (row 0).
  //      maxLayer 2, maxRows 2 -> width 32+3*160+2*80 = 672, height 32+2*40+1*24 = 136.
  //      a (16,16); b (256,16); c (256,16+64=80); d (496,16).
  //      ab: M 176 36 L 256 36        ac: M 176 36 L 256 (80+20=100)
  //      bd: M (256+160=416) 36 L 496 36     cd: M 416 100 L 496 36
  // proves: CLAIM(MC9)
  it("[MC9] the diamond", () => {
    const out = layoutOf(["d", "c", "b", "a"], [edge("cd", "c", "d"), edge("bd", "b", "d"), edge("ac", "a", "c"), edge("ab", "a", "b")]);
    expect(out).toStrictEqual({
      version: "layout/1",
      layout: "layered",
      width: 672,
      height: 136,
      nodes: [node("a", 16, 16, 0, 0), node("b", 256, 16, 1, 0), node("c", 256, 80, 1, 1), node("d", 496, 16, 2, 0)],
      edges: [
        { id: "ab", d: "M 176 36 L 256 36" },
        { id: "ac", d: "M 176 36 L 256 100" },
        { id: "bd", d: "M 416 36 L 496 36" },
        { id: "cd", d: "M 416 100 L 496 36" },
      ],
    });
  });

  // why: layer = 1 + max over predecessors (LONGEST path), not the shortest: a->b, b->c, a->c puts c in layer 2, not 1.
  //      A shortest-path layering gives c layer 1 (and overlaps b). a (16,16) b (256,16) c (496,16); width 672, height 72.
  //      ac is a forward edge spanning two layers: M 176 36 L 496 36.  bc: M 416 36 L 496 36.  ab: M 176 36 L 256 36.
  // proves: CLAIM(MC9)
  it("[MC9] layering uses the longest path (a->b->c plus a->c)", () => {
    const out = layoutOf(["a", "b", "c"], [edge("ab", "a", "b"), edge("bc", "b", "c"), edge("ac", "a", "c")]);
    expect(out.nodes).toStrictEqual([node("a", 16, 16, 0, 0), node("b", 256, 16, 1, 0), node("c", 496, 16, 2, 0)]);
    expect(out.edges).toStrictEqual([{ id: "ab", d: "M 176 36 L 256 36" }, { id: "ac", d: "M 176 36 L 496 36" }, { id: "bc", d: "M 416 36 L 496 36" }]);
    expect([out.width, out.height]).toStrictEqual([672, 72]);
  });

  // why: a graph with a 3-cycle b->c->d->b hanging off a (edges ab, bc, cd, db). The strongly connected group
  //      {b,c,d} is ONE layer: a layer 0; group layer 1 = 1 + layer(a). Members by id: b row0, c row1, d row2.
  //      maxLayer 1, maxRows 3: width 32+2*160+80 = 432, height 32+3*40+2*24 = 200.
  //      a (16,16); b (256,16); c (256,80); d (256,144).
  //      ab (forward): M 176 36 L 256 36.
  //      bc (same layer): fx=256 fy=16 tx=256 ty=80, yb = max(16,80)+52 = 132: M 336 56 L 336 132 L 336 132 L 336 120.
  //      cd: fy=80 ty=144, yb = 196:  M 336 120 L 336 196 L 336 196 L 336 184.
  //      db: fy=144 ty=16, yb = 196:  M 336 184 L 336 196 L 336 196 L 336 56.
  // proves: CLAIM(MC9)
  it("[MC9] a 3-cycle hanging off a node: the cycle shares one layer and same-layer edges use the bottom route", () => {
    const out = layoutOf(["a", "b", "c", "d"], [edge("ab", "a", "b"), edge("bc", "b", "c"), edge("cd", "c", "d"), edge("db", "d", "b")]);
    expect(out).toStrictEqual({
      version: "layout/1",
      layout: "layered",
      width: 432,
      height: 200,
      nodes: [node("a", 16, 16, 0, 0), node("b", 256, 16, 1, 0), node("c", 256, 80, 1, 1), node("d", 256, 144, 1, 2)],
      edges: [
        { id: "ab", d: "M 176 36 L 256 36" },
        { id: "bc", d: "M 336 56 L 336 132 L 336 132 L 336 120" },
        { id: "cd", d: "M 336 120 L 336 196 L 336 196 L 336 184" },
        { id: "db", d: "M 336 184 L 336 196 L 336 196 L 336 56" },
      ],
    });
  });

  // why: a cycle with NO entry node still gets layer 0 (a topological-sort layering that waits for in-degree 0 never
  //      terminates or drops it). a<->b: one group, layer 0, rows a0 b1. width 32+160 = 192, height 32+80+24 = 136.
  //      ab: fx=16 fy=16 tx=16 ty=80 yb=132: M 96 56 L 96 132 L 96 132 L 96 120.   ba: M 96 120 L 96 132 L 96 132 L 96 56.
  // proves: CLAIM(MC9)
  it("[MC9] a pure two-cycle with no entry point sits in layer 0", () => {
    expect(layoutOf(["b", "a"], [edge("ba", "b", "a"), edge("ab", "a", "b")])).toStrictEqual({
      version: "layout/1",
      layout: "layered",
      width: 192,
      height: 136,
      nodes: [node("a", 16, 16, 0, 0), node("b", 16, 80, 0, 1)],
      edges: [
        { id: "ab", d: "M 96 56 L 96 132 L 96 132 L 96 120" },
        { id: "ba", d: "M 96 120 L 96 132 L 96 132 L 96 56" },
      ],
    });
  });

  // why: contract: within a layer GROUPS are ordered by their smallest member id, then members by id. r -> b, r -> c, b<->z:
  //      layer 1 holds group {b,z} (smallest member b) and singleton c, so the order is b, z, c (rows 0,1,2). Plain sorting
  //      of node ids would give b, c, z. r (16,16); b (256,16); z (256,80); c (256,144). width 432, height 200.
  //      rb: M 176 36 L 256 36.  rc: M 176 36 L 256 (144+20=164).
  //      bz: fy=16 ty=80 yb=132: M 336 56 L 336 132 L 336 132 L 336 120.  zb: fy=80 ty=16 yb=132: M 336 120 L 336 132 L 336 132 L 336 56.
  // proves: CLAIM(MC9)
  it("[MC9] groups are ordered by smallest member id, so an SCC's members stay together", () => {
    const out = layoutOf(["c", "z", "b", "r"], [edge("rb", "r", "b"), edge("rc", "r", "c"), edge("bz", "b", "z"), edge("zb", "z", "b")]);
    expect(out.nodes).toStrictEqual([node("b", 256, 16, 1, 0), node("c", 256, 144, 1, 2), node("r", 16, 16, 0, 0), node("z", 256, 80, 1, 1)]);
    expect(out.edges).toStrictEqual([
      { id: "bz", d: "M 336 56 L 336 132 L 336 132 L 336 120" },
      { id: "rb", d: "M 176 36 L 256 36" },
      { id: "rc", d: "M 176 36 L 256 164" },
      { id: "zb", d: "M 336 120 L 336 132 L 336 132 L 336 56" },
    ]);
    expect([out.width, out.height]).toStrictEqual([432, 200]);
  });

  // why: a disconnected pair of nodes: both have no incoming group => layer 0, rows p0 q1: p (16,16), q (16,16+64=80).
  //      width 32+160 = 192, height 32+2*40+24 = 136. No edges.
  // proves: CLAIM(MC9)
  it("[MC9] two disconnected nodes stack in layer 0", () => {
    expect(layoutOf(["q", "p"], [])).toStrictEqual({
      version: "layout/1",
      layout: "layered",
      width: 192,
      height: 136,
      nodes: [node("p", 16, 16, 0, 0), node("q", 16, 80, 0, 1)],
      edges: [],
    });
  });

  // why: two disconnected CHAINS interleave by layer: layer 0 = a (row 0), c (row 1); layer 1 = b (row 0), d (row 1).
  //      a (16,16) c (16,80) b (256,16) d (256,80); width 432, height 136.  ab: M 176 36 L 256 36.  cd: M 176 (80+20=100) L 256 100.
  // proves: CLAIM(MC9)
  it("[MC9] two disconnected chains share layers and rows are counted per layer", () => {
    const out = layoutOf(["a", "b", "c", "d"], [edge("cd", "c", "d"), edge("ab", "a", "b")]);
    expect(out.nodes).toStrictEqual([node("a", 16, 16, 0, 0), node("b", 256, 16, 1, 0), node("c", 16, 80, 0, 1), node("d", 256, 80, 1, 1)]);
    expect(out.edges).toStrictEqual([{ id: "ab", d: "M 176 36 L 256 36" }, { id: "cd", d: "M 176 100 L 256 100" }]);
    expect([out.width, out.height]).toStrictEqual([432, 136]);
  });

  // why: a self loop is a single-node SCC with its own path rule: a (16,16): M 176 36 L 216 36 L 216 68 L 96 68 L 96 56
  //      (fx+160=176, fy+20=36, fx+200=216, fy+52=68, fx+80=96, fy+40=56). One node: width 192, height 72.
  // proves: CLAIM(MC9)
  it("[MC9] a node with a self loop", () => {
    expect(layoutOf(["a"], [edge("loop", "a", "a")])).toStrictEqual({
      version: "layout/1",
      layout: "layered",
      width: 192,
      height: 72,
      nodes: [node("a", 16, 16, 0, 0)],
      edges: [{ id: "loop", d: "M 176 36 L 216 36 L 216 68 L 96 68 L 96 56" }],
    });
  });

  // why: a self loop must not push the node a layer down (a->b plus b->b leaves b in layer 1), and the loop path is anchored at
  //      b's own box: b (256,16): M 416 36 L 456 36 L 456 68 L 336 68 L 336 56 (256+160, 16+20, 256+200, 16+52, 256+80, 16+40).
  //      Width is the layer formula (432), not widened for the loop.
  // proves: CLAIM(MC9)
  it("[MC9] a self loop does not change layering", () => {
    const out = layoutOf(["a", "b"], [edge("ab", "a", "b"), edge("bb", "b", "b")]);
    expect(out.nodes).toStrictEqual([node("a", 16, 16, 0, 0), node("b", 256, 16, 1, 0)]);
    expect(out.edges).toStrictEqual([{ id: "ab", d: "M 176 36 L 256 36" }, { id: "bb", d: "M 416 36 L 456 36 L 456 68 L 336 68 L 336 56" }]);
    expect([out.width, out.height]).toStrictEqual([432, 72]);
  });

  // why: the contract fixes the empty graph at 32 x 32 (two margins), with no nodes or edges and still the version string.
  // proves: CLAIM(MC9)
  it("[MC9] the empty graph is 32 x 32", () => {
    expect(layoutOf([], [])).toStrictEqual({ version: "layout/1", layout: "layered", width: 32, height: 32, nodes: [], edges: [] });
  });

  // why: ids are ordered by CODE UNIT, not by locale or numerically: "10" < "9" < "B" < "a" < "b". Five isolated nodes in layer 0,
  //      rows 0..4: y = 16, 80, 144, 208, 272. width 192, height 32+5*40+4*24 = 328. localeCompare would order a, b, B, 10, 9.
  // proves: CLAIM(MC9)
  it("[MC9] node order is code-unit id order", () => {
    const out = layoutOf(["a", "B", "b", "10", "9"], []);
    expect(out.nodes).toStrictEqual([node("10", 16, 16, 0, 0), node("9", 16, 80, 0, 1), node("B", 16, 144, 0, 2), node("a", 16, 208, 0, 3), node("b", 16, 272, 0, 4)]);
    expect([out.width, out.height]).toStrictEqual([192, 328]);
  });
});

describe("grid layout, hand-computed goldens", () => {
  // Grid: nodes by id; cols = ceil(sqrt(n)); node i at col = i % cols, row = floor(i / cols); layer := col; x,y use the same
  // 240 / 64 pitch; width/height use the same formulas with maxLayer = cols-1 and maxRows = ceil(n / cols).
  // why: one node: cols = ceil(sqrt 1) = 1 -> (16,16), width 32+160 = 192, height 72.
  // proves: CLAIM(MC9)
  it("[MC9] grid with 1 node", () => {
    expect(layoutOf(["n1"], [], "grid")).toStrictEqual({ version: "layout/1", layout: "grid", width: 192, height: 72, nodes: [node("n1", 16, 16, 0, 0)], edges: [] });
  });

  // why: two nodes: cols = ceil(sqrt 2) = ceil(1.414) = 2 -> one row: n1 (16,16), n2 (256,16); width 32+2*160+80 = 432, height 72.
  //      Grid edges are centre to centre: n2 centre (256+80, 16+20) = (336,36) -> n1 centre (96,36): "M 336 36 L 96 36".
  // proves: CLAIM(MC9)
  it("[MC9] grid with 2 nodes and a right-to-left edge", () => {
    expect(layoutOf(["n2", "n1"], [edge("e", "n2", "n1")], "grid")).toStrictEqual({
      version: "layout/1",
      layout: "grid",
      width: 432,
      height: 72,
      nodes: [node("n1", 16, 16, 0, 0), node("n2", 256, 16, 1, 0)],
      edges: [{ id: "e", d: "M 336 36 L 96 36" }],
    });
  });

  // why: four nodes: cols = ceil(sqrt 4) = 2, 2 rows. Ids ["a","B","c","D"] sort by code unit to B, D, a, c (a locale sort
  //      would give a, B, c, D): B (col0,row0) (16,16); D (col1,row0) (256,16); a (col0,row1) (16,80); c (col1,row1) (256,80).
  //      width 432, height 32+2*40+24 = 136. Edge e: B -> c: centres (96,36) -> (336,100). Edge f: a -> D: (96,100) -> (336,36).
  // proves: CLAIM(MC9)
  it("[MC9] grid with 4 nodes sorted by code-unit id", () => {
    expect(layoutOf(["a", "B", "c", "D"], [edge("f", "a", "D"), edge("e", "B", "c")], "grid")).toStrictEqual({
      version: "layout/1",
      layout: "grid",
      width: 432,
      height: 136,
      nodes: [node("B", 16, 16, 0, 0), node("D", 256, 16, 1, 0), node("a", 16, 80, 0, 1), node("c", 256, 80, 1, 1)],
      edges: [{ id: "e", d: "M 96 36 L 336 100" }, { id: "f", d: "M 96 100 L 336 36" }],
    });
  });

  // why: five nodes: cols = ceil(sqrt 5) = ceil(2.236) = 3, 2 rows (a short last row): n1 (16,16) n2 (256,16) n3 (496,16)
  //      n4 (16,80) n5 (256,80); layer = col. width 32+3*160+2*80 = 672, height 136. Edges: e1 n1->n5 (96,36)->(336,100);
  //      e2 n3->n4 (576,36)->(96,100) - direction does not matter for position; a cycle n1->n2->n1 is allowed.
  // proves: CLAIM(MC9)
  it("[MC9] grid with 5 nodes: 3 columns, short second row, edges centre to centre", () => {
    const edges = [edge("e1", "n1", "n5"), edge("e2", "n3", "n4"), edge("e3", "n1", "n2"), edge("e4", "n2", "n1")];
    const out = layoutOf(["n5", "n3", "n1", "n4", "n2"], edges, "grid");
    expect(out.nodes).toStrictEqual([node("n1", 16, 16, 0, 0), node("n2", 256, 16, 1, 0), node("n3", 496, 16, 2, 0), node("n4", 16, 80, 0, 1), node("n5", 256, 80, 1, 1)]);
    expect(out.edges).toStrictEqual([
      { id: "e1", d: "M 96 36 L 336 100" },
      { id: "e2", d: "M 576 36 L 96 100" },
      { id: "e3", d: "M 96 36 L 336 36" },
      { id: "e4", d: "M 336 36 L 96 36" },
    ]);
    expect([out.width, out.height, out.layout, out.version]).toStrictEqual([672, 136, "grid", "layout/1"]);
  });

  // why: the layout choice changes the edge path for the same graph: layered routes a->b from the right-middle of a to the
  //      left-middle of b ("M 176 36 L 256 36"), grid goes centre to centre ("M 96 36 L 336 36"). A grid that reuses the
  //      layered router (or the reverse) fails one of the two.
  // proves: CLAIM(MC9)
  it("[MC9] the same edge has different paths in layered and grid layouts", () => {
    const input = { nodes: [{ id: "a" }, { id: "b" }], edges: [edge("e", "a", "b")] };
    expect(computeGraphLayout({ ...input, layout: "layered" }).edges).toStrictEqual([{ id: "e", d: "M 176 36 L 256 36" }]);
    expect(computeGraphLayout({ ...input, layout: "grid" }).edges).toStrictEqual([{ id: "e", d: "M 96 36 L 336 36" }]);
  });
});

// ------------------------------------------------------------------------------------------------
// properties over random graphs (fixed seed)
// ------------------------------------------------------------------------------------------------
const POOL = ["a", "B", "b", "10", "9", "n1", "n2", "_x"];
const codeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const graphArb = fc.record({
  nodes: fc.subarray(POOL),
  pairs: fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 14 }),
  keys: fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 30, maxLength: 30 }),
  layout: fc.constantFrom("layered" as const, "grid" as const),
});
type Sample = typeof graphArb extends fc.Arbitrary<infer T> ? T : never;
const permute = <T>(list: T[], keys: number[], offset: number): T[] =>
  list.map((value, index) => [value, keys[(index + offset) % keys.length] ?? 0] as const).sort((a, b) => a[1] - b[1]).map(([value]) => value);
function build(sample: Sample, shuffle: boolean): GraphLayoutInput {
  const ids = sample.nodes;
  const edges: E[] = ids.length === 0 ? [] : sample.pairs.map(([a, b], index) => edge(`e${index}`, ids[a % ids.length]!, ids[b % ids.length]!));
  return {
    nodes: (shuffle ? permute(ids, sample.keys, 0) : ids).map((id) => ({ id })),
    edges: shuffle ? permute(edges, sample.keys, 11) : edges,
    layout: sample.layout,
  };
}

/** Independent layer oracle: reachability closure -> SCC leader -> longest path over the condensation. */
function oracleLayers(ids: string[], edges: E[]): Map<string, number> {
  const reach = new Map<string, Set<string>>(ids.map((id) => [id, new Set([id])]));
  for (const e of edges) reach.get(e.from)!.add(e.to);
  for (const k of ids) for (const i of ids) if (reach.get(i)!.has(k)) for (const j of ids) if (reach.get(k)!.has(j)) reach.get(i)!.add(j);
  const leader = (id: string): string => ids.filter((other) => reach.get(id)!.has(other) && reach.get(other)!.has(id)).sort(codeUnit)[0]!;
  const memo = new Map<string, number>();
  const layerOfGroup = (group: string): number => {
    const cached = memo.get(group);
    if (cached !== undefined) return cached;
    const members = ids.filter((id) => leader(id) === group);
    let best = 0;
    for (const e of edges) if (members.includes(e.to) && leader(e.from) !== group) best = Math.max(best, layerOfGroup(leader(e.from)) + 1);
    memo.set(group, best);
    return best;
  };
  return new Map(ids.map((id) => [id, layerOfGroup(leader(id))]));
}

function parsePath(d: string): Array<[number, number]> | null {
  if (!/^M -?\d+ -?\d+( L -?\d+ -?\d+)*$/.test(d)) return null;
  const tokens = d.split(" ");
  const points: Array<[number, number]> = [];
  for (let i = 0; i < tokens.length; i += 3) points.push([Number(tokens[i + 1]), Number(tokens[i + 2])]);
  return points;
}
const onBoundary = (p: [number, number], n: { x: number; y: number }): boolean =>
  p[0] >= n.x && p[0] <= n.x + 160 && p[1] >= n.y && p[1] <= n.y + 40 && (p[0] === n.x || p[0] === n.x + 160 || p[1] === n.y || p[1] === n.y + 40);

describe("layout properties (seed 42, 300 graphs)", () => {
  // why: MC9 "Rendering is deterministic ... Sort unordered inputs": shuffling node order and edge order must give a DEEP-EQUAL
  //      layout, for both layered and grid, on graphs with cycles, self loops, parallel edges and disconnected parts.
  //      Control: the control test below shows the generator really produces cyclic graphs.
  // proves: CLAIM(MC9)
  it("[MC9] shuffling nodes and edges yields an identical layout", () => {
    fc.assert(
      fc.property(graphArb, (sample) => {
        const shuffled = computeGraphLayout(build(sample, true));
        expect(shuffled).toStrictEqual(computeGraphLayout(build(sample, false)));
        // not vacuous: the (identical) result really describes the graph
        expect(shuffled.nodes.map((n) => n.id)).toStrictEqual([...sample.nodes].sort(codeUnit));
        expect(shuffled.version).toBe("layout/1");
      }),
      { seed: 42, numRuns: 300 },
    );
  });

  // why: structural invariants of Layout v1 for ANY graph: ids sorted by code unit; every input node/edge present once; x/y from
  //      layer/row by the 240/64 pitch; node boxes pairwise disjoint and inside the canvas margins; layered layers equal an
  //      independent oracle (SCC + longest path); rows in a layer are 0..k-1; edge d is well-formed, integer, starts on the
  //      FROM box boundary and ends on the TO box boundary (layered) or at the box centres (grid).
  // proves: CLAIM(MC9)
  it("[MC9] boxes never overlap, ids are sorted, layers match the oracle, edges start and end on node boundaries", () => {
    fc.assert(
      fc.property(graphArb, (sample) => {
        const input = build(sample, true);
        const out = computeGraphLayout(input);
        const ids = input.nodes.map((n) => n.id).sort(codeUnit);
        expect(out.nodes.map((n) => n.id)).toStrictEqual(ids);
        expect(out.edges.map((e) => e.id)).toStrictEqual(input.edges.map((e) => e.id).sort(codeUnit));
        expect(out.version).toBe("layout/1");
        for (const n of out.nodes) {
          expect([n.x, n.y]).toStrictEqual([16 + n.layer * 240, 16 + n.row * 64]);
          expect(n.x + 160 <= out.width - 16 && n.y + 40 <= out.height - 16, `${n.id} inside canvas`).toBe(true);
        }
        for (const [i, p] of out.nodes.entries()) {
          for (const q of out.nodes.slice(i + 1)) {
            const disjoint = p.x + 160 <= q.x || q.x + 160 <= p.x || p.y + 40 <= q.y || q.y + 40 <= p.y;
            expect(disjoint, `${p.id} and ${q.id} overlap`).toBe(true);
          }
        }
        if (ids.length === 0) expect([out.width, out.height]).toStrictEqual([32, 32]);

        const byId = new Map(out.nodes.map((n) => [n.id, n]));
        if (sample.layout === "layered") {
          const layers = oracleLayers(ids, input.edges);
          for (const n of out.nodes) expect(n.layer, `layer of ${n.id}`).toBe(layers.get(n.id));
          const maxLayer = Math.max(-1, ...out.nodes.map((n) => n.layer));
          for (let layer = 0; layer <= maxLayer; layer += 1) {
            const rows = out.nodes.filter((n) => n.layer === layer).map((n) => n.row).sort((a, b) => a - b);
            expect(rows, `rows of layer ${layer}`).toStrictEqual(rows.map((_, k) => k));
          }
        } else {
          const cols = Math.ceil(Math.sqrt(ids.length));
          out.nodes.forEach((n, i) => expect([n.layer, n.row]).toStrictEqual([i % cols, Math.floor(i / cols)]));
        }
        for (const e of input.edges) {
          const d = out.edges.find((x) => x.id === e.id)!.d;
          const points = parsePath(d);
          expect(points, `path syntax of ${e.id}: ${d}`).not.toBeNull();
          const from = byId.get(e.from)!;
          const to = byId.get(e.to)!;
          if (sample.layout === "grid") {
            if (e.from === e.to) continue; // grid self loops are not specified by the contract
            expect(points).toStrictEqual([[from.x + 80, from.y + 20], [to.x + 80, to.y + 20]]);
          } else {
            expect(onBoundary(points![0]!, from), `${e.id} starts on ${e.from}`).toBe(true);
            expect(onBoundary(points![points!.length - 1]!, to), `${e.id} ends on ${e.to}`).toBe(true);
            const shape = e.from === e.to ? 5 : from.layer < to.layer ? 2 : 4;
            expect(points!.length, `${e.id} route kind`).toBe(shape);
          }
        }
      }),
      { seed: 42, numRuns: 300 },
    );
  });

  // why: control that the two properties above are not vacuous: the seeded generator really produces cycles, self loops,
  //      multi-layer graphs and empty graphs (boolean coverage, so a generator regression is visible).
  // proves: CLAIM(MC9)
  it("[MC9] the generator covers cycles, self loops, deep layerings and empty graphs", () => {
    const seen = { cycle: false, loop: false, deep: false, empty: false };
    for (const sample of fc.sample(graphArb, { seed: 42, numRuns: 300 })) {
      const input = build(sample, false);
      const ids = input.nodes.map((n) => n.id);
      if (ids.length === 0) seen.empty = true;
      if (input.edges.some((e) => e.from === e.to)) seen.loop = true;
      if (Math.max(-1, ...oracleLayers(ids, input.edges).values()) >= 2) seen.deep = true;
      if (input.edges.some((e) => e.from !== e.to && input.edges.some((f) => f.from === e.to && f.to === e.from))) seen.cycle = true;
    }
    expect(seen).toStrictEqual({ cycle: true, loop: true, deep: true, empty: true });
  });

  // why: the oracle itself must be right or the property proves nothing: it reproduces the hand-computed layers of three goldens
  //      above (longest path, hanging cycle, entry-less cycle).
  // proves: CLAIM(MC9)
  it("[MC9] the layer oracle reproduces the hand-derived layers", () => {
    const layersOf = (ids: string[], edges: E[]) => Object.fromEntries(oracleLayers(ids, edges));
    expect(layersOf(["a", "b", "c"], [edge("1", "a", "b"), edge("2", "b", "c"), edge("3", "a", "c")])).toStrictEqual({ a: 0, b: 1, c: 2 });
    expect(layersOf(["a", "b", "c", "d"], [edge("1", "a", "b"), edge("2", "b", "c"), edge("3", "c", "d"), edge("4", "d", "b")])).toStrictEqual({ a: 0, b: 1, c: 1, d: 1 });
    expect(layersOf(["a", "b"], [edge("1", "a", "b"), edge("2", "b", "a")])).toStrictEqual({ a: 0, b: 0 });
  });
});

describe("graphNeighborhood", () => {
  // The hand-checked graph (a 3-cycle a->b->c->a, a tail c->d->e, and a second source f->d):
  //   e1 a->b   e2 b->c   e3 c->a   e4 c->d   e5 d->e   e6 f->d
  const nodes = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
  const edges = [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "a"), edge("e4", "c", "d"), edge("e5", "d", "e"), edge("e6", "f", "d")];
  const hood = (node: string, direction: "in" | "out" | "both", depth: number) => graphNeighborhood({ nodes, edges }, { node, direction, depth });

  // why: BFS from the focus along the allowed direction(s) up to `depth` steps; returns visited node ids and the TRAVERSED edge
  //      ids, both sorted. Derivations (a step expands every node first reached in the previous step):
  //      c out 1: from c: e3 (->a), e4 (->d)                         nodes {a,c,d}        edges {e3,e4}
  //      c out 2: expand a: e1 (->b); d: e5 (->e)                    nodes {a,b,c,d,e}    edges {e1,e3,e4,e5}
  //               (e2 b->c joins two VISITED nodes but b was only reached at step 2 and not expanded: NOT traversed)
  //      c out 3: expand b: e2 (->c, already visited, still traversed) edges {e1..e5}
  //      c in 1:  into c: e2 (from b)                                nodes {b,c}          edges {e2}
  //      c in 2:  into b: e1 (from a)                                nodes {a,b,c}        edges {e1,e2}
  //      c in 3:  into a: e3 (from c)                                                      edges {e1,e2,e3}
  //      d both 1: incident to d: e4, e5, e6                         nodes {c,d,e,f}      edges {e4,e5,e6}
  //      d both 2: expand c: e2,e3,e4; e: e5; f: e6                  all nodes            edges {e2..e6}   (e1 a->b: both ends
  //                visited, neither expanded: NOT traversed)
  //      d both 3: expand a, b: e1                                   all nodes            edges {e1..e6}
  //      depth 0 is just the focus; f out reaches d,e; a sink has no out-neighbours; a source has no in-neighbours.
  // proves: CLAIM(MC9)
  it.each([
    ["c", "both", 0, ["c"], []],
    ["c", "out", 0, ["c"], []],
    ["c", "out", 1, ["a", "c", "d"], ["e3", "e4"]],
    ["c", "out", 2, ["a", "b", "c", "d", "e"], ["e1", "e3", "e4", "e5"]],
    ["c", "out", 3, ["a", "b", "c", "d", "e"], ["e1", "e2", "e3", "e4", "e5"]],
    ["c", "out", 99, ["a", "b", "c", "d", "e"], ["e1", "e2", "e3", "e4", "e5"]],
    ["c", "in", 1, ["b", "c"], ["e2"]],
    ["c", "in", 2, ["a", "b", "c"], ["e1", "e2"]],
    ["c", "in", 3, ["a", "b", "c"], ["e1", "e2", "e3"]],
    ["d", "both", 1, ["c", "d", "e", "f"], ["e4", "e5", "e6"]],
    ["d", "both", 2, ["a", "b", "c", "d", "e", "f"], ["e2", "e3", "e4", "e5", "e6"]],
    ["d", "both", 3, ["a", "b", "c", "d", "e", "f"], ["e1", "e2", "e3", "e4", "e5", "e6"]],
    ["f", "out", 99, ["d", "e", "f"], ["e5", "e6"]],
    ["e", "out", 5, ["e"], []],
    ["f", "in", 5, ["f"], []],
  ] as const)("[MC9] neighborhood of %s, direction %s, depth %i", (focus, direction, depth, expectedNodes, expectedEdges) => {
    expect(hood(focus, direction, depth)).toStrictEqual({ nodeIds: [...expectedNodes], edgeIds: [...expectedEdges] });
  });

  // why: DECISION (docs/contract-additions/nav.md): a focus node that is not in the graph yields an empty neighbourhood
  //      ({nodeIds: [], edgeIds: []}), never the focus id and never a throw - the caller reports the unknown node.
  //      Control: the same call with an existing node is non-empty.
  // proves: CLAIM(MC9)
  it("[MC9] an unknown focus node gives an empty neighbourhood", () => {
    expect(hood("zzz", "both", 3)).toStrictEqual({ nodeIds: [], edgeIds: [] });
    expect(hood("a", "both", 3).nodeIds).toStrictEqual(["a", "b", "c", "d", "e", "f"]);
  });

  // why: results are sorted by code-unit order and independent of input order: ids "a","B","10"; x1: a->B, x2: 10->a;
  //      focus a, both, depth 1 -> nodes 10,B,a (not a,B,10) and edges x1,x2 even though the edges are listed reversed.
  // proves: CLAIM(MC9)
  it("[MC9] node and edge ids are returned in code-unit order regardless of input order", () => {
    const result = graphNeighborhood({ nodes: [{ id: "a" }, { id: "B" }, { id: "10" }], edges: [edge("x2", "10", "a"), edge("x1", "a", "B")] }, { node: "a", direction: "both", depth: 1 });
    expect(result).toStrictEqual({ nodeIds: ["10", "B", "a"], edgeIds: ["x1", "x2"] });
  });

  // why: over random graphs, with an independent DISTANCE-based formulation (a node is visited iff its BFS distance <= depth; an
  //      edge is traversed iff its tail/head - per direction - has distance <= depth-1), the result must match, be sorted, be
  //      monotone in depth, and be invariant under input permutation. (Formulation differs from the frontier-expansion a reducer
  //      would write, so this is not a mirror.)
  // proves: CLAIM(MC9)
  it("[MC9] matches a distance-based oracle, is monotone in depth and permutation-invariant (seed 42)", () => {
    const focusArb = fc.record({ sample: graphArb, which: fc.nat(), direction: fc.constantFrom("in" as const, "out" as const, "both" as const), depth: fc.integer({ min: 0, max: 5 }) });
    fc.assert(
      fc.property(focusArb, ({ sample, which, direction, depth }) => {
        const input = build(sample, false);
        const shuffled = build(sample, true);
        if (input.nodes.length === 0) return;
        const focus = input.nodes[which % input.nodes.length]!.id;
        const result = graphNeighborhood(input, { node: focus, direction, depth });
        expect(graphNeighborhood(shuffled, { node: focus, direction, depth })).toStrictEqual(result);

        const dist = new Map<string, number>([[focus, 0]]);
        for (let level = 0; level < 12; level += 1) {
          for (const e of input.edges) {
            const fromD = dist.get(e.from);
            const toD = dist.get(e.to);
            if ((direction === "out" || direction === "both") && fromD === level && toD === undefined) dist.set(e.to, level + 1);
            if ((direction === "in" || direction === "both") && toD === level && fromD === undefined) dist.set(e.from, level + 1);
          }
        }
        const reached = (id: string): number => dist.get(id) ?? Infinity;
        const expectedNodes = [...dist.entries()].filter(([, d]) => d <= depth).map(([id]) => id).sort(codeUnit);
        const expectedEdges = input.edges
          .filter((e) => (direction !== "in" && reached(e.from) <= depth - 1) || (direction !== "out" && reached(e.to) <= depth - 1))
          .map((e) => e.id)
          .sort(codeUnit);
        expect(result).toStrictEqual({ nodeIds: expectedNodes, edgeIds: expectedEdges });
        const deeper = graphNeighborhood(input, { node: focus, direction, depth: depth + 1 });
        expect(deeper.nodeIds).toEqual(expect.arrayContaining(result.nodeIds));
        expect(deeper.edgeIds).toEqual(expect.arrayContaining(result.edgeIds));
      }),
      { seed: 42, numRuns: 300 },
    );
  });
});
