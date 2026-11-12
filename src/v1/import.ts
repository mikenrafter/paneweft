import { mkdirDurably as mkdir, writeDurably } from "./durable.ts";
// Atomic, idempotent import of one collection into a session (spec section 8; amendment S3; IV20).
//
// Order: validate EVERYTHING (run, graphs, cross references) outside any lock; then, under the v1 import lock, the conflict check, the v0
// preflight of the lowered bundle (with the definition changes it implies), the v1 files and the receipt, which are invisible until their
// snapshot exists; then one v0 manifest swap (`importBundle`) that publishes snapshot and definitions together: the commit point. A
// crash before the swap leaves nothing readable and the registry untouched; a crash after it is a completed import that a retry
// recognises by its receipt. Identifiers from the payload are path components only through `pathComponent` (S1).
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, compareCodeUnits } from "../core/canonical.ts";
import { sha256Hex } from "../core/digest.ts";
import { WriteLockError, withWriteLock } from "../core/write-lock.ts";
import { err, ok, type Result, type ValidationIssue } from "../core/errors.ts";
import type { Session, ViewKey } from "../core/session.ts";
import type { Entity, EntityRef, Envelope, ViewDefinition } from "../core/wire.ts";
import type { ObjectGraph } from "../generated/v1/ObjectGraph.ts";
import type { TestRun } from "../generated/v1/TestRun.ts";
import { entityOfObject, lowerViewRecord, preflightObjectGraph, validateObjectGraph } from "./capture.ts";
import { resolveRequestedLimits, type LimitName } from "./limits.ts";
import { pageIdOf } from "./page-rows.ts";
import { captureFile, committedImport, customFile, pageFile, pageRefsFile, runDirectory, snapshotOfRun, v1Directory, type ImportRecord, type Origin } from "./read.ts";
import { validateAgainstV1 } from "./schemas.ts";

export type { Origin };

export interface CollectionImport {
  repo: string;
  /** Must equal run.runId and the runId of every graph. */
  runId: string;
  jobId: string | null;
  /** Stamped by the HOST: session metadata, never read from the submitted payload. */
  origin: Origin;
  run: unknown;
  graphs: unknown[];
  /** The operator's ceilings, re-checked here against what each graph declares (D1). */
  ceilings?: Partial<Record<LimitName, number>>;
  /** The size in bytes of each graph as it was written, in the order of `graphs`, when the caller read them from files. */
  graphBytes?: number[];
  effective?: Partial<Record<LimitName, number>>;
}

export interface ImportReceipt {
  runId: string;
  snapshotId: string;
  captureIds: string[];
  viewKeys: ViewKey[];
  entities: EntityRef[];
  /** true when the same run id with identical content was already imported (idempotent by run id). */
  alreadyImported: boolean;
}

export type ImportCrashPoint = "before-write" | "after-objects" | "after-manifest";


const issue = (code: ValidationIssue["code"], pointer: string, constraint: string, hint: string): ValidationIssue => ({ code, pointer, constraint, hint });

function validateRun(input: CollectionImport): Result<TestRun> {
  const run = input.run;
  if (run === null || typeof run !== "object" || Array.isArray(run)) return err("VALIDATION_FAILED", "the run is not an object", { errors: [issue("TYPE", "/run", "type: object", "Submit a paneweft.test-run/1 document.")] });
  if (Object.hasOwn(run, "meta")) {
    return err("VALIDATION_FAILED", "a submitted run cannot carry meta: the origin stamp is host metadata, assigned by the importer and never taken from the payload", { errors: [issue("FORBIDDEN_PROPERTY", "/run/meta", "meta is stamped by the host at import", "Remove the member. Execution origin is decided by who ran the code, not by the payload.")] });
  }
  const shape = validateAgainstV1("urn:paneweft:schema:v1:test-run:1", run).map((fault) => ({ ...fault, pointer: `/run${fault.pointer}` }));
  if (shape.length > 0) return err("VALIDATION_FAILED", `the run does not match paneweft.test-run/1 (${shape.length} fault${shape.length === 1 ? "" : "s"})`, { errors: shape });
  const document = run as TestRun;
  if (document.runId !== input.runId) return err("VALIDATION_FAILED", `the run record belongs to "${document.runId}", not to the run being imported ("${input.runId}")`, { errors: [issue("CONSTRAINT", "/run/runId", `const: ${JSON.stringify(input.runId)}`, "A run record of another run cannot be imported under this run id.")] });
  return ok(document);
}

