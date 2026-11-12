// Fix round 1, S11: the rows of a captured list beyond the first page are reachable from the agent tool (through its cursor) and from the
// viewer's data source. The graph is made by the TypeScript SDK itself, with a table of 250 rows and 100 rows per stored page.
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Capture, defineType } from "../../packages/paneweft-ts/src/index.ts";
import { canonical, collectionImport, sha256, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { must } from "../../test/helpers/must.ts";
import { createSessionSource } from "../viewer/session-source.ts";
import { importCollection } from "./import.ts";
import { captureFile, pageFile, pageRefsFile } from "./read.ts";
import { executeV1Operation } from "./tools.ts";

const open = useV1Sessions();
const Watch = defineType<{ rows: number }>({ id: "vigil::watch::WatchFile", source: { path: "src/watch.rs", symbol: "WatchFile" } });
Watch.view({
  id: "watch.events", title: "Events", question: "Which events were retained?", priority: 20, component: "list",
  render: (watch, view) => {
    const table = view.table().textColumn("event", "Event").numberColumn("tick", "Tick").orderBy("tick", "asc");
    for (let i = 0; i < watch.rows; i += 1) table.row({ id: `event-${String(i).padStart(4, "0")}`, cells: { event: `e-${i}`, tick: i } });
    return table.done();
  },
});

function bigCollection(rows: number) {
  const capture = new Capture({ captureId: "inv-1", runId: "run-1", invocationId: "inv-1" });
  capture.publish({ rows }, Watch);
  const input = collectionImport("vigil-redelivered");
  return { ...input, graphs: [capture.finish().toJSON()] };
}

describe("[S11] stored pages are reachable", () => {
  // why: S11. view_result paginated only the first page's rows (data.rows); no production caller read a stored page, so rows 101-250 of a
  // 250-row table were in the session and in no reply. Following the cursor must now return all of them, once, in order. Rejects an
  // implementation that serves `envelope.data.rows` and never opens a page.
  // proves: CLAIM(S11-stored-pages) CLAIM(IV19)
  it("returns every row of a 250-row table through view_result's cursor", async () => {
    const { session, dir } = await open();
    must(await importCollection(session, bigCollection(250)), "import");
    const context = { session, sessionDir: dir, jobs: null };
    const ids: string[] = [];
    let cursor: string | undefined;
    let last: any;
    for (let page = 0; page < 200; page += 1) {
      const outcome = await executeV1Operation(context, "view_result", { run: "run-1", view: "watch.events", format: "json", maxBytes: 4096, ...(cursor === undefined ? {} : { cursor }) });
      expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
      last = JSON.parse(outcome.body);
      ids.push(...last.items.map((item: any) => item.id));
      cursor = last.cursor ?? undefined;
      if (cursor === undefined) break;
    }
    expect(ids).toEqual(Array.from({ length: 250 }, (_, i) => `event-${String(i).padStart(4, "0")}`));
    expect(last.counts.total).toBe(250);
    expect(last.completeness.status).toBe("complete");
    expect(last.details.storedPages).toEqual([]);
  });

  // why: S11. The viewer's data source served the stored envelope, so a viewer showed 100 of 250 rows and a "more rows are stored" gap it could
  // not follow. Its view model now holds all 250 and is complete.
  // proves: CLAIM(S11-stored-pages)
  it("gives the viewer all 250 rows of the same table", async () => {
    const { session } = await open();
    must(await importCollection(session, bigCollection(250)), "import");
    const entry = (await session.listViewIndex("snap-run-1")).find((candidate) => candidate.viewDefinitionId === "watch.events")!;
    const model = must(await createSessionSource(session).getView({ viewId: entry.viewId, snapshotId: "snap-run-1" }), "viewer model");
    const data = model.envelope.data as { rows: Array<{ id: string }> };
    expect(data.rows).toHaveLength(250);
    expect(data.rows[249]!.id).toBe("event-0249");
    expect(model.envelope.completeness.status).toBe("complete");
  });

  // why: S11. A stored page that cannot be read is named, not silently dropped: the rows that are there are served and the completeness stays partial.
  // proves: CLAIM(S11-stored-pages)
  it("names a stored page it cannot read", async () => {
    const { session, dir } = await open();
    must(await importCollection(session, bigCollection(250)), "import");
    const pages = readdirSync(join(dir, "v1", "pages"));
    expect(pages).toHaveLength(2);
    rmSync(join(dir, "v1", "pages", pages[0]!));
    const entry = (await session.listViewIndex("snap-run-1")).find((candidate) => candidate.viewDefinitionId === "watch.events")!;
    const model = must(await createSessionSource(session).getView({ viewId: entry.viewId, snapshotId: "snap-run-1" }), "viewer model");
    expect(model.envelope.completeness.status).toBe("partial");
    expect(JSON.stringify(model.envelope.completeness)).toContain("could not be read");
    expect((model.envelope.data as { rows: unknown[] }).rows.length).toBeLessThan(250);
  });
});

describe("[S22] an invalid stored page is an explicit error, never a throw", () => {
  /** Replaces the first stored page of the 250-row table with `rows`, correctly hashed and referenced: what admission used to let through. */
  async function corrupt(rows: unknown[], mutate: (page: any) => void = () => {}) {
    const { session, dir } = await open();
    must(await importCollection(session, bigCollection(250)), "import");
    const file = captureFile(session, "run-1", "inv-1");
    const graph = JSON.parse(readFileSync(file, "utf8"));
    const view = graph.views.find((candidate: any) => candidate.viewId === "watch.events");
    const old = view.pages[0];
    const page: any = { pageId: `sha256:${sha256(canonical(rows))}`, rows };
    mutate(page);
    view.pages[0] = { index: old.index, pageId: page.pageId, rowCount: rows.length };
    writeFileSync(file, JSON.stringify(graph));
    writeFileSync(pageFile(session, page.pageId), JSON.stringify(page));
    // the reference that owns the page names the new body (D2)
    const refsFile = pageRefsFile(session, "run-1");
    const refs = JSON.parse(readFileSync(refsFile, "utf8"));
    const own = refs.refs.find((ref: any) => ref.viewId === "watch.events" && ref.position === old.index);
    own.pageId = page.pageId;
    own.rowCount = rows.length;
    writeFileSync(refsFile, JSON.stringify(refs));
    return { session, dir, pageId: page.pageId as string };
  }
  const read = async (session: any, dir: string) => executeV1Operation({ session, sessionDir: dir, jobs: null }, "view_result", { run: "run-1", view: "watch.events", format: "json", maxBytes: 8192 });

  // why: S22. A page holding `{}` made view_result throw a TypeError at `Object.entries(row.cells)`; the viewer's data source threw the same. Both answer with
  // an error that names the page. Rejects a reader that trusts the page it reads.
  // proves: CLAIM(S22-page-rows)
  it.each([
    ["an empty object", [{}]],
    ["a row whose cells are not an object", [{ id: "x", cells: 7, provenance: "observed", evidence: ["run"] }]],
    ["a row for an undeclared column", [{ id: "x", cells: { nope: 1 }, provenance: "observed", evidence: ["run"] }]],
    ["a row id the first page already holds", [{ id: "event-0000", cells: { event: "e", tick: 0 }, provenance: "observed", evidence: ["run"] }]],
  ])("view_result and the viewer refuse a stored page holding %s", async (_name, rows) => {
    const { session, dir, pageId } = await corrupt(rows);
    const outcome = await read(session, dir);
    expect(outcome.ok, "an invalid page is not served").toBe(false);
    expect(JSON.parse(outcome.body)).toMatchObject({ code: "STORAGE_CORRUPT" });
    expect(outcome.body).toContain(pageId);
    const entry = (await session.listViewIndex("snap-run-1")).find((candidate) => candidate.viewDefinitionId === "watch.events")!;
    const model = await createSessionSource(session).getView({ viewId: entry.viewId, snapshotId: "snap-run-1" });
    expect(model.ok).toBe(false);
  });

  // why: S22. A page whose rows no longer hash to its id (the file was edited, or truncated and rewritten) is the same error: stored pages are content addressed.
  // proves: CLAIM(S22-page-rows)
  it("refuses a stored page whose rows do not hash to its id", async () => {
    const { session, dir, pageId } = await corrupt([{ id: "x", cells: { event: "e", tick: 1 }, provenance: "observed", evidence: ["run"] }], (page) => { page.pageId = `sha256:${"0".repeat(64)}`; });
    // the file is stored under the id the view lists; its own pageId says something else
    writeFileSync(pageFile(session, pageId), JSON.stringify({ pageId, rows: [{ id: "y", cells: {}, provenance: "observed", evidence: ["run"] }] }));
    const outcome = await read(session, dir);
    expect(outcome.ok).toBe(false);
    expect(JSON.parse(outcome.body)).toMatchObject({ code: "STORAGE_CORRUPT" });
  });
});
