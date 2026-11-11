// @vitest-environment jsdom
// MC10: accessibility supports the core route. Using only KeyboardEvents (and focus), open a row, change tabs, expand a
// tree, follow source, dismiss a menu and return to the invoking control; names, tab relationships, focus order,
// selection state and non-colour alternatives are asserted, and axe-core runs on every v0 view beside them.
// Keys are handled on keydown (docs/contract-additions/dom.md A3), so dispatching KeyboardEvent drives the viewer.
// Scope: co-located with src/viewer (the viewer's keyboard behaviour is part of its public contract).
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import {
  SUBJECT, accessibleName, byId, fixedFresh, focusEl, goldenBundle, ids, need, node, openBundle, ownText, panes, paneAt, paneEntityIds, press, qa, q,
  selectedTab, sourceRepoSetup, tabDefinitionIds, tabStops, text, trailIds, useViewerCleanup, click,
  type MountedViewer,
} from "../../test/helpers/dom-harness.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
useViewerCleanup();

const openNav = (preferred = "d-children"): Promise<MountedViewer> =>
  openBundle(tmp("nav"), goldenBundle("nav"), node("A"), preferred, { decorate: fixedFresh, repositories: sourceRepoSetup(tmp("repo")) });

describe("[MC10] the core route with the keyboard only", () => {
  // why: design 7 MC10 "Using only the keyboard, open a row, change tabs, expand a tree, follow source, dismiss a menu, and
  //      return to the invoking control". One flow proves the pieces compose (focus survives re-render, panes do not multiply).
  // proves: CLAIM(MC10)
  it("[MC10] flow: Enter opens a row's entity; arrows change tabs; ArrowRight expands a tree node; Enter on an annotation opens source; the actions menu opens and Escape returns focus to its button", async () => {
    const v = await openNav();
    // 1. focus the first row (tab stop) and open its entity
    const firstRow = byId(paneAt(v, 0), "row", "a-to-b");
    focusEl(firstRow, "row a-to-b");
    await press(v, "Enter");
    expect(paneEntityIds(v)).toEqual(["A", "B"]);
    expect(byId(paneAt(v, 0), "row", "a-to-b").getAttribute("aria-selected")).toBe("true");
    // 2. tabs of pane 0: priorities 10 children, 15 alt, 20 tree -> ArrowRight twice, ArrowLeft once, ArrowRight once
    focusEl(selectedTab(paneAt(v, 0)), "selected tab");
    const stepTab = async (key: string, expected: string) => {
      await press(v, key);
      expect(selectedTab(paneAt(v, 0)).getAttribute("data-definition-id"), `after ${key}`).toBe(expected);
      expect(document.activeElement, `focus follows the selected tab after ${key}`).toBe(selectedTab(paneAt(v, 0)));
    };
    await stepTab("ArrowRight", "d-alt");
    await stepTab("ArrowRight", "d-tree");
    await stepTab("ArrowLeft", "d-alt");
    await stepTab("ArrowRight", "d-tree");
    expect(paneEntityIds(v), "switching tabs creates no pane").toEqual(["A", "B"]);
    // 3. expand t-1 with ArrowRight: aria-expanded flips, the child appears, no new pane
    focusEl(byId(paneAt(v, 0), "node", "t-1"), "tree node t-1");
    expect(byId(paneAt(v, 0), "node", "t-1").getAttribute("aria-expanded")).toBe("false");
    await press(v, "ArrowRight");
    expect(byId(paneAt(v, 0), "node", "t-1").getAttribute("aria-expanded")).toBe("true");
    expect(ids(qa(paneAt(v, 0), "node"))).toEqual(["t-root", "t-1", "t-1a", "t-2"]);
    expect(paneEntityIds(v)).toEqual(["A", "B"]);
    // 4. tabs to Code (graph 25, code 30), focus annotation a1, Enter opens the stored source
    focusEl(selectedTab(paneAt(v, 0)), "selected tab");
    await stepTab("ArrowRight", "d-graph");
    await stepTab("ArrowRight", "d-code");
    focusEl(byId(paneAt(v, 0), "annotation", "a1"), "annotation a1");
    await press(v, "Enter");
    expect(qa(paneAt(v, 0), "source-line").filter((l) => l.getAttribute("data-highlighted") === "true").map((l) => l.getAttribute("data-line"))).toEqual(["11", "12"]);
    expect(text(need(paneAt(v, 0), "source-origin"))).toContain("src/check.ts");
    // 5. actions menu of pane 1 (B): open with Enter, Escape closes it and focus returns to the invoking button
    const buttonOf = () => need(byId(paneAt(v, 1), "row", "b-to-c"), "actions-button", "row b-to-c");
    focusEl(buttonOf(), "actions-button");
    expect([buttonOf().getAttribute("aria-haspopup"), buttonOf().getAttribute("aria-expanded")]).toEqual(["menu", "false"]);
    await press(v, "Enter");
    expect(buttonOf().getAttribute("aria-expanded")).toBe("true");
    expect(need(paneAt(v, 1), "actions-menu").getAttribute("role")).toBe("menu");
    await press(v, "Escape");
    expect(q(paneAt(v, 1), "actions-menu")).toBeNull();
    expect(buttonOf().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(buttonOf());
    expect(trailIds(v)).toEqual(["A", "B"]);
  });
});

describe("[MC10] tabs", () => {
  // why: WAI-ARIA tabs: one tab stop (roving tabindex), aria-controls to a tabpanel labelled by the tab, selection state exposed.
  // proves: CLAIM(MC10)
  it("[MC10] roving tabindex (0 on the selected tab only), aria-selected on exactly one, aria-controls -> tabpanel -> aria-labelledby -> tab, before and after switching", async () => {
    const v = await openNav();
    const check = (when: string) => {
      const tabs = qa(paneAt(v, 0), "tab");
      expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true"), `${when}: exactly one selected`).toHaveLength(1);
      const selected = selectedTab(paneAt(v, 0));
      expect(tabs.map((t) => [t.getAttribute("data-definition-id"), t.getAttribute("tabindex")]).filter(([, i]) => i === "0").map(([d]) => d), `${when}: only the selected tab is in the tab order`).toEqual([selected.getAttribute("data-definition-id")]);
      expect(tabs.every((t) => t.getAttribute("role") === "tab"), `${when}: role=tab`).toBe(true);
      expect(need(paneAt(v, 0), "view-tabs").getAttribute("role")).toBe("tablist");
      const panelId = selected.getAttribute("aria-controls");
      expect(panelId, `${when}: aria-controls`).toBeTruthy();
      const panel = document.getElementById(panelId as string);
      expect(panel?.getAttribute("data-pw"), `${when}: aria-controls points at the tabpanel`).toBe("tabpanel");
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.getAttribute("aria-labelledby"), `${when}: the tabpanel is labelled by the tab`).toBe(selected.getAttribute("id"));
      expect(selected.getAttribute("id")).toBeTruthy();
    };
    check("initial");
    // available tabs for A in priority order (d-needs is unavailable and is not a tab): 10, 15, 20, 25, 30, then the two built-ins
    expect(tabDefinitionIds(paneAt(v, 0))).toEqual(["d-children", "d-alt", "d-tree", "d-graph", "d-code", "builtin:metadata", "builtin:raw"]);
    focusEl(selectedTab(paneAt(v, 0)));
    await press(v, "ArrowRight");
    check("after ArrowRight");
  });
  // why: arrow keys wrap and Home/End jump (APG), so a user can reach the last tab without Tab/Shift+Tab through all.
  // proves: CLAIM(MC10)
  it("[MC10] End selects the last tab, ArrowRight wraps to the first, ArrowLeft wraps back, Home selects the first", async () => {
    const v = await openNav();
    focusEl(selectedTab(paneAt(v, 0)));
    const now = () => selectedTab(paneAt(v, 0)).getAttribute("data-definition-id");
    await press(v, "End");
    expect(now()).toBe("builtin:raw");
    await press(v, "ArrowRight");
    expect(now()).toBe("d-children");
    await press(v, "ArrowLeft");
    expect(now()).toBe("builtin:raw");
    await press(v, "Home");
    expect(now()).toBe("d-children");
  });
});

