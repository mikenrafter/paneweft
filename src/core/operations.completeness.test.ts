// why: CLAIM(MC4) "Completeness is always visible" at the operation boundary (design 3 "A complete empty
// collection says '0 items within this scope'. It is different from an unavailable view and from an extraction
// error"; design 4 "even when zero rows match"; red-contract 3 header variants and `notice` strings). The four
// states complete-empty, partial-empty, unsupported and failed-operation must each be unmistakable in text and JSON.
// Also holds the summary side of CLAIM(MC13): the `freshness:` header line (fresh | stale | unknown).
// Expected strings are the red-contract section 3 literals, written out here, not imported.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { componentFixture, allBundle } from "../../test/helpers/fixtures.ts";
import { assertBodyWithin, cursorOf, issuesOf, jsonPages, okJson, okText, textPages, useOps } from "../../test/helpers/ops-env.ts";
import { patch } from "../../test/helpers/patch.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import {
  bundleOf, complete, graphView, listView, moduleRef, partial, row, unsupportedView, withFreshnessRoot,
  exampleView, notebookView, shapeView, sourceView, treeView,
} from "../../test/helpers/ops-views.ts";

const open = useOps();
const tempDir = useTempDirs();
const ARGS = (viewId: string) => ({ viewId, snapshotId: "snap-1" });

const GAP_ID = "g-open";
const GAP_QUESTION = "Which modules live outside src?";
const states = () =>
  bundleOf([
    listView({ id: "complete-empty", definitionId: "def-ce", rows: [], completeness: complete("all modules under src (none exist)") }),
    listView({ id: "partial-empty", definitionId: "def-pe", rows: [], completeness: partial([GAP_ID, GAP_QUESTION, "not enumerated"]) }),
    unsupportedView(listView({ id: "unsupported-view", definitionId: "def-un" }), "no parser for this language", "parse-rust", "call-graph"),
  ]);

