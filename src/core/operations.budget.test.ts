// why: CLAIM(MC3) "Text and JSON replies honor their byte budget" at the public operation boundary
// (design 4 "Shared envelope and bounded answers"; red-contract 3 "Bounded replies"). Real Session, real
// bundles, raw-Ajv validation of every JSON body. Expected values are hand-derived or come from the
// independent oracles in test/helpers/ops-oracle.ts (proved by ops-oracle.test.ts); nothing is imported from
// src/ except the function under test. Decisions the contract leaves open are in docs/contract-additions/ops.md.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, allBundle } from "../../test/helpers/fixtures.ts";
import {
  assertBodyWithin, assertChainCounts, cursorOf, entityIdsOfLines, failure, fragmentsOfJson, fragmentsOfText, jsonPages, okJson, okText, pendingAfter, plainItemsOfJson, reassemble,
  textPages, useOps, validateAgainst, type FragmentPiece, type OpsEnv,
} from "../../test/helpers/ops-env.ts";
import {
  describeSequenceDifference, followCursors, orderRows, rankSearch, utf8Length, type SearchDocument,
} from "../../test/helpers/ops-oracle.ts";
import {
  bundleOf, complete, claimBlock, entityAt, exampleView, listView, moduleRef, notebookView, partial, row, wideListView, wideRows,
} from "../../test/helpers/ops-views.ts";

const open = useOps();
const WIDE = { viewId: "wide", snapshotId: "snap-1" };
const wideBundle = () => bundleOf([wideListView()]);
// expected order of the 200 wide rows: the view's order (name asc), ties by id (names are unique here).
// two small rows beneath a 6 KB mandatory header (question and criterion are 1024 three-byte characters each: the schema maximum)
const BIG = "€".repeat(1024);
const rows = [row("a", { name: "a" }, { entity: moduleRef("a") }), row("b", { name: "b" }, { entity: moduleRef("b") })];
const wideExpectedIds = () => orderRows(wideRows(), { key: "name", direction: "asc" }).map((r) => r.id as string);

