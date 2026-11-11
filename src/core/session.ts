// Immutable session storage (design section 5): canonical JSON files plus a small manifest,
// no database. An explicit session directory owns the data.
//
// CLAIM(atomic-manifest): the manifest is replaced atomically, so a crash or injected failure
//   leaves the previous state fully readable [design section 5; session.test.ts, MC16, MC20].
// CLAIM(snapshot-immutable): a stored (viewId, snapshotId) never changes; different content under
//   the same key is SNAPSHOT_CONFLICT, identical content is idempotent [design section 4; MC20].
// Errors: methods return Result<T>; they never throw for domain failures.
import type { Bundle, Entity, EntityRef, Envelope, ViewDefinition } from "./wire.ts";
import { notImplementedResult, type Result } from "./errors.ts";

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

/** STUB: creates the directory if needed and returns a session whose every method is a stub. */
export async function openSession(dir: string, _options?: SessionOptions): Promise<Result<Session>> {
  const stub = <T>(what: string) => async (): Promise<Result<T>> => notImplementedResult<T>(`Session.${what}`);
  const session: Session = {
    dir,
    importBundle: stub("importBundle"),
    putView: stub("putView"),
    getView: stub("getView"),
    listViews: async () => [],
    getEntity: stub("getEntity"),
    listEntities: async () => [],
    listDefinitions: async () => ({ revision: 0, definitions: [] }),
    registerView: stub("registerView"),
    registerRepository: stub("registerRepository"),
    repositories: async () => [],
    snapshotInfo: stub("snapshotInfo"),
    exportBundle: async () => ({ schemaVersion: "paneweft.bundle/1", entities: [], definitions: [], views: [] }),
    notebookCreate: stub("notebookCreate"),
    notebookGet: stub("notebookGet"),
    notebookUpdate: stub("notebookUpdate"),
    recordExampleRun: stub("recordExampleRun"),
    listRuns: stub("listRuns"),
    close: async () => {},
  };
  return { ok: true, value: session };
}
