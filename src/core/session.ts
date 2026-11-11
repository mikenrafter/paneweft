// Immutable session storage (design section 5): canonical JSON files plus a small manifest,
// no database. An explicit session directory owns the data.
//
// Layout of a session directory:
//   manifest.json          the ONLY mutable file: registry, entities, snapshot table, view/page/run index. Replaced atomically.
//   objects/<sha256>.json  immutable canonical JSON of one stored view, notebook revision or run output, named by its content hash.
//   .lock/                 exists only while a process mutates the session; its `owner` file records who holds it (boot id, pid, start time, token).
//   .lock.recovery/        exists only while a contender removes a dead owner's lock (see breakStaleLock); same record. .lock.stale.* and
//                          .lock.recovery.stale.* are tombstones, .lock.new.* staging directories; a crash can leave them, and they are removed once their
//                          recorded process is dead.
//   server.json            written and removed by the viewer server; not part of the session state.
//
// CLAIM(atomic-manifest): the manifest is replaced atomically (write a temp file, fsync, rename), so a crash or injected failure
//   leaves the previous state fully readable [design section 5; session.test.ts, MC16, MC20].
// CLAIM(snapshot-immutable): a stored (viewId, snapshotId) never changes; different content under the same key is
//   SNAPSHOT_CONFLICT, identical content is idempotent [design section 4; MC20].
// CLAIM(process-lock): every mutation holds the session lock from BEFORE it reads mutable state until after the manifest swap, so
//   two processes (or two handles) serialise and neither can act on a stale read [session.processes.test.ts, S5].
// CLAIM(verified-reads): a stored object is read only through the manifest, and its canonical hash must equal the one the manifest
//   recorded; a tampered, truncated or emptied file is STORAGE_CORRUPT, never silently served; a file nobody registered is invisible
//   [session.atomic.test.ts, MC20].
// Errors: methods return Result<T>; they never throw for domain failures. Readers that return plain arrays throw a
//   `SessionStorageError` only when the manifest itself is unreadable.
import { mkdir, open, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Bundle, Entity, EntityRef, Envelope, ViewDefinition } from "./wire.ts";
import type { OperationError, Result, ValidationIssue } from "./errors.ts";
import { canonicalJson, compareCodeUnits, ownValue } from "./canonical.ts";
import { canonicalSha256, sha256Hex } from "./digest.ts";
import { viewItems } from "./items.ts";
import { identityOf, isAlive, type ProcessIdentity } from "./process-identity.ts";
import { validateDefinition, validateRunOutput, validateSubmission, type DefinitionMetadata, type ReferenceContext } from "./validate.ts";

export interface ViewKey { viewId: string; snapshotId: string }
export interface RepositoryRegistration { id: string; root: string }
export interface StoredView { envelope: Envelope; contentHash: string }
export interface SnapshotInfo { snapshotId: string; predecessor: string | null; viewIds: string[] }
export interface ImportSummary {
  entities: number;
  definitions: number;
  views: ViewKey[];
  registryRevision: number;
  /** `${viewId}@${snapshotId}` -> sha256 of the canonical JSON of the stored envelope. */
  contentHashes: Record<string, string>;
}
export interface NotebookPage { pageId: string; snapshotId: string; revision: number; envelope: Envelope }
export interface RecordedRun { runId: string; viewId: string; snapshotId: string; status: "passed" | "failed" | "error"; contentHash: string }

