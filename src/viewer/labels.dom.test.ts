// @vitest-environment jsdom
// why: dogfooding notes #9 and #12. The shape pane showed a field's type, example and evidence but neither its `path` nor its `label`, so three strings
//   in a row could not be told apart (the path was only a data attribute); the graph drew an edge's `relation` and nothing of its `label`, which is where
//   the real call chain or message payload lives. Both must be visible in the viewer. A long edge label is cut in the drawing with a marker (the drawing
//   has no room) and stays whole in the edge list, which is the text form; items without a label render exactly as before (the goldens).
// proves: CLAIM(MC9) viewer shows what the reply carries.
import { describe, expect, it } from "vitest";
import { SUBJECT, fixedFresh, goldenBundle, openBundle, paneAt, qa, text, useViewerCleanup } from "../../test/helpers/dom-harness.ts";
import { patch } from "../../test/helpers/patch.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
useViewerCleanup();

/** What the note prints: its direct text nodes (its <title> child holds the whole label for hover and assistive technology). */
const printed = (note: Element): string => Array.from(note.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("");
const LONG = "Hotswap first; standard claim: tabs.get -> activateStandard -> StandardHandler.activate -> parseBookmarkUrl";

describe("[#9] shape fields show their path and label", () => {
  const open = (labels: boolean) => openBundle(tmp("shape"), labels
    ? patch(goldenBundle("shape"), { op: "add", path: "/views/0/data/fields/1/label", value: "Watch identifier" })
    : goldenBundle("shape"), SUBJECT, "d-shape", { decorate: fixedFresh });

  // why: the finding. Every visible field names its path as text, in the field row, not only as a data attribute.
  it("[#9] each field row has a field-path part with the field's path", async () => {
    const v = await open(false);
    const fields = qa(paneAt(v, 0), "field");
    expect(fields.length).toBeGreaterThan(1);
    for (const field of fields) {
      const part = field.querySelector('[data-pw="field-path"]');
      expect(part, `field ${field.getAttribute("data-id")}`).not.toBeNull();
      expect(text(part)).toBe(field.getAttribute("data-path"));
    }
  });

  // why: the label is the field's human name; shown when the field has one.
  it("[#9] a field with a label shows it in a field-label part; a field without one has none", async () => {
    const v = await open(true);
    const byId = (id: string) => qa(paneAt(v, 0), "field").find((field) => field.getAttribute("data-id") === id) as HTMLElement;
    expect(text(byId("f-id").querySelector('[data-pw="field-label"]'))).toBe("Watch identifier");
    expect(byId("f-msg").querySelector('[data-pw="field-label"]')).toBeNull();
  });
});

describe("[#12] graph edges show their label", () => {
  const open = (label?: string) => openBundle(tmp("graph"), label === undefined ? goldenBundle("graph") : patch(goldenBundle("graph"), { op: "add", path: "/views/0/data/edges/0/label", value: label }), SUBJECT, "d-graph", { decorate: fixedFresh });
  const edge = (v: Awaited<ReturnType<typeof open>>, id: string) => qa(paneAt(v, 0), "graph-edge").find((candidate) => candidate.getAttribute("data-id") === id) as HTMLElement;

  // why: the finding. A short label is drawn whole next to the relation.
  it("[#12] a short label is drawn in an edge-note part, whole", async () => {
    const v = await open("startup path");
    expect(printed(edge(v, "e1").querySelector('[data-pw="edge-note"]') as Element)).toBe("startup path");
  });

  // why: a long label does not fit in the drawing: it is cut at 28 characters with the marker …, and the whole label is still reachable from the
  //   drawing as the note's <title> (hover / assistive technology).
  it("[#12] a long label is cut in the drawing with … and kept whole in the note's title", async () => {
    const v = await open(LONG);
    const note = edge(v, "e1").querySelector('[data-pw="edge-note"]') as Element;
    expect(printed(note)).toBe(`${LONG.slice(0, 27)}…`);
    expect(note.querySelector("title")?.textContent).toBe(LONG);
  });

  // why: the edge list is the non-graphic form; it carries the whole label however long.
  it("[#12] the edge list item carries the whole label", async () => {
    const v = await open(LONG);
    const item = qa(paneAt(v, 0), "graph-edge-item").find((candidate) => candidate.getAttribute("data-id") === "e1") as HTMLElement;
    expect(text(item.querySelector('[data-pw="edge-list-label"]'))).toBe(LONG);
  });

  // why: control. An edge with no label draws and lists nothing extra.
  it("[#12] an edge without a label has no note and no list label", async () => {
    const v = await open();
    expect(edge(v, "e1").querySelector('[data-pw="edge-note"]')).toBeNull();
    expect(qa(paneAt(v, 0), "edge-list-label")).toHaveLength(0);
  });
});
