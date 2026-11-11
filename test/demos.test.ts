// Cross-cutting suite for the two worked demos of design section 6 (vigil in Rust, residual-cli's TypeScript web
// package) and the composed notebook page. It lives in test/ because every test crosses layers on purpose: the
// committed fixtures (fixtures/demos/*.bundle.json) go through validation, session import, the bounded replies of
// executeOperation and the link / evidence / source resolvers. Expected values are literals derived by hand from
// the design tables, the inspected sources (file:line in fixtures/demos/README.md) and docs/red-contract.md;
// choices the design leaves open are in docs/contract-additions/demo.md (cited as A1..A10 below).
import { assert, describe, expect, it } from "vitest";
import { resolveClaimEvidence, resolveItemSource, resolveLink, type LinkResolution, type SourceOpening } from "../src/core/links.ts";
import { executeOperation } from "../src/core/operations.ts";
import { openSession, type Session, type ViewKey } from "../src/core/session.ts";
import { validateSubmission, type ValidationReport } from "../src/core/validate.ts";
import {
  DEMO_EXPECT, DEMO_VIEWS, RESIDUAL_SNAPSHOT, SIX_EMBEDDED, STORY_SNAPSHOT, STORY_VIEW_ID, VIGIL_SNAPSHOT,
  contextOfOtherEight, referenceContext, residualBundle, storyBundle, viewOf, vigilBundle, type AnyJson,
} from "./helpers/demo-fixtures.ts";
import { must, mustFail } from "./helpers/must.ts";
import { patch } from "./helpers/patch.ts";
import { useTempDirs } from "./helpers/tmp.ts";

const VIGIL_REV = "d064373a15139b969599ee05bc7b156b1d5b8ed7"; // design 6, "The inspected phoe-nix revision"
const STORY_KEY: ViewKey = { viewId: STORY_VIEW_ID, snapshotId: STORY_SNAPSHOT };
const DELIVERY_KEY: ViewKey = { viewId: "vigil-delivery-path", snapshotId: VIGIL_SNAPSHOT };
const GUARD_KEY: ViewKey = { viewId: "vigil-cancel-guard", snapshotId: VIGIL_SNAPSHOT };
const SHAPE_KEY: ViewKey = { viewId: "residual-selection-shape", snapshotId: RESIDUAL_SNAPSHOT };
const KEYUNION_KEY: ViewKey = { viewId: "residual-key-union", snapshotId: RESIDUAL_SNAPSHOT };

const tmp = useTempDirs();
async function freshSession(name: string): Promise<Session> {
  return must(await openSession(tmp(name)), "openSession");
}
/** Imports in the only order the story allows: vigil, residual, then the page that references them. */
async function sessionWithAll(name: string): Promise<Session> {
  const session = await freshSession(name);
  must(await session.importBundle(vigilBundle()), "import vigil bundle");
  must(await session.importBundle(residualBundle()), "import residual bundle");
  must(await session.importBundle(storyBundle()), "import story bundle");
  return session;
}
async function inspectText(session: Session, viewId: string, snapshotId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const outcome = await executeOperation(session, "inspect_view", { viewId, snapshotId, format: "text", ...extra });
  expect(outcome.ok, outcome.body).toBe(true);
  return outcome.body;
}
const headerLine = (body: string, prefix: string): string | undefined => body.split("\n").find((line) => line.startsWith(prefix));

function rejected(report: ValidationReport): Array<{ code: string; pointer: string }> {
  if (report.ok) assert.fail("the submission was accepted but must be rejected");
  return report.errors.map((issue) => ({ code: issue.code, pointer: issue.pointer }));
}
function resolvedLink(resolution: LinkResolution): Extract<LinkResolution, { status: "resolved" }> {
  if (resolution.status !== "resolved") assert.fail(`link unresolved: ${resolution.code} (missing ${resolution.missing}): ${resolution.message}`);
  return resolution;
}
function resolvedSource(opening: SourceOpening): Extract<SourceOpening, { status: "resolved" }> {
  if (opening.status !== "resolved") assert.fail(`source unresolved: ${opening.code}: ${opening.message}`);
  return opening;
}
/** Reads a stored link by id from a stored view and resolves exactly what it addresses. */
async function follow(session: Session, from: ViewKey, linkId: string): Promise<Extract<LinkResolution, { status: "resolved" }>> {
  const stored = must(await session.getView(from), `getView ${from.viewId}`);
  const link = stored.envelope.links.find((candidate) => candidate.id === linkId);
  if (!link) assert.fail(`view ${from.viewId} has no link ${linkId}`);
  return resolvedLink(await resolveLink(session, { snapshotId: link.snapshotId, viewId: link.viewId, ...(link.itemId === undefined ? {} : { itemId: link.itemId }) }));
}

const viewIdPointer = (index: number): string => `/views/0/data/blocks/${index}/viewId`;
const SIX_VIEW_BLOCK_INDEXES = [1, 2, 3, 5, 6, 7]; // v1 v2 v3 r1 r2 r3 in the design's block order (design 6, lines 551-562)
const ONLY = (issues: Array<{ code: string; pointer: string }>, pattern: RegExp) => issues.filter((issue) => pattern.test(issue.pointer));

