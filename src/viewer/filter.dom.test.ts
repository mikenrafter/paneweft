// @vitest-environment jsdom
// MC19 (browser side): filtering is stable and the browser and the agent describe the same filtered data. Expected numbers are
// counted by hand from fixtures/goldens/filter.bundle.json (comments show the counting) and cross-checked against
// executeOperation('inspect_view') on the same session, so neither side is the oracle of the other.
import { assert, describe, expect, it } from "vitest";
import { executeOperation } from "../core/operations.ts";
import type { Session } from "../core/session.ts";
import {
  SUBJECT, byId, fixedFresh, focusEl, goldenBundle, ids, need, openBundle, qa, q, text, toggleCheckbox, typeInto, useViewerCleanup, type MountedViewer,
} from "../../test/helpers/dom-harness.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
useViewerCleanup();

/** What the agent-facing reply says about the same filtered view: counts from the JSON reply of inspect_view. */
async function agentCounts(session: Session, viewId: string, filter: Record<string, unknown>): Promise<{ matched: number; total: number }> {
  const outcome = await executeOperation(session, "inspect_view", { viewId, snapshotId: "snap-1", filter, format: "json" });
  if (!outcome.ok) assert.fail(`inspect_view failed: ${outcome.error.code}: ${outcome.error.message}`);
  const reply = JSON.parse(outcome.body) as { counts: { matched: number; total: number } };
  return { matched: reply.counts.matched, total: reply.counts.total };
}
const counts = (v: MountedViewer) => {
  const el = need(v.container, "match-count");
  return { matched: Number(el.getAttribute("data-matched")), total: Number(el.getAttribute("data-total")), text: text(el) };
};
const openFilter = () => openBundle(tmp("filter"), goldenBundle("filter"), SUBJECT, "d-filter", { decorate: fixedFresh });

describe("[MC19] text filter over a list", () => {
  // Hand count over the five rows (name, kind): f1 alpha.rs lib, f2 beta.rs bin, f3 gamma.rs lib, f4 delta.rs bin, f5 epsilon.rs lib.
  // Display order is name asc: alpha, beta, delta, epsilon, gamma = f1, f2, f4, f5, f3.
  const CASES: Array<{ filter: string; ids: string[]; why: string }> = [
    { filter: "ta", ids: ["f2", "f4"], why: "'ta' occurs in be-ta.rs and del-ta.rs only (no kind cell contains it)" },
    { filter: "LIB", ids: ["f1", "f5", "f3"], why: "case-insensitive match of the kind cell 'lib': alpha, epsilon, gamma" },
    { filter: "a", ids: ["f1", "f2", "f4", "f3"], why: "'a' is in alpha, beta, delta, gamma; epsilon.rs/lib has no 'a'" },
    { filter: "zzz", ids: [], why: "nothing contains zzz" },
    { filter: "", ids: ["f1", "f2", "f4", "f5", "f3"], why: "an empty filter matches all five" },
  ];
  // why: design 7 MC19 "Browser focus and agent counts must describe the same filtered data" - typing updates data-matched/data-total to the hand count.
  // proves: CLAIM(MC19)
  it("[MC19] typing in filter-input updates match-count and the rows to the hand-counted numbers (2, 3, 4, 0, then 5 after clearing); total stays 5", async () => {
    const v = await openFilter();
    expect(counts(v)).toEqual({ matched: 5, total: 5, text: "5 of 5 match" });
    for (const c of CASES) {
      await typeInto(v, need(v.container, "filter-input"), c.filter);
      expect(ids(qa(v.container, "row")), `filter ${JSON.stringify(c.filter)}: ${c.why}`).toEqual(c.ids);
      expect(counts(v), `filter ${JSON.stringify(c.filter)}`).toEqual({ matched: c.ids.length, total: 5, text: `${c.ids.length} of 5 match` });
    }
  });
  // why: the cross-check - the same filter through the agent operation yields the same matched/total as the DOM (and as the hand count).
  // proves: CLAIM(MC19)
  it("[MC19] for every filter the browser's data-matched/data-total equal inspect_view's counts.matched/total on the same session", async () => {
    const v = await openFilter();
    for (const c of CASES.filter((x) => x.filter !== "")) {
      await typeInto(v, need(v.container, "filter-input"), c.filter);
      const agent = await agentCounts(v.session, "v-filter", { text: c.filter });
      expect(agent, `agent for ${JSON.stringify(c.filter)}`).toEqual({ matched: c.ids.length, total: 5 });
      expect({ matched: counts(v).matched, total: counts(v).total }).toEqual(agent);
    }
  });
  // why: filtering must not steal focus from the box the user is typing in (design 7 MC19 "Browser focus").
  // proves: CLAIM(MC19)
  it("[MC19] keyboard focus stays on filter-input and its value is kept while typing character by character", async () => {
    const v = await openFilter();
    focusEl(need(v.container, "filter-input"), "filter-input");
    for (const typed of ["t", "ta"]) {
      await typeInto(v, document.activeElement as HTMLElement, typed);
      expect(document.activeElement?.getAttribute("data-pw"), `after typing ${typed}`).toBe("filter-input");
      expect((document.activeElement as HTMLInputElement).value).toBe(typed);
    }
    expect(ids(qa(v.container, "row"))).toEqual(["f2", "f4"]);
  });
  // why: the filtered-empty message must carry the total so the user knows the scope was not empty.
  // proves: CLAIM(MC19) / CLAIM(MC4)
  it("[MC19] a filter matching nothing shows \"no items match the current filters (0 of 5)\" and clearing it removes the message", async () => {
    const v = await openFilter();
    await typeInto(v, need(v.container, "filter-input"), "zzz");
    expect(text(need(v.container, "empty-state"))).toBe("no items match the current filters (0 of 5)");
    await typeInto(v, need(v.container, "filter-input"), "");
    expect(q(v.container, "empty-state")).toBeNull();
    expect(qa(v.container, "row")).toHaveLength(5);
  });
});

