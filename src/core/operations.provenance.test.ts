// why: CLAIM(MC5) "Provenance cannot disappear in summaries" (design 4: "The returned text or JSON always includes
// those categories [read, compiled, observed ...], coverage status, current filters, snapshot ID, and the question,
// even when zero rows match"; MC5 table row: "A filtered-empty view still reports its evidence coverage").
// Header provenance and evidence count the WHOLE view (red-contract 3); rows show their own provenance word and
// evidence ids; inferred rows show their reason; shape examples distinguish missing / null (design 2.5).
// Row-line grammar from design 4's example `mcp.rs -> code/module:mcp; read; s1`. Open decisions (which items
// count for graphs, where an inferred reason is printed): docs/contract-additions/ops.md section 4.
import { describe, expect, it } from "vitest";
import { okJson, okText, useOps } from "../../test/helpers/ops-env.ts";
import {
  bundleOf, commandSource, complete, edge, fileSource, graphView, listView, moduleRef, node, row, shapeField, shapeView,
} from "../../test/helpers/ops-views.ts";

const open = useOps();
const ARGS = (viewId: string) => ({ viewId, snapshotId: "snap-1" });

const REASON = "Both callers pass through the same guard";
const SOURCES = [fileSource("s1"), commandSource("s2"), commandSource("s3", "run-1")];
// four provenance kinds in one view; order name asc -> alpha, beta, delta, gamma
const mixed = () =>
  bundleOf([
    listView({
      id: "mixed", definitionId: "def-mixed", sources: SOURCES, completeness: complete("four hand-made rows"),
      rows: [
        row("p-read", { name: "alpha" }, { entity: moduleRef("p-read") }),
        row("p-compiled", { name: "beta" }, { provenance: "compiled", evidence: ["s2"], entity: moduleRef("p-compiled") }),
        row("p-observed", { name: "gamma" }, { provenance: "observed", evidence: ["s3"] }),
        row("p-inferred", { name: "delta" }, { provenance: "inferred", reason: REASON, basis: ["p-read"] }),
      ],
    }),
  ]);

