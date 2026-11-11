// why: the discovery and argument-validation surface of the shared operation layer: list_components,
// describe_component, `validate` without a session, session-requiring operations, and the INVALID_ARGUMENT /
// UNKNOWN_OPERATION / SESSION_REQUIRED error model (red-contract 2: "INVALID_ARGUMENT (pointer into the tool
// arguments)"; design 5 operation table). Component questions are the "Question:" lines of design section 2; the
// capability filter cases are pinned with literals copied from the design's interaction paragraphs (the catalogue
// in src/core/catalogue.ts is the data the operation exposes, so only the filters pinned here are asserted).
import { describe, expect, it } from "vitest";
import { allBundle, componentFixture } from "../../test/helpers/fixtures.ts";
import { assertBodyWithin, callOperation, cursorOf, failure, issuesOf, okJson, useOps } from "../../test/helpers/ops-env.ts";
import { patch } from "../../test/helpers/patch.ts";

const open = useOps();

const QUESTIONS: Array<[id: string, question: string]> = [
  ["list", "What is in this set, and which members matter?"],
  ["tree", "How is this entity composed?"],
  ["graph", "What connects these entities, and by which relation?"],
  ["source", "Which exact code supports this statement?"],
  ["shape", "What does this value or boundary payload contain?"],
  ["notebook", "How do the evidence and views answer this investigation?"],
  ["example", "Can I rerun this scenario and inspect its tested result?"],
];

describe("[MC3] list_components", () => {
  // why: an agent chooses a component from this list; a missing id, a paraphrased question or an unstable order
  // misleads it. Order = catalogue order (design 2: "The order reflects likely usefulness").
  // proves: CLAIM(MC3) discovery replies carry exact counts and the design's questions; bodies stay within budget.
  it("[MC3] json: 7 components in design order with their literal questions; counts unit components total 7", async () => {
    const env = await open();
    const outcome = await env.call("list_components", { format: "json" });
    assertBodyWithin(outcome.body, 8192);
    const reply = okJson(outcome, { schema: false });
    expect(reply.items.map((i: { id: string }) => i.id)).toEqual(QUESTIONS.map(([id]) => id));
    expect(reply.items.map((i: { question: string }) => i.question)).toEqual(QUESTIONS.map(([, q]) => q));
    expect(reply.items.every((i: { capabilities: unknown }) => Array.isArray(i.capabilities) && i.capabilities.length > 0)).toBe(true);
    expect(reply.counts).toEqual({ unit: "components", total: 7, matched: 7, returned: 7, omitted: 0, truncated: false });
    expect(reply.cursor).toBeNull();
  });
  it("[MC3] text: one line per component naming the id and its question, and the count line", async () => {
    const env = await open();
    const outcome = await env.call("list_components", {});
    assertBodyWithin(outcome.body, 8192);
    const lines = outcome.body.split("\n");
    expect(lines).toContain("7/7 matched components returned; 0 omitted");
    for (const [id, question] of QUESTIONS) {
      expect(lines.some((l) => l.startsWith(id) && l.includes(question)), `${id} line`).toBe(true);
    }
  });
  it("[MC3] works without a session (a null session is allowed for discovery)", async () => {
    const outcome = await callOperation(null, "list_components", { format: "json" });
    expect(okJson(outcome, { schema: false }).counts.total).toBe(7);
  });

  // proves: CLAIM(MC3) capability filter. Literals: design 2.3 lists focus on a neighborhood only for graph; "open the
  // entity" appears for list, tree, graph, source, shape and notebook, while example's interactions are select runs /
  // inspect results / rerun (design 2.7), so `open-entity` selects six of the seven.
  it("[MC3] capability focus-neighborhood selects exactly graph; total, matched and returned describe that scope", async () => {
    const env = await open();
    const reply = okJson(await env.call("list_components", { capability: "focus-neighborhood", format: "json" }), { schema: false });
    expect(reply.items.map((i: { id: string }) => i.id)).toEqual(["graph"]);
    expect(reply.counts).toEqual({ unit: "components", total: 1, matched: 1, returned: 1, omitted: 0, truncated: false });
    expect(reply.filters).toEqual({ capability: "focus-neighborhood" });
  });
  it("[MC3] capability open-entity selects six components, not example", async () => {
    const env = await open();
    const reply = okJson(await env.call("list_components", { capability: "open-entity", format: "json" }), { schema: false });
    expect(reply.items.map((i: { id: string }) => i.id)).toEqual(["list", "tree", "graph", "source", "shape", "notebook"]);
    expect(reply.counts.total).toBe(6);
  });
  it("[MC3] an unknown capability gives zero items, total 0, a notice naming it, and no cursor", async () => {
    const env = await open();
    const outcome = await env.call("list_components", { capability: "no-such-capability", format: "json" });
    const reply = okJson(outcome, { schema: false });
    expect(reply.items).toEqual([]);
    expect(reply.counts).toEqual({ unit: "components", total: 0, matched: 0, returned: 0, omitted: 0, truncated: false });
    expect(reply.notice).toContain("no-such-capability");
    expect(cursorOf(outcome)).toBeNull();
  });
  it("[MC3] a garbage cursor is CURSOR_INVALID at /cursor", async () => {
    const env = await open();
    const garbage = failure(await env.call("list_components", { cursor: "not-a-cursor" }));
    expect(garbage.code).toBe("CURSOR_INVALID");
    expect(garbage.errors.map((issue) => issue.pointer)).toEqual(["/cursor"]);
  });
});

