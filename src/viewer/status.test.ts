// @vitest-environment jsdom
// MC4 (browser side): completeness is always visible and the four states (complete-empty, partial-empty, unsupported,
// failed operation) have distinct visible messages. MC5 (browser side): provenance cannot disappear in the picture, and a
// filtered-empty view still reports its coverage. Texts come from docs/viewer-dom-contract.md (the exact strings
// "0 items within this scope" and "no items match the current filters (0 of T)") and docs/contract-additions/dom.md B.
import { describe, expect, it } from "vitest";
import {
  SNAP, SUBJECT, byId, click, fixedFresh, goldenBundle, ids, need, openBundle, openEntity, mountBundle, panes, qa, q, sourceRepoSetup,
  text, typeInto, useViewerCleanup, withFailingSource, withFreshness,
  type MountedViewer,
} from "../../test/helpers/dom-harness.ts";
import { patch } from "../../test/helpers/patch.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
useViewerCleanup();

const emptyList = (completeness: unknown) => patch(goldenBundle("list"), { op: "replace", path: "/views/0/data/rows", value: [] }, { op: "replace", path: "/views/0/completeness", value: completeness });
const openList = (bundle: unknown = goldenBundle("list"), setup = {}) => openBundle(tmp("list"), bundle, SUBJECT, "d-list", { decorate: fixedFresh, ...setup });

async function completeEmptyMessage(): Promise<{ v: MountedViewer; message: string }> {
  const v = await openList(emptyList({ status: "complete", criterion: "all modules in the fixture" }));
  return { v, message: text(need(v.container, "empty-state")) };
}
async function partialEmptyMessage(): Promise<{ v: MountedViewer; message: string }> {
  const gap = { id: "g1", question: "Which modules were not scanned?", reason: "the scan stopped at the first error" };
  const v = await openList(emptyList({ status: "partial", gaps: [gap] }));
  return { v, message: text(need(v.container, "empty-state")) };
}
/** A notebook embedding an unsupported view (an unsupported view is unavailable as a pane view, so it is seen through an embed). */
async function unsupportedNotebook(): Promise<MountedViewer> {
  const bundle = patch(
    goldenBundle("notebook"),
    { op: "replace", path: "/views/0/completeness", value: { status: "unsupported", reason: "needs a compiler this checkout lacks", missingCapabilities: ["rustc"] } },
    { op: "remove", path: "/views/0/data" },
    { op: "replace", path: "/views/1/data/blocks/3/contradicts", value: [] },
  );
  return openBundle(tmp("unsupported"), bundle, SUBJECT, "d-notebook", { decorate: fixedFresh });
}
async function failedOpen(): Promise<MountedViewer> {
  const v = await mountBundle(tmp("failed"), goldenBundle("list"), { decorate: fixedFresh });
  await openEntity(v, { repository: "r", id: "ghost", kind: "demo/subject" });
  return v;
}

