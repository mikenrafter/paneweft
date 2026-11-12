// D2 (consolidation): the rows of a stored page are an immutable body addressed by their content, and who owns a page is a separate reference
// keyed by (run, capture, object, view, position). Identical bodies are shared; sharing never changes who owns what.
import { describe, expect, it } from "vitest";
import { Capture, defineType } from "../../packages/paneweft-ts/src/index.ts";
import { collectionImport, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { must } from "../../test/helpers/must.ts";
import { createSessionSource } from "../viewer/session-source.ts";
import { importCollection } from "./import.ts";
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
const Holder = defineType<{ rows: number; children: number }>({ id: "vigil::watch::Holder", source: { path: "src/watch.rs", symbol: "Holder" } });
Holder.view({
  id: "holder.details", title: "Holder", question: "What does it hold?", priority: 1, component: "shape",
  render: (holder, view) => {
    for (let i = 0; i < holder.children; i += 1) view.reference({ rows: holder.rows }, Watch, { name: `watch-${i}` });
    return view.details().field("children", holder.children).done();
  },
});

/** A run whose captured objects are `children` watches with identical tables, below a holder (o1) when `wrapped`, or one watch (o1) alone. */
function collection(runId: string, options: { rows: number; children?: number }) {
  const capture = new Capture({ captureId: "inv-1", runId, invocationId: "inv-1" });
  if (options.children === undefined) capture.publish({ rows: options.rows }, Watch);
  else capture.publish({ rows: options.rows, children: options.children }, Holder);
  const input = collectionImport("vigil-redelivered");
  return { ...input, runId, run: { ...(input.run as object), runId }, graphs: [capture.finish().toJSON()] };
}

const viewResult = async (env: Awaited<ReturnType<typeof open>>, run: string, observation?: string) =>
  executeV1Operation({ session: env.session, sessionDir: env.dir, jobs: null }, "view_result", { run, view: "watch.events", format: "json", maxBytes: 262_144, ...(observation === undefined ? {} : { observation }) });
const ids = (body: string): string[] => (JSON.parse(body) as { items: Array<{ id: string }> }).items.map((item) => item.id);
const expected = (rows: number): string[] => Array.from({ length: rows }, (_, i) => `event-${String(i).padStart(4, "0")}`);

describe("[D2] page bodies are shared, page ownership is not", () => {
  // why: D2 / S24. Two objects with identical tables have identical rows, so identical page ids. The global writer stored one record per id and
  // the second object's import overwrote the first's, so reading the first returned STORAGE_CORRUPT. Rejects any layout in which the owner of a
  // page is a property of the page's address.
  // proves: CLAIM(D2-page-ownership)
  it("reads two objects with identical tables, each its own rows", async () => {
    const env = await open();
    must(await importCollection(env.session, collection("run-1", { rows: 250, children: 2 })), "import");
    for (const object of ["o2", "o3"]) {
      const outcome = await viewResult(env, "run-1", object);
      expect(outcome.ok, `${object}: ${outcome.body.slice(0, 300)}`).toBe(true);
      expect(ids(outcome.body)).toEqual(expected(250));
    }
  });

  // why: D2. The same table in two different runs (here on a different object id) shares its stored bodies, and importing the second run leaves
  // the first run's pages readable and owned by the first run. Rejects an import that rewrites a page another run already holds.
  // proves: CLAIM(D2-page-ownership)
  it("keeps an earlier import readable when a later import stores the same rows for another object", async () => {
    const env = await open();
    must(await importCollection(env.session, collection("run-1", { rows: 250 })), "first import");
    must(await importCollection(env.session, collection("run-2", { rows: 250, children: 1 })), "second import");
    const first = await viewResult(env, "run-1");
    expect(first.ok, first.body.slice(0, 300)).toBe(true);
    expect(ids(first.body)).toEqual(expected(250));
    const second = await viewResult(env, "run-2", "o2");
    expect(second.ok, second.body.slice(0, 300)).toBe(true);
    expect(ids(second.body)).toEqual(expected(250));
    const entry = (await env.session.listViewIndex("snap-run-1")).find((candidate) => candidate.viewDefinitionId === "watch.events")!;
    const model = must(await createSessionSource(env.session).getView({ viewId: entry.viewId, snapshotId: "snap-run-1" }), "the viewer reads the first run");
    expect((model.envelope.data as { rows: unknown[] }).rows).toHaveLength(250);
  });

  // why: D2. Two imports that run at the same moment and store the same rows for different owners: whichever commits last, both runs read back
  // their own rows. Rejects a last-writer-wins page record.
  // proves: CLAIM(D2-page-ownership)
  it("keeps both of two concurrent imports readable when they store identical rows", async () => {
    const env = await open();
    const results = await Promise.all([
      importCollection(env.session, collection("run-1", { rows: 250 })),
      importCollection(env.session, collection("run-2", { rows: 250, children: 2 })),
    ]);
    for (const result of results) must(result, "import");
    for (const [run, object] of [["run-1", undefined], ["run-2", "o2"], ["run-2", "o3"]] as const) {
      const outcome = await viewResult(env, run, object);
      expect(outcome.ok, `${run} ${object ?? ""}: ${outcome.body.slice(0, 300)}`).toBe(true);
      expect(ids(outcome.body)).toEqual(expected(250));
    }
  });
});
