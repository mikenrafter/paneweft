// Atomicity, durability and concurrency of the session store (design 5 "Atomic manifest replacement",
// MC16, MC20). Failures are injected through SessionOptions.testHooks; corruption is simulated by editing
// the session directory from outside. Expectations are literals or observe the directory independently.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Bundle } from "./wire.ts";
import type { SessionOptions } from "./session.ts";
import { patch } from "../../test/helpers/patch.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { bundleFixture, importAll, openOk, subBundle, SORTED_VIEW_IDS } from "../../test/helpers/store-session.ts";
import { directoriesIn, filesContaining, treeSnapshot } from "../../test/helpers/store-fs.ts";
import { canonicalSha256 } from "../../test/helpers/store-canon.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
const fresh = () => join(tmp("atomic"), "s");
const EMPTY: Bundle = { schemaVersion: "paneweft.bundle/1", entities: [], definitions: [], views: [] };
const MODULES_QUESTION = "What is in this set, and which members matter?"; // appears only in the modules view

/** An invalid bundle: the first view is fine, the second has a dangling edge endpoint (to: "nowhere"). */
function bundleWithBadSecondView(): Bundle {
  const bundle = subBundle(["modules", "delivery-path"]);
  return patch(bundle, { op: "replace", path: "/views/1/data/edges/0/to", value: "nowhere" });
}

describe("Session atomic import: an invalid member leaves nothing visible", () => {
  // why: MC20: "Fail a bundle containing one invalid member and assert that no partial registry/notebook
  //   update becomes visible". The first view is valid, the second has a dangling edge. Afterwards the
  //   views, entities, definitions, revision AND the directory tree (paths + file hashes) are exactly as
  //   before: no staged files, no half-written manifest.
  // proves: CLAIM(MC20)
  it("[MC20] a bundle with a dangling edge in its second view: VALIDATION_FAILED, nothing visible, directory tree identical", async () => {
    const dir = fresh();
    const session = await openOk(dir);
    must(await session.importBundle(subBundle(["layout"]))); // non-empty prior state
    const treeBefore = treeSnapshot(dir);
    const revisionBefore = (await session.listDefinitions()).revision;
    const entitiesBefore = await session.listEntities();

    const error = mustFail(await session.importBundle(bundleWithBadSecondView()));

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.errors.map((issue) => [issue.code, issue.pointer])).toEqual([["DANGLING_REFERENCE", "/views/1/data/edges/0/to"]]);
    expect(await session.listViews()).toEqual([{ viewId: "layout", snapshotId: "snap-1" }]);
    expect(await session.listEntities()).toEqual(entitiesBefore);
    expect((await session.listDefinitions()).revision).toBe(revisionBefore);
    expect(treeSnapshot(dir)).toEqual(treeBefore);
  });

  // why: same claim from an empty session, observed through the public surface: listViews()==[] and
  //   listEntities()==[] (the exact assertion MC20 names), and the revision is back to 0.
  // proves: CLAIM(MC20)
  it("[MC20] from an empty session the failed bundle leaves listViews, listEntities and the registry empty", async () => {
    const session = await openOk(fresh());
    expect(mustFail(await session.importBundle(bundleWithBadSecondView())).code).toBe("VALIDATION_FAILED");
    expect(await session.listViews()).toEqual([]);
    expect(await session.listEntities()).toEqual([]);
    expect(await session.listDefinitions()).toEqual({ revision: 0, definitions: [] });
    expect(await session.exportBundle()).toEqual(EMPTY);
  });

  // why: a SHAPE fault (unknown property) is rejected by the same atomic gate, so the gate is not specific
  //   to semantic checks. One fault -> one issue.
  // proves: CLAIM(MC20)
  it("[MC20] an unknown property inside the second view is UNKNOWN_PROPERTY and nothing is stored", async () => {
    const session = await openOk(fresh());
    const bad = patch(subBundle(["modules", "layout"]), { op: "add", path: "/views/1/surprise", value: 1 });
    const error = mustFail(await session.importBundle(bad));
    expect(error.errors.map((issue) => [issue.code, issue.pointer])).toEqual([["UNKNOWN_PROPERTY", "/views/1/surprise"]]);
    expect(await session.listViews()).toEqual([]);
  });
});

