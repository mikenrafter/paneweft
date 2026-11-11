// Session storage behaviour that does not involve failure injection (design 4 and 5; MC12, MC16, MC20):
// import / read-back / export, canonical content hashes, snapshot immutability, registry, putView.
// Failure injection, restart, tampering and concurrency live in session.atomic.test.ts.
// Every expected value is a literal or an independent oracle (test/helpers/store-canon.ts); nothing is
// derived by calling the code under test. Questions and decisions: docs/contract-additions/store.md.
import { describe, expect, it } from "vitest";
import type { Bundle, ViewDefinition } from "./wire.ts";
import { patch } from "../../test/helpers/patch.ts";
import { clone } from "../../test/helpers/fixtures.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { canonicalSha256, reverseKeys } from "../../test/helpers/store-canon.ts";
import { bundleFixture, importAll, inSnapshot, openOk, subBundle, SORTED_DEFINITION_IDS, SORTED_ENTITY_IDS, SORTED_VIEW_IDS } from "../../test/helpers/store-session.ts";
import { filesContaining, treeSnapshot } from "../../test/helpers/store-fs.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { join } from "node:path";

const tmp = useTempDirs();
const fresh = () => join(tmp("session"), "s");

/** sha256 of the canonical JSON of fixtures/components/all.bundle.json views[0] ("modules"); computed with python3 json.dumps(sort_keys=True, separators=(",",":")) + hashlib. */
const MODULES_HASH = "fcd78f82f6a57277c90595313c6ddd88eb482562fef040b56071e6701943469d";
/** Same view with scope.excludes = ["a","b"] and ["b","a"] (computed the same way). */
const EXCLUDES_AB_HASH = "6bf78ca383bf6e49f9dd070508d940f5a64e3a426052afa5e3ce5d8cc2747759";
const EXCLUDES_BA_HASH = "5001eaf8e2ebd8052a478fb8764569399aecf6d0199b0783b97fcab5664e7b67";

const EMPTY_BUNDLE: Bundle = { schemaVersion: "paneweft.bundle/1", entities: [], definitions: [], views: [] };
const withExcludes = (excludes: string[]): Bundle => {
  const bundle = subBundle(["modules"]);
  return patch(bundle, { op: "replace", path: "/views/0/scope/excludes", value: excludes });
};
const byId = <T extends { id: string }>(items: T[], ids: readonly string[]): T[] => ids.map((id) => items.find((item) => item.id === id) as T);

