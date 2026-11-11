// why: CLAIM(MC19) "Filtering and pagination are stable" at the operation boundary (design MC19: "With equal sort
// keys and a fixed ID tie-break, concatenate pages and compare against an independently listed expected order.
// Change the filter or snapshot and expect a cursor-mismatch error"). red-contract 3: ordering is the view's
// (or the request's) order, then item id in code-unit order; a cursor binds (viewId, snapshotId, filter, order,
// position) and NOT the budget or format; filter members AND together. Expected orders are literal lists derived
// by hand below and cross-checked against the oracle in test/helpers/ops-oracle.ts (itself proved by ops-oracle.test.ts).
import { assert, describe, expect, it } from "vitest";
import type { OperationOutcome } from "./operations.ts";
import { entityIdsOfLines, failure, jsonPages, okJson, okText, textPages, useOps, type OpsEnv } from "../../test/helpers/ops-env.ts";
import { describeSequenceDifference, filterRows, followCursors, orderRows, treeFilter } from "../../test/helpers/ops-oracle.ts";
import {
  bundleOf, claimBlock, commandSource, complete, toolSource, edge, fileSource, graphView, listView, moduleRef, node, notebookView,
  proseBlock, row, treeNode, treeView, viewBlock,
} from "../../test/helpers/ops-views.ts";

const open = useOps();
const ARGS = { viewId: "paged", snapshotId: "snap-1" };

// ---- the dataset (13 rows; 7 share the rank 5) ----------------------------------------------------
// id  | rank | kind  | provenance | label
// q-b |  1   | beta  | read       |
// q-m |  1   | alpha | compiled   |
// q-z |  1   | beta  | read       |
// r-a |  5   | alpha | read       | "Gamma note"
// r-b |  5   | beta  | read       |
// r-c |  5   | alpha | read       |
// r-d |  5   | beta  | read       |
// r-e |  5   | alpha | read       |
// r-f |  5   | beta  | read       |
// r-g |  5   | alpha | read       |
// t-1 |  9   | beta  | observed   |
// t-2 |  9   | alpha | read       |
// u-1 | 10   | beta  | compiled   |
// name cell = "<id> " + 50 x "pad " (205 chars) so 13 rows exceed one 2048-byte page in text and JSON.
const PAD = "pad ".repeat(50);
const DATA: Array<[id: string, rank: number, kind: string, provenance: "read" | "compiled" | "observed", label?: string]> = [
  ["r-d", 5, "beta", "read"], ["q-z", 1, "beta", "read"], ["t-2", 9, "alpha", "read"], ["r-a", 5, "alpha", "read", "Gamma note"],
  ["u-1", 10, "beta", "compiled"], ["r-g", 5, "alpha", "read"], ["q-b", 1, "beta", "read"], ["r-f", 5, "beta", "read"],
  ["t-1", 9, "beta", "observed"], ["r-c", 5, "alpha", "read"], ["q-m", 1, "alpha", "compiled"], ["r-b", 5, "beta", "read"], ["r-e", 5, "alpha", "read"],
]; // deliberately shuffled: storage order must not leak into the result order
const SOURCES = [fileSource("s1"), toolSource("s2"), commandSource("s3", "run-1")];
const EVIDENCE = { read: ["s1"], compiled: ["s2"], observed: ["s3"] } as const;
const dataRows = () =>
  DATA.map(([id, rank, kind, provenance, label]) =>
    row(id, { name: `${id} ${PAD}`, rank, kind }, { provenance, evidence: EVIDENCE[provenance], entity: moduleRef(id), ...(label === undefined ? {} : { label }) }),
  );
const COLUMNS = [{ key: "name", title: "Name", format: "text" }, { key: "rank", title: "Rank", format: "number" }, { key: "kind", title: "Kind", format: "text" }];
const pagedView = (snapshotId = "snap-1", id = "paged") =>
  listView({
    id, snapshotId, definitionId: "def-paged", sources: SOURCES, columns: COLUMNS, rows: dataRows(),
    order: { key: "rank", direction: "asc" }, completeness: complete("13 hand-made rows"),
  });
const pagedBundle = () => bundleOf([pagedView("snap-1"), pagedView("snap-2"), pagedView("snap-1", "paged-b")]);