// =================================================================================================
describe("[MC1][MC2] the committed demo bundles pass validation", () => {
  // why: a fixture that the core rejects makes every other demo test meaningless; this is the positive control for
  //      all negative cases below and for the real-code facts in docs (design 6 + red-contract section 11: every
  //      fixture meant to be valid must pass validateSubmission with ok:true).
  // proves: CLAIM(MC1)
  it("[MC1] the vigil bundle (4 views, incl. self-loop cycles in the lifecycle graph) is accepted", () => {
    const report = validateSubmission(vigilBundle());
    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(report.kind).toBe("bundle");
  });
  // proves: CLAIM(MC1)
  it("[MC1] the residual bundle (4 views: list, shape, example, source) is accepted", () => {
    const report = validateSubmission(residualBundle());
    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(report.kind).toBe("bundle");
  });
  // why: the page references views that live in the other two bundles; with the other eight views as context the
  //      references are resolvable, so the page must be accepted (design 6: "the six view IDs resolve to the instances").
  // proves: CLAIM(MC2)
  it("[MC2] the story bundle is accepted when a ReferenceContext lists the other eight views and their item ids", () => {
    const report = validateSubmission(storyBundle(), contextOfOtherEight());
    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(report.kind).toBe("bundle");
  });
});

describe("[MC2] semantic references across the demo documents", () => {
  // why: standalone validation of the page must fail by design (it imports after the other two): one DANGLING_REFERENCE
  //      per embedded viewId, at exactly that block's pointer (red-contract section 2: "the referring value"), and no
  //      other kind of fault (the page is otherwise valid).
  // proves: CLAIM(MC2)
  it("[MC2] the story bundle without a context fails with DANGLING_REFERENCE at the six embedded viewId pointers", () => {
    const blocks: AnyJson[] = storyBundle().views[0].data.blocks;
    const derived = blocks.flatMap((block, index) => (block.kind === "view" ? [index] : []));
    expect(derived).toEqual(SIX_VIEW_BLOCK_INDEXES); // the pointers come from the fixture, pinned against the design's order
    const issues = rejected(validateSubmission(storyBundle()));
    expect(ONLY(issues, /^\/views\/0\/data\/blocks\/\d+\/viewId$/)).toEqual(
      SIX_VIEW_BLOCK_INDEXES.map((index) => ({ code: "DANGLING_REFERENCE", pointer: viewIdPointer(index) })),
    );
    expect(new Set(issues.map((issue) => issue.code))).toEqual(new Set(["DANGLING_REFERENCE"]));
  });
  // why: A2 (docs/contract-additions/demo.md): an example block's exampleId names an example view and is checked like a
  //      viewId. Context minus the two example views leaves exactly four dangling block references; the same page with
  //      the full context is the positive control (previous describe).
  // proves: CLAIM(MC2)
  it("[MC2] (A2) with the two example views missing from the context, v3, r3, ex1 and ex2 dangle, in pointer order", () => {
    const withoutExamples = referenceContext([...vigilBundle().views, ...residualBundle().views].filter((view: AnyJson) => view.component !== "example"));
    const issues = ONLY(rejected(validateSubmission(storyBundle(), withoutExamples)), /^\/views\/0\/data\/blocks\//);
    expect(issues).toEqual([
      { code: "DANGLING_REFERENCE", pointer: "/views/0/data/blocks/10/exampleId" },
      { code: "DANGLING_REFERENCE", pointer: "/views/0/data/blocks/11/exampleId" },
      { code: "DANGLING_REFERENCE", pointer: "/views/0/data/blocks/3/viewId" },
      { code: "DANGLING_REFERENCE", pointer: "/views/0/data/blocks/7/viewId" },
    ]);
  });
  // why: one mistyped view id must give exactly one issue even with a full context (single fault, single issue).
  // proves: CLAIM(MC2)
  it("[MC2] a mistyped embedded viewId is the only issue when the rest of the page resolves", () => {
    const bad = patch(storyBundle(), { op: "replace", path: viewIdPointer(2), value: "vigil-delivery-pathx" });
    expect(rejected(validateSubmission(bad, contextOfOtherEight()))).toEqual([{ code: "DANGLING_REFERENCE", pointer: viewIdPointer(2) }]);
  });
  // why: design 6 says D1's supports are SOURCE ids ("sv"), not view ids; a claim that supports an unregistered source
  //      must be rejected at that array element (design 4: "supports ... reference source IDs or {viewId, itemId}").
  // proves: CLAIM(MC2)
  it("[MC2] a claim that supports a source id the envelope does not register dangles at supports/0", () => {
    const bad = patch(storyBundle(), { op: "replace", path: "/views/0/data/blocks/4/supports/0", value: "sx" });
    expect(rejected(validateSubmission(bad, contextOfOtherEight()))).toEqual([{ code: "DANGLING_REFERENCE", pointer: "/views/0/data/blocks/4/supports/0" }]);
  });
  // why: evidence ids must exist in the envelope's sources (design 2 "nonempty source IDs"; red-contract section 2).
  // proves: CLAIM(MC2)
  it("[MC2] an edge citing an unknown source id fails at that evidence element", () => {
    const bad = patch(vigilBundle(), { op: "replace", path: "/views/0/data/edges/2/evidence/0", value: "s-nope" });
    expect(rejected(validateSubmission(bad))).toEqual([{ code: "DANGLING_REFERENCE", pointer: "/views/0/data/edges/2/evidence/0" }]);
  });
  // why: edge endpoints must be nodes; chosen edge (e-forwards) is on no path, so a path check cannot add a second issue.
  // proves: CLAIM(MC2)
  it("[MC2] an edge whose target node does not exist fails at the edge's `to`", () => {
    const bad = patch(vigilBundle(), { op: "replace", path: "/views/1/data/edges/1/to", value: "n-ghost" });
    expect(rejected(validateSubmission(bad))).toEqual([{ code: "DANGLING_REFERENCE", pointer: "/views/1/data/edges/1/to" }]);
  });
  // why: design 2.3 paths must be contiguous. Replacing only the last edge of p-delivered by an edge that starts at n-return-none
  //      (previous edge ends at n-commit) breaks exactly that one step.
  // proves: CLAIM(MC2)
  it("[MC2] a path whose last edge does not start where the previous one ends fails at that edgeIds element", () => {
    const bad = patch(vigilBundle(), { op: "replace", path: "/views/1/data/paths/0/edgeIds/4", value: "e-none-cancelled" });
    expect(rejected(validateSubmission(bad))).toEqual([{ code: "PATH_DISCONTINUOUS", pointer: "/views/1/data/paths/0/edgeIds/4" }]);
  });
  // why: an annotation must lie inside the excerpt's anchor lines (155-185); [150,160] starts before the excerpt.
  // proves: CLAIM(MC2)
  it("[MC2] an annotation starting before the excerpt fails with ANNOTATION_OUTSIDE_EXCERPT", () => {
    const bad = patch(vigilBundle(), { op: "replace", path: "/views/3/data/annotations/0/lines", value: [150, 160] });
    expect(rejected(validateSubmission(bad))).toEqual([{ code: "ANNOTATION_OUTSIDE_EXCERPT", pointer: "/views/3/data/annotations/0/lines" }]);
  });
  // why: item ids share one namespace per view (red-contract section 2); the later occurrence carries the issue. Nodes precede edges.
  // proves: CLAIM(MC2)
  it("[MC2] an edge reusing a node id fails with DUPLICATE_ID at the later occurrence", () => {
    const bad = patch(vigilBundle(), { op: "replace", path: "/views/0/data/edges/0/id", value: "n-pending" });
    expect(rejected(validateSubmission(bad))).toEqual([{ code: "DUPLICATE_ID", pointer: "/views/0/data/edges/0/id" }]);
  });
  // why: list order.key and shape ref must name existing columns/fields (red-contract section 2, DANGLING_REFERENCE).
  // proves: CLAIM(MC2)
  it("[MC2] a list ordering by an unknown column and a shape ref to an unknown field each fail at the referring value", () => {
    const badOrder = patch(residualBundle(), { op: "replace", path: "/views/0/data/order/key", value: "colour" });
    expect(rejected(validateSubmission(badOrder))).toEqual([{ code: "DANGLING_REFERENCE", pointer: "/views/0/data/order/key" }]);
    const badRef = patch(residualBundle(), { op: "replace", path: "/views/1/data/fields/1/ref", value: "f-ghost" });
    expect(rejected(validateSubmission(badRef))).toEqual([{ code: "DANGLING_REFERENCE", pointer: "/views/1/data/fields/1/ref" }]);
  });
});

// =================================================================================================
describe("[MC20] import order across the three bundles", () => {
  const VIGIL_KEYS = ["vigil-cancel-guard@vigil-d064373", "vigil-delivery-path@vigil-d064373", "vigil-lifecycle@vigil-d064373", "vigil-one-write@vigil-d064373"];
  const RESIDUAL_KEYS = ["residual-key-union@residual-32c0836", "residual-selection-shape@residual-32c0836", "residual-selection-switch@residual-32c0836", "residual-view-entrypoints@residual-32c0836"];
  const keyOf = (key: ViewKey): string => `${key.viewId}@${key.snapshotId}`;

  // why: the intended order vigil, residual, story must work and report exact counts: 3+6+1 entities, 4+4+1 definitions,
  //      4+4+1 views (the design's six views plus the two source views its own navigation story needs, A9).
  // proves: CLAIM(MC20)
  it("[MC20] vigil, then residual, then story each import with their exact entity, definition and view counts", async () => {
    const session = await freshSession("order");
    const vigil = must(await session.importBundle(vigilBundle()), "import vigil");
    expect([vigil.entities, vigil.definitions, vigil.views.map(keyOf).sort()]).toEqual([3, 4, VIGIL_KEYS]);
    expect(Object.keys(vigil.contentHashes).sort()).toEqual(VIGIL_KEYS);
    const residual = must(await session.importBundle(residualBundle()), "import residual");
    expect([residual.entities, residual.definitions, residual.views.map(keyOf).sort()]).toEqual([6, 4, RESIDUAL_KEYS]);
    const story = must(await session.importBundle(storyBundle()), "import story");
    expect([story.entities, story.definitions, story.views.map(keyOf)]).toEqual([1, 1, ["story-context-change@story-1"]]);
    for (const hash of Object.values(story.contentHashes)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
  // why: the page imported first references views that do not exist yet: the import must fail atomically (design MC20:
  //      "assert that no partial registry/notebook update becomes visible"), with the dangling pointers named.
  // proves: CLAIM(MC20)
  it("[MC20] the story imported first fails with VALIDATION_FAILED and leaves no entity, definition or view visible", async () => {
    const session = await freshSession("atomic");
    const registryBefore = await session.listDefinitions();
    const failure = mustFail(await session.importBundle(storyBundle()), "story first");
    expect(failure.code).toBe("VALIDATION_FAILED");
    expect(failure.errors.filter((issue) => /\/viewId$/.test(issue.pointer)).map((issue) => issue.pointer)).toEqual(SIX_VIEW_BLOCK_INDEXES.map(viewIdPointer));
    expect(await session.listViews()).toEqual([]);
    expect(await session.listEntities()).toEqual([]);
    expect(await session.listDefinitions()).toEqual(registryBefore);
    expect(await session.exportBundle()).toEqual({ schemaVersion: "paneweft.bundle/1", entities: [], definitions: [], views: [] });
  });
  // why: the failed attempt must not poison the session: after the other two are imported the same page succeeds
  //      (positive control for the previous test; the failure was about order, not content).
  // proves: CLAIM(MC20)
  it("[MC20] after a failed story import, importing vigil and residual makes the same story import succeed", async () => {
    const session = await freshSession("retry");
    mustFail(await session.importBundle(storyBundle()), "story first");
    must(await session.importBundle(vigilBundle()), "import vigil");
    must(await session.importBundle(residualBundle()), "import residual");
    must(await session.importBundle(storyBundle()), "story after the others");
    expect((await session.listViews()).map(keyOf).sort()).toEqual([...RESIDUAL_KEYS, "story-context-change@story-1", ...VIGIL_KEYS].sort());
  });
  // why: design MC20 "restart and reopen a valid multi-view bundle"; exportBundle after all three holds 4+4+1 views,
  //      3+6+1 entities and 4+4+1 definitions, and the scenario entities of kind vigil/watch and residual/selection are
  //      registered while no *-result entity exists (runs are empty, so no result exists yet).
  // proves: CLAIM(MC20)
  it("[MC20] exportBundle after all three imports holds 9 views, 10 entities, 9 definitions, and no result entities", async () => {
    const session = await sessionWithAll("export");
    const exported = await session.exportBundle();
    expect(exported.views.map((view) => `${view.id}@${view.snapshotId}`).sort()).toEqual([...RESIDUAL_KEYS, "story-context-change@story-1", ...VIGIL_KEYS].sort());
    expect(exported.definitions.map((definition) => definition.id).sort()).toEqual([
      "def-context-story", "def-residual-key-union", "def-residual-selection-shape", "def-residual-selection-switch", "def-residual-view-entrypoints",
      "def-vigil-cancel-guard", "def-vigil-delivery-path", "def-vigil-lifecycle", "def-vigil-one-write",
    ]);
    expect(exported.entities.map((entity) => `${entity.repository}/${entity.id}:${entity.kind}`).sort()).toEqual([
      "paneweft/context-story:notes/page",
      "residual-web/landscape:residual/landscape",
      "residual-web/nkp-bundle:code/module",
      "residual-web/nkp-hypergraph:code/module",
      "residual-web/nkp-seriation:code/module",
      "residual-web/selection-switch:residual/selection",
      "residual-web/selection:residual/selection",
      "vigil/keepalive-delivery:vigil/delivery",
      "vigil/one-write:vigil/watch",
      "vigil/watch:vigil/watch",
    ]);
  });
  // why: stored views are the validated fixtures, unchanged (nothing dropped or rewritten on the way through storage),
  //      and survive closing and reopening the session directory.
  // proves: CLAIM(MC20)
  it("[MC20] every stored demo view equals its fixture, also after the session is closed and reopened", async () => {
    const directory = tmp("restart");
    const first = must(await openSession(directory), "open");
    must(await first.importBundle(vigilBundle()), "vigil");
    must(await first.importBundle(residualBundle()), "residual");
    must(await first.importBundle(storyBundle()), "story");
    await first.close();
    const reopened = must(await openSession(directory), "reopen");
    for (const demo of DEMO_VIEWS) {
      const stored = must(await reopened.getView({ viewId: demo.id, snapshotId: demo.snapshotId }), `getView ${demo.id}`);
      expect(stored.envelope, demo.id).toEqual(viewOf(demo));
    }
    expect((await reopened.exportBundle()).views).toHaveLength(9);
  });
});

// =================================================================================================
describe("[MC8] the navigation story: page -> delivery -> cancellation source -> example", () => {
  // why: design 6 / MC8: "from the story notebook, embedded views are references, not copies". embedDepth 1 inlines each
  //      embedded view's header line (red-contract section 3); the six views appear with their components.
  // proves: CLAIM(MC8)
  it("[MC8] inspect_view of the page with embedDepth 1 inlines the header of all six embedded views", async () => {
    const session = await sessionWithAll("embed1");
    const body = await inspectText(session, STORY_VIEW_ID, STORY_SNAPSHOT, { embedDepth: 1, maxBytes: 32768 });
    expect(body.split("\n")[0]).toBe("paneweft.reply/1 view=story-context-change component=notebook");
    for (const embedded of SIX_EMBEDDED) expect(body, embedded.viewId).toContain(`view=${embedded.viewId} component=${embedded.component}`);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(32768);
  });
  // why: negative control for the previous test: at embedDepth 0 the page names the six views (references) but does not
  //      inline their headers.
  // proves: CLAIM(MC8)
  it("[MC8] embedDepth 0 lists the six views as references only", async () => {
    const session = await sessionWithAll("embed0");
    const body = await inspectText(session, STORY_VIEW_ID, STORY_SNAPSHOT, { embedDepth: 0 });
    for (const embedded of SIX_EMBEDDED) {
      expect(body, embedded.viewId).toContain(embedded.viewId);
      expect(body, embedded.viewId).not.toContain(`view=${embedded.viewId} component=${embedded.component}`);
    }
  });
  // why: every embed link of the page resolves to the exact view and snapshot it addresses, and each embedded view's
  //      repository keeps its own snapshot (design 6: "retain each view's repository and revision").
  // proves: CLAIM(MC8)
  it("[MC8] the page's six embed links resolve to their view in its own repository snapshot", async () => {
    const session = await sessionWithAll("embed-links");
    for (const embedded of SIX_EMBEDDED) {
      const resolution = await follow(session, STORY_KEY, `l-${embedded.block}`);
      expect(resolution, embedded.block).toMatchObject({ snapshotId: embedded.snapshotId, viewId: embedded.viewId });
    }
  });
  // why: an old or mistyped link must produce a named unresolved result and never open another snapshot
  //      (design 3 and MC8: "an old link must not silently open the newest snapshot"). The positive control comes first.
  // proves: CLAIM(MC8)
  it("[MC8] a link to an unknown snapshot or an unknown item is unresolved, with the exact missing part named", async () => {
    const session = await sessionWithAll("unresolved");
    expect(resolvedLink(await resolveLink(session, { snapshotId: VIGIL_SNAPSHOT, viewId: "vigil-delivery-path", itemId: "n-commit" }))).toMatchObject({ viewId: "vigil-delivery-path", itemId: "n-commit" });
    expect(await resolveLink(session, { snapshotId: "vigil-d064374", viewId: "vigil-delivery-path" })).toMatchObject({ status: "unresolved", code: "UNRESOLVED_TARGET", missing: "snapshot" });
    expect(await resolveLink(session, { snapshotId: VIGIL_SNAPSHOT, viewId: "vigil-delivery-path", itemId: "n-ghost" })).toMatchObject({ status: "unresolved", code: "UNRESOLVED_TARGET", missing: "item" });
  });
  // why: design 6 "page -> vigil delivery -> cancellation source -> example": each hop is a link stored in the previous
  //      view, read from storage (not from the fixture) and resolved. The last hop ends at the scenario, because
  //      no result exists (runs are empty).
  // proves: CLAIM(MC8)
  it("[MC8] page -> vigil delivery path -> cancellation source annotation -> example scenario resolves hop by hop", async () => {
    const session = await sessionWithAll("path-vigil");
    const toDelivery = await follow(session, STORY_KEY, "l-v2");
    expect(toDelivery).toMatchObject({ snapshotId: VIGIL_SNAPSHOT, viewId: "vigil-delivery-path" });
    const toSource = await follow(session, DELIVERY_KEY, "l-cancel-recheck");
    expect(toSource).toMatchObject({ snapshotId: VIGIL_SNAPSHOT, viewId: "vigil-cancel-guard", itemId: "a-recheck" });
    const toExample = await follow(session, GUARD_KEY, "l-to-example");
    expect(toExample).toMatchObject({ snapshotId: VIGIL_SNAPSHOT, viewId: "vigil-one-write", itemId: "scenario-one-write", entity: { repository: "vigil", id: "one-write", kind: "vigil/watch" } });
  });
  // why: design 6 second route: page -> residual selection shape -> key variant (source) -> example. Same hop-by-hop proof.
  // proves: CLAIM(MC8)
  it("[MC8] page -> residual selection shape -> key variant declaration -> example scenario resolves hop by hop", async () => {
    const session = await sessionWithAll("path-residual");
    expect(await follow(session, STORY_KEY, "l-r2")).toMatchObject({ snapshotId: RESIDUAL_SNAPSHOT, viewId: "residual-selection-shape" });
    expect(await follow(session, SHAPE_KEY, "l-key-variant")).toMatchObject({ snapshotId: RESIDUAL_SNAPSHOT, viewId: "residual-key-union", itemId: "a-union" });
    expect(await follow(session, SHAPE_KEY, "l-to-example")).toMatchObject({ snapshotId: RESIDUAL_SNAPSHOT, viewId: "residual-selection-switch", itemId: "scenario-selection-switch", entity: { repository: "residual-web", id: "selection-switch", kind: "residual/selection" } });
  });
  // why: "the cancellation source" is a stored excerpt of the real src/mcp.rs lines; resolving its annotation must give
  //      repository, revision, path, the annotated range and the verbatim numbered lines 184 and 185 (read from the file).
  // proves: CLAIM(MC8)
  it("[MC8][MC6] the commit annotation opens src/mcp.rs:184-185 of revision d064373 with the verbatim stored lines", async () => {
    const session = await sessionWithAll("source-annotation");
    const opening = resolvedSource(await resolveItemSource(session, GUARD_KEY, "a-commit"));
    expect(opening).toMatchObject({ repository: "vigil", revision: VIGIL_REV, path: "src/mcp.rs", highlight: [184, 185] });
    expect(opening.stored).toMatchObject({ viewId: "vigil-cancel-guard", snapshotId: VIGIL_SNAPSHOT });
    expect(opening.stored.lines).toContainEqual({ n: 184, text: "    vigil.commit_delivery(delivery);" });
    expect(opening.stored.lines).toContainEqual({ n: 185, text: "    Ok(Some(envelope))" });
  });
  // why: A5: design 6 says "a cancellation edge opens source"; the edge's anchor (mcp.rs:184) is covered by the stored
  //      excerpt of another view, which is what must open. The lifecycle edge anchored in engine.rs has no stored excerpt:
  //      a named unresolved result (never a silent empty one). The commit edge comes first as the positive control.
  // proves: CLAIM(MC8)
  it("[MC8] (A5) a delivery-graph edge opens the covering stored excerpt; a lifecycle edge without one is unresolved", async () => {
    const session = await sessionWithAll("edge-source");
    const commit = resolvedSource(await resolveItemSource(session, DELIVERY_KEY, "e-recheck-commit"));
    expect(commit).toMatchObject({ path: "src/mcp.rs", highlight: [184, 184] });
    expect(commit.stored).toMatchObject({ viewId: "vigil-cancel-guard" });
    const none = resolvedSource(await resolveItemSource(session, DELIVERY_KEY, "e-recheck-none"));
    expect(none).toMatchObject({ highlight: [181, 183] });
    expect(await resolveItemSource(session, { viewId: "vigil-lifecycle", snapshotId: VIGIL_SNAPSHOT }, "e-cancel-expires")).toMatchObject({ status: "unresolved", code: "UNRESOLVED_TARGET" });
  });
  // why: residual's key variant is a stored excerpt of landscape-selection.ts:1-15; the annotation opens line 15, the EntityKey union.
  // proves: CLAIM(MC8)
  it("[MC8] the key-union annotation opens web/src/landscape-selection.ts:15 with the verbatim EntityKey declaration", async () => {
    const session = await sessionWithAll("source-key");
    const opening = resolvedSource(await resolveItemSource(session, KEYUNION_KEY, "a-union"));
    expect(opening).toMatchObject({ repository: "residual-web", path: "web/src/landscape-selection.ts", highlight: [15, 15] });
    expect(opening.stored.lines).toContainEqual({ n: 15, text: "export type EntityKey = `component:${string}` | `force:${string}` | `attractor:${string}`;" });
  });
  // why: claim D1 (supported, supports ["sv"]) -> its evidence is the vigil source file; D1 is also shown by two annotations
  //      of the cancellation excerpt, and those annotations cite D1 back (annotation claimIds). A4: the step's
  //      target for a source id has no fixed shape yet, so the test only requires that the step names "sv".
  // proves: CLAIM(MC8)
  it("[MC8] (A4) claim D1 resolves to one `supports` step naming source sv, and its two source links lead to annotations citing D1", async () => {
    const session = await sessionWithAll("claim-d1");
    const steps = await resolveClaimEvidence(session, STORY_KEY, "D1");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ relation: "supports", resolution: { status: "resolved" } });
    expect(JSON.stringify(steps[0])).toContain('"sv"');
    const guard = must(await session.getView(GUARD_KEY), "getView guard").envelope.data as AnyJson;
    for (const linkId of ["l-D1-recheck", "l-D1-commit"]) {
      const resolution = await follow(session, STORY_KEY, linkId);
      expect(resolution.viewId).toBe("vigil-cancel-guard");
      const annotation = (guard.annotations as AnyJson[]).find((candidate) => candidate.id === resolution.itemId);
      expect(annotation?.claimIds, linkId).toEqual(["D1"]);
    }
  });
  // why: D2 is supported by read test assertions (source sr) and links to the residual scenario that holds them.
  // proves: CLAIM(MC8)
  it("[MC8] claim D2 resolves to one `supports` step naming source sr and links to the selection-switch scenario", async () => {
    const session = await sessionWithAll("claim-d2");
    const steps = await resolveClaimEvidence(session, STORY_KEY, "D2");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ relation: "supports", resolution: { status: "resolved" } });
    expect(JSON.stringify(steps[0])).toContain('"sr"');
    expect(await follow(session, STORY_KEY, "l-D2-switch")).toMatchObject({ viewId: "residual-selection-switch", itemId: "scenario-selection-switch" });
  });
  // why: design 6: D3 is open, has no supporting observation, and "its evidence identifies the question's origin, not proof";
  //      the page links D3 to the two example blocks (A1) which point at the two not-run example views.
  // proves: CLAIM(MC8)
  it("[MC8] (A1) open claim D3 has no evidence steps, its evidence is the design note sd, and it links to ex1 and ex2", async () => {
    const session = await sessionWithAll("claim-d3");
    expect(await resolveClaimEvidence(session, STORY_KEY, "D3")).toEqual([]);
    const page = must(await session.getView(STORY_KEY), "getView story").envelope;
    const blocks = (page.data as AnyJson).blocks as AnyJson[];
    expect(blocks.find((block) => block.id === "D3")).toMatchObject({ kind: "claim", status: "open", supports: [], contradicts: [], evidence: ["sd"] });
    expect(page.sources.find((source) => source.id === "sd")).toMatchObject({ kind: "document", path: "docs/design.md" });
    expect(blocks.filter((block) => block.kind === "example").map((block) => [block.id, block.exampleId])).toEqual([["ex1", "vigil-one-write"], ["ex2", "residual-selection-switch"]]);
    const examined = page.links.filter((link) => link.relation === "open question examined by");
    expect(examined.map((link) => link.itemId)).toEqual(["ex1", "ex2"]);
    for (const link of examined) expect(await follow(session, STORY_KEY, link.id)).toMatchObject({ snapshotId: STORY_SNAPSHOT, viewId: STORY_VIEW_ID, itemId: link.itemId });
  });
  // why: "rows open the builder module entity": the three rows of the entry-point list name registered code/module
  //      entities, and an unregistered one is a named unresolved entity (positive control first).
  // proves: CLAIM(MC8)
  it("[MC8] the entry-point rows open their registered builder module entity; an unregistered module is unresolved", async () => {
    const session = await sessionWithAll("rows");
    const rows = (viewOf({ id: "residual-view-entrypoints" }).data.rows as AnyJson[]).map((row) => row.entity);
    expect(rows.map((entity) => entity.id)).toEqual(["nkp-bundle", "nkp-seriation", "nkp-hypergraph"]);
    for (const entity of rows) expect(resolvedLink(await resolveLink(session, { snapshotId: RESIDUAL_SNAPSHOT, entity })), entity.id).toMatchObject({ entity });
    expect(await resolveLink(session, { snapshotId: RESIDUAL_SNAPSHOT, entity: { repository: "residual-web", id: "nkp-nothing", kind: "code/module" } })).toMatchObject({ status: "unresolved", missing: "entity" });
  });
});