describe("Session: import, read back and export", () => {
  // why: bundle import registers entities, definitions and views together (design 4); the summary must
  //   count them and key each view's content hash by `${viewId}@${snapshotId}` in stable order.
  // proves: CLAIM(MC20)
  it("[MC20] importBundle(all.bundle) reports 3 entities, 7 definitions, 7 views and a hash per view", async () => {
    const session = await openOk(fresh());
    const summary = must(await session.importBundle(bundleFixture()));
    expect(summary.entities).toBe(3);
    expect(summary.definitions).toBe(7);
    expect(summary.views).toEqual(SORTED_VIEW_IDS.map((viewId) => ({ viewId, snapshotId: "snap-1" })));
    expect(Object.keys(summary.contentHashes).sort()).toEqual(SORTED_VIEW_IDS.map((id) => `${id}@snap-1`));
    for (const view of bundleFixture().views) {
      expect(summary.contentHashes[`${view.id}@snap-1`], view.id).toBe(canonicalSha256(view));
    }
  });

  // why: what goes in must come out: listViews returns exactly the imported keys, sorted by
  //   (viewId, snapshotId), independent of the order of the bundle (store.md#4).
  // proves: CLAIM(MC20)
  it("[MC20] listViews returns the 7 imported keys sorted by (viewId, snapshotId)", async () => {
    const session = await openOk(fresh());
    await importAll(session);
    expect(await session.listViews()).toEqual(SORTED_VIEW_IDS.map((viewId) => ({ viewId, snapshotId: "snap-1" })));
  });

  // why: the browser and the operations only consume validated, stored snapshots; each stored view must
  //   be exactly the submitted envelope and carry the independent canonical hash.
  // proves: CLAIM(MC20)
  it("[MC20] getView returns each imported envelope unchanged with the canonical content hash", async () => {
    const session = await openOk(fresh());
    await importAll(session);
    for (const view of bundleFixture().views) {
      const stored = must(await session.getView({ viewId: view.id, snapshotId: "snap-1" }), view.id);
      expect(stored.envelope, view.id).toEqual(view);
      expect(stored.contentHash, view.id).toBe(canonicalSha256(view));
    }
  });

  // why: the oracle in the test could share a bug with the implementation; one hash is pinned as a
  //   literal computed outside this repo's code (python hashlib over python's canonical JSON text).
  // proves: CLAIM(MC20)
  it("[MC20] the content hash of the modules view equals the hand-computed literal", async () => {
    const session = await openOk(fresh());
    await importAll(session);
    expect(must(await session.getView({ viewId: "modules", snapshotId: "snap-1" })).contentHash).toBe(MODULES_HASH);
  });

  // why: entities are registered by the bundle path (design 4) and must be readable by identity.
  // proves: CLAIM(MC20)
  it("[MC20] getEntity returns each imported entity unchanged", async () => {
    const session = await openOk(fresh());
    await importAll(session);
    for (const entity of bundleFixture().entities) {
      const stored = must(await session.getEntity({ repository: entity.repository, id: entity.id, kind: entity.kind }, "snap-1"), entity.id);
      expect(stored, entity.id).toEqual(entity);
    }
  });

  // why: listEntities is the registry of entities; sorted by (repository,id,kind,snapshotId) and
  //   filterable by snapshot, so a snapshot's entity set never leaks into another.
  // proves: CLAIM(MC20)
  it("[MC20] listEntities returns the 3 entities sorted, filters by snapshot, and is empty for an unknown snapshot", async () => {
    const session = await openOk(fresh());
    await importAll(session);
    const expected = byId(bundleFixture().entities, SORTED_ENTITY_IDS);
    expect(await session.listEntities()).toEqual(expected);
    expect(await session.listEntities("snap-1")).toEqual(expected);
    expect(await session.listEntities("snap-9")).toEqual([]);
  });

  // why: the registry is shared state with a revision; the import's definitions must be listed (sorted by
  //   id, fields exactly as submitted) at the revision the summary reports.
  // proves: CLAIM(MC20)
  it("[MC20] listDefinitions returns the 7 imported definitions sorted by id at the summary's revision", async () => {
    const session = await openOk(fresh());
    const summary = must(await session.importBundle(bundleFixture()));
    const listed = await session.listDefinitions();
    expect(listed.revision).toBe(summary.registryRevision);
    expect(listed.definitions).toEqual(byId(bundleFixture().definitions, SORTED_DEFINITION_IDS));
  });

  // why: export is the portable form (design 5: "JSON bundle export/import"). It must equal the imported
  //   content, in the deterministic order of store.md#4: entities by (repository,id,kind,snapshotId),
  //   definitions by id, views by (id,snapshotId). The fixture's own order (watch, mcp, notes) is NOT sorted.
  // proves: CLAIM(MC20)
  it("[MC20] exportBundle returns exactly the imported content in the documented deterministic order", async () => {
    const session = await openOk(fresh());
    await importAll(session);
    const source = bundleFixture();
    expect(await session.exportBundle()).toEqual<Bundle>({
      schemaVersion: "paneweft.bundle/1",
      entities: byId(source.entities, SORTED_ENTITY_IDS),
      definitions: byId(source.definitions, SORTED_DEFINITION_IDS),
      views: byId(source.views, SORTED_VIEW_IDS),
    });
  });

  // why: determinism: the same content submitted in reversed array order exports identically, so export
  //   order is a function of content, not of insertion history.
  // proves: CLAIM(MC20)
  it("[MC20] export is independent of the order of the arrays in the imported bundle", async () => {
    const forward = await openOk(fresh());
    await importAll(forward);
    const reversedBundle = bundleFixture();
    reversedBundle.entities.reverse();
    reversedBundle.definitions.reverse();
    reversedBundle.views.reverse();
    const backward = await openOk(fresh());
    must(await backward.importBundle(reversedBundle));
    const exported = await backward.exportBundle();
    expect(exported.views.map((view) => view.id)).toEqual([...SORTED_VIEW_IDS]);
    expect(exported).toEqual(await forward.exportBundle());
  });

  // why: a bundle can be exported and imported into another session and give the same registry (the
  //   transport form of MC20's "reopen a valid multi-view bundle").
  // proves: CLAIM(MC20)
  it("[MC20] an exported bundle imports into a fresh session and exports identically", async () => {
    const first = await openOk(fresh());
    await importAll(first);
    const exported = await first.exportBundle();
    const second = await openOk(fresh());
    must(await second.importBundle(clone(exported)));
    expect(await second.exportBundle()).toEqual(exported);
  });

  // why: lookups never fall back to something nearby: an unknown view, a known view at another snapshot, an
  //   unknown entity and an unknown snapshot are NOT_FOUND (MC8: "must not silently open the newest snapshot").
  // proves: CLAIM(MC20)
  it("[MC20] unknown view, wrong snapshot, unknown entity and unknown snapshot are NOT_FOUND", async () => {
    const session = await openOk(fresh());
    await importAll(session);
    expect(mustFail(await session.getView({ viewId: "nope", snapshotId: "snap-1" })).code).toBe("NOT_FOUND");
    expect(mustFail(await session.getView({ viewId: "modules", snapshotId: "snap-2" })).code).toBe("NOT_FOUND");
    expect(mustFail(await session.getEntity({ repository: "r", id: "ghost", kind: "code/module" }, "snap-1")).code).toBe("NOT_FOUND");
    expect(mustFail(await session.getEntity({ repository: "r", id: "mcp", kind: "code/module" }, "snap-2")).code).toBe("NOT_FOUND");
    expect(mustFail(await session.snapshotInfo("snap-2")).code).toBe("NOT_FOUND");
  });
});