describe("[MC10] rows, tree and selection state", () => {
  // why: list rows are one tab stop (roving) and arrows move between them, as in an ARIA grid.
  // proves: CLAIM(MC10)
  it("[MC10] ArrowDown/ArrowUp move focus between rows with a roving tabindex", async () => {
    const v = await openNav();
    const row = (id: string) => byId(paneAt(v, 0), "row", id);
    expect(row("a-to-b").getAttribute("tabindex")).toBe("0");
    expect(row("a-to-d").getAttribute("tabindex")).toBe("-1");
    focusEl(row("a-to-b"));
    await press(v, "ArrowDown");
    expect(document.activeElement).toBe(row("a-to-d"));
    expect([row("a-to-d").getAttribute("tabindex"), row("a-to-b").getAttribute("tabindex")]).toEqual(["0", "-1"]);
    await press(v, "ArrowUp");
    expect(document.activeElement).toBe(row("a-to-b"));
  });
  // why: selection must be exposed to assistive technology, not only by colour.
  // proves: CLAIM(MC10)
  it("[MC10] Enter on a row sets aria-selected=true on that row only and leaves all others false", async () => {
    const v = await openNav();
    focusEl(byId(paneAt(v, 0), "row", "a-to-d"));
    await press(v, "Enter");
    const states = Object.fromEntries(qa(paneAt(v, 0), "row").map((r) => [r.getAttribute("data-id"), r.getAttribute("aria-selected")]));
    expect(states).toEqual({ "a-to-b": "false", "a-to-d": "true", "a-none": "false", "a-src": "false" });
    expect(paneEntityIds(v)).toEqual(["A", "D"]);
  });
  // why: ArrowRight/ArrowLeft expand and collapse (contract Tree); a leaf ignores them; a node without a target creates no pane.
  // proves: CLAIM(MC10) / CLAIM(MC7)
  it("[MC10] tree: ArrowRight expands, ArrowLeft collapses, a leaf ignores both, Enter opens the entity of t-2 and does nothing for target-less t-1", async () => {
    const v = await openNav("d-tree");
    const node_ = (id: string) => byId(paneAt(v, 0), "node", id);
    expect(ids(qa(paneAt(v, 0), "node"))).toEqual(["t-root", "t-1", "t-2"]);
    focusEl(node_("t-1"));
    await press(v, "ArrowRight");
    expect([node_("t-1").getAttribute("aria-expanded"), ids(qa(paneAt(v, 0), "node"))]).toEqual(["true", ["t-root", "t-1", "t-1a", "t-2"]]);
    await press(v, "ArrowLeft");
    expect([node_("t-1").getAttribute("aria-expanded"), ids(qa(paneAt(v, 0), "node"))]).toEqual(["false", ["t-root", "t-1", "t-2"]]);
    focusEl(node_("t-2"));
    await press(v, "ArrowRight");
    await press(v, "ArrowLeft");
    expect(ids(qa(paneAt(v, 0), "node")), "a leaf has nothing to expand or collapse").toEqual(["t-root", "t-1", "t-2"]);
    expect(node_("t-2").hasAttribute("aria-expanded")).toBe(false);
    expect(paneEntityIds(v)).toEqual(["A"]);
    focusEl(node_("t-1"));
    await press(v, "Enter");
    expect(paneEntityIds(v), "t-1 has neither entity nor anchor: no pane").toEqual(["A"]);
    focusEl(node_("t-2"));
    await press(v, "Enter");
    expect(paneEntityIds(v)).toEqual(["A", "B"]);
  });
});

