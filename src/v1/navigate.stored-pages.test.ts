// Rows on stored pages, and targets the capture did not keep (field test F19). `navigate` read only the first page of a list, so `event-0150` of a
// 1 200-row view was "not in view" for the CLI and MCP while the viewer opened it; and a row whose target was not captured (`notCaptured:
// object-limit`) was lowered to a row with no target at all, so navigate said "no entity to open" and the viewer did nothing.
import { describe, expect, it } from "vitest";
import { Capture, defineType } from "../../packages/paneweft-ts/src/index.ts";
import { specLimits } from "../../packages/paneweft-ts/test/support.ts";
import { executeOperation } from "../core/operations.ts";
import { createSessionSource } from "../viewer/session-source.ts";
import { collectionImport, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { must } from "../../test/helpers/must.ts";
import { importCollection } from "./import.ts";
import { executeV1Operation } from "./tools.ts";

const open = useV1Sessions();
const Event = defineType<{ n: number }>({ id: "vigil::watch::Event", source: { path: "src/watch.rs", symbol: "Event" } });
Event.view({ id: "event.details", title: "Event", question: "What is in this event?", priority: 1, component: "shape", render: (event, view) => view.details().field("position", event.n).done() });
const Watch = defineType<{ events: number }>({ id: "vigil::watch::WatchFile", source: { path: "src/watch.rs", symbol: "WatchFile" } });
Watch.view({
  id: "watch.events", title: "Events", question: "Which events were retained?", priority: 2, component: "list",
  render: (watch, view) => {
    const table = view.table().textColumn("event", "Event").numberColumn("position", "Position");
    for (let n = 0; n < watch.events; n += 1) {
      const id = `event-${String(n).padStart(4, "0")}`;
      table.row({ id, cells: { event: id, position: n }, target: view.reference({ n }, Event, { key: id }) });
    }
    return table.done();
  },
});

/** 400 events, 100 rows per stored page, and room for `objects` captured objects: the events past it are not-captured targets. */
async function world(objects: number) {
  const { session, dir } = await open();
  const capture = new Capture({ captureId: "inv-1", runId: "run-1", invocationId: "inv-1", limits: specLimits({ objects }) });
  capture.publish({ events: 400 }, Watch);
  must(await importCollection(session, { ...collectionImport("vigil-redelivered"), graphs: [capture.finish().toJSON()] }), "import");
  const context = { session, sessionDir: dir, jobs: null };
  const result = async (extra: Record<string, unknown> = {}) => JSON.parse((await executeV1Operation(context, "view_result", { run: "run-1", view: "watch.events", format: "json", maxBytes: 32768, ...extra })).body);
  const first = await result();
  const entity = first.details.entity as { repository: string; id: string; kind: string };
  const navigate = async (itemId: string, format: "json" | "text" = "json") => executeOperation(session, "navigate", { pane: { entity, snapshotId: "snap-run-1", viewDefinitionId: "watch.events" }, itemId, format });
  return { session, context, result, navigate, entity, storedViewId: first.details.storedViewId as string };
}

/** The rows view_result returns for the whole list, by following its cursor (an independent path to the rows on stored pages). */
async function allRows(w: Awaited<ReturnType<typeof world>>): Promise<any[]> {
  const rows: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i += 1) {
    const page = await w.result({ maxBytes: 32768, ...(cursor === undefined ? {} : { cursor }) });
    rows.push(...page.items);
    cursor = page.cursor ?? undefined;
    if (cursor === undefined) break;
  }
  return rows;
}

