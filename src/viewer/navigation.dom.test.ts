// @vitest-environment jsdom
// MC7 (pane navigation preserves context) and MC8 (cross-view links resolve exactly) in the browser DOM.
// The navigation model below is written independently of src/core/inspector.ts from red-contract section 4.
// Back is wired as docs/contract-additions/dom.md A1 (history.pushState({paneweft: state}) per state-changing action, restore on popstate).
import { describe, expect, it } from "vitest";
import {
  SUBJECT, byId, click, crumbs, fixedFresh, goldenBundle, ids, mountBundle, need, node, openBundle, openEntity, ownText, paneAt, paneEntityIds, panes,
  press, qa, q, retagSnapshot, selectedTab, sourceRepoSetup, text, trailIds, useViewerCleanup, visiblePanes, withMissingView, focusEl,
  type MountedViewer,
} from "../../test/helpers/dom-harness.ts";
import { must } from "../../test/helpers/must.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
useViewerCleanup();

const openNav = (preferred = "d-children", setup = {}): Promise<MountedViewer> =>
  openBundle(tmp("nav"), goldenBundle("nav"), node("A"), preferred, { decorate: fixedFresh, repositories: sourceRepoSetup(tmp("repo")), ...setup });

// ---- an independent model of the inspector (red-contract 4) for the nav fixture
interface MPane { entity: string; view: string; selection: string[]; pinned: boolean }
interface MFrame { trail: MPane[]; retained: MPane[] }
const TARGETS: Record<string, Record<string, string | null>> = {
  A: { "a-to-b": "B", "a-to-d": "D", "a-none": null }, B: { "b-to-c": "C" }, C: { "c-leaf": null }, D: { "d-x": null },
};
const ITEMS_IN_VIEW: Record<string, Record<string, string[]>> = { A: { "d-children": ["a-to-b", "a-to-d", "a-none", "a-src"], "d-alt": ["a-to-b", "a-alt-only"] } };
const fresh = (entity: string): MPane => ({ entity, view: "d-children", selection: [], pinned: false });
const copy = (s: MFrame): MFrame => structuredClone(s);
function mSelect(s: MFrame, paneIndex: number, itemId: string): MFrame {
  const out = copy(s);
  out.trail[paneIndex]!.selection = [itemId];
  const cut = out.trail.slice(paneIndex + 1);
  out.retained.push(...cut.filter((p) => p.pinned));
  out.trail = out.trail.slice(0, paneIndex + 1);
  const target = TARGETS[out.trail[paneIndex]!.entity]?.[itemId];
  if (target) out.trail.push(fresh(target));
  return out;
}
function mPin(s: MFrame, paneIndex: number): MFrame { const out = copy(s); out.trail[paneIndex]!.pinned = true; return out; }
function mSwitch(s: MFrame, paneIndex: number, view: string): MFrame {
  const out = copy(s);
  const pane = out.trail[paneIndex]!;
  pane.view = view;
  const valid = ITEMS_IN_VIEW[pane.entity]?.[view] ?? [];
  pane.selection = pane.selection.filter((id) => valid.includes(id));
  return out;
}
const observed = (v: MountedViewer): MFrame => {
  const s = v.handle.state();
  const shape = (p: (typeof s.trail)[number]): MPane => ({ entity: p.entity.id, view: p.viewDefinitionId, selection: p.selection, pinned: p.pinned });
  return { trail: s.trail.map(shape), retained: s.retained.map(shape) };
};
async function back(v: MountedViewer): Promise<void> {
  await new Promise<void>((resolve) => {
    const once = () => { window.removeEventListener("popstate", once); resolve(); };
    window.addEventListener("popstate", once);
    history.back();
  });
  await v.handle.whenIdle();
}

