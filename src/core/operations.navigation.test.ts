// why: CLAIM(MC7) pane navigation and CLAIM(MC8) exact cross-view links at the OPERATION level. open_entity and
// navigate are stateless (design 5 table: the pane state travels in the arguments), so this file pins what they return:
// the pane state {entity, snapshotId, viewDefinitionId, selection, filters, pinned} (design 3 "Each pane stores ..."),
// the available / needs-data / unsupported view lists in rank order (red-contract 5), preferred-view precedence with a
// visible fallback, unresolved targets that are NAMED, snapshots that never mix, and NO_TARGET for an item without an
// entity (design 2: "An item without an entity or anchor shows that absence; clicking it must not invent a target").
// The reducer itself (Back, pin, retained branches) is a different module; here only the stateless contracts.
// JSON field names (`pane`, `views.available`, `views.needs_data`, `views.unsupported`, `selected`) and the NO_TARGET
// shape are proposals in docs/contract-additions/ops.md section 6.
import { describe, expect, it } from "vitest";
import { allBundle } from "../../test/helpers/fixtures.ts";
import { assertBodyWithin, failure, issuesOf, okJson, okText, useOps } from "../../test/helpers/ops-env.ts";
import { patch } from "../../test/helpers/patch.ts";
import { bundleOf, entityAt, listView, MCP, moduleRef, row, unsupportedView, WATCH } from "../../test/helpers/ops-views.ts";

const open = useOps();
const OPEN = (extra: Record<string, unknown> = {}) => ({ snapshotId: "snap-1", entity: WATCH, ...extra });
const pane = (viewDefinitionId: string, entity: Record<string, unknown> = WATCH, snapshotId = "snap-1") => ({
  entity, snapshotId, viewDefinitionId, selection: [], filters: {}, pinned: false,
});

/** The ids of definitions in a views list. */
const defs = (list: Array<{ viewDefinitionId: string }>) => list.map((entry) => entry.viewDefinitionId);