describe("[MC4] the four states are visible and distinct", () => {
  // why: design 3 "A complete empty collection says '0 items within this scope'. It is different from an unavailable view and from
  //      an extraction error" - the literal string is the DOM contract's.
  // proves: CLAIM(MC4)
  it("[MC4] complete-empty: empty-state reads exactly \"0 items within this scope\", completeness is complete with its criterion, 0 of 0 match", async () => {
    const { v, message } = await completeEmptyMessage();
    expect(message).toBe("0 items within this scope");
    const completeness = need(v.container, "completeness");
    expect(completeness.getAttribute("data-status")).toBe("complete");
    expect(text(completeness)).toBe("complete (all modules in the fixture)");
    const count = need(v.container, "match-count");
    expect([count.getAttribute("data-matched"), count.getAttribute("data-total"), text(count)]).toEqual(["0", "0", "0 of 0 match"]);
    expect(qa(v.container, "row")).toHaveLength(0);
    expect(q(v.container, "error")).toBeNull();
  });
  // why: a partial view with no rows must not claim the scope is empty (design 7 MC4 "partial-empty with a named gap").
  // proves: CLAIM(MC4)
  it("[MC4] partial-empty: a different message that names the gap, never the complete-empty string; completeness is partial with the first gap", async () => {
    const { v, message } = await partialEmptyMessage();
    expect(message).not.toBe("0 items within this scope");
    expect(message).toContain("g1");
    expect(message).toContain("Which modules were not scanned?");
    expect(message).toContain("partial");
    const completeness = need(v.container, "completeness");
    expect(completeness.getAttribute("data-status")).toBe("partial");
    expect(text(completeness)).toBe("partial (1 gaps; first: g1: Which modules were not scanned?)");
  });
  // why: an unsupported view has no data body; rendering a list or a "0 items" message for it would be a lie.
  // proves: CLAIM(MC4)
  it("[MC4] unsupported: the embedded view shows completeness data-status=unsupported with its reason and renders no component element, even when expanded", async () => {
    const v = await unsupportedNotebook();
    const embedded = need(v.container, "embedded-view");
    const strip = need(embedded, "completeness");
    expect(strip.getAttribute("data-status")).toBe("unsupported");
    expect(text(strip)).toBe("unsupported (needs a compiler this checkout lacks; missing: rustc)");
    await click(v, need(byId(v.container, "block", "b-view"), "toggle"));
    const expanded = need(v.container, "embedded-view");
    for (const component of ["list", "tree", "graph", "source", "shape", "notebook", "example", "row", "empty-state"]) {
      expect(q(expanded, component), `no ${component} inside an unsupported embedded view`).toBeNull();
    }
    expect(text(need(expanded, "completeness"))).toContain("needs a compiler this checkout lacks");
  });
  // why: the unsupported view is unavailable in the registry; it must be listed with its reason, not silently dropped.
  // proves: CLAIM(MC4) / CLAIM(MC7)
  it("[MC4] the unsupported view is listed in the collapsed Needs evidence section with its reason and is not a tab", async () => {
    const v = await unsupportedNotebook();
    const section = need(v.container, "needs-evidence");
    expect((section as HTMLDetailsElement).open).toBe(false);
    const entries = qa(section, "unavailable-view");
    expect(entries).toHaveLength(1);
    expect(text(entries[0])).toContain("Modules");
    expect(text(entries[0])).toContain("needs a compiler this checkout lacks");
    expect(qa(v.container, "tab").map((t) => t.getAttribute("data-definition-id"))).toEqual(["d-notebook", "builtin:metadata", "builtin:raw"]);
  });
  // why: a failed operation is an error, not an empty or partial result (design 4: "operation errors with codes").
  // proves: CLAIM(MC4)
  it("[MC4] failed operation: opening an entity that does not exist renders error role=alert with data-code NOT_FOUND and creates no pane", async () => {
    const v = await failedOpen();
    const error = need(v.container, "error");
    expect([error.getAttribute("role"), error.getAttribute("data-code")]).toEqual(["alert", "NOT_FOUND"]);
    expect(text(error).startsWith("NOT_FOUND: ")).toBe(true);
    expect(text(error).length).toBeGreaterThan("NOT_FOUND: ".length);
    expect(panes(v)).toHaveLength(0);
    expect(v.handle.state().trail).toHaveLength(0);
    expect(q(v.container, "empty-state")).toBeNull();
  });
  // why: a source error Result must reach the user with its code and message while the stored excerpt stays visible.
  // proves: CLAIM(MC4) / CLAIM(MC6)
  it("[MC4] failed operation: a source returning PATH_OUTSIDE_ROOT shows error data-code=PATH_OUTSIDE_ROOT with the message, and the stored excerpt remains", async () => {
    const v = await openBundle(tmp("src-error"), goldenBundle("source"), SUBJECT, "d-code", {
      decorate: (s) => withFailingSource(fixedFresh(s), "PATH_OUTSIDE_ROOT", "path escapes the registered root"),
    });
    await click(v, byId(v.container, "annotation", "a1"));
    const error = need(v.container, "error");
    expect([error.getAttribute("role"), error.getAttribute("data-code")]).toEqual(["alert", "PATH_OUTSIDE_ROOT"]);
    expect(text(error)).toBe("PATH_OUTSIDE_ROOT: path escapes the registered root");
    expect(ids(qa(v.container, "source-line"), "data-line")).toEqual(["10", "11", "12"]);
  });
  // why: "all four messages differ pairwise" (brief) - a shared generic message would hide which state occurred.
  // proves: CLAIM(MC4)
  it("[MC4] the visible messages of complete-empty, partial-empty, unsupported and failed differ pairwise", async () => {
    const messages = [
      (await completeEmptyMessage()).message,
      (await partialEmptyMessage()).message,
      text(need(need(await unsupportedNotebook().then((v) => v.container), "embedded-view"), "completeness")),
      text(need((await failedOpen()).container, "error")),
    ];
    expect(new Set(messages).size).toBe(4);
    expect(messages.every((m) => m.length > 0)).toBe(true);
  });
});

