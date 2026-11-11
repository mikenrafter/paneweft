// Immutable session storage (design section 5): canonical JSON files plus a small manifest,
// no database. An explicit session directory owns the data.
//
// Layout of a session directory:
//   manifest.json          the ONLY mutable file: registry, entities, snapshot table, view/page/run index. Replaced atomically.
//   objects/<sha256>.json  immutable canonical JSON of one stored view, notebook revision or run output, named by its content hash.
//   .lock/                 exists only while a process mutates the session (mkdir is the atomic acquire).
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
import { mkdir, open, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Bundle, Entity, EntityRef, Envelope, ViewDefinition } from "./wire.ts";
import type { OperationError, Result, ValidationIssue } from "./errors.ts";
import { canonicalJson, compareCodeUnits } from "./canonical.ts";
import { canonicalSha256, sha256Hex } from "./digest.ts";
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
export interface NotebookPage { pageId: string; revision: number; envelope: Envelope }
export interface RecordedRun { runId: string; viewId: string; snapshotId: string; status: "passed" | "failed" | "error"; contentHash: string }

/** Failure injection for tests of atomicity (MC16, MC20). Never set in production code paths. */
export interface SessionTestHooks {
  /** S5: immediately before trying the process lock, before reading mutable manifest state. */
  beforeLockAcquire?: (info: { operation: string }) => void | Promise<void>;
  /** S5: a lock attempt found another process holding it, before waiting or returning CONFLICT. */
  onLockContended?: (info: { operation: string }) => void | Promise<void>;
  /** S5: after reading the manifest INSIDE the lock; held until the hook resolves. */
  afterManifestRead?: (info: { operation: string }) => void | Promise<void>;
  /** Called immediately before the manifest swap of a mutation; throwing simulates a failed save. */
  beforeManifestSwap?: (info: { operation: string }) => void | Promise<void>;
  /** Called after each file written while staging a mutation. */
  afterWrite?: (info: { count: number; path: string }) => void | Promise<void>;
}
export interface SessionOptions { testHooks?: SessionTestHooks }

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
  notebookGet(pageId: string, revision?: number): Promise<Result<NotebookPage>>;
  notebookUpdate(pageId: string, expectedRevision: number, change: { blocks: unknown[]; sources?: unknown[] }): Promise<Result<NotebookPage>>;
  recordExampleRun(key: ViewKey, output: unknown): Promise<Result<RecordedRun>>;
  listRuns(key: ViewKey): Promise<Result<RecordedRun[]>>;
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
function itemIdsOf(envelope: Envelope): string[] {
  const data = envelope.data as Record<string, any> | undefined;
  if (data === undefined) return [];
  const ids: string[] = [];
  const take = (items: unknown) => { for (const item of Array.isArray(items) ? items : []) if (item && typeof item.id === "string") ids.push(item.id); };
  switch (envelope.component) {
    case "list": take(data.rows); break;
    case "tree": take(data.nodes); break;
    case "graph": take(data.nodes); take(data.edges); break;
    case "source": take([data.excerpt]); take(data.annotations); break;
    case "shape": take(data.fields); break;
    case "notebook": take(data.blocks); break;
    case "example":
      take([data.scenario]); take(data.runs);
      for (const run of Array.isArray(data.runs) ? data.runs : []) take(run.assertions);
      break;
  }
  return ids;
}

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

// ---- the session --------------------------------------------------------------------------------------------------

class DirectorySession implements Session {
  readonly dir: string;
  private readonly hooks: SessionTestHooks;
  private closed = false;

