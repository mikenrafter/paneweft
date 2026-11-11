// why: the demo red tests (test/demos.test.ts) are only fair if the three committed demo bundles are
// valid against the canonical schemas, carry the design's literal hashes and revisions, and satisfy the
// cheap semantic rules of docs/red-contract.md section 2. This suite checks that with RAW Ajv and an
// independent checker in test/helpers/demo-fixtures.ts, never with src/core (still a stub), so a fixture
// that no implementation could accept is caught here, not in the green phase.
// scope: scaffold self-check. GREEN by design; counted separately in the red report and must stay green.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSchemaRegistry } from "../../src/schemas/index.ts";
import { sha256Hex } from "../helpers/hash.ts";
import { REPO_ROOT } from "../helpers/fixtures.ts";
import { patch } from "../helpers/patch.ts";
import {
  DEMO_EXPECT, DEMO_VIEWS, RESIDUAL_SNAPSHOT, STORY_SNAPSHOT, STORY_VIEW_ID, VIGIL_SNAPSHOT,
  bundleOf, checkBundleSemantics, itemsOfView, outsideViewsOf, residualBundle, storyBundle, viewOf, vigilBundle,
  type AnyJson,
} from "../helpers/demo-fixtures.ts";

const bundleSchemaId = "urn:paneweft:schema:bundle:1";
const ajv = createSchemaRegistry();
const validateBundle = ajv.getSchema(bundleSchemaId)!;
const allBundles = () => [vigilBundle(), residualBundle(), storyBundle()];
const known = () => outsideViewsOf(allBundles());

// Literal copy of docs/design.md section 6, "Selected input hashes" (lines 518-522) and the residual table (lines 538-540).
const DESIGN_HASHES: Record<string, string> = {
  "src/watch.rs": "62f0229b71d3984a5187787780f9a2b26bfc592277281c8ed02b66802e451742", // design.md line 518
  "src/engine.rs": "79cf0ad0ec83d68638a8ce414bde91375b3e11b93d40e79b00dc1086079e65ca", // line 519
  "src/tick.rs": "4355040b691eabbf6cbb367f69c1e583701dc5b8b41a421ffba7782fd48f6857", // line 520
  "src/mcp.rs": "1f627598551a007472cacecb61f4a649b8f60bb089ed16f67ce6f1145d415c25", // line 521
  "tests/mcp_e2e.rs": "1d0cd2cd40f8e156b3f0b9333c6d6c403b52400be5b17fd288a5d276b0c67e1f", // line 522
  "web/src/nkp-landscape.ts": "6eeb5997136297df81c28a9dfec1a4005a8d5560d61e5d0b914015d44523a9df", // line 538
  "web/src/landscape-selection.ts": "38418e62f565f9f32020068263e5344cb9759a39c17523d6832198f5933e0795", // line 539
  "web/src/nkp-landscape.test.ts": "d1f9db2be5dffa209793da697ea7c971f4ed07d90a1ab9a15c3ce57f0d5ecd8b", // line 540
};
// Revisions: design.md section 6 intro (line ~500) and `git -C <repo> rev-parse HEAD` at fixture-writing time.
const VIGIL_REV = "d064373a15139b969599ee05bc7b156b1d5b8ed7";
const RESIDUAL_REV = "32c0836283dad8c22431b3025ec910b4b5759e90";
const PANEWEFT_DESIGN_REV = "2765c525907bda1a95bcc5ecf03a1bf4a93bc7a7"; // `git rev-list -1 HEAD -- docs/design.md`
// `wc -l` of the inspected bytes: an anchor can never point past the end of its file.
const LINE_COUNTS: Record<string, number> = {
  "src/watch.rs": 1349, "src/engine.rs": 1039, "src/tick.rs": 1689, "src/mcp.rs": 435, "tests/mcp_e2e.rs": 729,
  "web/src/nkp-landscape.ts": 379, "web/src/landscape-selection.ts": 351, "web/src/nkp-landscape.test.ts": 409,
};
// Which inspected files each view uses (and therefore exactly what its freshness.files must hold).
const FILES_USED: Record<string, string[]> = {
  "vigil-lifecycle": ["src/watch.rs", "src/engine.rs", "src/tick.rs"],
  "vigil-delivery-path": ["src/mcp.rs"],
  "vigil-one-write": ["tests/mcp_e2e.rs"],
  "vigil-cancel-guard": ["src/mcp.rs"],
  "residual-view-entrypoints": ["web/src/nkp-landscape.ts"],
  "residual-selection-shape": ["web/src/nkp-landscape.ts", "web/src/landscape-selection.ts"],
  "residual-selection-switch": ["web/src/nkp-landscape.test.ts"],
  "residual-key-union": ["web/src/landscape-selection.ts"],
  [STORY_VIEW_ID]: ["src/mcp.rs", "tests/mcp_e2e.rs", "web/src/nkp-landscape.test.ts", "docs/design.md"],
};
describe("scaffold demos: the committed bundles are valid against the raw schemas", () => {
  for (const name of ["vigil", "residual", "story"] as const) {
    it(`${name}.bundle.json validates against paneweft.bundle/1`, () => {
      const bundle = bundleOf(DEMO_VIEWS.find((v) => v.bundle === name)!);
      expect(validateBundle(bundle), JSON.stringify(validateBundle.errors)).toBe(true);
    });
  }
  it("the nine demo views exist, each in its bundle, in the pinned order", () => {
    expect(vigilBundle().views.map((v: AnyJson) => v.id)).toEqual(["vigil-lifecycle", "vigil-delivery-path", "vigil-one-write", "vigil-cancel-guard"]);
    expect(residualBundle().views.map((v: AnyJson) => v.id)).toEqual(["residual-view-entrypoints", "residual-selection-shape", "residual-selection-switch", "residual-key-union"]);
    expect(storyBundle().views.map((v: AnyJson) => v.id)).toEqual([STORY_VIEW_ID]);
    expect(DEMO_VIEWS).toHaveLength(9);
  });
  it("snapshot ids: the vigil views share one snapshot, the residual views another, the story its own", () => {
    expect(viewOf({ id: STORY_VIEW_ID }).snapshotId).toBe(STORY_SNAPSHOT);
    expect(vigilBundle().views.every((v: AnyJson) => v.snapshotId === VIGIL_SNAPSHOT)).toBe(true);
    expect(residualBundle().views.every((v: AnyJson) => v.snapshotId === RESIDUAL_SNAPSHOT)).toBe(true);
  });
});