const V1_LOCK_WAIT_MS = 15_000;

/** Order of the two locks: the v1 lock first, the session write lock (taken inside `importBundle`) second, never the other way round. */
async function withV1Lock<T>(session: Session, body: () => Promise<Result<T>>): Promise<Result<T>> {
  await mkdir(v1Directory(session), { recursive: true });
  try {
    return await withWriteLock(v1Directory(session), { waitMs: V1_LOCK_WAIT_MS }, body);
  } catch (cause) {
    if (!(cause instanceof WriteLockError)) throw cause;
    return err(cause.kind === "contended" ? "CONFLICT" : "STORAGE_FAILED", `the import lock of this session could not be taken: ${cause.message}`, { retryable: cause.kind === "contended" });
  }
}

/** Validates everything first (no write on any fault), then commits as ONE unit under the v1 import lock: the conflict check against an
 * earlier import of the run, the preflight (with the definition changes it implies), the artifacts, the receipt, and the single manifest
 * swap that publishes the snapshot together with the changed definitions (S7).
 *
 * Why a lock of its own: the run directory and the receipt are v1 files the session lock does not cover. Two imports of one run id used to
 * check the receipt, write the same files and race to the manifest, so the loser's files could replace the winner's. */
export async function importCollection(session: Session, input: CollectionImport, options: { crashAt?: (point: ImportCrashPoint) => void | Promise<void> } = {}): Promise<Result<ImportReceipt>> {
  const run = validateRun(input);
  if (!run.ok) return run;
  const limits = resolveRequestedLimits(input.effective, input.ceilings);
  if (!limits.ok) return limits;
  const total = input.graphBytes?.reduce((n, size) => n + size, 0);
  if (total !== undefined && total > limits.value.report.effective.collectionBytes) return err("VALIDATION_FAILED", "aggregate captures exceed resolved collectionBytes");
  let aggregateBytes = 0;
  for (const [index, document] of input.graphs.entries()) {
    const preflight = preflightObjectGraph(document, { expectedRunId: input.runId, ...(input.effective === undefined ? {} : { effective: input.effective }), ...(input.ceilings === undefined ? {} : { ceilings: input.ceilings }) });
    if (!preflight.ok) return preflight;
    aggregateBytes += input.graphBytes?.[index] ?? preflight.value;
    if (aggregateBytes > limits.value.report.effective.collectionBytes) return err("VALIDATION_FAILED", "aggregate captures exceed resolved collectionBytes");
  }
  const digest = sha256Hex(canonicalJson({ repo: input.repo, run: input.run, graphs: input.graphs }));
  // A committed import answers without any lock (the answer cannot change: a committed run id is never rewritten); it is checked again
  // under the lock, which is the check that decides.
  const settled = await settledAnswer(session, input, digest);
  if (settled !== undefined) return settled;
  // everything else that needs no shared state is decided before the lock is taken
  const prepared = prepare(input, run.value);
  if (!prepared.ok) return prepared;
  return withV1Lock(session, () => commit(session, input, run.value, prepared.value, digest, options));
}

/** The answer for a run id whose import is already committed: the same receipt for the same content and origin, CONFLICT for anything else. */
async function settledAnswer(session: Session, input: CollectionImport, digest: string): Promise<Result<ImportReceipt> | undefined> {
  const existing = await committedImport(session, input.runId);
  if (existing === undefined) return undefined;
  if (existing.digest !== digest || existing.origin !== input.origin) return err("CONFLICT", `run "${input.runId}" is already imported with different content or a different origin; a run id names one collection, use a new run id`, { details: { runId: input.runId, existingOrigin: existing.origin } });
  return ok({ runId: existing.runId, snapshotId: existing.snapshotId, captureIds: existing.captureIds, viewKeys: existing.viewKeys, entities: existing.entities, alreadyImported: true });
}

interface Prepared {
  graphs: ObjectGraph[];
  captureIds: string[];
  entities: Entity[];
  definitions: Map<string, ViewDefinition>;
  views: Envelope[];
  overlays: Array<{ viewId: string; overlay: unknown }>;
}

