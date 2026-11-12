// F18 (TypeScript): a large real object keeps its main list. A root whose list view has one row per child object used to lose the list entirely: the children were captured
// first and spent the root's byte budget, so the list's frame no longer fitted and the view was `unsupported` with zero rows. Same scenarios as crates/paneweft/tests/children_budget.rs.
import { describe, expect, it } from "vitest";
import { Capture, defineType } from "./index.ts";
import { specLimits } from "../test/support.ts";

const Event = defineType<{ n: number }>({ id: "t::Event", source: { path: "children.test.ts", symbol: "Event" } });
Event.view({ id: "event.details", title: "Event", question: "What is in this event?", priority: 1, component: "shape", render: (event, view) => view.details().field("id", `event-${event.n}`).field("kind", "line").field("position", event.n).done() });
const Watch = defineType<{ events: Array<{ n: number }> }>({ id: "t::Watch", source: { path: "children.test.ts", symbol: "Watch" } });
Watch.view({ id: "watch.status", title: "Status", question: "How many events?", priority: 1, component: "shape", render: (watch, view) => view.details().field("event count", watch.events.length).done() });
Watch.view({
  id: "watch.events", title: "Events", question: "Which events were retained, and were they redelivered?", priority: 2, component: "list",
  render: (watch, view) => {
    const table = view.table().textColumn("event", "Event").numberColumn("position", "Position");
    for (const event of watch.events) table.row({ id: `event-${event.n}`, cells: { event: `event-${event.n}`, position: event.n }, target: view.reference(event, Event, { key: `event-${event.n}` }) });
    return table.done();
  },
});

const capture = (events: number): any => {
  const c = new Capture({ limits: specLimits() });
  c.publish({ events: Array.from({ length: events }, (_, n) => ({ n })) }, Watch);
  return c.finish().toJSON();
};
const viewOf = (graph: any, id: string): any => graph.views.find((v: any) => v.viewId === id && v.objectId === "o1");

describe("[F18] a list with child references keeps its rows", () => {
  // why: F18. 20 000 events, each row referencing its event: the list is partial with its first rows and says how many it omitted; the rows whose event did not fit are not-captured targets.
  // proves: CLAIM(F18-rows-before-children)
  it("is partial, not unsupported, when the budget is exhausted", () => {
    const graph = capture(20_000);
    const list = viewOf(graph, "watch.events");
    expect(list.completeness.status).toBe("partial");
    expect(list.completeness.reason).toBe("row-limit");
    const stored = list.pages.reduce((sum: number, page: any) => sum + page.rowCount, 0);
    expect(list.data.rows.length + stored).toBe(list.rowsTotal);
    expect(list.rowsTotal).toBeGreaterThanOrEqual(1000);
    expect(list.rowsTotal + list.completeness.omitted.rows.count).toBe(20_000);
    expect(list.data.rows[0].id).toBe("event-0");
    const rows = [...list.data.rows, ...graph.pages.flatMap((page: any) => page.rows)];
    expect(rows.filter((row: any) => row.target.object !== undefined).length).toBeGreaterThan(0);
    expect(rows.filter((row: any) => row.target.notCaptured !== undefined).length).toBeGreaterThan(0);
    expect(viewOf(graph, "watch.status").completeness.status).toBe("complete");
    const charged = Buffer.byteLength(JSON.stringify([graph.objects, graph.views, graph.pages, graph.diagnostics]), "utf8");
    expect(charged).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  // why: F18 control. A list that fits is untouched: every row, every child captured.
  // proves: CLAIM(F18-rows-before-children)
  it("leaves a list that fits complete, with every child captured", () => {
    const graph = capture(50);
    const list = viewOf(graph, "watch.events");
    expect(list.completeness.status).toBe("complete");
    expect(list.rowsTotal).toBe(50);
    expect(graph.objects).toHaveLength(51);
  });
});