// =================================================================================================
describe("[MC4] completeness is visible for every demo view", () => {
  for (const demo of DEMO_VIEWS) {
    // why: the completeness line of each demo view is exactly the design table's statement: partial with named gaps for
    //      the vigil views, the story and both examples; complete with the narrow criterion for the residual list/shape and
    //      the two source views (design 6 tables; red-contract section 3 header format).
    // proves: CLAIM(MC4)
    it(`[MC4] ${demo.id}: the reply header states ${DEMO_EXPECT[demo.id]!.completeness.split(" (")[0]}`, async () => {
      const session = await sessionWithAll(`completeness-${demo.id}`);
      const body = await inspectText(session, demo.id, demo.snapshotId, { maxBytes: 32768 });
      expect(headerLine(body, "completeness:")).toBe(DEMO_EXPECT[demo.id]!.completeness);
      expect(body.split("\n").filter((line) => line.startsWith("completeness:"))).toHaveLength(1);
    });
  }
  for (const id of ["vigil-one-write", "residual-selection-switch"]) {
    // why: design 2.7 and 6: an empty `runs` array says "not run"; completeness is partial so the notice is the partial one,
    //      "never the former" (red-contract section 3). The two examples are the demos' not-run scenarios.
    // proves: CLAIM(MC4)
    it(`[MC4] ${id}: the text reply says "not run", shows zero runs and the partial-empty notice`, async () => {
      const session = await sessionWithAll(`notrun-${id}`);
      const demo = DEMO_VIEWS.find((view) => view.id === id)!;
      const body = await inspectText(session, id, demo.snapshotId);
      expect(body.toLowerCase()).toContain("not run");
      expect(body).toContain("no items returned; completeness is partial (see gaps)");
      expect(body).not.toContain("0 items within this scope");
      expect(headerLine(body, "counts:")).toBe("counts: unit=runs total=0 matched=0 returned=0 omitted=0 truncated=false");
    });
  }
  // why: JSON form carries the same facts as the text header (red-contract section 3: JSON form has the same fields):
  //      the gap count, the first gap id naming the missing observed run, zero runs and the notice.
  // proves: CLAIM(MC4)
  it("[MC4] vigil-one-write in JSON names the missing observed run as its first gap and returns no items", async () => {
    const session = await sessionWithAll("notrun-json");
    const outcome = await executeOperation(session, "inspect_view", { viewId: "vigil-one-write", snapshotId: VIGIL_SNAPSHOT, format: "json" });
    expect(outcome.ok, outcome.body).toBe(true);
    const reply = JSON.parse(outcome.body) as AnyJson;
    expect(reply).toMatchObject({
      schemaVersion: "paneweft.reply/1",
      view: { id: "vigil-one-write", component: "example", snapshotId: VIGIL_SNAPSHOT },
      completeness: { status: "partial", gapCount: 2 },
      counts: { unit: "runs", total: 0, matched: 0, returned: 0, omitted: 0, truncated: false },
      notice: "no items returned; completeness is partial (see gaps)",
      items: [],
      cursor: null,
    });
    expect(reply.completeness.gaps[0].id).toBe("observed-run-missing");
  });
  // why: design MC4 "remove the gap from a partial payload and expect rejection": an example that is not run cannot be
  //      submitted as partial without naming why. The un-patched fixture is the positive control (MC1 tests above).
  // proves: CLAIM(MC4)
  it("[MC4] a partial example with its gaps removed is rejected with SIZE at completeness/gaps", () => {
    const bad = patch(vigilBundle(), { op: "replace", path: "/views/2/completeness", value: { status: "partial", gaps: [] } });
    expect(rejected(validateSubmission(bad))).toEqual([{ code: "SIZE", pointer: "/views/2/completeness/gaps" }]);
  });
});

