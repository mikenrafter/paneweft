// why: per-component reply shape of inspect_view (design 4 "Replies report total, matched, returned, omitted ...",
// design 2 text policy per component: list/tree/graph/source/shape/notebook/example) and the summary side of
// CLAIM(MC14) notebook embedDepth. Formats not fixed by red-contract 3 (tree tokens, source line grammar, example
// run lines, shape/basis lines) are the proposals in docs/contract-additions/ops.md section 4 and are cited in the
// tests that use them. All expected text is hand-derived from those rules, never produced by running code.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { issuesOf, okJson, okText, textPages, useOps } from "../../test/helpers/ops-env.ts";
import { describeSequenceDifference } from "../../test/helpers/ops-oracle.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import {
  bundleOf, claimBlock, complete, edge, entityAt, exampleView, graphView, item, listView, node, notebookView,
  partial, proseBlock, shapeField, shapeView, sourceView, treeNode, treeView, viewBlock, wideListView, withFreshnessRoot, type Json,
} from "../../test/helpers/ops-views.ts";

const open = useOps();
const tempDir = useTempDirs();
const ARGS = (viewId: string) => ({ viewId, snapshotId: "snap-1" });

describe("[MC3] list: reviewed golden of the whole text and JSON reply", () => {
  // why: pins the exact mandatory header (red-contract 3 order and wording) and design 4's example row line
  // `mcp.rs -> code/module:mcp; read; s1` for the committed list fixture. Hand-derived: 1 row, complete, the
  // source file is present with its recorded bytes (the test writes "hello\n", sha256 5891b5b5...be03) so freshness is fresh.
  // proves: CLAIM(MC3) header and body of a bounded list reply; no header line is dropped or reordered.
  // S1: freshness reads only operator-registered roots, so the operator registers the root the view records (setup only; the expected
  // output is unchanged: the file is present with its recorded bytes, hence `fresh`).
  const openFresh = async () => {
    const root = tempDir("golden");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "mcp.rs"), "hello\n");
    const env = await open(bundleOf([withFreshnessRoot(listView(), root)]));
    await env.session.registerRepository({ id: "r", root });
    return env;
  };
  it("[MC3] text golden", async () => {
    const env = await openFresh();
    const outcome = await env.call("inspect_view", ARGS("modules"));
    expect(outcome.body.trimEnd().split("\n")).toEqual([
      "paneweft.reply/1 view=modules component=list",
      "question: What is in this set, and which members matter?",
      "snapshot: snap-1",
      "completeness: complete (all modules in the fixture)",
      "freshness: fresh",
      "provenance: read=1 parsed=0 compiled=0 observed=0 inferred=0",
      "evidence: sources=s1",
      "filters: none",
      "order: name asc",
      "counts: unit=rows total=1 matched=1 returned=1 omitted=0 truncated=false",
      "1/1 matched rows returned; 0 omitted",
      "mcp.rs -> code/module:mcp; read; s1",
    ]);
  });
  it("[MC3] JSON golden (fields of urn:paneweft:schema:reply:1; item = the stored row)", async () => {
    const env = await openFresh();
    const reply = okJson(await env.call("inspect_view", { ...ARGS("modules"), format: "json" }));
    expect(reply).toMatchObject({
      schemaVersion: "paneweft.reply/1",
      view: { id: "modules", title: "Modules", component: "list", snapshotId: "snap-1" },
      question: "What is in this set, and which members matter?",
      completeness: { status: "complete", criterion: "all modules in the fixture" },
      freshness: { status: "fresh" },
      provenance: { read: 1, parsed: 0, compiled: 0, observed: 0, inferred: 0 },
      evidence: { sources: ["s1"] },
      filters: {},
      order: { key: "name", direction: "asc" },
      counts: { unit: "rows", total: 1, matched: 1, returned: 1, omitted: 0, truncated: false },
      cursor: null,
    });
    expect(reply.items).toEqual([
      { id: "mcp", cells: { name: "mcp.rs" }, provenance: "read", evidence: ["s1"], entity: { repository: "r", id: "mcp", kind: "code/module" } },
    ]);
  });
  it("[MC3] a row without an entity prints '-> (no entity)' (red-contract 3)", async () => {
    const env = await open(bundleOf([listView({ rows: [item("lonely", { cells: { name: "lonely.rs" } })] })]));
    expect(okText(await env.call("inspect_view", ARGS("modules"))).body).toContain("lonely.rs -> (no entity); read; s1");
  });
});