describe("[MC19] graph relation filter", () => {
  const edgeIds = (v: MountedViewer) => ids(qa(need(v.container, "graph"), "graph-edge"));
  const listIds = (v: MountedViewer) => ids(qa(need(v.container, "graph-edge-list"), "graph-edge-item"));
  const openGraph = () => openBundle(tmp("graph"), goldenBundle("graph"), SUBJECT, "d-graph", { decorate: fixedFresh });
  // Relations: invokes e1, calls e2 e3, writes e4, logs e5, retries e6 (6 edges).
  // why: design 2.3 "Interactions filter relation and provenance"; hidden-by-filter edges are absent from the SVG (contract Graph).
  // proves: CLAIM(MC19)
  it("[MC19] unchecking relation 'calls' removes e2 and e3 from the SVG and the edge list, keeps all 5 nodes and shows 4 of 6", async () => {
    const v = await openGraph();
    expect(ids(qa(v.container, "relation-filter"))).toEqual(["calls", "invokes", "logs", "retries", "writes"]);
    expect(edgeIds(v)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
    await toggleCheckbox(v, byId(v.container, "relation-filter", "calls"));
    expect(edgeIds(v)).toEqual(["e1", "e4", "e5", "e6"]);
    expect(listIds(v)).toEqual(["e1", "e4", "e5", "e6"]);
    expect(qa(v.container, "graph-node")).toHaveLength(5);
    expect(counts(v)).toEqual({ matched: 4, total: 6, text: "4 of 6 match" });
    // cross-check: the agent keeps edges with one of the remaining relations
    expect(await agentCounts(v.session, "v-graph", { relation: ["invokes", "logs", "retries", "writes"] })).toEqual({ matched: 4, total: 6 });
  });
  // why: filters compose and are reversible: re-checking restores the edges in their canonical order.
  // proves: CLAIM(MC19)
  it("[MC19] unchecking calls and writes leaves e1, e5, e6 (3 of 6); re-checking both restores all six", async () => {
    const v = await openGraph();
    await toggleCheckbox(v, byId(v.container, "relation-filter", "calls"));
    await toggleCheckbox(v, byId(v.container, "relation-filter", "writes"));
    expect(edgeIds(v)).toEqual(["e1", "e5", "e6"]);
    expect(counts(v)).toEqual({ matched: 3, total: 6, text: "3 of 6 match" });
    expect(await agentCounts(v.session, "v-graph", { relation: ["invokes", "logs", "retries"] })).toEqual({ matched: 3, total: 6 });
    await toggleCheckbox(v, byId(v.container, "relation-filter", "calls"));
    await toggleCheckbox(v, byId(v.container, "relation-filter", "writes"));
    expect(edgeIds(v)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
    expect(counts(v).matched).toBe(6);
  });
});

describe("[MC19] tree filter and claim filter", () => {
  // Tree golden: nodes n-src(src) n-mcp(mcp.rs) n-engine(engine) n-tick(tick.rs) n-core(core.rs) n-queue(queue) n-tests(tests) n-t-mcp(mcp.rs) = 8.
  // 'tick' occurs in the cell of n-tick only -> matched 1; its ancestors n-src and n-engine are shown as context and are not counted.
  // why: design 2.2 "filter while retaining ancestor context"; red-contract 3 "ancestors ... are not counted in matched".
  // proves: CLAIM(MC19)
  it("[MC19] filter 'tick' shows n-tick under its ancestors n-src and n-engine and counts 1 of 8, equal to inspect_view", async () => {
    const v = await openBundle(tmp("tree"), goldenBundle("tree"), SUBJECT, "d-tree", { decorate: fixedFresh });
    await typeInto(v, need(v.container, "filter-input"), "tick");
    expect(ids(qa(v.container, "node"))).toEqual(["n-src", "n-engine", "n-tick"]);
    expect(byId(v.container, "node", "n-engine").getAttribute("aria-expanded")).toBe("true");
    expect(counts(v)).toEqual({ matched: 1, total: 8, text: "1 of 8 match" });
    expect(await agentCounts(v.session, "v-tree", { text: "tick" })).toEqual({ matched: 1, total: 8 });
  });
  // why: design 2.6 "filter claims by status" - the claim-filter control narrows the visible claims, status words stay visible.
  // proves: CLAIM(MC19)
  it("[MC19] choosing 'open' in claim-filter leaves only the open claim; choosing 'all' restores the three", async () => {
    const v = await openBundle(tmp("nb"), goldenBundle("notebook"), SUBJECT, "d-notebook", { decorate: fixedFresh });
    expect(Array.from((need(v.container, "claim-filter") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["all", "supported", "disputed", "open"]);
    const choose = async (value: string) => {
      const select = need(v.container, "claim-filter") as HTMLSelectElement;
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await v.handle.whenIdle();
    };
    await choose("open");
    expect(qa(v.container, "claim-status").map((s) => s.getAttribute("data-status"))).toEqual(["open"]);
    await choose("all");
    expect(qa(v.container, "claim-status").map((s) => s.getAttribute("data-status"))).toEqual(["supported", "disputed", "open"]);
  });
});
