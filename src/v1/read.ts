// Reading imported collections: objects, backlinks, stored pages, run records (IV10, IV11).
// The v1 files live beside the v0 store under <session>/v1 and are visible ONLY through a committed snapshot of the v0 manifest:
// that manifest swap is the commit point of an import, so an interrupted import leaves nothing readable.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { compareCodeUnits } from "../core/canonical.ts";
import { err, ok, type Result } from "../core/errors.ts";
import type { Session, ViewKey } from "../core/session.ts";
import type { EntityRef } from "../core/wire.ts";
import type { ObjectGraph, ObjectRecord, PageRecord } from "../generated/v1/ObjectGraph.ts";
import type { TestRun } from "../generated/v1/TestRun.ts";
import { entityKindOf } from "./capture.ts";

export interface ObjectKey {
  snapshotId: string;
  captureId: string;
  objectId: string;
}

export interface Backlink {
  from: ObjectKey;
  name: string;
  kind: "child" | "alias" | "cycle";
}

export interface StoredObject {
  key: ObjectKey;
  record: ObjectRecord;
  entity: EntityRef;
  views: ViewKey[];
  /** Aliases and cycles shown without duplicating the graph: who points here, and how. */
  backlinks: Backlink[];
}

export type Origin = "host_collected" | "external_recorded" | "agent_submitted";

export interface StoredRun {
  run: TestRun;
  origin: Origin;
  snapshotId: string;
}

export interface V1Reader {
  object(key: ObjectKey): Promise<Result<StoredObject>>;
  /** A stored child page by content address; readable with no source process alive. */
  page(pageId: string): Promise<Result<PageRecord>>;
  run(runId: string): Promise<Result<StoredRun>>;
  runs(): Promise<Result<Array<{ runId: string; snapshotId: string; origin: StoredRun["origin"] }>>>;
}

/** What an import records beside the run: the host's stamps and the receipt, so a repeated import can answer without recomputing. */
export interface ImportRecord {
  runId: string;
  repo: string;
  origin: Origin;
  jobId: string | null;
  digest: string;
  snapshotId: string;
  captureIds: string[];
  viewKeys: ViewKey[];
  entities: EntityRef[];
  importedAt: string;
}

// S1: an identifier from a payload (run id, capture id, page id, view id) is a NAME, never a path. `pathComponent` maps any non-empty string to
// one file-name component, injectively and reversibly enough to compare (`%` is always escaped, so no two ids share a component), and
// `within` refuses a path that leaves its root, so a bug in one caller cannot become a write outside the store.
const COMPONENT_LIMIT = 160;

/** One safe, injective file-name component for `id`: percent-escapes everything but unreserved characters, escapes dot-only names, and
 * falls back to `%h-<sha256>` (never produced by escaping, since `h` is not a hex digit) for names too long for a file system. */
export function pathComponent(id: string): string {
  if (id.length === 0) throw new RangeError("an identifier used as a path component cannot be empty");
  let escaped = encodeURIComponent(id).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  if (/^\.+$/.test(escaped)) escaped = escaped.replaceAll(".", "%2E");
  return escaped.length > COMPONENT_LIMIT ? `%h-${createHash("sha256").update(id).digest("hex")}` : escaped;
}

/** `join(root, ...parts)` where every part is a path component already; throws if the result is not strictly inside `root`. */
export function within(root: string, ...parts: string[]): string {
  const path = join(root, ...parts);
  const inside = relative(root, path);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || inside.startsWith(sep)) throw new RangeError(`the path "${path}" is not inside "${root}"`);
  return path;
}

export const v1Directory = (session: Pick<Session, "dir">): string => join(session.dir, "v1");
export const runDirectory = (session: Pick<Session, "dir">, runId: string): string => within(join(v1Directory(session), "runs"), pathComponent(runId));
export const snapshotOfRun = (runId: string): string => `snap-${runId}`;
export const pageFile = (session: Pick<Session, "dir">, pageId: string): string => within(join(v1Directory(session), "pages"), `${pathComponent(pageId.replace(/^sha256:/, ""))}.json`);
export const captureFile = (session: Pick<Session, "dir">, runId: string, captureId: string): string => within(join(runDirectory(session, runId), "captures"), `${pathComponent(captureId)}.json`);
export const customFile = (session: Pick<Session, "dir">, runId: string, viewId: string): string => within(join(runDirectory(session, runId), "customs"), `${pathComponent(viewId)}.json`);

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

