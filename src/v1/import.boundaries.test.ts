// Fix round 1, S1 and S7: where an import may write, and what an import commits as one unit.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSession, type Session } from "../core/session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { collectionImport, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { lowerViewRecord } from "./capture.ts";
import { importCollection } from "./import.ts";
import { openV1Reader } from "./read.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const sessions: Session[] = [];
afterEach(async () => { for (const session of sessions.splice(0)) await session.close().catch(() => {}); });
/** A session one level below a directory of its own, so that a write outside the session is visible in `root`. */
async function nested(): Promise<{ session: Session; dir: string; root: string }> {
  const root = tmp("s1-root");
  const dir = join(root, "session");
  const session = must(await openSession(dir), "openSession");
  sessions.push(session);
  return { session, dir, root };
}

/** Every file under `root`, relative, sorted. */
function tree(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(root, path));
    }
  };
  walk(root);
  return found.sort();
}

/** The collection with one identifier renamed everywhere it appears as a whole string value. */
function renamed<T>(value: T, from: string, to: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(from), JSON.stringify(to))) as T;
}

describe("[S1] untrusted identifiers are path components, never paths", () => {
  // why: S1. A capture id is read from the submitted payload and used to be joined into the artifact path, so `../../../../manifest` wrote
  // the graph over the session manifest and `../../../../../escaped` wrote beside the session. Rejects the implementation that joins `${captureId}.json`.
  // proves: CLAIM(S1-confinement)
  it("writes nothing outside the session's v1 store, objects and manifest for a traversing capture id", async () => {
    const { session, root } = await nested();
    const before = tree(root);
    const input = collectionImport("vigil-redelivered");
    const hostile = "../../../../../escaped";
    input.graphs = input.graphs.map((graph) => renamed(graph, "inv-1", hostile));
    input.run = renamed(input.run, "inv-1", hostile);
    const outcome = await importCollection(session, input);
    const created = tree(root).filter((path) => !before.includes(path));
    const stray = created.filter((path) => !path.startsWith("session/v1/") && !path.startsWith("session/objects/") && path !== "session/manifest.json" && path !== "session/.write.lock");
    expect(stray, "files created outside v1/, objects/ and the manifest").toEqual([]);
    if (outcome.ok) {
      const object = await openV1Reader(session).object({ snapshotId: "snap-run-1", captureId: hostile, objectId: "o1" });
      expect(object.ok, "an accepted capture id reads back by the same id").toBe(true);
    }
  });

  // why: S1. The session manifest is the commit point; a payload that names it as a capture id must not be able to replace it before the
  // import commits. After a crash in the middle of the import the manifest is still the one the session had.
  // proves: CLAIM(S1-confinement)
  it("leaves the session manifest byte-identical when a capture id names it and the import is interrupted", async () => {
    const { session, dir } = await nested();
    must(await session.registerRepository({ id: "vg", root: dir }), "register");
    const manifestBefore = readFileSync(join(dir, "manifest.json"), "utf8");
    const input = collectionImport("vigil-redelivered");
    const hostile = "../../../../manifest";
    input.graphs = input.graphs.map((graph) => renamed(graph, "inv-1", hostile));
    input.run = renamed(input.run, "inv-1", hostile);
    await importCollection(session, input, { crashAt: (point) => { if (point === "after-objects") throw new Error("crash"); } }).catch(() => undefined);
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe(manifestBefore);
  });

  // why: S1. The run id also names a directory. A run id like `../planted` must not address a sibling of runs/ on read: a record planted at
  // v1/planted/import.json used to be read as the import of run `../planted`.
  // proves: CLAIM(S1-confinement)
  it("does not read a run record from outside runs/ for a traversing run id", async () => {
    const { session, dir } = await open();
    must(await importCollection(session, collectionImport("vigil-redelivered")), "import");
    const real = JSON.parse(readFileSync(join(dir, "v1", "runs", "run-1", "import.json"), "utf8"));
    mkdirSync(join(dir, "v1", "planted"), { recursive: true });
    writeFileSync(join(dir, "v1", "planted", "import.json"), JSON.stringify(real));
    writeFileSync(join(dir, "v1", "planted", "run.json"), readFileSync(join(dir, "v1", "runs", "run-1", "run.json"), "utf8"));
    const read = await openV1Reader(session).run("../planted");
    expect(read.ok, "a run id with path separators addresses nothing").toBe(false);
  });

  // why: S1. A run id with separators is accepted as an identifier (the schema allows any string up to 128 characters) but stays inside v1/runs/.
  // proves: CLAIM(S1-confinement)
  it("keeps a run id with separators inside v1/runs and reads it back", async () => {
    const { session, root } = await nested();
    const input = collectionImport("vigil-redelivered");
    const hostile = "../../outside";
    input.runId = hostile;
    input.run = renamed(input.run, "run-1", hostile);
    input.graphs = input.graphs.map((graph) => renamed(graph, "run-1", hostile));
    const before = tree(root);
    const outcome = await importCollection(session, input);
    const stray = tree(root).filter((path) => !before.includes(path)).filter((path) => !path.startsWith("session/v1/runs/") && !path.startsWith("session/v1/pages/") && !path.startsWith("session/objects/") && !["session/manifest.json", "session/.write.lock", "session/v1/.write.lock"].includes(path));
    expect(stray, "created outside v1/runs").toEqual([]);
    if (outcome.ok) expect((await openV1Reader(session).run(hostile)).ok).toBe(true);
  });
});