describe("[MC4] the completeness and freshness strip is persistent", () => {
  const STRIP_PARTS = ["completeness", "freshness", "snapshot", "provenance-summary"];
  const stripFacts = (v: MountedViewer) => {
    const strip = need(v.container, "status-strip");
    return STRIP_PARTS.map((name) => text(need(strip, name)));
  };
  // why: design 4 "a persistent completeness/freshness strip above each view": above in document order and outside the view body.
  // proves: CLAIM(MC4)
  it("[MC4] the strip precedes the tabpanel, is not inside it, and keeps its four parts after a filter empties the view", async () => {
    const v = await openList();
    const strip = need(v.container, "status-strip");
    const panel = need(v.container, "tabpanel");
    expect(strip.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip.closest('[data-pw="tabpanel"]')).toBeNull();
    const before = stripFacts(v);
    expect(before).toEqual(["complete (all modules in the fixture)", "fresh", "snap-1", "read=1 parsed=1 compiled=1 observed=1 inferred=1"]);
    await typeInto(v, need(v.container, "filter-input"), "zzz");
    expect(qa(v.container, "row")).toHaveLength(0);
    expect(stripFacts(v)).toEqual(before);
  });
  // why: design 4 "Collapsed notebook blocks still display their status" and the strip must survive collapse/expand.
  // proves: CLAIM(MC4)
  it("[MC4] a notebook keeps its strip and every claim-status while claim blocks are expanded and collapsed again", async () => {
    const v = await openBundle(tmp("nb"), goldenBundle("notebook"), SUBJECT, "d-notebook", { decorate: fixedFresh });
    const before = stripFacts(v);
    const statuses = () => qa(v.container, "claim-status").map((s) => text(s));
    expect(statuses()).toEqual(["supported", "disputed", "open"]);
    const toggle = (id: string) => need(byId(v.container, "block", id), "toggle");
    await click(v, toggle("b-c1"));
    expect(toggle("b-c1").getAttribute("aria-expanded")).toBe("true"); // dom.md D1: aria-expanded lives on the toggle button
    expect(statuses()).toEqual(["supported", "disputed", "open"]);
    expect(stripFacts(v)).toEqual(before);
    await click(v, toggle("b-c1"));
    expect(toggle("b-c1").getAttribute("aria-expanded")).toBe("false");
    expect(statuses()).toEqual(["supported", "disputed", "open"]);
    expect(stripFacts(v)).toEqual(before);
  });
  // why: freshness is separate from completeness (design 4): a complete historical view can be stale today.
  // proves: CLAIM(MC4) / CLAIM(MC13)
  it("[MC4] freshness shows fresh, stale (changed path) and unknown (inaccessible root) as data-status plus text, while completeness stays complete", async () => {
    const hex = (c: string) => c.repeat(64);
    const cases: Array<[Parameters<typeof withFreshness>[1], string, string]> = [
      [{ status: "fresh" }, "fresh", "fresh"],
      [{ status: "stale", changedPaths: [{ repository: "r", path: "src/check.ts", recordedSha256: hex("a"), currentSha256: hex("b") }], inaccessibleRoots: [] }, "stale", "stale (changed: src/check.ts)"],
      [{ status: "unknown", inaccessibleRoots: ["/work/r"] }, "unknown", "unknown (inaccessible: /work/r)"],
    ];
    for (const [freshness, status, expectedText] of cases) {
      const v = await openBundle(tmp(`fresh-${status}`), goldenBundle("list"), SUBJECT, "d-list", { decorate: (s) => withFreshness(s, freshness) });
      const fresh = need(v.container, "freshness");
      expect([fresh.getAttribute("data-status"), text(fresh)]).toEqual([status, expectedText]);
      expect(need(v.container, "completeness").getAttribute("data-status")).toBe("complete");
    }
  });
});