describe("[MC3] graph: edge tuples, counts and the focus neighborhood", () => {
  // Chain alpha -calls-> beta -imports-> gamma -reads-> delta; edge ids e1 e2 e3. Node ids double as the printed names
  // (nodes carry no label). BFS from `beta`: out/depth 1 traverses e2; in/depth 1 e1; both/depth 1 e1+e2; out/depth 2 e2+e3.
  // red-contract 6: graphNeighborhood returns the edge ids TRAVERSED. docs/contract-additions/ops.md section 4: the focus
  // acts as a filter, so total = 3 submitted edges and matched = traversed edges.
  const chain = (id: string, focus?: unknown) =>
    graphView({
      id, definitionId: `def-${id}`, completeness: complete("three submitted edges"), paths: null,
      nodes: [node("alpha"), node("beta"), node("gamma"), node("delta")],
      edges: [edge("e1", "alpha", "beta", "calls"), edge("e2", "beta", "gamma", "imports"), edge("e3", "gamma", "delta", "reads")],
      ...(focus === undefined ? {} : { focus }),
    });
  const ids = (reply: { items: Array<{ id: string }> }) => reply.items.map((i) => i.id);

  it("[MC3] without a focus all 3 edges are returned as tuples (unit edges), sorted by id", async () => {
    const env = await open(bundleOf([chain("g-all")]));
    const json = okJson(await env.call("inspect_view", { ...ARGS("g-all"), format: "json" }));
    expect(ids(json)).toEqual(["e1", "e2", "e3"]);
    expect(json.items.map((e: { from: string; to: string; relation: string }) => [e.from, e.relation, e.to])).toEqual([
      ["alpha", "calls", "beta"], ["beta", "imports", "gamma"], ["gamma", "reads", "delta"],
    ]);
    expect(json.counts).toEqual({ unit: "edges", total: 3, matched: 3, returned: 3, omitted: 0, truncated: false });
    const text = okText(await env.call("inspect_view", ARGS("g-all")));
    expect(text.body.filter((l) => /alpha.*calls.*beta/.test(l) || /beta.*imports.*gamma/.test(l) || /gamma.*reads.*delta/.test(l))).toHaveLength(3);
    expect(text.body[0]).toBe("3/3 matched edges returned; 0 omitted");
  });
  const focusCases: Array<[title: string, focus: Record<string, unknown>, edges: string[]]> = [
    ["out, depth 1 from beta traverses only e2", { node: "beta", direction: "out", depth: 1 }, ["e2"]],
    ["in, depth 1 from beta traverses only e1", { node: "beta", direction: "in", depth: 1 }, ["e1"]],
    ["both, depth 1 from beta traverses e1 and e2", { node: "beta", direction: "both", depth: 1 }, ["e1", "e2"]],
    ["out, depth 2 from beta traverses e2 and e3", { node: "beta", direction: "out", depth: 2 }, ["e2", "e3"]],
    ["depth 0 traverses nothing", { node: "beta", direction: "both", depth: 0 }, []],
  ];
  it.each(focusCases)("[MC3] focus %s (json: 3 submitted, N matched)", async (_title, focus, expected) => {
    const env = await open(bundleOf([chain("g-focus", focus)]));
    const json = okJson(await env.call("inspect_view", { ...ARGS("g-focus"), format: "json" }));
    expect(ids(json)).toEqual(expected);
    expect(json.counts).toEqual({ unit: "edges", total: 3, matched: expected.length, returned: expected.length, omitted: 0, truncated: false });
  });
  it("[MC3] text of a focused graph lists only the traversed tuple and never invents reachability", async () => {
    const env = await open(bundleOf([chain("g-focus-text", { node: "beta", direction: "out", depth: 1 })]));
    const text = okText(await env.call("inspect_view", ARGS("g-focus-text")));
    expect(text.body.some((l) => /beta.*imports.*gamma/.test(l))).toBe(true);
    expect(text.body.some((l) => /alpha.*calls.*beta/.test(l))).toBe(false);
    expect(text.body.some((l) => /gamma.*reads.*delta/.test(l))).toBe(false);
    expect(text.counts).toMatchObject({ unit: "edges", total: 3, matched: 1, returned: 1 });
  });
});