describe("[F19] navigate reaches the rows of stored pages", () => {
  // why: F19. `event-0150` of a 1 200-row view: UNRESOLVED_TARGET "item does not exist in view". The row is on a stored page; the CLI/MCP navigate
  // must open the entity it targets, as the viewer does.
  // proves: CLAIM(F19-stored-pages)
  it("opens the entity a row on a stored page targets", async () => {
    const w = await world(260);
    const rows = await allRows(w);
    expect(rows).toHaveLength(400);
    const row = rows.find((candidate) => candidate.id === "event-0150");
    expect(row.entity, "event-0150 is on the second stored page and was captured").not.toBeNull();
    const outcome = await w.navigate("event-0150");
    expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
    expect(JSON.parse(outcome.body).pane.entity).toEqual(row.entity);
  });

  // why: F19. A row of the first page keeps working (the control that the stored-page lookup did not replace the first page's).
  // proves: CLAIM(F19-stored-pages)
  it("still opens a row of the first page", async () => {
    const w = await world(260);
    const outcome = await w.navigate("event-0003");
    expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
    expect(JSON.parse(outcome.body).pane.entity.id).toMatch(/^inv-1\.o/);
  });

  // why: F19. A row id that is in no page is still UNRESOLVED_TARGET: the page lookup must not turn every id into a hit.
  // proves: CLAIM(F19-stored-pages)
  it("refuses an id that is in no page", async () => {
    const w = await world(260);
    const outcome = await w.navigate("event-9999");
    expect(outcome.ok).toBe(false);
    expect(JSON.parse(outcome.body).code).toBe("UNRESOLVED_TARGET");
  });
});

describe("[F19] a target the capture did not keep is explained", () => {
  // why: F19. `event-1100` (not captured: object-limit) came back as "does not exist" (stored page) or "no entity to open" (first page). Both now say what
  // happened, which limit, and what to do, in a few hundred bytes.
  // proves: CLAIM(F19-not-captured)
  it.each(["event-0070", "event-0300"])("navigate on %s says the object was not captured, and why", async (itemId) => {
    const w = await world(60);
    const rows = await allRows(w);
    expect(rows.find((row) => row.id === itemId).entity, "the row has no entity because the target was not captured").toBeNull();
    const outcome = await w.navigate(itemId);
    expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
    const payload = JSON.parse(outcome.body);
    expect(payload.pane).toBeNull();
    expect(payload.notice).toMatchObject({ code: "NOT_CAPTURED", itemId, reason: "object-limit" });
    expect(payload.notice.message).toContain(itemId);
    expect(payload.notice.message).toContain("object-limit");
    expect(payload.notice.message).toMatch(/collect/);
    expect(payload.notice.message.length).toBeLessThanOrEqual(400);
    const text = (await w.navigate(itemId, "text")).body;
    expect(text).toContain("NOT_CAPTURED:");
  });

  // why: F19. view_result shows the same fact on the row: the agent sees which rows lead nowhere before it tries.
  // proves: CLAIM(F19-not-captured)
  it("view_result marks the rows whose target was not captured", async () => {
    const w = await world(60);
    const rows = await allRows(w);
    const missing = rows.filter((row) => row.notCaptured !== undefined && row.notCaptured !== null);
    expect(missing.length).toBe(rows.filter((row) => row.entity === null).length);
    expect(missing.length).toBeGreaterThan(300);
    expect(missing[0].notCaptured).toEqual({ reason: "object-limit" });
    const text = (await executeV1Operation(w.context, "view_result", { run: "run-1", view: "watch.events", format: "text", maxBytes: 32768 })).body;
    expect(text).toContain("-> not captured: object-limit");
  });

  // why: F19. The viewer's data source gives the row the same fact the tool does: it is what the viewer shows and what Enter explains.
  // proves: CLAIM(F19-not-captured)
  it("the viewer's model carries the not-captured reason on the row", async () => {
    const w = await world(60);
    const model = must(await createSessionSource(w.session).getView({ viewId: w.storedViewId, snapshotId: "snap-run-1" }), "model");
    const rows = (model.envelope.data as { rows: Array<{ id: string; notCaptured?: { reason: string } }> }).rows;
    expect(rows.find((row) => row.id === "event-0300")!.notCaptured).toEqual({ reason: "object-limit" });
    expect(rows.find((row) => row.id === "event-0003")!.notCaptured).toBeUndefined();
  });
});