describe("[MC10] actions menu", () => {
  // why: contract Facts: aria-haspopup/expanded on the button, role=menu with menuitems of the documented kinds, arrows move
  //      between items, Escape closes the menu and focus returns to the actions-button.
  // proves: CLAIM(MC10)
  it("[MC10] a row with an entity and an anchor offers open-entity then open-source; the first item takes focus, ArrowDown moves, Escape closes and returns focus", async () => {
    const v = await openBundle(tmp("list"), goldenBundle("list"), SUBJECT, "d-list", { decorate: fixedFresh });
    const button = () => need(byId(v.container, "row", "r1"), "actions-button");
    focusEl(button());
    await press(v, "Enter");
    expect(button().getAttribute("aria-expanded")).toBe("true");
    const menu = need(v.container, "actions-menu");
    expect(menu.getAttribute("role")).toBe("menu");
    const items = qa(menu, "menu-item");
    expect(items.map((i) => [i.getAttribute("role"), i.getAttribute("data-kind")])).toEqual([["menuitem", "open-entity"], ["menuitem", "open-source"]]);
    expect(document.activeElement).toBe(items[0]);
    await press(v, "ArrowDown");
    expect(document.activeElement).toBe(qa(need(v.container, "actions-menu"), "menu-item")[1]);
    await press(v, "Escape");
    expect(q(v.container, "actions-menu")).toBeNull();
    expect(document.activeElement).toBe(button());
    expect(button().getAttribute("aria-expanded")).toBe("false");
  });
  // why: the menu must offer only what the item has; an entity-only row has no open-source, an anchor-only row no open-entity.
  // proves: CLAIM(MC10) (negative controls for the menu contents)
  it("[MC10] an entity-only row offers just open-entity and an anchor-only row just open-source", async () => {
    const v = await openNav();
    const kinds = async (rowId: string) => {
      focusEl(need(byId(paneAt(v, 0), "row", rowId), "actions-button"));
      await press(v, "Enter");
      const k = qa(need(v.container, "actions-menu"), "menu-item").map((i) => i.getAttribute("data-kind"));
      await press(v, "Escape");
      return k;
    };
    expect(await kinds("a-to-b")).toEqual(["open-entity"]);
    expect(await kinds("a-src")).toEqual(["open-source"]);
  });
  // why: activating open-entity from the keyboard must navigate, like Enter on the row, and must close the menu.
  // proves: CLAIM(MC10)
  it("[MC10] Enter on the open-entity menu item opens the entity pane and closes the menu", async () => {
    const v = await openNav();
    focusEl(need(byId(paneAt(v, 0), "row", "a-to-b"), "actions-button"));
    await press(v, "Enter");
    await press(v, "Enter"); // the first item has focus
    expect(paneEntityIds(v)).toEqual(["A", "B"]);
    expect(q(v.container, "actions-menu")).toBeNull();
  });
});

