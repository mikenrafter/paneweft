// Capture validation and the lowering of SDK records into v0 envelopes (docs/v1-red-contract.md sections 3 and 4).
//
// Admission is the trust boundary for SDK artifacts: schema, every cross reference, every content hash and the run binding are
// checked BEFORE anything is stored, and every fault carries the JSON pointer of the offending member. Lowering turns the records
// into ordinary paneweft.view/1 envelopes, so the unchanged v0 operations (open_entity, navigate, inspect_view) serve them.
import { canonicalJson } from "../core/canonical.ts";
import { sha256Hex } from "../core/digest.ts";
import { err, ok, type Result, type ValidationIssue } from "../core/errors.ts";
import { validateSubmission } from "../core/validate.ts";
import type { Entity, EntityRef, Envelope, ViewDefinition } from "../core/wire.ts";
import type { ObjectGraph, ObjectRecord, ViewRecord } from "../generated/v1/ObjectGraph.ts";
import { LIMIT_NAMES, resolveRequestedLimits, type LimitName } from "./limits.ts";
import { checkListRows, rowIds } from "./page-rows.ts";
import { validateAgainstV1 } from "./schemas.ts";

export interface LowerContext {
  repo: string;
  snapshotId: string;
  runnerId: string;
  startedAt: string;
  finishedAt: string;
  generatedAt: string;
}

const issue = (code: ValidationIssue["code"], pointer: string, constraint: string, hint: string): ValidationIssue => ({ code, pointer, constraint, hint });

/** The content hash of an object record: sha256 of the canonical JSON of {domainKey, fields, label, typeId}. */
export function objectContentHash(record: Pick<ObjectRecord, "typeId" | "domainKey" | "label" | "fields">): string {
  return sha256Hex(canonicalJson({ domainKey: record.domainKey, fields: record.fields, label: record.label, typeId: record.typeId }));
}

/** `vigil::watch::WatchFile` -> `vigil/watch/watch-file`: lowercase, `::` -> `/`, CamelCase -> kebab-case (section 4). Characters a kind
 * cannot hold become `-`, and a segment that would not start with a letter gets a `t` prefix, so the result is always a valid kind. */
export function entityKindOf(typeId: string): string {
  const segment = (text: string): string => {
    const kebab = text.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
    return /^[a-z]/.test(kebab) ? kebab : `t${kebab}`;
  };
  const kind = typeId.split("::").filter((part) => part.length > 0).map(segment).join("/");
  return kind.length > 0 ? kind.slice(0, 128) : "t";
}

const entityId = (graph: Pick<ObjectGraph, "captureId">, objectId: string): string => `${graph.captureId}.${objectId}`;

function recordOf(graph: ObjectGraph, objectId: string): ObjectRecord {
  const record = graph.objects.find((candidate) => candidate.id === objectId);
  if (record === undefined) throw new Error(`object ${objectId} is not in capture ${graph.captureId}`);
  return record;
}

/** The entity an object record maps to: {repo, `<captureId>.<objectId>`, kind} in the snapshot of its run. The data roles are the ids of
 * the views the object has, so a declared view with no captured instance is distinguishable from an available one. */
export function entityOfObject(repo: string, graph: ObjectGraph, objectId: string): Entity {
  const record = recordOf(graph, objectId);
  const relations: Entity["relations"] = [];
  for (const edge of record.edges) {
    if (edge.kind === "not-captured" || edge.target === undefined) continue;
    const target = recordOf(graph, edge.target);
    relations.push({ name: edge.name, target: { repository: repo, id: entityId(graph, target.id), kind: entityKindOf(target.typeId) } });
  }
  return { repository: repo, id: entityId(graph, objectId), kind: entityKindOf(record.typeId), snapshotId: `snap-${graph.runId}`, label: record.label.length > 0 ? record.label : record.id, dataRoles: [...record.views], relations };
}

export interface AdmissionContext {
  /** The run being imported: a graph of another run is foreign or stale and refused. */
  expectedRunId: string;
  /** The operator's ceilings (the adapter's `limitCeilings`): a graph may not declare a bound above them. */
  ceilings?: Partial<Record<LimitName, number>>;
  /** The size in bytes of the document as it was written, when the caller has it; otherwise the document is serialized to measure it. */
  byteLength?: number;
  /** Resolved job limits, including requested reductions. */
  effective?: Partial<Record<LimitName, number>>;
}

const textBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
/** The records of a list and the commas between them: the brackets of the list belong to the frame of the document, not to a root. */
const recordsBytes = (items: unknown[]): number => textBytes(items) - 2;

/** The bounds the host holds a graph to, independently of the SDK that wrote it (D1): what it declares may not exceed the operator's
 * ceilings, the document may not be larger than the collectionBytes it declares, and the objects, views and stored pages of one root (the
 * objects from that root up to the next one, with their views and pages) may not be larger than the rootBytes it declares. */
function sizeIssues(graph: ObjectGraph, document: unknown, context: AdmissionContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const resolved = resolveRequestedLimits(context.effective, context.ceilings);
  if (!resolved.ok) return [issue("LIMIT_EXCEEDED", "/limits", "valid resolved limits", resolved.error.message)];
  const allowed = resolved.value.report.effective;
  const limits = Object.fromEntries(LIMIT_NAMES.map((name) => [name, Math.min(allowed[name], graph.limits[name])])) as Record<LimitName, number>;
  for (const name of LIMIT_NAMES) {
    if (graph.limits[name] > allowed[name]) issues.push(issue("LIMIT_EXCEEDED", `/limits/${name}`, `at most ${allowed[name]} (resolved job limit)`, "The artifact may only lower the host's resolved limits."));
  }
  const size = context.byteLength ?? textBytes(document);
  if (size > limits.collectionBytes) issues.push(issue("LIMIT_EXCEEDED", "/limits/collectionBytes", `at most ${limits.collectionBytes} bytes`, `The document is ${size} bytes.`));
  const check = (used: number, cap: number, pointer: string): void => {
    if (used > cap) issues.push(issue("LIMIT_EXCEEDED", pointer, `at most ${cap}`, `Observed ${used}.`));
  };
  check(graph.objects.length, limits.objects, "/objects");
  check(graph.roots.length, limits.roots, "/roots");
  check(graph.objects.reduce((n, o) => n + o.edges.filter((e) => e.kind !== "not-captured").length, 0), limits.references, "/objects");
  // Free text values are bounded; protocol names, ids, enum literals and content hashes have schema bounds of their own.
  const string = (text: string | null | undefined, pointer: string): void => { if (typeof text === "string") check(Buffer.byteLength(text), limits.stringBytes, pointer); };
  const values = (value: unknown, pointer: string, depth = 0): void => {
    if (depth > 64) { check(depth, 64, pointer); return; }
    if (typeof value === "string") { string(value, pointer); return; }
    if (Array.isArray(value)) { value.forEach((v, i) => values(v, `${pointer}/${i}`, depth + 1)); return; }
    if (value === null || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(object)) {
      const cutKey = key === "…" && item !== null && typeof item === "object" && (item as Record<string, unknown>).$paneweft === "not-captured";
      if (object.$paneweft === undefined && !cutKey) string(key, `${pointer}/${key}`);
      if (key === "$paneweft" || (key === "reason" && object.$paneweft === "not-captured") || (key === "value" && object.$paneweft === "float")) continue;
      values(item, `${pointer}/${key}`, depth + 1);
    }
  };
  graph.objects.forEach((o, i) => { string(o.label, `/objects/${i}/label`); string(o.domainKey, `/objects/${i}/domainKey`); values(o.fields, `/objects/${i}/fields`); });
  graph.views.forEach((v, i) => {
    string(v.unsupportedReason, `/views/${i}/unsupportedReason`);
    if (v.completeness.status === "unsupported") string(v.completeness.reason, `/views/${i}/completeness/reason`);
    if (v.component === "custom" && v.data !== undefined) {
      const custom = v.data as { payload?: unknown; fallback?: { data?: unknown } };
      values(custom.payload, `/views/${i}/data/payload`);
      // The fallback is checked by its own component schema when lowered. Its free scalar values still obey the job's string bound.
      const fallback = custom.fallback?.data as { rows?: Array<{ cells?: unknown }>; fields?: Array<{ example?: unknown }> } | undefined;
      fallback?.rows?.forEach((r) => values(r.cells, `/views/${i}/data/fallback/data/rows`));
      fallback?.fields?.forEach((f) => values(f.example, `/views/${i}/data/fallback/data/fields`));
      check(fallback?.rows?.length ?? Math.max(0, (fallback?.fields?.length ?? 0) - 1), limits.viewRows, `/views/${i}/data/fallback/data`);
    }
    const data = v.data as { rows?: unknown[]; fields?: Array<{ example?: unknown }> } | undefined;
    const pages = graph.pages.filter((p) => p.objectId === v.objectId && p.viewId === v.viewId);
    const rows = data?.rows ?? [];
    check(rows.length, limits.pageRows, `/views/${i}/data/rows`);
    check(rows.length + pages.reduce((n, p) => n + p.rows.length, 0), limits.viewRows, `/views/${i}/pages`);
    rows.forEach((row, at) => values((row as { cells?: unknown }).cells, `/views/${i}/data/rows/${at}/cells`));
    data?.fields?.forEach((f, at) => values(f.example, `/views/${i}/data/fields/${at}/example`));
  });
  graph.pages.forEach((p, i) => { check(p.rows.length, limits.pageRows, `/pages/${i}/rows`); p.rows.forEach((r, at) => values((r as { cells?: unknown }).cells, `/pages/${i}/rows/${at}/cells`)); });
  const position = new Map(graph.objects.map((object, at) => [object.id, at]));
  const starts = graph.roots.map((root) => position.get(root)).filter((at): at is number => at !== undefined);
  const span = (owner: string, from: number, to: number): boolean => {
    const at = position.get(owner);
    return at !== undefined && at >= from && at < to;
  };
  if ((graph.objects.length > 0 && starts[0] !== 0) || starts.length !== graph.roots.length || starts.some((at, i) => i > 0 && at <= (starts[i - 1] as number))) issues.push(issue("CONSTRAINT", "/roots", "roots cover the objects in capture order", "Every object must belong to an ordered root span."));
  const byId = new Map(graph.objects.map((o) => [o.id, o]));
  const parents = new Map<string, string>();
  for (const object of graph.objects) for (const edge of object.edges) {
    if (edge.kind !== "child" || edge.target === undefined) continue;
    if (parents.has(edge.target) || (position.get(edge.target) ?? -1) <= (position.get(object.id) ?? -1)) issues.push(issue("CONSTRAINT", "/objects", "a child is first discovered once, after its parent", "Use alias/cycle for previously captured objects."));
    parents.set(edge.target, object.id);
  }
  if (graph.roots.some((id) => parents.has(id))) issues.push(issue("CONSTRAINT", "/roots", "a root has no child parent", "Roots start independent traversal spans."));
  starts.forEach((from, rank) => {
    const to = rank + 1 < starts.length ? (starts[rank + 1] as number) : graph.objects.length;
    const used = recordsBytes(graph.objects.slice(from, to)) + recordsBytes(graph.views.filter((view) => span(view.objectId, from, to))) + recordsBytes(graph.pages.filter((page) => span(page.objectId, from, to)));
    const visited = new Set<string>();
    const pending: Array<[string, number]> = [[graph.objects[from]?.id ?? "", 0]];
    while (pending.length > 0) {
      const [id, depth] = pending.pop() as [string, number];
      if (visited.has(id)) continue;
      visited.add(id);
      check(depth, limits.depth, "/limits/depth");
      for (const edge of byId.get(id)?.edges ?? []) if (edge.kind === "child" && edge.target !== undefined) {
        if (!span(edge.target, from, to)) issues.push(issue("CONSTRAINT", "/roots", "child belongs to its root span", edge.target));
        pending.push([edge.target, depth + 1]);
      }
    }
    if (graph.objects.slice(from, to).some((o) => !visited.has(o.id))) issues.push(issue("CONSTRAINT", "/roots", "every object is covered by its root's child traversal", "Orphaned or interleaved object."));
    if (used > limits.rootBytes) issues.push(issue("LIMIT_EXCEEDED", "/limits/rootBytes", `the records of one root are at most ${limits.rootBytes} bytes`, `The root "${graph.objects[from]?.id}" holds ${used} bytes.`));
  });
  return issues;
}

