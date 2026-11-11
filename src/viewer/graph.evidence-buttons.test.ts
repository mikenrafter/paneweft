// @vitest-environment jsdom
// Review round 2, S9: the evidence text inside the graph SVG (`<text data-pw="evidence-link" data-source>`) answered to the mouse only: it had no role,
// no tabindex and no accessible name, so a keyboard user landed on the enclosing graph node (role="button"), whose activation opens the node's entity -
// not the evidence. Required: each SVG evidence control is a focusable button (role="button", tabindex="0", a name that says which source and for what)
// that is NOT inside the node's button (nested interactive controls are an axe violation), activates with click, Enter and Space, shows the source
// detail, leaves the node action alone, and gets focus back after the re-render. Graph goldens change accordingly (test/goldens/graph.outline.txt).
// World: the graph golden bundle (fixtures/goldens/graph.bundle.json): nodes a, b, c cite s1 (so three controls share one source id), d cites s2, e cites s1 and tc.
// proves: CLAIM(MC10) CLAIM(evidence-navigation)
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { SUBJECT, accessibleName, byId, click, fixedFresh, focusEl, goldenBundle, need, openBundle, paneAt, paneEntityIds, press, qa, text, useViewerCleanup, type MountedViewer } from "../../test/helpers/dom-harness.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
useViewerCleanup();

const openGraph = (): Promise<MountedViewer> => openBundle(tmp("graph"), goldenBundle("graph"), SUBJECT, "d-graph", { decorate: fixedFresh });
/** The SVG evidence controls of the item labelled `label` (nodes: their label; the name format is `Evidence <source> of <label>`), in declared order. */
function evidenceOf(v: MountedViewer, label: string): HTMLElement[] {
  const found = svgEvidence(v).filter((link) => accessibleName(link) === `Evidence ${sourceOf(link)} of ${label}`);
  expect(found, `an SVG evidence control named "Evidence <source> of ${label}"`).not.toHaveLength(0);
  return found;
}
const svgEvidence = (v: MountedViewer): HTMLElement[] => qa(paneAt(v, 0), "evidence-link").filter((link) => link.namespaceURI === "http://www.w3.org/2000/svg");
const sourceOf = (link: HTMLElement): string | null => link.getAttribute("data-source");
const AXE = { runOnly: { type: "tag" as const, values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, rules: { "color-contrast": { enabled: false } } };

describe("[S9/r2] SVG evidence controls are buttons", () => {
  // why: a control a keyboard user cannot focus, or that has no role and name, does not exist for them.
  it("every evidence control in the graph SVG has role=button, tabindex=0 and a name that carries the source and the item it belongs to", async () => {
    const v = await openGraph();
    const controls = svgEvidence(v);
    expect(controls, "nodes a:s1 b:s1 c:s1 d:s2 e:s1,tc (6) plus the edges' s1 s1 s1 s2 s1,tc s1 (7)").toHaveLength(13);
    for (const control of controls) {
      expect(control.getAttribute("role"), sourceOf(control) as string).toBe("button");
      expect(control.getAttribute("tabindex")).toBe("0");
      expect(accessibleName(control)).toContain(sourceOf(control) as string);
    }
    expect(evidenceOf(v, "Engine").map(sourceOf), "the name tells the three s1 controls apart by node").toEqual(["s1"]);
    expect(evidenceOf(v, "MCP").map(sourceOf)).toEqual(["s1"]);
    expect(evidenceOf(v, "Log").map(sourceOf), "declared order").toEqual(["s1", "tc"]);
    expect(evidenceOf(v, "e5").map(sourceOf), "an edge's controls are named after the edge").toEqual(["s1", "tc"]);
  });

  // why: nested interactive controls (a button inside role=button) are not reliably reachable by assistive technology, and the node's own action would swallow them.
  it("no evidence control is inside a graph node, and a graph node holds no focusable descendant", async () => {
    const v = await openGraph();
    for (const node of qa(paneAt(v, 0), "graph-node")) {
      expect(node.querySelector('[data-pw="evidence-link"]'), `node ${node.getAttribute("data-id")}`).toBeNull();
      expect(node.querySelector("[tabindex]"), `node ${node.getAttribute("data-id")} children are presentational`).toBeNull();
    }
  });

  // why: a click, Enter and Space must all do the same thing, and it must be the evidence action: the source detail opens, no entity pane appears.
  it.each([["click", ""], ["Enter", "Enter"], ["Space", " "]])("%s on the evidence control of node b opens the detail of its source and leaves the node action alone", async (_name, key) => {
    const v = await openGraph();
    const link = evidenceOf(v, "Engine")[0] as HTMLElement;
    expect(text(link)).toBe("s1");
    if (key === "") await click(v, link);
    else { focusEl(link, "evidence control of node b"); await press(v, key); }
    const detail = need(paneAt(v, 0), "source-detail");
    expect(detail.getAttribute("data-source")).toBe("s1");
    expect(paneEntityIds(v), "the node's entity was not opened").toEqual(["subject"]);
    expect(v.handle.state().trail.map((pane) => pane.entity.id)).toEqual(["subject"]);
  });

  // control: Enter on the graph node itself still opens its entity, so the assertions above are about the evidence control and not a dead graph.
  it("control: Enter on the node itself opens the node's entity", async () => {
    const v = await openGraph();
    focusEl(byId(paneAt(v, 0), "graph-node", "b"), "graph node b");
    await press(v, "Enter");
    expect(paneEntityIds(v)).toEqual(["subject", "mod-engine"]);
  });

  // why: three controls show the same source id; after the re-render focus has to return to the one the user activated, not to the first match.
  it("focus returns to the activated control after the detail opens, even though other controls name the same source", async () => {
    const v = await openGraph();
    const link = evidenceOf(v, "Tick")[0] as HTMLElement;
    const { x, y } = { x: link.getAttribute("x"), y: link.getAttribute("y") };
    focusEl(link, "evidence control of node c");
    await press(v, "Enter");
    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute("data-pw")).toBe("evidence-link");
    expect([focused.getAttribute("x"), focused.getAttribute("y")], "the control of node c, not that of node a").toEqual([x, y]);
    expect(focused.getAttribute("aria-expanded"), "and it says it is open").toBe("true");
  });

  // why: the point of the restructuring is that assistive technology accepts it; this is the same axe run as the rest of MC10, on the opened state.
  it("axe finds no WCAG A/AA violation in the graph, before and after an evidence detail is opened", async () => {
    const v = await openGraph();
    const violations = async () => (await axe.run(v.container, AXE)).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
    expect(await violations()).toEqual([]);
    await click(v, evidenceOf(v, "Log")[1] as HTMLElement);
    expect(need(paneAt(v, 0), "source-detail").getAttribute("data-source")).toBe("tc");
    expect(await violations()).toEqual([]);
  });
});