describe("[MC10] following source from a menu", () => {
  // why: design 7 MC10 "follow source" with the keyboard only: the open-source item of a graph edge's menu opens the stored excerpt.
  // proves: CLAIM(MC10) / CLAIM(MC8)
  it("[MC10] Enter on the open-source menu item of graph edge ge1 shows the stored source with lines 11-12 highlighted and no new pane; the menu closes", async () => {
    const v = await openNav("d-graph");
    focusEl(need(byId(paneAt(v, 0), "graph-edge-item", "ge1"), "actions-button"));
    await press(v, "Enter");
    expect(qa(need(v.container, "actions-menu"), "menu-item").map((i) => i.getAttribute("data-kind"))).toEqual(["open-source"]);
    await press(v, "Enter");
    expect(qa(need(paneAt(v, 0), "source"), "source-line").map((l) => [l.getAttribute("data-line"), l.getAttribute("data-highlighted")])).toEqual([["10", "false"], ["11", "true"], ["12", "true"]]);
    expect(q(v.container, "actions-menu")).toBeNull();
    expect(paneEntityIds(v)).toEqual(["A"]);
  });
});

describe("[MC10] tab order and names", () => {
  // why: the Tab sequence is the DOM sequence of the interactive controls; no positive tabindex may reorder it.
  // proves: CLAIM(MC10)
  it("[MC10] the tab stops of a list pane run crumb, pin, tab, filter-input, row in that order, each shell control exactly once, and no tabindex is positive", async () => {
    const v = await openBundle(tmp("list"), goldenBundle("list"), SUBJECT, "d-list", { decorate: fixedFresh });
    const names = tabStops(v.container).map((e) => e.getAttribute("data-pw") ?? e.tagName.toLowerCase());
    const first = (name: string) => names.indexOf(name);
    for (const shell of ["crumb", "pin", "tab", "filter-input"]) expect(names.filter((n) => n === shell), `${shell} is one tab stop`).toHaveLength(1);
    expect(names.filter((n) => n === "row"), "rows are a roving group: one tab stop").toHaveLength(1);
    expect([first("crumb"), first("pin"), first("tab"), first("filter-input"), first("row")].every((i, k, a) => i >= 0 && (k === 0 || i > a[k - 1]!))).toBe(true);
    const positive = Array.from(v.container.querySelectorAll("[tabindex]")).filter((e) => Number(e.getAttribute("tabindex")) > 0);
    expect(positive).toHaveLength(0);
  });
  // why: graph nodes are individually focusable in the SVG and must be visited in id order = DOM order, not scattered by geometry.
  // proves: CLAIM(MC10)
  it("[MC10] graph nodes are tab stops in id order a, b, c, d, e", async () => {
    const v = await openBundle(tmp("graph"), goldenBundle("graph"), SUBJECT, "d-graph", { decorate: fixedFresh });
    const stops = tabStops(v.container).filter((e) => e.getAttribute("data-pw") === "graph-node").map((e) => e.getAttribute("data-id"));
    expect(stops).toEqual(["a", "b", "c", "d", "e"]);
  });
  // why: every interactive element needs an accessible name (aria-label or text); a nameless control is unusable with a screen reader.
  // proves: CLAIM(MC10)
  it("[MC10] every tab stop, tab, treeitem and gridcell row in all seven views has a non-empty accessible name", async () => {
    const views: Array<[string, string, string]> = [["list", "list", "d-list"], ["tree", "tree", "d-tree"], ["graph", "graph", "d-graph"], ["source", "source", "d-code"], ["shape", "shape", "d-shape"], ["notebook", "notebook", "d-notebook"], ["example-runs", "example-runs", "d-example"]];
    const nameless: string[] = [];
    for (const [label, bundle, preferred] of views) {
      const v = await openBundle(tmp(label), goldenBundle(bundle), SUBJECT, preferred, { decorate: fixedFresh, repositories: sourceRepoSetup(tmp("repo")) });
      const stops = tabStops(v.container);
      const roles = Array.from(v.container.querySelectorAll<HTMLElement>('[role="tab"], [role="treeitem"], [role="row"][tabindex], [role="menuitem"], [role="button"]'));
      const all = Array.from(new Set([...stops, ...roles]));
      expect(all.length, `${label}: found interactive elements`).toBeGreaterThanOrEqual(4);
      for (const el of all) if (accessibleName(el) === "") nameless.push(`${label}: ${el.getAttribute("data-pw") ?? el.tagName}#${el.getAttribute("data-id") ?? ""}`);
    }
    expect(nameless).toEqual([]);
  });
});