describe("[MC3] describe_component arguments", () => {
  it("[MC3] an unknown component id is INVALID_ARGUMENT with exactly (/component, ENUM)", async () => {
    // why: the schema's enum is the discovery contract; positive control = every v0 id is accepted (see operations.budget).
    const env = await open();
    expect(issuesOf(await env.call("describe_component", { component: "heatmap" }))).toEqual({ code: "INVALID_ARGUMENT", issues: [["/component", "ENUM"]] });
  });
  it("[MC3] a missing component is (/component, REQUIRED); a non-string one is (/component, ENUM)", async () => {
    const env = await open();
    expect(issuesOf(await env.call("describe_component", {}))).toEqual({ code: "INVALID_ARGUMENT", issues: [["/component", "REQUIRED"]] });
    expect(issuesOf(await env.call("describe_component", { component: 3 }))).toEqual({ code: "INVALID_ARGUMENT", issues: [["/component", "ENUM"]] });
  });
  it("[MC3] works without a session for a valid component", async () => {
    const outcome = await callOperation(null, "describe_component", { component: "list", format: "json", maxBytes: 32768 });
    expect(okJson(outcome, { schema: false }).component).toBe("list");
  });
});

describe("[MC1] validate without a session", () => {
  // why: `validate` is pure; an agent must be able to check a payload before any session exists (design 5 table).
  // Negative control beside the positive: the same fixture with one fault is VALIDATION_FAILED at the exact pointer.
  // proves: CLAIM(MC1) validate works with a null session and reports the exact issue.
  it("[MC1] accepts the valid list fixture and the valid all-components bundle", async () => {
    expect((await callOperation(null, "validate", { input: componentFixture("list") })).ok).toBe(true);
    expect((await callOperation(null, "validate", { input: allBundle() })).ok).toBe(true);
  });
  it("[MC1] rejects a graph with a string depth: VALIDATION_FAILED with exactly (/data/focus/depth, TYPE)", async () => {
    const bad = patch(componentFixture("graph"), { op: "add", path: "/data/focus", value: { node: "a", direction: "out", depth: "2" } });
    expect(issuesOf(await callOperation(null, "validate", { input: bad }))).toEqual({ code: "VALIDATION_FAILED", issues: [["/data/focus/depth", "TYPE"]] });
  });
});

