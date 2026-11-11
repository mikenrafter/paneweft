// scope: tests of the OPERATION-LAYER TEST ORACLES (test/helpers/ops-*.ts), not of src/. These are green by
// design in the red phase. why: the operation suites compute expected clipping, ordering, filtering, search
// ranking and cursor chains with these helpers; each helper is proved here against hand-checked cases so a
// wrong oracle cannot bless or condemn an implementation.
import { describe, expect, it } from "vitest";
import {
  clipToBytes, codePointBytes, compareScalar, describeSequenceDifference, filterRows, followCursors, isWellFormedUtf8Text,
  modelPager, orderRows, rankSearch, searchTier, treeFilter, utf8Length, type OracleRow, type SearchDocument,
} from "./ops-oracle.ts";
import { assertChainCounts, entityIdsOfLines, parseTextReply } from "./ops-env.ts";

describe("oracle: UTF-8 clipping", () => {
  // derivation: U+20AC encodes to 3 bytes (E2 82 AC); U+1F600 to 4 bytes (F0 9F 98 80); U+00E9 to 2 bytes; ASCII to 1.
  it("[MC3] codePointBytes follows the UTF-8 length classes at their boundaries", () => {
    expect([0x00, 0x7f, 0x80, 0x7ff, 0x800, 0xffff, 0x10000, 0x10ffff].map(codePointBytes)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });
  it("[MC3] clipToBytes never ends inside a code point: 3-byte characters", () => {
    // "€€€" is 9 bytes; the answer for each budget is the number of whole characters that fit: floor(max / 3).
    const text = "€€€";
    expect([9, 8, 6, 5, 3, 2, 0].map((max) => clipToBytes(text, max))).toEqual(["€€€", "€€", "€€", "€", "€", "", ""]);
  });
  it("[MC3] clipToBytes treats an astral emoji as one 4-byte unit, never as two surrogates", () => {
    // "a😀b" = 1 + 4 + 1 bytes. Budget 4: 'a' fits (1), the emoji would reach 5 -> stop. Budget 5 fits 'a😀'.
    const text = "a😀b";
    expect([6, 5, 4, 1, 0].map((max) => clipToBytes(text, max))).toEqual(["a😀b", "a😀", "a", "a", ""]);
    expect(isWellFormedUtf8Text(clipToBytes(text, 4))).toBe(true);
  });
  it("[MC3] clipToBytes stops at the first character that does not fit even if a later one would (mixed widths)", () => {
    // "€a€": 3, then 1 (total 4), then 3 (total 7). Budget 6 -> "€a", NOT "€a" plus skipping to fit something else.
    expect(clipToBytes("€a€", 6)).toBe("€a");
    expect(clipToBytes("é", 1)).toBe("");
    expect(clipToBytes("", 10)).toBe("");
  });
  it("[MC3] clipToBytes agrees with Buffer.byteLength on the clipped result (cross-check of the arithmetic)", () => {
    const text = "x€😀é".repeat(20);
    const total = utf8Length(text); // 20 * (1 + 3 + 4 + 2) = 200
    expect(total).toBe(200);
    for (let max = 0; max < total; max += 1) {
      const clipped = clipToBytes(text, max);
      expect(utf8Length(clipped)).toBeLessThanOrEqual(max);
      expect(text.startsWith(clipped)).toBe(true);
      // maximality: the next code point (there is one, max < total) would exceed the budget
      const next = [...text.slice(clipped.length)][0] as string;
      expect(utf8Length(clipped) + utf8Length(next)).toBeGreaterThan(max);
    }
    expect(clipToBytes(text, total)).toBe(text);
    expect(clipToBytes(text, total + 7)).toBe(text);
  });
  it("[MC3] isWellFormedUtf8Text rejects U+FFFD and lone surrogates, accepts multibyte text", () => {
    expect(isWellFormedUtf8Text("ok €😀 é")).toBe(true);
    expect(isWellFormedUtf8Text("bad \uFFFD")).toBe(false);
    expect(isWellFormedUtf8Text("lone \ud83d surrogate")).toBe(false);
  });
});

describe("oracle: ordering and filtering", () => {
  const cell = (id: string, rank: number, extra: Partial<OracleRow> = {}): OracleRow => ({ id, cells: { rank }, provenance: "read", ...extra });
  const rows = [cell("b", 5), cell("a", 5), cell("c", 1), cell("d", 10), cell("e", 9)];
  it("[MC19] compareScalar orders numbers numerically and strings by code unit, with a fixed type order", () => {
    expect(compareScalar(9, 10)).toBe(-1); // numeric, not lexicographic
    expect(compareScalar("10", "9")).toBe(-1); // strings are lexicographic
    expect(compareScalar("B", "a")).toBe(-1); // 'B' (66) < 'a' (97): code-unit, not locale, order
    expect([true, "", 0, null, false].sort(compareScalar)).toEqual([null, false, true, 0, ""]);
  });
  it("[MC19] orderRows: ascending, ties broken by id ascending", () => {
    // by hand: rank 1 -> c; rank 5 -> a, b (id tie-break); rank 9 -> e; rank 10 -> d.
    expect(orderRows(rows, { key: "rank", direction: "asc" }).map((r) => r.id)).toEqual(["c", "a", "b", "e", "d"]);
  });
  it("[MC19] orderRows: descending reverses the key but keeps the id tie-break ascending", () => {
    // by hand: rank 10 -> d; 9 -> e; 5 -> a, b; 1 -> c
    expect(orderRows(rows, { key: "rank", direction: "desc" }).map((r) => r.id)).toEqual(["d", "e", "a", "b", "c"]);
  });
  it("[MC19] orderRows does not mutate its input", () => {
    const before = rows.map((r) => r.id);
    orderRows(rows, { key: "rank", direction: "asc" });
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  const filterable: OracleRow[] = [
    { id: "r1", label: "Gamma", cells: { name: "Alpha Beta", rank: 5 }, provenance: "read" },
    { id: "r2", cells: { name: "delta", rank: 6 }, provenance: "observed" },
    { id: "r3", cells: { name: "ALPHA two", rank: 5 }, provenance: "compiled" },
  ];
  const ids = (list: OracleRow[]) => list.map((r) => r.id);
  it("[MC19] filterRows text: case-insensitive, matches label or string cells, never numeric cells", () => {
    expect(ids(filterRows(filterable, { text: "alpha" }))).toEqual(["r1", "r3"]); // cell 'Alpha Beta' and 'ALPHA two'
    expect(ids(filterRows(filterable, { text: "GAMMA" }))).toEqual(["r1"]); // label only
    expect(ids(filterRows(filterable, { text: "5" }))).toEqual([]); // rank is the NUMBER 5, not a string cell
  });
  it("[MC19] filterRows columns: exact equality by type; unknown columns match nothing", () => {
    expect(ids(filterRows(filterable, { columns: { rank: 5 } }))).toEqual(["r1", "r3"]);
    expect(ids(filterRows(filterable, { columns: { rank: "5" } }))).toEqual([]);
    expect(ids(filterRows(filterable, { columns: { nope: 5 } }))).toEqual([]);
  });
  it("[MC19] filterRows provenance is any-of and members AND together", () => {
    expect(ids(filterRows(filterable, { provenance: ["read", "observed"] }))).toEqual(["r1", "r2"]);
    expect(ids(filterRows(filterable, { provenance: ["read", "observed"], columns: { rank: 5 } }))).toEqual(["r1"]);
  });
});

describe("oracle: search ranking", () => {
  const docs: SearchDocument[] = [
    { type: "claim", id: "c1", texts: ["cancel"] },
    { type: "view", id: "v2", texts: ["Never cancelled", "other question"] },
    { type: "entity", id: "e3", texts: ["Uncancelled"] },
    { type: "example", id: "x1", texts: ["Cancel then retry"] },
    { type: "entity", id: "e2", texts: ["Cancellation"] },
    { type: "view", id: "v1", texts: ["Cancel"] },
    { type: "entity", id: "e1", texts: ["cancel"] },
    { type: "entity", id: "zz", texts: ["unrelated"] },
  ];
  it("[MC19] searchTier: exact 0, prefix 1, substring 2, none null; best of several texts", () => {
    expect(searchTier(["Cancel"], "cancel")).toBe(0);
    expect(searchTier(["Cancel then retry"], "cancel")).toBe(1);
    expect(searchTier(["Never cancelled"], "cancel")).toBe(2);
    expect(searchTier(["x", "cancel"], "cancel")).toBe(0);
    expect(searchTier(["other"], "cancel")).toBeNull();
  });
  it("[MC19] rankSearch: tier first, then entity<view<example<claim, then id; non-matches dropped", () => {
    // by hand. exact: e1(entity), v1(view), c1(claim). prefix: e2(entity), x1(example). substring: e3(entity), v2(view).
    expect(rankSearch(docs, "cancel").map((d) => `${d.type}:${d.id}`)).toEqual([
      "entity:e1", "view:v1", "claim:c1", "entity:e2", "example:x1", "entity:e3", "view:v2",
    ]);
  });
  it("[MC19] rankSearch breaks a full tie by id in code-unit order", () => {
    const tied: SearchDocument[] = [
      { type: "entity", id: "b", texts: ["same"] },
      { type: "entity", id: "B", texts: ["same"] },
      { type: "entity", id: "a", texts: ["same"] },
    ];
    expect(rankSearch(tied, "same").map((d) => d.id)).toEqual(["B", "a", "b"]); // 'B' (66) < 'a' (97) < 'b' (98)
  });
});

describe("oracle: tree filter with ancestor context", () => {
  // R -> [A -> [A1, A2], B -> [B1]]
  const nodes = [
    { id: "R", children: ["A", "B"] }, { id: "A", children: ["A1", "A2"] }, { id: "A1", children: [] },
    { id: "A2", children: [] }, { id: "B", children: ["B1"] }, { id: "B1", children: [] },
  ];
  it("[MC19] a deep match keeps only its ancestors as context", () => {
    expect(treeFilter(["R"], nodes, (id) => id === "A1")).toEqual({ matched: ["A1"], context: ["R", "A"], preorder: ["R", "A", "A1"] });
  });
  it("[MC19] a matching ancestor is a match, not context; siblings of matches are dropped", () => {
    expect(treeFilter(["R"], nodes, (id) => id === "A" || id === "A2")).toEqual({ matched: ["A", "A2"], context: ["R"], preorder: ["R", "A", "A2"] });
  });
  it("[MC19] no match keeps nothing", () => {
    expect(treeFilter(["R"], nodes, () => false)).toEqual({ matched: [], context: [], preorder: [] });
  });
});

describe("oracle: cursor chain follower", () => {
  it("[MC3] followCursors concatenates a model pager exactly once and ends on a null cursor", async () => {
    const items = ["a", "b", "c", "d", "e", "f", "g"];
    const pages = await followCursors(modelPager(items, 3));
    expect(pages.map((p) => p.items)).toEqual([["a", "b", "c"], ["d", "e", "f"], ["g"]]);
    expect(pages.map((p) => p.cursor)).toEqual(["3", "6", null]);
  });
  it("[MC3] followCursors fails on a pager that repeats a cursor (no progress)", async () => {
    await expect(followCursors(async () => ({ cursor: "same" }))).rejects.toThrow(/repeated cursor token after 2 pages/);
  });
  it("[MC3] followCursors fails on a pager that never ends", async () => {
    let n = 0;
    await expect(followCursors(async () => ({ cursor: `c${n++}` }), 5)).rejects.toThrow(/more than 5 pages/);
  });
  it("[MC19] describeSequenceDifference is null for equal sequences and names duplicates and the first difference", () => {
    expect(describeSequenceDifference(["a", "b"], ["a", "b"])).toBeNull();
    expect(describeSequenceDifference(["a", "b", "c"], ["a", "b", "b"])).toContain('duplicates=["b"]');
    expect(describeSequenceDifference(["a", "b", "c"], ["a", "c", "b"])).toContain('first difference at 1: expected "b", got "c"');
    expect(describeSequenceDifference(["a", "b"], ["a"])).toContain("expected 2 ids, got 1");
  });
});

describe("helpers: text reply parser (red-contract section 3 shape)", () => {
  const header = [
    "paneweft.reply/1 view=modules component=list",
    "question: What is in this set, and which members matter?",
    "snapshot: snap-1",
    "completeness: complete (all modules in the fixture)",
    "freshness: fresh",
    "provenance: read=1 parsed=0 compiled=0 observed=0 inferred=0",
    "evidence: sources=s1",
    "filters: none",
    "order: name asc",
    "counts: unit=rows total=6 matched=6 returned=1 omitted=5 truncated=true",
  ];
  const golden = [...header, "1/6 matched rows returned; 5 omitted", "mcp.rs -> code/module:mcp; read; s1", "cursor: abc.def"].join("\n");
  it("[MC3] parses the golden: ids, counts, body lines and cursor", () => {
    const reply = parseTextReply(golden);
    expect(reply.view).toBe("modules");
    expect(reply.component).toBe("list");
    expect(reply.header.snapshot).toBe("snap-1");
    expect(reply.counts).toEqual({ unit: "rows", total: 6, matched: 6, returned: 1, omitted: 5, truncated: true });
    expect(reply.body).toEqual(["1/6 matched rows returned; 5 omitted", "mcp.rs -> code/module:mcp; read; s1"]);
    expect(reply.cursor).toBe("abc.def");
  });
  it("[MC3] a trailing newline and a missing cursor line are accepted (cursor null)", () => {
    const reply = parseTextReply([...header, "0/6 matched rows returned; 0 omitted"].join("\n") + "\n");
    expect(reply.cursor).toBeNull();
    expect(reply.body).toEqual(["0/6 matched rows returned; 0 omitted"]);
  });
  it("[MC3] rejects a header whose lines are out of contract order, or whose first line is wrong", () => {
    const swapped = [...header];
    [swapped[2], swapped[3]] = [swapped[3] as string, swapped[2] as string];
    expect(() => parseTextReply(swapped.join("\n"))).toThrow(/header line 3 must start with "snapshot: "/);
    expect(() => parseTextReply(["paneweft.reply/2 view=x component=list", ...header.slice(1)].join("\n"))).toThrow(/first line/);
  });
  it("[MC3] rejects a header with a second completeness line (header must be exactly the nine keys)", () => {
    const doubled = [...header.slice(0, 4), "completeness: partial (1 gaps; first: g: q)", ...header.slice(4)];
    expect(() => parseTextReply(doubled.join("\n"))).toThrow(/header line 5 must start with "freshness: "/);
  });
  it("[MC3] entityIdsOfLines extracts ids from list lines and ignores other body lines", () => {
    expect(entityIdsOfLines(["1/2 matched rows returned; 1 omitted", "€€001😀 -> code/module:w-001; read; s1", "x -> (no entity); read; s1", "y -> code/module:w-002; compiled; s1,s2"]))
      .toEqual(["w-001", "w-002"]);
  });
});

describe("helpers: chain count invariants", () => {
  // 7 items in pages of 3: returned 3,3,1; omitted AFTER each page 4,1,0; cursors non-null,non-null,null.
  const good = [
    { counts: { total: 9, matched: 7, returned: 3, omitted: 4 }, cursor: "a" },
    { counts: { total: 9, matched: 7, returned: 3, omitted: 1 }, cursor: "b" },
    { counts: { total: 9, matched: 7, returned: 1, omitted: 0 }, cursor: null },
  ];
  it("[MC3] accepts a hand-checked chain", () => {
    expect(() => assertChainCounts(good, { total: 9, matched: 7 })).not.toThrow();
  });
  it("[MC3] rejects: a lost item, a cursor on the last page, a changed matched count", () => {
    const lost = [good[0]!, { counts: { total: 9, matched: 7, returned: 2, omitted: 0 }, cursor: null }];
    expect(() => assertChainCounts(lost, { total: 9, matched: 7 })).toThrow(/offset\+returned\+omitted/);
    const dangling = [good[0]!, good[1]!, { counts: { total: 9, matched: 7, returned: 1, omitted: 0 }, cursor: "zz" }];
    expect(() => assertChainCounts(dangling, { total: 9, matched: 7 })).toThrow(/cursor is null iff omitted = 0/);
    expect(() => assertChainCounts(good, { total: 9, matched: 8 })).toThrow(/matched/);
  });
});