describe("[MC7] open_entity: pane state and views in rank order", () => {
  // why: red-contract 5 rank rule: exact-kind definitions by (priority, id), then the `*` built-ins
  // builtin:metadata (1000) and builtin:raw (1001), which are always available. The fixture priorities are
  // def-modules 10, def-layout 20, def-delivery 30, def-source 40, def-shape 50, def-example 60 (fixtures/components/all.bundle.json).
  // proves: CLAIM(MC7)/CLAIM(MC12) the initial pane is the first applicable view and the list is rank-ordered.
  it("[MC7] the fixture entity opens at def-modules with a fresh pane state; eight views are available, in rank order", async () => {
    const env = await open(allBundle());
    const reply = okJson(await env.call("open_entity", OPEN({ format: "json" })));
    expect(reply.pane).toEqual({ entity: WATCH, snapshotId: "snap-1", viewDefinitionId: "def-modules", selection: [], filters: {}, pinned: false });
    expect(defs(reply.views.available)).toEqual(["def-modules", "def-layout", "def-delivery", "def-source", "def-shape", "def-example", "builtin:metadata", "builtin:raw"]);
    expect(reply.views.available.map((v: { priority: number }) => v.priority)).toEqual([10, 20, 30, 40, 50, 60, 1000, 1001]);
    expect(reply.views.available[2]).toMatchObject({ viewDefinitionId: "def-delivery", title: "Delivery path", component: "graph" });
    expect(reply.views.needs_data).toEqual([]);
    expect(reply.views.unsupported).toEqual([]);
    expect(reply.selected).toEqual({ viewDefinitionId: "def-modules" });
    // the bounded answer is the initial view's reply
    expect(reply.view).toMatchObject({ id: "modules", component: "list", snapshotId: "snap-1" });
    expect(reply.counts).toMatchObject({ unit: "rows", total: 1, matched: 1, returned: 1 });
  });
  it("[MC7] text: the answer header of the initial view, then one 'available:' line per view in the same order", async () => {
    const env = await open(allBundle());
    const text = okText(await env.call("open_entity", OPEN()));
    expect(text.firstLine).toBe("paneweft.reply/1 view=modules component=list");
    const available = text.body.filter((l) => l.startsWith("available: ")).map((l) => l.split(" ")[1]);
    expect(available).toEqual(["def-modules", "def-layout", "def-delivery", "def-source", "def-shape", "def-example", "builtin:metadata", "builtin:raw"]);
  });
  it("[MC7] a pane for an entity with no registered definitions offers exactly the two built-ins, metadata first", async () => {
    const env = await open(allBundle());
    const reply = okJson(await env.call("open_entity", { snapshotId: "snap-1", entity: MCP, format: "json" }), { schema: false });
    expect(reply.pane).toEqual({ entity: MCP, snapshotId: "snap-1", viewDefinitionId: "builtin:metadata", selection: [], filters: {}, pinned: false });
    expect(defs(reply.views.available)).toEqual(["builtin:metadata", "builtin:raw"]);
  });

  // why: design 3 "Applicability has a visible result: available, needs data with named missing roles, or unsupported
  // with a reason" and red-contract 5: required = requires union {dataRole}; missing = required minus entity.dataRoles, sorted.
  // Scenario: the entity only has the roles modules and layout; a priority-15 definition also requires alerts and telemetry.
  // proves: CLAIM(MC12) needs_data entries are listed separately and name the missing roles.
  const needsDataBundle = () =>
    patch(
      allBundle(),
      { op: "replace", path: "/entities/0/dataRoles", value: ["modules", "layout"] },
      { op: "add", path: "/definitions/-", value: { id: "def-multi", entityKind: "vigil/watch", title: "Multi source", priority: 15, component: "list", requires: ["telemetry", "alerts"], dataRole: "modules" } },
    );
  it("[MC12] roles missing -> needs_data lists each unavailable view with its sorted missing roles; available keeps rank order", async () => {
    const env = await open(needsDataBundle());
    const reply = okJson(await env.call("open_entity", OPEN({ format: "json" })));
    expect(defs(reply.views.available)).toEqual(["def-modules", "def-layout", "builtin:metadata", "builtin:raw"]);
    expect(reply.views.needs_data.map((v: { viewDefinitionId: string; missing: string[] }) => [v.viewDefinitionId, v.missing])).toEqual([
      ["def-multi", ["alerts", "telemetry"]],
      ["def-delivery", ["delivery"]],
      ["def-source", ["source"]],
      ["def-shape", ["shape"]],
      ["def-example", ["example"]],
    ]);
    expect(reply.views.needs_data[0]).toMatchObject({ title: "Multi source" });
  });
  it("[MC12] text: needs_data lines name the definition and 'missing:' roles, separate from the available lines", async () => {
    const env = await open(needsDataBundle());
    const text = okText(await env.call("open_entity", OPEN()));
    expect(text.body.filter((l) => l.startsWith("available: ")).map((l) => l.split(" ")[1])).toEqual(["def-modules", "def-layout", "builtin:metadata", "builtin:raw"]);
    const needs = text.body.filter((l) => l.startsWith("needs_data: "));
    expect(needs).toHaveLength(5);
    expect(needs[0]).toContain("def-multi");
    expect(needs[0]).toContain("missing: alerts, telemetry");
    expect(needs[1]).toContain("def-delivery");
    expect(needs[1]).toContain("missing: delivery");
  });
  it("[MC12] an unsupported view instance is listed as unsupported with its reason, not as available", async () => {
    const bundle = patch(allBundle(), { op: "replace", path: "/views/3", value: unsupportedView(allBundle().views[3], "no source access", "read-source") });
    const env = await open(bundle);
    const reply = okJson(await env.call("open_entity", OPEN({ format: "json" })));
    expect(defs(reply.views.available)).toEqual(["def-modules", "def-layout", "def-delivery", "def-shape", "def-example", "builtin:metadata", "builtin:raw"]);
    expect(reply.views.unsupported).toEqual([expect.objectContaining({ viewDefinitionId: "def-source", reason: "no source access" })]);
  });

  // why: design 3 "They may request a preferred view, with a visible fallback if that view is unavailable"; red-contract 5 `selected`.
  // proves: CLAIM(MC12) preferred-view precedence and visible fallback.
  it("[MC12] preferredViewDefinitionId def-delivery wins over the first view, and the answer is that view's", async () => {
    const env = await open(allBundle());
    const reply = okJson(await env.call("open_entity", OPEN({ format: "json", preferredViewDefinitionId: "def-delivery" })));
    expect(reply.pane.viewDefinitionId).toBe("def-delivery");
    expect(reply.selected).toEqual({ viewDefinitionId: "def-delivery" });
    expect(reply.view).toMatchObject({ id: "delivery-path", component: "graph" });
    expect(reply.counts.unit).toBe("edges");
  });
  it("[MC12] a preferred view that needs data falls back to the first available view and says so (fallbackFrom)", async () => {
    const env = await open(needsDataBundle());
    const reply = okJson(await env.call("open_entity", OPEN({ format: "json", preferredViewDefinitionId: "def-delivery" })));
    expect(reply.pane.viewDefinitionId).toBe("def-modules");
    expect(reply.selected.viewDefinitionId).toBe("def-modules");
    expect(reply.selected.fallbackFrom.requested).toBe("def-delivery");
    expect(reply.selected.fallbackFrom.reason.length).toBeGreaterThan(0);
  });
  it("[MC12] an unknown preferred view also falls back visibly", async () => {
    const env = await open(allBundle());
    const reply = okJson(await env.call("open_entity", OPEN({ format: "json", preferredViewDefinitionId: "def-nope" })));
    expect(reply.pane.viewDefinitionId).toBe("def-modules");
    expect(reply.selected.fallbackFrom.requested).toBe("def-nope");
  });

  it("[MC3] open_entity replies stay within a 2048-byte budget in both formats", async () => {
    const env = await open(allBundle());
    for (const format of ["text", "json"] as const) {
      const outcome = await env.call("open_entity", OPEN({ format, maxBytes: 2048 }));
      expect(outcome.ok).toBe(true);
      assertBodyWithin(outcome.body, 2048, `open_entity ${format}`);
    }
  });
});