describe("[MC5] provenance in the browser", () => {
  const ROW_PROVENANCE: Record<string, string> = { r1: "read", r2: "compiled", r3: "inferred", r4: "observed", r5: "parsed" };
  // why: design 4 "A view mixing read, compiled, and observed facts shows all of them" - each row carries its own word.
  // proves: CLAIM(MC5)
  it("[MC5] a list mixing all five provenances: each row's badge has the row's data-provenance and the same word as text", async () => {
    const v = await openList();
    const rows = qa(v.container, "row");
    expect(ids(rows)).toEqual(["r2", "r3", "r1", "r5", "r4"]);
    for (const row of rows) {
      const id = row.getAttribute("data-id") as string;
      const badge = need(row, "provenance-badge", `row ${id}`);
      expect([row.getAttribute("data-provenance"), badge.getAttribute("data-provenance"), text(badge)]).toEqual([ROW_PROVENANCE[id], ROW_PROVENANCE[id], ROW_PROVENANCE[id]]);
    }
  });
  // why: design 2 "inferred ... requires reason" - the reason must be visible with the inferred fact, and only there.
  // proves: CLAIM(MC5)
  it("[MC5] only the inferred row shows inferred-reason, with exactly its reason text", async () => {
    const v = await openList();
    const reasons = qa(v.container, "inferred-reason");
    expect(reasons.map((r) => text(r))).toEqual(["name matches the module path"]);
    expect(byId(v.container, "row", "r3").contains(reasons[0]!)).toBe(true);
  });
  // why: an evidence link per source id, each addressable (data-source) - r5 cites two sources.
  // proves: CLAIM(MC5)
  it("[MC5] evidence-link per source id: r5 lists s1 and s2 in order, each with data-source equal to its text", async () => {
    const v = await openList();
    const links = qa(byId(v.container, "row", "r5"), "evidence-link");
    expect(links.map((l) => [l.getAttribute("data-source"), text(l)])).toEqual([["s1", "s1"], ["s2", "s2"]]);
    expect(qa(byId(v.container, "row", "r4"), "evidence-link").map((l) => l.getAttribute("data-source"))).toEqual(["s2"]);
  });
  // why: the summary lists all five categories with counts, including zeroes (a missing category would hide absence of evidence).
  // proves: CLAIM(MC5)
  it("[MC5] provenance-summary lists all five categories with counts for the whole view, zero counts included", async () => {
    const list = await openList();
    expect(text(need(list.container, "provenance-summary"))).toBe("read=1 parsed=1 compiled=1 observed=1 inferred=1");
    const source = await openBundle(tmp("source"), goldenBundle("source"), SUBJECT, "d-code", { decorate: fixedFresh });
    // excerpt read + annotation a1 read + annotation a2 compiled
    expect(text(need(source.container, "provenance-summary"))).toBe("read=2 parsed=0 compiled=1 observed=0 inferred=0");
  });
  // why: the summary counts the whole view, not the filtered subset (red-contract 3: provenance counts are unfiltered).
  // proves: CLAIM(MC5)
  it("[MC5] filtering to one row leaves provenance-summary and evidence-coverage unchanged", async () => {
    const v = await openList();
    await typeInto(v, need(v.container, "filter-input"), "beta");
    expect(ids(qa(v.container, "row"))).toEqual(["r2"]);
    expect(text(need(v.container, "provenance-summary"))).toBe("read=1 parsed=1 compiled=1 observed=1 inferred=1");
    expect(text(need(v.container, "evidence-coverage"))).toBe("sources=s1,s2");
  });
  // why: design 7 MC5 "A filtered-empty view still reports its evidence coverage".
  // proves: CLAIM(MC5) / CLAIM(MC4)
  it("[MC5] a filter matching nothing shows the filtered-empty message (0 of 5) and still shows provenance-summary and evidence coverage", async () => {
    const v = await openList();
    await typeInto(v, need(v.container, "filter-input"), "zzz");
    expect(text(need(v.container, "empty-state"))).toBe("no items match the current filters (0 of 5)");
    const count = need(v.container, "match-count");
    expect([count.getAttribute("data-matched"), count.getAttribute("data-total")]).toEqual(["0", "5"]);
    expect(text(need(v.container, "provenance-summary"))).toBe("read=1 parsed=1 compiled=1 observed=1 inferred=1");
    expect(text(need(v.container, "evidence-coverage"))).toBe("sources=s1,s2");
    expect(qa(v.container, "row")).toHaveLength(0);
  });
  // why: design 4 "provenance badges on facts" includes graph nodes and edges, drawn inside the SVG.
  // proves: CLAIM(MC5)
  it("[MC5] a graph shows a badge on each of its 5 nodes and 6 edges, matching their provenance, and the inferred edge shows its reason", async () => {
    const v = await openBundle(tmp("graph"), goldenBundle("graph"), SUBJECT, "d-graph", { decorate: fixedFresh });
    const nodes = qa(v.container, "graph-node");
    const edges = qa(v.container, "graph-edge");
    expect([nodes.length, edges.length]).toEqual([5, 6]);
    const badgeWord = (el: HTMLElement) => qa(el, "provenance-badge").map((b) => text(b));
    expect(nodes.map(badgeWord)).toEqual([["read"], ["read"], ["parsed"], ["observed"], ["compiled"]]);
    expect(edges.map(badgeWord)).toEqual([["read"], ["read"], ["inferred"], ["observed"], ["compiled"], ["parsed"]]);
    expect(qa(byId(v.container, "graph-edge", "e3"), "inferred-reason").map((r) => text(r))).toEqual(["callback re-enters the engine"]);
    expect(qa(v.container, "inferred-reason")).toHaveLength(1);
  });
  // why: inferred facts in shape and notebook components must also carry their reason (every component, not just list).
  // proves: CLAIM(MC5)
  it("[MC5] shape field f-tag and notebook claim b-c2 (both inferred) show their reasons", async () => {
    const shape = await openBundle(tmp("shape"), goldenBundle("shape"), SUBJECT, "d-shape", { decorate: fixedFresh });
    expect(qa(shape.container, "inferred-reason").map((r) => text(r))).toEqual(["seen in one log line"]);
    expect(byId(shape.container, "field", "f-tag").contains(qa(shape.container, "inferred-reason")[0]!)).toBe(true);
    const nb = await openBundle(tmp("nb"), goldenBundle("notebook"), SUBJECT, "d-notebook", { decorate: fixedFresh });
    expect(qa(nb.container, "inferred-reason").map((r) => text(r))).toEqual(["two observations disagree"]);
    expect(byId(nb.container, "block", "b-c2").contains(qa(nb.container, "inferred-reason")[0]!)).toBe(true);
  });
});