/** Bounded iterative preflight, safe before schema validation and digest generation. */
export function preflightObjectGraph(document: unknown, context: AdmissionContext): Result<number> {
  const resolved = resolveRequestedLimits(context.effective, context.ceilings);
  if (!resolved.ok) return resolved;
  const cap = resolved.value.report.effective.collectionBytes;
  const refusal = (): Result<never> => err("VALIDATION_FAILED", "capture exceeds resolved byte or nesting limit", { errors: [issue("LIMIT_EXCEEDED", "/limits/collectionBytes", `at most ${cap} bytes and bounded nesting`, "Refused before schema validation or hashing.")] });
  if (context.byteLength !== undefined && context.byteLength > cap) return refusal();
  const stack: Array<[unknown, number]> = [[document, 0]];
  let bytes = 0;
  while (stack.length > 0) {
    const [value, depth] = stack.pop() as [unknown, number];
    if (depth > 80 || bytes > cap) return refusal();
    if (typeof value === "string") {
      if (value.length + 2 > cap - bytes) return refusal();
      bytes += textBytes(value);
    } else if (Array.isArray(value)) {
      bytes += 2 + Math.max(0, value.length - 1);
      if (bytes > cap) return refusal();
      for (const item of value) stack.push([item ?? null, depth + 1]);
    } else if (value !== null && typeof value === "object") {
      bytes += 2;
      let count = 0;
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        if (key.length + 3 > cap - bytes) return refusal();
        bytes += textBytes(key) + 1 + Number(count++ > 0);
        if (bytes > cap) return refusal();
        stack.push([item, depth + 1]);
      }
    } else bytes += JSON.stringify(value)?.length ?? 4;
  }
  return bytes > cap ? refusal() : ok(context.byteLength ?? bytes);
}