describe("[S7] an import commits as one unit", () => {
  const variant = () => {
    const input = collectionImport("vigil-redelivered");
    const run = structuredClone(input.run) as any;
    run.invocations[0].finishedAt = "2026-11-11T12:00:09Z";
    return { ...input, run };
  };

  // why: S7. Same run id, different content, started together. The receipt check and the artifact writes used to run outside the session
  // transaction, so the loser (paused after its own receipt check) overwrote the winner's run record and receipt: both calls answered
  // ok, or the artifacts and the committed snapshot came from different imports. Exactly one import wins and what is stored is the winner's.
  // proves: CLAIM(S7-transaction)
  it("lets exactly one of two conflicting imports of one run win and stores only the winner's artifacts", async () => {
    const { session, dir } = await open();
    let held = false;
    const slow = importCollection(session, collectionImport("vigil-redelivered"), {
      crashAt: async (point) => {
        if (point !== "before-write" || held) return;
        held = true;
        const until = Date.now() + 2500;
        while (Date.now() < until && (await session.snapshotInfo("snap-run-1")).ok === false) await new Promise((resolve) => setTimeout(resolve, 25));
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const fast = importCollection(session, variant());
    const [a, b] = await Promise.all([slow, fast]);
    expect([a.ok, b.ok].filter(Boolean), JSON.stringify([a, b])).toHaveLength(1);
    const winner = a.ok ? collectionImport("vigil-redelivered") : variant();
    const stored = JSON.parse(readFileSync(join(dir, "v1", "runs", "run-1", "run.json"), "utf8"));
    expect(stored.invocations[0].finishedAt).toBe((winner.run as any).invocations[0].finishedAt);
    const receipt = JSON.parse(readFileSync(join(dir, "v1", "runs", "run-1", "import.json"), "utf8"));
    const again = must(await importCollection(session, winner), "the winner's content is idempotent");
    expect(again.alreadyImported, JSON.stringify(receipt)).toBe(true);
    expect(mustFail(await importCollection(session, a.ok ? variant() : collectionImport("vigil-redelivered")), "the loser's content").code).toBe("CONFLICT");
  });

  // why: S7. The view definitions used to be replaced in the registry BEFORE the preflight and before any artifact existed. An import that
  // never commits (a crash before the write) still left the registry changed. The definition change commits with the views or not at all.
  // proves: CLAIM(S7-transaction)
  it("does not change the registry when the import does not commit", async () => {
    const { session } = await open();
    must(await importCollection(session, collectionImport("vigil-redelivered")), "first run registers the definitions");
    const registered = await session.listDefinitions();
    const second = collectionImport("vigil-redelivered");
    second.runId = "run-2";
    second.run = renamed(second.run, "run-1", "run-2");
    second.graphs = second.graphs.map((graph) => renamed(graph, "run-1", "run-2")).map((graph) => {
      const edited = structuredClone(graph) as any;
      edited.views[0].title = "A title edited since the first collection";
      return edited;
    });
    await importCollection(session, second, { crashAt: (point) => { if (point === "before-write") throw new Error("crash"); } }).catch(() => undefined);
    const after = await session.listDefinitions();
    expect(after.revision, "the registry revision").toBe(registered.revision);
    expect(after.definitions).toEqual(registered.definitions);
  });

  // why: S7. A rejected import used to leave the registry edited: the changed view definitions were replaced one by one BEFORE the preflight
  // that refuses the import (here: another writer already holds one of its views with different content). Rejection leaves the registry as it was.
  // proves: CLAIM(S7-transaction)
  it("does not keep a definition replacement when the preflight refuses the import", async () => {
    const { session } = await open();
    must(await importCollection(session, collectionImport("vigil-redelivered")), "first run registers the definitions");
    const registered = await session.listDefinitions();
    const base = collectionImport("vigil-redelivered");
    const rename = (graph: any) => renamed(graph, "run-1", "run-2");
    const run2 = renamed(base.run, "run-1", "run-2") as any;
    // another writer (a v0 bundle) already holds snapshot snap-run-2's `watch.events` view with a different question
    const squatter = rename(structuredClone(base.graphs[0])) as any;
    squatter.views[1].question = "Which events did somebody else record?";
    const context = { repo: "vg", snapshotId: "snap-run-2", runnerId: run2.runner.id, startedAt: "2026-11-11T12:00:00Z", finishedAt: "2026-11-11T12:00:01Z", generatedAt: "2026-11-11T12:00:01Z" };
    const lowered = squatter.views.map((view: any) => must(lowerViewRecord(squatter, view, context), "lower"));
    const entities = [...new Map(lowered.map((l: any) => [l.entity.id, l.entity])).values()];
    const definitions = [...new Map(lowered.map((l: any) => [l.definition.id, l.definition])).values()];
    must(await session.importBundle({ schemaVersion: "paneweft.bundle/1", entities, definitions, views: lowered.map((l: any) => l.envelope) }), "the other writer");
    const afterSquat = await session.listDefinitions();
    const mine = rename(structuredClone(base.graphs[0])) as any;
    mine.views[0].title = "A title edited since the first collection";
    const outcome = await importCollection(session, { ...base, runId: "run-2", run: run2, graphs: [mine] });
    expect(outcome.ok, "the squatted view makes the import conflict").toBe(false);
    expect((await session.listDefinitions()).definitions).toEqual(afterSquat.definitions);
    expect(afterSquat.definitions).toEqual(registered.definitions);
  });
});