describe("Session: canonical content hashes", () => {
  // why: "canonicalize object keys" (design 5): the same view with every object's keys in reverse order is
  //   the same content, so it has the same hash. Re-importing it into the same session is idempotent.
  // proves: CLAIM(MC20)
  it("[MC20] reordering object keys yields the SAME content hash (and re-import is idempotent)", async () => {
    const original = await openOk(fresh());
    await importAll(original);
    const reordered = await openOk(fresh());
    const summary = must(await reordered.importBundle(reverseKeys(subBundle(["modules"]))));
    expect(summary.contentHashes["modules@snap-1"]).toBe(MODULES_HASH);
    // same session: the reordered submission of identical content is not a conflict
    must(await original.importBundle(reverseKeys(subBundle(["modules"]))));
    expect(must(await original.getView({ viewId: "modules", snapshotId: "snap-1" })).contentHash).toBe(MODULES_HASH);
  });

  // why: "keep ordered arrays ordered" (design 5): reordering an array changes the content, hence the hash.
  //   Both hashes are literals from an external canonicaliser, so a hasher that sorts arrays fails.
  // proves: CLAIM(MC20)
  it("[MC20] reordering an array yields a DIFFERENT content hash (two hand-computed literals)", async () => {
    const ab = must(await (await openOk(fresh())).importBundle(withExcludes(["a", "b"])));
    const ba = must(await (await openOk(fresh())).importBundle(withExcludes(["b", "a"])));
    expect(ab.contentHashes["modules@snap-1"]).toBe(EXCLUDES_AB_HASH);
    expect(ba.contentHashes["modules@snap-1"]).toBe(EXCLUDES_BA_HASH);
  });

  // why: the array-order change is a real content change, so within one session it is a conflict (snapshot
  //   immutability), not an idempotent re-import.
  // proves: CLAIM(MC20)
  it("[MC20] the array-reordered view in the same snapshot is SNAPSHOT_CONFLICT, the original stays", async () => {
    const session = await openOk(fresh());
    must(await session.importBundle(withExcludes(["a", "b"])));
    const error = mustFail(await session.importBundle(withExcludes(["b", "a"])));
    expect(error.code).toBe("SNAPSHOT_CONFLICT");
    expect(must(await session.getView({ viewId: "modules", snapshotId: "snap-1" })).contentHash).toBe(EXCLUDES_AB_HASH);
  });
});

