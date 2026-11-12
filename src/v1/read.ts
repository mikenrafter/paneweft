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
import type { ObjectGraph, ObjectRecord, ViewRecord } from "../generated/v1/ObjectGraph.ts";
import { checkListRows, pageIdOf, rowIds } from "./page-rows.ts";
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

/** Who owns a stored page: the run that imported it, the capture, object and view that list it, and its place among that view's pages (1 is the
 * first stored page, the one after the rows the view's record holds). The page body is shared by content; this key is not. */
export interface PageKey {
  runId: string;
  captureId: string;
  objectId: string;
  viewId: string;
  position: number;
}

/** The ownership record of one stored page (D2): published with the import that stored it, in `runs/<run>/page-refs.json`. */
export interface PageRef {
  captureId: string;
  objectId: string;
  viewId: string;
  position: number;
  pageId: string;
  rowCount: number;
}

/** A stored page that passed every check of `readPageAt`. */
export interface StoredPage {
  key: PageKey;
  pageId: string;
  rows: Array<Record<string, unknown>>;
  /** Positions of the earlier stored pages that could not be read (missing or corrupt). Row ids are unique over the view, and that is proven only
   * against the first page and the pages that were read: this page's ids are not compared with the rows of these. Empty: proven against all. */
  unprovenAgainst: number[];
}

/** What the stored v1 files are read through: the session directory and the committed snapshots (a session, or one read of its manifest). */
export type StoreReader = Pick<Session, "dir" | "snapshotInfo">;