/** Admission of one SDK artifact. */
export function validateObjectGraph(document: unknown, context: AdmissionContext): Result<ObjectGraph> {
  const preflight = preflightObjectGraph(document, context);
  if (!preflight.ok) return preflight;
  const shape = validateAgainstV1("urn:paneweft:schema:v1:object-graph:1", document);
  if (shape.length > 0) return err("VALIDATION_FAILED", `the object graph does not match paneweft.object-graph/1 (${shape.length} fault${shape.length === 1 ? "" : "s"})`, { errors: shape });
  const graph = document as ObjectGraph;
  const issues: ValidationIssue[] = [];
  if (graph.runId !== context.expectedRunId) {
    issues.push(issue("CONSTRAINT", "/runId", `const: ${JSON.stringify(context.expectedRunId)}`, `This graph was captured by run "${graph.runId}", not by the run being imported ("${context.expectedRunId}"); a stale or foreign artifact cannot satisfy this run. Recollect.`));
    return err("VALIDATION_FAILED", "the object graph belongs to another run", { errors: issues });
  }
  const ids = new Set<string>();
  graph.objects.forEach((object, index) => {
    if (ids.has(object.id)) issues.push(issue("DUPLICATE_ID", `/objects/${index}/id`, "object ids are unique within a capture", `The id "${object.id}" appears twice.`));
    ids.add(object.id);
  });
  const dangling = (pointer: string, target: string, what: string): void => {
    if (!ids.has(target)) issues.push(issue("DANGLING_REFERENCE", pointer, `${what} names an object of this capture`, `"${target}" is not an object id of capture "${graph.captureId}".`));
  };
  graph.roots.forEach((root, index) => dangling(`/roots/${index}`, root, "a root"));
  let references = 0;
  graph.objects.forEach((object, index) => {
    object.edges.forEach((edge, edgeIndex) => {
      if (edge.kind === "not-captured") return;
      references += 1;
      if (edge.target !== undefined) dangling(`/objects/${index}/edges/${edgeIndex}/target`, edge.target, "an edge target");
    });
  });
  const bounds = sizeIssues(graph, document, context);
  if (bounds.length > 0) return err("VALIDATION_FAILED", "capture exceeds resolved limits", { errors: [...issues, ...bounds] });
  graph.objects.forEach((object, index) => {
    const expected = objectContentHash(object);
    if (object.contentHash !== expected) issues.push(issue("CONSTRAINT", `/objects/${index}/contentHash`, `sha256 of the canonical {domainKey, fields, label, typeId} is ${expected}`, "The record was edited after it was hashed; recapture instead of editing the artifact."));
  });
  const pageIds = new Set(graph.pages.map((page) => page.pageId));
  const claimedPages = new Set<number>();
  const seenViews = new Set<string>();
  const checkRows = (rows: unknown[], base: string): void => {
    rows.forEach((row, rowIndex) => {
      const target = (row as { target?: { object?: string } } | null)?.target;
      if (target?.object !== undefined) dangling(`${base}/${rowIndex}/target/object`, target.object, "a row target");
    });
  };
  graph.views.forEach((view, index) => {
    dangling(`/views/${index}/objectId`, view.objectId, "a view's object");
    const key = `${view.objectId}\u0000${view.viewId}`;
    if (seenViews.has(key)) issues.push(issue("DUPLICATE_ID", `/views/${index}/viewId`, "a view id is recorded once per object", `Object "${view.objectId}" already has a record for "${view.viewId}".`));
    seenViews.add(key);
    if (view.component === "list" && view.data !== undefined) {
      const rows = (view.data as { rows?: unknown[] }).rows ?? [];
      checkRows(rows, `/views/${index}/data/rows`);
      if (rows.length > graph.limits.viewRows) issues.push(issue("LIMIT_EXCEEDED", `/views/${index}/data/rows`, `at most ${graph.limits.viewRows} rows per view (the capture's own limit)`, "Recollect with fewer rows or a larger declared limit."));
    }
    // S22: the stored pages of a view are checked as rows of THAT view: the record must be the view's own (view, object, index, count), its rows
    // must be valid list rows with declared columns, and ids are unique over the first page and every stored page
    const seen = new Set<string>(view.component === "list" ? rowIds((view.data as { rows?: unknown } | undefined)?.rows) : []);
    [...view.pages.entries()].sort(([, a], [, b]) => a.index - b.index).forEach(([pageIndex, reference]) => {
      const pointer = `/views/${index}/pages/${pageIndex}`;
      if (!pageIds.has(reference.pageId)) {
        issues.push(issue("DANGLING_REFERENCE", `${pointer}/pageId`, "a view page names a stored page of this capture", `No stored page "${reference.pageId}" is in the capture.`));
        return;
      }
      const at = graph.pages.findIndex((page) => page.pageId === reference.pageId && page.viewId === view.viewId && page.objectId === view.objectId);
      const record = graph.pages[at];
      if (record === undefined) {
        issues.push(issue("CONSTRAINT", `${pointer}/pageId`, "a view page names a stored page of this view", `The stored page "${reference.pageId}" belongs to another view or object.`));
        return;
      }
      claimedPages.add(at);
      if (record.index !== reference.index) issues.push(issue("CONSTRAINT", `${pointer}/index`, `the stored page says it is page ${record.index}`, "The view and its stored page disagree about the page number."));
      if (record.rows.length !== reference.rowCount) issues.push(issue("CONSTRAINT", `${pointer}/rowCount`, `the stored page holds ${record.rows.length} rows`, "The view's count of a stored page is the number of rows the page holds."));
      if (view.component !== "list") issues.push(issue("CONSTRAINT", `${pointer}/pageId`, "only a list has stored pages", `The view "${view.viewId}" is a ${view.component}.`));
      else issues.push(...checkListRows((view.data ?? {}) as { columns?: unknown; order?: unknown }, record.rows, `/pages/${at}/rows`, seen));
    });
  });
  graph.pages.forEach((page, index) => {
    if (!claimedPages.has(index)) issues.push(issue("CONSTRAINT", `/pages/${index}/pageId`, "a stored page is listed by the view and object it names", `No view "${page.viewId}" of object "${page.objectId}" lists this page with its index.`));
  });
  graph.pages.forEach((page, index) => {
    const expected = `sha256:${sha256Hex(canonicalJson(page.rows))}`;
    if (page.pageId !== expected) issues.push(issue("CONSTRAINT", `/pages/${index}/pageId`, `the page id is the sha256 of its canonical rows (${expected})`, "A stored page is content addressed; a page whose id does not match its rows is refused."));
    dangling(`/pages/${index}/objectId`, page.objectId, "a page's object");
    checkRows(page.rows, `/pages/${index}/rows`);
  });
  if (graph.objects.length > graph.limits.objects) issues.push(issue("LIMIT_EXCEEDED", "/objects", `at most ${graph.limits.objects} objects (the capture's own limit)`, "The artifact exceeds the limits it declares; a hostile or buggy SDK produced it."));
  if (references > graph.limits.references) issues.push(issue("LIMIT_EXCEEDED", "/objects", `at most ${graph.limits.references} references (the capture's own limit)`, "The artifact exceeds the limits it declares."));
  if (graph.roots.length > graph.limits.roots) issues.push(issue("LIMIT_EXCEEDED", "/roots", `at most ${graph.limits.roots} roots (the capture's own limit)`, "The artifact exceeds the limits it declares."));
  if (issues.length > 0) return err("VALIDATION_FAILED", `the object graph is not admissible (${issues.length} fault${issues.length === 1 ? "" : "s"})`, { errors: issues.sort((a, b) => (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0)) });
  return ok(graph);
}

