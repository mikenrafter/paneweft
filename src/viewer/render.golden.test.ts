// @vitest-environment jsdom
// MC9: rendering is deterministic for a fixed document and viewport. The goldens in test/goldens/*.outline.txt
// were derived BY HAND from docs/viewer-dom-contract.md + docs/contract-additions/dom.md and the literal
// bundles in fixtures/goldens (nothing was produced by running an implementation; there is none). Reviewing a
// golden means re-deriving it from those two documents. Arithmetic for the graph layout is in the comments below.
//
// Scope: co-located with src/viewer. The viewer is mounted over createSessionSource(session) with freshness fixed
// to "fresh" (freshness has its own tests), 1024x768, locale en-US.
import { describe, expect, it } from "vitest";
import {
  SUBJECT, byId, click, fixedFresh, geometryOutline, goldenBundle, goldenGeometry, goldenOutline, ids, need, openBundle, ownText, qa, q, sourceRepoSetup, text, useViewerCleanup, viewerOutline,
  type MountSetup, type MountedViewer,
} from "../../test/helpers/dom-harness.ts";
import { outline } from "../../test/helpers/structure.ts";
import { patch } from "../../test/helpers/patch.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
useViewerCleanup();

interface GoldenCase { name: string; bundle: string; preferred: string; after?: (v: MountedViewer) => Promise<void> }
// Pinned by name on purpose: emptying this table must break the suite (test-quality 8).
const GOLDENS: GoldenCase[] = [
  { name: "list", bundle: "list", preferred: "d-list" },
  { name: "tree", bundle: "tree", preferred: "d-tree" },
  { name: "graph", bundle: "graph", preferred: "d-graph" },
  { name: "source", bundle: "source", preferred: "d-code", after: async (v) => { await click(v, byId(v.container, "annotation", "a1")); } },
  { name: "shape", bundle: "shape", preferred: "d-shape" },
  { name: "notebook", bundle: "notebook", preferred: "d-notebook" },
  { name: "example-notrun", bundle: "example-notrun", preferred: "d-example" },
  { name: "example-runs", bundle: "example-runs", preferred: "d-example" },
];
const FACT_SEL = ["row", "node", "graph-node", "graph-edge", "field", "block", "run", "assertion", "scenario", "fact"].map((n) => `[data-pw="${n}"]`).join(",");
const caseFor = (name: string): GoldenCase => GOLDENS.find((g) => g.name === name) as GoldenCase;

async function mountGolden(g: GoldenCase, overrides: { bundle?: unknown; viewport?: { width: number; height: number }; locale?: string } = {}): Promise<MountedViewer> {
  const setup: MountSetup = {
    decorate: fixedFresh,
    ...(g.name === "source" ? { repositories: sourceRepoSetup(tmp("repo")) } : {}),
    ...(overrides.viewport ? { viewport: overrides.viewport } : {}),
    ...(overrides.locale ? { locale: overrides.locale } : {}),
  };
  const v = await openBundle(tmp(g.name), overrides.bundle ?? goldenBundle(g.bundle), SUBJECT, g.preferred, setup);
  if (g.after) await g.after(v);
  return v;
}

