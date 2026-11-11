// T1 (tier-2 review S1): a bundle may repeat an identical view (validate.ts accepts it: same identity, same content).
// The store must hold ONE manifest row per (viewId, snapshotId) and ONE page entry per notebook, however often the bundle repeats it.
// Every expected value is a literal; the fixture bundle (fixtures/components/all.bundle.json) has 7 views, one of them the notebook "cancellation-notebook".
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import type { Bundle } from "./wire.ts";
import { must } from "../../test/helpers/must.ts";
import { bundleFixture, openOk, SORTED_VIEW_IDS } from "../../test/helpers/store-session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
const fresh = () => join(tmp("dup"), "s");

/** The fixture bundle with the view `id` listed twice in a row (identical content). */
function withRepeated(id: string): Bundle {
  const bundle = bundleFixture();
  const index = bundle.views.findIndex((view) => view.id === id);
  if (index < 0) throw new Error(`fixture view ${id} not found`);
  const views = [...bundle.views];
  views.splice(index, 0, structuredClone(views[index]!));
  return { ...bundle, views };
}
const ALL_KEYS = SORTED_VIEW_IDS.map((viewId) => ({ viewId, snapshotId: "snap-1" }));

describe("Session: a bundle that repeats an identical view", () => {
  // why: validate.ts accepts a repeated identical view; the manifest must not grow a second row for it, or listViews, export and the viewer index show it twice.
  // proves: CLAIM(snapshot-immutable) (one stored (viewId, snapshotId) -> one row)
  it("[T1] importing [v, v] stores one row: listViews and exportBundle list the view once, the summary names it once", async () => {
    const session = await openOk(fresh());
    const summary = must(await session.importBundle(withRepeated("modules")));
    expect(summary.views).toEqual(ALL_KEYS);
    expect(await session.listViews()).toEqual(ALL_KEYS);
    expect((await session.exportBundle()).views.map((view) => view.id)).toEqual([...SORTED_VIEW_IDS]);
    expect(Object.keys(summary.contentHashes).sort()).toEqual(SORTED_VIEW_IDS.map((id) => `${id}@snap-1`));
  });

  // why: for a notebook the duplicate would also add a second PageEntry; revision counting and update would then act on the wrong row.
  //   After get/update/get the page is at revision 2 and the view list still has seven keys.
  // proves: CLAIM(notebook-snapshot-identity)
  it("[T1] importing [notebook, notebook]: get is revision 1, update to revision 2 succeeds, list stays one row per view", async () => {
    const session = await openOk(fresh());
    must(await session.importBundle(withRepeated("cancellation-notebook")));
    const first = must(await session.notebookGet("cancellation-notebook"));
    expect(first.revision).toBe(1);
    const blocks = (first.envelope.data as { blocks: Array<Record<string, unknown>> }).blocks;
    const updated = must(await session.notebookUpdate("cancellation-notebook", 1, { blocks }));
    expect(updated.revision).toBe(2);
    expect(must(await session.notebookGet("cancellation-notebook")).revision).toBe(2);
    expect(must(await session.notebookGet("cancellation-notebook", 1)).revision).toBe(1);
    expect(await session.listViews()).toEqual(ALL_KEYS);
    expect((await session.exportBundle()).views.filter((view) => view.id === "cancellation-notebook")).toHaveLength(1);
  });
});
