// Capture validation and the lowering of SDK records into v0 envelopes (docs/v1-red-contract.md sections 3 and 4).
import type { Result } from "../core/errors.ts";
import type { Entity, EntityRef, Envelope, ViewDefinition } from "../core/wire.ts";
import type { ObjectGraph, ObjectRecord, ViewRecord } from "../generated/v1/ObjectGraph.ts";
import { notImplemented } from "./stub.ts";

export interface LowerContext {
  repo: string;
  snapshotId: string;
  runnerId: string;
  startedAt: string;
  finishedAt: string;
  generatedAt: string;
}

/** Admission of one SDK artifact: the schema, every cross reference (edge targets, roots, view objects, row targets, page ids and
 * hashes), the content hash of every object record, and the run binding: `graph.runId` must equal `expectedRunId` or the artifact is
 * foreign/stale and refused. STUB. */
export function validateObjectGraph(document: unknown, context: { expectedRunId: string }): Result<ObjectGraph> {
  return notImplemented("validateObjectGraph");
}

/** The content hash of an object record: sha256 of the canonical JSON of {domainKey, fields, label, typeId}. STUB: "". */
export function objectContentHash(record: Pick<ObjectRecord, "typeId" | "domainKey" | "label" | "fields">): string {
  return "";
}

/** `vigil::watch::WatchFile` -> `vigil/watch/watch-file` (section 4). STUB: "". */
export function entityKindOf(typeId: string): string {
  return "";
}

/** The entity an object record maps to: {repo, `<captureId>.<objectId>`, kind}. STUB. */
export function entityOfObject(repo: string, graph: ObjectGraph, objectId: string): Entity {
  return { repository: repo, id: "", kind: "", snapshotId: "", label: "", dataRoles: [], relations: [] };
}

/** A view record becomes an ordinary paneweft.view/1 envelope with a run source and `observed` items; a row `target` becomes the
 * row's `entity`. The stored view id is `<captureId>.<objectId>.<viewId>`. STUB. */
export function lowerViewRecord(graph: ObjectGraph, view: ViewRecord, context: LowerContext): Result<{ envelope: Envelope; definition: ViewDefinition; entity: Entity }> {
  return notImplemented("lowerViewRecord");
}

export type { EntityRef };