  constructor(dir: string, options: SessionOptions) {
    this.dir = dir;
    this.hooks = options.testHooks ?? {};
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
      const snapshot = manifest.snapshots[snapshotId];
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

  async notebookGet(pageId: string, revision?: number): Promise<Result<NotebookPage>> {
    return this.withReads(async () => {
      const manifest = await this.readManifest();
      const page = [...manifest.pages].reverse().find((candidate) => candidate.pageId === pageId);
      if (page === undefined) return failure("NOT_FOUND", `no notebook page "${pageId}"`);
      const wanted = revision ?? page.revisions.length;
      const hash = page.revisions[wanted - 1];
      if (!Number.isInteger(wanted) || wanted < 1 || hash === undefined) return failure("NOT_FOUND", `notebook page "${pageId}" has no revision ${String(revision)}`);
      return ok({ pageId, revision: wanted, envelope: (await this.readObject(hash)) as Envelope });
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
    const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    let contended = false;
    for (;;) {
      try {
        await mkdir(lock);
        await writeFile(join(lock, "owner"), JSON.stringify({ pid: process.pid, token }));
        return async () => {
          try {
            const owner = JSON.parse(await readFile(join(lock, "owner"), "utf8")) as { token?: string };
            if (owner.token !== token) return; // somebody broke our lock as stale; it is not ours to remove any more
            await unlink(join(lock, "owner"));
            await rmdir(lock);
          } catch { /* already gone */ }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (!contended) {
        contended = true;
        await this.hooks.onLockContended?.({ operation });
      }
      if (await this.breakStaleLock(lock)) continue;
      if (Date.now() > deadline) throw new LockTimeout();
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  /** A lock whose owner process is gone (and that is not brand new) is removed. */
  private async breakStaleLock(lock: string): Promise<boolean> {
    try {
      const info = await stat(lock);
      const text = await readFile(join(lock, "owner"), "utf8").catch(() => null);
      const owner = text === null ? null : (JSON.parse(text) as { pid?: number });
      const age = Date.now() - info.mtimeMs;
      const ownerAlive = owner?.pid === undefined ? age < 5_000 : processIsAlive(owner.pid);
      if (ownerAlive) return false;
      await unlink(join(lock, "owner")).catch(() => {});
      await rmdir(lock);
      return true;
    } catch {
      return false;
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
      const known = manifest.snapshots[snapshotId];
      if (known === undefined) {
        if (predecessor !== undefined && manifest.snapshots[predecessor] === undefined && !content.views.some((view) => view.snapshotId === predecessor) && !content.entities.some((entity) => entity.snapshotId === predecessor)) {
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
      if (snapshots[snapshotId] === undefined) snapshots[snapshotId] = { predecessor: predecessor !== undefined && predecessor !== snapshotId ? predecessor : null };
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
      return { manifest: merged.manifest, value: { pageId: envelope.id, revision: 1, envelope } };
    });
  }

  async notebookUpdate(pageId: string, expectedRevision: number, change: { blocks: unknown[]; sources?: unknown[] }): Promise<Result<NotebookPage>> {
    return this.mutate<NotebookPage>("notebookUpdate", async (manifest, stage) => {
      const index = manifest.pages.map((page) => page.pageId).lastIndexOf(pageId);
      const page = manifest.pages[index];
      if (page === undefined) return { error: failure("NOT_FOUND", `no notebook page "${pageId}"`) };
      const currentRevision = page.revisions.length;
      if (expectedRevision !== currentRevision) {
        return { error: failure("CONFLICT", `notebook page "${pageId}" is at revision ${currentRevision}, not ${expectedRevision}; re-read and retry`, { retryable: true, details: { currentRevision } }) };
      }
      const latest = (await this.readObject(page.revisions[currentRevision - 1] as string)) as Envelope;
      const envelope = { ...latest, ...(change.sources === undefined ? {} : { sources: change.sources }), data: { ...(latest.data as object), blocks: change.blocks } } as Envelope;
      const report = validateSubmission(envelope, await this.contextFor(manifest, [envelope]));
      if (!report.ok) return { error: validationFailure("the notebook page", report.errors) };
      const hash = await stage(envelope);
      const pages = manifest.pages.map((entry, position) => (position === index ? { ...entry, revisions: [...entry.revisions, hash] } : entry));
      const views = manifest.views.map((view) => (view.viewId === pageId && view.snapshotId === page.snapshotId ? { ...view, hash } : view));
      return { manifest: { ...manifest, pages, views }, value: { pageId, revision: currentRevision + 1, envelope } };
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
      const report = validateRunOutput(output, { ...context, evidenceSources: view.sources });
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