describe("[MC4] the four states: complete-empty, partial-empty, unsupported, failed", () => {
  // why: an empty answer that does not say whether the scope was exhausted is the worst reply an agent can get:
  // "0 items within this scope" is a COMPLETE claim and must appear only for a complete view.
  // proves: CLAIM(MC4) complete-empty.
  it.each(["text", "json"] as const)("[MC4] %s: complete-empty names its criterion and says '0 items within this scope'", async (format) => {
    const env = await open(states());
    const outcome = await env.call("inspect_view", { ...ARGS("complete-empty"), format });
    assertBodyWithin(outcome.body, 8192);
    const counts = { unit: "rows", total: 0, matched: 0, returned: 0, omitted: 0, truncated: false };
    if (format === "json") {
      const reply = okJson(outcome);
      expect(reply.completeness).toMatchObject({ status: "complete", criterion: "all modules under src (none exist)" });
      expect(reply.notice).toBe("0 items within this scope");
      expect(reply.counts).toEqual(counts);
      expect(reply.items).toEqual([]);
    } else {
      const reply = okText(outcome);
      expect(reply.header.completeness).toBe("complete (all modules under src (none exist))");
      expect(reply.raw).toContain("0 items within this scope");
      expect(reply.counts).toEqual(counts);
      expect(reply.body[0]).toBe("0/0 matched rows returned; 0 omitted");
    }
    expect(cursorOf(outcome)).toBeNull();
  });

  // why: the same zero rows from a PARTIAL view must never read as "nothing exists": design 4 "It never replaces an
  // unknown count with zero"; red-contract 3: partial and total = 0 -> a different notice naming the gaps.
  // proves: CLAIM(MC4) partial-empty is distinct and names the gap id and question.
  it.each(["text", "json"] as const)("[MC4] %s: partial-empty names the gap, says 'no items returned; completeness is partial (see gaps)' and never '0 items within this scope'", async (format) => {
    const env = await open(states());
    const outcome = await env.call("inspect_view", { ...ARGS("partial-empty"), format });
    if (format === "json") {
      const reply = okJson(outcome);
      expect(reply.completeness).toMatchObject({ status: "partial", gapCount: 1 });
      expect(reply.completeness.gaps).toEqual([{ id: GAP_ID, question: GAP_QUESTION, reason: "not enumerated" }]);
      expect(reply.notice).toBe("no items returned; completeness is partial (see gaps)");
    } else {
      const reply = okText(outcome);
      expect(reply.header.completeness).toBe(`partial (1 gaps; first: ${GAP_ID}: ${GAP_QUESTION})`);
      expect(reply.raw).toContain("no items returned; completeness is partial (see gaps)");
    }
    expect(outcome.body).not.toContain("0 items within this scope");
    expect(outcome.body).toContain(GAP_ID);
    expect(outcome.body).toContain(GAP_QUESTION);
  });

  // why: design 4 "Unsupported has no data body"; a renderer that reads view.data.rows on it throws. The domain
  // result is a normal reply whose payload status is "unsupported" with the missing capabilities.
  // proves: CLAIM(MC4) unsupported is a domain result, not an error.
  it.each(["text", "json"] as const)("[MC4] %s: unsupported is an ok reply with status unsupported, reason, missing capabilities and zero counts", async (format) => {
    const env = await open(states());
    const outcome = await env.call("inspect_view", { ...ARGS("unsupported-view"), format });
    expect(outcome.ok).toBe(true);
    expect((outcome.ok ? (outcome.payload as { completeness: unknown }).completeness : null)).toMatchObject({
      status: "unsupported", reason: "no parser for this language", missingCapabilities: ["parse-rust", "call-graph"],
    });
    const counts = { unit: "rows", total: 0, matched: 0, returned: 0, omitted: 0, truncated: false };
    if (format === "json") {
      const reply = okJson(outcome);
      expect(reply.notice).toBe("this view is unsupported: no parser for this language");
      expect(reply.counts).toEqual(counts);
    } else {
      const reply = okText(outcome);
      expect(reply.header.completeness).toBe("unsupported (no parser for this language; missing: parse-rust, call-graph)");
      expect(reply.raw).toContain("this view is unsupported: no parser for this language");
      expect(reply.counts).toEqual(counts);
    }
    expect(outcome.body).not.toContain("0 items within this scope");
  });

  // why: "no `data` access errors" - an unsupported envelope has no data for ANY component; each component's
  // summary code path must cope. Units: list rows, tree nodes, graph edges, source lines, shape fields, notebook blocks, example runs.
  // proves: CLAIM(MC4) unsupported works for all seven components.
  const unsupportedOf: Array<[string, string, () => Record<string, any>]> = [
    ["list", "rows", () => listView()], ["tree", "nodes", () => treeView()], ["graph", "edges", () => graphView()],
    ["source", "lines", () => sourceView()], ["shape", "fields", () => shapeView()],
    ["notebook", "blocks", () => notebookView()], ["example", "runs", () => exampleView()],
  ];
  it.each(unsupportedOf)("[MC4] an unsupported %s view summarises without a data body (unit %s)", async (component, unit, make) => {
    const env = await open(bundleOf([unsupportedView({ ...make(), id: "u", viewDefinitionId: "def-u" }, "needs a language service", "lsp")]));
    const outcome = await env.call("inspect_view", { ...ARGS("u"), format: "json" });
    const reply = okJson(outcome);
    expect(reply.view.component).toBe(component);
    expect(reply.completeness).toMatchObject({ status: "unsupported", reason: "needs a language service", missingCapabilities: ["lsp"] });
    expect(reply.counts).toEqual({ unit, total: 0, matched: 0, returned: 0, omitted: 0, truncated: false });
    expect(reply.items).toEqual([]);
  });

  // why: malformed input is an operation ERROR (design 4: "Unsupported and partial are domain results, while
  // malformed input ... are operation errors with codes"). Positive control: the valid bundle is accepted.
  // proves: CLAIM(MC4) failed operation: ok:false, VALIDATION_FAILED, exact pointer.
  it("[MC4] render of a graph with a string depth fails with VALIDATION_FAILED and exactly the issue (/data/focus/depth, TYPE)", async () => {
    const env = await open();
    const malformed = patch(componentFixture("graph"), { op: "add", path: "/data/focus", value: { node: "a", direction: "out", depth: "2" } });
    const outcome = await env.call("render", { input: malformed });
    expect(outcome.ok).toBe(false);
    expect(issuesOf(outcome)).toEqual({ code: "VALIDATION_FAILED", issues: [["/data/focus/depth", "TYPE"]] });
    expect(outcome.format).toBe("text"); // the default format; the error body is a JSON paneweft.error/1 document either way
  });
  it("[MC4] positive control: render of the valid all-components bundle is accepted", async () => {
    const env = await open();
    const outcome = await env.call("render", { input: allBundle() });
    expect(outcome.ok).toBe(true);
  });

  // why: the four states must be distinguishable by their visible status AND their notice, not just by one field.
  // proves: CLAIM(MC4) distinct statuses and messages.
  it("[MC4] the four states carry four distinct statuses and three distinct notices", async () => {
    const env = await open(states());
    const replies = await Promise.all(["complete-empty", "partial-empty", "unsupported-view"].map(async (id) => okJson(await env.call("inspect_view", { ...ARGS(id), format: "json" }))));
    const failed = await env.call("render", { input: patch(componentFixture("graph"), { op: "replace", path: "/component", value: "heatmap" }) });
    const statuses = [...replies.map((r) => r.completeness.status as string), failed.ok ? "ok" : `error:${failed.error.code}`];
    expect(statuses).toEqual(["complete", "partial", "unsupported", "error:VALIDATION_FAILED"]);
    expect(new Set(statuses).size).toBe(4);
    expect(new Set(replies.map((r) => r.notice)).size).toBe(3);
  });
});