describe("[MC7] expansion and selection", () => {
  // why: design 3 "Expansion ... distinct controls so selecting a tree chevron does not navigate".
  // proves: CLAIM(MC7)
  it("[MC7] clicking a tree toggle flips aria-expanded and never spawns a pane, changes the inspector state or pushes history", async () => {
    const v = await openNav("d-tree");
    const stateBefore = observed(v);
    const historyBefore = history.length;
    const toggle = () => need(byId(paneAt(v, 0), "node", "t-1"), "toggle", "node t-1");
    expect(byId(paneAt(v, 0), "node", "t-1").getAttribute("aria-expanded")).toBe("false");
    await click(v, toggle());
    expect(byId(paneAt(v, 0), "node", "t-1").getAttribute("aria-expanded")).toBe("true");
    expect(ids(qa(paneAt(v, 0), "node"))).toEqual(["t-root", "t-1", "t-1a", "t-2"]);
    expect([panes(v).length, v.handle.state().trail.length]).toEqual([1, 1]);
    expect(observed(v)).toEqual(stateBefore);
    expect(history.length).toBe(historyBefore);
    await click(v, toggle());
    expect(byId(paneAt(v, 0), "node", "t-1").getAttribute("aria-expanded")).toBe("false");
    expect(panes(v)).toHaveLength(1);
  });
  // why: design 3 "An item without an entity or anchor shows that absence; clicking it must not invent a target".
  // proves: CLAIM(MC7)
  it("[MC7] Enter on a row without a target creates no pane, shows no-target and selects only that row", async () => {
    const v = await openNav();
    const row = byId(paneAt(v, 0), "row", "a-none");
    expect(need(row, "no-target").textContent).toBeTruthy();
    expect(q(row, "actions-button"), "a target-less row has no actions").toBeNull();
    focusEl(row);
    await press(v, "Enter");
    expect(panes(v)).toHaveLength(1);
    expect(observed(v)).toEqual({ trail: [{ entity: "A", view: "d-children", selection: ["a-none"], pinned: false }], retained: [] });
    await click(v, need(row, "no-target"));
    expect(panes(v), "activating no-target creates no pane").toHaveLength(1);
  });
});

