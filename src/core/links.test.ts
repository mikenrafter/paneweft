// MC8 cross-view links: resolveLink, resolveItemSource, resolveClaimEvidence over a REAL Session (openSession in a temp dir +
// importBundle of committed fixtures). Normative: design section 3 ("Cross-view links address a snapshot, view instance, and
// optional item ... Missing references return an unresolved-target explanation ... Navigation never silently mixes snapshots"),
// section 7 MC8 and MC6, red-contract section 4 (UNRESOLVED_TARGET). Fixtures: components/all.bundle.json plus fixtures/nav/*.json.
//
// The exact resolution OBJECTS (which optional keys appear) are decisions of this suite, recorded in docs/contract-additions/nav.md:
//   * a resolved view link carries viewDefinitionId (the view's definition) and `entity` only when the item points at an entity
//     (for an example run: the run's result);
//   * a resolved entity link carries entity, viewDefinitionId, and viewId only when a stored instance of that definition exists
//     for that entity and snapshot; `fallback` only when a preferred view was requested and could not be used.
// itemSource `lines` are the stored excerpt lines of the ANCHOR RANGE only; `highlight` equals the anchor lines.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveClaimEvidence, resolveItemSource, resolveLink } from "./links.ts";
import { createSchemaRegistry } from "../schemas/index.ts";
import { sha256Hex } from "../../test/helpers/hash.ts";
import { must } from "../../test/helpers/must.ts";
import { patch } from "../../test/helpers/patch.ts";
import { readFixture, sessionWithoutItem, sessionWithoutSource, useSessions } from "../../test/helpers/nav-session.ts";

const ALL = { file: "components/all.bundle.json" };
const ROWS_1 = { file: "nav/rows.snap-1.json" };
const ROWS_2 = { file: "nav/rows.snap-2.json", predecessorSnapshotId: "snap-1" };
const EDGE_SOURCE = { file: "nav/edge-source.json" };
const CLAIMS_1 = { file: "nav/claim-result.snap-1.json" };
const CLAIMS_2 = { file: "nav/claim-result.snap-2.json", predecessorSnapshotId: "snap-1" };
const HELLO_SHA = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"; // sha256("hello\n"), fixtures/README.md
const REV = "0123456789abcdef0123456789abcdef01234567"; // gitRev in the fixtures' freshness block
const unresolved = (missing: "snapshot" | "view" | "item" | "entity", mention: string) => ({ status: "unresolved", code: "UNRESOLVED_TARGET", missing, message: expect.stringContaining(mention) });