/** Failure injection for tests of atomicity (MC16, MC20). Never set in production code paths. */
export interface SessionTestHooks {
  /** S5: immediately before trying the process lock, before reading mutable manifest state. */
  beforeLockAcquire?: (info: { operation: string }) => void | Promise<void>;
  /** S5: a lock attempt found another process holding it, before waiting or returning CONFLICT. */
  onLockContended?: (info: { operation: string }) => void | Promise<void>;
  /** S5: after reading the manifest INSIDE the lock; held until the hook resolves. */
  afterManifestRead?: (info: { operation: string }) => void | Promise<void>;
  /** S2: a contender decided the lock's owner is dead, before it tries to break the lock. Other contenders may finish recovery while this is held. */
  afterStaleObserved?: (info: { operation: string }) => void | Promise<void>;
  /** S2: that contender's attempt to break the stale lock finished; `broke` says whether it removed the lock it had judged stale. */
  afterStaleResolved?: (info: { operation: string; broke: boolean }) => void | Promise<void>;
  /** S2 round 2: this contender holds the recovery mutex, before it re-reads the main lock. */
  afterRecoveryMutexTaken?: (info: { operation: string }) => void | Promise<void>;
  /** S2 round 2: a contender found the recovery mutex's holder dead, before it takes the mutex away. */
  afterMutexStaleObserved?: (info: { operation: string }) => void | Promise<void>;
  /** S2 round 2: `target` (the main lock or the recovery mutex) was just renamed to a tombstone and has not been verified yet. */
  afterDisplaced?: (info: { operation: string; target: "lock" | "recovery" }) => void | Promise<void>;
  /** S2 flock: the lock helper was spawned (its pid), before the lock is known to be held. Reported while the helper may still be waiting. */
  afterHelperSpawned?: (info: { operation: string; helperPid: number }) => void | Promise<void>;
  /** S2 flock: the helper reported the lock acquired; nothing mutable has been read yet. */
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
  /** How long a mutation waits for a lock held by a live process before it answers CONFLICT. Default 15 seconds. */
  lockWaitMs?: number;
}

export interface Session {
  readonly dir: string;
  importBundle(input: unknown, options?: { predecessorSnapshotId?: string }): Promise<Result<ImportSummary>>;
  /** A single envelope; its entity and view definition must already be registered. */
  putView(input: unknown, options?: { predecessorSnapshotId?: string }): Promise<Result<ImportSummary>>;
  getView(key: ViewKey): Promise<Result<StoredView>>;
  listViews(): Promise<ViewKey[]>;
  getEntity(entity: EntityRef, snapshotId: string): Promise<Result<Entity>>;
  listEntities(snapshotId?: string): Promise<Entity[]>;
  listDefinitions(): Promise<{ revision: number; definitions: ViewDefinition[] }>;
  registerView(definition: unknown, expectedRevision: number): Promise<Result<{ revision: number }>>;
  registerRepository(registration: RepositoryRegistration): Promise<Result<void>>;
  repositories(): Promise<RepositoryRegistration[]>;
  snapshotInfo(snapshotId: string): Promise<Result<SnapshotInfo>>;
  exportBundle(): Promise<Bundle>;
  notebookCreate(input: unknown): Promise<Result<NotebookPage>>;
  /**
   * A page is addressed by (pageId, snapshotId). `snapshotId` may be omitted only while exactly one snapshot holds the pageId; with several the call
   * is INVALID_ARGUMENT naming them (CLAIM(notebook-snapshot-identity)); an unknown snapshot or page is NOT_FOUND.
   */
  notebookGet(pageId: string, revision?: number, snapshotId?: string): Promise<Result<NotebookPage>>;
  notebookUpdate(pageId: string, expectedRevision: number, change: { blocks: unknown[]; sources?: unknown[] }, snapshotId?: string): Promise<Result<NotebookPage>>;
  recordExampleRun(key: ViewKey, output: unknown): Promise<Result<RecordedRun>>;
  listRuns(key: ViewKey): Promise<Result<RecordedRun[]>>;
  /** The runs recorded on an example view with their stored `paneweft.run/1` outputs, in recording order; each output is read through its verified content hash. */
  recordedRunOutputs(key: ViewKey): Promise<Result<Array<{ run: RecordedRun; output: unknown }>>>;
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

interface ViewEntry { viewId: string; snapshotId: string; hash: string; component: Envelope["component"] }
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
const LOCK = ".lock";
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 5;

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

// ---- the session --------------------------------------------------------------------------------------------------

class DirectorySession implements Session {
  readonly dir: string;
  private readonly hooks: SessionTestHooks;
  private closed = false;
  private readonly lockWaitMs: number;
  /** Whether the start-up sweep of crashed processes' leftovers has run for this handle. */
  private swept = false;

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

