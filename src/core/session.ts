// Immutable session storage (design section 5): canonical JSON files plus a small manifest,
// no database. An explicit session directory owns the data.
//
// Layout of a session directory:
//   manifest.json          the ONLY mutable file: registry, entities, snapshot table, view/page/run index. Replaced atomically.
//   objects/<sha256>.json  immutable canonical JSON of one stored view, notebook revision or run output, named by its content hash.
//   .write.lock            permanent, empty lock file (write-lock.ts): every mutation takes a kernel flock on a fresh descriptor of it. It is never
//                          unlinked, renamed or written; a crashed holder cannot leave it locked because the kernel releases the lock with the process.
//   server.json            written and removed by the viewer server; not part of the session state.
//
// CLAIM(atomic-manifest): the manifest is replaced atomically (write a temp file, fsync, rename), so a crash or injected failure
//   leaves the previous state fully readable [design section 5; session.test.ts, MC16, MC20].
// CLAIM(durable-objects): objects are fsynced (file, then the objects directory and the session directory) BEFORE the manifest that names them
//   is written, so a power loss cannot leave a durable manifest pointing at objects that never reached the disk [session.durability.test.ts, T10].
// CLAIM(snapshot-immutable): a stored (viewId, snapshotId) never changes; different content under the same key is
//   SNAPSHOT_CONFLICT, identical content is idempotent [design section 4; MC20].
// CLAIM(manifest-snapshot-read): a compound operation derives everything from ONE manifest read (`Session.snapshot()`), never from a second read that a commit may
//   have changed; the view lists (entity, title, definition, completeness) come from the manifest rows, and the stored object is verified when it is opened
//   [session.snapshot-reads.test.ts, T5; session.write-lock.test.ts].
// CLAIM(preflight-parity): `preflight` runs the very admission code importBundle and putView run inside their lock (`admitBundle`, `admitView`), with a
//   stage function that writes nothing, so what it accepts is what an import would accept at that manifest [operations.validate-session.test.ts, #4].
// CLAIM(process-lock): every mutation holds the session write lock (write-lock.ts, flock) from BEFORE it reads mutable state until after the
//   manifest swap, so two processes (or two handles) serialise and neither can act on a stale read [session.processes.test.ts, S5;
//   session.write-lock.test.ts]. Readers take no lock: each reads ONE manifest snapshot (CLAIM(manifest-snapshot-read), session.write-lock.test.ts).
// CLAIM(verified-reads): a stored object is read only through the manifest, and its canonical hash must equal the one the manifest
//   recorded; a tampered, truncated or emptied file is STORAGE_CORRUPT, never silently served; a file nobody registered is invisible
//   [session.atomic.test.ts, MC20].
// Mutation failures that are about the lock: CONFLICT (retryable) when another writer held the lock for the whole wait; STORAGE_FAILED with
//   details.cause "flock-missing" (util-linux `flock` not on PATH), "flock-failed" or "lock-file-unavailable" otherwise. None of them mutates.
// Errors: methods return Result<T>; they never throw for domain failures. Readers that return plain arrays throw a
//   `SessionStorageError` only when the manifest itself is unreadable.
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Bundle, Entity, EntityRef, Envelope, ViewDefinition } from "./wire.ts";
import type { OperationError, Result, ValidationIssue } from "./errors.ts";
import { canonicalJson, compareCodeUnits, ownValue } from "./canonical.ts";
import { canonicalSha256, sha256Hex } from "./digest.ts";
import { viewItems } from "./items.ts";
import { WriteLockError, withWriteLock } from "./write-lock.ts";
import { validateDefinition, validateRunOutput, validateSubmission, type DefinitionMetadata, type ReferenceContext, type ValidationNote } from "./validate.ts";

export interface ViewKey { viewId: string; snapshotId: string }
export interface RepositoryRegistration { id: string; root: string }
export interface StoredView { envelope: Envelope; contentHash: string }
export interface SnapshotInfo { snapshotId: string; predecessor: string | null; viewIds: string[] }
/** What the view lists need of a view's completeness: whether it is unsupported (and why). */
export type ViewCompleteness = { status: "complete" | "partial" } | { status: "unsupported"; reason: string };
/** One stored view as the lists see it, answered from the manifest without opening the stored object (T5). */
export interface ViewIndexEntry extends ViewKey {
  component: Envelope["component"];
  title: string;
  viewDefinitionId: string;
  entity: EntityRef;
  completeness: ViewCompleteness;
}
export interface ImportSummary {
  entities: number;
  definitions: number;
  views: ViewKey[];
  registryRevision: number;
  /** `${viewId}@${snapshotId}` -> sha256 of the canonical JSON of the stored envelope. */
  contentHashes: Record<string, string>;
  /** The validator's non-fatal notes on the accepted document (empty when it had none); `render` reports them. */
  notes: ValidationNote[];
}
export interface NotebookPage { pageId: string; snapshotId: string; revision: number; envelope: Envelope }
export interface RecordedRun { runId: string; viewId: string; snapshotId: string; status: "passed" | "failed" | "error"; contentHash: string }

/** Failure injection for tests of atomicity (MC16, MC20). Never set in production code paths. */
export interface SessionTestHooks {
  /** S5: immediately before trying the write lock, before reading mutable manifest state. */
  beforeLockAcquire?: (info: { operation: string }) => void | Promise<void>;
  /** S5: after reading the manifest INSIDE the lock; held until the hook resolves. */
  afterManifestRead?: (info: { operation: string }) => void | Promise<void>;
  /** S2 flock: the lock helper was spawned (its pid), before the lock is known to be held. Reported while the helper may still be waiting. */
  afterHelperSpawned?: (info: { operation: string; helperPid: number }) => void | Promise<void>;
  /** S2 flock: the helper reported the lock acquired; nothing mutable has been read yet. Runs inside the critical section. */
  afterLockAcquired?: (info: { operation: string }) => void | Promise<void>;
  /** S2 flock: the new manifest is written and synced under a temporary name; the rename (the commit point) has not happened. */
  beforeManifestRename?: (info: { operation: string }) => void | Promise<void>;
  /** S2 flock: the rename happened, so the mutation is committed; the lock is still held. */
  afterManifestRename?: (info: { operation: string }) => void | Promise<void>;
  /** Called immediately before the manifest swap of a mutation; throwing simulates a failed save. */
  beforeManifestSwap?: (info: { operation: string }) => void | Promise<void>;
  /** Called after each file written while staging a mutation. */
  afterWrite?: (info: { count: number; path: string }) => void | Promise<void>;
}
export interface SessionOptions {
  testHooks?: SessionTestHooks;
  /** How long a mutation waits for a lock another writer holds before it answers CONFLICT, in whole milliseconds (>= 1). Default 15 seconds. */
  lockWaitMs?: number;
}