function prepare(input: CollectionImport, run: TestRun): Result<Prepared> {
  const snapshotId = snapshotOfRun(input.runId);
  const graphs: ObjectGraph[] = [];
  const faults: ValidationIssue[] = [];
  for (const [index, document] of input.graphs.entries()) {
    const checked = validateObjectGraph(document, { expectedRunId: input.runId, ...(input.effective === undefined ? {} : { effective: input.effective }), ...(input.ceilings === undefined ? {} : { ceilings: input.ceilings }), ...(input.graphBytes?.[index] === undefined ? {} : { byteLength: input.graphBytes[index] as number }) });
    if (checked.ok) graphs.push(checked.value);
    else faults.push(...checked.error.errors.map((fault) => ({ ...fault, pointer: `/graphs/${index}${fault.pointer}` })));
  }
  if (faults.length > 0) return err("VALIDATION_FAILED", `a captured object graph is not admissible (${faults.length} fault${faults.length === 1 ? "" : "s"})`, { errors: faults });
  const captureIds = graphs.map((graph) => graph.captureId);
  if (new Set(captureIds).size !== captureIds.length) return err("VALIDATION_FAILED", "two graphs carry the same capture id", { errors: [issue("DUPLICATE_ID", "/graphs", "capture ids are unique within a run", "Each invocation publishes its own capture.")] });
  for (const [index, invocation] of run.invocations.entries()) {
    const reference = invocation.result;
    if (reference === null || reference === undefined) continue;
    const graph = graphs.find((candidate) => candidate.captureId === reference.captureId);
    if (graph === undefined || !graph.objects.some((object) => object.id === reference.object)) {
      return err("VALIDATION_FAILED", `invocation ${invocation.id} names the result ${reference.captureId}/${reference.object}, which was not imported`, { errors: [issue("DANGLING_REFERENCE", `/run/invocations/${index}/result`, "a result names an imported object", "Import the capture the invocation published, or recollect.")] });
    }
  }

  const startedAt = run.invocations.map((invocation) => invocation.startedAt).filter((time): time is string => typeof time === "string").sort()[0] ?? new Date(0).toISOString();
  const finishedAt = run.invocations.map((invocation) => invocation.finishedAt).filter((time): time is string => typeof time === "string").sort().slice(-1)[0] ?? startedAt;
  // The run itself is an entity: its snapshot exists even when no capture could be imported (a failing run still imports).
  const entities: Entity[] = [{ repository: input.repo, id: input.runId, kind: "paneweft/test-run", snapshotId, label: `run ${input.runId}`, dataRoles: [], relations: [] }];
  const definitions = new Map<string, ViewDefinition>();
  const views: Envelope[] = [];
  const overlays: Array<{ viewId: string; overlay: unknown }> = [];
  const generatedAt = finishedAt;
  for (const graph of graphs) {
    for (const object of graph.objects) entities.push(entityOfObject(input.repo, graph, object.id));
    for (const view of graph.views) {
      const lowered = lowerViewRecord(graph, view, { repo: input.repo, snapshotId, runnerId: run.runner.id, startedAt, finishedAt, generatedAt });
      if (!lowered.ok) return lowered;
      views.push(lowered.value.envelope);
      if (lowered.value.overlay !== undefined) overlays.push({ viewId: lowered.value.envelope.id, overlay: lowered.value.overlay });
      const known = definitions.get(lowered.value.definition.id);
      if (known !== undefined && canonicalJson(known) !== canonicalJson(lowered.value.definition)) return err("VALIDATION_FAILED", `view "${view.viewId}" is declared with different metadata in two captures of one run`, { errors: [issue("IDENTITY_CONFLICT", "/graphs", "a view id has one definition per run", "Declare each view once.")] });
      definitions.set(lowered.value.definition.id, lowered.value.definition);
    }
  }
  return ok({ graphs, captureIds, entities, definitions, views, overlays });
}

/** Stores the page bodies of `graphs` that the store does not already hold, then the references that say which view of which capture owns which page.
 * A body is written only when no valid body of that address is there: identical rows are one file, whoever stored them first, and storing them
 * again changes nothing. The references are keyed by (run, capture, object, view, position) and are the only record of ownership. */