describe("Session: snapshot immutability and refresh", () => {
  // why: importing the same content twice is harmless (idempotent): nothing changes, no error, same hashes,
  //   and the registry revision does not move because nothing was registered anew (store.md#5).
  // proves: CLAIM(MC20)
  it("[MC20] idempotent re-import of identical content succeeds and changes nothing", async () => {
    const session = await openOk(fresh());
    const first = must(await session.importBundle(bundleFixture()));
    const exported = await session.exportBundle();
    const second = must(await session.importBundle(bundleFixture()));
    expect(second.contentHashes).toEqual(first.contentHashes);
    expect(second.registryRevision).toBe(first.registryRevision);
    expect(await session.exportBundle()).toEqual(exported);
  });

  // why: the same (viewId, snapshotId) with different content is SNAPSHOT_CONFLICT; the old content stays
  //   readable and byte-identical, and the other members of the failed bundle are not stored (atomic).
  // proves: CLAIM(MC20)
  it("[MC20] same (viewId, snapshotId) with different content is SNAPSHOT_CONFLICT; old content and registry intact", async () => {
    const session = await openOk(fresh());
    must(await session.importBundle(subBundle(["modules"])));
    const before = must(await session.getView({ viewId: "modules", snapshotId: "snap-1" }));
    const revision = (await session.listDefinitions()).revision;
    const conflicting = subBundle(["modules", "layout"]);
    conflicting.views[0] = patch(conflicting.views[0]!, { op: "replace", path: "/title", value: "Edited title" });
    const error = mustFail(await session.importBundle(conflicting));
    expect(error.code).toBe("SNAPSHOT_CONFLICT");
    expect(must(await session.getView({ viewId: "modules", snapshotId: "snap-1" }))).toEqual(before);
    expect(await session.listViews()).toEqual([{ viewId: "modules", snapshotId: "snap-1" }]); // layout not stored
    expect((await session.listDefinitions()).revision).toBe(revision);
  });

  // why: design 4: "An entity ID is unique within its repository and snapshot; contradictory replacement
  //   data requires a new snapshot". Same entity, same snapshot, new label -> conflict, old entity kept.
  // proves: CLAIM(MC20)
  it("[MC20] an entity re-submitted with different data in the same snapshot is SNAPSHOT_CONFLICT", async () => {
    const session = await openOk(fresh());
    await importAll(session);
    const changed = patch(subBundle(["modules"]), { op: "replace", path: "/entities/1/label", value: "renamed.rs" });
    expect(mustFail(await session.importBundle(changed)).code).toBe("SNAPSHOT_CONFLICT");
    const stored = must(await session.getEntity({ repository: "r", id: "mcp", kind: "code/module" }, "snap-1"));
    expect(stored.label).toBe("mcp.rs");
  });

  // why: refreshing creates a NEW snapshot that names its predecessor and never rewrites the old view
  //   (design 4). snap-1 files stay byte-identical; snap-2 records snap-1 as predecessor.
  // proves: CLAIM(MC20)
  it("[MC20] a new snapshot with predecessorSnapshotId records the predecessor and leaves snap-1 byte-identical", async () => {
    const dir = fresh();
    const session = await openOk(dir);
    await importAll(session);
    const marker = "What is in this set, and which members matter?"; // question text of the snap-1 modules view only
    const oldFiles = filesContaining(dir, marker);
    expect(oldFiles).toHaveLength(1);
    const treeBefore = treeSnapshot(dir);
    const oldView = must(await session.getView({ viewId: "modules", snapshotId: "snap-1" }));

    const refreshed = inSnapshot(subBundle(["modules", "layout"]), "snap-2");
    refreshed.views[0] = patch(refreshed.views[0]!, { op: "replace", path: "/title", value: "Modules (refreshed)" });
    must(await session.importBundle(refreshed, { predecessorSnapshotId: "snap-1" }));

    expect(must(await session.snapshotInfo("snap-2"))).toEqual({ snapshotId: "snap-2", predecessor: "snap-1", viewIds: ["layout", "modules"] });
    expect(must(await session.snapshotInfo("snap-1"))).toEqual({ snapshotId: "snap-1", predecessor: null, viewIds: [...SORTED_VIEW_IDS] });
    expect(must(await session.getView({ viewId: "modules", snapshotId: "snap-1" }))).toEqual(oldView);
    const after = treeSnapshot(dir);
    for (const path of oldFiles) {
      expect(after.find((entry) => entry.path === path), path).toEqual(treeBefore.find((entry) => entry.path === path));
    }
    expect((await session.listViews()).map((key) => `${key.viewId}@${key.snapshotId}`)).toEqual([
      "cancellation-notebook@snap-1", "check-source@snap-1", "delivery-path@snap-1", "layout@snap-1", "layout@snap-2",
      "modules@snap-1", "modules@snap-2", "vigil-one-write@snap-1", "watch-shape@snap-1",
    ]);
  });

  // why: entities of different snapshots coexist; listEntities(snapshot) must not mix them.
  // proves: CLAIM(MC20)
  it("[MC20] after a second snapshot, listEntities(snapshot) returns only that snapshot's entities", async () => {
    const session = await openOk(fresh());
    await importAll(session);
    must(await session.importBundle(inSnapshot(subBundle(["modules"]), "snap-2"), { predecessorSnapshotId: "snap-1" }));
    const two = await session.listEntities("snap-2");
    expect(two.map((entity) => `${entity.id}@${entity.snapshotId}`)).toEqual(["mcp@snap-2", "notes@snap-2", "watch@snap-2"]);
    expect((await session.listEntities()).map((entity) => `${entity.id}@${entity.snapshotId}`)).toEqual([
      "mcp@snap-1", "mcp@snap-2", "notes@snap-1", "notes@snap-2", "watch@snap-1", "watch@snap-2",
    ]);
  });
});