describe("scaffold demos: hashes and revisions equal the design's literals", () => {
  it("the literal table is a faithful copy of docs/design.md (every hash occurs in the design text)", () => {
    const design = readFileSync(join(REPO_ROOT, "docs", "design.md"), "utf8");
    for (const [path, hash] of Object.entries(DESIGN_HASHES)) expect(design, path).toContain(hash);
  });
  for (const [viewId, files] of Object.entries(FILES_USED)) {
    it(`${viewId}: freshness.files holds exactly ${files.length} file(s) used by the view, with the design's hashes`, () => {
      const view = viewOf({ id: viewId });
      const recorded: Record<string, string> = Object.assign({}, ...view.freshness.repositories.map((r: AnyJson) => r.files));
      expect(Object.keys(recorded).sort()).toEqual([...files].sort());
      for (const [path, hash] of Object.entries(recorded)) {
        if (path === "docs/design.md") continue; // the design note's own hash is pinned in the next test
        expect(hash, path).toBe(DESIGN_HASHES[path]);
      }
    });
  }
  it("the story's sd source is docs/design.md with the sha256 of the bytes in this checkout", () => {
    // Bump procedure: if docs/design.md is edited, recompute `sha256sum docs/design.md` and replace the value in
    // fixtures/demos/story.bundle.json (sources[sd].sha256 and freshness paneweft files) and in README.md.
    const story = viewOf({ id: STORY_VIEW_ID });
    const sd = story.sources.find((s: AnyJson) => s.id === "sd");
    expect(sd).toMatchObject({ kind: "document", repository: "paneweft", path: "docs/design.md" });
    expect(sd.sha256).toBe(sha256Hex(readFileSync(join(REPO_ROOT, "docs", "design.md"))));
  });
  it("repository revisions equal the design's pinned revisions, and no repository is dirty", () => {
    const revs = new Map<string, string | null>();
    for (const view of allBundles().flatMap((b) => b.views as AnyJson[])) {
      for (const repo of view.freshness.repositories as AnyJson[]) {
        expect(repo.dirty, `${view.id}/${repo.id}`).toBe(false);
        revs.set(`${view.id}/${repo.id}`, repo.gitRev);
      }
    }
    for (const [key, rev] of revs) {
      const repo = key.split("/")[1];
      expect(rev, key).toBe(repo === "vigil" ? VIGIL_REV : repo === "residual-web" ? RESIDUAL_REV : PANEWEFT_DESIGN_REV);
    }
    expect(new Set(revs.keys()).size).toBe(9 + 2); // nine views; the story names two more repositories
  });
  it("every source's sha256 equals the design's hash for its path (document source excluded)", () => {
    for (const view of allBundles().flatMap((b) => b.views as AnyJson[])) {
      for (const source of view.sources as AnyJson[]) {
        if (source.kind === "document") continue;
        expect(source.sha256, `${view.id}/${source.id}`).toBe(DESIGN_HASHES[source.path]);
      }
    }
  });
  it("no anchor points past the end of the inspected file", () => {
    for (const view of allBundles().flatMap((b) => b.views as AnyJson[])) {
      for (const item of itemsOfView(view)) {
        if (!item.anchor) continue;
        expect(item.anchor.lines[1], `${view.id}/${item.id}`).toBeLessThanOrEqual(LINE_COUNTS[item.anchor.path]!);
      }
    }
  });
});