const ASC = ["q-b", "q-m", "q-z", "r-a", "r-b", "r-c", "r-d", "r-e", "r-f", "r-g", "t-1", "t-2", "u-1"]; // rank asc; ties by id
const DESC = ["u-1", "t-1", "t-2", "r-a", "r-b", "r-c", "r-d", "r-e", "r-f", "r-g", "q-b", "q-m", "q-z"]; // rank desc; ties STILL by id asc
const BY_KIND = ["q-m", "r-a", "r-c", "r-e", "r-g", "t-2", "q-b", "q-z", "r-b", "r-d", "r-f", "t-1", "u-1"]; // kind asc: alpha (6) then beta (7); ties by id

describe("[MC19] oracle agrees with the hand-derived orders", () => {
  // why: the literal orders above are the test's expectations; the oracle must reproduce them, so a drift in either is caught here.
  it("[MC19] orderRows reproduces ASC, DESC and BY_KIND", () => {
    const rows = dataRows();
    expect(orderRows(rows, { key: "rank", direction: "asc" }).map((r) => r.id)).toEqual(ASC);
    expect(orderRows(rows, { key: "rank", direction: "desc" }).map((r) => r.id)).toEqual(DESC);
    expect(orderRows(rows, { key: "kind", direction: "asc" }).map((r) => r.id)).toEqual(BY_KIND);
  });
});

describe("[MC19] equal sort keys, id tie-break, ascending and descending", () => {
  // why: seven rows share rank 5; without a total order (id tie-break) a cursor chain can repeat or drop them.
  // proves: CLAIM(MC19) concatenated pages == independently listed expected order.
  it("[MC19] JSON chain, view order (rank asc), budget 2048: ids equal ASC exactly once each", async () => {
    const env = await open(pagedBundle());
    const pages = await jsonPages(env, "inspect_view", ARGS, 2048);
    expect(describeSequenceDifference(ASC, pages.flatMap((p) => p.reply.items.map((i: { id: string }) => i.id)))).toBeNull();
    expect(pages.length).toBeGreaterThanOrEqual(2); // 13 x ~390 JSON bytes > 2048
    expect(pages[0]?.reply.order).toEqual({ key: "rank", direction: "asc" });
  });
  it("[MC19] JSON chain with request order rank desc: DESC, the seven rank-5 rows still ascending by id", async () => {
    const env = await open(pagedBundle());
    const pages = await jsonPages(env, "inspect_view", { ...ARGS, order: { key: "rank", direction: "desc" } }, 2048);
    expect(describeSequenceDifference(DESC, pages.flatMap((p) => p.reply.items.map((i: { id: string }) => i.id)))).toBeNull();
    expect(pages[0]?.reply.order).toEqual({ key: "rank", direction: "desc" });
  });
  it("[MC19] a request order on another column (kind asc) overrides the view order and ties by id", async () => {
    const env = await open(pagedBundle());
    const pages = await jsonPages(env, "inspect_view", { ...ARGS, order: { key: "kind", direction: "asc" } }, 2048);
    expect(describeSequenceDifference(BY_KIND, pages.flatMap((p) => p.reply.items.map((i: { id: string }) => i.id)))).toBeNull();
  });
  it("[MC19] text chain gives the same order as JSON (header line 'order: rank asc'; ids from the entity lines)", async () => {
    const env = await open(pagedBundle());
    const pages = await textPages(env, "inspect_view", ARGS, 2048);
    expect(describeSequenceDifference(ASC, pages.flatMap((p) => entityIdsOfLines(p.reply.body)))).toBeNull();
    expect(pages.every((p) => p.reply.header.order === "rank asc")).toBe(true);
    expect(pages.length).toBeGreaterThanOrEqual(2); // 13 x ~230 text bytes > 2048
  });
  it("[MC19] numbers sort numerically: rank 9 before rank 10 (a lexicographic sort would put 10 first)", async () => {
    const env = await open(pagedBundle());
    const reply = okJson(await env.call("inspect_view", { ...ARGS, format: "json", maxBytes: 32768 }));
    const ids: string[] = reply.items.map((i: { id: string }) => i.id);
    expect(ids.indexOf("t-1")).toBeLessThan(ids.indexOf("u-1"));
    expect(ids).toEqual(ASC);
  });
});