describe("[MC4] a partial view stays partial after filtering and when it has many gaps", () => {
  const FIVE = ["a", "b", "c", "d", "e"].map((n) => row(`r-${n}`, { name: `item ${n}` }, { entity: moduleRef(`r-${n}`) }));
  const gapView = () =>
    bundleOf([listView({ id: "gappy", definitionId: "def-gappy", rows: FIVE, completeness: partial(["g-1", "q one"], ["g-2", "q two"], ["g-3", "q three"]) })]);

  // why: design 4 "A short reply includes gap counts and at least the first named gap"; a filter that removes every row
  // must not make the gaps vanish or read as "0 items within this scope" (the scope is not exhausted).
  // proves: CLAIM(MC4) partial view with zero rows after a filter.
  it.each(["text", "json"] as const)("[MC4] %s: filter matching no row of a partial view still prints 3 gaps, the first gap and the filter notice", async (format) => {
    const env = await open(gapView());
    const outcome = await env.call("inspect_view", { ...ARGS("gappy"), format, filter: { text: "zzz" } });
    if (format === "json") {
      const reply = okJson(outcome);
      expect(reply.completeness).toMatchObject({ status: "partial", gapCount: 3 });
      expect(reply.completeness.gaps[0]).toMatchObject({ id: "g-1", question: "q one" });
      expect(reply.counts).toEqual({ unit: "rows", total: 5, matched: 0, returned: 0, omitted: 0, truncated: false });
      expect(reply.notice).toBe("no items match the current filters (0 of 5)");
    } else {
      const reply = okText(outcome);
      expect(reply.header.completeness).toBe("partial (3 gaps; first: g-1: q one)");
      expect(reply.header.filters).toBe('text="zzz"');
      expect(reply.counts).toEqual({ unit: "rows", total: 5, matched: 0, returned: 0, omitted: 0, truncated: false });
      expect(reply.raw).toContain("no items match the current filters (0 of 5)");
    }
    expect(outcome.body).not.toContain("0 items within this scope");
  });

  // 50 gaps with ~300-byte questions (15 KB) can never fit one 2048-byte page: the reply must say 50, show the first,
  // and give a pager for the rest (docs/contract-additions/ops.md section 3), never "0 gaps".
  const gaps = Array.from({ length: 50 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return [`g-${n}`, `Gap ${n}: ` + "why is this unknown? ".repeat(15), `reason ${n}`] as [string, string, string];
  });
  const manyGaps = () => bundleOf([listView({ id: "many", definitionId: "def-many", rows: [], completeness: partial(...gaps) })]);
  const expectedGapIds = gaps.map(([id]) => id);

  // proves: CLAIM(MC4) many gaps: count, first gap, pager.
  // docs/contract-additions/ops.md section 3 (text): gap #1 is named in the header line only; `gap: <id>: <question>` body
  // lines carry gaps #2..#50 and are paged by the cursor, so header + body lines together name each gap exactly once.
  it("[MC4] text: the header of every page says 50 gaps and the first gap; the page chain lists g-02..g-50 once each", async () => {
    const env = await open(manyGaps());
    const pages = await textPages(env, "inspect_view", ARGS("many"), 2048);
    expect(pages.length).toBeGreaterThanOrEqual(2); // 49 x ~320 bytes > 2048
    for (const page of pages) expect(page.reply.header.completeness).toBe(`partial (50 gaps; first: g-01: ${gaps[0]?.[1]})`);
    const gapIdOf = (line: string) => /^gap: (g-\d+): /.exec(line)?.[1];
    const listed = pages.flatMap((page) => page.reply.body.map(gapIdOf).filter((id): id is string => id !== undefined));
    expect(listed).toEqual(expectedGapIds.slice(1));
  });
  it("[MC4] json: gapCount is 50 on every page and the pages' completeness.gaps concatenate to the 50 gaps in order, first page starting at g-01", async () => {
    const env = await open(manyGaps());
    const pages = await jsonPages(env, "inspect_view", ARGS("many"), 2048);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const page of pages) expect(page.reply.completeness.gapCount).toBe(50);
    expect(pages[0]?.reply.completeness.gaps[0]).toEqual({ id: "g-01", question: gaps[0]?.[1], reason: "reason 01" });
    expect(pages.flatMap((p) => p.reply.completeness.gaps.map((g: { id: string }) => g.id))).toEqual(expectedGapIds);
    // zero rows throughout: gap paging does not invent items
    for (const page of pages) expect(page.reply.counts).toEqual({ unit: "rows", total: 0, matched: 0, returned: 0, omitted: 0, truncated: false });
  });
  it("[MC4] a partial list with rows AND 50 gaps never reports 0 gaps, even on a budget-limited first page", async () => {
    const env = await open(bundleOf([listView({ id: "many2", definitionId: "def-many2", rows: FIVE, completeness: partial(...gaps) })]));
    const reply = okJson(await env.call("inspect_view", { ...ARGS("many2"), format: "json", maxBytes: 2048 }));
    expect(reply.completeness.gapCount).toBe(50);
    expect(reply.completeness.gaps[0].id).toBe("g-01");
    expect(reply.counts.matched).toBe(5);
    expect(reply.cursor).not.toBeNull();
  });
});