describe("[MC3] source: numbered lines, annotation links, clipped line ranges", () => {
  const excerpt = (first: number, lines: string[]) => ({
    id: "x", anchor: { repository: "r", path: "src/check.ts", lines: [first, first + lines.length - 1] },
    language: "typescript", text: lines.join("\n"), provenance: "read", evidence: ["s1"],
  });
  // why: design 2.4 "Lines retain file numbering. Text returns numbered excerpt lines and annotation-to-claim links".
  // Excerpt = file lines 10..12; annotation a1 covers line 11 and cites claims C1 and C2.
  // proves: CLAIM(MC3) source text keeps file numbering and annotation->claim links.
  it("[MC3] lines 10..12 are printed with their FILE numbers (not 1..3) and a1 links line 11 to claims C1 and C2", async () => {
    const view = sourceView({
      id: "src-small", definitionId: "def-src-small", excerpt: excerpt(10, ["line ten", "line eleven", "line twelve"]),
      annotations: [item("a1", { lines: [11, 11], message: "Denial branch", claimIds: ["C1", "C2"] })],
    });
    const env = await open(bundleOf([view]));
    const text = okText(await env.call("inspect_view", ARGS("src-small")));
    const numbered = text.body.flatMap((l) => {
      const match = /^\s*(\d+)\W+(line (?:ten|eleven|twelve))/.exec(l); // a trailing marker (e.g. an annotation tag) is allowed
      return match === null ? [] : [[match[1], match[2]]];
    });
    expect(numbered).toEqual([["10", "line ten"], ["11", "line eleven"], ["12", "line twelve"]]);
    const annotation = text.body.find((l) => l.includes("a1")) as string;
    expect(annotation).toContain("11");
    expect(annotation).toContain("Denial branch");
    expect(annotation).toContain("C1");
    expect(annotation).toContain("C2");
    expect(text.counts).toEqual({ unit: "lines", total: 3, matched: 3, returned: 3, omitted: 0, truncated: false });
  });

  // why: design 2.4 "clipping reports omitted line ranges". 200 lines 100..299 cannot fit 2048 bytes: the first r lines
  // are returned, the rest (100+r)..299 is reported as a range, and the cursor chain yields every file line exactly once.
  // proves: CLAIM(MC3) clipped source reports omitted line ranges and pages losslessly.
  const BIG_LINES = Array.from({ length: 200 }, (_, i) => `code line ${100 + i} ${"x".repeat(24)}`); // ~40 bytes each, 8 KB
  const bigSource = () => bundleOf([sourceView({ id: "src-big", definitionId: "def-src-big", excerpt: excerpt(100, BIG_LINES), annotations: [], completeness: complete("lines 100-299") })]);
  it("[MC3] at 2048 bytes the omitted range is stated as 'omitted lines <100+returned>-299' and counts add up", async () => {
    const env = await open(bigSource());
    const outcome = await env.call("inspect_view", { ...ARGS("src-big"), maxBytes: 2048 });
    const text = okText(outcome);
    expect(text.counts).toMatchObject({ unit: "lines", total: 200, matched: 200 });
    expect(text.counts.returned + text.counts.omitted).toBe(200);
    expect(text.counts.omitted).toBeGreaterThan(0); // ~8 KB of lines vs 2048 bytes
    expect(text.raw).toContain(`omitted lines ${100 + text.counts.returned}-299`);
    expect(text.body.filter((l) => /^\s*\d+\W+code line \d+/.test(l))).toHaveLength(text.counts.returned);
  });
  it("[MC3] the cursor chain returns file lines 100..299 once each, in order, within budget", async () => {
    const env = await open(bigSource());
    const pages = await textPages(env, "inspect_view", ARGS("src-big"), 2048);
    const numbers = pages.flatMap((p) => p.reply.body.flatMap((l) => (/^\s*(\d+)\W+code line (\d+)\b/.exec(l) ? [`${/^\s*(\d+)/.exec(l)?.[1]}:${/code line (\d+)/.exec(l)?.[1]}`] : [])));
    expect(describeSequenceDifference(Array.from({ length: 200 }, (_, i) => `${100 + i}:${100 + i}`), numbers)).toBeNull();
    expect(pages.length).toBeGreaterThanOrEqual(2);
  });
});