describe("[MC3] bounded list replies: multibyte labels, 200 rows", () => {
  // why: a reply slicer that works on characters or on serialized text breaks on 3-byte "€" and 4-byte emoji;
  // every row here is made of them, so almost every byte offset of a naive cut is inside a code point.
  // proves: CLAIM(MC3) Buffer.byteLength(body) <= maxBytes, JSON parses, text round-trips, counts are exact.
  const cases: Array<[format: "text" | "json", maxBytes: number, mustOmit: boolean]> = [
    ["text", 2048, true], ["json", 2048, true],
    ["text", 8192, true], ["json", 8192, true],
    // text rows are ~60 bytes: 200 of them may fit 32768, so omission is only certain for JSON (>= 150 bytes per row).
    ["text", 32768, false], ["json", 32768, true],
  ];
  it.each(cases)("[MC3] %s at maxBytes %i: within budget, well-formed, exact counts", async (format, maxBytes, mustOmit) => {
    const env = await open(wideBundle());
    const outcome = await env.call("inspect_view", { ...WIDE, format, maxBytes });
    assertBodyWithin(outcome.body, maxBytes);
    const reply = format === "json" ? okJson(outcome) : okText(outcome);
    const counts = reply.counts;
    const itemLines = format === "json" ? reply.items.length : entityIdsOfLines(reply.body).length;
    // derivation: 200 generated rows, no filter -> total = matched = 200; every returned or omitted row is accounted for.
    expect(counts.unit).toBe("rows");
    expect(counts.total).toBe(200);
    expect(counts.matched).toBe(200);
    expect(counts.returned + counts.omitted).toBe(200);
    expect(counts.returned).toBeGreaterThanOrEqual(1);
    expect(counts.truncated).toBe(counts.omitted > 0);
    expect(cursorOf(outcome) === null).toBe(counts.omitted === 0);
    expect(!mustOmit || counts.omitted > 0).toBe(true);
    expect(itemLines).toBe(counts.returned);
  });

  // why: "usable cursor chain": following cursors yields every row exactly once, in the view's order, within budget.
  // proves: CLAIM(MC3) cursor chain; counts along the chain follow docs/contract-additions/ops.md section 2.
  it.each([2048, 8192, 32768])("[MC3] JSON cursor chain at maxBytes %i returns the 200 expected ids exactly once, in order", async (maxBytes) => {
    const env = await open(wideBundle());
    const pages = await jsonPages(env, "inspect_view", WIDE, maxBytes);
    const ids = pages.flatMap((page) => page.reply.items.map((item: { id: string }) => item.id));
    expect(describeSequenceDifference(wideExpectedIds(), ids)).toBeNull();
    // JSON rows are >= 150 bytes each: 200 rows never fit one page of at most 32768 bytes.
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[pages.length - 1]?.cursor).toBeNull();
    assertChainCounts(pages.map((p) => ({ counts: p.reply.counts, cursor: p.cursor })), { total: 200, matched: 200 });
  });
  it.each([2048, 8192])("[MC3] text cursor chain at maxBytes %i returns the 200 expected ids exactly once, in order", async (maxBytes) => {
    const env = await open(wideBundle());
    const pages = await textPages(env, "inspect_view", WIDE, maxBytes);
    const ids = pages.flatMap((page) => entityIdsOfLines(page.reply.body));
    expect(describeSequenceDifference(wideExpectedIds(), ids)).toBeNull();
    expect(pages.length).toBeGreaterThanOrEqual(2); // ~60 bytes per row x 200 rows + header > 8192
    assertChainCounts(pages.map((p) => ({ counts: p.reply.counts, cursor: p.cursor })), { total: 200, matched: 200 });
  });
  it("[MC3] the JSON cursor chain survives rows whose labels are the 256-character schema maximum (long labels)", async () => {
    // why: a long label (768 bytes of "€") makes one JSON row ~1 KB; at 2048 at most two rows fit beside the header.
    // 30 rows -> at least 15 pages, and every one must still progress.
    const rows = Array.from({ length: 30 }, (_, i) => {
      const n = String(i + 1).padStart(2, "0");
      return row(`l-${n}`, { name: `n-${n}` }, { label: "€".repeat(256), entity: moduleRef(`l-${n}`) });
    });
    const env = await open(bundleOf([listView({ id: "long", definitionId: "def-long", rows, completeness: complete("30 long-label rows") })]));
    const pages = await jsonPages(env, "inspect_view", { viewId: "long", snapshotId: "snap-1" }, 2048);
    const ids = pages.flatMap((page) => page.reply.items.map((item: { id: string }) => item.id));
    expect(ids).toEqual(Array.from({ length: 30 }, (_, i) => `l-${String(i + 1).padStart(2, "0")}`));
    expect(pages.length).toBeGreaterThanOrEqual(15);
  });

  // why: the budget has defaults; a wrong default silently changes every agent reply (red-contract 3).
  // proves: CLAIM(MC3) default budget 8192 and default format text.
  it("[MC3] the default budget is 8192: omitting maxBytes equals asking for 8192 and exceeds the 2048 minimum", async () => {
    const env = await open(wideBundle());
    const byDefault = await env.call("inspect_view", { ...WIDE, format: "json" });
    const explicit = await env.call("inspect_view", { ...WIDE, format: "json", maxBytes: 8192 });
    expect(byDefault.body).toBe(explicit.body);
    expect(utf8Length(byDefault.body)).toBeLessThanOrEqual(8192);
    expect(utf8Length(byDefault.body)).toBeGreaterThan(2048);
    expect(okJson(byDefault).counts.omitted).toBeGreaterThan(0); // 200 JSON rows are far larger than 8192
  });
  it("[MC3] the default format is text", async () => {
    const env = await open(wideBundle());
    const outcome = await env.call("inspect_view", { ...WIDE });
    expect(outcome.ok).toBe(true);
    expect(outcome.format).toBe("text");
    expect(outcome.body.startsWith("paneweft.reply/1 view=wide component=list\n")).toBe(true);
  });
  it("[MC3] a larger budget returns strictly more rows: 2048 < 8192 < 32768", async () => {
    const env = await open(wideBundle());
    const returned: number[] = [];
    for (const maxBytes of [2048, 8192, 32768]) {
      returned.push(okJson(await env.call("inspect_view", { ...WIDE, format: "json", maxBytes })).counts.returned);
    }
    expect(returned[0]).toBeGreaterThanOrEqual(1);
    expect(returned[1]).toBeGreaterThan(returned[0] as number);
    expect(returned[2]).toBeGreaterThan(returned[1] as number);
  });
});

