// Review S6: references into other views were validated against item ids POOLED across every snapshot, standalone notebooks
// (putView, notebook_create, notebook_update) skipped target validation altogether, and a run's result entity was matched in any snapshot.
// A reference addresses ONE snapshot: the one the notebook's `links` name for that view (the rule navigation and embeds use, referencedSnapshot),
// else the notebook's own snapshot. These tests go through the real Session methods.
// World: view "shared" exists in snap-1 (only item x1) and in snap-2 (only item x2); "only-1" (list) and "ex-1" (example) exist in snap-1 only.
// Expectation derivation: a notebook in snap-2 without links addresses snap-2, so x1 and "only-1" are dangling there and x2 is not;
// with a link {snapshotId: snap-1, viewId: shared} the same notebook addresses snap-1, so x1 resolves and x2 does not.
// proves: CLAIM(exact-snapshot-references)
import { describe, expect, it } from "vitest";
import type { Session } from "./session.ts";
import { must } from "../../test/helpers/must.ts";
import { bundleOf, claimBlock, complete, exampleBlock, exampleView, listView, moduleRef, notebookView, proseBlock, row, viewBlock } from "../../test/helpers/ops-views.ts";
import { EXAMPLE_KEY, passOutput } from "../../test/helpers/store-runner.ts";
import { importAll, openOk } from "../../test/helpers/store-session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
type Json = any;
const danglingAt = (result: { ok: boolean; error?: { code: string; errors: Array<{ code: string; pointer: string }> } }): string[] =>
  (result.error?.errors ?? []).filter((issue) => issue.code === "DANGLING_REFERENCE").map((issue) => issue.pointer);

const shared = (snapshotId: string, itemId: string): Json =>
  listView({ id: "shared", snapshotId, definitionId: "def-shared", title: "Shared", completeness: complete("fixture"), rows: [row(itemId, { name: itemId }, { entity: moduleRef(itemId) })] });
const only1 = (): Json => listView({ id: "only-1", snapshotId: "snap-1", definitionId: "def-only", title: "Only in snap-1", completeness: complete("fixture"), rows: [row("o1", { name: "o1" })] });
const example1 = (): Json => exampleView({ id: "ex-1", snapshotId: "snap-1", definitionId: "def-example-x", title: "Example in snap-1", completeness: complete("fixture") });
const withLink = (notebook: Json, snapshotId: string, viewId: string): Json => ({ ...notebook, links: [{ id: `link-${viewId}`, relation: "cites", snapshotId, viewId }] });
const story = (blocks: Json[], id = "story", links?: { snapshotId: string; viewId: string }): Json => {
  const notebook = notebookView({ id, snapshotId: "snap-2", definitionId: "def-story-x", title: "Story", completeness: complete("fixture"), blocks });
  return links === undefined ? notebook : withLink(notebook, links.snapshotId, links.viewId);
};
const supporting = (itemId: string): Json[] => [claimBlock("c1", "a claim", "supported", { supports: [{ viewId: "shared", itemId }] })];

/** The referenced views stored (snap-1 and snap-2), plus a valid prose-only notebook in snap-2 that registers the notebook entity and definition. */
async function world(): Promise<Session> {
  const session = await openOk(tmp("exact-snapshot"));
  must(await session.importBundle(bundleOf([shared("snap-1", "x1"), shared("snap-2", "x2"), only1(), example1(), story([proseBlock("p", "seed")], "seed")])));
  return session;
}
const bundleWith = (notebook: Json): Json => bundleOf([shared("snap-1", "x1"), shared("snap-2", "x2"), only1(), example1(), notebook]);