describe("[MC5] provenance in text and JSON summaries", () => {
  // why: a row that hides how it was learned lets an inference pass as a reading. Each row line carries its own
  // provenance word and evidence ids; the inferred row carries its reason on the same line.
  // proves: CLAIM(MC5) labels and evidence links on rows.
  it("[MC5] text: each row line shows its provenance word and evidence ids; the inferred row also shows its reason", async () => {
    const env = await open(mixed());
    const reply = okText(await env.call("inspect_view", ARGS("mixed")));
    const line = (name: string) => reply.body.find((l) => l.startsWith(`${name} -> `));
    expect(line("alpha")).toBe("alpha -> code/module:p-read; read; s1");
    expect(line("beta")).toBe("beta -> code/module:p-compiled; compiled; s2");
    expect(line("gamma")).toBe("gamma -> (no entity); observed; s3");
    const inferred = line("delta") as string;
    expect(inferred.startsWith("delta -> (no entity); inferred; s1")).toBe(true);
    expect(inferred).toContain(REASON);
    expect(reply.body.filter((l) => l.includes(" -> "))).toHaveLength(4);
  });
  it("[MC5] json: items carry provenance, evidence, and the inferred reason", async () => {
    const env = await open(mixed());
    const reply = okJson(await env.call("inspect_view", { ...ARGS("mixed"), format: "json" }));
    const byId = (id: string) => reply.items.find((item: { id: string }) => item.id === id);
    expect([byId("p-read"), byId("p-compiled"), byId("p-observed"), byId("p-inferred")].map((i) => [i.provenance, i.evidence])).toEqual([
      ["read", ["s1"]], ["compiled", ["s2"]], ["observed", ["s3"]], ["inferred", ["s1"]],
    ]);
    expect(byId("p-inferred").reason).toBe(REASON);
    expect(byId("p-read")).not.toHaveProperty("reason");
  });

  // why: the header lists every provenance category with an exact count even when a category is 0 (a missing
  // "parsed=0" is indistinguishable from "not computed"), and lists the evidence sources of the whole view.
  // proves: CLAIM(MC5) header provenance counts and evidence sources.
  it("[MC5] header counts are exact: read=1 parsed=0 compiled=1 observed=1 inferred=1, sources s1,s2,s3 (text and JSON)", async () => {
    const env = await open(mixed());
    const text = okText(await env.call("inspect_view", ARGS("mixed")));
    expect(text.header.provenance).toBe("read=1 parsed=0 compiled=1 observed=1 inferred=1");
    expect(text.header.evidence).toBe("sources=s1,s2,s3");
    const json = okJson(await env.call("inspect_view", { ...ARGS("mixed"), format: "json" }));
    expect(json.provenance).toEqual({ read: 1, parsed: 0, compiled: 1, observed: 1, inferred: 1 });
    expect(json.evidence).toEqual({ sources: ["s1", "s2", "s3"] });
  });

  // why: MC5 "A filtered-empty view still reports its evidence coverage": the counts describe the whole view, not the
  // filtered slice, so a filter that matches nothing must not zero them.
  // proves: CLAIM(MC5) filtered-empty keeps whole-view provenance and evidence.
  const noObserved = () =>
    bundleOf([
      listView({
        id: "plain", definitionId: "def-plain", sources: [fileSource("s1"), commandSource("s2")], completeness: complete("three rows"),
        rows: [
          row("x1", { name: "x1" }, { entity: moduleRef("x1") }),
          row("x2", { name: "x2" }, { entity: moduleRef("x2") }),
          row("x3", { name: "x3" }, { provenance: "compiled", evidence: ["s2"], entity: moduleRef("x3") }),
        ],
      }),
    ]);
  it("[MC5] text: filtering provenance=observed on a view without observed rows matches 0 yet still reports read=2 compiled=1 and sources s1,s2", async () => {
    const env = await open(noObserved());
    const reply = okText(await env.call("inspect_view", { ...ARGS("plain"), filter: { provenance: ["observed"] } }));
    expect(reply.counts).toEqual({ unit: "rows", total: 3, matched: 0, returned: 0, omitted: 0, truncated: false });
    expect(reply.header.provenance).toBe("read=2 parsed=0 compiled=1 observed=0 inferred=0");
    expect(reply.header.evidence).toBe("sources=s1,s2");
    expect(reply.header.filters).toBe("provenance=observed");
    expect(reply.raw).toContain("no items match the current filters (0 of 3)");
  });
  it("[MC5] json: the same filtered-empty request keeps the whole-view provenance and evidence", async () => {
    const env = await open(noObserved());
    const reply = okJson(await env.call("inspect_view", { ...ARGS("plain"), format: "json", filter: { provenance: ["observed"] } }));
    expect(reply.provenance).toEqual({ read: 2, parsed: 0, compiled: 1, observed: 0, inferred: 0 });
    expect(reply.evidence.sources).toEqual(["s1", "s2"]);
    expect(reply.filters).toEqual({ provenance: ["observed"] });
    expect(reply.counts.matched).toBe(0);
  });
  it("[MC5] positive control: provenance=compiled on the same view matches exactly the one compiled row, header counts unchanged", async () => {
    const env = await open(noObserved());
    const reply = okText(await env.call("inspect_view", { ...ARGS("plain"), filter: { provenance: ["compiled"] } }));
    expect(reply.counts).toMatchObject({ total: 3, matched: 1, returned: 1 });
    expect(reply.header.provenance).toBe("read=2 parsed=0 compiled=1 observed=0 inferred=0");
    expect(reply.body.filter((l) => l.includes(" -> "))).toEqual(["x3 -> code/module:x3; compiled; s2"]);
  });
  it("[MC5] a non-empty filter does not shrink the header either: provenance=read on the mixed view still shows 1/0/1/1/1", async () => {
    const env = await open(mixed());
    const reply = okText(await env.call("inspect_view", { ...ARGS("mixed"), filter: { provenance: ["read"] } }));
    expect(reply.counts).toMatchObject({ total: 4, matched: 1 });
    expect(reply.header.provenance).toBe("read=1 parsed=0 compiled=1 observed=1 inferred=1");
    expect(reply.header.evidence).toBe("sources=s1,s2,s3");
  });

  // why: design 2.5 "Missing, null, and redacted examples are distinct". JSON: key absent vs null vs value vs "";
  // text: `no example` vs `null` vs the value. Paths avoid the words "null" and "example" so substring checks are exact.
  // proves: CLAIM(MC5) shape example states stay distinct in summaries.
  const shape = () =>
    bundleOf([
      shapeView({
        id: "shape-ex", definitionId: "def-shape-ex", root: "f-root",
        fields: [
          shapeField("f-root", "root", "object", { children: ["f-a", "f-b", "f-c", "f-d"] }),
          shapeField("f-a", "root.a", "string"), // example key absent
          shapeField("f-b", "root.b", "string", { example: null }), // explicit null
          shapeField("f-c", "root.c", "string", { example: "hello" }),
          shapeField("f-d", "root.d", "string", { example: "" }), // empty string is a value, not missing
        ],
      }),
    ]);
  it("[MC5] json: the missing example has no `example` key, null stays null, values stay values", async () => {
    const env = await open(shape());
    const reply = okJson(await env.call("inspect_view", { ...ARGS("shape-ex"), format: "json" }));
    const field = (id: string) => reply.items.find((item: { id: string }) => item.id === id);
    expect(field("f-a")).not.toHaveProperty("example");
    expect(field("f-b")).toHaveProperty("example", null);
    expect(field("f-c").example).toBe("hello");
    expect(field("f-d").example).toBe("");
    expect(reply.counts).toMatchObject({ unit: "fields", total: 5, matched: 5, returned: 5 });
  });
  it("[MC5] text: 'no example' for the missing one, 'null' for the null one, the value for a value, neither word for an empty string", async () => {
    const env = await open(shape());
    const reply = okText(await env.call("inspect_view", ARGS("shape-ex")));
    const line = (path: string) => reply.body.find((l) => l.includes(path)) as string;
    expect(line("root.a")).toContain("no example");
    expect(line("root.a")).not.toContain("null");
    expect(line("root.b")).toContain("null");
    expect(line("root.b")).not.toContain("no example");
    expect(line("root.c")).toContain("hello");
    expect(line("root.d")).not.toContain("no example");
    expect(line("root.d")).not.toContain("null");
    // each field line states path, type and presence (design 2.5: "field paths, types, presence, basis")
    expect(line("root.a")).toContain("string");
    expect(line("root.a")).toContain("required");
    expect(reply.header.provenance).toBe("read=5 parsed=0 compiled=0 observed=0 inferred=0");
  });

  // why: graph facts are nodes AND edges; counting only one array would under-report inferred edges.
  // docs/contract-additions/ops.md section 4: header provenance counts every fact item of the view's data.
  // proves: CLAIM(MC5) graph provenance counts and inferred edge reasons.
  it("[MC5] graph: header counts nodes and edges together (read=4 inferred=1) and an inferred edge line shows its reason", async () => {
    const env = await open(
      bundleOf([
        graphView({
          id: "g-prov", definitionId: "def-g-prov", completeness: complete("three nodes, two edges"),
          nodes: [node("a"), node("b"), node("c")], paths: null,
          edges: [edge("e1", "a", "b", "calls"), edge("e2", "b", "c", "imports", { provenance: "inferred", reason: REASON, basis: ["e1"] })],
        }),
      ]),
    );
    const reply = okText(await env.call("inspect_view", ARGS("g-prov")));
    expect(reply.header.provenance).toBe("read=4 parsed=0 compiled=0 observed=0 inferred=1");
    const inferred = reply.body.find((l) => l.includes("imports")) as string;
    expect(inferred).toContain("inferred");
    expect(inferred).toContain(REASON);
  });
});