describe("[MC7] trail, pin, switch and Back", () => {
  // why: design 3 "Selecting an inspectable item opens the next pane"; crumbs mirror the trail and mark the active pane.
  // proves: CLAIM(MC7)
  it("[MC7] selecting A -> B -> C builds three crumbs with aria-current on the last only; selecting another child of A cuts the trail", async () => {
    const v = await openNav();
    await click(v, byId(paneAt(v, 0), "row", "a-to-b"));
    await click(v, byId(paneAt(v, 1), "row", "b-to-c"));
    expect(crumbs(v).map((c) => [text(c), c.getAttribute("data-pane-index"), c.getAttribute("aria-current")])).toEqual([
      ["Node A", "0", null], ["Node B", "1", null], ["Node C", "2", "page"],
    ]);
    expect(paneEntityIds(v)).toEqual(["A", "B", "C"]);
    expect(trailIds(v)).toEqual(["A", "B", "C"]);
    await click(v, byId(paneAt(v, 0), "row", "a-to-d"));
    expect(crumbs(v).map((c) => [text(c), c.getAttribute("aria-current")])).toEqual([["Node A", null], ["Node D", "page"]]);
    expect(paneEntityIds(v)).toEqual(["A", "D"]);
  });
  // why: design 7 MC7 "Select A -> B -> C, pin B, select a different child of A, switch a view, then use Back. Compare entity IDs,
  //      snapshot IDs, selection, and retained branch against a small independent navigation model."
  // proves: CLAIM(MC7)
  it("[MC7] model flow: select A->B->C, pin B, select another child of A, switch view; state equals the model after every step and Back restores each earlier state", async () => {
    const v = await openNav();
    let model: MFrame = { trail: [fresh("A")], retained: [] };
    const snapshots: MFrame[] = [model];
    const step = async (label: string, next: MFrame, act: () => Promise<void>) => {
      await act();
      model = next;
      snapshots.push(model);
      expect(observed(v), label).toEqual(model);
      expect(trailIds(v), `${label}: panes in the DOM`).toEqual(model.trail.map((p) => p.entity));
    };
    expect(observed(v)).toEqual(model);
    await step("select a-to-b", mSelect(model, 0, "a-to-b"), () => click(v, byId(paneAt(v, 0), "row", "a-to-b")));
    await step("select b-to-c", mSelect(model, 1, "b-to-c"), () => click(v, byId(paneAt(v, 1), "row", "b-to-c")));
    await step("pin B", mPin(model, 1), () => click(v, need(paneAt(v, 1), "pin")));
    expect([need(paneAt(v, 1), "pin").getAttribute("aria-pressed"), paneAt(v, 1).getAttribute("data-pinned")]).toEqual(["true", "true"]);
    await step("select a-to-d", mSelect(model, 0, "a-to-d"), () => click(v, byId(paneAt(v, 0), "row", "a-to-d")));
    expect(observed(v).retained.map((p) => p.entity), "the pinned branch B is retained, unpinned C is dropped").toEqual(["B"]);
    await step("switch A to alt", mSwitch(model, 0, "d-alt"), () => click(v, qa(paneAt(v, 0), "tab").find((t) => t.getAttribute("data-definition-id") === "d-alt") as HTMLElement));
    expect(observed(v).trail[0]!.selection, "a-to-d does not exist in the alt view").toEqual([]);
    // Back: each popstate restores the {trail, retained} of the previous history entry (switch -> select a-to-d -> pin)
    await back(v);
    expect(observed(v)).toEqual(snapshots[4]);
    await back(v);
    expect(observed(v)).toEqual(snapshots[3]);
    expect(paneEntityIds(v)).toEqual(["A", "B", "C"]);
    expect(need(paneAt(v, 1), "pin").getAttribute("aria-pressed")).toBe("true");
  });
  // why: A1 of the additions: the history entry carries the inspector state, so Back and deep restore have something to read.
  // proves: CLAIM(MC7)
  it("[MC7] every state-changing action pushes history.state.paneweft with the current trail", async () => {
    const v = await openNav();
    const trailOf = () => (history.state?.paneweft?.trail ?? []).map((p: { entity: { id: string } }) => p.entity.id);
    expect(trailOf()).toEqual(["A"]);
    const before = history.length;
    await click(v, byId(paneAt(v, 0), "row", "a-to-b"));
    expect(history.length).toBe(before + 1);
    expect(trailOf()).toEqual(["A", "B"]);
  });
  // why: reducer pin is one-way (red-contract 4: already pinned -> unchanged state, no new history entry).
  // proves: CLAIM(MC7)
  it("[MC7] pin sets aria-pressed=true and data-pinned=true; pressing it again leaves the state and history unchanged", async () => {
    const v = await openNav();
    await click(v, byId(paneAt(v, 0), "row", "a-to-b"));
    expect(need(paneAt(v, 0), "pin").getAttribute("aria-pressed")).toBe("false");
    await click(v, need(paneAt(v, 0), "pin"));
    const state = observed(v);
    const length = history.length;
    expect(need(paneAt(v, 0), "pin").getAttribute("aria-pressed")).toBe("true");
    expect(paneAt(v, 1).getAttribute("data-pinned")).toBe("false");
    await click(v, need(paneAt(v, 0), "pin"));
    expect(observed(v)).toEqual(state);
    expect(history.length).toBe(length);
    expect(need(paneAt(v, 0), "pin").getAttribute("aria-pressed")).toBe("true");
  });
  // why: design 3 "Changing tabs preserves the entity and its valid selection" - a selection that exists in the new view survives.
  // proves: CLAIM(MC7)
  it("[MC7] switching to a view that still has the selected item keeps entity, snapshot, selection and the next pane", async () => {
    const v = await openNav();
    await click(v, byId(paneAt(v, 0), "row", "a-to-b"));
    await click(v, qa(paneAt(v, 0), "tab").find((t) => t.getAttribute("data-definition-id") === "d-alt") as HTMLElement);
    expect(selectedTab(paneAt(v, 0)).getAttribute("data-definition-id")).toBe("d-alt");
    expect(observed(v)).toEqual({ trail: [{ entity: "A", view: "d-alt", selection: ["a-to-b"], pinned: false }, fresh("B")], retained: [] });
    expect(byId(paneAt(v, 0), "row", "a-to-b").getAttribute("aria-selected")).toBe("true");
    expect(paneAt(v, 0).getAttribute("data-snapshot-id")).toBe("snap-1");
  });
  // why: ... and drops one that does not exist there (negative control of the former).
  // proves: CLAIM(MC7)
  it("[MC7] switching to a view without the selected item clears the selection but keeps the entity", async () => {
    const v = await openNav();
    await click(v, byId(paneAt(v, 0), "row", "a-to-d"));
    await click(v, qa(paneAt(v, 0), "tab").find((t) => t.getAttribute("data-definition-id") === "d-alt") as HTMLElement);
    expect(observed(v).trail[0]).toEqual({ entity: "A", view: "d-alt", selection: [], pinned: false });
    expect(qa(paneAt(v, 0), "row").map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "false"]);
  });
});