describe("scaffold demos: every item is source-inspected and cites existing evidence", () => {
  for (const view of DEMO_VIEWS) {
    it(`${view.id}: ${DEMO_EXPECT[view.id]!.items} items, all provenance read, each evidence id is a source of the envelope`, () => {
      const envelope = viewOf(view);
      const items = itemsOfView(envelope);
      expect(items).toHaveLength(DEMO_EXPECT[view.id]!.items!);
      const sourceIds = new Set(envelope.sources.map((s: AnyJson) => s.id));
      for (const item of items) {
        expect(item.provenance, item.id).toBe("read");
        expect(item.evidence.length, item.id).toBeGreaterThan(0);
        for (const id of item.evidence) expect(sourceIds.has(id), `${item.id} cites ${id}`).toBe(true);
      }
    });
  }
});

describe("scaffold demos: independent semantic checker (cheap rules of red-contract section 2)", () => {
  it("accepts all three bundles with every demo view known", () => {
    for (const bundle of allBundles()) expect(checkBundleSemantics(bundle, known())).toEqual([]);
  });
  it("the story bundle alone has dangling viewIds (it imports after the other two by design)", () => {
    const aloneProblems = checkBundleSemantics(storyBundle(), outsideViewsOf([storyBundle()]));
    const dangling = aloneProblems.filter((p) => /blocks\/\d+\/viewId: unknown view/.test(p));
    expect(dangling.map((p) => p.split(":")[0])).toEqual([1, 2, 3, 5, 6, 7].map((i) => `/views/0/data/blocks/${i}/viewId`));
  });
  // negative controls: the checker must notice each fault, otherwise "[] problems" above proves nothing
  it("detects a duplicate id", () => {
    const bad = patch(vigilBundle(), { op: "replace", path: "/views/0/data/edges/0/id", value: "n-pending" });
    expect(checkBundleSemantics(bad, known()).some((p) => p.includes("duplicate id n-pending"))).toBe(true);
  });
  it("detects a dangling evidence id", () => {
    const bad = patch(vigilBundle(), { op: "replace", path: "/views/0/data/edges/2/evidence/0", value: "s-nope" });
    expect(checkBundleSemantics(bad, known())).toContain("/views/0/item/6(e-tick-over-budget)/evidence/0: unknown source s-nope");
  });
  it("detects a dangling edge endpoint and a discontinuous path", () => {
    const endpoint = patch(vigilBundle(), { op: "replace", path: "/views/1/data/edges/1/to", value: "n-ghost" });
    expect(checkBundleSemantics(endpoint, known())).toEqual(["/views/1/data/edges/1/to: unknown node n-ghost"]);
    const path = patch(vigilBundle(), { op: "replace", path: "/views/1/data/paths/0/edgeIds/4", value: "e-none-cancelled" });
    expect(checkBundleSemantics(path, known())).toEqual(["/views/1/data/paths/0/edgeIds/4: starts at n-return-none, previous ended at n-commit"]);
  });
  it("detects an annotation outside the excerpt and a source file missing from freshness", () => {
    const outside = patch(vigilBundle(), { op: "replace", path: "/views/3/data/annotations/0/lines", value: [150, 160] });
    expect(checkBundleSemantics(outside, known())).toEqual(["/views/3/data/annotations/0/lines: outside excerpt 155-185"]);
    const noHash = patch(vigilBundle(), { op: "remove", path: "/views/3/freshness/repositories/0/files/src~1mcp.rs" });
    expect(checkBundleSemantics(noHash, known()).length).toBeGreaterThan(0);
  });
  it("detects a notebook claim that supports a source id the envelope does not register", () => {
    const bad = patch(storyBundle(), { op: "replace", path: "/views/0/data/blocks/4/supports/0", value: "sx" });
    expect(checkBundleSemantics(bad, known())).toEqual(["/views/0/data/blocks/4/supports/0: unknown source sx"]);
  });
  it("detects a link into a view with the wrong snapshot or a missing item", () => {
    const wrongSnapshot = patch(storyBundle(), { op: "replace", path: "/views/0/links/1/snapshotId", value: "vigil-d064374" });
    expect(checkBundleSemantics(wrongSnapshot, known())).toHaveLength(1);
    const missingItem = patch(vigilBundle(), { op: "replace", path: "/views/1/links/0/itemId", value: "a-ghost" });
    expect(checkBundleSemantics(missingItem, known())).toHaveLength(1);
  });
});