describe("[MC3] tree: indented paths, expansion state, child counts, named not_loaded branches", () => {
  // Tokens from docs/contract-additions/ops.md section 4: a line is `<2 spaces per depth><name> [<state>; children=<n>]`
  // with state `expanded` (has children, complete), `leaf` (complete, no children) or `not_loaded` (children unknown;
  // printed `children=?`). design 2.2: "`not_loaded` produces a visible load/needs-evidence affordance, not a leaf."
  //   src [expanded; children=2]
  //     a [expanded; children=1]
  //       a1.rs [leaf; children=0]
  //     b [not_loaded; children=?]
  const nodes = [
    treeNode("r", "src", ["a", "b"]), treeNode("a", "a", ["a1"]), treeNode("a1", "a1.rs"),
    treeNode("b", "b", [], { childrenState: "not_loaded" }),
  ];
  const bundle = () => bundleOf([treeView({ id: "tree-x", definitionId: "def-tree-x", roots: ["r"], nodes, completeness: partial(["g-b", "What is under b?"]) })]);
  it("[MC3] text: depth indentation, expansion state, child counts, and b is named not_loaded (never a leaf)", async () => {
    const env = await open(bundle());
    const text = okText(await env.call("inspect_view", ARGS("tree-x")));
    const line = (name: string) => text.body.find((l) => l.trimStart().startsWith(`${name} [`)) as string;
    const indent = (l: string) => /^( *)/.exec(l)?.[1]?.length;
    expect([line("src"), line("a"), line("a1.rs"), line("b")].map(indent)).toEqual([0, 2, 4, 2]);
    expect(line("src")).toContain("expanded; children=2");
    expect(line("a")).toContain("expanded; children=1");
    expect(line("a1.rs")).toContain("leaf; children=0");
    expect(line("b")).toContain("not_loaded");
    expect(line("b")).not.toContain("leaf");
    expect(text.body.map((l) => l.trimStart().split(" ")[0] ?? "").filter((w) => ["src", "a", "a1.rs", "b"].includes(w))).toEqual(["src", "a", "a1.rs", "b"]); // preorder
    expect(text.counts).toEqual({ unit: "nodes", total: 4, matched: 4, returned: 4, omitted: 0, truncated: false });
  });
  it("[MC3] json: nodes keep childrenState so not_loaded is explicit, in preorder", async () => {
    const env = await open(bundle());
    const reply = okJson(await env.call("inspect_view", { ...ARGS("tree-x"), format: "json" }));
    expect(reply.items.map((n: { id: string; childrenState: string }) => [n.id, n.childrenState])).toEqual([["r", "complete"], ["a", "complete"], ["a1", "complete"], ["b", "not_loaded"]]);
  });
});