describe("[MC7] viewport", () => {
  // why: design 3 "A narrow viewport shows one pane and a breadcrumb trail; history retains the others".
  // proves: CLAIM(MC7)
  it("[MC7] at width 480 only the active pane is visible while the trail shows one crumb per pane; at 1024 all trail panes are visible", async () => {
    const narrow = await openNav("d-children", { viewport: { width: 480, height: 800 } });
    await click(narrow, byId(paneAt(narrow, 0), "row", "a-to-b"));
    await click(narrow, byId(paneAt(narrow, 1), "row", "b-to-c"));
    expect(visiblePanes(narrow).map((p) => p.getAttribute("data-entity-id"))).toEqual(["C"]);
    expect(crumbs(narrow).map((c) => text(c))).toEqual(["Node A", "Node B", "Node C"]);
    expect(trailIds(narrow)).toEqual(["A", "B", "C"]);
    const wide = await openNav("d-children", { viewport: { width: 1024, height: 768 } });
    await click(wide, byId(paneAt(wide, 0), "row", "a-to-b"));
    await click(wide, byId(paneAt(wide, 1), "row", "b-to-c"));
    expect(visiblePanes(wide).map((p) => p.getAttribute("data-entity-id"))).toEqual(["A", "B", "C"]);
  });
  // why: in narrow mode the trail is the only way back to earlier panes (dom.md A4).
  // proves: CLAIM(MC7)
  it("[MC7] narrow: clicking the first crumb shows pane A alone, moves aria-current to it and leaves the inspector state untouched", async () => {
    const v = await openNav("d-children", { viewport: { width: 480, height: 800 } });
    await click(v, byId(paneAt(v, 0), "row", "a-to-b"));
    const state = observed(v);
    await click(v, crumbs(v)[0]!);
    expect(visiblePanes(v).map((p) => p.getAttribute("data-entity-id"))).toEqual(["A"]);
    expect(crumbs(v).map((c) => c.getAttribute("aria-current"))).toEqual(["page", null]);
    expect(observed(v)).toEqual(state);
  });
});