describe("scaffold demos: facts the red tests rely on", () => {
  // why: the design overstates residual's tests and cites the wrong file for vigil's example.
  // These independent literals pin the corrected evidence without requiring sibling repos on Boat.
  // proves: CLAIM(round2-demo-evidence)
  it("round 2: separate residual cases assert sidebar text; vigil example blocks cite the e2e file", () => {
    const scenario = viewOf({ id: "residual-selection-switch" }).data.scenario;
    expect(scenario.parameters).toEqual({ testRunner: "bun:test", leaf: "auth", viewSequence: "bundle,heatmap,regions", filterToggle: "data-hide-filtered-graph-toggle", separateCases: true, assertion: "sidebar text contains auth" });
    const story = viewOf({ id: STORY_VIEW_ID });
    const blocks = story.data.blocks as AnyJson[];
    expect(blocks.find((b) => b.id === "D2")).toMatchObject({ statement: "The tests check that the sidebar still contains auth after switching to heatmap and regions, and in a separate test after enabling hide-filtered." });
    for (const id of ["v3", "ex1"]) expect(blocks.find((b) => b.id === id)).toMatchObject({ evidence: ["sv-e2e"] });
    expect(story.sources.find((s: AnyJson) => s.id === "sv-e2e")).toMatchObject({ kind: "file", repository: "vigil", path: "tests/mcp_e2e.rs", sha256: "1d0cd2cd40f8e156b3f0b9333c6d6c403b52400be5b17fd288a5d276b0c67e1f" });
    const entry = viewOf({ id: "residual-view-entrypoints" });
    expect(entry.data.rows.map((r: AnyJson) => r.anchor.lines)).toEqual([[245, 246], [247, 248], [249, 255]]);
    const cancelled = viewOf({ id: "vigil-delivery-path" }).data.nodes.find((n: AnyJson) => n.id === "n-cancelled-result");
    expect(cancelled.label).toBe('cancelled_result(): the tool replies with the text "cancelled" flagged as an error (src/mcp.rs:188-190)');
  });
  it("the two example views have runs [] and name the missing observed run as their first gap", () => {
    for (const id of ["vigil-one-write", "residual-selection-switch"]) {
      const view = viewOf({ id });
      expect(view.data.runs, id).toEqual([]);
      expect(view.completeness.status, id).toBe("partial");
      expect(view.completeness.gaps[0].id, id).toBe("observed-run-missing");
      expect(view.completeness.gaps[0].reason.startsWith("Not run:"), id).toBe(true);
    }
  });
  it("runner ids and scenario entity kinds follow design section 6", () => {
    const v = viewOf({ id: "vigil-one-write" }).data.scenario;
    expect(v).toMatchObject({ runnerId: "vigil-one-write", entity: { repository: "vigil", id: "one-write", kind: "vigil/watch" } });
    expect(v.anchor).toEqual({ repository: "vigil", path: "tests/mcp_e2e.rs", lines: [112, 156] });
    const r = viewOf({ id: "residual-selection-switch" }).data.scenario;
    expect(r).toMatchObject({ runnerId: "residual-selection-switch", entity: { repository: "residual-web", id: "selection-switch", kind: "residual/selection" } });
    expect(r.anchor).toEqual({ repository: "residual-web", path: "web/src/nkp-landscape.test.ts", lines: [336, 364] });
  });
  it("the lifecycle graph anchors the design's four lines, and its gaps are the three the design names", () => {
    const lifecycle = viewOf({ id: "vigil-lifecycle" });
    const anchored = (path: string) => itemsOfView(lifecycle).filter((i) => i.anchor?.path === path).map((i) => i.anchor.lines[0]);
    expect(anchored("src/watch.rs")).toContain(414); // WatchStatus variants; the enum itself is line 413
    expect(anchored("src/engine.rs")).toContain(290); // cancel body; fn cancel is line 280
    expect(anchored("src/tick.rs")).toEqual(expect.arrayContaining([132, 178]));
    expect(lifecycle.completeness.gaps.map((g: AnyJson) => g.id)).toEqual(["firing-rules", "attention-events", "recovery"]);
  });
  it("the delivery graph covers mcp.rs:127-185 and its gaps are transport bookkeeping and async trace", () => {
    const delivery = viewOf({ id: "vigil-delivery-path" });
    const lines = itemsOfView(delivery).filter((i) => i.anchor).flatMap((i) => i.anchor.lines as number[]);
    expect(Math.min(...lines)).toBeLessThanOrEqual(127);
    expect(lines).toContain(185);
    expect(delivery.completeness.gaps.map((g: AnyJson) => g.id)).toEqual(["delivery-bookkeeping", "async-trace"]);
  });
  it("the residual views declare the narrow complete criteria (design section 6: choose the narrower criterion)", () => {
    expect(viewOf({ id: "residual-view-entrypoints" }).completeness.criterion).toContain("three declared LandscapeView choices");
    expect(viewOf({ id: "residual-selection-shape" }).completeness.criterion).toContain("three variants of the EntityKey union");
    expect(viewOf({ id: "residual-selection-shape" }).scope.limits.join(" ")).toContain("every renderer and every filter");
  });
  it("the story keeps the design's ten blocks in order, then ex1 and ex2 (the documented addition)", () => {
    const blocks = viewOf({ id: STORY_VIEW_ID }).data.blocks as AnyJson[];
    expect(blocks.map((b) => b.id)).toEqual(["intro", "v1", "v2", "v3", "D1", "r1", "r2", "r3", "D2", "D3", "ex1", "ex2"]);
    expect(blocks.filter((b) => b.kind === "claim").map((b) => [b.id, b.status, b.supports, b.evidence])).toEqual([
      ["D1", "supported", ["sv"], ["sv"]],
      ["D2", "supported", ["sr"], ["sr"]],
      ["D3", "open", [], ["sd"]],
    ]);
  });
  it("each demo view serializes far below the 2 MiB per-view limit, and the graphs far below 200 nodes / 500 edges", () => {
    for (const view of allBundles().flatMap((b) => b.views as AnyJson[])) {
      expect(Buffer.byteLength(JSON.stringify(view)), view.id).toBeLessThan(64 * 1024);
      expect(itemsOfView(view).length, view.id).toBeLessThan(100); // limit: 10,000 fact items per view (design 4)
    }
    for (const id of ["vigil-lifecycle", "vigil-delivery-path"]) {
      expect(viewOf({ id }).data.nodes.length, id).toBeLessThanOrEqual(20); // limit 200
      expect(viewOf({ id }).data.edges.length, id).toBeLessThanOrEqual(50); // limit 500
    }
  });
  it("the hand-written reply expectations match the fixtures (completeness header line, primary-collection total, sources)", () => {
    // oracle: the header format of red-contract section 3, applied to the fixture by the test itself
    const headerLine = (c: AnyJson): string =>
      c.status === "complete"
        ? `completeness: complete (${c.criterion})`
        : `completeness: partial (${c.gaps.length} gaps; first: ${c.gaps[0].id}: ${c.gaps[0].question})`;
    const total = (view: AnyJson): number =>
      view.component === "graph" ? view.data.edges.length
        : view.component === "list" ? view.data.rows.length
        : view.component === "shape" ? view.data.fields.length
        : view.component === "source" ? view.data.excerpt.text.split("\n").length
        : view.component === "notebook" ? view.data.blocks.length
        : view.data.runs.length;
    for (const demo of DEMO_VIEWS) {
      const view = viewOf(demo);
      const expected = DEMO_EXPECT[demo.id]!;
      expect(headerLine(view.completeness), demo.id).toBe(expected.completeness);
      expect(total(view), demo.id).toBe(expected.total);
      expect(view.sources.map((s: AnyJson) => s.id).sort(), demo.id).toEqual([...expected.sources].sort());
    }
  });
  it("bundleOf maps every demo view to the bundle that holds it", () => {
    for (const view of DEMO_VIEWS) expect(bundleOf(view).views.some((v: AnyJson) => v.id === view.id), view.id).toBe(true);
  });
});