describe("[MC3] budget bounds and BUDGET_TOO_SMALL", () => {
  // why: red-contract 2/3: below the minimum is BUDGET_TOO_SMALL with details.minimumBytes 2048; the requested
  // budget cannot apply below the minimum, so the error body must fit the MINIMUM (2048). Above 32768 is a
  // plain argument fault (INVALID_ARGUMENT at /maxBytes), a different code: the boundary is 2047|2048 and 32768|32769.
  // proves: CLAIM(MC3) budget range.
  it.each([["text", 2047], ["json", 2047], ["text", 1], ["json", 0]] as const)(
    "[MC3] %s maxBytes %i -> BUDGET_TOO_SMALL with minimumBytes 2048 in a body of at most 2048 bytes",
    async (format, maxBytes) => {
      const env = await open(bundleOf([wideListView()]));
      const outcome = await env.call("inspect_view", { ...WIDE, format, maxBytes });
      const error = failure(outcome);
      expect(error.code).toBe("BUDGET_TOO_SMALL");
      expect(error.details).toEqual({ minimumBytes: 2048 });
      assertBodyWithin(outcome.body, 2048, "BUDGET_TOO_SMALL body");
    },
  );
  it("[MC3] maxBytes 2048 (the minimum) is accepted: positive control for the 2047 rejection", async () => {
    const env = await open(bundleOf([wideListView()]));
    expect((await env.call("inspect_view", { ...WIDE, maxBytes: 2048 })).ok).toBe(true);
  });
  it("[MC3] maxBytes 32769 -> INVALID_ARGUMENT at /maxBytes (OUT_OF_RANGE); 32768 is accepted", async () => {
    const env = await open(bundleOf([wideListView()]));
    const rejected = failure(await env.call("inspect_view", { ...WIDE, maxBytes: 32769 }));
    expect(rejected.code).toBe("INVALID_ARGUMENT");
    expect(rejected.errors.map((issue) => [issue.pointer, issue.code])).toEqual([["/maxBytes", "OUT_OF_RANGE"]]);
    const accepted = await env.call("inspect_view", { ...WIDE, maxBytes: 32768 });
    expect(accepted.ok).toBe(true);
    assertBodyWithin(accepted.body, 32768);
  });

  // why: design 4 "If a requested budget cannot fit the mandatory header, it returns a bounded BUDGET_TOO_SMALL error
  // with the minimum." A header with a 1024-code-point question and criterion (3-byte "€": 3072 bytes each, the
  // schema maximum) cannot fit 2048. minimumBytes must be the SMALLEST fitting budget: one less still fails with the
  // same minimum, the minimum itself succeeds with the header intact.
  // proves: CLAIM(MC3) header larger than the minimum budget.
  it.each(["text", "json"] as const)("[MC3] %s: a 6 KB mandatory header at maxBytes 2048 -> BUDGET_TOO_SMALL with the exact minimum, which then succeeds", async (format) => {
    const env = await open(bundleOf([listView({ id: "bigh", definitionId: "def-bigh", rows, question: BIG, completeness: complete(BIG) })]));
    const args = { viewId: "bigh", snapshotId: "snap-1", format };
    const refused = await env.call("inspect_view", { ...args, maxBytes: 2048 });
    const error = failure(refused);
    expect(error.code).toBe("BUDGET_TOO_SMALL");
    assertBodyWithin(refused.body, 2048, "BUDGET_TOO_SMALL body");
    const minimum = (error.details as { minimumBytes: number }).minimumBytes;
    // derivation: question (3072 bytes) + criterion (3072 bytes) are mandatory, so the minimum exceeds 6144; the
    // remaining header lines are a few hundred bytes, far below 12288.
    expect(minimum).toBeGreaterThan(6144);
    expect(minimum).toBeLessThanOrEqual(12288);
    const tooSmall = failure(await env.call("inspect_view", { ...args, maxBytes: minimum - 1 }));
    expect(tooSmall.code).toBe("BUDGET_TOO_SMALL");
    expect((tooSmall.details as { minimumBytes: number }).minimumBytes).toBe(minimum);
    const fits = await env.call("inspect_view", { ...args, maxBytes: minimum });
    assertBodyWithin(fits.body, minimum, "header-only reply");
    if (format === "json") {
      const reply = okJson(fits);
      expect(reply.question).toBe(BIG);
      expect(reply.completeness).toMatchObject({ status: "complete", criterion: BIG });
      expect(reply.counts.matched).toBe(2);
    } else {
      const reply = okText(fits);
      expect(reply.header.question).toBe(BIG);
      expect(reply.header.completeness).toBe(`complete (${BIG})`);
      expect(reply.counts.matched).toBe(2);
    }
  });
  it("[MC3] a partial view whose first gap question is 3072 bytes has the same BUDGET_TOO_SMALL behaviour (gap text is mandatory header)", async () => {
    const env = await open(bundleOf([listView({ id: "biggap", definitionId: "def-biggap", rows, completeness: partial(["g-big", BIG]) })]));
    const refused = failure(await env.call("inspect_view", { viewId: "biggap", snapshotId: "snap-1", maxBytes: 2048 }));
    expect(refused.code).toBe("BUDGET_TOO_SMALL");
    const minimum = (refused.details as { minimumBytes: number }).minimumBytes;
    expect(minimum).toBeGreaterThan(3072);
    expect(minimum).toBeLessThanOrEqual(12288);
    const fits = okText(await env.call("inspect_view", { viewId: "biggap", snapshotId: "snap-1", maxBytes: minimum }));
    expect(fits.header.completeness).toBe(`partial (1 gaps; first: g-big: ${BIG})`);
  });
});