describe("[MC19] cursors are bound to their query", () => {
  // why: red-contract 3: "Another filter/order/snapshot -> CURSOR_MISMATCH; garbage -> CURSOR_INVALID" (design 4: "It cannot
  // be reused against a different query"). Each mismatch below changes exactly ONE member of the bound tuple.
  // proves: CLAIM(MC19) cursor binding.
  async function firstCursor(env: OpsEnv, extra: Record<string, unknown> = {}) {
    const outcome = await env.call("inspect_view", { ...ARGS, format: "json", maxBytes: 2048, ...extra });
    okJson(outcome);
    if (!outcome.ok || outcome.cursor === null) return assert.fail("the first page must have a cursor (13 rows do not fit 2048 bytes)");
    return outcome.cursor;
  }
  const cursorPointer = (outcome: OperationOutcome) => failure(outcome).errors.map((issue) => issue.pointer);

  it("[MC19] positive control: the cursor continues the same query at the right position", async () => {
    const env = await open(pagedBundle());
    const first = okJson(await env.call("inspect_view", { ...ARGS, format: "json", maxBytes: 2048 }));
    const cursor = first.cursor as string;
    const second = okJson(await env.call("inspect_view", { ...ARGS, format: "json", maxBytes: 2048, cursor }));
    const ids = [...first.items, ...second.items].map((i: { id: string }) => i.id);
    expect(ids).toEqual(ASC.slice(0, ids.length)); // the second page starts exactly where the first stopped
    expect(second.items.length).toBeGreaterThanOrEqual(1);
  });
  it("[MC19] changing the filter -> CURSOR_MISMATCH at /cursor (filter vs no filter, and filter A vs filter B)", async () => {
    const env = await open(pagedBundle());
    const unfiltered = await firstCursor(env);
    const withFilter = await env.call("inspect_view", { ...ARGS, format: "json", maxBytes: 2048, cursor: unfiltered, filter: { text: "alpha" } });
    expect(failure(withFilter).code).toBe("CURSOR_MISMATCH");
    expect(cursorPointer(withFilter)).toEqual(["/cursor"]);
    const readCursor = await firstCursor(env, { filter: { provenance: ["read"] } });
    const otherFilter = await env.call("inspect_view", { ...ARGS, format: "json", maxBytes: 2048, cursor: readCursor, filter: { provenance: ["compiled"] } });
    expect(failure(otherFilter).code).toBe("CURSOR_MISMATCH");
  });
  it("[MC19] changing the order -> CURSOR_MISMATCH", async () => {
    const env = await open(pagedBundle());
    const cursor = await firstCursor(env);
    const outcome = await env.call("inspect_view", { ...ARGS, format: "json", maxBytes: 2048, cursor, order: { key: "rank", direction: "desc" } });
    expect(failure(outcome).code).toBe("CURSOR_MISMATCH");
    expect(cursorPointer(outcome)).toEqual(["/cursor"]);
  });
  it("[MC19] a second snapshot of the same view id -> CURSOR_MISMATCH; the same cursor still works on snap-1", async () => {
    const env = await open(pagedBundle());
    const cursor = await firstCursor(env);
    const moved = await env.call("inspect_view", { viewId: "paged", snapshotId: "snap-2", format: "json", maxBytes: 2048, cursor });
    expect(failure(moved).code).toBe("CURSOR_MISMATCH");
    expect(cursorPointer(moved)).toEqual(["/cursor"]);
    const same = await env.call("inspect_view", { ...ARGS, format: "json", maxBytes: 2048, cursor });
    expect(okJson(same).counts.matched).toBe(13);
  });
  it("[MC19] a different view id with identical content -> CURSOR_MISMATCH (the cursor binds the view)", async () => {
    const env = await open(pagedBundle());
    const cursor = await firstCursor(env);
    const outcome = await env.call("inspect_view", { viewId: "paged-b", snapshotId: "snap-1", format: "json", maxBytes: 2048, cursor });
    expect(failure(outcome).code).toBe("CURSOR_MISMATCH");
  });

  // why: red-contract 3 says the cursor binds viewId, snapshotId, filter, order and position only; a client must be
  // able to shrink or grow its budget (and switch format) mid-chain without restarting.
  // proves: CLAIM(MC19) budget and format are not part of the binding.
  it("[MC19] a cursor from maxBytes 2048 continues at 4096 and the pages still concatenate to ASC", async () => {
    const env = await open(pagedBundle());
    const first = okJson(await env.call("inspect_view", { ...ARGS, format: "json", maxBytes: 2048 }));
    const rest = await followCursors(async (cursor) => {
      const use = cursor ?? (first.cursor as string); // the first call resumes from the 2048-byte page's cursor
      const outcome = await env.call("inspect_view", { ...ARGS, format: "json", maxBytes: 4096, cursor: use });
      const reply = okJson(outcome);
      return { ids: reply.items.map((i: { id: string }) => i.id) as string[], cursor: outcome.ok ? outcome.cursor : null };
    });
    const ids = [...first.items.map((i: { id: string }) => i.id), ...rest.flatMap((p) => p.ids)];
    expect(describeSequenceDifference(ASC, ids)).toBeNull();
  });
  it("[MC19] a cursor taken from a JSON page continues in text format", async () => {
    const env = await open(pagedBundle());
    const first = okJson(await env.call("inspect_view", { ...ARGS, format: "json", maxBytes: 2048 }));
    const text = okText(await env.call("inspect_view", { ...ARGS, format: "text", maxBytes: 32768, cursor: first.cursor }));
    const ids = [...first.items.map((i: { id: string }) => i.id), ...entityIdsOfLines(text.body)];
    expect(describeSequenceDifference(ASC, ids)).toBeNull();
    expect(text.cursor).toBeNull();
  });

  // proves: CLAIM(MC19) malformed and tampered cursors are CURSOR_INVALID, distinct from CURSOR_MISMATCH.
  it.each(["not-a-cursor", "!!!", "e30"])("[MC19] garbage cursor %j -> CURSOR_INVALID at /cursor", async (garbage) => {
    const env = await open(pagedBundle());
    const outcome = await env.call("inspect_view", { ...ARGS, cursor: garbage });
    expect(failure(outcome).code).toBe("CURSOR_INVALID");
    expect(cursorPointer(outcome)).toEqual(["/cursor"]);
  });
  it("[MC19] a truncated cursor and a cursor with one changed character are CURSOR_INVALID", async () => {
    const env = await open(pagedBundle());
    const cursor = await firstCursor(env);
    const truncated = cursor.slice(0, Math.floor(cursor.length / 2));
    const middle = Math.floor(cursor.length / 2);
    const tampered = cursor.slice(0, middle) + (cursor[middle] === "A" ? "B" : "A") + cursor.slice(middle + 1);
    expect(tampered).not.toBe(cursor);
    expect(failure(await env.call("inspect_view", { ...ARGS, cursor: truncated })).code).toBe("CURSOR_INVALID");
    expect(failure(await env.call("inspect_view", { ...ARGS, cursor: tampered })).code).toBe("CURSOR_INVALID");
  });
});