function limitsSummary(graph: ObjectGraph): string {
  const { depth, objects, references, stringBytes, pageRows } = graph.limits;
  return `captured under depth ${depth}, objects ${objects}, references ${references}, string ${stringBytes} bytes, ${pageRows} rows per stored page`;
}

/** The v0 completeness of a view record. A complete capture names its criterion; every omission is a named gap; rows kept in stored
 * pages are a gap too, because the envelope holds only the first page. */
export function lowerCompleteness(view: ViewRecord): Envelope["completeness"] {
  const completeness = view.completeness;
  if (completeness.status === "unsupported") return { status: "unsupported", reason: completeness.reason ?? "unsupported", missingCapabilities: [] };
  const gaps: Array<{ id: string; question: string; reason: string }> = [];
  for (const [name, omission] of Object.entries(completeness.omitted ?? {})) {
    gaps.push({ id: `omitted-${name}`, question: `Which ${name} were not captured?`, reason: omission.known ? `${omission.count} ${name} were refused by a capture bound (${completeness.reason ?? "limit"})` : `an unknown number of ${name} were refused by a capture bound` });
  }
  const stored = view.pages.reduce((sum, page) => sum + page.rowCount, 0);
  if (stored > 0) gaps.push({ id: "stored-pages", question: "Where are the remaining rows?", reason: `${stored} more rows are stored in ${view.pages.length} content-addressed page(s): ${view.pages.map((page) => page.pageId).join(", ")}`.slice(0, 1000) });
  if (gaps.length > 0) return { status: "partial", gaps: gaps as [(typeof gaps)[number], ...typeof gaps] };
  const total = view.rowsTotal;
  return { status: "complete", criterion: total === undefined || total === null ? "every value the view selected at capture time" : `all ${total} rows the view selected at capture time` };
}