describe("Session.putView: a single envelope needs its entity and definition", () => {
  const viewFixture = () => clone(bundleFixture().views[0]!); // "modules": entity r/watch snap-1, definition def-modules
  const entityOnly = (): Bundle => ({ ...EMPTY_BUNDLE, entities: [clone(bundleFixture().entities[0]!)] });
  const definitionOnly = (): Bundle => ({ ...EMPTY_BUNDLE, definitions: [clone(bundleFixture().definitions[0]!)] });

  // why: design 4: "Single-envelope rendering requires its entity and definition to exist already".
  //   With neither registered there are two dangling references, at the two referring values.
  // proves: CLAIM(MC20)
  it("[MC20] DANGLING_REFERENCE at /entity and /viewDefinitionId when neither is registered; nothing stored", async () => {
    const session = await openOk(fresh());
    const error = mustFail(await session.putView(viewFixture()));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.errors.map((issue) => [issue.code, issue.pointer])).toEqual([
      ["DANGLING_REFERENCE", "/entity"], ["DANGLING_REFERENCE", "/viewDefinitionId"],
    ]);
    expect(await session.listViews()).toEqual([]);
  });

  // why: one reference at a time: entity present, definition missing -> exactly one issue.
  // proves: CLAIM(MC20)
  it("[MC20] only the definition missing -> a single DANGLING_REFERENCE at /viewDefinitionId", async () => {
    const session = await openOk(fresh());
    must(await session.importBundle(entityOnly()));
    const error = mustFail(await session.putView(viewFixture()));
    expect(error.errors.map((issue) => [issue.code, issue.pointer])).toEqual([["DANGLING_REFERENCE", "/viewDefinitionId"]]);
  });

  // why: the mirror case: definition present, entity missing -> exactly one issue at /entity.
  // proves: CLAIM(MC20)
  it("[MC20] only the entity missing -> a single DANGLING_REFERENCE at /entity", async () => {
    const session = await openOk(fresh());
    must(await session.importBundle(definitionOnly()));
    const error = mustFail(await session.putView(viewFixture()));
    expect(error.errors.map((issue) => [issue.code, issue.pointer])).toEqual([["DANGLING_REFERENCE", "/entity"]]);
  });

  // why: entity identity includes the snapshot (design 4). The entity exists at snap-1; a view in snap-2
  //   does not reference an existing entity.
  // proves: CLAIM(MC20)
  it("[MC20] the entity registered only at snap-1 does not satisfy a view in snap-2", async () => {
    const session = await openOk(fresh());
    must(await session.importBundle({ ...entityOnly(), definitions: [clone(bundleFixture().definitions[0]!)] }));
    const view = patch(viewFixture(), { op: "replace", path: "/snapshotId", value: "snap-2" });
    const error = mustFail(await session.putView(view));
    expect(error.errors.map((issue) => [issue.code, issue.pointer])).toEqual([["DANGLING_REFERENCE", "/entity"]]);
  });

  // why: positive control: with entity and definition registered the same envelope is stored and read back.
  // proves: CLAIM(MC20)
  it("[MC20] succeeds when entity and definition are registered; the view reads back unchanged", async () => {
    const session = await openOk(fresh());
    must(await session.importBundle({ ...entityOnly(), definitions: [clone(bundleFixture().definitions[0]!)] }));
    const summary = must(await session.putView(viewFixture()));
    expect(summary.views).toEqual([{ viewId: "modules", snapshotId: "snap-1" }]);
    expect(summary.contentHashes["modules@snap-1"]).toBe(MODULES_HASH);
    expect(must(await session.getView({ viewId: "modules", snapshotId: "snap-1" })).envelope).toEqual(viewFixture());
  });

  // why: putView validates the envelope itself too; an intra-document fault is VALIDATION_FAILED and
  //   nothing becomes visible.
  // proves: CLAIM(MC20)
  it("[MC20] a registered entity/definition does not excuse an invalid envelope (dangling source id)", async () => {
    const session = await openOk(fresh());
    must(await session.importBundle({ ...entityOnly(), definitions: [clone(bundleFixture().definitions[0]!)] }));
    const bad = patch(viewFixture(), { op: "replace", path: "/data/rows/0/evidence/0", value: "s-missing" });
    const error = mustFail(await session.putView(bad));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.errors.map((issue) => [issue.code, issue.pointer])).toEqual([["DANGLING_REFERENCE", "/data/rows/0/evidence/0"]]);
    expect(await session.listViews()).toEqual([]);
  });
});