describe("[MC11] SESSION_REQUIRED for session-bound operations", () => {
  // why: red-contract 2 lists SESSION_REQUIRED; list_components, describe_component and validate must work without
  // a session while the other ten must say so by code instead of crashing. The control: the SAME arguments with a real
  // session do not yield SESSION_REQUIRED.
  // proves: CLAIM(MC11) CLI and MCP share one error model for a missing session.
  const watch = { repository: "r", id: "watch", kind: "vigil/watch" };
  const SESSION_BOUND: Array<[string, Record<string, unknown>]> = [
    ["register_view", { definition: { id: "d1", entityKind: "vigil/watch", title: "t", component: "list", requires: [], dataRole: "modules" }, expectedRevision: 0 }],
    ["render", { input: componentFixture("list") }],
    ["open_entity", { snapshotId: "snap-1", entity: watch }],
    ["navigate", { pane: { entity: watch, snapshotId: "snap-1", viewDefinitionId: "def-modules", selection: [], filters: {}, pinned: false }, itemId: "mcp" }],
    ["inspect_view", { viewId: "modules", snapshotId: "snap-1" }],
    ["search", { query: "mcp" }],
    ["notebook_create", { input: componentFixture("notebook") }],
    ["notebook_get", { pageId: "cancellation-notebook" }],
    ["notebook_update", { pageId: "cancellation-notebook", expectedRevision: 1, blocks: [] }],
    ["example_record", { viewId: "vigil-one-write", snapshotId: "snap-1", output: {} }],
  ];
  it.each(SESSION_BOUND)("[MC11] %s with a null session -> SESSION_REQUIRED; with a session it is not", async (tool, args) => {
    const sessionless = failure(await callOperation(null, tool, args));
    expect(sessionless.code).toBe("SESSION_REQUIRED");
    const env = await open(allBundle());
    const withSession = await env.call(tool, args);
    expect(withSession.ok ? "ok" : withSession.error.code).not.toBe("SESSION_REQUIRED");
  });
  it("[MC11] the table covers all thirteen tools of design 5 together with the three session-free ones (the loop above is not vacuous)", () => {
    const all = [...SESSION_BOUND.map(([name]) => name), "list_components", "describe_component", "validate"].sort();
    expect(all).toEqual([
      "describe_component", "example_record", "inspect_view", "list_components", "navigate", "notebook_create", "notebook_get",
      "notebook_update", "open_entity", "register_view", "render", "search", "validate",
    ]);
  });
});