  private async readObject(hash: string): Promise<unknown> {
    let text: string;
    try {
      text = await readFile(join(this.dir, OBJECTS, `${hash}.json`), "utf8");
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
      const manifest = await this.readManifest();
      const entry = manifest.views.find((candidate) => candidate.viewId === key.viewId && candidate.snapshotId === key.snapshotId);
      if (entry === undefined) return failure("NOT_FOUND", `no view "${key.viewId}" in snapshot "${key.snapshotId}"`);
      const envelope = (await this.readObject(entry.hash)) as Envelope;
      return ok({ envelope, contentHash: entry.hash });
    });
  }

  async listViews(): Promise<ViewKey[]> {
    return (await this.readManifest()).views.map(({ viewId, snapshotId }) => ({ viewId, snapshotId })).sort(byViewKey);
  }

  async getEntity(entity: EntityRef, snapshotId: string): Promise<Result<Entity>> {
    return this.withReads(async () => {
      const manifest = await this.readManifest();
      const found = manifest.entities.find((candidate) => candidate.snapshotId === snapshotId && candidate.repository === entity.repository && candidate.kind === entity.kind && candidate.id === entity.id);
      return found === undefined ? failure("NOT_FOUND", `no entity ${entity.repository}/${entity.kind}/${entity.id} in snapshot "${snapshotId}"`) : ok(found);
    });
  }