describe("[MC7] Needs evidence", () => {
  // why: design 3 "The inspector lists unavailable registered views in a collapsed 'Needs evidence' section" with the missing roles.
  // proves: CLAIM(MC7) / CLAIM(MC12)
  it("[MC7] entity B lacks four roles: each unavailable view is listed with its title and the missing role, collapsed, and is not a tab", async () => {
    const v = await openBundle(tmp("nav"), goldenBundle("nav"), node("B"), "d-children", { decorate: fixedFresh });
    const section = need(v.container, "needs-evidence");
    expect((section as HTMLDetailsElement).open).toBe(false);
    const entries = qa(section, "unavailable-view").map((e) => text(e));
    // definitions of nav/node by priority: alt 15 (role alt), tree 20 (tree), graph 25 (graph), code 30 (code), needs 40 (telemetry)
    expect(entries).toHaveLength(5);
    const expected: Array<[string, string]> = [["Children alt", "alt"], ["Structure", "tree"], ["Links", "graph"], ["Code", "code"], ["Telemetry", "telemetry"]];
    expected.forEach(([title, role], i) => { expect(entries[i], `entry ${i}`).toContain(title); expect(entries[i], `entry ${i}`).toContain(role); });
    expect(qa(v.container, "tab").map((t) => t.getAttribute("data-definition-id"))).toEqual(["d-children", "builtin:metadata", "builtin:raw"]);
  });
  // why: design 7 MC12 "Register a second list view ... show it without a browser rebuild"; the unavailable one names its missing role.
  // proves: CLAIM(MC7) / CLAIM(MC12)
  it("[MC7] registering a definition that requires a role the entity lacks adds exactly one entry naming that role, without remounting", async () => {
    const v = await openNav();
    const before = qa(need(v.container, "needs-evidence"), "unavailable-view").map((e) => text(e));
    expect(before).toHaveLength(1); // d-needs (telemetry)
    const { revision } = await v.session.listDefinitions();
    must(await v.session.registerView({ id: "d-extra", entityKind: "nav/node", title: "Extra view", component: "list", requires: ["extra-role"], dataRole: "children" }, revision), "registerView");
    await openEntity(v, node("A"), "d-children");
    const after = qa(need(v.container, "needs-evidence"), "unavailable-view").map((e) => text(e));
    expect(after).toHaveLength(2);
    const added = after.find((t) => t.includes("Extra view"));
    expect(added).toContain("extra-role");
    expect(qa(v.container, "tab").map((t) => t.getAttribute("data-definition-id"))).not.toContain("d-extra");
  });
  // why: when every registered view is available there is no Needs evidence section to mislead (negative control).
  // proves: CLAIM(MC7)
  it("[MC7] an entity whose registered views are all available has no needs-evidence element", async () => {
    const v = await openBundle(tmp("list"), goldenBundle("list"), SUBJECT, "d-list", { decorate: fixedFresh });
    expect(q(v.container, "needs-evidence")).toBeNull();
  });
});

