// @vitest-environment jsdom
// why: F17. The viewer never showed the view's question: `grep question src/viewer` found only the partial-gap text, so "Which events were retained, and were they redelivered?"
//   appeared nowhere in the pane (spec section 5: "Preserve keyboard access and the question in both presentations"). A list also rendered as one cell per line, with
//   nothing to line the columns up. The expected texts are the question and the column titles written in the golden bundle, not read back from the code under test.
// proves: CLAIM(F17-question) CLAIM(F17-grid)
import { describe, expect, it } from "vitest";
import { byId, fixedFresh, focusEl, goldenBundle, need, openBundle, paneAt, press, qa, text, SUBJECT, useViewerCleanup, q } from "../../test/helpers/dom-harness.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
useViewerCleanup();

describe("[F17] the pane shows the view's question", () => {
  // why: F17. The question is the view's reason to exist. It is shown above the status strip, as text (never markup), for every component.
  it("puts the question of the shown view above the status strip", async () => {
    const bundle = goldenBundle("list") as { views: Array<{ id: string; question: string; title: string }> };
    const view = bundle.views.find((candidate) => candidate.id === "d-list") ?? bundle.views[0]!;
    expect(view.question.length, "the fixture view has a question").toBeGreaterThan(0);
    const v = await openBundle(tmp("f17-question"), goldenBundle("list"), SUBJECT, "d-list", { decorate: fixedFresh });
    const pane = paneAt(v, 0);
    const question = need(pane, "question");
    expect(text(question)).toBe(view.question);
    expect(question.compareDocumentPosition(need(pane, "status-strip")) & 4, "the question precedes the status strip").toBe(4);
    expect(qa(pane, "question")).toHaveLength(1);
  });

  // why: F17. A question that is hostile text stays text: it is set with textContent, like every value.
  it("shows markup in a question as text", async () => {
    const hostile = structuredClone(goldenBundle("list")) as { views: Array<{ question: string }> };
    for (const view of hostile.views) view.question = "<img src=x onerror=alert(1)> Which modules?";
    const v = await openBundle(tmp("f17-hostile"), hostile, SUBJECT, "d-list", { decorate: fixedFresh });
    const question = need(paneAt(v, 0), "question");
    expect(text(question)).toBe("<img src=x onerror=alert(1)> Which modules?");
    expect(question.querySelector("img")).toBeNull();
  });
});

describe("[F17] a list is laid out as a grid with its column titles", () => {
  // why: F17. The shots showed one cell per line. A grid has one track per column plus one for the row's actions, the same template on the header row and on every
  //   row, so the cells of a column line up. The template is on the elements, so it is true whatever stylesheet the page has.
  it("gives the header and every row the same tracks: one per column plus the actions cell", async () => {
    const bundle = goldenBundle("list") as { views: Array<{ id: string; data: { columns: Array<{ key: string; title: string }> } }> };
    const columns = (bundle.views.find((view) => view.id === "d-list") ?? bundle.views[0]!).data.columns;
    const v = await openBundle(tmp("f17-grid"), goldenBundle("list"), SUBJECT, "d-list", { decorate: fixedFresh });
    const list = need(paneAt(v, 0), "list");
    const headers = qa(list, "column-header");
    expect(headers.map((header) => text(header)), "the column titles, in column order").toEqual(columns.map((column) => column.title));
    const rows = qa(list, "row");
    expect(rows.length).toBeGreaterThan(0);
    const template = (element: Element): string => /grid-template-columns:\s*([^;]+)/.exec(element.getAttribute("style") ?? "")?.[1]?.trim() ?? "";
    const header = headers[0]!.parentElement!;
    expect(template(header), "the header row has a template").not.toBe("");
    for (const row of rows) expect(template(row), `row ${row.getAttribute("data-id")}`).toBe(template(header));
    expect(header.getAttribute("style")).toMatch(/display:\s*grid/);
    expect(template(header).split(/\s+(?![^()]*\))/).length, "one track per column plus the actions cell").toBe(columns.length + 1);
    expect(qa(rows[0]!, "cell")).toHaveLength(columns.length);
  });

  // why: F17 asks to keep keyboard access: rows stay focusable with a roving tabindex, the arrow keys move between them and Enter opens (the existing keyboard suite
  //   covers the full set; this pins that the grid markup did not take the roles away).
  it("keeps the grid roles and the roving row focus", async () => {
    const v = await openBundle(tmp("f17-keys"), goldenBundle("list"), SUBJECT, "d-list", { decorate: fixedFresh });
    const list = need(paneAt(v, 0), "list");
    expect(list.getAttribute("role")).toBe("grid");
    const rows = qa(list, "row");
    expect(rows.filter((row) => row.getAttribute("tabindex") === "0")).toHaveLength(1);
    focusEl(rows[0]!);
    await press(v, "ArrowDown");
    expect(v.container.ownerDocument.activeElement).toBe(rows[1]);
    expect(q(list, "column-header")?.getAttribute("role")).toBe("columnheader");
    void byId;
  });
});
