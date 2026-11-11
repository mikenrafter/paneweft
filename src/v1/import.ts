// Atomic, idempotent import of one collection into a session (spec section 8; amendment S3; IV20).
//
// Order: validate EVERYTHING (run, graphs, cross references, the v0 preflight of the lowered bundle); write the v1 files, which are
// invisible until their snapshot exists; then one v0 manifest swap (`importBundle`), which is the commit point. A crash before the
// swap leaves nothing readable; a crash after it is a completed import that a retry recognises by its content digest.
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson } from "../core/canonical.ts";
import { sha256Hex } from "../core/digest.ts";
import { err, ok, type Result, type ValidationIssue } from "../core/errors.ts";
import type { Session, ViewKey } from "../core/session.ts";
import type { Entity, EntityRef, Envelope, ViewDefinition } from "../core/wire.ts";
import type { ObjectGraph } from "../generated/v1/ObjectGraph.ts";
import type { TestRun } from "../generated/v1/TestRun.ts";
import { entityOfObject, lowerViewRecord, validateObjectGraph } from "./capture.ts";
import { committedImport, pageFile, runDirectory, snapshotOfRun, type ImportRecord, type Origin } from "./read.ts";
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

async function writeDurably(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

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

/** Validates everything first (no write on any fault), then writes under the session write lock: objects, then one atomic manifest
 * swap. */
export async function importCollection(session: Session, input: CollectionImport, options: { crashAt?: (point: ImportCrashPoint) => void | Promise<void> } = {}): Promise<Result<ImportReceipt>> {
  const crash = async (point: ImportCrashPoint): Promise<void> => void (await options.crashAt?.(point));
  const run = validateRun(input);
  if (!run.ok) return run;
  const snapshotId = snapshotOfRun(input.runId);
  const digest = sha256Hex(canonicalJson({ repo: input.repo, run: input.run, graphs: input.graphs }));
  const existing = await committedImport(session, input.runId);
  if (existing !== undefined) {
    if (existing.digest !== digest || existing.origin !== input.origin) return err("CONFLICT", `run "${input.runId}" is already imported with different content or a different origin; a run id names one collection, use a new run id`, { details: { runId: input.runId, existingOrigin: existing.origin } });
    return ok({ runId: existing.runId, snapshotId: existing.snapshotId, captureIds: existing.captureIds, viewKeys: existing.viewKeys, entities: existing.entities, alreadyImported: true });
  }

  const graphs: ObjectGraph[] = [];
  const faults: ValidationIssue[] = [];
  for (const [index, document] of input.graphs.entries()) {
    const checked = validateObjectGraph(document, { expectedRunId: input.runId });
    if (checked.ok) graphs.push(checked.value);
    else faults.push(...checked.error.errors.map((fault) => ({ ...fault, pointer: `/graphs/${index}${fault.pointer}` })));
  }
  if (faults.length > 0) return err("VALIDATION_FAILED", `a captured object graph is not admissible (${faults.length} fault${faults.length === 1 ? "" : "s"})`, { errors: faults });
  const captureIds = graphs.map((graph) => graph.captureId);
  if (new Set(captureIds).size !== captureIds.length) return err("VALIDATION_FAILED", "two graphs carry the same capture id", { errors: [issue("DUPLICATE_ID", "/graphs", "capture ids are unique within a run", "Each invocation publishes its own capture.")] });
  for (const [index, invocation] of run.value.invocations.entries()) {
    const reference = invocation.result;
    if (reference === null || reference === undefined) continue;
    const graph = graphs.find((candidate) => candidate.captureId === reference.captureId);
    if (graph === undefined || !graph.objects.some((object) => object.id === reference.object)) {
      return err("VALIDATION_FAILED", `invocation ${invocation.id} names the result ${reference.captureId}/${reference.object}, which was not imported`, { errors: [issue("DANGLING_REFERENCE", `/run/invocations/${index}/result`, "a result names an imported object", "Import the capture the invocation published, or recollect.")] });
    }
  }

  const startedAt = run.value.invocations.map((invocation) => invocation.startedAt).filter((time): time is string => typeof time === "string").sort()[0] ?? new Date(0).toISOString();
  const finishedAt = run.value.invocations.map((invocation) => invocation.finishedAt).filter((time): time is string => typeof time === "string").sort().slice(-1)[0] ?? startedAt;
  // The run itself is an entity: its snapshot exists even when no capture could be imported (a failing run still imports).
  const entities: Entity[] = [{ repository: input.repo, id: input.runId, kind: "paneweft/test-run", snapshotId, label: `run ${input.runId}`, dataRoles: [], relations: [] }];
  const definitions = new Map<string, ViewDefinition>();
  const views: Envelope[] = [];
  const overlays: Array<{ viewId: string; overlay: unknown }> = [];
  const generatedAt = finishedAt;
  for (const graph of graphs) {
    for (const object of graph.objects) entities.push(entityOfObject(input.repo, graph, object.id));
    for (const view of graph.views) {
      const lowered = lowerViewRecord(graph, view, { repo: input.repo, snapshotId, runnerId: run.value.runner.id, startedAt, finishedAt, generatedAt });
      if (!lowered.ok) return lowered;
      views.push(lowered.value.envelope);
      if (lowered.value.overlay !== undefined) overlays.push({ viewId: lowered.value.envelope.id, overlay: lowered.value.overlay });
      const known = definitions.get(lowered.value.definition.id);
      if (known !== undefined && canonicalJson(known) !== canonicalJson(lowered.value.definition)) return err("VALIDATION_FAILED", `view "${view.viewId}" is declared with different metadata in two captures of one run`, { errors: [issue("IDENTITY_CONFLICT", "/graphs", "a view id has one definition per run", "Declare each view once.")] });
      definitions.set(lowered.value.definition.id, lowered.value.definition);
    }
  }
  // A view whose title or priority was edited since an earlier collection changes its registered definition: replace it explicitly,
  // as the v0 registry requires, so recollecting after an edit works.
  const registered = await session.listDefinitions();
  let revision = registered.revision;
  for (const definition of definitions.values()) {
    const current = registered.definitions.find((candidate) => candidate.id === definition.id);
    if (current === undefined || canonicalJson(current) === canonicalJson(definition)) continue;
    const replaced = await session.registerView(definition, revision);
    if (!replaced.ok) return replaced;
    revision = replaced.value.revision;
  }
  const bundle = { schemaVersion: "paneweft.bundle/1" as const, entities, definitions: [...definitions.values()], views };
  const checked = await session.preflight(bundle);
  if (!checked.ok) return checked;

  await crash("before-write");
  const base = runDirectory(session, input.runId);
  const stored: TestRun = { ...run.value, meta: { origin: input.origin, importedAt: new Date().toISOString(), jobId: input.jobId } };
  for (const graph of graphs) {
    await writeDurably(join(base, "captures", `${graph.captureId}.json`), JSON.stringify(graph));
    for (const page of graph.pages) await writeDurably(pageFile(session, page.pageId), JSON.stringify(page));
  }
  for (const { viewId, overlay } of overlays) await writeDurably(join(base, "customs", `${encodeURIComponent(viewId)}.json`), JSON.stringify(overlay));
  await writeDurably(join(base, "run.json"), JSON.stringify(stored));
  await crash("after-objects");
  const imported = await session.importBundle(bundle);
  if (!imported.ok) return imported;
  const receipt: ImportRecord = {
    runId: input.runId,
    repo: input.repo,
    origin: input.origin,
    jobId: input.jobId,
    digest,
    snapshotId,
    captureIds,
    viewKeys: imported.value.views,
    entities: entities.map((entity) => ({ repository: entity.repository, id: entity.id, kind: entity.kind })),
    importedAt: stored.meta?.importedAt ?? new Date().toISOString(),
  };
  // The receipt is written AFTER the commit and is what makes the run visible to readers (they require both the snapshot and this
  // record). A crash between the swap and this write is recovered by the retry: it finds no record, repeats the idempotent steps, and
  // writes it.
  await writeDurably(join(base, "import.json"), JSON.stringify(receipt));
  await crash("after-manifest");
  return ok({ runId: receipt.runId, snapshotId, captureIds, viewKeys: receipt.viewKeys, entities: receipt.entities, alreadyImported: false });
}

export type { TestRun };