describe("Session atomic import: injected storage failures", () => {
  // why: CLAIM(atomic-manifest): a failure just before the manifest swap leaves the previous state fully
  //   readable. Nothing of the failed import is visible, not even through a brand-new handle, and a retry
  //   without the hook succeeds (the failure was not sticky).
  // proves: CLAIM(MC16) CLAIM(MC20)
  it("[MC20] beforeManifestSwap throwing: STORAGE_FAILED, nothing visible (also to a new handle), retry succeeds", async () => {
    const dir = fresh();
    let armed = true;
    const options: SessionOptions = { testHooks: { beforeManifestSwap: () => { if (armed) throw new Error("simulated disk full"); } } };
    const session = await openOk(dir, options);

    const error = mustFail(await session.importBundle(bundleFixture()));
    expect(error.code).toBe("STORAGE_FAILED");
    expect(await session.listViews()).toEqual([]);
    expect(await session.exportBundle()).toEqual(EMPTY);
    expect((await session.listDefinitions()).revision).toBe(0);
    const other = await openOk(dir);
    expect(await other.listViews()).toEqual([]);

    armed = false;
    const retry = must(await session.importBundle(bundleFixture()));
    expect(retry.views).toHaveLength(7);
    expect(await session.listViews()).toEqual(SORTED_VIEW_IDS.map((viewId) => ({ viewId, snapshotId: "snap-1" })));
  });

  // why: a failure while STAGING files (the 2nd file written) must not leave a half-imported session: the
  //   hook is observed to fire for writes 1 and 2 (so the injection is real), nothing is visible, and a
  //   reopened session imports cleanly.
  // proves: CLAIM(MC20)
  it("[MC20] afterWrite throwing on the 2nd write: STORAGE_FAILED, nothing visible, a reopened session imports cleanly", async () => {
    const dir = fresh();
    const counts: number[] = [];
    const options: SessionOptions = { testHooks: { afterWrite: ({ count }) => { counts.push(count); if (count === 2) throw new Error("simulated write failure"); } } };
    const session = await openOk(dir, options);

    expect(mustFail(await session.importBundle(bundleFixture())).code).toBe("STORAGE_FAILED");
    expect(counts).toEqual([1, 2]);
    expect(await session.listViews()).toEqual([]);
    expect(await session.listEntities()).toEqual([]);

    await session.close();
    const reopened = await openOk(dir);
    expect(await reopened.listViews()).toEqual([]);
    must(await reopened.importBundle(bundleFixture()));
    expect((await reopened.listViews()).length).toBe(7);
  });

  // why: the previous state survives a failed LATER import: view A stays byte-identical, view B never
  //   appears, and the registry revision is the one after A.
  // proves: CLAIM(MC20)
  it("[MC20] a failed second import leaves the first import intact and readable after reopen", async () => {
    const dir = fresh();
    let armed = false;
    const options: SessionOptions = { testHooks: { beforeManifestSwap: () => { if (armed) throw new Error("boom"); } } };
    const session = await openOk(dir, options);
    must(await session.importBundle(subBundle(["modules"])));
    const before = must(await session.getView({ viewId: "modules", snapshotId: "snap-1" }));
    const revision = (await session.listDefinitions()).revision;

    armed = true;
    expect(mustFail(await session.importBundle(subBundle(["modules", "layout"]))).code).toBe("STORAGE_FAILED");
    await session.close();

    const reopened = await openOk(dir);
    expect(await reopened.listViews()).toEqual([{ viewId: "modules", snapshotId: "snap-1" }]);
    expect(must(await reopened.getView({ viewId: "modules", snapshotId: "snap-1" }))).toEqual(before);
    expect((await reopened.listDefinitions()).revision).toBe(revision);
  });

  // why: registerView is a mutation too; a failed save must not advance the revision or list the definition.
  // proves: CLAIM(MC12)
  it("[MC12] registerView with a failing manifest swap: STORAGE_FAILED, revision and definitions unchanged", async () => {
    let armed = true;
    const session = await openOk(fresh(), { testHooks: { beforeManifestSwap: () => { if (armed) throw new Error("boom"); } } });
    const definition = { id: "d", entityKind: "vigil/watch", title: "D", component: "list", requires: [], dataRole: "modules" };
    expect(mustFail(await session.registerView(definition, 0)).code).toBe("STORAGE_FAILED");
    expect(await session.listDefinitions()).toEqual({ revision: 0, definitions: [] });
    armed = false;
    expect(must(await session.registerView(definition, 0))).toEqual({ revision: 1 });
  });
});