describe("[MC3] notebook: claim and view references with status, authored order", () => {
  // authored order deliberately differs from id order: z-intro, v-1, c-2, c-1.
  const blocks = [proseBlock("z-intro", "Why does cancellation preserve a result?"), viewBlock("v-1", "modules"), claimBlock("c-2", "Delivery is checked before commit", "open"), claimBlock("c-1", "Cancellation is checked", "supported")];
  const bundle = () => bundleOf([listView(), notebookView({ id: "nb-x", definitionId: "def-nb-x", blocks, completeness: partial(["g-nb", "Does the checkout satisfy it?"]) })]);
  it("[MC3] text: blocks in authored order, the view block names its view id, claims show id, status and statement", async () => {
    const env = await open(bundle());
    const text = okText(await env.call("inspect_view", ARGS("nb-x")));
    expect(text.counts).toEqual({ unit: "blocks", total: 4, matched: 4, returned: 4, omitted: 0, truncated: false });
    expect(text.body[0]).toBe("4/4 matched blocks returned; 0 omitted");
    const at = (needle: string) => text.body.findIndex((l) => l.includes(needle));
    expect([at("Why does cancellation"), at("modules"), at("c-2"), at("c-1")]).toEqual([1, 2, 3, 4]);
    expect(text.body[3]).toContain("open");
    expect(text.body[3]).toContain("Delivery is checked before commit");
    expect(text.body[4]).toContain("supported");
    expect(text.header.completeness).toBe("partial (1 gaps; first: g-nb: Does the checkout satisfy it?)");
  });
  it("[MC3] json: items keep kind, status and viewId and follow the authored order", async () => {
    const env = await open(bundle());
    const reply = okJson(await env.call("inspect_view", { ...ARGS("nb-x"), format: "json" }));
    expect(reply.items.map((b: { id: string; kind: string }) => [b.id, b.kind])).toEqual([["z-intro", "prose"], ["v-1", "view"], ["c-2", "claim"], ["c-1", "claim"]]);
    expect(reply.items[1].viewId).toBe("modules");
    expect(reply.items[2].status).toBe("open");
  });
});

describe("[MC3] example: not run, and recorded runs", () => {
  const RES = { repository: "r", id: "res-1", kind: "json/value" };
  const resultEntity = entityAt(RES, "snap-1");
  const assertion = (id: string, statement: string, passed: boolean) => item(id, { statement, passed });
  const runs = [
    item("run-1", { runId: "rid-1", status: "passed", assertions: [assertion("as-1", "fires once", true), assertion("as-2", "event id is build:1:0", true)], result: RES }),
    item("run-2", { runId: "rid-2", status: "failed", assertions: [assertion("as-3", "exit code is zero", false), assertion("as-4", "stderr is empty", true)] }),
    item("run-3", { runId: "rid-3", status: "error", assertions: [], error: "runner crashed" }),
  ];

  // proves: CLAIM(MC3) an empty runs array says "not run" and never reads as passed.
  it("[MC3] no runs: text says 'not run', counts unit runs total 0, and the rerun instruction is present", async () => {
    const env = await open(bundleOf([exampleView()]));
    const text = okText(await env.call("inspect_view", ARGS("vigil-one-write")));
    expect(text.raw).toContain("not run");
    expect(text.counts).toEqual({ unit: "runs", total: 0, matched: 0, returned: 0, omitted: 0, truncated: false });
    expect(text.raw).toContain("paneweft example run vigil-one-write"); // design 5: `paneweft example run ID`
    expect(text.header.completeness).toBe("partial (1 gaps; first: g-not-run: Does the scenario pass in this checkout?)");
  });
  // design 2.7: "Text returns status, assertion counts/failures, result reference, and a rerun instruction."
  it("[MC3] three runs: status, assertion counts, the failed assertion, the result reference and the rerun instruction; no 'not run'", async () => {
    const env = await open(bundleOf([exampleView({ id: "ex-runs", definitionId: "def-ex-runs", runs })], { entities: [resultEntity] }));
    const text = okText(await env.call("inspect_view", ARGS("ex-runs")));
    expect(text.counts).toEqual({ unit: "runs", total: 3, matched: 3, returned: 3, omitted: 0, truncated: false });
    const run = (id: string) => text.body.find((l) => l.includes(id)) as string;
    expect(run("rid-1")).toContain("passed");
    expect(run("rid-1")).toContain("assertions=2/2");
    expect(run("rid-1")).toContain("json/value:res-1");
    expect(run("rid-2")).toContain("failed");
    expect(run("rid-2")).toContain("assertions=1/2");
    expect(run("rid-2")).toContain("exit code is zero"); // the failing assertion is named
    expect(run("rid-2")).not.toContain("stderr is empty");
    expect(run("rid-3")).toContain("error");
    expect(run("rid-3")).toContain("runner crashed");
    expect(text.raw).toContain("paneweft example run vigil-one-write");
    expect(text.raw).not.toContain("not run");
  });
});