describe("[MC3] no match, one huge item, minimum budget", () => {
  // why: design 4 "returned text or JSON always includes ... even when zero rows match".
  // proves: CLAIM(MC3) no-match reply keeps the header and exact counts.
  it.each(["text", "json"] as const)("[MC3] %s: a filter matching nothing returns the full header, total 200, matched 0, no cursor", async (format) => {
    const env = await open(wideBundle());
    const outcome = await env.call("inspect_view", { ...WIDE, format, maxBytes: 2048, filter: { text: "no-such-text" } });
    assertBodyWithin(outcome.body, 2048);
    if (format === "json") {
      const reply = okJson(outcome);
      expect(reply.counts).toEqual({ unit: "rows", total: 200, matched: 0, returned: 0, omitted: 0, truncated: false });
      expect(reply.items).toEqual([]);
      expect(reply.question).toBe("What is in this set, and which members matter?");
      expect(reply.notice).toBe("no items match the current filters (0 of 200)");
    } else {
      const reply = okText(outcome);
      expect(reply.counts).toEqual({ unit: "rows", total: 200, matched: 0, returned: 0, omitted: 0, truncated: false });
      expect(reply.header.question).toBe("What is in this set, and which members matter?");
      expect(reply.raw).toContain("no items match the current filters (0 of 200)");
    }
    expect(cursorOf(outcome)).toBeNull();
  });

  // why: S3. One item larger than the whole budget is SPLIT into fragments {item_id, offset, length, total, text}; nothing is discarded
  //      and nothing is flagged "clipped". The four budgets 2048..2051 give four residues mod 3 for the cut point of a 3-byte "€",
  //      so a byte-offset slicer must land inside a code point; the 32768 budget is the largest page and the item (60,000+ bytes) still
  //      needs two pages. The reconstruction oracle is independent of the implementation: `total` must equal the UTF-8 length of
  //      JSON.stringify(original row) (the canonical item text has no whitespace, so its length does not depend on key order) and
  //      the concatenated texts must parse back to a row deep-equal to the submitted row. Order name desc puts the huge row FIRST:
  //      [huge, zz, a-small]; zz and a-small fit a page whole, so they are never fragmented and are delivered exactly once.
  // proves: CLAIM(MC3) CLAIM(S3-fragments) one huge item, lossless, within budget, header on every page.
  const HUGE = "€".repeat(20_000); // 60,000 bytes: below the 64 KiB string limit, above every budget
  const hugeRows = () => [
    row("a-small", { name: "a-small" }, { entity: moduleRef("a-small") }),
    row("zz", { name: "zz" }, { entity: moduleRef("zz") }),
    row("huge", { name: HUGE }, { entity: moduleRef("huge") }),
  ];
  const hugeBundle = () => bundleOf([listView({ id: "hugev", definitionId: "def-hugev", rows: hugeRows(), order: { key: "name", direction: "desc" }, completeness: complete("three rows") })]);
  const hugeArgs = { viewId: "hugev", snapshotId: "snap-1" };
  const hugeOriginal = () => hugeRows()[2];

  it.each([2048, 2049, 2050, 2051, 32768])("[S3] JSON at maxBytes %i: the 60,000-byte row arrives as fragments that rebuild exactly the submitted row; zz and a-small arrive whole, once", async (maxBytes) => {
    const env = await open(hugeBundle());
    const pages = await jsonPages(env, "inspect_view", hugeArgs, maxBytes);
    const pieces = pages.flatMap((page) => fragmentsOfJson(page.reply));
    const { order, texts } = reassemble(pieces);
    expect(order).toEqual(["huge"]);
    const rebuilt = texts.get("huge") as string;
    expect(pieces[0]?.total, "total = UTF-8 bytes of the canonical item text").toBe(utf8Length(JSON.stringify(hugeOriginal())));
    expect(utf8Length(rebuilt)).toBe(pieces[0]?.total);
    expect(JSON.parse(rebuilt)).toEqual(hugeOriginal());
    expect(pieces.length, "a 60 KB item cannot fit one page").toBeGreaterThanOrEqual(2);
    // the whole items, in page order, and each exactly once
    expect(pages.flatMap((page) => plainItemsOfJson(page.reply).map((item: { id: string }) => item.id))).toEqual(["zz", "a-small"]);
    // document order of the events: the fragments of `huge` all precede zz and a-small
    const events = pages.flatMap((page) => page.reply.items.map((item: any) => (item.fragment === undefined ? item.id : item.fragment.item_id)));
    expect(events.filter((id: string, i: number) => i === 0 || id !== events[i - 1])).toEqual(["huge", "zz", "a-small"]);
    // nothing is "clipped" any more and every page keeps its header
    expect(JSON.stringify(pages.map((page) => page.reply))).not.toMatch(/"clipped"|"originalBytes"/);
    for (const page of pages) {
      expect(page.reply.question).toBe("What is in this set, and which members matter?");
      expect(page.reply.completeness).toMatchObject({ status: "complete", criterion: "three rows" });
    }
    assertChainCounts(pages.map((p) => ({ counts: p.reply.counts, cursor: p.cursor, pending: pendingAfter(fragmentsOfJson(p.reply)) })), { total: 3, matched: 3 });
    pages.forEach((page, index) => expect(page.reply.counts.truncated, `page ${index + 1}: truncated iff something follows`).toBe(page.cursor !== null));
  });
  it.each([2048, 2049, 2050, 2051])("[S3] text at maxBytes %i: fragment lines rebuild the item's whole line; no clipped marker; header intact on every page", async (maxBytes) => {
    const env = await open(hugeBundle());
    const pages = await textPages(env, "inspect_view", hugeArgs, maxBytes);
    const pieces = pages.flatMap((page) => fragmentsOfText(page.reply.body));
    const { order, texts } = reassemble(pieces);
    // the item's text line is the red-contract list-row line: `<first cell> -> <kind>:<entity id>; <provenance>; <evidence ids>`
    const wholeLine = `${HUGE} -> code/module:huge; read; s1`;
    expect(order).toEqual(["huge"]);
    expect(texts.get("huge")).toBe(wholeLine);
    expect(pieces[0]?.total).toBe(utf8Length(wholeLine)); // 60,000 + 30 bytes: " -> " 4, "code/module:huge" 16, "; read" 6, "; s1" 4
    expect(pages.flatMap((page) => entityIdsOfLines(page.reply.body))).toEqual(["zz", "a-small"]);
    for (const page of pages) {
      expect(page.reply.header.completeness).toBe("complete (three rows)");
      expect(page.reply.raw).not.toMatch(/clipped/);
    }
    assertChainCounts(pages.map((p) => ({ counts: p.reply.counts, cursor: p.cursor, pending: pendingAfter(fragmentsOfText(p.reply.body)) })), { total: 3, matched: 3 });
  });

  // why: S3 "the cursor encodes (item index, byte offset)": it does not bind the budget (red-contract 3), so a chain may change maxBytes
  //      between pages and must still deliver every byte once. Page 1 at 2048, then 8192, then 4096, then 32768 for the rest:
  //      the reconstruction is the same as with a constant budget. A cursor that restarted the item, or counted offsets in
  //      characters, would duplicate or skip bytes here.
  // proves: CLAIM(S3-fragments) CLAIM(MC19)
  it("[S3] a chain that changes maxBytes between pages still rebuilds the item exactly once", async () => {
    const env = await open(hugeBundle());
    const budgets = [2048, 8192, 4096, 32768];
    const pieces: FragmentPiece[] = [];
    const wholeIds: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 40; page++) {
      const outcome = await env.call("inspect_view", { ...hugeArgs, format: "json", maxBytes: budgets[Math.min(page, budgets.length - 1)], ...(cursor === null ? {} : { cursor }) });
      const reply = okJson(outcome);
      assertBodyWithin(outcome.body, budgets[Math.min(page, budgets.length - 1)] as number);
      pieces.push(...fragmentsOfJson(reply));
      wholeIds.push(...plainItemsOfJson(reply).map((item: { id: string }) => item.id));
      cursor = cursorOf(outcome);
      if (cursor === null) break;
    }
    expect(cursor, "the chain terminated").toBeNull();
    expect(JSON.parse(reassemble(pieces).texts.get("huge") as string)).toEqual(hugeOriginal());
    expect(wholeIds).toEqual(["zz", "a-small"]);
  });

  // why: S3 "the minimum budget is the header size plus 64 payload bytes, so every page makes progress". This closes the open question
  //      of the first round (ops.md 7.1: at exactly minimumBytes a page could carry zero items and a chain would stall). The view has
  //      a 6 KB mandatory header; its minimum is read from the BUDGET_TOO_SMALL error (and is the smallest fitting value, tested above).
  //      At that budget every page must deliver payload: either a whole item or a fragment of at least 61 bytes (64 minus one
  //      4-byte code point), and the chain must TERMINATE within a bound derived from the content size, not from the implementation:
  //      pages <= ceil(contentBytes / 61) + items + 1. Items: rows "a" and "b" (about 100 bytes of canonical JSON each).
  // proves: CLAIM(S3-progress) CLAIM(MC3)
  it.each(["json", "text"] as const)("[S3] %s: at the reported minimum every page makes progress and the chain terminates within the content-derived bound", async (format) => {
    const env = await open(bundleOf([listView({ id: "bigh", definitionId: "def-bigh", rows, question: BIG, completeness: complete(BIG) })]));
    const args = { viewId: "bigh", snapshotId: "snap-1" };
    const refused = failure(await env.call("inspect_view", { ...args, format, maxBytes: 2048 }));
    const minimum = (refused.details as { minimumBytes: number }).minimumBytes;
    const pages = format === "json" ? await jsonPages(env, "inspect_view", args, minimum) : await textPages(env, "inspect_view", args, minimum);
    const delivered = (page: (typeof pages)[number]): number => {
      const reply = (page as { reply: any }).reply;
      return format === "json"
        ? fragmentsOfJson(reply).length + plainItemsOfJson(reply).length
        : fragmentsOfText(reply.body).length + entityIdsOfLines(reply.body).length;
    };
    pages.forEach((page, index) => {
      expect(delivered(page), `page ${index + 1} delivers a whole item or a fragment`).toBeGreaterThan(0);
      const reply = (page as { reply: any }).reply;
      const pieces = format === "json" ? fragmentsOfJson(reply) : fragmentsOfText(reply.body);
      for (const piece of pieces) {
        // These two rows have ASCII-only payloads, so there is no code-point alignment loss.
        // A terminal fragment can have less than the 64-byte reserve left.
        expect(piece.length, `${piece.item_id}@${piece.offset}: use all 64 reserved payload bytes`).toBeGreaterThanOrEqual(Math.min(64, piece.total - piece.offset));
      }
    });
    const content = rows.reduce((sum, r) => sum + utf8Length(JSON.stringify(r)), 0);
    expect(pages.length, `terminates in at most ceil(${content}/61) + 2 + 1 pages`).toBeLessThanOrEqual(Math.ceil(content / 61) + 3);
    if (format === "json") {
      const pieces = pages.flatMap((page) => fragmentsOfJson((page as { reply: any }).reply));
      const { texts } = reassemble(pieces);
      const rebuilt = [
        ...pages.flatMap((page) => plainItemsOfJson((page as { reply: any }).reply)),
        ...[...texts.values()].map((text) => JSON.parse(text)),
      ];
      expect(rebuilt.map((r: { id: string }) => r.id).sort()).toEqual(["a", "b"]);
      for (const item of rebuilt) expect(item).toEqual(rows.find((r) => r.id === item.id));
    }
    assertChainCounts(pages.map((p) => ({ counts: (p as any).reply.counts, cursor: p.cursor, pending: pendingAfter(format === "json" ? fragmentsOfJson((p as any).reply) : fragmentsOfText((p as any).reply.body)) })), { total: 2, matched: 2 });
  });

  // why: the minimum budget 2048 must work for every v0 component (design 4: "minimum 2048"); a header that
  // only fits 8192 would break the stated range. Fixture counts are hand-read from fixtures/components/*.json.
  // proves: CLAIM(MC3) minimum-budget for all seven components, both formats.
  const minimum: Array<[component: string, viewId: string, unit: string, total: number]> = [
    ["list", "modules", "rows", 1], ["tree", "layout", "nodes", 2], ["graph", "delivery-path", "edges", 1],
    ["source", "check-source", "lines", 1], ["shape", "watch-shape", "fields", 1],
    ["notebook", "cancellation-notebook", "blocks", 2], ["example", "vigil-one-write", "runs", 0],
  ];
  it.each(minimum.flatMap(([c, v, u, t]) => (["text", "json"] as const).map((f) => [c, v, u, t, f] as const)))(
    "[MC3] %s fixture at maxBytes 2048 (%s %s=%i) in %s fits with every row returned",
    async (component, viewId, unit, total, format) => {
      const env = await open(allBundle());
      const outcome = await env.call("inspect_view", { viewId, snapshotId: "snap-1", format, maxBytes: 2048 });
      assertBodyWithin(outcome.body, 2048);
      const parsed = format === "json" ? okJson(outcome) : okText(outcome);
      expect(parsed.counts).toEqual({ unit, total, matched: total, returned: total, omitted: 0, truncated: false });
      if (format === "json") expect(parsed.view).toEqual(expect.objectContaining({ id: viewId, component, snapshotId: "snap-1" }));
      else {
        expect(parsed.firstLine).toBe(`paneweft.reply/1 view=${viewId} component=${component}`);
        expect(parsed.body[0]).toBe(`${total}/${total} matched ${unit} returned; 0 omitted`);
      }
    },
  );
});

