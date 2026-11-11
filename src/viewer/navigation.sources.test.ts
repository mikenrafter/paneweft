// Review S9: evidence controls carrying `data-source` did nothing when activated, and notebook example blocks were plain text. The shipped bundle
// (dist/viewer in JSDOM, over a REAL viewer server and session) must (1) show the declared source behind an evidence control as `source-detail`
// and (2) open the example an example block names as the next pane, each by mouse and by keyboard (Enter and Space on the focused control).
// World: fixtures/components/all.bundle.json plus the demo notebook page `context-survival` (test/helpers/store-notebook.ts), whose claims D1/D2 cite sources
// sv ("src/mcp.rs", sha256 of "hello\n") and sr ("web/src/nkp-landscape.test.ts") and whose block ex1 names the scenario "once" of example view
// vigil-one-write (entity vigil/watch "watch"). Expected values are those fixture literals.
// New DOM pinned here (docs/viewer-dom-contract.md, review S9): `source-detail` (data-source; contains `source-field` data-name/value) and `example-link`.
// proves: CLAIM(evidence-navigation)
import { describe, expect, it } from "vitest";
import { must } from "../../test/helpers/must.ts";
import { demoNotebook, PAGE_ID } from "../../test/helpers/store-notebook.ts";
import { useViewerDom, type ViewerPage } from "../../test/helpers/viewer-dom.ts";
import { useViewers } from "../../test/helpers/wire-http.ts";

const viewers = useViewers();
const openPage = useViewerDom();

/** The demo page on its OWN entity and definition (the viewer opens the first view of an entity's definition, and the fixture notebook already owns notes/page "notes"). */
const storyBundle = () => ({
  schemaVersion: "paneweft.bundle/1",
  entities: [{ repository: "r", id: "s9-notes", kind: "notes/page", snapshotId: "snap-1", label: "s9-notes", dataRoles: ["role-story-s9"], relations: [] }],
  definitions: [{ id: "def-story-s9", entityKind: "notes/page", title: "Story S9", priority: 50, component: "notebook", requires: [], dataRole: "role-story-s9" }],
  views: [{ ...demoNotebook(), entity: { repository: "r", id: "s9-notes", kind: "notes/page" }, viewDefinitionId: "def-story-s9" }],
});

async function notebookPage(): Promise<ViewerPage> {
  const { session, server } = await viewers.start();
  must(await session.importBundle(storyBundle()));
  const page = openPage(server, PAGE_ID, "snap-1");
  await page.settled(() => expect(page.pw("block").length).toBe(8));
  return page;
}
const fieldsOf = (page: ViewerPage): Record<string, string> =>
  Object.fromEntries(page.pw("source-field").map((field) => [field.getAttribute("data-name") as string, field.getAttribute("data-value") ?? page.text(field)]));
const linkFor = (page: ViewerPage, blockId: string, source: string): HTMLElement => {
  const link = page.pw("block").find((block) => block.getAttribute("data-id") === blockId)?.querySelector<HTMLElement>(`[data-pw="evidence-link"][data-source="${source}"]`);
  if (link === undefined || link === null) throw new Error(`no evidence link ${source} in block ${blockId}`);
  return link;
};

describe("[S9] an evidence control with data-source shows the declared source", () => {
  it("clicking the source link of a fact opens its source-detail: id, kind, repository, path and recorded hash", async () => {
    const page = await notebookPage();
    expect(page.pw("source-detail"), "nothing is open before activation").toHaveLength(0);
    linkFor(page, "intro", "sd").click();
    await page.settled(() => expect(page.pw("source-detail")).toHaveLength(1));
    const detail = page.pw("source-detail")[0] as HTMLElement;
    expect(detail.getAttribute("data-source")).toBe("sd");
    expect(fieldsOf(page)).toMatchObject({ id: "sd", kind: "document", repository: "r", path: "docs/design.md", sha256: "87e3143fd01462f82d2d2c3aea39e7e35f52d88a09b99d750b465f837d01e68f" });
  });

  it.each(["Enter", " "])("keyboard: %j on a focused source link of a claim opens the detail of THAT source; the same key again closes it", async (key) => {
    const page = await notebookPage();
    page.key(page.pw("toggle").find((toggle) => toggle.getAttribute("data-item") === "D2") as HTMLElement, "Enter"); // expand claim D2 so its supports are listed
    await page.settled(() => expect(linkFor(page, "D2", "sr")).toBeTruthy());
    const link = linkFor(page, "D2", "sr");
    page.key(link, key);
    await page.settled(() => expect(page.pw("source-detail")).toHaveLength(1));
    expect(fieldsOf(page)).toMatchObject({ id: "sr", path: "web/src/nkp-landscape.test.ts", sha256: "d1f9db2be5dffa209793da697ea7c971f4ed07d90a1ab9a15c3ce57f0d5ecd8b" });
    expect(linkFor(page, "D2", "sr").getAttribute("aria-expanded"), "the control says it is open").toBe("true");
    page.key(linkFor(page, "D2", "sr"), key);
    await page.settled(() => expect(page.pw("source-detail")).toHaveLength(0));
  });

  it("a second source replaces the first (one detail at a time)", async () => {
    const page = await notebookPage();
    linkFor(page, "intro", "sd").click();
    await page.settled(() => expect(page.pw("source-detail")).toHaveLength(1));
    linkFor(page, "v1", "sv").click();
    await page.settled(() => expect(page.pw("source-detail").map((detail) => detail.getAttribute("data-source"))).toEqual(["sv"]));
  });
});

describe("[S9] a notebook example block opens the example it names", () => {
  it("the example block is an activatable control, not plain text", async () => {
    const page = await notebookPage();
    const block = page.pw("block").find((candidate) => candidate.getAttribute("data-id") === "ex1") as HTMLElement;
    const link = block.querySelector<HTMLElement>('[data-pw="example-link"]');
    expect(link, "ex1 offers an example-link").not.toBeNull();
    expect(link?.getAttribute("data-example-id")).toBe("once");
    expect(page.text(link)).toContain("once");
  });

  it.each([["click", ""], ["Enter", "Enter"], ["Space", " "]])("%s on the link opens the example's entity in a second pane, showing the scenario and its rerun instruction", async (_name, key) => {
    const page = await notebookPage();
    const link = page.pw("example-link")[0] as HTMLElement;
    if (key === "") link.click(); else page.key(link, key);
    await page.settled(() => expect(page.pw("pane").map((pane) => pane.getAttribute("data-entity-id"))).toEqual(["s9-notes", "watch"]));
    const opened = page.pw("pane")[1] as HTMLElement;
    expect(opened.getAttribute("data-snapshot-id")).toBe("snap-1");
    await page.settled(() => expect(opened.querySelector('[data-pw="example"]')).not.toBeNull());
    expect(page.text(opened.querySelector('[data-pw="scenario"]'))).toContain("vigil-one-write");
    expect(page.text(opened.querySelector('[data-pw="rerun-instruction"]'))).toBe("paneweft example run vigil-one-write");
  });

  // control: merely showing the page opens no second pane.
  it("control: showing the notebook opens exactly one pane", async () => {
    const { session, server } = await viewers.start();
    must(await session.importBundle(storyBundle()));
    const page = openPage(server, PAGE_ID, "snap-1");
    await page.settled(() => expect(page.pw("block").length).toBe(8));
    expect(page.pw("pane")).toHaveLength(1);
  });
});