/**
 * Every read of a session. `Session` answers each from a fresh manifest read; a `SessionSnapshot` answers all of them from ONE manifest read, which is what
 * a compound operation (open_entity, navigate, render, ...) needs so that its steps cannot see different generations (CLAIM(manifest-snapshot-read)).
 */
export interface SessionReader {
  getView(key: ViewKey): Promise<Result<StoredView>>;
  listViews(): Promise<ViewKey[]>;
  /** The stored views (of one snapshot when `snapshotId` is given) with entity, title, definition id and completeness, in key order. Opens no object whose manifest row has them. */
  listViewIndex(snapshotId?: string): Promise<ViewIndexEntry[]>;
  getEntity(entity: EntityRef, snapshotId: string): Promise<Result<Entity>>;
  listEntities(snapshotId?: string): Promise<Entity[]>;
  listDefinitions(): Promise<{ revision: number; definitions: ViewDefinition[] }>;
  repositories(): Promise<RepositoryRegistration[]>;
  snapshotInfo(snapshotId: string): Promise<Result<SnapshotInfo>>;
  exportBundle(): Promise<Bundle>;
  /**
   * A page is addressed by (pageId, snapshotId). `snapshotId` may be omitted only while exactly one snapshot holds the pageId; with several the call
   * is INVALID_ARGUMENT naming them (CLAIM(notebook-snapshot-identity)); an unknown snapshot or page is NOT_FOUND.
   */
  notebookGet(pageId: string, revision?: number, snapshotId?: string): Promise<Result<NotebookPage>>;
  listRuns(key: ViewKey): Promise<Result<RecordedRun[]>>;
  /** The runs recorded on an example view with their stored `paneweft.run/1` outputs, in recording order; each output is read through its verified content hash. */
  recordedRunOutputs(key: ViewKey): Promise<Result<Array<{ run: RecordedRun; output: unknown }>>>;
}

/** The session as it was at one manifest read: every answer, and the generation and registry revision, are those of that read. */
export interface SessionSnapshot extends SessionReader {
  readonly generation: number;
  readonly registryRevision: number;
}

export interface Session extends SessionReader {
  readonly dir: string;
  /** One manifest read, to be passed through every step of a compound operation. */
  snapshot(): Promise<SessionSnapshot>;
  /**
   * `replaceDefinitions` are registered definitions that this bundle changes (the v0 registry otherwise refuses a different definition under a
   * registered id): they are validated and replaced in the SAME manifest swap as the bundle's views, so an import that is refused or never
   * commits leaves the registry as it was (CLAIM(S7-transaction)).
   */
  importBundle(input: unknown, options?: { predecessorSnapshotId?: string; replaceDefinitions?: ViewDefinition[] }): Promise<Result<ImportSummary>>;
  /**
   * What importBundle (a `paneweft.bundle/1`) or putView (an envelope) would answer for `input` against this session as it is now, with nothing stored
   * and no lock taken: the same validation with the session's reference context and the same identity and snapshot conflict checks, through the same code
   * (CLAIM(preflight-parity)). `validate` with a session is this.
   */
  preflight(input: unknown, options?: { predecessorSnapshotId?: string; replaceDefinitions?: ViewDefinition[] }): Promise<Result<{ kind: "envelope" | "bundle"; notes: ValidationNote[] }>>;
  /** A single envelope; its entity and view definition must already be registered. */
  putView(input: unknown, options?: { predecessorSnapshotId?: string }): Promise<Result<ImportSummary>>;
  registerView(definition: unknown, expectedRevision: number): Promise<Result<{ revision: number }>>;
  registerRepository(registration: RepositoryRegistration): Promise<Result<void>>;
  notebookCreate(input: unknown): Promise<Result<NotebookPage>>;
  notebookUpdate(pageId: string, expectedRevision: number, change: { blocks: unknown[]; sources?: unknown[] }, snapshotId?: string): Promise<Result<NotebookPage>>;
  recordExampleRun(key: ViewKey, output: unknown): Promise<Result<RecordedRun>>;
  close(): Promise<void>;
}

type Failure = { readonly ok: false; readonly error: OperationError };

export class SessionStorageError extends Error {
  readonly code: "STORAGE_CORRUPT" | "STORAGE_FAILED";
  constructor(code: "STORAGE_CORRUPT" | "STORAGE_FAILED", message: string) {
    super(message);
    this.code = code;
  }
}

// ---- manifest -----------------------------------------------------------------------------------------------------

/**
 * One stored view. `entity`, `title`, `viewDefinitionId` and `completeness` are what the lists need, recorded at write time so that listing the views of an
 * entity does not open every object (T5). A row written before they existed lacks them; readers derive them from the object (ManifestReader.indexOf) and
 * `paneweft.session/1` is unchanged: an older reader ignores the extra members.
 */
interface ViewEntry { viewId: string; snapshotId: string; hash: string; component: Envelope["component"]; entity?: EntityRef; title?: string; viewDefinitionId?: string; completeness?: ViewCompleteness }
type IndexFields = Pick<ViewIndexEntry, "entity" | "title" | "viewDefinitionId" | "completeness">;
const indexFieldsOf = (envelope: Envelope): IndexFields => ({
  entity: { repository: envelope.entity.repository, id: envelope.entity.id, kind: envelope.entity.kind },
  title: envelope.title,
  viewDefinitionId: envelope.viewDefinitionId,
  completeness: envelope.completeness.status === "unsupported" ? { status: "unsupported", reason: envelope.completeness.reason } : { status: envelope.completeness.status },
});
interface PageEntry { pageId: string; snapshotId: string; /** content hashes; revision N is index N-1 */ revisions: string[] }
interface RunEntry extends RecordedRun { /** the stored run output is objects/<contentHash>.json */ }
interface Manifest {
  schemaVersion: "paneweft.session/1";
  generation: number;
  registryRevision: number;
  repositories: RepositoryRegistration[];
  definitions: ViewDefinition[];
  entities: Entity[];
  snapshots: Record<string, { predecessor: string | null }>;
  views: ViewEntry[];
  pages: PageEntry[];
  runs: RunEntry[];
}
const emptyManifest = (): Manifest => ({
  schemaVersion: "paneweft.session/1", generation: 0, registryRevision: 0, repositories: [], definitions: [], entities: [], snapshots: {}, views: [], pages: [], runs: [],
});