describe("[MC8] open_entity: unresolved targets are named, old snapshots stay", () => {
  // proves: CLAIM(MC8) a missing target produces a named unresolved result (never an empty or substituted pane).
  it("[MC8] an entity that does not exist -> UNRESOLVED_TARGET naming it", async () => {
    const env = await open(allBundle());
    const error = failure(await env.call("open_entity", { snapshotId: "snap-1", entity: { repository: "r", id: "ghost", kind: "vigil/watch" } }));
    expect(error.code).toBe("UNRESOLVED_TARGET");
    expect(error.message).toContain("ghost");
    expect(error.retryable).toBe(false);
  });
  it("[MC8] the same id with another kind is a different entity: UNRESOLVED_TARGET (positive control: the true kind opens)", async () => {
    const env = await open(allBundle());
    expect(failure(await env.call("open_entity", { snapshotId: "snap-1", entity: { repository: "r", id: "watch", kind: "code/module" } })).code).toBe("UNRESOLVED_TARGET");
    expect((await env.call("open_entity", OPEN())).ok).toBe(true);
  });
  it("[MC8] a snapshot that does not exist -> UNRESOLVED_TARGET naming the snapshot, never the newest one", async () => {
    const env = await open(allBundle());
    const error = failure(await env.call("open_entity", { snapshotId: "snap-9", entity: WATCH }));
    expect(error.code).toBe("UNRESOLVED_TARGET");
    expect(error.message).toContain("snap-9");
  });

  // why: design 4 "Opening an old link keeps that snapshot"; design 3 "Navigation never silently mixes snapshots".
  // Two snapshots hold the SAME view id with different row labels, so showing the newest is observable.
  // proves: CLAIM(MC8) an old snapshot id keeps that snapshot.
  const twoSnapshots = () =>
    bundleOf([
      listView({ snapshotId: "snap-1", rows: [row("mcp", { name: "old-name" }, { entity: moduleRef("mcp") })] }),
      listView({ snapshotId: "snap-2", rows: [row("mcp", { name: "new-name" }, { entity: moduleRef("mcp") })] }),
    ]);
  it("[MC8] opening at snap-1 shows old-name and pane.snapshotId snap-1; opening at snap-2 shows new-name (control)", async () => {
    const env = await open(twoSnapshots());
    const old = okJson(await env.call("open_entity", { snapshotId: "snap-1", entity: WATCH, format: "json" }));
    expect(old.pane.snapshotId).toBe("snap-1");
    expect(old.view.snapshotId).toBe("snap-1");
    expect(old.items.map((i: { cells: { name: string } }) => i.cells.name)).toEqual(["old-name"]);
    const fresh = okJson(await env.call("open_entity", { snapshotId: "snap-2", entity: WATCH, format: "json" }));
    expect(fresh.pane.snapshotId).toBe("snap-2");
    expect(fresh.items.map((i: { cells: { name: string } }) => i.cells.name)).toEqual(["new-name"]);
  });
  it("[MC8] text: the old snapshot's reply never mentions the newer label", async () => {
    const env = await open(twoSnapshots());
    const outcome = await env.call("open_entity", { snapshotId: "snap-1", entity: WATCH });
    const text = okText(outcome);
    expect(text.header.snapshot).toBe("snap-1");
    expect(outcome.body).toContain("old-name");
    expect(outcome.body).not.toContain("new-name");
  });
});