describe("fixtures/nav are valid under raw Ajv (control for everything below)", () => {
  // why: every link test imports these fixtures through the real session; if one did not even satisfy the bundle schema, a red
  //      test could not be blamed on the implementation. Raw Ajv, independent of src/core. A negative control (one fault
  //      patched in) proves the check can fail. Green by design (data only).
  // proves: CLAIM(MC8)
  it("[MC8] every nav fixture validates as a paneweft.bundle/1, and a patched copy does not", () => {
    const validate = createSchemaRegistry().getSchema("urn:paneweft:schema:bundle:1")!;
    for (const file of ["rows.snap-1", "rows.snap-2", "edge-source", "claim-result.snap-1", "claim-result.snap-2", "partial-entity"]) {
      const bundle = readFixture(`nav/${file}.json`);
      expect(validate(bundle), `${file}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    const broken = patch(readFixture("nav/edge-source.json"), { op: "replace", path: "/views/0/data/layout", value: "force" });
    expect(validate(broken)).toBe(false);
  });
});

describe("resolveLink: view and item links", () => {
  const sessions = useSessions();

  // why: the basic exact resolution: snapshot + view + item resolve to a structured object naming the view's definition and the
  //      item's target entity (modules/mcp has entity code/module:mcp). toStrictEqual pins the exact key set.
  // proves: CLAIM(MC8)
  it("[MC8] a view+item link resolves to exactly that item, with its definition and entity", async () => {
    const session = await sessions.load(ALL);
    expect(await resolveLink(session, { snapshotId: "snap-1", viewId: "modules", itemId: "mcp" })).toStrictEqual({
      status: "resolved",
      snapshotId: "snap-1",
      viewId: "modules",
      itemId: "mcp",
      viewDefinitionId: "def-modules",
      entity: { repository: "r", id: "mcp", kind: "code/module" },
    });
  });

  // why: without an item the link addresses the view instance; an item with no entity (tree node c) resolves without inventing an
  //      entity (design section 2: "clicking it must not invent a target"). Both objects have exactly the listed keys.
  // proves: CLAIM(MC8)
  it("[MC8] a view link without an item, and an item without an entity, resolve without extra keys", async () => {
    const session = await sessions.load(ALL);
    expect(await resolveLink(session, { snapshotId: "snap-1", viewId: "layout" })).toStrictEqual({ status: "resolved", snapshotId: "snap-1", viewId: "layout", viewDefinitionId: "def-layout" });
    expect(await resolveLink(session, { snapshotId: "snap-1", viewId: "layout", itemId: "c" })).toStrictEqual({
      status: "resolved",
      snapshotId: "snap-1",
      viewId: "layout",
      itemId: "c",
      viewDefinitionId: "def-layout",
    });
  });

  // why: MC8 "an old link must not silently open the newest snapshot". rows exists in snap-1 (row-a, row-b) and the newer snap-2
  //      (row-a renamed, row-new; row-b removed). A link to snap-1/row-b stays on snap-1 although snap-2 is newer; the same item
  //      id in snap-2 is unresolved; row-new is unresolved in snap-1 and resolved in snap-2. Four rows = both directions.
  // proves: CLAIM(MC8)
  it.each([
    ["snap-1", "row-b", { status: "resolved", snapshotId: "snap-1", viewId: "rows", itemId: "row-b", viewDefinitionId: "def-rows" }],
    ["snap-2", "row-b", unresolved("item", "row-b")],
    ["snap-1", "row-new", unresolved("item", "row-new")],
    ["snap-2", "row-new", { status: "resolved", snapshotId: "snap-2", viewId: "rows", itemId: "row-new", viewDefinitionId: "def-rows" }],
  ] as const)("[MC8] with snap-1 and snap-2 stored, the link to %s/%s", async (snapshotId, itemId, expected) => {
    const session = await sessions.load(ROWS_1, ROWS_2);
    expect(await resolveLink(session, { snapshotId, viewId: "rows", itemId })).toStrictEqual(expected);
  });

  // why: precedence and naming of the missing parts: an unknown snapshot is reported as the SNAPSHOT (even if view and item are also
  //      unknown), an unknown view in a known snapshot as the VIEW, an unknown item as the ITEM; each message names the
  //      missing id, and each is the UNRESOLVED_TARGET code.
  // proves: CLAIM(MC8)
  it.each([
    ["unknown snapshot", { snapshotId: "snap-9", viewId: "rows", itemId: "row-a" }, unresolved("snapshot", "snap-9")],
    ["unknown snapshot beats unknown view and item", { snapshotId: "snap-9", viewId: "ghost-view", itemId: "ghost-item" }, unresolved("snapshot", "snap-9")],
    ["unknown view", { snapshotId: "snap-1", viewId: "ghost-view" }, unresolved("view", "ghost-view")],
    ["unknown view with an item", { snapshotId: "snap-1", viewId: "ghost-view", itemId: "row-a" }, unresolved("view", "ghost-view")],
    ["unknown item", { snapshotId: "snap-1", viewId: "rows", itemId: "row-ghost" }, unresolved("item", "row-ghost")],
  ] as const)("[MC8] %s is a named unresolved result", async (_name, target, expected) => {
    const session = await sessions.load(ROWS_1, ROWS_2);
    expect(await resolveLink(session, target)).toStrictEqual(expected);
  });

  // why: a view that exists ONLY in snap-1 (result-shape; snap-2 of the claim fixture has just one-write) is unresolved in snap-2: with the
  //      snapshot stored but the view absent, the link must not fall through to the snapshot that has it.
  // proves: CLAIM(MC8)
  it("[MC8] a view present only in snap-1 is unresolved in snap-2, not redirected", async () => {
    const session = await sessions.load(CLAIMS_1, CLAIMS_2);
    expect(await resolveLink(session, { snapshotId: "snap-1", viewId: "result-shape" })).toStrictEqual({ status: "resolved", snapshotId: "snap-1", viewId: "result-shape", viewDefinitionId: "def-result-shape" });
    expect(await resolveLink(session, { snapshotId: "snap-2", viewId: "result-shape" })).toStrictEqual(unresolved("view", "result-shape"));
  });
});

describe("resolveLink: entity links and the preferred view", () => {
  const sessions = useSessions();
  const watch = { repository: "r", id: "watch", kind: "vigil/watch" };

  // why: an entity link opens the entity at the requested snapshot with its first applicable view (def-modules, priority 10,
  //      stored instance `modules`); an explicit available preference wins even at worse priority (def-example, 60) and is NOT a
  //      fallback. toStrictEqual: no `fallback` key. Both with the stored instance's view id.
  // proves: CLAIM(MC8)
  it.each([
    ["no preference", undefined, "def-modules", "modules"],
    ["an available preference with worse priority", "def-example", "def-example", "vigil-one-write"],
  ] as const)("[MC8] entity link with %s", async (_name, preferred, definition, viewId) => {
    const session = await sessions.load(ALL);
    const target = preferred === undefined ? { snapshotId: "snap-1", entity: watch } : { snapshotId: "snap-1", entity: watch, preferredViewDefinitionId: preferred };
    expect(await resolveLink(session, target)).toStrictEqual({ status: "resolved", snapshotId: "snap-1", entity: watch, viewDefinitionId: definition, viewId });
  });

  // why: design section 3 "They may request a preferred view, with a visible fallback if that view is unavailable". `partial` holds only
  //      the `modules` role, so def-layout (needs `layout`) is unavailable: the link still resolves, to def-modules, with
  //      fallback {requested, used, reason} naming the missing role. There is no stored instance for `partial`, so no viewId.
  //      An id nobody registered also falls back, reason naming it.
  // proves: CLAIM(MC8)
  it.each([
    ["an unavailable preferred view (needs data)", "def-layout", "layout"],
    ["a preferred id nobody registered", "def-ghost", "def-ghost"],
  ] as const)("[MC8] %s resolves with a visible fallback", async (_name, preferred, mention) => {
    const session = await sessions.load(ALL, { file: "nav/partial-entity.json" });
    const entity = { repository: "r", id: "partial", kind: "vigil/watch" };
    const out = await resolveLink(session, { snapshotId: "snap-1", entity, preferredViewDefinitionId: preferred });
    expect(out).toMatchObject({ status: "resolved", snapshotId: "snap-1", entity, viewDefinitionId: "def-modules", fallback: { requested: preferred, used: "def-modules" } });
    expect(out.status === "resolved" ? out.fallback?.reason : undefined).toContain(mention);
    expect(out).not.toHaveProperty("viewId");
  });

  // why: an entity with only the built-in views (code/module) resolves to builtin:metadata, or to builtin:raw when asked; there is no
  //      stored instance so no viewId; asking for it is not a fallback.
  // proves: CLAIM(MC8)
  it.each([
    ["no preference", undefined, "builtin:metadata"],
    ["the raw built-in", "builtin:raw", "builtin:raw"],
  ] as const)("[MC8] an entity with only built-in views: %s", async (_name, preferred, expected) => {
    const session = await sessions.load(ALL);
    const entity = { repository: "r", id: "mcp", kind: "code/module" };
    const target = preferred === undefined ? { snapshotId: "snap-1", entity } : { snapshotId: "snap-1", entity, preferredViewDefinitionId: preferred };
    expect(await resolveLink(session, target)).toStrictEqual({ status: "resolved", snapshotId: "snap-1", entity, viewDefinitionId: expected });
  });

  // why: entity links are snapshot-exact too: ledger-new exists only in snap-2, so the link to snap-1 is unresolved (entity named), the
  //      link to snap-2 resolves; a totally unknown entity is unresolved; a link to a snapshot that does not exist names the snapshot.
  // proves: CLAIM(MC8)
  it("[MC8] an entity present only in the newer snapshot is unresolved in the older one", async () => {
    const session = await sessions.load(ROWS_1, ROWS_2);
    const ledgerNew = { repository: "r", id: "ledger-new", kind: "acct/ledger" };
    expect(await resolveLink(session, { snapshotId: "snap-1", entity: ledgerNew })).toStrictEqual(unresolved("entity", "ledger-new"));
    expect(await resolveLink(session, { snapshotId: "snap-2", entity: ledgerNew })).toStrictEqual({ status: "resolved", snapshotId: "snap-2", entity: ledgerNew, viewDefinitionId: "builtin:metadata" });
    expect(await resolveLink(session, { snapshotId: "snap-2", entity: { repository: "r", id: "nobody", kind: "acct/ledger" } })).toStrictEqual(unresolved("entity", "nobody"));
    expect(await resolveLink(session, { snapshotId: "snap-7", entity: ledgerNew })).toStrictEqual(unresolved("snapshot", "snap-7"));
  });

  // why: the same entity in two snapshots resolves to the instance of the REQUESTED snapshot, never the other: ledger has the stored view
  //      `rows` in both; both resolve to def-rows/rows with their own snapshotId echoed back.
  // proves: CLAIM(MC8)
  it("[MC8] an entity in two snapshots resolves in the requested one", async () => {
    const session = await sessions.load(ROWS_1, ROWS_2);
    const ledger = { repository: "r", id: "ledger", kind: "acct/ledger" };
    for (const snapshotId of ["snap-1", "snap-2"]) {
      expect(await resolveLink(session, { snapshotId, entity: ledger })).toStrictEqual({ status: "resolved", snapshotId, entity: ledger, viewDefinitionId: "def-rows", viewId: "rows" });
    }
  });
});

describe("resolveItemSource: follow a graph edge to its stored source", () => {
  const sessions = useSessions();
  const graph = { viewId: "flow-graph", snapshotId: "snap-1" };
  const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => ({ n: from + k, text: `line${from + k}` }));

  /** Creates a repository root holding src/check.ts with `content` (null = no file) and registers it as `r`. */
  async function registerRoot(session: Awaited<ReturnType<typeof sessions.load>>, content: string | null): Promise<string> {
    const root = sessions.tempDir("repo");
    if (content !== null) {
      mkdirSync(dirname(join(root, "src/check.ts")), { recursive: true });
      writeFileSync(join(root, "src/check.ts"), content);
    }
    must(await session.registerRepository({ id: "r", root }), "registerRepository");
    return root;
  }

  // why: MC8/MC6 headline: an edge with an anchor opens the stored excerpt's numbered lines for the edge's anchor range (lines 5-6 of the
  //      stored 4-8 excerpt: line5, line6), highlight = the anchor lines, repository + revision from the envelope, and currency
  //      `fresh` because the registered root's bytes ("hello\n") hash to the recorded sha256. Exact object.
  // proves: CLAIM(MC8)
  it("[MC8] an anchored edge resolves to the stored lines, highlight, repository, revision and fresh currency", async () => {
    const session = await sessions.load(EDGE_SOURCE);
    await registerRoot(session, "hello\n");
    expect(await resolveItemSource(session, graph, "e-main")).toStrictEqual({
      status: "resolved",
      repository: "r",
      revision: REV,
      path: "src/check.ts",
      highlight: [5, 6],
      origin: "stored-excerpt",
      stored: { viewId: "flow-source", snapshotId: "snap-1", lines: lines(5, 6) },
      currency: { state: "fresh", recordedSha256: HELLO_SHA, currentSha256: HELLO_SHA },
    });
  });

  // why: the stored excerpt covers lines 4-8; an anchor is covered iff both its ends lie inside. Boundary rows: first line only (4,4) and last
  //      line only (8,8) resolve; one line before the start (3,4) and one past the end (8,9) do not; an anchor in a file with no stored excerpt
  //      (src/other.ts) does not. Unresolved results name the item and never invent lines.
  // proves: CLAIM(MC8)
  it.each([
    ["e-first", [4, 4]],
    ["e-last", [8, 8]],
  ] as const)("[MC8] the anchor of %s is at the excerpt boundary and resolves", async (itemId, range) => {
    const session = await sessions.load(EDGE_SOURCE);
    await registerRoot(session, "hello\n");
    const out = await resolveItemSource(session, graph, itemId);
    expect(out).toMatchObject({ status: "resolved", highlight: [...range], stored: { lines: lines(range[0], range[1]) } });
  });

  // why: the refusing half of the boundary table above (same fixture, same registered root).
  // proves: CLAIM(MC8)
  it.each([
    ["e-before", "starts one line before the stored excerpt"],
    ["e-after", "ends one line after the stored excerpt"],
    ["e-elsewhere", "is in a file with no stored excerpt"],
  ] as const)("[MC8] %s %s: unresolved, named, no invented lines", async (itemId, _why) => {
    const session = await sessions.load(EDGE_SOURCE);
    await registerRoot(session, "hello\n");
    expect(await resolveItemSource(session, graph, itemId)).toStrictEqual({ status: "unresolved", code: "UNRESOLVED_TARGET", message: expect.stringContaining(itemId) });
  });

  // why: design section 2 "An item without an entity or anchor shows that absence; clicking it must not invent a target": an edge with no
  //      anchor is unresolved and the message says there is no anchor; an item id that does not exist, and a view that does not
  //      exist, are unresolved naming themselves.
  // proves: CLAIM(MC8)
  it("[MC8] an item with no anchor, an unknown item and an unknown view are named unresolved results", async () => {
    const session = await sessions.load(EDGE_SOURCE);
    await registerRoot(session, "hello\n");
    expect(await resolveItemSource(session, graph, "e-bare")).toStrictEqual({ status: "unresolved", code: "UNRESOLVED_TARGET", message: expect.stringMatching(/e-bare.*anchor|anchor.*e-bare/s) });
    expect(await resolveItemSource(session, graph, "e-ghost")).toStrictEqual({ status: "unresolved", code: "UNRESOLVED_TARGET", message: expect.stringContaining("e-ghost") });
    expect(await resolveItemSource(session, { viewId: "no-such-view", snapshotId: "snap-1" }, "e-main")).toStrictEqual({ status: "unresolved", code: "UNRESOLVED_TARGET", message: expect.stringContaining("no-such-view") });
    expect(await resolveItemSource(session, { viewId: "flow-graph", snapshotId: "snap-9" }, "e-main")).toStrictEqual({ status: "unresolved", code: "UNRESOLVED_TARGET", message: expect.stringContaining("snap-9") });
  });

  // why: design section 2.4 "If local bytes no longer match the recorded hash, click-through offers the stored excerpt and identifies the
  //      mismatch": modifying the file makes currency `stale` with the CURRENT hash, while the OLD stored lines are still
  //      returned, byte for byte the same as in the fresh case. A deleted file under an accessible root is stale with
  //      currentSha256 null (freshness.ts: "stale: differs or is gone").
  // proves: CLAIM(MC8)
  it("[MC8] a modified file is stale but the stored lines are still returned; a deleted file is stale with no current hash", async () => {
    const session = await sessions.load(EDGE_SOURCE);
    const root = await registerRoot(session, "hello\n");
    const fresh = await resolveItemSource(session, graph, "e-main");
    writeFileSync(join(root, "src/check.ts"), "hello world\n");
    const modified = await resolveItemSource(session, graph, "e-main");
    expect(modified).toStrictEqual({
      status: "resolved",
      repository: "r",
      revision: REV,
      path: "src/check.ts",
      highlight: [5, 6],
      origin: "stored-excerpt",
      stored: { viewId: "flow-source", snapshotId: "snap-1", lines: lines(5, 6) },
      currency: { state: "stale", recordedSha256: HELLO_SHA, currentSha256: sha256Hex("hello world\n") },
    });
    const storedOf = (opening: typeof fresh) => (opening.status === "resolved" ? opening.stored : "not resolved");
    expect(storedOf(modified), "same stored lines as when fresh").toStrictEqual(storedOf(fresh));
    sessions.removeDirectory(join(root, "src"));
    const deleted = await resolveItemSource(session, graph, "e-main");
    expect(deleted.status === "resolved" ? deleted.currency : null).toStrictEqual({ state: "stale", recordedSha256: HELLO_SHA, currentSha256: null });
  });

  // why: currency is `unknown` (not fresh, not stale) when the root cannot be consulted: no repository registered under that id, or the registered root
  //      directory has since vanished. The stored lines are still returned. recordedSha256 is still reported; currentSha256 is null.
  // proves: CLAIM(MC8)
  it("[MC8] an unregistered repository or a vanished root gives unknown currency with the stored lines intact", async () => {
    const unregistered = await sessions.load(EDGE_SOURCE);
    const expectedUnknown = {
      status: "resolved",
      repository: "r",
      revision: REV,
      path: "src/check.ts",
      highlight: [5, 6],
      origin: "stored-excerpt",
      stored: { viewId: "flow-source", snapshotId: "snap-1", lines: lines(5, 6) },
      currency: { state: "unknown", recordedSha256: HELLO_SHA, currentSha256: null },
    };
    expect(await resolveItemSource(unregistered, graph, "e-main")).toStrictEqual(expectedUnknown);
    const vanished = await sessions.load(EDGE_SOURCE);
    const root = await registerRoot(vanished, "hello\n");
    sessions.removeDirectory(root);
    expect(await resolveItemSource(vanished, graph, "e-main")).toStrictEqual(expectedUnknown);
  });

  // why: non-Git roots record gitRev null; the opening then reports revision null (never a made-up string). One-fault variant of the
  //      fixture built with patch(): both views' gitRev -> null.
  // proves: CLAIM(MC8)
  it("[MC8] a non-Git repository reports revision null", async () => {
    const session = await sessions.load({
      ...EDGE_SOURCE,
      transform: (bundle) =>
        patch(bundle, { op: "replace", path: "/views/0/freshness/repositories/0/gitRev", value: null }, { op: "replace", path: "/views/1/freshness/repositories/0/gitRev", value: null }),
    });
    await registerRoot(session, "hello\n");
    const out = await resolveItemSource(session, graph, "e-main");
    expect(out).toMatchObject({ status: "resolved", revision: null, currency: { state: "fresh" } });
  });

  // why: source views are items too: an annotation (a: lines 5-6, a-tail: line 8) and the excerpt item itself (x: lines 4-8) open their own
  //      range of the same stored excerpt, with the source view as the stored view. Highlight = the item's own lines.
  // proves: CLAIM(MC8)
  it.each([
    ["a", [5, 6]],
    ["a-tail", [8, 8]],
    ["x", [4, 8]],
  ] as const)("[MC8] source view item %s opens lines %j of its own excerpt", async (itemId, range) => {
    const session = await sessions.load(EDGE_SOURCE);
    await registerRoot(session, "hello\n");
    expect(await resolveItemSource(session, { viewId: "flow-source", snapshotId: "snap-1" }, itemId)).toStrictEqual({
      status: "resolved",
      repository: "r",
      revision: REV,
      path: "src/check.ts",
      highlight: [...range],
      origin: "stored-excerpt",
      stored: { viewId: "flow-source", snapshotId: "snap-1", lines: lines(range[0], range[1]) },
      currency: { state: "fresh", recordedSha256: HELLO_SHA, currentSha256: HELLO_SHA },
    });
  });
});

describe("resolveClaimEvidence: follow a notebook claim to an example result", () => {
  const sessions = useSessions();
  const result = { repository: "r", id: "result", kind: "json/value" };
  const story = { viewId: "story", snapshotId: "snap-1" };
  const expectedSteps = [
    {
      target: { snapshotId: "snap-1", viewId: "one-write", itemId: "run-1" },
      relation: "supports",
      resolution: { status: "resolved", snapshotId: "snap-1", viewId: "one-write", itemId: "run-1", viewDefinitionId: "def-probe-example", entity: result },
    },
    {
      target: { snapshotId: "snap-1", viewId: "result-shape", itemId: "f" },
      relation: "supports",
      resolution: { status: "resolved", snapshotId: "snap-1", viewId: "result-shape", itemId: "f", viewDefinitionId: "def-result-shape" },
    },
    {
      target: { snapshotId: "snap-1", viewId: "one-write", itemId: "run-2" },
      relation: "contradicts",
      resolution: { status: "resolved", snapshotId: "snap-1", viewId: "one-write", itemId: "run-2", viewDefinitionId: "def-probe-example" },
    },
  ];

  // why: MC8 "follow ... a notebook claim to an example result": claim C1 supports [one-write/run-1, result-shape/f] and contradicts
  //      [one-write/run-2]. Steps come back in DECLARED order (supports, then contradicts), each target in the claim's own snapshot, each resolving
  //      to the example view's item; run-1 (passed) resolves through its result EntityRef to the entity json/value:result, and run-2
  //      (failed, no result) resolves without an entity. Exact structure.
  // proves: CLAIM(MC8)
  it("[MC8] a claim's supports then contradicts resolve in declared order, run-1 through to the result entity", async () => {
    const session = await sessions.load(CLAIMS_1);
    expect(await resolveClaimEvidence(session, story, "C1")).toStrictEqual(expectedSteps);
  });

  // why: the entity named by the resolution must actually be REGISTERED (design section 4: generic example results are entities of kind
  //      json/value): fetching it from the session returns it with its label, so the link leads somewhere inspectable.
  // proves: CLAIM(MC8)
  it("[MC8] the result entity the claim resolves to is registered in the session", async () => {
    const session = await sessions.load(CLAIMS_1);
    const steps = await resolveClaimEvidence(session, story, "C1");
    const first = steps[0]?.resolution;
    const entity = first?.status === "resolved" && "entity" in first ? first.entity : undefined;
    expect(entity).toStrictEqual(result);
    const stored = must(await session.getEntity(result, "snap-1"), "getEntity");
    expect(stored).toMatchObject({ id: "result", kind: "json/value", snapshotId: "snap-1", label: "result", dataRoles: ["shape"] });
  });

  // why: navigation never mixes snapshots: with snap-2 stored (its one-write view has run-1 resulting in `result-2`), the snap-1 claim must
  //      still resolve to snap-1 and to entity `result`, not to `result-2`. Same exact steps as the snap-1-only case. (run-2 does not exist in
  //      snap-2, so a lookup in the newest snapshot would also fail on step three.)
  // proves: CLAIM(MC8)
  it("[MC8] with a newer snapshot stored, the claim still resolves inside its own snapshot", async () => {
    const session = await sessions.load(CLAIMS_1, CLAIMS_2);
    expect(await resolveClaimEvidence(session, story, "C1")).toStrictEqual(expectedSteps);
  });

  // why: S2. A claim target whose ITEM is gone is reported as a named unresolved step IN PLACE (the other steps still resolve, order
  //      preserved), never dropped and never redirected. Import is STRICT (next test), so this state is produced by the controlled
  //      resolver fixture: a real session whose stored view `one-write` reads back without run-2, as after a valid import whose
  //      target was removed later. The contradicts target (one-write/run-2) is the step that must become unresolved.
  // proves: CLAIM(MC8) CLAIM(S2-strict-import)
  it("[S2] a claim target removed after a valid import is an unresolved step in place; the others still resolve", async () => {
    const real = await sessions.load(CLAIMS_1);
    const session = sessionWithoutItem(real, { viewId: "one-write", snapshotId: "snap-1" }, "run-2");
    const steps = await resolveClaimEvidence(session, story, "C1");
    expect(steps).toStrictEqual([
      expectedSteps[0],
      expectedSteps[1],
      { target: { snapshotId: "snap-1", viewId: "one-write", itemId: "run-2" }, relation: "contradicts", resolution: unresolved("item", "run-2") },
    ]);
    // control: the real, unwrapped session resolves the same step (the fixture removes only what it names)
    expect(await resolveClaimEvidence(real, story, "C1")).toStrictEqual(expectedSteps);
  });

  // why: S2 removes the old contradiction (a test that needed import to ACCEPT a dangling item). The strict rule is pinned from the
  //      session side too: the one-fault bundle that the previous test used to import is refused by importBundle, with the
  //      DANGLING_REFERENCE at the claim entry, and nothing is stored.
  // proves: CLAIM(S2-strict-import) CLAIM(MC20)
  it("[S2] importing a claim whose {viewId,itemId} item does not exist is refused (VALIDATION_FAILED, DANGLING_REFERENCE), nothing stored", async () => {
    const session = await sessions.load();
    const bundle = patch(readFixture(CLAIMS_1.file), { op: "replace", path: "/views/2/data/blocks/1/contradicts/0/itemId", value: "run-ghost" });
    const result = await session.importBundle(bundle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
      expect(result.error.errors.map((issue) => [issue.code, issue.pointer])).toEqual([["DANGLING_REFERENCE", "/views/2/data/blocks/1/contradicts/0"]]);
    }
    expect(await session.listViews()).toEqual([]);
  });

  // why: S11. D1 in the demos cites a SOURCE id (`supports: ["sv"]`), which `LinkTarget` could not name; EvidenceStep gains a source target
  //      variant {snapshotId, viewId, sourceId} whose resolution shows the declared source itself. Mixed evidence keeps the claim's
  //      DECLARED order: here supports = [item run-1, source s1, item f], contradicts = [item run-2], so the source step is second -
  //      a grouping "items first, sources last" would put it third. The source is taken from the story view's declared `sources`.
  // proves: CLAIM(S11-source-evidence) CLAIM(MC8)
  it("[S11] a claim mixing item and source evidence resolves in declared order, the source step showing the declared source", async () => {
    const session = await sessions.load({ ...CLAIMS_1, transform: (bundle) => patch(bundle, { op: "add", path: "/views/2/data/blocks/1/supports/1", value: "s1" }) });
    const declared = readFixture(CLAIMS_1.file).views[2].sources[0];
    expect(declared.id).toBe("s1");
    expect(await resolveClaimEvidence(session, story, "C1")).toStrictEqual([
      expectedSteps[0],
      { target: { snapshotId: "snap-1", viewId: "story", sourceId: "s1" }, relation: "supports", resolution: { status: "resolved", sourceId: "s1", source: declared } },
      expectedSteps[1],
      expectedSteps[2],
    ]);
  });

  // why: S11 "visible resolution or an explicit unresolved explanation": a source that is no longer declared (removed after a valid
  //      import; import itself refuses such ids, validate.bundle.test) is an unresolved step IN PLACE naming the source, never dropped.
  // proves: CLAIM(S11-source-evidence) CLAIM(MC8)
  it("[S11] a source evidence target that is no longer declared is an unresolved step in place naming the source", async () => {
    const real = await sessions.load({ ...CLAIMS_1, transform: (bundle) => patch(bundle, { op: "add", path: "/views/2/data/blocks/1/supports/1", value: "s1" }) });
    const session = sessionWithoutSource(real, story, "s1");
    const steps = await resolveClaimEvidence(session, story, "C1");
    expect(steps).toHaveLength(4);
    expect(steps[1]).toStrictEqual({
      target: { snapshotId: "snap-1", viewId: "story", sourceId: "s1" },
      relation: "supports",
      resolution: { status: "unresolved", code: "UNRESOLVED_TARGET", missing: "source", message: expect.stringContaining("s1") },
    });
    expect([steps[0], steps[2], steps[3]]).toStrictEqual([expectedSteps[0], expectedSteps[1], expectedSteps[2]]);
  });
});