const MANIFEST = "manifest.json";
const OBJECTS = "objects";
const LOCK_WAIT_MS = 15_000;

// ---- errors -------------------------------------------------------------------------------------------------------

function failure(code: OperationError["code"], message: string, extra: Partial<Pick<OperationError, "errors" | "retryable" | "details">> = {}): Failure {
  return { ok: false, error: { schemaVersion: "paneweft.error/1", code, message, errors: extra.errors ?? [], retryable: extra.retryable ?? false, ...(extra.details === undefined ? {} : { details: extra.details }) } };
}
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
function validationFailure(subject: string, errors: ValidationIssue[]) {
  return failure("VALIDATION_FAILED", `${subject} failed validation with ${errors.length} issue${errors.length === 1 ? "" : "s"}; first: ${errors[0]?.code} at "${errors[0]?.pointer}"`, { errors });
}

// ---- helpers ------------------------------------------------------------------------------------------------------

const entityKey = (entity: EntityRef & { snapshotId: string }): string => `${entity.snapshotId}\u0000${entity.repository}\u0000${entity.kind}\u0000${entity.id}`;
const viewKey = (key: ViewKey): string => `${key.snapshotId}\u0000${key.viewId}`;
const byViewKey = (a: ViewKey, b: ViewKey): number => compareCodeUnits(a.viewId, b.viewId) || compareCodeUnits(a.snapshotId, b.snapshotId);
/** CLAIM(manifest-snapshot-read): compound reads derive everything from ONE manifest, never from a second read that a commit may have changed. */
const sortedEntities = (entities: readonly Entity[], snapshotId?: string): Entity[] => entities
  .filter((entity) => snapshotId === undefined || entity.snapshotId === snapshotId)
  .sort((a, b) => compareCodeUnits(a.repository, b.repository) || compareCodeUnits(a.id, b.id) || compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.snapshotId, b.snapshotId));
const hashesLabel = (key: ViewKey): string => `${key.viewId}@${key.snapshotId}`;

/** Items of a view that other views may point at (the item ids a ReferenceContext view lists). */
const itemIdsOf = (envelope: Envelope): string[] => viewItems(envelope).map((item) => item.id);

/** View ids a submitted document's notebooks point at; only those views' items are loaded into the validation context. */
function referencedViewIds(documents: unknown[]): { ids: Set<string>; examples: boolean } {
  const ids = new Set<string>();
  let examples = false;
  for (const view of documents as Array<Record<string, any>>) {
    if (view?.component !== "notebook") continue;
    for (const block of Array.isArray(view.data?.blocks) ? view.data.blocks : []) {
      if (typeof block?.viewId === "string") ids.add(block.viewId);
      if (typeof block?.exampleId === "string") { ids.add(block.exampleId); examples = true; }
      for (const key of ["supports", "contradicts"]) for (const target of Array.isArray(block?.[key]) ? block[key] : []) if (typeof target?.viewId === "string") ids.add(target.viewId);
    }
  }
  return { ids, examples };
}

/** The page (pageId, snapshotId) of the manifest; see Session.notebookGet for the rules when `snapshotId` is omitted. */
function locatePage(manifest: Manifest, pageId: string, snapshotId: string | undefined): { page: PageEntry; index: number } | { error: Failure } {
  const holders = manifest.pages.filter((candidate) => candidate.pageId === pageId);
  if (holders.length === 0) return { error: failure("NOT_FOUND", `no notebook page "${pageId}"`) };
  if (snapshotId === undefined) {
    if (holders.length > 1) {
      const names = holders.map((holder) => holder.snapshotId).sort(compareCodeUnits);
      return { error: failure("INVALID_ARGUMENT", `notebook page "${pageId}" exists in ${holders.length} snapshots (${names.join(", ")}); pass snapshotId`, { errors: [{ code: "REQUIRED", pointer: "/snapshotId", constraint: "required: snapshotId when several snapshots hold the page", hint: `Pass one of: ${names.join(", ")}.` }] }) };
    }
    return { page: holders[0] as PageEntry, index: manifest.pages.indexOf(holders[0] as PageEntry) };
  }
  const page = holders.find((candidate) => candidate.snapshotId === snapshotId);
  if (page === undefined) return { error: failure("NOT_FOUND", `no notebook page "${pageId}" in snapshot "${snapshotId}"`) };
  return { page, index: manifest.pages.indexOf(page) };
}