describe("Session restart", () => {
  // why: MC20: "Restart and reopen a valid multi-view bundle". After close + openSession everything the
  //   first handle served is served again, byte-for-byte equal, with the same hashes.
  // proves: CLAIM(MC20)
  it("[MC20] close and openSession again: views, entities, definitions, revision, hashes and export are identical", async () => {
    const dir = fresh();
    const first = await openOk(dir);
    const summary = must(await first.importBundle(bundleFixture()));
    const exported = await first.exportBundle();
    await first.close();

    const second = await openOk(dir);
    expect(await second.exportBundle()).toEqual(exported);
    expect(await second.listViews()).toEqual(SORTED_VIEW_IDS.map((viewId) => ({ viewId, snapshotId: "snap-1" })));
    expect((await second.listDefinitions()).revision).toBe(summary.registryRevision);
    for (const view of bundleFixture().views) {
      const stored = must(await second.getView({ viewId: view.id, snapshotId: "snap-1" }), view.id);
      expect(stored.envelope, view.id).toEqual(view);
      expect(stored.contentHash, view.id).toBe(canonicalSha256(view));
    }
    expect((await second.listEntities()).length).toBe(3);
  });

  // why: the snapshot lineage is part of the stored state; it must survive a restart.
  // proves: CLAIM(MC20)
  it("[MC20] snapshot predecessors survive a restart", async () => {
    const dir = fresh();
    const first = await openOk(dir);
    await importAll(first);
    const refreshed = bundleFixture();
    for (const entity of refreshed.entities) entity.snapshotId = "snap-2";
    refreshed.views = refreshed.views.slice(0, 1).map((view) => ({ ...view, snapshotId: "snap-2" }));
    must(await first.importBundle(refreshed, { predecessorSnapshotId: "snap-1" }));
    await first.close();
    const second = await openOk(dir);
    expect(must(await second.snapshotInfo("snap-2"))).toEqual({ snapshotId: "snap-2", predecessor: "snap-1", viewIds: ["modules"] });
  });
});

describe("Session storage corruption and foreign files", () => {
  async function importedDir(dir: string): Promise<void> {
    const session = await openOk(dir);
    await importAll(session);
    await session.close();
  }

  // why: "storage consumes only validated snapshots" (MC20). A stored view file edited on disk no longer
  //   matches its content hash; getView must say STORAGE_CORRUPT instead of serving it. The neighbouring
  //   untouched view is still served (positive control: corruption is detected per view).
  // proves: CLAIM(MC20)
  it("[MC20] a tampered stored view file: getView is STORAGE_CORRUPT, an untouched view still reads", async () => {
    const dir = fresh();
    await importedDir(dir);
    const files = filesContaining(dir, MODULES_QUESTION);
    expect(files).toHaveLength(1); // precondition: exactly one stored file holds the modules view
    const path = join(dir, files[0]!);
    writeFileSync(path, readFileSync(path, "utf8").replace("What is in this set", "What is IN this set"));

    const reopened = await openOk(dir);
    expect(mustFail(await reopened.getView({ viewId: "modules", snapshotId: "snap-1" })).code).toBe("STORAGE_CORRUPT");
    expect(must(await reopened.getView({ viewId: "layout", snapshotId: "snap-1" })).envelope.id).toBe("layout");
  });

  // why: a truncated/emptied file (crash during a naive overwrite) is corruption, not "view not found".
  // proves: CLAIM(MC20)
  it("[MC20] an emptied stored view file is STORAGE_CORRUPT, not NOT_FOUND", async () => {
    const dir = fresh();
    await importedDir(dir);
    const files = filesContaining(dir, MODULES_QUESTION);
    expect(files).toHaveLength(1);
    writeFileSync(join(dir, files[0]!), "");
    const reopened = await openOk(dir);
    expect(mustFail(await reopened.getView({ viewId: "modules", snapshotId: "snap-1" })).code).toBe("STORAGE_CORRUPT");
  });

  // why: only manifest-registered, validated snapshots are served (red-contract 8). A valid-looking view JSON
  //   planted in the session directory (root and every subdirectory) is never listed, read or exported.
  // proves: CLAIM(MC20)
  it("[MC20] an unmanifested JSON file planted in the session directory is never listed, read or exported", async () => {
    const dir = fresh();
    await importedDir(dir);
    const planted = { ...bundleFixture().views[0]!, id: "planted-view" };
    for (const sub of directoriesIn(dir)) {
      const target = join(dir, sub);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "planted-view.json"), JSON.stringify(planted));
    }
    const reopened = await openOk(dir);
    expect((await reopened.listViews()).map((key) => key.viewId)).toEqual([...SORTED_VIEW_IDS]);
    expect(mustFail(await reopened.getView({ viewId: "planted-view", snapshotId: "snap-1" })).code).toBe("NOT_FOUND");
    expect((await reopened.exportBundle()).views.map((view) => view.id)).toEqual([...SORTED_VIEW_IDS]);
  });
});