/** The import record of a run IF its snapshot is committed in the manifest; otherwise the run does not exist for readers. */
export async function committedImport(session: Session, runId: string): Promise<ImportRecord | undefined> {
  const record = await readJsonFile<ImportRecord>(join(runDirectory(session, runId), "import.json"));
  if (record === undefined) return undefined;
  const snapshot = await session.snapshotInfo(record.snapshotId);
  return snapshot.ok ? record : undefined;
}

export function openV1Reader(session: Session): V1Reader {
  const runIdOfSnapshot = (snapshotId: string): string | undefined => (snapshotId.startsWith("snap-") && snapshotId.length > 5 ? snapshotId.slice(5) : undefined);
  const notFound = <T>(what: string): Result<T> => err("NOT_FOUND", `${what} is not in this session`);
  return {
    async object(key) {
      const runId = runIdOfSnapshot(key.snapshotId);
      if (runId === undefined) return notFound(`snapshot "${key.snapshotId}"`);
      const record = await committedImport(session, runId);
      if (record === undefined || !record.captureIds.includes(key.captureId)) return notFound(`capture "${key.captureId}" of snapshot "${key.snapshotId}"`);
      const graph = await readJsonFile<ObjectGraph>(captureFile(session, runId, key.captureId));
      const object = graph?.objects.find((candidate) => candidate.id === key.objectId);
      if (graph === undefined || object === undefined) return notFound(`object "${key.objectId}" of capture "${key.captureId}"`);
      const backlinks: Backlink[] = [];
      for (const other of graph.objects) {
        for (const edge of other.edges) {
          if (edge.target === key.objectId && edge.kind !== "not-captured") backlinks.push({ from: { snapshotId: key.snapshotId, captureId: key.captureId, objectId: other.id }, name: edge.name, kind: edge.kind });
        }
      }
      const entity: EntityRef = { repository: record.repo, id: `${graph.captureId}.${object.id}`, kind: entityKindOf(object.typeId) };
      return ok({ key, record: object, entity, views: graph.views.filter((view) => view.objectId === object.id).map((view) => ({ viewId: `${graph.captureId}.${object.id}.${view.viewId}`, snapshotId: key.snapshotId })), backlinks });
    },
    async page(pageId) {
      if (!/^sha256:[0-9a-f]{64}$/.test(pageId)) return err("INVALID_ARGUMENT", `"${pageId}" is not a page id (sha256:<64 hex>)`);
      const page = await readJsonFile<PageRecord>(pageFile(session, pageId));
      return page === undefined ? notFound(`page "${pageId}"`) : ok(page);
    },
    async run(runId) {
      const record = await committedImport(session, runId);
      if (record === undefined) return notFound(`run "${runId}"`);
      const run = await readJsonFile<TestRun>(join(runDirectory(session, runId), "run.json"));
      return run === undefined ? err("STORAGE_CORRUPT", `run "${runId}" is committed but its record is missing`) : ok({ run, origin: record.origin, snapshotId: record.snapshotId });
    },
    async runs() {
      let names: string[];
      try {
        names = await readdir(join(v1Directory(session), "runs"));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
        return err("STORAGE_FAILED", (cause as Error).message);
      }
      const runs: Array<{ runId: string; snapshotId: string; origin: StoredRun["origin"] }> = [];
      for (const name of names.sort(compareCodeUnits)) {
        // the receipt names the run; a directory is that run's only if the receipt's id maps back to the directory's name
        const named = await readJsonFile<ImportRecord>(join(v1Directory(session), "runs", name, "import.json")).catch(() => undefined);
        if (typeof named?.runId !== "string" || named.runId.length === 0 || pathComponent(named.runId) !== name) continue;
        const record = await committedImport(session, named.runId);
        if (record !== undefined) runs.push({ runId: record.runId, snapshotId: record.snapshotId, origin: record.origin });
      }
      return ok(runs);
    },
  };
}