describe("[MC10] non-colour alternatives", () => {
  // why: provenance, completeness and freshness must be readable without colour (design 7 MC10).
  // proves: CLAIM(MC10)
  it("[MC10] in all seven views each provenance-badge's text is its provenance word, completeness and freshness carry data-status and a status word", async () => {
    const views: Array<[string, string, string, string]> = [["list", "list", "d-list", "complete"], ["tree", "tree", "d-tree", "complete"], ["graph", "graph", "d-graph", "complete"], ["source", "source", "d-code", "complete"], ["shape", "shape", "d-shape", "complete"], ["notebook", "notebook", "d-notebook", "complete"], ["example-notrun", "example-notrun", "d-example", "partial"]];
    const problems: string[] = [];
    for (const [label, bundle, preferred, completeness] of views) {
      const v = await openBundle(tmp(label), goldenBundle(bundle), SUBJECT, preferred, { decorate: fixedFresh, repositories: sourceRepoSetup(tmp("repo")) });
      const badges = qa(v.container, "provenance-badge");
      if (badges.length === 0) problems.push(`${label}: no badges`);
      for (const b of badges) if (text(b) !== b.getAttribute("data-provenance") || text(b) === "") problems.push(`${label}: badge text ${JSON.stringify(text(b))} vs ${b.getAttribute("data-provenance")}`);
      const c = need(v.container, "completeness", label);
      if (c.getAttribute("data-status") !== completeness || !text(c).startsWith(completeness)) problems.push(`${label}: completeness ${c.getAttribute("data-status")} ${JSON.stringify(text(c))}`);
      const f = need(v.container, "freshness", label);
      if (f.getAttribute("data-status") !== "fresh" || text(f) !== "fresh") problems.push(`${label}: freshness ${f.getAttribute("data-status")} ${JSON.stringify(text(f))}`);
    }
    expect(problems).toEqual([]);
  });
  // why: colour must never carry meaning alone for claim status, assertion outcome and graph relations.
  // proves: CLAIM(MC10)
  it("[MC10] claim-status text equals its data-status, assertions end in PASS or FAIL matching data-passed, and the graph has a textual edge list with 6 items", async () => {
    const nb = await openBundle(tmp("nb"), goldenBundle("notebook"), SUBJECT, "d-notebook", { decorate: fixedFresh });
    expect(qa(nb.container, "claim-status").map((s) => [s.getAttribute("data-status"), text(s)])).toEqual([["supported", "supported"], ["disputed", "disputed"], ["open", "open"]]);
    const ex = await openBundle(tmp("ex"), goldenBundle("example-runs"), SUBJECT, "d-example", { decorate: fixedFresh });
    expect(qa(ex.container, "assertion").map((a) => [a.getAttribute("data-passed"), ownText(a).split(" ").pop()])).toEqual([["true", "PASS"], ["true", "PASS"], ["false", "FAIL"]]);
    const gr = await openBundle(tmp("gr"), goldenBundle("graph"), SUBJECT, "d-graph", { decorate: fixedFresh });
    expect(qa(gr.container, "graph-edge-item")).toHaveLength(6);
    expect(qa(gr.container, "edge-label").map((e) => text(e))).toEqual(["invokes", "calls", "calls", "writes", "logs", "retries"]);
  });
});