async function publishPages(session: Session, runId: string, graphs: ObjectGraph[]): Promise<void> {
  const refs: Array<{ captureId: string; objectId: string; viewId: string; position: number; pageId: string; rowCount: number }> = [];
  const bodies = new Map<string, unknown[]>();
  for (const graph of graphs) {
    for (const page of graph.pages) bodies.set(page.pageId, page.rows);
    for (const view of graph.views) for (const ref of view.pages) refs.push({ captureId: graph.captureId, objectId: view.objectId, viewId: view.viewId, position: ref.index, pageId: ref.pageId, rowCount: ref.rowCount });
  }
  for (const [pageId, rows] of bodies) {
    const present = await readFile(pageFile(session, pageId), "utf8").then((text) => { try { return (JSON.parse(text) as { rows?: unknown }).rows; } catch { return undefined; } }, () => undefined);
    if (present !== undefined && pageIdOf(present) === pageId) continue;
    await writeDurably(pageFile(session, pageId), JSON.stringify({ pageId, rows }));
  }
  refs.sort((a, b) => compareCodeUnits(a.captureId, b.captureId) || compareCodeUnits(a.objectId, b.objectId) || compareCodeUnits(a.viewId, b.viewId) || a.position - b.position);
  await writeDurably(pageRefsFile(session, runId), JSON.stringify({ schemaVersion: "paneweft.page-refs/1", runId, refs }));
}

async function commit(session: Session, input: CollectionImport, run: TestRun, prepared: Prepared, digest: string, options: { crashAt?: (point: ImportCrashPoint) => void | Promise<void> }): Promise<Result<ImportReceipt>> {
  const crash = async (point: ImportCrashPoint): Promise<void> => void (await options.crashAt?.(point));
  const snapshotId = snapshotOfRun(input.runId);
  const { graphs, captureIds, entities, definitions, views, overlays } = prepared;
  const settled = await settledAnswer(session, input, digest);
  if (settled !== undefined) return settled;
  // A view whose title or priority was edited since an earlier collection changes its registered definition. The replacement is part of the
  // import's own manifest swap, so a refused or interrupted import leaves the registry alone.
  const registered = await session.listDefinitions();
  const replaceDefinitions = [...definitions.values()].filter((definition) => {
    const current = registered.definitions.find((candidate) => candidate.id === definition.id);
    return current !== undefined && canonicalJson(current) !== canonicalJson(definition);
  });
  const bundle = { schemaVersion: "paneweft.bundle/1" as const, entities, definitions: [...definitions.values()], views };
  const checked = await session.preflight(bundle, { replaceDefinitions });
  if (!checked.ok) return checked;

  await crash("before-write");
  const base = runDirectory(session, input.runId);
  const stored: TestRun = { ...run, meta: { origin: input.origin, importedAt: new Date().toISOString(), jobId: input.jobId } };
  try {
    // D2: the capture is stored without the bodies of its pages. Bodies are shared by content and owned by nobody; who owns which page is the
    // run's page references, published here with everything else the commit makes visible.
    for (const graph of graphs) await writeDurably(captureFile(session, input.runId, graph.captureId), JSON.stringify({ ...graph, pages: [] }));
    await publishPages(session, input.runId, graphs);
    for (const { viewId, overlay } of overlays) await writeDurably(customFile(session, input.runId, viewId), JSON.stringify(overlay));
    await writeDurably(join(base, "run.json"), JSON.stringify(stored));
    // The receipt names the content this run id is claimed by. It is written BEFORE the commit and counts only once the snapshot is in the
    // manifest (readers require both), so no window exists in which a committed snapshot has no record of whose content it is.
    const viewKeys = [...new Map(views.map((envelope) => [`${envelope.snapshotId}\u0000${envelope.id}`, { viewId: envelope.id, snapshotId: envelope.snapshotId }])).values()].sort((a, b) => compareCodeUnits(a.viewId, b.viewId) || compareCodeUnits(a.snapshotId, b.snapshotId));
    const receipt: ImportRecord = {
      runId: input.runId,
      repo: input.repo,
      origin: input.origin,
      jobId: input.jobId,
      digest,
      snapshotId,
      captureIds,
      viewKeys,
      entities: entities.map((entity) => ({ repository: entity.repository, id: entity.id, kind: entity.kind })),
      importedAt: stored.meta?.importedAt ?? new Date().toISOString(),
    };
    await writeDurably(join(base, "import.json"), JSON.stringify(receipt));
    await crash("after-objects");
    const imported = await session.importBundle(bundle, { replaceDefinitions });
    if (!imported.ok) return imported;
    await crash("after-manifest");
    return ok({ runId: receipt.runId, snapshotId, captureIds, viewKeys: imported.value.views, entities: receipt.entities, alreadyImported: false });
  } catch (cause) {
    if (cause instanceof Error && (cause as NodeJS.ErrnoException).code !== undefined) return err("STORAGE_FAILED", `the import of run "${input.runId}" could not be stored: ${cause.message}`);
    throw cause;
  }
}

export type { TestRun };