describe("Session concurrency: two handles on one directory", () => {
  // why: two processes (CLI + viewer) may import at once. No lost update: every successful import must be
  //   visible afterwards; a loser gets a retryable CONFLICT, never silent loss. We do not assume who wins.
  // proves: CLAIM(MC16) CLAIM(MC20)
  it("[MC20] two handles importing different bundles concurrently: every success is visible, failures are retryable CONFLICT, retry converges", async () => {
    const dir = fresh();
    const a = await openOk(dir);
    const b = await openOk(dir);
    const results = await Promise.all([a.importBundle(subBundle(["modules"])), b.importBundle(subBundle(["layout"]))]);
    const names = ["modules", "layout"];
    const succeeded = names.filter((_, index) => results[index]!.ok).sort();
    const failures = results.flatMap((result) => (result.ok ? [] : [result.error]));
    expect(failures.map((error) => error.code)).toEqual(failures.map(() => "CONFLICT"));
    expect(failures.map((error) => error.retryable)).toEqual(failures.map(() => true));

    const observer = await openOk(dir);
    expect((await observer.listViews()).map((key) => key.viewId)).toEqual(succeeded);

    // retry both on their own handles: the winner's retry is idempotent, the loser's lands now
    must(await a.importBundle(subBundle(["modules"])));
    must(await b.importBundle(subBundle(["layout"])));
    expect((await (await openOk(dir)).listViews()).map((key) => key.viewId)).toEqual(["layout", "modules"]);
    const exported = await (await openOk(dir)).exportBundle();
    expect(exported.views.map((view) => view.id)).toEqual(["layout", "modules"]);
    expect(exported.entities.map((entity) => entity.id)).toEqual(["mcp", "notes", "watch"]);
  });

  // why: more contention: four handles, four distinct views, all at once. The invariant is the same.
  // proves: CLAIM(MC20)
  it("[MC20] four handles importing four views at once: the final store contains exactly the successful ones, retries add the rest", async () => {
    const dir = fresh();
    const views = ["modules", "layout", "delivery-path", "watch-shape"];
    const handles = await Promise.all(views.map(() => openOk(dir)));
    const results = await Promise.all(handles.map((handle, index) => handle.importBundle(subBundle([views[index]!]))));
    const succeeded = views.filter((_, index) => results[index]!.ok).sort();
    const failures = results.flatMap((result) => (result.ok ? [] : [result.error]));
    expect(failures.map((error) => error.code)).toEqual(failures.map(() => "CONFLICT"));
    expect((await (await openOk(dir)).listViews()).map((key) => key.viewId)).toEqual(succeeded);

    for (const [index, handle] of handles.entries()) must(await handle.importBundle(subBundle([views[index]!]))); // winners idempotent, losers land
    expect((await (await openOk(dir)).listViews()).map((key) => key.viewId)).toEqual(["delivery-path", "layout", "modules", "watch-shape"]);
  });

  // why: handles are not caches: after another handle imports, a handle opened earlier sees the new state.
  // proves: CLAIM(MC20)
  it("[MC20] a handle opened before another handle's import sees the imported views", async () => {
    const dir = fresh();
    const early = await openOk(dir);
    const writer = await openOk(dir);
    must(await writer.importBundle(subBundle(["modules"])));
    expect(await early.listViews()).toEqual([{ viewId: "modules", snapshotId: "snap-1" }]);
  });
});