describe("[MC9] structure goldens (hand-derived)", () => {
  // why: a reviewed structural golden is the only guard against the rendered DOM silently dropping an element the
  //      contract requires (badge, strip, label) or reordering rows. Each golden pins the whole pane of one component.
  // proves: CLAIM(MC9) design section 7 MC9; contract: viewer-dom-contract.md Shell/Facts/List + dom.md B,C,D
  it("[MC9] list: 5 rows, one group, sort size asc (numeric, so 1,234 is last), equal keys 5/5 tie-broken by id r2 < r3, all five provenances, no-target row", async () => {
    // derivation: sizes r1=7 r2=5 r3=5 r4=1234 r5=9 -> ascending numeric 5,5,7,9,1234 -> r2,r3 (tie by id), r1, r5, r4.
    // A string sort would give 1234 < 5 < 5 < 7 < 9, so the last line of the order is the trap.
    // r4 has neither entity nor anchor -> no-target and no actions-button (dom.md C). r5 cites two sources.
    const v = await mountGolden(caseFor("list"));
    expect(viewerOutline(v.container)).toBe(goldenOutline("list"));
  });
  // why: tree structure must show expanded, collapsed and not_loaded nodes distinctly and keep a repeated entity as two occurrences.
  // proves: CLAIM(MC9)
  it("[MC9] tree: expanded roots, collapsed engine, not_loaded queue with load-affordance, mcp.rs entity occurring twice (n-mcp, n-t-mcp)", async () => {
    // derivation: depth-0 nodes n-src and n-tests are expanded, deeper ones collapsed (dom.md D) -> rendered pre-order
    // n-src, n-mcp, n-engine (collapsed: n-tick and n-core absent), n-queue (not_loaded), n-tests, n-t-mcp = 6 of 8 nodes.
    const v = await mountGolden(caseFor("tree"));
    expect(viewerOutline(v.container)).toBe(goldenOutline("tree"));
  });
  // why: layout v1 is pinned (design 5: font, viewport and layout version in structure goldens); a cycle must stay visible.
  //      The svg root is role="group", not the contract's role="img" (dom.md D1: axe nested-interactive on focusable nodes).
  // proves: CLAIM(MC9)
  it("[MC9] graph with a cycle: layered layout/1 coordinates, edge paths and from-relation-to texts hand-computed", async () => {
    // Layout v1 (red-contract 6): nodeWidth 160, nodeHeight 40, gapX 80, gapY 24, margin 16.
    // SCCs: {a} {b,c} (b->c, c->b) {d} {e}; the self loop d->d does not create a second member.
    // Condensation edges: a->{b,c}, {b,c}->d, a->e. layer(a)=0; layer({b,c})=1+0=1; layer(e)=1+0=1; layer(d)=1+1=2.
    // Layer 1 groups ordered by smallest member id: {b,c} (b) before {e}: rows b=0, c=1, e=2. Layers 0 and 2 have row 0.
    //   x = 16 + layer*240 ; y = 16 + row*64:  a(16,16) b(256,16) c(256,80) e(256,144) d(496,16).
    //   width = 2*16 + 3*160 + 2*80 = 672 ; height = 2*16 + 3*40 + 2*24 = 200  -> "672 x 200".
    // Edge paths: forward (layer(from) < layer(to)): "M fx+160 fy+20 L tx ty+20".
    //   e1 a->b: M 176 36 L 256 36.   e4 b->d: M 416 36 L 496 36.   e5 a->e: M 176 36 L 256 164 (ty+20 = 144+20).
    // The coordinates and paths are NOT repeated in this component outline (S6): they are pinned once, by the geometry golden
    // `graph-layered.geometry.txt` below and by layout.test.ts. This outline pins the elements, ids, relations, provenance and evidence.
    const v = await mountGolden(caseFor("graph"));
    expect(viewerOutline(v.container)).toBe(goldenOutline("graph"));
  });
  // why: S6. Geometry is pinned ONCE, here, instead of in every component outline: layered layout/1 node positions and edge
  //      paths, covering the four path kinds (forward, same-layer downward, same-layer upward, self loop) in a 672 x 200 canvas.
  //      The previous golden put the self loop at x = 696 > 672 (outside the canvas) and repeated a point in the b/c routes;
  //      both are corrected here, by hand, from red-contract 6 (S6 amendment):
  //        nodes a(16,16) b(256,16) c(256,80) d(496,16) e(256,144)   [x = 16+240*layer, y = 16+64*row]
  //        e2 b->c downward: M 256 36 L 250 36 L 250 100 L 256 100     (fx, fy+20, fx-6, ty+20)
  //        e3 c->b upward:   M 256 100 L 244 100 L 244 36 L 256 36     (gutter fx-12)
  //        e6 d->d: fx=496 fy=16: M 596 56 L 596 68 L 556 68 L 556 56  (fx+100, fy+40, fy+52, fx+60) - max x 596 <= 672
  // proves: CLAIM(MC9) CLAIM(S6-containment)
  it("[S6] graph geometry golden: node positions and the four path kinds, the self loop inside the canvas", async () => {
    const v = await mountGolden(caseFor("graph"));
    expect(geometryOutline(v.container)).toBe(goldenGeometry("graph-layered"));
  });
  // why: an annotation click must highlight exactly its lines with file numbering from the stored excerpt.
  // proves: CLAIM(MC9) / CLAIM(MC6)
  it("[MC9] source: lines 10-12 keep file numbering and annotation a1 (lines 11-12) is highlighted, line 10 is not", async () => {
    // derivation: excerpt anchor lines [10,12]; annotation a1 lines [11,12] -> data-line 11 and 12 highlighted "true", 10 "false".
    // gitRev is null in the fixture -> source-origin reads "r no revision src/check.ts" (dom.md D).
    const v = await mountGolden(caseFor("source"));
    expect(viewerOutline(v.container)).toBe(goldenOutline("source"));
  });
  // why: absent, null and string "null" examples must stay distinct; a recursive ref must not expand.
  // proves: CLAIM(MC9)
  it("[MC9] shape: declared basis, required/optional/unknown presence, examples \"w-1\", null, \"null\", none, 3, false, recursive ref", async () => {
    // derivation: field-example is JSON.stringify of the scalar (strings quoted) or "no example" when absent (contract Shape).
    // f-parent has ref f-msg (path "msg") -> field-ref "ref: msg" and no children / toggle.
    const v = await mountGolden(caseFor("shape"));
    expect(viewerOutline(v.container)).toBe(goldenOutline("shape"));
  });
  // why: notebook blocks keep declared order, claim status is visible while collapsed, embedded view is collapsed with its completeness.
  // proves: CLAIM(MC9)
  it("[MC9] notebook: prose with sanitised markdown, collapsed embedded view, claim blocks supported/disputed/open all collapsed with visible status", async () => {
    // derivation: prose "**cancellation**" and the link render as inline markup whose text flattens to
    // "Why does cancellation preserve a result? See the docs."; every claim/view toggle is aria-expanded=false (dom.md D1) yet the claim shows claim-status.
    const v = await mountGolden(caseFor("notebook"));
    expect(viewerOutline(v.container)).toBe(goldenOutline("notebook"));
  });
  // why: an example with no runs says "not run" (design 2.7) instead of an empty table.
  // proves: CLAIM(MC9)
  it("[MC9] example without runs: not-run, rerun instruction, partial completeness naming the gap", async () => {
    const v = await mountGolden(caseFor("example-notrun"));
    expect(viewerOutline(v.container)).toBe(goldenOutline("example-notrun"));
  });
  // why: a passed run and a failed assertion must both be shown with their PASS/FAIL words, not colour.
  // proves: CLAIM(MC9)
  it("[MC9] example with runs: passed run (2 PASS) and failed run (1 FAIL) with result links, observed provenance on every part", async () => {
    // derivation: provenance totals = scenario read(1) + runs observed(2) + assertions observed(3) = read=1 observed=5.
    const v = await mountGolden(caseFor("example-runs"));
    expect(viewerOutline(v.container)).toBe(goldenOutline("example-runs"));
  });
});