/** List rows of a capture as v0 rows: a row `target` becomes the row's `entity`. Shared by the stored first page and by stored pages read later. */
export function lowerListRows(graph: Pick<ObjectGraph, "captureId" | "objects">, repo: string, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const { target, ...rest } = row as { target?: { object?: string; notCaptured?: { reason?: string } } } & Record<string, unknown>;
    // a target the capture did not keep stays on the row as its reason, so a reader can say why there is nothing to open (F19)
    if (target?.object === undefined) return typeof target?.notCaptured?.reason === "string" ? { ...rest, notCaptured: { reason: target.notCaptured.reason.slice(0, 64) } } : rest;
    return { ...rest, entity: { repository: repo, id: entityId(graph, target.object), kind: entityKindOf(recordOf(graph as ObjectGraph, target.object).typeId) } };
  });
}

/** A view record becomes an ordinary paneweft.view/1 envelope with a run source and `observed` items; a row `target` becomes the
 * row's `entity`. The stored view id is `<captureId>.<objectId>.<viewId>`. */
export interface CustomOverlay {
  /** Where the view came from, so the viewer can find the renderer under the repository's registered root. */
  repo: string;
  renderer: { id: string; apiVersion: number; payloadSchemaDigest: string; assetDigest: string };
  payload: unknown;
  /** Object ids the renderer may name, each with the entity that opens it. */
  objects: Record<string, EntityRef>;
}