// =================================================================================================
describe("[MC5] provenance and evidence coverage are reported for every demo view", () => {
  for (const demo of DEMO_VIEWS) {
    const expected = DEMO_EXPECT[demo.id]!;
    // why: every fact of the demos was read from source and nothing executed (design 6: "I did not build, execute tests,
    //      start a viewer, or observe runtime traces"), so the whole-view provenance line is read=N with every other
    //      category 0, N counted by hand (A6); the evidence line lists exactly the registered sources the items cite.
    // proves: CLAIM(MC5)
    it(`[MC5] ${demo.id}: provenance read=${expected.items}, all other categories 0, evidence sources ${expected.sources.join(",")}`, async () => {
      const session = await sessionWithAll(`prov-${demo.id}`);
      const body = await inspectText(session, demo.id, demo.snapshotId, { maxBytes: 32768 });
      expect(headerLine(body, "provenance:")).toBe(`provenance: read=${expected.items} parsed=0 compiled=0 observed=0 inferred=0`);
      const evidence = headerLine(body, "evidence: sources=");
      expect(evidence?.slice("evidence: sources=".length).split(",").sort()).toEqual([...expected.sources].sort());
    });
  }
  // why: design MC5 "a filtered-empty view still reports its evidence coverage": a filter matching nothing changes the counts
  //      and the notice but not the whole-view provenance and evidence lines (red-contract section 3).
  // proves: CLAIM(MC5)
  it("[MC5] a filter that matches no lifecycle edge still reports read=14 and the three sources", async () => {
    const session = await sessionWithAll("prov-filtered-empty");
    const body = await inspectText(session, "vigil-lifecycle", VIGIL_SNAPSHOT, { filter: { text: "no edge says this" } });
    expect(headerLine(body, "provenance:")).toBe("provenance: read=14 parsed=0 compiled=0 observed=0 inferred=0");
    expect(headerLine(body, "evidence: sources=")?.slice("evidence: sources=".length).split(",").sort()).toEqual(["s-engine", "s-tick", "s-watch"]);
    expect(headerLine(body, "counts:")).toBe("counts: unit=edges total=10 matched=0 returned=0 omitted=0 truncated=false");
    expect(body).toContain("no items match the current filters (0 of 10)");
  });
});

// =================================================================================================
describe("[MC14] the demos fit the default reply budget", () => {
  // why: design 4 says the default reply is 8192 bytes; the demo views are far below the view limits, so each one must
  //      come back whole at the default budget: counts equal the hand-derived totals, nothing omitted or truncated, no cursor.
  // proves: CLAIM(MC14)
  it("[MC14] all nine demo views return every item within 8192 bytes", async () => {
    const session = await sessionWithAll("budget");
    for (const demo of DEMO_VIEWS) {
      const expected = DEMO_EXPECT[demo.id]!;
      const body = await inspectText(session, demo.id, demo.snapshotId);
      expect(Buffer.byteLength(body), demo.id).toBeLessThanOrEqual(8192);
      expect(headerLine(body, "counts:"), demo.id).toBe(`counts: unit=${expected.unit} total=${expected.total} matched=${expected.total} returned=${expected.total} omitted=0 truncated=false`);
      expect(body, demo.id).not.toContain("cursor:");
    }
  });
});
