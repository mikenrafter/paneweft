// why: tier-2 review T5. Every `open_entity` and `navigate` re-read EVERY stored object of the snapshot (open, hash-verify and parse each one) only to learn which views
//   belong to the entity, and read the manifest again for every step (snapshot info, entity, view list, each view, definitions, repositories). Two costs: the work grows with the
//   number of views in the session, and the steps of one operation could see different generations of the registry (a registration in between changes the answer halfway).
//   Now the manifest row of a view records its entity reference, title, definition id and the little the ranker needs of its completeness (migration: a row without them
//   is derived from the stored object, once per content hash), and a compound operation reads the manifest ONCE (`Session.snapshot()`) and passes that snapshot through
//   every step. Correct first: the answers are those of the old code (parity with a stripped manifest), then fast (counted at the file system).
// CLAIM(manifest-snapshot-read): a compound operation derives everything from one manifest read [this file; session.write-lock.test.ts for the single-read rule of readers].
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeOperation } from "./operations.ts";
import { openSession, type Session } from "./session.ts";
import { allBundle } from "../../test/helpers/fixtures.ts";
import { observeFilesystem } from "../../test/helpers/fs-spy.ts";
import { failure, okJson, useOps } from "../../test/helpers/ops-env.ts";
import { bundleOf, listView, type Json } from "../../test/helpers/ops-views.ts";
import { must } from "../../test/helpers/must.ts";

const open = useOps();
const WATCH = { repository: "r", kind: "vigil/watch", id: "watch" };
const OPEN = { snapshotId: "snap-1", entity: WATCH, format: "json" } as const;
const PANE = { entity: WATCH, snapshotId: "snap-1", viewDefinitionId: "def-modules", selection: [], filters: {}, pinned: false };

/** all.bundle.json plus `extra` more list views of the same entity (distinct ids and definitions), so reads that scale with the view count show. */
function bundleWithManyViews(extra: number): Json {
  const base = allBundle();
  const views = [...base.views];
  const definitions = [...base.definitions];
  for (let index = 0; index < extra; index++) {
    views.push(listView({ id: `extra-${index}`, definitionId: `def-extra-${index}`, title: `Extra ${index}` }));
    definitions.push({ id: `def-extra-${index}`, entityKind: "vigil/watch", title: `Extra ${index}`, priority: 60, component: "list", requires: [], dataRole: "modules" });
  }
  return { ...base, definitions, views };
}

/** Counts what `run` reads from the session directory: the manifest, and the stored objects. */
async function reads(dir: string, run: () => Promise<unknown>): Promise<{ manifest: number; objects: number }> {
  const observation = observeFilesystem();
  try {
    await run();
  } finally {
    observation.stop();
  }
  const readsOf = observation.touching(dir).filter((call) => /readFile|createReadStream|open$/.test(call.api));
  return {
    manifest: readsOf.filter((call) => call.path === join(dir, "manifest.json")).length,
    objects: readsOf.filter((call) => call.path.startsWith(join(dir, "objects"))).length,
  };
}

describe("[T5] the manifest row of a view carries what the lists need", () => {
  // why: the requirement itself: entity ref and title are recorded where the lists can read them without opening the object.
  it("[T5] after an import each manifest view row has entity, title, viewDefinitionId and completeness", async () => {
    const env = await open(allBundle());
    const manifest = JSON.parse(readFileSync(join(env.dir, "manifest.json"), "utf8"));
    const row = manifest.views.find((view: { viewId: string }) => view.viewId === "modules");
    expect(row).toMatchObject({ entity: WATCH, title: "Modules", viewDefinitionId: "def-modules", completeness: { status: "complete" } });
  });

  // why: the index lists views without touching a single object, in key order, with the fields the viewer's /api/index needs.
  it("[T5] listViewIndex reads no object and lists every view with component, title, definition, entity", async () => {
    const env = await open(bundleWithManyViews(5));
    const seen: Json[] = [];
    const counted = await reads(env.dir, async () => void seen.push(...(await env.session.listViewIndex())));
    expect(counted.objects).toBe(0);
    expect(seen).toHaveLength(12);
    expect(seen.find((entry) => entry.viewId === "modules")).toEqual({ viewId: "modules", snapshotId: "snap-1", component: "list", title: "Modules", viewDefinitionId: "def-modules", entity: WATCH, completeness: { status: "complete" } });
  });
});

describe("[T5] open_entity and navigate read the manifest once and do not scale with the number of views", () => {
  // why: the finding, measured. 12 views in the snapshot; open_entity shows ONE of them.
  it("[T5] open_entity: one manifest read, at most 2 object reads, with 12 views in the snapshot", async () => {
    const env = await open(bundleWithManyViews(5));
    const counted = await reads(env.dir, async () => okJson(await env.call("open_entity", OPEN)));
    expect(counted).toEqual({ manifest: 1, objects: expect.any(Number) });
    expect(counted.objects).toBeLessThanOrEqual(2);
  });
  it("[T5] navigate (open-entity): one manifest read, at most 3 object reads, with 12 views in the snapshot", async () => {
    const env = await open(bundleWithManyViews(5));
    const counted = await reads(env.dir, async () => okJson(await env.call("navigate", { pane: PANE, itemId: "mcp", format: "json" })));
    expect(counted.manifest).toBe(1);
    expect(counted.objects).toBeLessThanOrEqual(3);
  });
  // why: finding the covering source excerpt looked at every view; only source views can hold one.
  it("[T5] navigate (open-source) reads the pane's view and the source views only, not every view", async () => {
    const env = await open(bundleWithManyViews(5));
    const counted = await reads(env.dir, async () => void (await env.call("navigate", { pane: { ...PANE, viewDefinitionId: "def-delivery" }, itemId: "e1", action: "open-source", format: "json" })));
    expect(counted.manifest).toBe(1);
    expect(counted.objects).toBeLessThanOrEqual(3); // the graph view, the source view(s)
  });
});