export function lowerViewRecord(graph: ObjectGraph, view: ViewRecord, context: LowerContext): Result<{ envelope: Envelope; definition: ViewDefinition; entity: Entity; overlay?: CustomOverlay }> {
  const object = graph.objects.find((candidate) => candidate.id === view.objectId);
  if (object === undefined) return err("VALIDATION_FAILED", `view ${view.viewId} names the object ${view.objectId}, which is not in capture ${graph.captureId}`, { errors: [issue("DANGLING_REFERENCE", "/objectId", "a view's object is in the capture", `Unknown object "${view.objectId}".`)] });
  const entity = entityOfObject(context.repo, graph, object.id);
  const entityRef: EntityRef = { repository: entity.repository, id: entity.id, kind: entity.kind };
  const kindOfObject = (id: string): string => entityKindOf(recordOf(graph, id).typeId);
  let data: unknown = view.data;
  let component: string = view.component === "custom" && view.completeness.status === "unsupported" ? "shape" : view.component;
  let overlay: CustomOverlay | undefined;
  if (view.component === "custom" && view.completeness.status !== "unsupported") {
    // A repo-owned renderer is an overlay on an ORDINARY view: the stored envelope is the standard fallback (so text, the agent tools and
    // the unchanged v0 operations read the same facts), and the renderer, its payload and the objects it may name are kept beside it.
    const custom = validateAgainstV1("urn:paneweft:schema:v1:component:custom:1", view.data);
    if (custom.length > 0) return err("VALIDATION_FAILED", `the custom view ${view.viewId} does not match its component schema`, { errors: custom.map((fault) => ({ ...fault, pointer: `/data${fault.pointer}` })) });
    const body = view.data as { renderer: CustomOverlay["renderer"]; payload: unknown; objects: string[]; fallback: { component: string; data: Record<string, unknown> } };
    const unknown = body.objects.find((id) => !graph.objects.some((object) => object.id === id));
    if (unknown !== undefined) return err("VALIDATION_FAILED", `the custom view ${view.viewId} names the object ${unknown}, which is not in capture ${graph.captureId}`, { errors: [issue("DANGLING_REFERENCE", "/data/objects", "a renderer may only name captured objects", `Unknown object "${unknown}".`)] });
    component = body.fallback.component;
    data = body.fallback.data;
    overlay = { repo: context.repo, renderer: body.renderer, payload: body.payload, objects: Object.fromEntries(body.objects.map((id) => [id, { repository: context.repo, id: entityId(graph, id), kind: kindOfObject(id) }])) };
  }
  if (component === "list" && data !== undefined) {
    const list = data as { rows: Array<Record<string, unknown>> } & Record<string, unknown>;
    data = { ...list, rows: lowerListRows(graph, context.repo, list.rows) };
  }
  const envelope = {
    schemaVersion: "paneweft.view/1",
    id: `${entity.id}.${view.viewId}`,
    title: view.title,
    question: view.question,
    entity: entityRef,
    snapshotId: context.snapshotId,
    component,
    viewDefinitionId: view.viewId,
    scope: { repositories: [context.repo], roots: [], excludes: [], limits: [limitsSummary(graph)] },
    sources: [{ id: "run", kind: "run", run_id: graph.runId, runner_id: context.runnerId, started_at: context.startedAt, finished_at: context.finishedAt }],
    generatedAt: context.generatedAt,
    freshness: { repositories: [] },
    links: [],
    completeness: lowerCompleteness(view),
    ...(data === undefined ? {} : { data }),
  } as unknown as Envelope;
  const definition: ViewDefinition = { id: view.viewId, entityKind: entity.kind, title: view.title, priority: view.priority, component: component as ViewDefinition["component"], requires: [], dataRole: view.viewId };
  return ok({ envelope, definition, entity, ...(overlay === undefined ? {} : { overlay }) });
}

/** CLAIM(T1-admission): what the import would do to a capture, done at admission. Every view record is lowered (custom views included) and the bundle those
 * envelopes and the capture's entities make is checked by the v0 schemas (component schemas, sizes, references). A capture that fails here is refused as a
 * failed capture with the fault's pointer, instead of passing admission and failing the whole run's import. Times and the snapshot are placeholders: they
 * are not part of any v0 schema rule. */
export function admitLowering(graph: ObjectGraph, context: { repo: string; snapshotId: string; runnerId: string }): Result<ObjectGraph> {
  const at = new Date(0).toISOString();
  const lowering: LowerContext = { ...context, startedAt: at, finishedAt: at, generatedAt: at };
  const definitions = new Map<string, ViewDefinition>();
  const views: Envelope[] = [];
  for (const [index, view] of graph.views.entries()) {
    const lowered = lowerViewRecord(graph, view, lowering);
    if (!lowered.ok) return err("VALIDATION_FAILED", lowered.error.message, { errors: (lowered.error.errors ?? []).map((fault) => ({ ...fault, pointer: `/views/${index}${fault.pointer}` })) });
    views.push(lowered.value.envelope);
    definitions.set(lowered.value.definition.id, lowered.value.definition);
  }
  const bundle = { schemaVersion: "paneweft.bundle/1", entities: graph.objects.map((object) => entityOfObject(context.repo, graph, object.id)), definitions: [...definitions.values()], views };
  const report = validateSubmission(bundle);
  if (report.ok) return ok(graph);
  return err("VALIDATION_FAILED", `the lowered views of the capture do not pass the v0 schemas (${report.errors.length} fault${report.errors.length === 1 ? "" : "s"})`, { errors: report.errors });
}

export type { EntityRef };