describe("Session registry: registerView, revisions and persistence", () => {
  const definition = (overrides: Record<string, unknown> = {}): ViewDefinition =>
    ({ id: "def-extra", entityKind: "vigil/watch", title: "Extra", component: "list", requires: [], dataRole: "modules", ...overrides }) as ViewDefinition;

  // why: design 5 `register_view`: returns the new registry revision; a fresh registry is revision 0 and a
  //   registration increments by exactly 1 (red-contract 5). The definition is stored as submitted.
  // proves: CLAIM(MC12)
  it("[MC12] registerView at revision 0 returns revision 1 and the definition is listed as submitted", async () => {
    const session = await openOk(fresh());
    expect(must(await session.registerView(definition(), 0))).toEqual({ revision: 1 });
    expect(await session.listDefinitions()).toEqual({ revision: 1, definitions: [definition()] });
  });

  // why: every successful registration moves the revision by exactly 1, never by the number of fields.
  // proves: CLAIM(MC12)
  it("[MC12] a second registration moves the revision from 1 to 2 and lists both definitions sorted by id", async () => {
    const session = await openOk(fresh());
    must(await session.registerView(definition({ id: "def-b" }), 0));
    expect(must(await session.registerView(definition({ id: "def-a" }), 1))).toEqual({ revision: 2 });
    const listed = await session.listDefinitions();
    expect(listed.revision).toBe(2);
    expect(listed.definitions.map((entry) => entry.id)).toEqual(["def-a", "def-b"]);
  });

  // why: optimistic concurrency: a stale expected revision is CONFLICT with the current revision in
  //   details, retryable after a re-read, and the definition is NOT added.
  // proves: CLAIM(MC12)
  it("[MC12] a stale expectedRevision is a retryable CONFLICT with details.currentRevision; nothing is added", async () => {
    const session = await openOk(fresh());
    must(await session.registerView(definition({ id: "def-a" }), 0));
    const error = mustFail(await session.registerView(definition({ id: "def-b" }), 0));
    expect(error.code).toBe("CONFLICT");
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual({ currentRevision: 1 });
    expect((await session.listDefinitions()).definitions.map((entry) => entry.id)).toEqual(["def-a"]);
    expect(must(await session.registerView(definition({ id: "def-b" }), 1))).toEqual({ revision: 2 }); // retry after re-read
  });

  // why: an expected revision AHEAD of the registry is also a conflict (not accepted as "at least").
  // proves: CLAIM(MC12)
  it("[MC12] an expectedRevision greater than the current revision is CONFLICT too", async () => {
    const session = await openOk(fresh());
    const error = mustFail(await session.registerView(definition(), 5));
    expect(error.code).toBe("CONFLICT");
    expect(error.details).toEqual({ currentRevision: 0 });
  });

  // why: the registry persists across openSession (red-contract 5): reopen shows the same revision and
  //   definitions, and the revision keeps counting from there.
  // proves: CLAIM(MC12)
  it("[MC12] the registry (revision and definitions) persists across close and openSession", async () => {
    const dir = fresh();
    const first = await openOk(dir);
    must(await first.registerView(definition({ id: "def-a" }), 0));
    must(await first.registerView(definition({ id: "def-b", priority: 5 }), 1));
    await first.close();
    const second = await openOk(dir);
    expect(await second.listDefinitions()).toEqual({ revision: 2, definitions: [definition({ id: "def-a" }), definition({ id: "def-b", priority: 5 })] });
    expect(must(await second.registerView(definition({ id: "def-c" }), 2))).toEqual({ revision: 3 });
  });

  // why: a definition naming a deferred component (e.g. matrix) is rejected: the registry accepts the seven
  //   v0 components only (red-contract 5). The revision does not move.
  // proves: CLAIM(MC12)
  it("[MC12] a definition with a deferred component is VALIDATION_FAILED (UNKNOWN_COMPONENT at /component); revision unchanged", async () => {
    const session = await openOk(fresh());
    const error = mustFail(await session.registerView(definition({ component: "matrix" }), 0));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.errors.map((issue) => [issue.code, issue.pointer])).toEqual([["UNKNOWN_COMPONENT", "/component"]]);
    expect(await session.listDefinitions()).toEqual({ revision: 0, definitions: [] });
  });

  // why: forwarding aliases reject cycles (design 3); a self-forward is the minimal cycle. The revision does
  //   not move and the definition is not stored.
  // proves: CLAIM(MC12)
  it("[MC12] a self-forwarding definition is ALIAS_CYCLE at /forward; revision unchanged", async () => {
    const session = await openOk(fresh());
    const error = mustFail(await session.registerView(definition({ id: "loop", forward: { entityId: "watch", viewDefinitionId: "loop" } }), 0));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.errors.map((issue) => [issue.code, issue.pointer])).toEqual([["ALIAS_CYCLE", "/forward"]]);
    expect(await session.listDefinitions()).toEqual({ revision: 0, definitions: [] });
  });

  // why: a longer alias cycle (a -> b -> a) submitted in one bundle is rejected as a whole with ALIAS_CYCLE
  //   at the definitions' forward pointers (red-contract 2); nothing from the bundle becomes visible.
  // proves: CLAIM(MC12)
  it("[MC12] a bundle whose definitions form an alias cycle is rejected atomically", async () => {
    const session = await openOk(fresh());
    const cyclic: Bundle = {
      ...EMPTY_BUNDLE,
      definitions: [
        definition({ id: "a", forward: { entityId: "watch", viewDefinitionId: "b" } }),
        definition({ id: "b", forward: { entityId: "watch", viewDefinitionId: "a" } }),
      ],
    };
    const error = mustFail(await session.importBundle(cyclic));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect([...new Set(error.errors.map((issue) => issue.code))]).toEqual(["ALIAS_CYCLE"]);
    expect(error.errors.every((issue) => issue.pointer === "/definitions/0/forward" || issue.pointer === "/definitions/1/forward")).toBe(true);
    expect(await session.listDefinitions()).toEqual({ revision: 0, definitions: [] });
  });

  // why: control for the cycle rejections: a non-cyclic forward is fine.
  // proves: CLAIM(MC12)
  it("[MC12] a forwarding definition whose target is registered is accepted", async () => {
    const session = await openOk(fresh());
    must(await session.registerView(definition({ id: "target" }), 0));
    expect(must(await session.registerView(definition({ id: "alias", forward: { entityId: "watch", viewDefinitionId: "target" } }), 1))).toEqual({ revision: 2 });
  });

  // why: store.md#6: the registry stores a definition AS SUBMITTED. The default priority 50 is applied by
  //   rankViews, not written back; and an explicit 0 (falsy!) must survive. Catches `priority || 50`.
  // proves: CLAIM(MC12)
  it("[MC12] priority is stored as submitted: omitted stays omitted, explicit 0 and 50 are kept", async () => {
    const session = await openOk(fresh());
    must(await session.registerView(definition({ id: "omitted" }), 0));
    must(await session.registerView(definition({ id: "zero", priority: 0 }), 1));
    must(await session.registerView(definition({ id: "fifty", priority: 50 }), 2));
    const listed = (await session.listDefinitions()).definitions;
    expect(listed.find((entry) => entry.id === "omitted")).not.toHaveProperty("priority");
    expect(listed.find((entry) => entry.id === "zero")?.priority).toBe(0);
    expect(listed.find((entry) => entry.id === "fifty")?.priority).toBe(50);
  });

  // why: a malformed definition is a shape fault with the schema's pointer; the revision does not move.
  // proves: CLAIM(MC12)
  it("[MC12] a definition missing dataRole is REQUIRED at /dataRole; revision unchanged", async () => {
    const session = await openOk(fresh());
    const { dataRole: _dropped, ...incomplete } = definition();
    const error = mustFail(await session.registerView(incomplete, 0));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.errors.map((issue) => [issue.code, issue.pointer])).toEqual([["REQUIRED", "/dataRole"]]);
    expect((await session.listDefinitions()).revision).toBe(0);
  });
});

describe("Session repositories", () => {
  // why: registered repository roots are what anchors resolve against; they must come back sorted by id
  //   (store.md#7) and persist across reopen, otherwise a restart silently loses the allowlist.
  // proves: CLAIM(MC20)
  it("[MC20] registerRepository then repositories() lists them sorted by id, also after reopening", async () => {
    const dir = fresh();
    const session = await openOk(dir);
    const zeta = tmp("repo-zeta");
    const alpha = tmp("repo-alpha");
    must(await session.registerRepository({ id: "zeta", root: zeta }));
    must(await session.registerRepository({ id: "alpha", root: alpha }));
    const expected = [{ id: "alpha", root: alpha }, { id: "zeta", root: zeta }];
    expect(await session.repositories()).toEqual(expected);
    await session.close();
    expect(await (await openOk(dir)).repositories()).toEqual(expected);
  });
});