describe("[MC9] determinism", () => {
  // why: a second mount of the same document must not differ (hidden counters, ids from Math.random, time).
  // proves: CLAIM(MC9)
  it("[MC9] mounting the same data twice yields identical outlines for all eight goldens", async () => {
    const mismatches: string[] = [];
    for (const g of GOLDENS) {
      const first = viewerOutline((await mountGolden(g)).container);
      const second = viewerOutline((await mountGolden(g)).container);
      if (first !== second) mismatches.push(g.name);
      expect(first.startsWith("viewer\n  pane-trail"), `${g.name} rendered no viewer`).toBe(true);
    }
    expect(mismatches).toEqual([]);
  });
  // why: design 5 "sort unordered inputs": nodes and edges are lookup tables, so their input order must not change the picture.
  // proves: CLAIM(MC9)
  it("[MC9] shuffling graph nodes and rotating edges in the input yields the identical graph outline (the golden)", async () => {
    const bundle = goldenBundle("graph");
    const data = bundle.views[0].data;
    data.nodes = [...data.nodes].reverse();
    data.edges = [...data.edges.slice(2), ...data.edges.slice(0, 2)];
    expect(data.nodes.map((n: any) => n.id)).toEqual(["e", "d", "c", "b", "a"]); // positive control: the shuffle really happened
    expect(data.edges.map((e: any) => e.id)).toEqual(["e3", "e4", "e5", "e6", "e1", "e2"]);
    const v = await mountGolden(caseFor("graph"), { bundle });
    expect(viewerOutline(v.container)).toBe(goldenOutline("graph"));
  });
  // why: equal sort keys are tie-broken by id, never by input position.
  // proves: CLAIM(MC9)
  it("[MC9] reversing the input row order of the list yields the golden (ties r2/r3 broken by id)", async () => {
    const bundle = goldenBundle("list");
    bundle.views[0].data.rows.reverse();
    expect(bundle.views[0].data.rows.map((r: any) => r.id)).toEqual(["r5", "r4", "r3", "r2", "r1"]);
    const v = await mountGolden(caseFor("list"), { bundle });
    expect(viewerOutline(v.container)).toBe(goldenOutline("list"));
  });
  // why: tree node and shape field arrays are lookup tables; display order comes from roots/children, not array order.
  // proves: CLAIM(MC9)
  it("[MC9] reversing the node array of the tree and the field array of the shape yields the goldens", async () => {
    const tree = goldenBundle("tree");
    tree.views[0].data.nodes.reverse();
    const treeViewer = await mountGolden(caseFor("tree"), { bundle: tree });
    expect(viewerOutline(treeViewer.container)).toBe(goldenOutline("tree"));
    const shape = goldenBundle("shape");
    shape.views[0].data.fields.reverse();
    const shapeViewer = await mountGolden(caseFor("shape"), { bundle: shape });
    expect(viewerOutline(shapeViewer.container)).toBe(goldenOutline("shape"));
  });
  // why: design 5 pins layout version and forbids time-dependent output; no timestamps may leak into the DOM.
  // proves: CLAIM(MC9)
  it("[MC9] the graph outline pins layout \"layout/1\" and no golden-mounted viewer prints a timestamp", async () => {
    const graph = viewerOutline((await mountGolden(caseFor("graph"))).container);
    expect(graph.split("\n").filter((l) => l.includes("data-layout-version"))).toEqual(['        layout-info data-layout="layered" data-layout-version="layout/1"']);
    const leaks: string[] = [];
    for (const g of GOLDENS) {
      const o = viewerOutline((await mountGolden(g)).container);
      if (/20\d\d-\d\d-\d\d|T\d\d:\d\d|\d\d:\d\d:\d\d|capturedAt|generatedAt/.test(o)) leaks.push(g.name);
    }
    expect(leaks).toEqual([]);
  });
  // why: the layout must not depend on the viewport (design 5 "viewport size pinned" means it is an input, not a hidden measurement).
  // proves: CLAIM(MC9)
  it("[MC9] the graph subtree is identical at viewport widths 1024 and 480", async () => {
    const wide = await mountGolden(caseFor("graph"), { viewport: { width: 1024, height: 768 } });
    const narrow = await mountGolden(caseFor("graph"), { viewport: { width: 480, height: 800 } });
    const wideOutline = outline(need(wide.container, "graph"));
    expect(wideOutline).toContain("graph-node");
    expect(outline(need(narrow.container, "graph"))).toBe(wideOutline);
  });
  // why: the locale is a mount input; numbers format by it (design 7 MC9 "pin locale").
  // proves: CLAIM(MC9)
  it("[MC9] locale en-US renders 1,234 and de-DE renders 1.234 for the same cell", async () => {
    const us = await mountGolden(caseFor("list"), { locale: "en-US" });
    const de = await mountGolden(caseFor("list"), { locale: "de-DE" });
    const sizeOf = (v: MountedViewer) => text(qa(byId(v.container, "row", "r4"), "cell").find((c) => c.getAttribute("data-id") === "size"));
    expect(sizeOf(us)).toBe("1,234");
    expect(sizeOf(de)).toBe("1.234");
  });
  // why: the grid layout is the second fixed layout; its coordinates are hand-computed too.
  // proves: CLAIM(MC9)
  it("[MC9] grid layout of the same graph: 5 nodes -> 3 columns, positions and centre-to-centre edge paths hand-computed", async () => {
    // derivation (red-contract 6 Grid): nodes by id a,b,c,d,e; n=5, cols=ceil(sqrt(5))=3; i -> col=i%3, row=floor(i/3):
    //   a(0,0) b(1,0) c(2,0) d(0,1) e(1,1).  x = 16+col*240, y = 16+row*64:
    //   a(16,16) b(256,16) c(496,16) d(16,80) e(256,80).  width = 32+3*160+2*80 = 672 ; height = 32+2*40+1*24 = 136.
    // centres = (x+80, y+20): a(96,36) b(336,36) c(576,36) d(96,100) e(336,100).
    //   e1 a->b M 96 36 L 336 36 ; e2 b->c M 336 36 L 576 36 ; e3 c->b M 576 36 L 336 36 ;
    //   e4 b->d M 336 36 L 96 100 ; e5 a->e M 96 36 L 336 100.  (e6 is a zero-length self edge in grid; not pinned here.)
    const bundle = patch(goldenBundle("graph"), { op: "replace", path: "/views/0/data/layout", value: "grid" });
    const v = await mountGolden(caseFor("graph"), { bundle });
    const info = need(v.container, "layout-info");
    expect([info.getAttribute("data-layout"), info.getAttribute("data-layout-version"), text(info)]).toEqual(["grid", "layout/1", "672 x 136"]);
    const positions = Object.fromEntries(qa(v.container, "graph-node").map((n) => [n.getAttribute("data-id"), [n.getAttribute("data-x"), n.getAttribute("data-y")]]));
    expect(positions).toEqual({ a: ["16", "16"], b: ["256", "16"], c: ["496", "16"], d: ["16", "80"], e: ["256", "80"] });
    const path = (id: string) => need(byId(v.container, "graph-edge", id), "edge-path").getAttribute("d");
    expect(["e1", "e2", "e3", "e4", "e5"].map(path)).toEqual([
      "M 96 36 L 336 36", "M 336 36 L 576 36", "M 576 36 L 336 36", "M 336 36 L 96 100", "M 96 36 L 336 100",
    ]);
  });
});