describe("[MC19] filter semantics and counts", () => {
  // why: matched must equal an independent count of the filter over the rows; members AND together (red-contract 3).
  // text is a case-insensitive substring of the LABEL or any STRING cell: the numeric rank 5 is not found by text "5".
  // Expected lists are literal (derived from the dataset table above, in rank-asc order) and cross-checked with filterRows.
  // proves: CLAIM(MC19) filter semantics and counts.
  const cases: Array<[title: string, filter: Record<string, unknown>, expected: string[]]> = [
    ["text matches a LABEL, case-insensitively ('GAMMA' -> label 'Gamma note')", { text: "GAMMA" }, ["r-a"]],
    ["text matches a string cell ('q-m' occurs only in the name of q-m)", { text: "q-m" }, ["q-m"]],
    ["text on a string cell is case-insensitive ('ALPHA' -> kind alpha)", { text: "ALPHA" }, ["q-m", "r-a", "r-c", "r-e", "r-g", "t-2"]],
    ["text never matches a numeric cell ('5' is the rank of seven rows)", { text: "5" }, []],
    ["columns: exact equality on a number", { columns: { rank: 5 } }, ["r-a", "r-b", "r-c", "r-d", "r-e", "r-f", "r-g"]],
    ["columns: the string '5' is not the number 5", { columns: { rank: "5" } }, []],
    ["columns AND together", { columns: { rank: 5, kind: "alpha" } }, ["r-a", "r-c", "r-e", "r-g"]],
    ["provenance is any-of", { provenance: ["observed", "compiled"] }, ["q-m", "t-1", "u-1"]],
    ["text AND provenance", { text: "alpha", provenance: ["compiled"] }, ["q-m"]],
  ];
  it.each(cases)("[MC19] %s", async (_title, filter, expected) => {
    const env = await open(pagedBundle());
    const reply = okJson(await env.call("inspect_view", { ...ARGS, format: "json", maxBytes: 32768, filter }));
    expect(reply.items.map((i: { id: string }) => i.id)).toEqual(expected);
    expect(reply.counts).toEqual({ unit: "rows", total: 13, matched: expected.length, returned: expected.length, omitted: 0, truncated: false });
    // the oracle agrees with the hand-derived literal (as a set; the literal carries the order)
    const independent = filterRows(dataRows(), filter as Parameters<typeof filterRows>[1]).map((r) => r.id as string).sort();
    expect(independent).toEqual([...expected].sort());
    expect(reply.filters).toEqual(filter);
  });
  it("[MC19] the header filters line lists members in contract order: text, columns.<key>, provenance", async () => {
    const env = await open(pagedBundle());
    const reply = okText(await env.call("inspect_view", { ...ARGS, filter: { provenance: ["read", "observed"], columns: { rank: 5 }, text: "alpha" } }));
    expect(reply.header.filters).toBe('text="alpha" columns.rank=5 provenance=read,observed');
    expect(reply.counts).toMatchObject({ total: 13, matched: 4, returned: 4 }); // alpha AND rank 5 AND read: r-a r-c r-e r-g
    expect(reply.header.filters).not.toBe("none");
  });
  it("[MC19] with no filter the header says 'filters: none'", async () => {
    const env = await open(pagedBundle());
    expect(okText(await env.call("inspect_view", ARGS)).header.filters).toBe("none");
  });
  it("[MC19] filtered counts hold along a cursor chain: matched 6 for text 'alpha', total stays 13, ids in order", async () => {
    const env = await open(pagedBundle());
    const pages = await jsonPages(env, "inspect_view", { ...ARGS, filter: { text: "alpha" } }, 2048);
    expect(pages.flatMap((p) => p.reply.items.map((i: { id: string }) => i.id))).toEqual(["q-m", "r-a", "r-c", "r-e", "r-g", "t-2"]);
    for (const page of pages) expect(page.reply.counts).toMatchObject({ total: 13, matched: 6 });
  });

  // proves: CLAIM(MC19) graph relation filter.
  it("[MC19] graph: relation filter keeps edges with any given relation; unit edges, total 5", async () => {
    // edges by id: e-1 calls, e-2 imports, e-3 calls, e-4 reads, e-5 imports
    const graph = graphView({
      id: "g-rel", definitionId: "def-g-rel", completeness: complete("five edges"), paths: null,
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("e-3", "c", "a", "calls"), edge("e-1", "a", "b", "calls"), edge("e-5", "a", "c", "imports"), edge("e-2", "b", "c", "imports"), edge("e-4", "b", "a", "reads")],
    });
    const env = await open(bundleOf([graph]));
    const query = (filter: Record<string, unknown>) => env.call("inspect_view", { viewId: "g-rel", snapshotId: "snap-1", format: "json", filter });
    const calls = okJson(await query({ relation: ["calls"] }));
    expect(calls.items.map((i: { id: string }) => i.id)).toEqual(["e-1", "e-3"]);
    expect(calls.counts).toEqual({ unit: "edges", total: 5, matched: 2, returned: 2, omitted: 0, truncated: false });
    const two = okJson(await query({ relation: ["calls", "reads"] }));
    expect(two.items.map((i: { id: string }) => i.id)).toEqual(["e-1", "e-3", "e-4"]);
    const none = okJson(await query({ relation: ["no-such-relation"] }));
    expect(none.counts).toMatchObject({ total: 5, matched: 0 });
    const text = okText(await env.call("inspect_view", { viewId: "g-rel", snapshotId: "snap-1", filter: { relation: ["calls"] } }));
    expect(text.header.filters).toBe("relation=calls");
  });

  // proves: CLAIM(MC19) notebook claim status filter.
  it("[MC19] notebook: a status filter keeps only claims with that status, in authored order; prose and view blocks never match", async () => {
    const blocks = [
      proseBlock("p1", "Why?"), claimBlock("c-1", "first", "supported"), claimBlock("c-2", "second", "open"),
      viewBlock("v-1", "modules"), claimBlock("c-3", "third", "disputed"), claimBlock("c-4", "fourth", "open"),
    ];
    const env = await open(bundleOf([listView(), notebookView({ id: "nb-status", definitionId: "def-nb-status", blocks })]));
    const query = async (status: string[]) => okJson(await env.call("inspect_view", { viewId: "nb-status", snapshotId: "snap-1", format: "json", filter: { status } }));
    const open_ = await query(["open"]);
    expect(open_.items.map((i: { id: string }) => i.id)).toEqual(["c-2", "c-4"]);
    expect(open_.counts).toEqual({ unit: "blocks", total: 6, matched: 2, returned: 2, omitted: 0, truncated: false });
    expect((await query(["open", "disputed"])).items.map((i: { id: string }) => i.id)).toEqual(["c-2", "c-3", "c-4"]);
    expect((await query(["supported"])).items.map((i: { id: string }) => i.id)).toEqual(["c-1"]);
    const text = okText(await env.call("inspect_view", { viewId: "nb-status", snapshotId: "snap-1", filter: { status: ["open"] } }));
    expect(text.header.filters).toBe("status=open");
  });

  // proves: CLAIM(MC19) tree filter keeps ancestors as context, not counted.
  describe("tree filter keeps ancestors as context, uncounted", () => {
    // R "root" -> [A "alpha dir" -> [A1 "alpha-one.txt", A2 "two.txt"], B "beta dir" -> [B1 "one.txt"]]; 6 nodes.
    const NODES = [
      treeNode("R", "root", ["A", "B"]), treeNode("A", "alpha dir", ["A1", "A2"]), treeNode("A1", "alpha-one.txt"),
      treeNode("A2", "two.txt"), treeNode("B", "beta dir", ["B1"]), treeNode("B1", "one.txt"),
    ];
    const treeBundle = () => bundleOf([treeView({ id: "tr", definitionId: "def-tr", roots: ["R"], nodes: NODES, completeness: complete("six nodes") })]);
    const names = new Map(NODES.map((n) => [n.id as string, (n.cells as { name: string }).name]));
    const independent = (needle: string) =>
      treeFilter(["R"], NODES.map((n) => ({ id: n.id as string, children: n.children as string[] })), (id) => (names.get(id) as string).toLowerCase().includes(needle));

    it("[MC19] text 'ALPHA': matches A and A1; R is context; B, A2, B1 are dropped; matched 2 of total 6", async () => {
      const env = await open(treeBundle());
      const reply = okJson(await env.call("inspect_view", { viewId: "tr", snapshotId: "snap-1", format: "json", filter: { text: "ALPHA" } }));
      expect(reply.items.map((i: { id: string }) => i.id)).toEqual(["R", "A", "A1"]);
      expect(reply.items.filter((i: { context?: boolean }) => i.context === true).map((i: { id: string }) => i.id)).toEqual(["R"]);
      expect(reply.counts).toEqual({ unit: "nodes", total: 6, matched: 2, returned: 2, omitted: 0, truncated: false });
      expect(independent("alpha")).toEqual({ matched: ["A", "A1"], context: ["R"], preorder: ["R", "A", "A1"] });
    });
    it("[MC19] text 'one': matches A1 and B1; R, A, B are context (3 ancestors) and are NOT counted", async () => {
      const env = await open(treeBundle());
      const reply = okJson(await env.call("inspect_view", { viewId: "tr", snapshotId: "snap-1", format: "json", filter: { text: "one" } }));
      expect(reply.items.map((i: { id: string }) => i.id)).toEqual(["R", "A", "A1", "B", "B1"]);
      expect(reply.items.filter((i: { context?: boolean }) => i.context === true).map((i: { id: string }) => i.id)).toEqual(["R", "A", "B"]);
      expect(reply.counts).toMatchObject({ total: 6, matched: 2, returned: 2 });
      expect(independent("one").context).toEqual(["R", "A", "B"]);
    });
    it("[MC19] text: context lines are flagged 'context', matching lines are not", async () => {
      const env = await open(treeBundle());
      const reply = okText(await env.call("inspect_view", { viewId: "tr", snapshotId: "snap-1", filter: { text: "ALPHA" } }));
      const contextLines = reply.body.filter((l) => l.includes("context"));
      expect(contextLines).toHaveLength(1);
      expect(contextLines[0]).toContain("root");
      expect(reply.body.filter((l) => l.includes("alpha-one.txt") && l.includes("context"))).toEqual([]);
    });
  });
});