describe("[MC11] argument validation", () => {
  // why: red-contract 2 table: Ajv keywords map to issue codes and the pointer lands on the faulty value; the operation
  // code is INVALID_ARGUMENT and the issue list is the exact, sorted fault list (a single fault -> a single issue).
  // proves: CLAIM(MC11) invalid arguments are reported with code and pointer.
  const VALID = { viewId: "modules", snapshotId: "snap-1" };
  const faults: Array<[title: string, args: unknown, issues: Array<[string, string]>]> = [
    ["maxBytes as a string", { ...VALID, maxBytes: "8192" }, [["/maxBytes", "TYPE"]]],
    ["maxBytes not an integer", { ...VALID, maxBytes: 4096.5 }, [["/maxBytes", "TYPE"]]],
    ["format outside the enum", { ...VALID, format: "xml" }, [["/format", "ENUM"]]],
    ["a provenance label outside the enum", { ...VALID, filter: { provenance: ["read", "bogus"] } }, [["/filter/provenance/1", "ENUM"]]],
    ["the first provenance label wrong", { ...VALID, filter: { provenance: ["bogus"] } }, [["/filter/provenance/0", "ENUM"]]],
    ["an empty provenance list", { ...VALID, filter: { provenance: [] } }, [["/filter/provenance", "SIZE"]]],
    ["filter.text as a number", { ...VALID, filter: { text: 5 } }, [["/filter/text", "TYPE"]]],
    ["an unknown filter member", { ...VALID, filter: { colour: "red" } }, [["/filter/colour", "UNKNOWN_PROPERTY"]]],
    ["a missing viewId", { snapshotId: "snap-1" }, [["/viewId", "REQUIRED"]]],
    ["an extra argument", { ...VALID, limit: 5 }, [["/limit", "UNKNOWN_PROPERTY"]]],
    ["order without a direction", { ...VALID, order: { key: "name" } }, [["/order/direction", "REQUIRED"]]],
    ["order with a bad direction", { ...VALID, order: { key: "name", direction: "up" } }, [["/order/direction", "ENUM"]]],
    ["an empty cursor", { ...VALID, cursor: "" }, [["/cursor", "SIZE"]]],
    ["two faults at once are both reported, sorted by pointer", { snapshotId: "snap-1", maxBytes: "x" }, [["/maxBytes", "TYPE"], ["/viewId", "REQUIRED"]]],
  ];
  it.each(faults)("[MC11] inspect_view: %s -> INVALID_ARGUMENT with exactly the expected issue list", async (_title, args, issues) => {
    const env = await open(allBundle());
    expect(issuesOf(await env.call("inspect_view", args))).toEqual({ code: "INVALID_ARGUMENT", issues });
  });
  it("[MC11] every issue carries a non-empty constraint and repair hint", async () => {
    const env = await open(allBundle());
    const error = failure(await env.call("inspect_view", { ...VALID, format: "xml" }));
    expect(error.errors).toHaveLength(1);
    expect(error.errors[0]?.constraint.length).toBeGreaterThan(0);
    expect(error.errors[0]?.hint.length).toBeGreaterThan(0);
    expect(error.retryable).toBe(false);
  });
  it.each([null, [], "text", 7])("[MC11] arguments that are not an object (%j) -> INVALID_ARGUMENT with exactly (/ whole value, TYPE)", async (args) => {
    const env = await open();
    expect(issuesOf(await env.call("list_components", args))).toEqual({ code: "INVALID_ARGUMENT", issues: [["", "TYPE"]] });
  });
  it("[MC11] positive control: the VALID arguments are accepted", async () => {
    const env = await open(allBundle());
    expect((await env.call("inspect_view", VALID)).ok).toBe(true);
  });
  it("[MC11] an unknown tool is UNKNOWN_OPERATION and names the tool, with or without a session", async () => {
    const env = await open();
    for (const outcome of [await env.call("frobnicate", {}), await callOperation(null, "frobnicate", {})]) {
      const error = failure(outcome);
      expect(error.code).toBe("UNKNOWN_OPERATION");
      expect(error.message).toContain("frobnicate");
    }
  });
  it("[MC11] tool names are exact: a differently-cased or hyphenated name is UNKNOWN_OPERATION", async () => {
    const env = await open();
    expect(failure(await env.call("List_Components", {})).code).toBe("UNKNOWN_OPERATION");
    expect(failure(await env.call("list-components", {})).code).toBe("UNKNOWN_OPERATION");
    expect((await env.call("list_components", {})).ok).toBe(true);
  });
  it("[MC8] inspect_view of an unknown view or snapshot is UNRESOLVED_TARGET naming it (never an empty reply or the newest snapshot)", async () => {
    // docs/contract-additions/ops.md section 6: design 3 "Missing references return an unresolved-target explanation".
    const env = await open(allBundle());
    const noView = failure(await env.call("inspect_view", { viewId: "ghost-view", snapshotId: "snap-1" }));
    expect(noView.code).toBe("UNRESOLVED_TARGET");
    expect(noView.message).toContain("ghost-view");
    const noSnapshot = failure(await env.call("inspect_view", { viewId: "modules", snapshotId: "snap-9" }));
    expect(noSnapshot.code).toBe("UNRESOLVED_TARGET");
    expect(noSnapshot.message).toContain("snap-9");
  });
});