describe("[MC3] shape: basis and references", () => {
  // design 2.5 "Text returns field paths, types, presence, basis, and references. Recursive types use ref".
  it("[MC3] text names the basis and prints a recursive type as a reference, not an expansion", async () => {
    const view = shapeView({
      id: "shape-ref", definitionId: "def-shape-ref", root: "f-node", basis: "observed",
      fields: [shapeField("f-node", "node", "object", { children: ["f-next"] }), shapeField("f-next", "node.next", "node", { presence: "optional", ref: "f-node" })],
    });
    const env = await open(bundleOf([view]));
    const text = okText(await env.call("inspect_view", ARGS("shape-ref")));
    expect(text.body).toContain("basis: observed");
    const next = text.body.find((l) => l.includes("node.next")) as string;
    expect(next).toContain("optional");
    expect(next).toContain("ref=f-node");
    expect(text.counts).toMatchObject({ unit: "fields", total: 2, returned: 2 });
  });
});

describe("[MC14] notebook embedDepth in summaries", () => {
  // Graph of embeds: nb-a -> [modules, nb-b, nb-a(self)]; nb-b -> [nb-c, nb-a]; nb-c -> []. So nb-a -> nb-b -> nb-a is a cycle.
  // red-contract 3: embedDepth 1 inlines each embedded view's header line (`paneweft.reply/1 view=<id> component=<c>`) and each
  // embedded notebook's block lines; embeds inside an embedded notebook stay references; cycles are cut; 0 = references only.
  const bundle = () =>
    bundleOf([
      listView(),
      notebookView({ id: "nb-a", definitionId: "def-nb-a", blocks: [proseBlock("a-prose", "outer prose"), viewBlock("a-list", "modules"), viewBlock("a-b", "nb-b"), viewBlock("a-self", "nb-a")] }),
      notebookView({ id: "nb-b", definitionId: "def-nb-b", blocks: [proseBlock("b-prose", "inner prose"), viewBlock("b-c", "nb-c"), viewBlock("b-a", "nb-a")] }),
      notebookView({ id: "nb-c", definitionId: "def-nb-c", blocks: [proseBlock("c-prose", "deepest prose")] }),
    ]);
  const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
  const LIST_HEADER = "paneweft.reply/1 view=modules component=list";

  // why: the default must not flood the reply (design 2.6: "Embedded views return references rather than recursively flooding").
  // proves: CLAIM(MC14) default depth 0 returns references only.
  it("[MC14] default (and explicit 0): references only - no embedded header line, no embedded prose; both spellings are byte-identical", async () => {
    const env = await open(bundle());
    const byDefault = await env.call("inspect_view", ARGS("nb-a"));
    const explicit = await env.call("inspect_view", { ...ARGS("nb-a"), embedDepth: 0 });
    expect(byDefault.body).toBe(explicit.body);
    const text = okText(byDefault);
    expect(text.raw).not.toContain(LIST_HEADER);
    expect(text.raw).not.toContain("inner prose");
    expect(text.raw).toContain("modules"); // the reference is there
    expect(text.raw).toContain("nb-b");
    expect(occurrences(text.raw, "outer prose")).toBe(1);
  });
  // proves: CLAIM(MC14) depth 1 inlines one level only.
  it("[MC14] embedDepth 1 inlines the list's header line and nb-b's blocks, but nb-c (embedded inside nb-b) stays a reference", async () => {
    const env = await open(bundle());
    const text = okText(await env.call("inspect_view", { ...ARGS("nb-a"), embedDepth: 1 }));
    expect(occurrences(text.raw, LIST_HEADER)).toBe(1);
    expect(occurrences(text.raw, "inner prose")).toBe(1);
    expect(text.raw).toContain("nb-c"); // reference with its link
    expect(text.raw).not.toContain("deepest prose");
    // the embedded list contributes only its header line, never its rows
    expect(text.body.filter((l) => l.includes(" -> code/module:"))).toEqual([]);
  });
  it("[MC14] json depth 1: the embedded notebook's blocks appear in the item, the depth-2 notebook's do not", async () => {
    const env = await open(bundle());
    const reply = okJson(await env.call("inspect_view", { ...ARGS("nb-a"), format: "json", embedDepth: 1 }));
    const serialized = JSON.stringify(reply.items);
    expect(serialized).toContain("inner prose");
    expect(serialized).not.toContain("deepest prose");
    const deeper = okJson(await env.call("inspect_view", { ...ARGS("nb-a"), format: "json" }));
    expect(JSON.stringify(deeper.items)).not.toContain("inner prose");
  });
  // proves: CLAIM(MC14) embed cycles terminate: A->B->A and A->A.
  it("[MC14] cycles terminate: nb-a embeds nb-b (which embeds nb-a back) and itself; nb-a's own prose is printed once", async () => {
    const env = await open(bundle());
    const text = okText(await env.call("inspect_view", { ...ARGS("nb-a"), embedDepth: 1 }));
    expect(occurrences(text.raw, "outer prose")).toBe(1); // the self-embed and the back-reference are cut, not inlined
  });
  it("[MC14] the cycle from the other side: viewing nb-b at depth 1 inlines nb-a and nb-c once each and cuts nb-a's own embeds", async () => {
    const env = await open(bundle());
    const text = okText(await env.call("inspect_view", { ...ARGS("nb-b"), embedDepth: 1 }));
    expect(occurrences(text.raw, "inner prose")).toBe(1);
    expect(occurrences(text.raw, "outer prose")).toBe(1);
    expect(occurrences(text.raw, "deepest prose")).toBe(1);
    expect(text.raw).not.toContain(LIST_HEADER); // nb-a's embed of the list is one level too deep
  });
  // why: an inlined embed must not defeat the budget: 200 rows behind one embedded reference add exactly one header line.
  it("[MC14] embedding the 200-row wide list at depth 1 stays within 2048 bytes and adds only its header line", async () => {
    const env = await open(bundleOf([wideListView(), notebookView({ id: "nb-w", definitionId: "def-nb-w", blocks: [proseBlock("w-prose", "see below"), viewBlock("w-list", "wide")] })]));
    const outcome = await env.call("inspect_view", { ...ARGS("nb-w"), embedDepth: 1, maxBytes: 2048 });
    const text = okText(outcome);
    expect(Buffer.byteLength(outcome.body, "utf8")).toBeLessThanOrEqual(2048);
    expect(text.raw).toContain("paneweft.reply/1 view=wide component=list");
    expect(text.body.filter((l) => l.includes(" -> code/module:"))).toEqual([]);
  });
  // proves: CLAIM(MC14) the limit is one level (design 4: "inline expansion stops after one level").
  it.each([[2, "OUT_OF_RANGE"], [-1, "OUT_OF_RANGE"], ["1", "TYPE"]] as const)("[MC14] embedDepth %j -> INVALID_ARGUMENT at /embedDepth (%s)", async (value, code) => {
    const env = await open(bundle());
    expect(issuesOf(await env.call("inspect_view", { ...ARGS("nb-a"), embedDepth: value }))).toEqual({ code: "INVALID_ARGUMENT", issues: [["/embedDepth", code]] });
  });
  it("[MC14] positive control: embedDepth 1 is accepted", async () => {
    const env = await open(bundle());
    expect((await env.call("inspect_view", { ...ARGS("nb-a"), embedDepth: 1 })).ok).toBe(true);
  });
});
