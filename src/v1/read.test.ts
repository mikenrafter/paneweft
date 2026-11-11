// Reading imported collections (IV10: stored pages and not-captured; IV11: exact object navigation, aliases, cycles, separate captures)
// and text/browser agreement of the facts (S12). Navigation goes through the UNCHANGED v0 operations.
import { describe, expect, it } from "vitest";
import { executeOperation } from "../core/operations.ts";
import { startViewer } from "../viewer/server.ts";
import { useViewerDom } from "../../test/helpers/viewer-dom.ts";
import { DIST_VIEWER } from "../../test/helpers/wire-http.ts";
import { canonical, collectionFixture, collectionImport, sha256, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { must } from "../../test/helpers/must.ts";
import { importCollection } from "./import.ts";
import { openV1Reader } from "./read.ts";

const open = useV1Sessions();
const mountViewer = useViewerDom();

async function inspectJson(session: any, args: Record<string, unknown>): Promise<any> {
  const outcome = await executeOperation(session, "inspect_view", { format: "json", ...args });
  expect(outcome.ok, outcome.body.slice(0, 400)).toBe(true);
  return JSON.parse(outcome.body);
}

describe("[IV10] stored pages and not-captured branches", () => {
  // why: IV10. A child page is read by its content address with no source process alive (the reader opens the session only), and the
  // bytes are exactly the rows that were stored.
  // proves: CLAIM(IV10)
  it("reads a stored page by content address after import", async () => {
    const { session } = await open();
    const input = collectionImport("vigil-redelivered");
    const graph = input.graphs[0] as any;
    const rows = graph.views[1].data.rows.slice(1);
    const pageId = `sha256:${sha256(canonical(rows))}`;
    graph.views[1].data.rows = graph.views[1].data.rows.slice(0, 1);
    graph.views[1].pages = [{ index: 1, pageId, rowCount: rows.length }];
    graph.pages = [{ pageId, viewId: "watch.events", objectId: "o1", index: 1, rows }];
    must(await importCollection(session, input), "import");
    const page = must(await openV1Reader(session).page(pageId), "page");
    expect(page.rows).toEqual(rows);
    expect(page.index).toBe(1);
  });

  // why: IV10. A branch that was not captured is a stored state with a reason and a recollection SELECTOR (data for `collect`),
  // never a live callback; the old snapshot is not changed by asking.
  // proves: CLAIM(IV10)
  it("a not-captured branch keeps its reason and a recollection selector", async () => {
    const { session } = await open();
    const input = collectionImport("vigil-redelivered");
    const graph = input.graphs[0] as any;
    graph.objects[0].edges.push({ name: "watch.events", kind: "not-captured", reason: "depth-limit", selector: { examples: ["watch.cancelled"], limits: { depth: 8 } } });
    must(await importCollection(session, input), "import");
    const stored = must(await openV1Reader(session).object({ snapshotId: "snap-run-1", captureId: "inv-1", objectId: "o1" }), "object");
    const edge = stored.record.edges.find((e) => e.kind === "not-captured");
    expect(edge).toEqual({ name: "watch.events", kind: "not-captured", reason: "depth-limit", selector: { examples: ["watch.cancelled"], limits: { depth: 8 } } });
  });
});

describe("[IV11] objects, aliases, cycles and snapshots", () => {
  // why: IV11. Selecting a row opens the exact object (the event at tick 6, not the same-looking e-1 at tick 3) through the v0 navigate
  // operation, and the opened pane offers the object's stored view.
  // proves: CLAIM(IV11) CLAIM(IV21)
  it("navigate follows a row to the exact captured object", async () => {
    const { session } = await open();
    must(await importCollection(session, collectionImport("vigil-redelivered")), "import");
    const events = await inspectJson(session, { viewId: "inv-1.o1.watch.events", snapshotId: "snap-run-1" });
    const rows = events.items as any[];
    const duplicate = rows.filter((r) => r.cells.event === "e-1").map((r) => r.id);
    expect(duplicate).toEqual(["event-0", "event-2"]);
    const pane = { entity: { repository: "vg", kind: "vigil/watch/watch-file", id: "inv-1.o1" }, snapshotId: "snap-run-1", viewDefinitionId: "watch.events", selection: [], filters: {}, pinned: false };
    const followed = await executeOperation(session, "navigate", { format: "json", pane, itemId: "event-2" });
    expect(followed.ok, followed.body.slice(0, 300)).toBe(true);
    const target = JSON.parse(followed.body);
    expect(target.pane.entity).toEqual({ repository: "vg", kind: "vigil/watch/event", id: "inv-1.o4" });
    const opened = must(await openV1Reader(session).object({ snapshotId: "snap-run-1", captureId: "inv-1", objectId: "o4" }), "object o4");
    expect(opened.record.fields).toEqual({ tick: 6, redelivered: true });
  });

  // why: IV11. Aliases and cycles are shown without duplicating the graph: the shared child lists BOTH referrers as backlinks with
  // their kinds, and the cycle target lists the cycle edge.
  // proves: CLAIM(IV11) CLAIM(S11-alias)
  it("lists alias and cycle backlinks without duplicating the object", async () => {
    const { session } = await open();
    must(await importCollection(session, collectionImport("cycle-alias", {}, { graph: "object-graph.a.json", run: "test-run.a.json" })), "import");
    const reader = openV1Reader(session);
    const shared = must(await reader.object({ snapshotId: "snap-run-a", captureId: "inv-1", objectId: "o3" }), "o3");
    expect(shared.backlinks.map((b) => [b.from.objectId, b.name, b.kind]).sort()).toEqual([["o1", "side", "child"], ["o2", "side", "alias"]]);
    const root = must(await reader.object({ snapshotId: "snap-run-a", captureId: "inv-1", objectId: "o1" }), "o1");
    expect(root.backlinks.map((b) => [b.from.objectId, b.kind])).toEqual([["o2", "cycle"]]);
  });

  // why: IV11. Two separate captures use the same object ids (o1..o3). A pane of snapshot A must never resolve an object of snapshot B:
  // the entity ids differ by capture (here the runs differ), and an object key with the wrong snapshot is NOT_FOUND.
  // proves: CLAIM(IV11)
  it("never substitutes an object of another snapshot", async () => {
    const { session } = await open();
    must(await importCollection(session, collectionImport("cycle-alias", {}, { graph: "object-graph.a.json", run: "test-run.a.json" })), "A");
    must(await importCollection(session, collectionImport("cycle-alias", {}, { graph: "object-graph.b.json", run: "test-run.b.json" })), "B");
    const reader = openV1Reader(session);
    const a = must(await reader.object({ snapshotId: "snap-run-a", captureId: "inv-1", objectId: "o2" }), "A o2");
    const b = must(await reader.object({ snapshotId: "snap-run-b", captureId: "inv-1", objectId: "o2" }), "B o2");
    expect([a.record.label, b.record.label]).toEqual(["b-A", "b-B"]);
    const crossed = await reader.object({ snapshotId: "snap-run-a", captureId: "inv-1", objectId: "o2" });
    expect(crossed.ok && crossed.value.record.label).toBe("b-A");
    const wrong = await reader.object({ snapshotId: "snap-run-zzz", captureId: "inv-1", objectId: "o2" });
    expect(wrong.ok).toBe(false);
    expect(wrong.ok ? "" : wrong.error.code).toBe("NOT_FOUND");
    const pane = { entity: { repository: "vg", kind: "fx/node", id: "inv-1.o1" }, snapshotId: "snap-run-b", viewDefinitionId: "node.links", selection: [], filters: {}, pinned: false };
    const followed = await executeOperation(session, "navigate", { format: "json", pane, itemId: "link-0" });
    expect(followed.ok, followed.body.slice(0, 300)).toBe(true);
    expect(JSON.parse(followed.body).pane.snapshotId, "navigation stays in the pane's snapshot").toBe("snap-run-b");
  });
});

describe("[S12] text and browser carry the same domain facts", () => {
  // why: S12 / IV21. The text form of the events view carries, per row, the event id, its tick and its redelivered flag, in the v0
  // row grammar; the three rows below are written out by hand from the fixture (two events share the id e-1 and differ in tick).
  // proves: CLAIM(S12-text-completeness) CLAIM(IV21)
  it("text lists every event with tick and redelivered", async () => {
    const { session } = await open();
    must(await importCollection(session, collectionImport("vigil-redelivered")), "import");
    const outcome = await executeOperation(session, "inspect_view", { viewId: "inv-1.o1.watch.events", snapshotId: "snap-run-1" });
    expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
    const lines = outcome.body.split("\n");
    for (const expected of [
      "e-1 -> vigil/watch/event:inv-1.o2; observed; run | tick=3 | redelivered=false",
      "e-1 -> vigil/watch/event:inv-1.o4; observed; run | tick=6 | redelivered=true",
      "e-2 -> vigil/watch/event:inv-1.o3; observed; run | tick=5 | redelivered=true",
    ]) expect(lines, expected).toContain(expected);
  });

  // why: S12. ContainMarks mapping fields (original index, container ID, backup name) are all in the text, with their values.
  // proves: CLAIM(S12-text-completeness) CLAIM(IV21)
  it("text carries the three mapping fields", async () => {
    const { session } = await open();
    must(await importCollection(session, collectionImport("containmarks-mapping")), "import");
    const outcome = await executeOperation(session, "inspect_view", { viewId: "inv-1.o1.mapping.details", snapshotId: "snap-run-2" });
    expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
    const text = outcome.body;
    expect(text).toMatch(/\$\.original index[^\n]*example: 4\b/);
    expect(text).toMatch(/\$\.container ID[^\n]*example: "firefox-container-3"/);
    expect(text).toMatch(/\$\.backup name[^\n]*example: "Work"/);
  });

  // why: S12. At the smallest budget the 60-event list still delivers every fact: pages carry whole rows, a cursor continues, nothing
  // is thinned. The expected rows are generated by an independent loop.
  // proves: CLAIM(S12-text-completeness)
  it("at 2048 bytes every row survives across cursor pages", async () => {
    const { session } = await open();
    const input = collectionImport("vigil-redelivered");
    const graph = input.graphs[0] as any;
    const count = 60;
    const events = Array.from({ length: count }, (_, i) => ({ id: `e-${String(i).padStart(2, "0")}`, tick: 100 + i, redelivered: i % 2 === 0 }));
    graph.objects = [graph.objects[0], ...events.map((e, i) => ({ id: `o${i + 2}`, typeId: "vigil::watch::Event", domainKey: e.id, label: e.id, fields: { tick: e.tick, redelivered: e.redelivered }, edges: [], views: [], contentHash: sha256(canonical({ typeId: "vigil::watch::Event", domainKey: e.id, label: e.id, fields: { tick: e.tick, redelivered: e.redelivered } })) }))];
    graph.objects[0].edges = events.map((_, i) => ({ name: "watch.events", kind: "child", target: `o${i + 2}` }));
    graph.views = [{ ...graph.views[1], data: { ...graph.views[1].data, rows: events.map((e, i) => ({ id: `event-${i}`, cells: { event: e.id, tick: e.tick, redelivered: e.redelivered }, provenance: "observed", evidence: ["run"], target: { object: `o${i + 2}` } })) }, rowsTotal: count }];
    must(await importCollection(session, input), "import");
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 200; page += 1) {
      const outcome = await executeOperation(session, "inspect_view", { viewId: "inv-1.o1.watch.events", snapshotId: "snap-run-1", maxBytes: 2048, ...(cursor === undefined ? {} : { cursor }) });
      expect(outcome.ok, outcome.body.slice(0, 200)).toBe(true);
      for (const line of outcome.body.split("\n")) { const m = /^(e-\d\d) -> .*\| tick=(\d+) \| redelivered=(true|false)$/.exec(line); if (m) seen.add(`${m[1]}:${m[2]}:${m[3]}`); }
      const next = /^cursor: (.+)$/m.exec(outcome.body)?.[1];
      if (next === undefined) break;
      cursor = next;
    }
    expect([...seen].sort()).toEqual(events.map((e) => `${e.id}:${e.tick}:${e.redelivered}`).sort());
  });

  // why: S12 browser path. The SHIPPED viewer bundle (jsdom, real server) shows the same facts for the same snapshot.
  // proves: CLAIM(S12-text-completeness) CLAIM(IV11)
  it("the browser renders the same event facts", async () => {
    const { session } = await open();
    must(await importCollection(session, collectionImport("vigil-redelivered")), "import");
    const server = must(await startViewer({ session, assetsDirectory: DIST_VIEWER }), "startViewer");
    try {
      const page = mountViewer(server, "inv-1.o1.watch.events", "snap-run-1");
      const text = await page.settled(() => { const t = page.text(page.window.document.body); expect(t).toContain("e-2"); return t; });
      for (const fact of ["e-1", "e-2", "3", "5", "6", "true", "false"]) expect(text, fact).toContain(fact);
      expect(page.pw("row").length, "one row per event occurrence").toBe(3);
    } finally {
      await server.close();
    }
  });
});