export interface V1Reader {
  object(key: ObjectKey): Promise<Result<StoredObject>>;
  /** A stored page of a view, validated (D3); readable with no source process alive. */
  page(key: PageKey): Promise<Result<StoredPage>>;
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
/** The bodies of stored pages: one immutable file per distinct body, addressed by its content and owned by nobody (D2). */
export const pageRefsFile = (session: Pick<Session, "dir">, runId: string): string => within(runDirectory(session, runId), "page-refs.json");
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
export async function committedImport(session: StoreReader, runId: string): Promise<ImportRecord | undefined> {
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
    async page(key) {
      const view = await loadViewPages(session, key);
      if (!view.ok) return view;
      return readPageAt(view.value, key.position);
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

// ---- stored pages (D2, D3) --------------------------------------------------------------------------------------------------------------
// The one reader of a stored page. The CLI, the agent tools, the viewer and `V1Reader.page` all end here, so a page that is missing, a page that is
// not JSON and a page that is JSON but not a valid page of its view get the same answer on every surface: NOT_FOUND for the first, STORAGE_CORRUPT
// for the other two.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const corrupt = <T>(message: string, details?: Record<string, unknown>): Result<T> => err("STORAGE_CORRUPT", message.slice(0, 2000), details === undefined ? {} : { details });

/** What is known about the stored pages of one view of one run: its capture, its record in the capture, and the references that own its pages. */
export interface ViewPages {
  session: StoreReader;
  runId: string;
  record: ImportRecord;
  graph: ObjectGraph;
  view: ViewRecord;
  /** The references of this view, by position. */
  refs: PageRef[];
}

async function readStored<T>(path: string, what: string): Promise<Result<T>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return err("NOT_FOUND", `${what} is not in this session`);
    return err("STORAGE_FAILED", `${what} could not be read: ${(cause as Error).message}`);
  }
  try {
    return ok(JSON.parse(text) as T);
  } catch {
    return corrupt(`${what} is not valid JSON`);
  }
}

/** The capture and the references behind the stored pages of a view. NOT_FOUND: no such run, capture or view. STORAGE_CORRUPT: the run is committed
 * and a file it needs is missing or damaged. */
export async function loadViewPages(session: StoreReader, key: Omit<PageKey, "position">): Promise<Result<ViewPages>> {
  const record = await committedImport(session, key.runId).catch(() => undefined);
  if (record === undefined || !record.captureIds.includes(key.captureId)) return err("NOT_FOUND", `capture "${key.captureId}" of run "${key.runId}" is not in this session`);
  const capture = await readStored<ObjectGraph>(captureFile(session, key.runId, key.captureId), `the capture "${key.captureId}" of run "${key.runId}"`);
  if (!capture.ok) return capture.error.code === "NOT_FOUND" ? corrupt(`run "${key.runId}" is committed but its capture "${key.captureId}" is missing`) : capture;
  const graph = capture.value;
  if (!isRecord(graph) || !Array.isArray(graph.objects) || !Array.isArray(graph.views)) return corrupt(`the capture "${key.captureId}" of run "${key.runId}" is not an object graph`);
  const view = graph.views.find((candidate) => candidate.objectId === key.objectId && candidate.viewId === key.viewId);
  if (view === undefined) return err("NOT_FOUND", `view "${key.viewId}" of object "${key.objectId}" is not in capture "${key.captureId}" of run "${key.runId}"`);
  const stored = await readStored<{ refs?: unknown }>(pageRefsFile(session, key.runId), `the page references of run "${key.runId}"`);
  if (!stored.ok) return stored.error.code === "NOT_FOUND" ? corrupt(`run "${key.runId}" is committed but its page references are missing`) : stored;
  if (!isRecord(stored.value) || !Array.isArray(stored.value.refs)) return corrupt(`the page references of run "${key.runId}" are not a list`);
  const refs: PageRef[] = [];
  for (const entry of stored.value.refs) {
    if (!isRecord(entry) || typeof entry.captureId !== "string" || typeof entry.objectId !== "string" || typeof entry.viewId !== "string" || !Number.isInteger(entry.position) || typeof entry.pageId !== "string" || !Number.isInteger(entry.rowCount)) return corrupt(`the page references of run "${key.runId}" hold an entry that is not a reference`);
    if (entry.captureId === key.captureId && entry.objectId === key.objectId && entry.viewId === key.viewId) refs.push(entry as unknown as PageRef);
  }
  refs.sort((a, b) => a.position - b.position);
  return ok({ session, runId: key.runId, record, graph, view, refs });
}

/** What a page's reading leaves for the page after it: the row ids of the view so far (the first page and every page that WAS read) and the positions
 * that could not be read. A page that is not there or not valid fails only itself; it adds nothing to `seen`, and the pages after it are checked
 * against the pages that are present, with the gap recorded as `unprovenAgainst`. */
interface PrefixState { seen: Set<string>; unread: number[] }
const pagePrefixes = new WeakMap<ViewPages, { tail: Promise<PrefixState>; pages: Array<Promise<Result<StoredPage>>> }>();

/** The stored page at `position`, if it is a valid page of the view that owns it. Row ids are unique over the view; a page is checked against the
 * first page and every earlier page that could be read. Checks, in order: the reference exists; the body file
 * exists (NOT_FOUND) and is JSON of the right shape; its rows hash to the address the reference names and are as many as it counts; every row is
 * a row of the view's list (schema, declared columns, unique ids); every row target is an object of the capture. */
/** CLAIM(S29): the reader owns all preceding-page validation, including concurrent direct reads [page-reader.test.ts].
 * CLAIM(S40): a page's own NOT_FOUND or corruption fails only that page; later pages are still served [page-reader.test.ts]. */
export async function readPageAt(view: ViewPages, position: number): Promise<Result<StoredPage>> {
  if (!Number.isInteger(position) || position < 1 || position > view.refs.length) return err("NOT_FOUND", "invalid stored page position");
  let prefix = pagePrefixes.get(view);
  if (prefix === undefined) {
    prefix = { tail: Promise.resolve({ seen: new Set(rowIds((view.view.data as { rows?: unknown } | undefined)?.rows)), unread: [] }), pages: [] };
    pagePrefixes.set(view, prefix);
  }
  // Build the promise chain synchronously, so concurrent callers share one validation per prefix without mutating a shared seen set.
  while (prefix.pages.length < position) {
    const at = prefix.pages.length + 1;
    const step: Promise<{ state: PrefixState; page: Result<StoredPage> }> = prefix.tail.then(async (previous) => {
      const seen = new Set(previous.seen);
      const result = await readOnePage(view, at, seen);
      if (!result.ok) return { state: { seen: previous.seen, unread: [...previous.unread, at] }, page: result };
      return { state: { seen, unread: previous.unread }, page: ok({ ...result.value, unprovenAgainst: previous.unread }) };
    });
    prefix.pages.push(step.then((done) => done.page));
    prefix.tail = step.then((done) => done.state);
  }
  return prefix.pages[position - 1] as Promise<Result<StoredPage>>;
}

async function readOnePage(view: ViewPages, position: number, seen: Set<string>): Promise<Result<Omit<StoredPage, "unprovenAgainst">>> {
  const key: PageKey = { runId: view.runId, captureId: view.graph.captureId, objectId: view.view.objectId, viewId: view.view.viewId, position };
  const where = `page ${position} of view "${key.viewId}" of object "${key.objectId}" in run "${key.runId}"`;
  const ref = view.refs.find((candidate) => candidate.position === position);
  if (ref === undefined) return err("NOT_FOUND", `${where} is not stored`);
  const stored = await readStored<unknown>(pageFile(view.session, ref.pageId), `the body of the stored page "${ref.pageId}"`);
  if (!stored.ok) return stored.error.code === "NOT_FOUND" ? err("NOT_FOUND", `the stored page "${ref.pageId}" (${where}) is not in this session`, { details: { runId: key.runId, view: key.viewId, pageId: ref.pageId } }) : corruptPage(key, ref.pageId, [stored.error.message]);
  const body = stored.value;
  if (!isRecord(body) || Object.keys(body).sort().join() !== "pageId,rows" || typeof body.pageId !== "string" || !Array.isArray(body.rows)) return corruptPage(key, ref.pageId, ["its body is not {pageId, rows}"]);
  const reasons: string[] = [];
  if (body.pageId !== ref.pageId) reasons.push(`it says it is ${JSON.stringify(body.pageId)}`);
  if (pageIdOf(body.rows) !== ref.pageId) reasons.push("its rows do not hash to its id");
  if (body.rows.length !== ref.rowCount) reasons.push(`it holds ${body.rows.length} rows, not the ${ref.rowCount} its reference counts`);
  if (reasons.length === 0) {
    reasons.push(...checkListRows(view.view.data as { columns?: unknown; order?: unknown }, body.rows, "/rows", seen).slice(0, 3).map((fault) => `${fault.pointer} ${fault.constraint}`));
    const objects = new Set(view.graph.objects.map((object) => object.id));
    for (const [at, row] of (body.rows as Array<{ target?: { object?: string } }>).entries()) {
      const target = row?.target?.object;
      if (target !== undefined && !objects.has(target)) reasons.push(`/rows/${at}/target names the object ${JSON.stringify(target)}, which the capture does not hold`);
    }
  }
  return reasons.length > 0 ? corruptPage(key, ref.pageId, reasons) : ok({ key, pageId: ref.pageId, rows: body.rows as Array<Record<string, unknown>> });
}

function corruptPage(key: PageKey, pageId: string, reasons: string[]): Result<never> {
  return corrupt(`the stored page "${pageId}" (page ${key.position} of view "${key.viewId}" of object "${key.objectId}" in run "${key.runId}") is not valid: ${reasons.join("; ")}`, { runId: key.runId, view: key.viewId, pageId, reasons });
}