describe("[T5] a compound operation sees one registry revision", () => {
  const READS = new Set(["snapshot", "snapshotInfo", "getEntity", "listViews", "listViewIndex", "getView", "listDefinitions", "repositories", "listEntities", "recordedRunOutputs", "notebookGet"]);
  /** `session`, except that right after its first read another handle registers a new applicable definition (registry revision + 1). */
  async function racing(session: Session, dir: string): Promise<{ proxy: Session; fired: () => boolean }> {
    const other = must(await openSession(dir));
    let fired = false;
    const proxy = new Proxy(session, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof property !== "string" || !READS.has(property) || typeof value !== "function") return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          if (!fired) {
            fired = true;
            // one for the entity open_entity shows and one for the code/module the navigate target opens
            for (const [id, entityKind] of [["def-late", "vigil/watch"], ["def-late-module", "code/module"]] as const) {
              const { revision } = await other.listDefinitions();
              must(await other.registerView({ id, entityKind, title: "Late", priority: 5, component: "list", requires: [], dataRole: "modules" }, revision));
            }
          }
          return result;
        };
      },
    });
    return { proxy, fired: () => fired };
  }
  const definitionIds = (reply: Json): string[] => [...reply.views.available, ...reply.views.needs_data, ...reply.views.unsupported].map((view: { viewDefinitionId: string }) => view.viewDefinitionId);

  // why: the view list of an entity is ranked from the registry; a registration between "which entity" and "which definitions" would put a definition in the answer
  //   that the first read did not have (or rank by a mixture). With one snapshot the answer is that of the registry revision of the first read, whatever happens next.
  it("[T5] open_entity answers from the registry as it was at its first read, though a definition is registered right after", async () => {
    const env = await open(allBundle());
    const { proxy, fired } = await racing(env.session, env.dir);
    const reply = okJson(await executeOperation(proxy, "open_entity", OPEN));
    expect(fired(), "the interleaved registration happened").toBe(true);
    expect(definitionIds(reply)).not.toContain("def-late");
    // control: the registration really took effect afterwards, so the test could have seen it
    expect(definitionIds(okJson(await env.call("open_entity", OPEN)))).toContain("def-late");
  });
  it("[T5] navigate answers from the registry as it was at its first read, though a definition is registered right after", async () => {
    const env = await open(allBundle());
    const { proxy, fired } = await racing(env.session, env.dir);
    const reply = okJson(await executeOperation(proxy, "navigate", { pane: PANE, itemId: "mcp", format: "json" }));
    expect(fired()).toBe(true);
    expect(definitionIds(reply)).not.toContain("def-late-module");
    // control: the registration really took effect afterwards
    expect(definitionIds(okJson(await env.call("navigate", { pane: PANE, itemId: "mcp", format: "json" })))).toContain("def-late-module");
  });
});

describe("[T5] a session written before the index fields existed still answers the same", () => {
  /** Rewrites the manifest as an older version wrote it: view rows without entity, title, viewDefinitionId and completeness. */
  function strip(dir: string): void {
    const path = join(dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    for (const view of manifest.views) { delete view.entity; delete view.title; delete view.viewDefinitionId; delete view.completeness; }
    writeFileSync(path, JSON.stringify(manifest));
  }
  // why: migration is "derive on read if absent": identical answers for the same session, before and after stripping the rows.
  it("[T5] open_entity, navigate and the view index are byte-identical on a stripped manifest", async () => {
    const env = await open(allBundle());
    const before = {
      open: (await env.call("open_entity", OPEN)).body,
      navigate: (await env.call("navigate", { pane: PANE, itemId: "mcp", format: "json" })).body,
      index: await env.session.listViewIndex(),
    };
    strip(env.dir);
    const fresh = must(await openSession(env.dir));
    expect((await executeOperation(fresh, "open_entity", OPEN)).body).toBe(before.open);
    expect((await executeOperation(fresh, "navigate", { pane: PANE, itemId: "mcp", format: "json" })).body).toBe(before.navigate);
    expect(await fresh.listViewIndex()).toEqual(before.index);
  });
  // why: a new write into an old-format manifest adds complete rows next to the derived ones; both kinds list.
  it("[T5] a view imported into a stripped manifest is listed next to the old ones", async () => {
    const env = await open(allBundle());
    strip(env.dir);
    const fresh = must(await openSession(env.dir));
    must(await fresh.importBundle(bundleOf([listView({ id: "later", definitionId: "def-later", snapshotId: "snap-2", title: "Later" })])));
    const ids = (await fresh.listViewIndex()).map((entry) => `${entry.viewId}@${entry.snapshotId}`);
    expect(ids).toContain("modules@snap-1");
    expect(ids).toContain("later@snap-2");
  });
  // why: control for the failure path: an unknown entity is still the named unresolved target on the new read path.
  it("[T5] control: an unknown entity is still UNRESOLVED_TARGET", async () => {
    const env = await open(allBundle());
    expect(failure(await env.call("open_entity", { ...OPEN, entity: { ...WATCH, id: "ghost" } })).code).toBe("UNRESOLVED_TARGET");
  });
});