describe("[MC3] huge-schema discovery pages", () => {
  // why: design 4/5: describe_component "paged when needed"; red-contract 3: replies page
  // {component, section, chunk, chunkIndex, chunkCount} and the concatenated chunks parse to
  // {id, question, capabilities, limits, schema, example} where `schema` is the canonical schema document.
  // The graph schema document is several KB, far above 2048, so at minimum budget it MUST page.
  // proves: CLAIM(MC3) discovery pages are bounded, complete and lossless.
  const GRAPH_CAPABILITIES = ["select", "filter-relation", "filter-provenance", "focus-neighborhood", "focus-path", "open-entity", "open-evidence"]; // design 2.3 interactions, copied by hand
  const readSchemaFile = (component: string) => JSON.parse(readFileSync(join(REPO_ROOT, "src", "schemas", "components", `${component}.schema.json`), "utf8"));

  async function describeAll(env: OpsEnv, component: string, maxBytes: number) {
    const pages = await followCursors(async (cursor) => {
      const outcome = await env.call("describe_component", { component, format: "json", maxBytes, ...(cursor === null ? {} : { cursor }) });
      assertBodyWithin(outcome.body, maxBytes, `describe ${component} page`);
      const body = okJson(outcome, { schema: false });
      return { body, cursor: outcome.ok ? outcome.cursor : null };
    });
    return pages;
  }

  it("[MC3] graph at maxBytes 2048 pages (>= 2 pages), each page within budget, chunk indices 0..n-1, last cursor null", async () => {
    const env = await open();
    const pages = await describeAll(env, "graph", 2048);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    pages.forEach((page, index) => {
      expect(page.body.component).toBe("graph");
      expect(typeof page.body.section).toBe("string");
      expect(typeof page.body.chunk).toBe("string");
      expect(page.body.chunkIndex).toBe(index);
      expect(page.body.chunkCount).toBe(pages.length);
    });
    expect(pages[pages.length - 1]?.cursor).toBeNull();
    expect(pages.slice(0, -1).every((p) => p.cursor !== null)).toBe(true);
  });
  it("[MC3] the concatenated graph chunks parse to {id, question, capabilities, limits, schema, example} with the schema FILE and a valid example", async () => {
    const env = await open();
    const pages = await describeAll(env, "graph", 2048);
    const document = JSON.parse(pages.map((p) => p.body.chunk as string).join(""));
    expect(Object.keys(document).sort()).toEqual(["capabilities", "example", "id", "limits", "question", "schema"]);
    expect(document.id).toBe("graph");
    expect(document.question).toBe("What connects these entities, and by which relation?"); // design 2.3
    expect(document.capabilities).toEqual(GRAPH_CAPABILITIES);
    expect(JSON.stringify(document.limits)).toMatch(/\b200\b.*\b500\b|\b500\b.*\b200\b/); // design 4: graph budget 200 nodes, 500 edges
    expect(document.schema).toEqual(readSchemaFile("graph"));
    expect(validateAgainst("urn:paneweft:schema:component:graph:1", document.example)).toEqual([]);
  });
  it("[MC3] at maxBytes 32768 the same document fits one page (positive control: paging is driven by the budget)", async () => {
    const env = await open();
    const pages = await describeAll(env, "graph", 32768);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.body.chunkCount).toBe(1);
    expect(pages[0]?.cursor).toBeNull();
    expect(JSON.parse(pages[0]?.body.chunk).id).toBe("graph");
  });
  it.each(["list", "tree", "graph", "source", "shape", "notebook", "example"])("[MC3] %s at 2048 reassembles to its schema file, a valid example and its own id", async (component) => {
    const env = await open();
    const pages = await describeAll(env, component, 2048);
    const document = JSON.parse(pages.map((p) => p.body.chunk as string).join(""));
    expect(document.id).toBe(component);
    expect(document.schema).toEqual(readSchemaFile(component));
    expect(validateAgainst(`urn:paneweft:schema:component:${component}:1`, document.example)).toEqual([]);
  });
  it("[MC3] text format pages are bounded and well-formed too, and the chain terminates", async () => {
    const env = await open();
    const pages = await followCursors(async (cursor) => {
      const outcome = await env.call("describe_component", { component: "graph", format: "text", maxBytes: 2048, ...(cursor === null ? {} : { cursor }) });
      expect(outcome.ok).toBe(true);
      assertBodyWithin(outcome.body, 2048, "text describe page");
      return { cursor: outcome.ok ? outcome.cursor : null };
    });
    expect(pages.length).toBeGreaterThanOrEqual(2);
  });
});