  async listEntities(snapshotId?: string): Promise<Entity[]> {
    const entities = (await this.readManifest()).entities.filter((entity) => snapshotId === undefined || entity.snapshotId === snapshotId);
    return entities.sort((a, b) => compareCodeUnits(a.repository, b.repository) || compareCodeUnits(a.id, b.id) || compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.snapshotId, b.snapshotId));
  }

  async listDefinitions(): Promise<{ revision: number; definitions: ViewDefinition[] }> {
    const manifest = await this.readManifest();
    return { revision: manifest.registryRevision, definitions: [...manifest.definitions].sort((a, b) => compareCodeUnits(a.id, b.id)) };
  }

  async repositories(): Promise<RepositoryRegistration[]> {
    return [...(await this.readManifest()).repositories].sort((a, b) => compareCodeUnits(a.id, b.id));
  }

  async snapshotInfo(snapshotId: string): Promise<Result<SnapshotInfo>> {
    return this.withReads(async () => {
      const manifest = await this.readManifest();
      const snapshot = ownValue(manifest.snapshots, snapshotId);
      if (snapshot === undefined) return failure("NOT_FOUND", `no snapshot "${snapshotId}"`);
      const viewIds = [...new Set(manifest.views.filter((view) => view.snapshotId === snapshotId).map((view) => view.viewId))].sort(compareCodeUnits);
      return ok({ snapshotId, predecessor: snapshot.predecessor, viewIds });
    });
  }

  async exportBundle(): Promise<Bundle> {
    const manifest = await this.readManifest();
    const views = [...manifest.views].sort(byViewKey);
    const envelopes: Envelope[] = [];
    for (const entry of views) envelopes.push((await this.readObject(entry.hash)) as Envelope);
    return {
      schemaVersion: "paneweft.bundle/1",
      entities: await this.listEntities(),
      definitions: [...manifest.definitions].sort((a, b) => compareCodeUnits(a.id, b.id)),
      views: envelopes,
    };
  }

  async listRuns(key: ViewKey): Promise<Result<RecordedRun[]>> {
    return this.withReads(async () => {
      const manifest = await this.readManifest();
      if (!manifest.views.some((view) => view.viewId === key.viewId && view.snapshotId === key.snapshotId)) return failure("NOT_FOUND", `no view "${key.viewId}" in snapshot "${key.snapshotId}"`);
      return ok(manifest.runs.filter((run) => run.viewId === key.viewId && run.snapshotId === key.snapshotId).map(({ runId, viewId, snapshotId, status, contentHash }) => ({ runId, viewId, snapshotId, status, contentHash })));
    });
  }

  async recordedRunOutputs(key: ViewKey): Promise<Result<Array<{ run: RecordedRun; output: unknown }>>> {
    return this.withReads(async () => {
      const manifest = await this.readManifest();
      if (!manifest.views.some((view) => view.viewId === key.viewId && view.snapshotId === key.snapshotId)) return failure("NOT_FOUND", `no view "${key.viewId}" in snapshot "${key.snapshotId}"`);
      const found: Array<{ run: RecordedRun; output: unknown }> = [];
      for (const run of manifest.runs.filter((entry) => entry.viewId === key.viewId && entry.snapshotId === key.snapshotId)) {
        const { runId, viewId, snapshotId, status, contentHash } = run;
        found.push({ run: { runId, viewId, snapshotId, status, contentHash }, output: await this.readObject(contentHash) });
      }
      return ok(found);
    });
  }

  async notebookGet(pageId: string, revision?: number, snapshotId?: string): Promise<Result<NotebookPage>> {
    return this.withReads(async () => {
      const manifest = await this.readManifest();
      const located = locatePage(manifest, pageId, snapshotId);
      if ("error" in located) return located.error;
      const { page } = located;
      const wanted = revision ?? page.revisions.length;
      const hash = page.revisions[wanted - 1];
      if (!Number.isInteger(wanted) || wanted < 1 || hash === undefined) return failure("NOT_FOUND", `notebook page "${pageId}" in snapshot "${page.snapshotId}" has no revision ${String(revision)}`);
      return ok({ pageId, snapshotId: page.snapshotId, revision: wanted, envelope: (await this.readObject(hash)) as Envelope });
    });
  }

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

  private async acquireLock(operation: string): Promise<() => Promise<void>> {
    await mkdir(this.dir, { recursive: true });
    const lock = join(this.dir, LOCK);
    const doc = await newLockDoc();
    if (!this.swept) {
      this.swept = true;
      await this.sweepOrphans(operation); // start-up: whatever a crashed process left behind
    }
    const deadline = Date.now() + this.lockWaitMs;
    let contended = false;
    for (;;) {
      if (await publishLock(this.dir, lock, doc)) return () => releaseLock(lock, doc.token);
      if (!contended) {
        contended = true;
        await this.hooks.onLockContended?.({ operation });
      }
      if (await this.breakStaleLock(lock, operation)) continue;
      if (Date.now() > deadline) throw new LockTimeout();
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  /**
   * Stale-lock recovery (review S2, round 2). A lock is stale ONLY when the process identity it records is dead (process-identity.ts);
   * its age proves nothing. It is removed by exactly one contender at a time, and never a lock that is not the one that was judged dead.
   * CLAIM(stale-lock-recovery): a contender removes a lock only (1) inside the recovery mutex `.lock.recovery`, which is itself a lock with a
   *   recorded identity and is reaped only when that identity is dead (and then by the same move-aside-and-verify step), (2) after re-reading the
   *   lock there and finding the SAME dead identity (same token) it first judged stale, (3) by renaming it to a unique tombstone (atomic, so the
   *   lock never half exists), and (4) after verifying the tombstone still holds that dead identity; otherwise the tombstone is put back (a
   *   rename that fails while the path is retaken) and, if it cannot be put back, the displacement is reported as STORAGE_FAILED. Tombstones and
   *   staging directories of dead identities left by a crash are removed at start-up and before each recovery
   *   [session.stale-lock.test.ts, session.lock-recovery.test.ts].
   * Why a mutex and a tombstone: a rename is by NAME, so a contender that judged an old lock dead could otherwise take the live replacement
   *   another contender just created. Re-judging inside the mutex stops that; the tombstone check detects a violated mutex.
   * Returns true when the lock this contender judged stale is gone and the acquire should be retried at once.
   */
  private async breakStaleLock(lock: string, operation: string): Promise<boolean> {
    const observed = await inspectLock(lock);
    if (observed.kind === "gone") return true; // released or already recovered: just try to acquire
    if (observed.kind === "held") return false;
    await this.hooks.afterStaleObserved?.({ operation });
    const broke = await this.withRecoveryMutex(operation, false, async () => {
      await this.removeOrphans();
      const current = await inspectLock(lock);
      if (current.kind !== "dead" || current.doc.token !== observed.doc.token) return false; // gone, replaced or revived since it was judged
      return this.displaceDead(lock, observed.doc, "lock", operation);
    });
    await this.hooks.afterStaleResolved?.({ operation, broke });
    return broke;
  }

  /**
   * Runs `work` holding the recovery mutex, or answers `busy` without running it: the mutex is held by a live process (never reaped, however
   * old) or could not be made. A mutex whose holder is dead is taken away here, and the caller polls and tries again.
   */
  private async withRecoveryMutex<T>(operation: string, busy: T, work: () => Promise<T>): Promise<T> {
    const mutex = join(this.dir, RECOVERY);
    const mine = await newLockDoc();
    if (!(await publishLock(this.dir, mutex, mine))) {
      const holder = await inspectLock(mutex);
      if (holder.kind === "dead") {
        await this.hooks.afterMutexStaleObserved?.({ operation });
        await this.displaceDead(mutex, holder.doc, "recovery", operation);
      }
      return busy;
    }
    try {
      await this.hooks.afterRecoveryMutexTaken?.({ operation });
      return await work();
    } finally {
      await releaseLock(mutex, mine.token);
    }
  }

  /**
   * Moves the dead lock `observed` at `path` aside and discards it, but only if what was moved really is that dead lock. Anything else
   * (a live owner took the path after `observed` was read) is put back; if the path has been retaken meanwhile it cannot be, and that is reported.
   * Returns true when the dead lock is gone.
   */
  private async displaceDead(path: string, observed: LockDoc, target: "lock" | "recovery", operation: string): Promise<boolean> {
    const tombstone = `${path}.stale.${randomBytes(8).toString("hex")}`;
    try {
      await rename(path, tombstone);
    } catch {
      return false; // gone already, or not movable: judge again
    }
    await this.hooks.afterDisplaced?.({ operation, target });
    const held = await readOwner(tombstone);
    if (held === "gone") return true; // a sweeper removed it first, and sweepers remove only dead identities
    if (held !== "unreadable" && held.token === observed.token && !(await isAlive(held))) {
      await rm(tombstone, { recursive: true, force: true });
      return true;
    }
    try {
      await rename(tombstone, path);
      return false;
    } catch {
      if (held !== "unreadable" && !(await isAlive(held))) {
        await rm(tombstone, { recursive: true, force: true }); // a dead lock of somebody else: nothing alive was displaced
        return false;
      }
      throw new SessionStorageError("STORAGE_FAILED", `a session ${target === "lock" ? "lock" : "recovery lock"} that may belong to a running process was displaced during recovery and could not be restored because its path was taken again; it is kept at "${tombstone}"`);
    }
  }

  /** Start-up sweep: removes the leftovers of crashed processes if there are any, taking a dead recovery mutex away on the way. */
  private async sweepOrphans(operation: string): Promise<void> {
    if (!(await readdir(this.dir)).some((name) => name.startsWith(`${LOCK}.`))) return;
    for (let attempt = 0; attempt < 2; attempt += 1) { // the second attempt follows the reaping of a dead mutex on the first
      if (await this.withRecoveryMutex(operation, false, async () => { await this.removeOrphans(); return true; })) return;
    }
  }

  /** Removes staging directories and tombstones whose recorded identity is dead. A live or unattributable one is never touched. Needs the mutex. */
  private async removeOrphans(): Promise<void> {
    for (const name of await readdir(this.dir)) {
      const path = join(this.dir, name);
      const staging = STAGING_NAME.exec(name);
      if (staging !== null) {
        const [, bootId, pid, startTime] = staging as unknown as [string, string, string, string];
        if (!(await isAlive({ bootId: bootId === "-" ? null : bootId, pid: Number(pid), startTime: startTime === "-" ? null : Number(startTime) }))) await rm(path, { recursive: true, force: true });
      } else if (TOMBSTONE_NAME.test(name)) {
        const held = await readOwner(path);
        if (held !== "gone" && held !== "unreadable" && !(await isAlive(held))) await rm(path, { recursive: true, force: true });
      }
    }
  }

  /**
   * Runs `build` under the process lock with a freshly read manifest. `build` validates first and stages files only afterwards (through
   * `stage`), so a rejected request leaves the directory untouched. The manifest swap is the single commit point.
   */
  private async mutate<T>(
    operation: string,
    build: (manifest: Manifest, stage: (value: unknown) => Promise<string>) => Promise<{ manifest: Manifest; value: T } | { error: Failure }>,
  ): Promise<Result<T>> {
    if (this.closed) return failure("INVALID_ARGUMENT", "the session handle is closed");
    let release: (() => Promise<void>) | null = null;
    try {
      await this.hooks.beforeLockAcquire?.({ operation });
      release = await this.acquireLock(operation);
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
        await writeFile(temporary, text);
        await rename(temporary, target);
        writes += 1;
        await this.hooks.afterWrite?.({ count: writes, path: target });
        return hash;
      };
      const built = await build(current, stage);
      if ("error" in built) return built.error;
      await this.hooks.beforeManifestSwap?.({ operation });
      await this.swapManifest({ ...built.manifest, generation: current.generation + 1 });
      return ok(built.value);
    } catch (error) {
      if (error instanceof LockTimeout) return failure("CONFLICT", `another writer holds the session lock; retry (${operation})`, { retryable: true });
      if (error instanceof SessionStorageError) return failure(error.code, error.message);
      return failure("STORAGE_FAILED", `${operation} could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await release?.();
    }
  }

  /** CLAIM(atomic-manifest): temp file in the same directory, fsync, rename over manifest.json. */
  private async swapManifest(manifest: Manifest): Promise<void> {
    const target = join(this.dir, MANIFEST);
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(JSON.stringify(manifest));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
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
  ): Promise<{ manifest: Manifest; summary: ImportSummary } | { error: Failure }> {
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
    for (const envelope of content.views) {
      const hash = canonicalSha256(envelope);
      const key = { viewId: envelope.id, snapshotId: envelope.snapshotId };
      const existing = views.find((candidate) => candidate.viewId === key.viewId && candidate.snapshotId === key.snapshotId);
      const page = pages.find((candidate) => candidate.pageId === envelope.id && candidate.snapshotId === envelope.snapshotId);
      const known = existing?.hash === hash || page?.revisions.includes(hash) === true;
      if (existing !== undefined && !known) return { error: failure("SNAPSHOT_CONFLICT", `view "${key.viewId}" already exists in snapshot "${key.snapshotId}" with different content; submit a new snapshot`) };
      contentHashes[hashesLabel(key)] = hash;
      if (!keys.some((candidate) => viewKey(candidate) === viewKey(key))) keys.push(key);
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
      views.push({ viewId: envelope.id, snapshotId: envelope.snapshotId, hash, component: envelope.component });
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

  async importBundle(input: unknown, options: { predecessorSnapshotId?: string } = {}): Promise<Result<ImportSummary>> {
    return this.mutate<ImportSummary>("importBundle", async (manifest, stage) => {
      const report = validateSubmission(input, await this.contextFor(manifest, (input as { views?: unknown[] } | null)?.views ?? []));
      if (!report.ok) return { error: validationFailure("the bundle", report.errors) };
      if (report.kind !== "bundle") return { error: failure("INVALID_ARGUMENT", "importBundle takes a paneweft.bundle/1 document; use putView for a single envelope", { errors: [{ code: "SCHEMA_VERSION", pointer: "/schemaVersion", constraint: 'const: "paneweft.bundle/1"', hint: 'Use the literal "paneweft.bundle/1".' }] }) };
      const merged = await this.merge(manifest, input as Bundle, options.predecessorSnapshotId, stage);
      if ("error" in merged) return merged;
      return { manifest: merged.manifest, value: merged.summary };
    });
  }

  async putView(input: unknown, options: { predecessorSnapshotId?: string } = {}): Promise<Result<ImportSummary>> {
    return this.mutate<ImportSummary>("putView", async (manifest, stage) => {
      const report = validateSubmission(input, await this.contextFor(manifest, [input]));
      if (!report.ok) return { error: validationFailure("the view", report.errors) };
      if (report.kind !== "envelope") return { error: failure("INVALID_ARGUMENT", "putView takes a paneweft.view/1 envelope; use importBundle for a bundle") };
      const merged = await this.merge(manifest, { entities: [], definitions: [], views: [input as Envelope] }, options.predecessorSnapshotId, stage);
      if ("error" in merged) return merged;
      return { manifest: merged.manifest, value: merged.summary };
    });
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
      const views = manifest.views.map((view) => (view.viewId === pageId && view.snapshotId === page.snapshotId ? { ...view, hash } : view));
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

class LockTimeout extends Error {}

// ---- the process lock: records, publication, inspection ----------------------------------------------------------------
// A lock (`.lock`) and the recovery mutex (`.lock.recovery`) are directories holding one file, `owner`, with the holder's identity and a
// token unique to this acquisition. A lock is PUBLISHED by building the directory under a staging name and renaming it into place, so it
// exists with its owner record or not at all; rename onto an existing lock fails (ENOTEMPTY), which is the exclusion.

/** What a lock records: who holds it (process-identity.ts) and which acquisition it is. Records from older code may lack boot id and start time. */
interface LockDoc extends ProcessIdentity { token: string }
/** `held` is a live holder, or a lock nobody can be attributed to (never judged stale: its age proves nothing). */
type LockState = { kind: "gone" } | { kind: "held" } | { kind: "dead"; doc: LockDoc };

const RECOVERY = `${LOCK}.recovery`;
const STAGING_NAME = /^\.lock\.new\.([0-9a-f-]+|-)\.(\d+)\.(\d+|-)\.[0-9a-f]+$/;
const TOMBSTONE_NAME = /^\.lock(?:\.recovery)?\.stale\./;

async function newLockDoc(): Promise<LockDoc> {
  return { ...(await identityOf(process.pid)), token: `${process.pid}-${randomBytes(8).toString("hex")}` };
}

/** Creates `target` holding `doc`, atomically; false when it already exists. */
async function publishLock(dir: string, target: string, doc: LockDoc): Promise<boolean> {
  const staging = join(dir, `${LOCK}.new.${doc.bootId ?? "-"}.${doc.pid}.${doc.startTime ?? "-"}.${randomBytes(6).toString("hex")}`);
  await mkdir(staging);
  try {
    await writeFile(join(staging, "owner"), JSON.stringify(doc));
    await rename(staging, target);
    return true;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw error;
  }
}

/** Removes the lock at `path` if it is still this acquisition's. A lock somebody else holds now is not ours to remove. */
async function releaseLock(path: string, token: string): Promise<void> {
  try {
    const held = await readOwner(path);
    if (held === "gone" || held === "unreadable" || held.token !== token) return;
    await unlink(join(path, "owner"));
    await rmdir(path);
  } catch { /* already gone, or replaced between the two steps */ }
}

async function readOwner(path: string): Promise<LockDoc | "gone" | "unreadable"> {
  let text: string;
  try {
    text = await readFile(join(path, "owner"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") return "unreadable";
    return (await stat(path).then(() => true, () => false)) ? "unreadable" : "gone";
  }
  try {
    const doc = JSON.parse(text) as Partial<Record<keyof LockDoc, unknown>>;
    const { pid, token, bootId, startTime } = doc;
    if (!Number.isInteger(pid) || (pid as number) < 1 || typeof token !== "string") return "unreadable";
    if ((bootId !== undefined && bootId !== null && typeof bootId !== "string") || (startTime !== undefined && startTime !== null && typeof startTime !== "number")) return "unreadable";
    return { pid: pid as number, token, bootId: (bootId as string | null | undefined) ?? null, startTime: (startTime as number | null | undefined) ?? null };
  } catch {
    return "unreadable";
  }
}

async function inspectLock(path: string): Promise<LockState> {
  const doc = await readOwner(path);
  if (doc === "gone") return { kind: "gone" };
  if (doc === "unreadable") return { kind: "held" };
  return (await isAlive(doc)) ? { kind: "held" } : { kind: "dead", doc };
}

/** Creates the directory if needed and opens a handle. Opening reads and writes nothing; every call re-reads the manifest. */
export async function openSession(dir: string, options: SessionOptions = {}): Promise<Result<Session>> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    return failure("STORAGE_FAILED", `cannot create the session directory "${dir}": ${error instanceof Error ? error.message : String(error)}`);
  }
  return ok(new DirectorySession(dir, options));
}