describe("[MC13] the freshness header line", () => {
  // why: design 4 "Freshness is computed separately from the evidence's completeness: fresh, stale with changed paths, or
  // unknown with inaccessible roots. A complete historical view remains complete ... while stale." red-contract 3
  // header: `freshness: fresh | stale (changed: <path>, <path>) | unknown (inaccessible: <root>, <root>)`.
  // The fixture's recorded hash for src/mcp.rs is sha256("hello\n"); the directory is written by the test.
  // proves: CLAIM(MC13) summary freshness states; completeness unaffected.
  const mcpPath = (root: string) => join(root, "src", "mcp.rs");
  function writeMcp(root: string, content: string) {
    mkdirSync(dirname(mcpPath(root)), { recursive: true });
    writeFileSync(mcpPath(root), content);
  }
  const view = (root: string) => bundleOf([withFreshnessRoot(listView({ id: "fresh-v", definitionId: "def-fresh" }), root)]);
  // S1: the envelope's recorded root is never read; the OPERATOR registers the local root of repository `r`.
  const operatorRegisters = async (env: { session: { registerRepository(r: { id: string; root: string }): Promise<unknown> } }, root: string) =>
    void (await env.session.registerRepository({ id: "r", root }));

  it("[MC13] fresh: the file still holds the recorded bytes -> 'freshness: fresh'", async () => {
    const root = tempDir("fresh");
    writeMcp(root, "hello\n");
    const env = await open(view(root));
    await operatorRegisters(env, root);
    expect(okText(await env.call("inspect_view", ARGS("fresh-v"))).header.freshness).toBe("fresh");
    expect(okJson(await env.call("inspect_view", { ...ARGS("fresh-v"), format: "json" })).freshness.status).toBe("fresh");
  });
  it("[MC13] stale: the bytes changed -> 'stale (changed: src/mcp.rs)' and the view is still complete", async () => {
    const root = tempDir("stale");
    writeMcp(root, "hello, changed\n");
    const env = await open(view(root));
    await operatorRegisters(env, root);
    const text = okText(await env.call("inspect_view", ARGS("fresh-v")));
    expect(text.header.freshness).toBe("stale (changed: src/mcp.rs)");
    expect(text.header.completeness).toBe("complete (all modules in the fixture)");
    const json = okJson(await env.call("inspect_view", { ...ARGS("fresh-v"), format: "json" }));
    expect(json.freshness).toMatchObject({ status: "stale", changedPaths: ["src/mcp.rs"] });
    expect(json.completeness.status).toBe("complete");
  });
  it("[MC13] unknown: the root cannot be read -> 'unknown (inaccessible: <root>)'", async () => {
    const missing = join(tempDir("unknown"), "no-such-root");
    const env = await open(view(missing));
    await operatorRegisters(env, missing);
    expect(okText(await env.call("inspect_view", ARGS("fresh-v"))).header.freshness).toBe(`unknown (inaccessible: ${missing})`);
    expect(okJson(await env.call("inspect_view", { ...ARGS("fresh-v"), format: "json" })).freshness).toMatchObject({ status: "unknown", inaccessibleRoots: [missing] });
  });
  // why: S1. The envelope below records a root that EXISTS and holds the recorded bytes, but the operator registered no
  //   repository: the header must say `unverified` with the repository and a reason, never `fresh`, and must not name the
  //   submitted root (it is untrusted text that could be a probe).
  // proves: CLAIM(freshness-registered-roots) CLAIM(MC13) CLAIM(MC15)
  it("[S1] unverified: a recorded root that exists and matches, with no registration -> 'unverified (r: ...)', never fresh", async () => {
    const root = tempDir("unverified");
    writeMcp(root, "hello\n");
    const env = await open(view(root));
    const text = okText(await env.call("inspect_view", ARGS("fresh-v")));
    expect(text.header.freshness).toMatch(/^unverified \(r: .*\S.*\)$/);
    expect(text.header.freshness).not.toContain(root);
    expect(text.header.completeness).toBe("complete (all modules in the fixture)");
    const json = okJson(await env.call("inspect_view", { ...ARGS("fresh-v"), format: "json" }));
    expect(json.freshness).toMatchObject({ status: "unverified", unverified: [{ repository: "r", code: "REPOSITORY_NOT_REGISTERED" }] });
    expect(JSON.stringify(json.freshness)).not.toContain(root);
  });
});