describe("[MC8] cross-view links", () => {
  // why: design 7 MC8 "Follow a graph edge to source" - the stored excerpt opens with the anchored lines highlighted, in place.
  // proves: CLAIM(MC8)
  it("[MC8] a graph edge's open-source menu item shows the stored excerpt with exactly the anchored lines 11-12 highlighted and creates no pane", async () => {
    const v = await openNav("d-graph");
    expect(q(paneAt(v, 0), "source"), "no source before following the edge").toBeNull();
    await click(v, need(byId(paneAt(v, 0), "graph-edge-item", "ge1"), "actions-button"));
    const item = qa(need(v.container, "actions-menu"), "menu-item").find((i) => i.getAttribute("data-kind") === "open-source");
    await click(v, item as HTMLElement);
    const source = need(paneAt(v, 0), "source");
    expect(qa(source, "source-line").map((l) => [l.getAttribute("data-line"), l.getAttribute("data-highlighted"), ownText(l)])).toEqual([
      ["10", "false", "export function check(user: User) {"],
      ["11", "true", "if (!allowed(user)) return denied;"],
      ["12", "true", "audit(user);"],
    ]);
    expect(text(need(source, "source-origin"))).toBe("r no revision src/check.ts");
    expect(panes(v)).toHaveLength(1);
  });
  // why: design 3 "Missing references return an unresolved-target explanation" - named, and no pane is invented.
  // proves: CLAIM(MC8)
  it("[MC8] a notebook claim's evidence-link whose view is missing explains the unresolved target (naming it) and creates no pane", async () => {
    const v = await openBundle(tmp("nb"), goldenBundle("notebook"), SUBJECT, "d-notebook", { decorate: (s) => withMissingView(fixedFresh(s), "v-list") });
    const block = () => byId(v.container, "block", "b-c2");
    await click(v, need(block(), "toggle"));
    const link = qa(block(), "evidence-link").find((l) => l.getAttribute("data-view-id") === "v-list");
    expect([link?.getAttribute("data-id"), link?.getAttribute("data-kind"), text(link)]).toEqual(["r2", "contradicts", "v-list#r2"]);
    expect(block().querySelector('[data-pw="no-target"], [data-pw="error"]'), "negative control: nothing unresolved before following").toBeNull();
    const before = panes(v).length;
    await click(v, link as HTMLElement);
    const explanation = block().querySelector('[data-pw="no-target"], [data-pw="error"]');
    expect(explanation, "an unresolved explanation appears in the claim block").not.toBeNull();
    expect(text(explanation)).toContain("v-list");
    expect(panes(v)).toHaveLength(before);
    expect(v.handle.state().trail).toHaveLength(1);
  });
  // why: a resolvable link opens the linked view's entity with that view selected (LinkResolution: entity + viewDefinitionId + item);
  //      a plain source-id link is not navigation. Positive control for the former test.
  // proves: CLAIM(MC8)
  it("[MC8] the evidence-link v-list#r2 opens the subject's Modules view with row r2 selected; the source-id link s1 opens nothing", async () => {
    const v = await openBundle(tmp("nb"), goldenBundle("notebook"), SUBJECT, "d-notebook", { decorate: fixedFresh });
    await click(v, need(byId(v.container, "block", "b-c2"), "toggle"));
    const links = qa(byId(v.container, "block", "b-c2"), "evidence-link");
    expect(links.map((l) => [l.getAttribute("data-kind"), l.getAttribute("data-source") ?? l.getAttribute("data-view-id")])).toEqual([
      [null, "s1"], ["supports", "s1"], ["contradicts", "v-list"],
    ]);
    await click(v, links[1]!);
    expect(v.handle.state().trail.map((p) => p.viewDefinitionId), "a source-id link does not navigate").toEqual(["d-notebook"]);
    // since review S9 a source-id link shows its source detail, which re-renders the pane: the next link is looked up again (the old node is detached)
    const afterDetail = qa(byId(v.container, "block", "b-c2"), "evidence-link");
    expect(afterDetail[2]?.getAttribute("data-view-id")).toBe("v-list");
    await click(v, afterDetail[2]!);
    expect(v.handle.state().trail.map((p) => [p.entity.id, p.snapshotId, p.viewDefinitionId, p.selection])).toEqual([["subject", "snap-1", "d-list", ["r2"]]]);
    expect(byId(paneAt(v, 0), "row", "r2").getAttribute("aria-selected")).toBe("true");
  });
  // why: design 7 MC8 "an old link must not silently open the newest snapshot" and design 3 "Navigation never silently mixes snapshots".
  // proves: CLAIM(MC8)
  it("[MC8] opening A at snap-1 while snap-2 exists shows the old content, and following a row stays in snap-1", async () => {
    const snap2 = retagSnapshot(goldenBundle("nav"), "snap-2");
    snap2.views.find((x: any) => x.id === "A-children").data.rows[0].cells.name = "1 to B (new)";
    const v = await mountBundle(tmp("nav"), goldenBundle("nav"), { decorate: fixedFresh, more: [snap2] });
    await openEntity(v, node("A"), "d-children", "snap-1");
    expect(paneAt(v, 0).getAttribute("data-snapshot-id")).toBe("snap-1");
    expect(text(qa(byId(paneAt(v, 0), "row", "a-to-b"), "cell")[0])).toBe("1 to B");
    await click(v, byId(paneAt(v, 0), "row", "a-to-b"));
    expect(panes(v).map((p) => [p.getAttribute("data-entity-id"), p.getAttribute("data-snapshot-id")])).toEqual([["A", "snap-1"], ["B", "snap-1"]]);
    expect(v.handle.state().trail.map((p) => p.snapshotId)).toEqual(["snap-1", "snap-1"]);
    const v2 = await mountBundle(tmp("nav2"), goldenBundle("nav"), { decorate: fixedFresh, more: [snap2] });
    await openEntity(v2, node("A"), "d-children", "snap-2");
    expect(paneAt(v2, 0).getAttribute("data-snapshot-id")).toBe("snap-2");
    expect(text(qa(byId(paneAt(v2, 0), "row", "a-to-b"), "cell")[0])).toBe("1 to B (new)");
  });
});