describe("[MC7] navigate: following an item to its entity", () => {
  // The 'modules' list row `mcp` has entity code/module:mcp (fixtures/components/list.json). The code/module kind has no
  // registered definitions in the fixture bundle, so its pane opens on the built-ins (red-contract 5).
  // proves: CLAIM(MC7) navigation opens the target entity in the SAME snapshot with a fresh pane state.
  it("[MC7] navigating row 'mcp' of the modules pane opens code/module:mcp at snap-1 on builtin:metadata, with both built-in views", async () => {
    const env = await open(allBundle());
    const reply = okJson(await env.call("navigate", { pane: pane("def-modules"), itemId: "mcp", format: "json" }), { schema: false });
    expect(reply.pane).toEqual({ entity: MCP, snapshotId: "snap-1", viewDefinitionId: "builtin:metadata", selection: [], filters: {}, pinned: false });
    expect(defs(reply.views.available)).toEqual(["builtin:metadata", "builtin:raw"]);
  });
  it("[MC7] navigation is stateless: the same pane and item give a byte-identical reply", async () => {
    const env = await open(allBundle());
    const args = { pane: pane("def-modules"), itemId: "mcp", format: "json" as const };
    const first = await env.call("navigate", args);
    const second = await env.call("navigate", args);
    expect(first.ok).toBe(true);
    expect(second.body).toBe(first.body);
  });
  it("[MC7] a row whose entity has registered views opens at its first applicable view, with the full reply of that view", async () => {
    // the row 'self' points back to the watch entity, which owns def-modules (the only definition here)
    const bundle = bundleOf([listView({ rows: [row("self", { name: "watch" }, { entity: WATCH })] })]);
    const env = await open(bundle);
    const reply = okJson(await env.call("navigate", { pane: pane("def-modules"), itemId: "self", format: "json" }));
    expect(reply.pane).toEqual({ entity: WATCH, snapshotId: "snap-1", viewDefinitionId: "def-modules", selection: [], filters: {}, pinned: false });
    expect(reply.view).toMatchObject({ id: "modules", snapshotId: "snap-1" });
    expect(defs(reply.views.available)).toEqual(["def-modules", "builtin:metadata", "builtin:raw"]);
  });

  // why: design 2 "An item without an entity or anchor shows that absence; clicking it must not invent a target";
  // red-contract 4 `select` with target none -> notice NO_TARGET and no pane. The operation returns an OK result (the
  // item exists; there is just nowhere to go) whose pane is null and whose notice carries the code.
  // proves: CLAIM(MC7) item without entity -> NO_TARGET notice, no new pane.
  const withPlain = () => bundleOf([listView({ rows: [row("plain", { name: "plain.rs" }), row("mcp", { name: "mcp.rs" }, { entity: moduleRef("mcp") })] })]);
  it("[MC7] an item without an entity -> ok result, pane null, notice NO_TARGET naming the item", async () => {
    const env = await open(withPlain());
    const outcome = await env.call("navigate", { pane: pane("def-modules"), itemId: "plain", format: "json" });
    expect(outcome.ok).toBe(true);
    const reply = okJson(outcome, { schema: false });
    expect(reply.pane).toBeNull();
    expect(reply.notice.code).toBe("NO_TARGET");
    expect(reply.notice.message).toContain("plain");
  });
  it("[MC7] text: the NO_TARGET notice is visible, and the sibling row with an entity does navigate (control)", async () => {
    const env = await open(withPlain());
    const text = await env.call("navigate", { pane: pane("def-modules"), itemId: "plain" });
    expect(text.ok).toBe(true);
    expect(text.body).toContain("NO_TARGET");
    expect(text.body).toContain("plain");
    const control = okJson(await env.call("navigate", { pane: pane("def-modules"), itemId: "mcp", format: "json" }), { schema: false });
    expect(control.pane.entity).toEqual(MCP);
  });
  it("[MC8] an item id that is not in the pane's view -> UNRESOLVED_TARGET naming the item", async () => {
    const env = await open(allBundle());
    const error = failure(await env.call("navigate", { pane: pane("def-modules"), itemId: "no-such-row" }));
    expect(error.code).toBe("UNRESOLVED_TARGET");
    expect(error.message).toContain("no-such-row");
  });
  it("[MC8] a row whose entity was never registered -> UNRESOLVED_TARGET naming the entity, not NO_TARGET", async () => {
    const bundle = bundleOf([listView({ rows: [row("dangling", { name: "ghost.rs" }, { entity: moduleRef("ghost") })] })]);
    const env = await open(bundle);
    const error = failure(await env.call("navigate", { pane: pane("def-modules"), itemId: "dangling" }));
    expect(error.code).toBe("UNRESOLVED_TARGET");
    expect(error.message).toContain("ghost");
  });

  // why: design 3/4 "Navigation never silently mixes snapshots": a pane at snap-1 follows its link within snap-1 even when
  // snap-2 also holds the target; and a target that exists only in snap-2 is unresolved, not silently opened there.
  // proves: CLAIM(MC8) old links never open the newest snapshot.
  const late = entityAt({ repository: "r", id: "late", kind: "code/module" }, "snap-2");
  const mixed = () =>
    bundleOf(
      [
        listView({ snapshotId: "snap-1", rows: [row("mcp", { name: "mcp.rs" }, { entity: moduleRef("mcp") }), row("next", { name: "late.rs" }, { entity: moduleRef("late") })] }),
        listView({ snapshotId: "snap-2", rows: [row("mcp", { name: "mcp.rs" }, { entity: moduleRef("mcp") })] }),
      ],
      { entities: [late] },
    );
  it("[MC8] from a snap-1 pane the target opens at snap-1 even though snap-2 also has it", async () => {
    const env = await open(mixed());
    const reply = okJson(await env.call("navigate", { pane: pane("def-modules", WATCH, "snap-1"), itemId: "mcp", format: "json" }), { schema: false });
    expect(reply.pane.snapshotId).toBe("snap-1");
    expect(reply.pane.entity).toEqual(MCP);
  });
  it("[MC8] a target registered only in snap-2 is UNRESOLVED_TARGET from a snap-1 pane, naming the entity and the snapshot", async () => {
    const env = await open(mixed());
    const error = failure(await env.call("navigate", { pane: pane("def-modules", WATCH, "snap-1"), itemId: "next" }));
    expect(error.code).toBe("UNRESOLVED_TARGET");
    expect(error.message).toContain("late");
    expect(error.message).toContain("snap-1");
    // control: from a snap-2 pane the same entity exists, so the lookup is by snapshot, not by name
    const entityHere = okJson(await env.call("open_entity", { snapshotId: "snap-2", entity: { repository: "r", id: "late", kind: "code/module" }, format: "json" }), { schema: false });
    expect(entityHere.pane.snapshotId).toBe("snap-2");
  });

  // proves: CLAIM(MC11) navigate argument errors carry code and pointer.
  it("[MC11] a pane without an entity -> INVALID_ARGUMENT at /pane/entity (REQUIRED)", async () => {
    const env = await open(allBundle());
    const { entity: _entity, ...incomplete } = pane("def-modules");
    expect(issuesOf(await env.call("navigate", { pane: incomplete, itemId: "mcp" }))).toEqual({ code: "INVALID_ARGUMENT", issues: [["/pane/entity", "REQUIRED"]] });
  });
  it("[MC11] an action outside the enum -> INVALID_ARGUMENT at /action (ENUM); positive control: open-entity", async () => {
    const env = await open(allBundle());
    expect(issuesOf(await env.call("navigate", { pane: pane("def-modules"), itemId: "mcp", action: "open-everything" }))).toEqual({ code: "INVALID_ARGUMENT", issues: [["/action", "ENUM"]] });
    expect((await env.call("navigate", { pane: pane("def-modules"), itemId: "mcp", action: "open-entity" })).ok).toBe(true);
  });
});