/** Reads a stored object by content hash and verifies the hash (CLAIM(verified-reads)). */
async function readStoredObject(dir: string, hash: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(join(dir, OBJECTS, `${hash}.json`), "utf8");
  } catch (error) {
    throw new SessionStorageError("STORAGE_CORRUPT", `stored object ${hash} cannot be read: ${String(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SessionStorageError("STORAGE_CORRUPT", `stored object ${hash} is not JSON: ${String(error)}`);
  }
  if (canonicalSha256(value) !== hash) throw new SessionStorageError("STORAGE_CORRUPT", `stored object ${hash} no longer matches its recorded content hash`);
  return value;
}

/** The session at one manifest read (see SessionSnapshot). Objects are immutable and never swept, so a hash named by this manifest stays readable. */
class ManifestReader implements SessionSnapshot {
  readonly generation: number;
  readonly registryRevision: number;
  private readonly dir: string;
  private readonly manifest: Manifest;
  private readonly derived: Map<string, IndexFields>;

  // no parameter properties: Node's strip-only TypeScript (bin.smoke.test.ts) does not support them
  constructor(dir: string, manifest: Manifest, derived: Map<string, IndexFields>) {
    this.dir = dir;
    this.manifest = manifest;
    this.derived = derived;
    this.generation = manifest.generation;
    this.registryRevision = manifest.registryRevision;
  }

  private readObject(hash: string): Promise<unknown> {
    return readStoredObject(this.dir, hash);
  }

  private async withReads<T>(read: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof SessionStorageError) return failure(error.code, error.message);
      throw error;
    }
  }

  async getView(key: ViewKey): Promise<Result<StoredView>> {
    return this.withReads(async () => {
      const entry = this.manifest.views.find((candidate) => candidate.viewId === key.viewId && candidate.snapshotId === key.snapshotId);
      if (entry === undefined) return failure("NOT_FOUND", `no view "${key.viewId}" in snapshot "${key.snapshotId}"`);
      const envelope = (await this.readObject(entry.hash)) as Envelope;
      return ok({ envelope, contentHash: entry.hash });
    });
  }

  async listViews(): Promise<ViewKey[]> {
    return this.manifest.views.map(({ viewId, snapshotId }) => ({ viewId, snapshotId })).sort(byViewKey);
  }

  async listViewIndex(snapshotId?: string): Promise<ViewIndexEntry[]> {
    const found: ViewIndexEntry[] = [];
    for (const entry of this.manifest.views) {
      if (snapshotId !== undefined && entry.snapshotId !== snapshotId) continue;
      let fields: IndexFields | undefined = entry.entity !== undefined && entry.title !== undefined && entry.viewDefinitionId !== undefined && entry.completeness !== undefined
        ? { entity: entry.entity, title: entry.title, viewDefinitionId: entry.viewDefinitionId, completeness: entry.completeness }
        : this.derived.get(entry.hash);
      if (fields === undefined) {
        try {
          fields = indexFieldsOf((await this.readObject(entry.hash)) as Envelope);
        } catch (error) {
          if (error instanceof SessionStorageError) continue; // an unreadable stored view is not listed, as before the index existed; opening it reports why
          throw error;
        }
        this.derived.set(entry.hash, fields);
      }
      found.push({ viewId: entry.viewId, snapshotId: entry.snapshotId, component: entry.component, ...fields });
    }
    return found.sort(byViewKey);
  }

  async getEntity(entity: EntityRef, snapshotId: string): Promise<Result<Entity>> {
    const found = this.manifest.entities.find((candidate) => candidate.snapshotId === snapshotId && candidate.repository === entity.repository && candidate.kind === entity.kind && candidate.id === entity.id);
    return found === undefined ? failure("NOT_FOUND", `no entity ${entity.repository}/${entity.kind}/${entity.id} in snapshot "${snapshotId}"`) : ok(found);
  }

  async listEntities(snapshotId?: string): Promise<Entity[]> {
    return sortedEntities(this.manifest.entities, snapshotId);
  }

  async listDefinitions(): Promise<{ revision: number; definitions: ViewDefinition[] }> {
    return { revision: this.manifest.registryRevision, definitions: [...this.manifest.definitions].sort((a, b) => compareCodeUnits(a.id, b.id)) };
  }

  async repositories(): Promise<RepositoryRegistration[]> {
    return [...this.manifest.repositories].sort((a, b) => compareCodeUnits(a.id, b.id));
  }

  async snapshotInfo(snapshotId: string): Promise<Result<SnapshotInfo>> {
    const snapshot = ownValue(this.manifest.snapshots, snapshotId);
    if (snapshot === undefined) return failure("NOT_FOUND", `no snapshot "${snapshotId}"`);
    const viewIds = [...new Set(this.manifest.views.filter((view) => view.snapshotId === snapshotId).map((view) => view.viewId))].sort(compareCodeUnits);
    return ok({ snapshotId, predecessor: snapshot.predecessor, viewIds });
  }

  async exportBundle(): Promise<Bundle> {
    const views = [...this.manifest.views].sort(byViewKey);
    const envelopes: Envelope[] = [];
    for (const entry of views) envelopes.push((await this.readObject(entry.hash)) as Envelope);
    return {
      schemaVersion: "paneweft.bundle/1",
      entities: sortedEntities(this.manifest.entities),
      definitions: [...this.manifest.definitions].sort((a, b) => compareCodeUnits(a.id, b.id)),
      views: envelopes,
    };
  }

  async listRuns(key: ViewKey): Promise<Result<RecordedRun[]>> {
    if (!this.manifest.views.some((view) => view.viewId === key.viewId && view.snapshotId === key.snapshotId)) return failure("NOT_FOUND", `no view "${key.viewId}" in snapshot "${key.snapshotId}"`);
    return ok(this.manifest.runs.filter((run) => run.viewId === key.viewId && run.snapshotId === key.snapshotId).map(({ runId, viewId, snapshotId, status, contentHash }) => ({ runId, viewId, snapshotId, status, contentHash })));
  }

  async recordedRunOutputs(key: ViewKey): Promise<Result<Array<{ run: RecordedRun; output: unknown }>>> {
    return this.withReads(async () => {
      if (!this.manifest.views.some((view) => view.viewId === key.viewId && view.snapshotId === key.snapshotId)) return failure("NOT_FOUND", `no view "${key.viewId}" in snapshot "${key.snapshotId}"`);
      const found: Array<{ run: RecordedRun; output: unknown }> = [];
      for (const run of this.manifest.runs.filter((entry) => entry.viewId === key.viewId && entry.snapshotId === key.snapshotId)) {
        const { runId, viewId, snapshotId, status, contentHash } = run;
        found.push({ run: { runId, viewId, snapshotId, status, contentHash }, output: await this.readObject(contentHash) });
      }
      return ok(found);
    });
  }

  async notebookGet(pageId: string, revision?: number, snapshotId?: string): Promise<Result<NotebookPage>> {
    return this.withReads(async () => {
      const located = locatePage(this.manifest, pageId, snapshotId);
      if ("error" in located) return located.error;
      const { page } = located;
      const wanted = revision ?? page.revisions.length;
      const hash = page.revisions[wanted - 1];
      if (!Number.isInteger(wanted) || wanted < 1 || hash === undefined) return failure("NOT_FOUND", `notebook page "${pageId}" in snapshot "${page.snapshotId}" has no revision ${String(revision)}`);
      return ok({ pageId, snapshotId: page.snapshotId, revision: wanted, envelope: (await this.readObject(hash)) as Envelope });
    });
  }
}

// ---- the session --------------------------------------------------------------------------------------------------

class DirectorySession implements Session {
  readonly dir: string;
  private readonly hooks: SessionTestHooks;
  private closed = false;
  private readonly lockWaitMs: number;

  constructor(dir: string, options: SessionOptions) {
    this.dir = dir;
    this.hooks = options.testHooks ?? {};
    this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
  }

  // -- reading ------------------------------------------------------------------------------------------------------

  /** Reads the manifest afresh: another handle or process may have changed it since the last call. */
  private async readManifest(): Promise<Manifest> {
    let text: string;
    try {
      text = await readFile(join(this.dir, MANIFEST), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyManifest();
      throw new SessionStorageError("STORAGE_FAILED", `cannot read the session manifest: ${String(error)}`);
    }
    try {
      const manifest = JSON.parse(text) as Manifest;
      if (manifest?.schemaVersion !== "paneweft.session/1") throw new Error("unknown manifest schemaVersion");
      return manifest;
    } catch (error) {
      throw new SessionStorageError("STORAGE_CORRUPT", `the session manifest is unreadable: ${String(error)}`);
    }
  }

  private readObject(hash: string): Promise<unknown> {
    return readStoredObject(this.dir, hash);
  }

  /** One manifest read; every method of the result answers from it. */
  async snapshot(): Promise<SessionSnapshot> {
    return new ManifestReader(this.dir, await this.readManifest(), this.derivedIndex);
  }

  /** Index fields derived from stored objects of rows that lack them, by content hash (objects are immutable, so the answer never goes stale). */
  private readonly derivedIndex = new Map<string, IndexFields>();

  /** CLAIM(session-read-errors): snapshot acquisition belongs to the Result error boundary [session.read-errors.test.ts]. */
  private async withSnapshot<T>(read: (snapshot: SessionSnapshot) => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await read(await this.snapshot());
    } catch (error) {
      if (error instanceof SessionStorageError) return failure(error.code, error.message);
      throw error;
    }
  }

  getView(key: ViewKey): Promise<Result<StoredView>> { return this.withSnapshot((read) => read.getView(key)); }
  listViews(): Promise<ViewKey[]> { return this.snapshot().then((read) => read.listViews()); }
  listViewIndex(snapshotId?: string): Promise<ViewIndexEntry[]> { return this.snapshot().then((read) => read.listViewIndex(snapshotId)); }
  getEntity(entity: EntityRef, snapshotId: string): Promise<Result<Entity>> { return this.withSnapshot((read) => read.getEntity(entity, snapshotId)); }
  listEntities(snapshotId?: string): Promise<Entity[]> { return this.snapshot().then((read) => read.listEntities(snapshotId)); }
  listDefinitions(): Promise<{ revision: number; definitions: ViewDefinition[] }> { return this.snapshot().then((read) => read.listDefinitions()); }
  repositories(): Promise<RepositoryRegistration[]> { return this.snapshot().then((read) => read.repositories()); }
  snapshotInfo(snapshotId: string): Promise<Result<SnapshotInfo>> { return this.withSnapshot((read) => read.snapshotInfo(snapshotId)); }
  exportBundle(): Promise<Bundle> { return this.snapshot().then((read) => read.exportBundle()); }
  listRuns(key: ViewKey): Promise<Result<RecordedRun[]>> { return this.withSnapshot((read) => read.listRuns(key)); }
  recordedRunOutputs(key: ViewKey): Promise<Result<Array<{ run: RecordedRun; output: unknown }>>> { return this.withSnapshot((read) => read.recordedRunOutputs(key)); }
  notebookGet(pageId: string, revision?: number, snapshotId?: string): Promise<Result<NotebookPage>> { return this.withSnapshot((read) => read.notebookGet(pageId, revision, snapshotId)); }

  async registerRepository(registration: RepositoryRegistration): Promise<Result<void>> {
    if (typeof registration?.id !== "string" || registration.id === "" || typeof registration.root !== "string" || registration.root === "") {
      return failure("INVALID_ARGUMENT", "a repository registration needs a non-empty id and root");
    }
    return this.mutate<void>("registerRepository", async (manifest) => {
      const repositories = manifest.repositories.filter((entry) => entry.id !== registration.id);
      repositories.push({ id: registration.id, root: registration.root });
      return { manifest: { ...manifest, repositories }, value: undefined };
    });
  }

  // -- the mutation protocol ---------------------------------------------------------------------------------------------

  /**
   * Runs `build` under the write lock (write-lock.ts) with a freshly read manifest. `build` validates first and stages files only afterwards
   * (through `stage`), so a rejected request leaves the directory untouched. The manifest rename is the single commit point.
   * CLAIM(flock-no-premature-mutation): when the lock was not acquired (contention timeout, missing or failing `flock`) nothing is read or written
   *   and the answer is a Failure; the lock is released only after every write of the critical section has settled
   *   [session.write-lock.test.ts, write-lock.test.ts].
   */
  private async mutate<T>(
    operation: string,
    build: (manifest: Manifest, stage: (value: unknown) => Promise<string>) => Promise<{ manifest: Manifest; value: T } | { error: Failure }>,
  ): Promise<Result<T>> {
    if (this.closed) return failure("INVALID_ARGUMENT", "the session handle is closed");
    try {
      await this.hooks.beforeLockAcquire?.({ operation });
      await mkdir(this.dir, { recursive: true });
      return await withWriteLock(this.dir, { waitMs: this.lockWaitMs, onHelperSpawned: (helperPid) => this.hooks.afterHelperSpawned?.({ operation, helperPid }) }, async () => {
        await this.hooks.afterLockAcquired?.({ operation });
        const current = await this.readManifest();
        await this.hooks.afterManifestRead?.({ operation });
        let writes = 0;
        const stage = async (value: unknown): Promise<string> => {
          const text = canonicalJson(value);
          const hash = sha256Hex(text);
          const target = join(this.dir, OBJECTS, `${hash}.json`);
          const existing = await readFile(target, "utf8").catch(() => null);
          if (existing === text) return hash; // already stored, byte-identical: nothing to write
          await mkdir(join(this.dir, OBJECTS), { recursive: true });
          const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
          const handle = await open(temporary, "wx");
          try {
            await handle.writeFile(text);
            await handle.sync(); // the bytes are on disk before the name that will point at them exists
          } finally {
            await handle.close();
          }
          await rename(temporary, target);
          writes += 1;
          await this.hooks.afterWrite?.({ count: writes, path: target });
          return hash;
        };
        const built = await build(current, stage);
        if ("error" in built) return built.error;
        // CLAIM(durable-objects): every object the new manifest names is durable (file synced above; directory entries synced here) before the manifest is written
        if (writes > 0) {
          await syncDirectory(join(this.dir, OBJECTS));
          await syncDirectory(this.dir); // the objects directory itself may be new
        }
        await this.hooks.beforeManifestSwap?.({ operation });
        await this.swapManifest({ ...built.manifest, generation: current.generation + 1 }, operation);
        return ok(built.value);
      });
    } catch (error) {
      if (error instanceof WriteLockError) return lockFailure(error, operation, this.lockWaitMs);
      if (error instanceof SessionStorageError) return failure(error.code, error.message);
      return failure("STORAGE_FAILED", `${operation} could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** CLAIM(atomic-manifest): temp file in the same directory, fsync, rename over manifest.json. */
  private async swapManifest(manifest: Manifest, operation: string): Promise<void> {
    const target = join(this.dir, MANIFEST);
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(JSON.stringify(manifest));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.hooks.beforeManifestRename?.({ operation });
    await rename(temporary, target);
    await syncDirectory(this.dir);
    await this.hooks.afterManifestRename?.({ operation });
  }

  // -- validation context -----------------------------------------------------------------------------------------------

  private async contextFor(manifest: Manifest, documents: unknown[]): Promise<ReferenceContext> {
    const wanted = referencedViewIds(documents);
    const views: NonNullable<ReferenceContext["views"]> = [];
    for (const entry of manifest.views) {
      // an example block may name the scenario item of an example view, so those views are loaded whenever one is referenced
      if (!wanted.ids.has(entry.viewId) && !(wanted.examples && entry.component === "example")) continue;
      try {
        const stored = (await this.readObject(entry.hash)) as Envelope;
        views.push({ id: entry.viewId, snapshotId: entry.snapshotId, itemIds: itemIdsOf(stored), component: stored.component });
      } catch {
        // an unreadable stored view cannot vouch for references into it
      }
    }
    return {
      entities: manifest.entities.map(({ repository, id, kind, snapshotId }) => ({ repository, id, kind, snapshotId })),
      definitions: manifest.definitions.map((definition): DefinitionMetadata => ({ id: definition.id, component: definition.component, entityKind: definition.entityKind })),
      views,
    };
  }

  // -- import -----------------------------------------------------------------------------------------------------------

  /** Conflict-checks and merges validated content into `manifest`; the shared core of importBundle, putView and recordExampleRun. */
  private async merge(
    manifest: Manifest,
    content: { entities: Entity[]; definitions: ViewDefinition[]; views: Envelope[] },
    predecessor: string | undefined,
    stage: (value: unknown) => Promise<string>,
  ): Promise<{ manifest: Manifest; summary: Omit<ImportSummary, "notes"> } | { error: Failure }> {
    const entities = [...manifest.entities];
    const definitions = [...manifest.definitions];
    for (const entity of content.entities) {
      const existing = entities.find((candidate) => entityKey(candidate) === entityKey(entity));
      if (existing === undefined) entities.push(entity);
      else if (canonicalJson(existing) !== canonicalJson(entity)) return { error: failure("SNAPSHOT_CONFLICT", `entity ${entity.repository}/${entity.kind}/${entity.id} already exists in snapshot "${entity.snapshotId}" with different data; submit a new snapshot`) };
    }
    let registryChanged = false;
    for (const definition of content.definitions) {
      const index = definitions.findIndex((candidate) => candidate.id === definition.id);
      if (index < 0) { definitions.push(definition); registryChanged = true; }
      else if (canonicalJson(definitions[index]) !== canonicalJson(definition)) return { error: failure("SNAPSHOT_CONFLICT", `definition "${definition.id}" is already registered with different content; use register_view to change a definition`) };
    }
    const views = [...manifest.views];
    const pages = manifest.pages.map((page) => ({ ...page, revisions: [...page.revisions] }));
    const contentHashes: Record<string, string> = {};
    const keys: ViewKey[] = [];
    const toStore: Array<{ envelope: Envelope; hash: string }> = [];
    const queuedHashes = new Map<string, string>();
    for (const envelope of content.views) {
      const hash = canonicalSha256(envelope);
      const key = { viewId: envelope.id, snapshotId: envelope.snapshotId };
      const existing = views.find((candidate) => candidate.viewId === key.viewId && candidate.snapshotId === key.snapshotId);
      const page = pages.find((candidate) => candidate.pageId === envelope.id && candidate.snapshotId === envelope.snapshotId);
      const known = existing?.hash === hash || page?.revisions.includes(hash) === true;
      if (existing !== undefined && !known) return { error: failure("SNAPSHOT_CONFLICT", `view "${key.viewId}" already exists in snapshot "${key.snapshotId}" with different content; submit a new snapshot`) };
      const queued = queuedHashes.get(viewKey(key));
      // validate.ts lets a bundle repeat an identical view; the manifest still gets one row (and one page entry) per key
      if (queued !== undefined) {
        if (queued !== hash) return { error: failure("SNAPSHOT_CONFLICT", `view "${key.viewId}" appears twice in snapshot "${key.snapshotId}" with different content; submit a new snapshot`) };
        continue;
      }
      queuedHashes.set(viewKey(key), hash);
      contentHashes[hashesLabel(key)] = hash;
      keys.push(key);
      if (existing === undefined) toStore.push({ envelope, hash });
    }
    for (const snapshotId of new Set([...content.entities.map((entity) => entity.snapshotId), ...content.views.map((view) => view.snapshotId)])) {
      const known = ownValue(manifest.snapshots, snapshotId);
      if (known === undefined) {
        if (predecessor !== undefined && ownValue(manifest.snapshots, predecessor) === undefined && !content.views.some((view) => view.snapshotId === predecessor) && !content.entities.some((entity) => entity.snapshotId === predecessor)) {
          return { error: failure("NOT_FOUND", `predecessor snapshot "${predecessor}" does not exist`) };
        }
      } else if (predecessor !== undefined && known.predecessor !== predecessor && known.predecessor !== null) {
        return { error: failure("SNAPSHOT_CONFLICT", `snapshot "${snapshotId}" already has predecessor "${known.predecessor}"`) };
      }
    }
    // everything is decided; only now touch the disk
    for (const { envelope, hash } of toStore) {
      await stage(envelope);
      views.push({ viewId: envelope.id, snapshotId: envelope.snapshotId, hash, component: envelope.component, ...indexFieldsOf(envelope) });
      if (envelope.component === "notebook") pages.push({ pageId: envelope.id, snapshotId: envelope.snapshotId, revisions: [hash] });
    }
    const snapshots = { ...manifest.snapshots };
    for (const snapshotId of new Set([...content.entities.map((entity) => entity.snapshotId), ...content.views.map((view) => view.snapshotId)])) {
      // defineProperty: plain assignment of "__proto__" would set the prototype instead of adding the entry
      if (ownValue(snapshots, snapshotId) === undefined) Object.defineProperty(snapshots, snapshotId, { value: { predecessor: predecessor !== undefined && predecessor !== snapshotId ? predecessor : null }, enumerable: true, writable: true, configurable: true });
    }
    const registryRevision = manifest.registryRevision + (registryChanged ? 1 : 0);
    const next: Manifest = { ...manifest, entities, definitions, views, pages, snapshots, registryRevision };
    return {
      manifest: next,
      summary: { entities: content.entities.length, definitions: content.definitions.length, views: keys.sort(byViewKey), registryRevision, contentHashes },
    };
  }

  /** `manifest` with each registered definition of `replacements` replaced by the submitted one (validated like register_view); definitions not yet
   * registered are left to the merge. The registry revision advances once per replaced definition, as register_view would. */
  private replaceDefinitions(manifest: Manifest, replacements: readonly ViewDefinition[]): { manifest: Manifest } | { error: Failure } {
    let definitions = manifest.definitions;
    let registryRevision = manifest.registryRevision;
    for (const submitted of replacements) {
      const current = definitions.find((candidate) => candidate.id === submitted.id);
      if (current === undefined || canonicalJson(current) === canonicalJson(submitted)) continue;
      const report = validateDefinition(submitted, definitions);
      if (!report.ok) return { error: validationFailure("the definition", report.errors) };
      definitions = [...definitions.filter((candidate) => candidate.id !== submitted.id), submitted];
      registryRevision += 1;
    }
    return { manifest: { ...manifest, definitions, registryRevision } };
  }

  /** The admission of a bundle against `manifest`: validation with the session's reference context, then the conflict checks and the merge. */
  private async admitBundle(base: Manifest, input: unknown, predecessor: string | undefined, stage: (value: unknown) => Promise<string>, replacements: readonly ViewDefinition[] = []): Promise<{ manifest: Manifest; value: ImportSummary } | { error: Failure }> {
    const replaced = this.replaceDefinitions(base, replacements);
    if ("error" in replaced) return replaced;
    const manifest = replaced.manifest;
    const report = validateSubmission(input, await this.contextFor(manifest, (input as { views?: unknown[] } | null)?.views ?? []));
    if (!report.ok) return { error: validationFailure("the bundle", report.errors) };
    if (report.kind !== "bundle") return { error: failure("INVALID_ARGUMENT", "importBundle takes a paneweft.bundle/1 document; use putView for a single envelope", { errors: [{ code: "SCHEMA_VERSION", pointer: "/schemaVersion", constraint: 'const: "paneweft.bundle/1"', hint: 'Use the literal "paneweft.bundle/1".' }] }) };
    const merged = await this.merge(manifest, input as Bundle, predecessor, stage);
    if ("error" in merged) return merged;
    return { manifest: merged.manifest, value: { ...merged.summary, notes: report.notes } };
  }

  /** The admission of a single envelope against `manifest`; see admitBundle. */
  private async admitView(manifest: Manifest, input: unknown, predecessor: string | undefined, stage: (value: unknown) => Promise<string>): Promise<{ manifest: Manifest; value: ImportSummary } | { error: Failure }> {
    const report = validateSubmission(input, await this.contextFor(manifest, [input]));
    if (!report.ok) return { error: validationFailure("the view", report.errors) };
    if (report.kind !== "envelope") return { error: failure("INVALID_ARGUMENT", "putView takes a paneweft.view/1 envelope; use importBundle for a bundle") };
    const merged = await this.merge(manifest, { entities: [], definitions: [], views: [input as Envelope] }, predecessor, stage);
    if ("error" in merged) return merged;
    return { manifest: merged.manifest, value: { ...merged.summary, notes: report.notes } };
  }

  async importBundle(input: unknown, options: { predecessorSnapshotId?: string; replaceDefinitions?: ViewDefinition[] } = {}): Promise<Result<ImportSummary>> {
    return this.mutate<ImportSummary>("importBundle", (manifest, stage) => this.admitBundle(manifest, input, options.predecessorSnapshotId, stage, options.replaceDefinitions));
  }

  async putView(input: unknown, options: { predecessorSnapshotId?: string } = {}): Promise<Result<ImportSummary>> {
    return this.mutate<ImportSummary>("putView", (manifest, stage) => this.admitView(manifest, input, options.predecessorSnapshotId, stage));
  }

  async preflight(input: unknown, options: { predecessorSnapshotId?: string; replaceDefinitions?: ViewDefinition[] } = {}): Promise<Result<{ kind: "envelope" | "bundle"; notes: ValidationNote[] }>> {
    try {
      const manifest = await this.readManifest();
      const isBundle = typeof input === "object" && input !== null && (input as { schemaVersion?: unknown }).schemaVersion === "paneweft.bundle/1";
      const dry = async (value: unknown): Promise<string> => canonicalSha256(value); // names the object, writes nothing
      const admitted = isBundle ? await this.admitBundle(manifest, input, options.predecessorSnapshotId, dry, options.replaceDefinitions) : await this.admitView(manifest, input, options.predecessorSnapshotId, dry);
      return "error" in admitted ? admitted.error : ok({ kind: isBundle ? "bundle" as const : "envelope" as const, notes: admitted.value.notes });
    } catch (error) {
      if (error instanceof SessionStorageError) return failure(error.code, error.message);
      throw error;
    }
  }

  // -- registry ---------------------------------------------------------------------------------------------------------

  async registerView(definition: unknown, expectedRevision: number): Promise<Result<{ revision: number }>> {
    return this.mutate<{ revision: number }>("registerView", async (manifest) => {
      if (expectedRevision !== manifest.registryRevision) {
        return { error: failure("CONFLICT", `the registry is at revision ${manifest.registryRevision}, not ${expectedRevision}; re-read and retry`, { retryable: true, details: { currentRevision: manifest.registryRevision } }) };
      }
      const report = validateDefinition(definition, manifest.definitions);
      if (!report.ok) return { error: validationFailure("the definition", report.errors) };
      const submitted = definition as ViewDefinition;
      const existing = manifest.definitions.find((candidate) => candidate.id === submitted.id);
      if (existing !== undefined && canonicalJson(existing) === canonicalJson(submitted)) return { manifest, value: { revision: manifest.registryRevision } };
      const definitions = [...manifest.definitions.filter((candidate) => candidate.id !== submitted.id), submitted];
      const registryRevision = manifest.registryRevision + 1;
      return { manifest: { ...manifest, definitions, registryRevision }, value: { revision: registryRevision } };
    });
  }

  // -- notebooks --------------------------------------------------------------------------------------------------------

  async notebookCreate(input: unknown): Promise<Result<NotebookPage>> {
    return this.mutate<NotebookPage>("notebookCreate", async (manifest, stage) => {
      const report = validateSubmission(input, await this.contextFor(manifest, [input]));
      if (!report.ok) return { error: validationFailure("the notebook page", report.errors) };
      const envelope = input as Envelope;
      if (report.kind !== "envelope" || envelope.component !== "notebook") return { error: failure("INVALID_ARGUMENT", "notebook_create takes a notebook envelope (component \"notebook\")") };
      if (manifest.pages.some((page) => page.pageId === envelope.id && page.snapshotId === envelope.snapshotId)) {
        return { error: failure("CONFLICT", `notebook page "${envelope.id}" already exists in snapshot "${envelope.snapshotId}"; update it with its expected revision`, { retryable: false, details: { currentRevision: manifest.pages.find((page) => page.pageId === envelope.id && page.snapshotId === envelope.snapshotId)?.revisions.length } }) };
      }
      const merged = await this.merge(manifest, { entities: [], definitions: [], views: [envelope] }, undefined, stage);
      if ("error" in merged) return merged;
      return { manifest: merged.manifest, value: { pageId: envelope.id, snapshotId: envelope.snapshotId, revision: 1, envelope } };
    });
  }

  async notebookUpdate(pageId: string, expectedRevision: number, change: { blocks: unknown[]; sources?: unknown[] }, snapshotId?: string): Promise<Result<NotebookPage>> {
    return this.mutate<NotebookPage>("notebookUpdate", async (manifest, stage) => {
      const located = locatePage(manifest, pageId, snapshotId);
      if ("error" in located) return located;
      const { page, index } = located;
      const currentRevision = page.revisions.length;
      if (expectedRevision !== currentRevision) {
        return { error: failure("CONFLICT", `notebook page "${pageId}" in snapshot "${page.snapshotId}" is at revision ${currentRevision}, not ${expectedRevision}; re-read and retry`, { retryable: true, details: { currentRevision } }) };
      }
      const latest = (await this.readObject(page.revisions[currentRevision - 1] as string)) as Envelope;
      const envelope = { ...latest, ...(change.sources === undefined ? {} : { sources: change.sources }), data: { ...(latest.data as object), blocks: change.blocks } } as Envelope;
      const report = validateSubmission(envelope, await this.contextFor(manifest, [envelope]));
      if (!report.ok) return { error: validationFailure("the notebook page", report.errors) };
      const hash = await stage(envelope);
      const pages = manifest.pages.map((entry, position) => (position === index ? { ...entry, revisions: [...entry.revisions, hash] } : entry));
      const views = manifest.views.map((view) => (view.viewId === pageId && view.snapshotId === page.snapshotId ? { ...view, hash, ...indexFieldsOf(envelope) } : view));
      return { manifest: { ...manifest, pages, views }, value: { pageId, snapshotId: page.snapshotId, revision: currentRevision + 1, envelope } };
    });
  }

  // -- example runs -----------------------------------------------------------------------------------------------------

  async recordExampleRun(key: ViewKey, output: unknown): Promise<Result<RecordedRun>> {
    return this.mutate<RecordedRun>("recordExampleRun", async (manifest, stage) => {
      const entry = manifest.views.find((candidate) => candidate.viewId === key.viewId && candidate.snapshotId === key.snapshotId);
      if (entry === undefined) return { error: failure("NOT_FOUND", `no view "${key.viewId}" in snapshot "${key.snapshotId}"`) };
      const view = (await this.readObject(entry.hash)) as Envelope;
      if (view.component !== "example") return { error: failure("INVALID_ARGUMENT", `view "${key.viewId}" is a ${view.component} view; runs are recorded on example views`) };
      const context = await this.contextFor(manifest, ((output as { bundle?: { views?: unknown[] } } | null)?.bundle?.views) ?? []);
      const report = validateRunOutput(output, { ...context, evidenceSources: view.sources, snapshotId: key.snapshotId });
      if (!report.ok) return { error: validationFailure("the run output", report.errors) };
      const document = output as { run: { runId: string; status: RecordedRun["status"] }; bundle: Bundle };
      if (manifest.runs.some((run) => run.viewId === key.viewId && run.snapshotId === key.snapshotId && run.runId === document.run.runId)) {
        return { error: failure("DUPLICATE_RUN", `run "${document.run.runId}" is already recorded for view "${key.viewId}"`) };
      }
      const merged = await this.merge(manifest, document.bundle, undefined, stage);
      if ("error" in merged) return merged;
      const contentHash = await stage(output);
      const recorded: RecordedRun = { runId: document.run.runId, viewId: key.viewId, snapshotId: key.snapshotId, status: document.run.status, contentHash };
      return { manifest: { ...merged.manifest, runs: [...merged.manifest.runs, recorded] }, value: recorded };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** fsync of a directory: makes the entries created or renamed in it durable. */
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** How a lock that was not acquired is reported: CONFLICT (retryable) for contention, STORAGE_FAILED with `details.cause` for everything else. */
function lockFailure(error: WriteLockError, operation: string, waitMs: number): Failure {
  if (error.kind === "contended") return failure("CONFLICT", `another writer held the session lock for more than ${waitMs} ms; retry (${operation})`, { retryable: true });
  return failure("STORAGE_FAILED", `${operation} could not be saved: ${error.message}`, { details: { cause: error.kind } });
}

/** Creates the directory if needed and opens a handle. Opening reads and writes nothing; every call re-reads the manifest. */
export async function openSession(dir: string, options: SessionOptions = {}): Promise<Result<Session>> {
  if (options.lockWaitMs !== undefined && (!Number.isInteger(options.lockWaitMs) || options.lockWaitMs < 1)) {
    return failure("INVALID_ARGUMENT", `lockWaitMs must be a whole number of milliseconds, at least 1; got ${String(options.lockWaitMs)}`);
  }
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    return failure("STORAGE_FAILED", `cannot create the session directory "${dir}": ${error instanceof Error ? error.message : String(error)}`);
  }
  return ok(new DirectorySession(dir, options));
}
