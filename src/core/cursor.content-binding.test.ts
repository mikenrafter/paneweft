// Review S10: inspection, open-entity and search cursors bound only the QUERY (tool, view, snapshot, filter, order), not the content they page over.
// A notebook page keeps its (view id, snapshot) across revisions and a search covers whatever the session holds, so a cursor issued before a change
// continued into the changed listing and silently skipped or repeated rows. The cursor now carries a digest of the listing's own entries; a listing
// that changed since the cursor was issued is CURSOR_STALE (one issue at /cursor), never a silently shifted page. Unchanged content keeps working.
// World: notebook "long" with 60 prose blocks (each ~60 bytes, so 2048 bytes holds a page of ~25 and the chain has a next page); search over 60 entities.
// proves: CLAIM(cursor-content-bound)
import { describe, expect, it } from "vitest";
import { cursorOf, failure, useOps, type OpsEnv } from "../../test/helpers/ops-env.ts";
import { bundleOf, complete, entityAt, listView, notebookView, proseBlock, row } from "../../test/helpers/ops-views.ts";
import { must } from "../../test/helpers/must.ts";

const open = useOps();
const KEY = { viewId: "long", snapshotId: "snap-1" };
const NOTES = { repository: "r", id: "notes", kind: "notes/page" };
const blocks = (label: string) => Array.from({ length: 60 }, (_, index) => proseBlock(`b${String(index).padStart(2, "0")}`, `${label} block number ${index} with some text to fill the line`));
const longBundle = () => bundleOf([notebookView({ id: "long", snapshotId: "snap-1", definitionId: "def-long", title: "Long", completeness: complete("fixture"), blocks: blocks("first") })]);

async function firstPage(env: OpsEnv, tool: "inspect_view" | "open_entity") {
  const args = tool === "inspect_view" ? { ...KEY, maxBytes: 2048 } : { entity: NOTES, snapshotId: "snap-1", maxBytes: 2048 };
  const page = await env.call(tool, args);
  const cursor = cursorOf(page);
  expect(cursor, "the first page must have a next page, or the test proves nothing").not.toBeNull();
  return { args, cursor: cursor as string };
}
/** Edits the page in place: same view id, same snapshot, new revision. */
async function edit(env: OpsEnv) {
  must(await env.session.notebookUpdate("long", 1, { blocks: blocks("second") }, "snap-1"));
}

describe("[S10] a cursor over stored content is bound to that content", () => {
  it.each(["inspect_view", "open_entity"] as const)("%s: a cursor issued before the notebook was edited is CURSOR_STALE at /cursor", async (tool) => {
    const env = await open(longBundle());
    const { args, cursor } = await firstPage(env, tool);
    await edit(env);
    const error = failure(await env.call(tool, { ...args, cursor }));
    expect(error.code).toBe("CURSOR_STALE");
    expect(error.errors.map((issue) => issue.pointer)).toEqual(["/cursor"]);
    expect(error.message).toContain("changed");
  });

  it.each(["inspect_view", "open_entity"] as const)("%s: control: with no change the same cursor continues the chain", async (tool) => {
    const env = await open(longBundle());
    const { args, cursor } = await firstPage(env, tool);
    const next = await env.call(tool, { ...args, cursor });
    expect(next.ok, next.body).toBe(true);
  });

  it("a fresh request after the edit starts over and its own cursor works", async () => {
    const env = await open(longBundle());
    await edit(env);
    const { args, cursor } = await firstPage(env, "inspect_view");
    expect((await env.call("inspect_view", { ...args, cursor })).ok).toBe(true);
  });
});

describe("[S10] a search cursor is bound to the result set it paged", () => {
  const entities = (snapshotId: string, prefix: string, count: number) => Array.from({ length: count }, (_, index) => entityAt({ repository: "r", id: `${prefix}-${index}`, kind: "code/module" }, snapshotId, { label: `${prefix} entity ${index} label text` }));
  const searchBundle = () => bundleOf([listView({ id: "anchor", snapshotId: "snap-1", definitionId: "def-anchor", title: "Anchor", completeness: complete("fixture"), rows: [row("a", { name: "a" })] })], { entities: entities("snap-1", "item", 60) });

  it("importing more matching content after page 1 makes its cursor CURSOR_STALE", async () => {
    const env = await open(searchBundle());
    const page = await env.call("search", { query: "item", maxBytes: 2048 });
    const cursor = cursorOf(page);
    expect(cursor, "page 1 must have a next page").not.toBeNull();
    must(await env.session.importBundle(bundleOf([listView({ id: "anchor2", snapshotId: "snap-2", definitionId: "def-anchor2", title: "Anchor 2", completeness: complete("fixture"), rows: [row("a", { name: "a" })] })], { entities: entities("snap-2", "item", 3) })));
    const error = failure(await env.call("search", { query: "item", maxBytes: 2048, cursor: cursor as string }));
    expect(error.code).toBe("CURSOR_STALE");
    expect(error.errors.map((issue) => issue.pointer)).toEqual(["/cursor"]);
  });

  it("control: importing content that does not match the query leaves the cursor valid", async () => {
    const env = await open(searchBundle());
    const cursor = cursorOf(await env.call("search", { query: "item", maxBytes: 2048 }));
    expect(cursor).not.toBeNull();
    must(await env.session.importBundle(bundleOf([listView({ id: "anchor2", snapshotId: "snap-2", definitionId: "def-anchor2", title: "Anchor 2", completeness: complete("fixture"), rows: [row("a", { name: "a" })] })], { entities: entities("snap-2", "zzz", 3) })));
    const next = await env.call("search", { query: "item", maxBytes: 2048, cursor: cursor as string });
    expect(next.ok, next.body).toBe(true);
  });
});