describe("[S6] bundle notebook references are checked in the addressed snapshot", () => {
  it("an evidence target item that exists only in another snapshot is DANGLING_REFERENCE; the item of its own snapshot is accepted", async () => {
    const session = await openOk(tmp("exact-bundle"));
    const dangling = await session.importBundle(bundleWith(story(supporting("x1"))));
    expect(dangling.ok, "x1 exists in snap-1 only; the notebook addresses snap-2").toBe(false);
    expect(danglingAt(dangling as never)).toEqual(["/views/4/data/blocks/0/supports/0"]);
    expect((await session.listViews()), "a rejected bundle stores nothing").toEqual([]);
    must(await session.importBundle(bundleWith(story(supporting("x2")))));
  });

  it("a link to snap-1 makes the same notebook address snap-1: x1 resolves, x2 (snap-2 only) is dangling", async () => {
    const session = await openOk(tmp("exact-link"));
    must(await session.importBundle(bundleWith(story(supporting("x1"), "story-a", { snapshotId: "snap-1", viewId: "shared" }))));
    const dangling = await session.importBundle(bundleWith(story(supporting("x2"), "story-b", { snapshotId: "snap-1", viewId: "shared" })));
    expect(dangling.ok, "x2 exists in snap-2 only; the link sends the notebook to snap-1").toBe(false);
    expect(danglingAt(dangling as never)).toEqual(["/views/4/data/blocks/0/supports/0"]);
  });

  it("a view block and an example block are resolved in the addressed snapshot too", async () => {
    const session = await openOk(tmp("exact-blocks"));
    const viewRef = await session.importBundle(bundleWith(story([viewBlock("vb", "only-1")])));
    expect(danglingAt(viewRef as never), "view only-1 exists in snap-1 only").toEqual(["/views/4/data/blocks/0/viewId"]);
    const exampleRef = await session.importBundle(bundleWith(story([exampleBlock("eb", "ex-1")])));
    expect(danglingAt(exampleRef as never), "example ex-1 exists in snap-1 only").toEqual(["/views/4/data/blocks/0/exampleId"]);
    must(await session.importBundle(bundleWith(withLink(withLink(story([viewBlock("vb", "only-1"), exampleBlock("eb", "ex-1")]), "snap-1", "only-1"), "snap-1", "ex-1"))));
  });
});

describe("[S6] a standalone notebook is validated against its targets on every storage path", () => {
  it("putView and notebookCreate refuse a notebook whose target view does not exist, and store nothing", async () => {
    const session = await world();
    const before = (await session.listViews()).length;
    const missing = story([viewBlock("vb", "no-such-view")], "lone");
    const put = await session.putView(missing);
    expect(danglingAt(put as never)).toEqual(["/data/blocks/0/viewId"]);
    const created = await session.notebookCreate(missing);
    expect(danglingAt(created as never)).toEqual(["/data/blocks/0/viewId"]);
    expect((await session.listViews()).length).toBe(before);
  });

  it("putView and notebookCreate judge a target item in the notebook's own snapshot, not in any snapshot", async () => {
    const session = await world();
    expect(danglingAt(await session.putView(story(supporting("x1"), "lone-a")) as never), "x1 is in snap-1 only").toEqual(["/data/blocks/0/supports/0"]);
    expect(danglingAt(await session.notebookCreate(story(supporting("x1"), "lone-b")) as never)).toEqual(["/data/blocks/0/supports/0"]);
    must(await session.putView(story(supporting("x2"), "lone-c")));
    must(await session.notebookCreate(story(supporting("x1"), "lone-d", { snapshotId: "snap-1", viewId: "shared" })));
  });

  it("notebookUpdate refuses blocks with a dangling target; the page stays at its revision", async () => {
    const session = await world();
    must(await session.notebookCreate(story([proseBlock("p", "start")], "page")));
    const update = await session.notebookUpdate("page", 1, { blocks: supporting("x1") }, "snap-2");
    expect(danglingAt(update as never)).toEqual(["/data/blocks/0/supports/0"]);
    expect(must(await session.notebookGet("page", undefined, "snap-2")).revision).toBe(1);
    expect(must(await session.notebookUpdate("page", 1, { blocks: supporting("x2") }, "snap-2")).revision).toBe(2);
  });
});

describe("[S6] a recorded run's result entity is looked up in the snapshot the run is recorded on", () => {
  it("a result registered only in another snapshot (by the output's bundle, or already in the session) is DANGLING_REFERENCE", async () => {
    const session = await openOk(tmp("exact-run"));
    await importAll(session);
    const elsewhere = passOutput("elsewhere");
    elsewhere.bundle.entities[0].snapshotId = "snap-2";
    const bundled = await session.recordExampleRun(EXAMPLE_KEY, elsewhere);
    expect(bundled.ok, "the output registers its result in snap-2; the run belongs to snap-1").toBe(false);
    expect(danglingAt(bundled as never)).toEqual(["/run/result"]);

    const resident = passOutput("resident");
    must(await session.importBundle({ schemaVersion: "paneweft.bundle/1", definitions: [], views: [], entities: [{ ...resident.bundle.entities[0], snapshotId: "snap-2" }] }));
    resident.bundle.entities = [];
    const existing = await session.recordExampleRun(EXAMPLE_KEY, resident);
    expect(existing.ok, "the result exists in the session, but in snap-2").toBe(false);
    expect(danglingAt(existing as never)).toEqual(["/run/result"]);
  });

  // control: the result registered in the run's own snapshot is accepted.
  it("control: a result registered in the run's own snapshot is accepted", async () => {
    const session = await openOk(tmp("exact-run-ok"));
    await importAll(session);
    expect(must(await session.recordExampleRun(EXAMPLE_KEY, passOutput("ok"))).runId).toBe("ok");
  });
});