describe("[MC9] targeted mutation-sensitivity (the build-loop list)", () => {
  // why: "delete a provenance badge" must fail a test: every fact of every component has exactly one own badge whose
  //      word equals the input provenance of that item (expected map comes from the fixture literal, not from the viewer).
  // proves: CLAIM(MC9) / CLAIM(MC5)
  it("[MC9] every fact of every golden has exactly one provenance-badge matching its input provenance", async () => {
    const tables: Array<{ golden: string; fact: string; expectedFacts: number; provenance: Record<string, string> }> = [
      { golden: "list", fact: "row", expectedFacts: 5, provenance: { r1: "read", r2: "compiled", r3: "inferred", r4: "observed", r5: "parsed" } },
      { golden: "tree", fact: "node", expectedFacts: 6, provenance: { "n-src": "read", "n-mcp": "compiled", "n-engine": "parsed", "n-queue": "observed", "n-tests": "read", "n-t-mcp": "read" } },
      { golden: "graph", fact: "graph-node", expectedFacts: 5, provenance: { a: "read", b: "read", c: "parsed", d: "observed", e: "compiled" } },
      { golden: "graph", fact: "graph-edge", expectedFacts: 6, provenance: { e1: "read", e2: "read", e3: "inferred", e4: "observed", e5: "compiled", e6: "parsed" } },
      { golden: "shape", fact: "field", expectedFacts: 7, provenance: { "f-msg": "read", "f-id": "read", "f-note": "compiled", "f-tag": "inferred", "f-parent": "read", "f-count": "compiled", "f-flag": "parsed" } },
      { golden: "notebook", fact: "block", expectedFacts: 5, provenance: { "b-intro": "read", "b-view": "parsed", "b-c1": "read", "b-c2": "inferred", "b-c3": "observed" } },
      { golden: "source", fact: "fact", expectedFacts: 3, provenance: { x: "read", a1: "read", a2: "compiled" } },
      { golden: "example-runs", fact: "assertion", expectedFacts: 3, provenance: { as1: "observed", as2: "observed", as3: "observed" } },
      { golden: "example-runs", fact: "run", expectedFacts: 2, provenance: { r1: "observed", r2: "observed" } },
    ];
    const problems: string[] = [];
    for (const t of tables) {
      const v = await mountGolden(caseFor(t.golden));
      const facts = qa(v.container, t.fact);
      if (facts.length !== t.expectedFacts) problems.push(`${t.golden}/${t.fact}: ${facts.length} facts, expected ${t.expectedFacts}`);
      for (const fact of facts) {
        const id = fact.getAttribute("data-id") ?? "?";
        // own badges: those whose nearest enclosing fact-like element is this one (a run contains assertions with their own badges)
        const own = qa(fact, "provenance-badge").filter((b) => b.parentElement?.closest(FACT_SEL) === fact);
        const expected = t.provenance[id];
        if (own.length !== 1) problems.push(`${t.golden}/${id}: ${own.length} own badges`);
        else if (own[0]!.getAttribute("data-provenance") !== expected || text(own[0]) !== expected) problems.push(`${t.golden}/${id}: badge ${own[0]!.getAttribute("data-provenance")}/${text(own[0])}, expected ${expected}`);
      }
    }
    expect(problems).toEqual([]);
  });
  // why: "reverse an edge" must fail a test: a reversed edge draws from the target and prints the wrong arrow text.
  // proves: CLAIM(MC9)
  it("[MC9] edges point from -> to: paths start at the source node's right side and end at the target's left side; item text reads from -relation-> to", async () => {
    // expected endpoints from the node positions in the golden derivation: forward edges leave (fx+160, fy+20) and arrive (tx, ty+20).
    const v = await mountGolden(caseFor("graph"));
    const path = (id: string) => need(byId(v.container, "graph-edge", id), "edge-path").getAttribute("d");
    expect(path("e1")).toBe("M 176 36 L 256 36");   // a(16,16) -> b(256,16)
    expect(path("e4")).toBe("M 416 36 L 496 36");   // b(256,16) -> d(496,16)
    expect(path("e5")).toBe("M 176 36 L 256 164");  // a(16,16) -> e(256,144)
    expect(path("e1")).not.toBe("M 256 36 L 176 36"); // the reversed spelling of e1
    // the back edge c->b (e3) and its twin b->c (e2) are different paths: the viewer must not swap them
    expect(path("e2")).not.toBe(path("e3"));
    const item = (id: string) => ownText(byId(v.container, "graph-edge-item", id));
    expect([item("e1"), item("e2"), item("e3"), item("e4"), item("e5"), item("e6")]).toEqual([
      "a -invokes-> b", "b -calls-> c", "c -calls-> b", "b -writes-> d", "a -logs-> e", "d -retries-> d",
    ]);
    expect(text(need(byId(v.container, "graph-edge", "e3"), "edge-label"))).toBe("calls");
  });
  // why: "break a link" must fail a test: an evidence link without data-source cannot be followed.
  // proves: CLAIM(MC9) / CLAIM(MC5)
  it("[MC9] every evidence-link has a data-source equal to its text, and each fact lists exactly its input evidence ids in order", async () => {
    // expected: the evidence arrays of the fixture literals (list rows r1..r5; example scenario/runs/assertions): 7 links in list, 6 in example-runs.
    const tables: Array<{ golden: string; totalLinks: number; byItem: Record<string, string[]> }> = [
      { golden: "list", totalLinks: 7, byItem: { r1: ["s1"], r2: ["s1", "tc"], r3: ["s1"], r4: ["s2"], r5: ["s1", "s2"] } }, // r2 is compiled: it cites the tool source tc (S4)
      { golden: "example-runs", totalLinks: 6, byItem: { r1: ["s2"], r2: ["s3"], as1: ["s2"], as2: ["s2"], as3: ["s3"], scenario: ["s1"] } },
    ];
    const problems: string[] = [];
    for (const t of tables) {
      const v = await mountGolden(caseFor(t.golden));
      const links = qa(v.container, "evidence-link");
      if (links.length !== t.totalLinks) problems.push(`${t.golden}: ${links.length} links, expected ${t.totalLinks}`);
      for (const link of links) if (!link.getAttribute("data-source") || link.getAttribute("data-source") !== text(link)) problems.push(`${t.golden}: link ${text(link)} has data-source ${link.getAttribute("data-source")}`);
      for (const fact of v.container.querySelectorAll<HTMLElement>(FACT_SEL)) {
        const id = fact.getAttribute("data-pw") === "scenario" ? "scenario" : (fact.getAttribute("data-id") ?? "?");
        const own = qa(fact, "evidence-link").filter((l) => l.parentElement?.closest(FACT_SEL) === fact).map((l) => l.getAttribute("data-source"));
        if (JSON.stringify(own) !== JSON.stringify(t.byItem[id])) problems.push(`${t.golden}/${id}: links ${JSON.stringify(own)}, expected ${JSON.stringify(t.byItem[id])}`);
      }
    }
    expect(problems).toEqual([]);
  });
  // why: "drop omitted counts" must fail a test: hidden (collapsed) nodes are still part of total and matched.
  // proves: CLAIM(MC9) / CLAIM(MC19)
  it("[MC9] the tree renders 6 of its 8 nodes but match-count states 8 of 8: hidden descendants stay counted", async () => {
    const v = await mountGolden(caseFor("tree"));
    expect(qa(v.container, "node")).toHaveLength(6);
    const count = need(v.container, "match-count");
    expect([count.getAttribute("data-matched"), count.getAttribute("data-total"), text(count)]).toEqual(["8", "8", "8 of 8 match"]);
    expect(ids(qa(v.container, "node"))).not.toContain("n-tick");
    expect(q(v.container, "empty-state")).toBeNull();
  });
});