describe("[MC3] bounded search results", () => {
  // why: design 3/5: search returns "bounded typed search results"; a result list larger than the budget pages,
  // and the ranking (exact > prefix > substring, then entity < view < example < claim, then id) is stable
  // across pages. The expected order comes from rankSearch (proved in ops-oracle.test.ts); the 7 hand-written
  // docs below are also pinned literally in the oracle test.
  // proves: CLAIM(MC3) search is bounded and its pages concatenate to the ranked list.
  const base = () => {
    const views = [
      listView({ id: "v-exact", definitionId: "def-v-exact", title: "Cancel", rows: [row("a", { name: "a" })] }),
      listView({ id: "v-sub", definitionId: "def-v-sub", title: "Never cancelled", rows: [row("a", { name: "a" })] }),
      exampleView({ id: "x-prefix", definitionId: "def-x", title: "Retry flow", scenario: { id: "once", label: "Cancel then retry", runnerId: "r1", parameters: {}, provenance: "read", evidence: ["s1"] } }),
      notebookView({ id: "n-claims", definitionId: "def-n", title: "Notes", blocks: [claimBlock("c-exact", "cancel", "open"), claimBlock("c-other", "unrelated claim", "open")] }),
    ];
    const entities = [
      entityAt({ repository: "r", id: "e-exact", kind: "code/module" }, "snap-1", { label: "cancel" }),
      entityAt({ repository: "r", id: "e-prefix", kind: "code/module" }, "snap-1", { label: "Cancellation" }),
      entityAt({ repository: "r", id: "e-sub", kind: "code/module" }, "snap-1", { label: "Uncancelled" }),
    ];
    return { views, entities };
  };
  const docs = (): SearchDocument[] => [
    { type: "entity", id: "e-exact", texts: ["cancel"] }, { type: "entity", id: "e-prefix", texts: ["Cancellation"] }, { type: "entity", id: "e-sub", texts: ["Uncancelled"] },
    { type: "view", id: "v-exact", texts: ["Cancel"] }, { type: "view", id: "v-sub", texts: ["Never cancelled"] },
    { type: "example", id: "x-prefix", texts: ["Cancel then retry"] }, { type: "claim", id: "c-exact", texts: ["cancel"] },
  ];
  const tagged = (items: Array<{ type: string; id: string }>) => items.map((item) => `${item.type}:${item.id}`);

  it("[MC3] a case-insensitive query returns the 7 matches ranked exact > prefix > substring, then entity,view,example,claim", async () => {
    const { views, entities } = base();
    const env = await open(bundleOf(views, { entities }));
    const reply = okJson(await env.call("search", { query: "CaNcEl", format: "json" }), { schema: false });
    // by hand: exact = e-exact, v-exact, c-exact; prefix = e-prefix, x-prefix; substring = e-sub, v-sub
    expect(tagged(reply.items)).toEqual(["entity:e-exact", "view:v-exact", "claim:c-exact", "entity:e-prefix", "example:x-prefix", "entity:e-sub", "view:v-sub"]);
    expect(reply.counts).toEqual({ unit: "results", total: 7, matched: 7, returned: 7, omitted: 0, truncated: false });
    expect(tagged(rankSearch(docs(), "cancel"))).toEqual(tagged(reply.items)); // the oracle agrees with the literal
  });
  it("[MC3] 120 more prefix matches make the result list exceed 2048 bytes: pages are bounded and concatenate to the oracle ranking", async () => {
    const { views, entities } = base();
    const steps = Array.from({ length: 120 }, (_, i) => `step-${String(i).padStart(3, "0")}`);
    const more = steps.map((id) => entityAt({ repository: "r", id, kind: "code/module" }, "snap-1", { label: `Cancel ${id}` }));
    const env = await open(bundleOf(views, { entities: [...entities, ...more] }));
    const pages = await jsonPagesNoSchema(env, { query: "cancel" }, 2048);
    const expected = rankSearch([...docs(), ...steps.map((id): SearchDocument => ({ type: "entity", id, texts: [`Cancel ${id}`] }))], "cancel");
    expect(pages.flatMap((p) => tagged(p.items))).toEqual(tagged(expected));
    expect(pages.length).toBeGreaterThanOrEqual(3); // 127 results of >= 40 bytes each cannot fit 2048 bytes: at least 3 pages
    expect(expected).toHaveLength(127);
  });
  async function jsonPagesNoSchema(env: OpsEnv, args: Record<string, unknown>, maxBytes: number) {
    const pages = await followCursors(async (cursor) => {
      const outcome = await env.call("search", { ...args, format: "json", maxBytes, ...(cursor === null ? {} : { cursor }) });
      assertBodyWithin(outcome.body, maxBytes, "search page");
      const reply = okJson(outcome, { schema: false });
      return { items: reply.items as Array<{ type: string; id: string }>, cursor: outcome.ok ? outcome.cursor : null };
    });
    return pages;
  }
});