describe("[MC10] automated accessibility check (axe-core)", () => {
  // jsdom has no layout, so colour contrast cannot be computed; every other WCAG 2.x A/AA rule runs.
  const AXE_OPTIONS = {
    runOnly: { type: "tag" as const, values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    rules: { "color-contrast": { enabled: false } },
  };
  const runAxe = async (root: HTMLElement) => {
    const result = await axe.run(root, AXE_OPTIONS);
    return result.violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  };

  // why: proves the check is live in this environment: if axe silently found nothing everywhere, the seven assertions below mean nothing.
  // proves: CLAIM(MC10) (positive control)
  it("[MC10] positive control: axe flags an unlabelled button and an image without alt inside a mounted viewer's container", async () => {
    const v = await openBundle(tmp("list"), goldenBundle("list"), SUBJECT, "d-list", { decorate: fixedFresh });
    const bad = document.createElement("div");
    bad.innerHTML = '<button></button><img src="x.png">';
    v.container.append(bad);
    const ruleIds = (await runAxe(v.container)).map((x) => x.split(":")[0]);
    expect(ruleIds).toContain("button-name");
    expect(ruleIds).toContain("image-alt");
  });

  const VIEWS: Array<[string, string, string, (v: MountedViewer) => Promise<void>]> = [
    ["list", "list", "d-list", async () => {}],
    ["tree", "tree", "d-tree", async () => {}],
    ["graph", "graph", "d-graph", async () => {}],
    ["source (annotation activated)", "source", "d-code", async (v) => { await click(v, byId(v.container, "annotation", "a1")); }],
    ["shape", "shape", "d-shape", async () => {}],
    ["notebook (a claim expanded)", "notebook", "d-notebook", async (v) => { await click(v, need(byId(v.container, "block", "b-c2"), "toggle", "block b-c2")); }],
    ["example (two runs)", "example-runs", "d-example", async () => {}],
  ];
  for (const [label, bundle, preferred, prepare] of VIEWS) {
    // why: design 7 MC10 "Run an automated accessibility check alongside these behavioral assertions" - on each v0 view.
    // proves: CLAIM(MC10)
    it(`[MC10] axe finds no WCAG A/AA violation in the ${label} view`, async () => {
      const v = await openBundle(tmp(bundle), goldenBundle(bundle), SUBJECT, preferred, { decorate: fixedFresh, repositories: sourceRepoSetup(tmp("repo")) });
      await prepare(v);
      expect(panes(v).length, "a viewer was rendered").toBe(1);
      expect(await runAxe(v.container)).toEqual([]);
    });
  }
  // why: an open menu adds role=menu/menuitem semantics that the static views do not exercise.
  // proves: CLAIM(MC10)
  it("[MC10] axe finds no violation with an actions menu open", async () => {
    const v = await openBundle(tmp("list"), goldenBundle("list"), SUBJECT, "d-list", { decorate: fixedFresh });
    focusEl(need(byId(v.container, "row", "r1"), "actions-button"));
    await press(v, "Enter");
    expect(q(v.container, "actions-menu")).not.toBeNull();
    expect(await runAxe(v.container)).toEqual([]);
  });
});
