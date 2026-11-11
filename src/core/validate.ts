// Validation = limits, then JSON Schema (Ajv 2020-12, strict), then semantic checks.
// One core used by CLI, MCP, session import and viewer (design section 5).
//
// Reason: agent-submitted documents are the trust boundary; nothing reaches storage or the
// browser without passing here.
// Errors: never throws; every fault is a ValidationIssue sorted by (pointer, code).
// Invariants: deterministic for equal input; a single fault yields a single issue.
// Mating parts: tools/validate (MCP), `paneweft validate` (CLI), Session.importBundle.
//
// CLAIM(limits-first): if any v0 limit is exceeded the report holds only LIMIT_EXCEEDED issues; neither the
//   schema nor the semantic pass runs over a hostile document [docs/contract-additions/val.md Q1; limits.test.ts].
// CLAIM(one-fault-one-issue): Ajv's echoes (the `if` wrapper error, `unevaluatedProperties` reports for properties a
//   failing `allOf` branch declared, duplicate keyword errors on one pointer) never reach the report
//   [docs/red-contract.md section 2; validate.shape.test.ts].
// CLAIM(semantics-after-shape): semantic checks run only over a document that passed the schema pass, so a
//   semantic rule never sees a malformed structure [docs/contract-additions/val.md Q9].
import type { ErrorObject, ValidateFunction } from "ajv";
import { compareCodeUnits, canonicalJson } from "./canonical.ts";
import type { IssueCode, ValidationIssue } from "./errors.ts";
import { LIMITS } from "./limits.ts";
import { createSchemaRegistry, loadSchemaDocuments, type SchemaDocument } from "../schemas/index.ts";
import type { EntityRef } from "./wire.ts";

/** A registered view definition as the context knows it (S8): identity plus the metadata an instance must agree with. */
export interface DefinitionMetadata { id: string; component: string; entityKind: string }

/** What lies outside the submitted document, so cross references can be checked against it. */
export interface ReferenceContext {
  views?: Array<{ id: string; snapshotId: string; itemIds: string[] }>;
  entities?: Array<EntityRef & { snapshotId: string }>;
  /** S8: replaces the bare `definitionIds`; an instance whose component or entity kind disagrees is DEFINITION_MISMATCH. */
  definitions?: DefinitionMetadata[];
}

export interface ValidationNote { pointer: string; message: string }

export type ValidationReport =
  | { ok: true; kind: "envelope" | "bundle" | "run"; notes: ValidationNote[] }
  | { ok: false; kind: "envelope" | "bundle" | "run" | "unknown"; errors: ValidationIssue[] };

type Json = any; // the document under validation is unknown JSON until the schema pass has accepted it
type Obj = Record<string, Json>;

// ---- issue plumbing ----------------------------------------------------------------------------------------

const escapeToken = (token: string): string => token.replace(/~/g, "~0").replace(/\//g, "~1");
const pointerOf = (...tokens: Array<string | number>): string => tokens.map((token) => `/${escapeToken(String(token))}`).join("");

class IssueSet {
  private readonly byKey = new Map<string, ValidationIssue>();
  add(code: IssueCode, pointer: string, constraint: string, hint: string): void {
    const key = `${pointer}\u0000${code}`;
    if (!this.byKey.has(key)) this.byKey.set(key, { code, pointer, constraint, hint });
  }
  get size(): number { return this.byKey.size; }
  sorted(): ValidationIssue[] {
    return [...this.byKey.values()].sort((a, b) => compareCodeUnits(a.pointer, b.pointer) || compareCodeUnits(a.code, b.code));
  }
}

// ---- schema registry -----------------------------------------------------------------------------------------

interface Registry {
  validators: { envelope: ValidateFunction; bundle: ValidateFunction; run: ValidateFunction };
  /** Schema node -> the document it lives in, so a `#/$defs/x` reference can be resolved from any node. */
  baseOf: WeakMap<object, SchemaDocument>;
  byId: Map<string, SchemaDocument>;
}
let registry: Registry | null = null;
function schemaRegistry(): Registry {
  if (registry !== null) return registry;
  const documents = loadSchemaDocuments();
  const ajv = createSchemaRegistry({ verbose: true, documents });
  const baseOf = new WeakMap<object, SchemaDocument>();
  const byId = new Map<string, SchemaDocument>();
  for (const entry of documents) {
    byId.set(entry.id, entry);
    const stack: unknown[] = [entry.document];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === null || typeof node !== "object") continue;
      baseOf.set(node, entry);
      for (const child of Object.values(node)) stack.push(child);
    }
  }
  const validator = (id: string): ValidateFunction => {
    const found = ajv.getSchema(id);
    if (found === undefined) throw new Error(`schema ${id} is not registered`);
    return found;
  };
  registry = {
    validators: {
      envelope: validator("urn:paneweft:schema:envelope:1"),
      bundle: validator("urn:paneweft:schema:bundle:1"),
      run: validator("urn:paneweft:schema:run-output:1"),
    },
    baseOf,
    byId,
  };
  return registry;
}

function resolveReference(reference: string, from: object): { node: Obj; document: SchemaDocument } | null {
  const { baseOf, byId } = schemaRegistry();
  const hashAt = reference.indexOf("#");
  const idPart = hashAt < 0 ? reference : reference.slice(0, hashAt);
  const fragment = hashAt < 0 ? "" : reference.slice(hashAt + 1);
  const document = idPart === "" ? baseOf.get(from) : byId.get(idPart);
  if (document === undefined) return null;
  let node: Json = document.document;
  for (const raw of fragment.split("/").slice(1)) {
    node = node?.[raw.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (node === undefined) return null;
  }
  return { node, document };
}

/** Every property name any branch of `schema` (through $ref, allOf, anyOf, oneOf, if/then/else) can declare. */
function declaredProperties(schema: Obj, seen = new Set<object>()): Set<string> {
  const names = new Set<string>();
  const visit = (node: Json): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    for (const name of Object.keys(node.properties ?? {})) names.add(name);
    for (const key of ["allOf", "anyOf", "oneOf"]) for (const child of node[key] ?? []) visit(child);
    for (const key of ["if", "then", "else"]) visit(node[key]);
    if (typeof node.$ref === "string") {
      const target = resolveReference(node.$ref, node);
      if (target !== null) visit(target.node);
    }
  };
  visit(schema);
  return names;
}

// ---- Ajv error normalisation -----------------------------------------------------------------------------------

function describeAllowed(values: unknown): string {
  return Array.isArray(values) ? values.map((value) => JSON.stringify(value)).join(", ") : String(values);
}

function normaliseAjvErrors(errors: ErrorObject[], issues: IssueSet, prefix: string): void {
  for (const error of errors) {
    if (error.keyword === "if") continue; // the wrapper Ajv adds when a then/else branch fails; the branch's own errors are the fault
    const parent = (error.parentSchema ?? {}) as Obj;
    const params = error.params as Obj;
    const here = prefix + error.instancePath;
    const own = typeof parent["x-hint"] === "string" ? (parent["x-hint"] as string) : null;
    switch (error.keyword) {
      case "required": {
        const name = String(params.missingProperty);
        const propertyHint = (parent.properties?.[name] as Obj | undefined)?.["x-hint"];
        issues.add("REQUIRED", `${here}/${escapeToken(name)}`, `required: ${name}`, own ?? (typeof propertyHint === "string" ? propertyHint : `Add the required property "${name}".`));
        break;
      }
      case "type": {
        const expected = Array.isArray(params.type) ? params.type.join(" | ") : String(params.type);
        issues.add("TYPE", here, `type: ${expected}`, own ?? `Use a value of type ${expected}.`);
        break;
      }
      case "enum": {
        const allowed = describeAllowed(params.allowedValues);
        const code: IssueCode = error.instancePath.endsWith("/component") ? "UNKNOWN_COMPONENT" : "ENUM";
        issues.add(code, here, `enum: ${allowed}`, own ?? `Use one of: ${allowed}.`);
        break;
      }
      case "const": {
        const literal = JSON.stringify(params.allowedValue);
        const code: IssueCode = error.instancePath.endsWith("/schemaVersion") ? "SCHEMA_VERSION" : "ENUM";
        issues.add(code, here, `const: ${literal}`, own ?? `Use the literal ${literal}.`);
        break;
      }
      case "additionalProperties": {
        const name = String(params.additionalProperty);
        issues.add("UNKNOWN_PROPERTY", `${here}/${escapeToken(name)}`, "no additional properties", `Remove the unknown property "${name}".`);
        break;
      }
      case "unevaluatedProperties": {
        const name = String(params.unevaluatedProperty);
        if (declaredProperties(parent).has(name)) break; // an echo: a failing allOf branch dropped the annotation of a declared property
        issues.add("UNKNOWN_PROPERTY", `${here}/${escapeToken(name)}`, "no unevaluated properties", `Remove the unknown property "${name}".`);
        break;
      }
      case "false schema":
        issues.add("FORBIDDEN_PROPERTY", here, "property not allowed here", own ?? "Remove this property; the other members of the object forbid it.");
        break;
      case "pattern":
        issues.add("PATTERN", here, `pattern: ${String(params.pattern)}`, own ?? `Use a value matching ${String(params.pattern)}.`);
        break;
      case "format":
        issues.add("PATTERN", here, `format: ${String(params.format)}`, own ?? `Use a value in ${String(params.format)} format.`);
        break;
      case "minimum":
      case "maximum":
      case "exclusiveMinimum":
      case "exclusiveMaximum":
        issues.add("OUT_OF_RANGE", here, `${error.keyword}: ${String(params.limit)}`, own ?? `Use a number ${String(params.comparison ?? error.keyword)} ${String(params.limit)}.`);
        break;
      case "minLength":
      case "maxLength":
      case "minItems":
      case "maxItems":
      case "minProperties":
      case "maxProperties":
      case "uniqueItems":
        issues.add("SIZE", here, `${error.keyword}: ${String(params.limit ?? "")}`.trim(), own ?? (error.keyword === "minLength" ? "Use a non-empty value." : `Respect the ${error.keyword} bound of ${String(params.limit ?? "this schema")}.`));
        break;
      default:
        issues.add("CONSTRAINT", here, `${error.keyword}`, own ?? `The value violates the schema keyword "${error.keyword}".`);
    }
  }
}

// ---- limits (design section 4) -----------------------------------------------------------------------------------

const ITEM_ARRAYS = ["rows", "nodes", "edges", "fields", "blocks", "annotations", "runs"] as const;
const SCOPE_HINT = "Scope the view to fewer facts or partition it into several smaller views, linked from a summary view.";

interface ViewSite { pointer: string; view: Obj }
function viewSites(root: Obj, kind: DocumentKind): ViewSite[] {
  if (kind === "envelope") return [{ pointer: "", view: root }];
  const container = kind === "bundle" ? root : root.bundle;
  const prefix = kind === "bundle" ? "" : "/bundle";
  if (container === null || typeof container !== "object" || !Array.isArray(container.views)) return [];
  return container.views.flatMap((view: Json, index: number) => (view !== null && typeof view === "object" ? [{ pointer: `${prefix}/views/${index}`, view }] : []));
}

function utf8Length(text: string): number {
  return text.length * 3 <= LIMITS.stringBytes ? text.length : Buffer.byteLength(text, "utf8");
}

function limitIssues(root: Obj, kind: DocumentKind): IssueSet {
  const issues = new IssueSet();
  // depth and strings in one iterative walk: a hostile document must not be able to overflow the stack
  type Frame = { value: Json; pointer: string; depth: number };
  const stack: Frame[] = [{ value: root, pointer: "", depth: 1 }];
  let tooDeep = false;
  while (stack.length > 0) {
    const { value, pointer, depth } = stack.pop() as Frame;
    if (typeof value === "string") {
      if (utf8Length(value) > LIMITS.stringBytes) issues.add("LIMIT_EXCEEDED", pointer, `string: at most ${LIMITS.stringBytes} UTF-8 bytes`, "Shorten the text or move it into a separate, referenced source.");
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    if (depth > LIMITS.nestingLevels) {
      tooDeep = true;
      issues.add("LIMIT_EXCEEDED", pointer, `nesting: at most ${LIMITS.nestingLevels} levels`, "Flatten the structure; deeply nested data has no place in a view.");
      continue; // do not descend: one issue per offending branch
    }
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) stack.push({ value: value[index], pointer: `${pointer}/${index}`, depth: depth + 1 });
    } else {
      for (const key of Object.keys(value)) stack.push({ value: value[key], pointer: `${pointer}/${escapeToken(key)}`, depth: depth + 1 });
    }
  }
  for (const { pointer, view } of viewSites(root, kind)) {
    const data = view.data;
    if (data === null || typeof data !== "object") continue;
    for (const key of ITEM_ARRAYS) {
      const items = data[key];
      if (Array.isArray(items) && items.length > LIMITS.factItemsPerView) issues.add("LIMIT_EXCEEDED", `${pointer}/data/${key}`, `${key}: at most ${LIMITS.factItemsPerView} fact items per view`, SCOPE_HINT);
    }
    if (Array.isArray(data.nodes) && view.component === "graph" && data.nodes.length > LIMITS.graphNodes) issues.add("LIMIT_EXCEEDED", `${pointer}/data/nodes`, `nodes: at most ${LIMITS.graphNodes} graph nodes`, SCOPE_HINT);
    if (Array.isArray(data.edges) && view.component === "graph" && data.edges.length > LIMITS.graphEdges) issues.add("LIMIT_EXCEEDED", `${pointer}/data/edges`, `edges: at most ${LIMITS.graphEdges} graph edges`, SCOPE_HINT);
  }
  if (!tooDeep) {
    const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
    if (kind === "envelope") {
      if (size(root) > LIMITS.viewBytes) issues.add("LIMIT_EXCEEDED", "", `view: at most ${LIMITS.viewBytes} bytes`, SCOPE_HINT);
    } else {
      const container = kind === "bundle" ? root : root.bundle;
      const containerPointer = kind === "bundle" ? "" : "/bundle";
      if (container !== null && typeof container === "object" && size(container) > LIMITS.bundleBytes) issues.add("LIMIT_EXCEEDED", containerPointer, `bundle: at most ${LIMITS.bundleBytes} bytes`, SCOPE_HINT);
      for (const { pointer, view } of viewSites(root, kind)) {
        if (size(view) > LIMITS.viewBytes) issues.add("LIMIT_EXCEEDED", pointer, `view: at most ${LIMITS.viewBytes} bytes`, SCOPE_HINT);
      }
    }
  }
  return issues;
}

// ---- semantic checks ---------------------------------------------------------------------------------------------

type DocumentKind = "envelope" | "bundle" | "run";

interface LocatedItem { pointer: string; item: Obj; ownRunId?: string }

/** Every Item of a view in document order (also the order of the single id namespace; red-contract section 2 and val.md Q7). */
function itemsOfView(view: Obj, base: string): LocatedItem[] {
  const data = view.data as Obj | undefined;
  if (data === undefined) return [];
  const at = (...tokens: Array<string | number>) => base + "/data" + pointerOf(...tokens);
  const located: LocatedItem[] = [];
  const each = (key: string) => (Array.isArray(data[key]) ? data[key] : []).forEach((item: Obj, index: number) => located.push({ pointer: at(key, index), item }));
  switch (view.component) {
    case "list": each("rows"); break;
    case "tree": each("nodes"); break;
    case "graph": each("nodes"); each("edges"); break;
    case "source":
      if (data.excerpt) located.push({ pointer: at("excerpt"), item: data.excerpt });
      each("annotations");
      break;
    case "shape": each("fields"); break;
    case "notebook": each("blocks"); break;
    case "example":
      if (data.scenario) located.push({ pointer: at("scenario"), item: data.scenario });
      (data.runs ?? []).forEach((run: Obj, index: number) => located.push({ pointer: at("runs", index), item: run, ownRunId: run.runId }));
      (data.runs ?? []).forEach((run: Obj, index: number) => (run.assertions ?? []).forEach((assertion: Obj, at2: number) => located.push({ pointer: at("runs", index, "assertions", at2), item: assertion })));
      break;
  }
  return located;
}

interface SourceIndex { get(id: string): Obj | undefined }

/** Evidence, basis, anchors and provenance of one Item. `recorded` resolves anchors to a recorded content hash (absent: not checked). */
function checkItem(entry: LocatedItem, sources: SourceIndex, itemIds: Set<string>, recorded: ((repository: string, path: string) => boolean) | null, issues: IssueSet): void {
  const { item, pointer } = entry;
  const evidence: string[] = Array.isArray(item.evidence) ? item.evidence : [];
  let dangling = false;
  evidence.forEach((id, index) => {
    if (sources.get(id) === undefined) {
      dangling = true;
      issues.add("DANGLING_REFERENCE", `${pointer}/evidence/${index}`, "evidence must name a declared source", `Declare a source with id "${id}" in the envelope's sources, or cite an existing source id.`);
    }
  });
  (Array.isArray(item.basis) ? item.basis : []).forEach((id: string, index: number) => {
    if (sources.get(id) === undefined && !itemIds.has(id)) {
      issues.add("DANGLING_REFERENCE", `${pointer}/basis/${index}`, "basis must name an item or source of this view", `Use the id of a supporting item of this view or of a declared source; "${id}" is neither.`);
    }
  });
  if (item.anchor !== undefined && item.anchor !== null) {
    const lines: number[] = item.anchor.lines;
    if (lines[0]! > lines[1]!) issues.add("INVALID_LINE_RANGE", `${pointer}/anchor/lines`, "lines: [first, last] with first <= last", "Use one-based inclusive lines with the first line not after the last.");
    if (recorded !== null && !recorded(item.anchor.repository, item.anchor.path)) {
      issues.add("DANGLING_REFERENCE", `${pointer}/anchor/path`, "anchor must resolve to a recorded file hash", `Record the sha256 of "${item.anchor.path}" in freshness.repositories["${item.anchor.repository}"].files.`);
    }
  }
  if (dangling) return; // the provenance rules read the cited sources; with an unresolved citation they have nothing sound to read
  const cited = evidence.map((id) => sources.get(id) as Obj);
  if (item.provenance === "observed") {
    // N2/S4: an observed example run is honest only through a run source of its OWN run id; other observed facts may also
    // cite a captured command or log that carries a run id (the older, still valid, shape outside the run-source contract).
    const honest = entry.ownRunId !== undefined
      ? cited.some((source) => source.kind === "run" && source.run_id === entry.ownRunId)
      : cited.some((source) => source.kind === "run" || source.runId !== undefined);
    if (!honest) {
      const hint = entry.ownRunId !== undefined
        ? `Cite a source of kind "run" whose run_id is "${entry.ownRunId}"; a file or command source cannot show that this run was observed.`
        : "Cite a source of kind \"run\", or a command or log source that carries a runId.";
      issues.add("PROVENANCE_RUN_REQUIRED", `${pointer}/provenance`, "observed needs a run source", hint);
    }
  }
  if (item.provenance === "compiled" && !cited.some((source) => source.kind === "tool")) {
    issues.add("PROVENANCE_TOOL_REQUIRED", `${pointer}/provenance`, "compiled needs a tool source", "Cite a source of kind \"tool\" (name and version of the compiler or language service) beside any file evidence.");
  }
}

function sourceIndexOf(sources: Obj[]): SourceIndex & { ids: Set<string> } {
  const byId = new Map<string, Obj>();
  for (const source of sources) if (!byId.has(source.id)) byId.set(source.id, source);
  return { get: (id) => byId.get(id), ids: new Set(byId.keys()) };
}

function checkDuplicateIds(entries: LocatedItem[], issues: IssueSet): Set<string> {
  const seen = new Set<string>();
  for (const { item, pointer } of entries) {
    if (seen.has(item.id)) issues.add("DUPLICATE_ID", `${pointer}/id`, "ids are unique within a view", `The id "${item.id}" is already used in this view; item ids share one namespace.`);
    seen.add(item.id);
  }
  return seen;
}

function checkRunRules(run: Obj, pointer: string, issues: IssueSet): void {
  if (run.status === "passed" && Array.isArray(run.assertions) && run.assertions.some((assertion: Obj) => assertion.passed === false)) {
    issues.add("PASSED_WITH_FAILED_ASSERTION", `${pointer}/status`, "a passed run has only passing assertions", "Set the run status to \"failed\" or correct the failing assertion.");
  }
}

function checkComponent(view: Obj, base: string, itemIds: Set<string>, issues: IssueSet): void {
  const data = view.data as Obj;
  const at = (...tokens: Array<string | number>) => base + "/data" + pointerOf(...tokens);
  const dangling = (pointer: string, what: string) => issues.add("DANGLING_REFERENCE", pointer, what, `Reference an id that exists in this view; ${what}.`);
  switch (view.component) {
    case "list": {
      const columns = new Set<string>((data.columns as Obj[]).map((column) => column.key));
      (data.rows as Obj[]).forEach((row, index) => {
        for (const key of Object.keys(row.cells ?? {})) if (!columns.has(key)) dangling(at("rows", index, "cells", key), "a cell must belong to a declared column");
      });
      if (!columns.has(data.order.key)) dangling(at("order", "key"), "order.key must name a declared column");
      break;
    }
    case "tree": {
      const columns = new Set<string>((data.columns as Obj[]).map((column) => column.key));
      const nodes = new Map<string, { node: Obj; index: number }>();
      (data.nodes as Obj[]).forEach((node, index) => { if (!nodes.has(node.id)) nodes.set(node.id, { node, index }); });
      (data.roots as string[]).forEach((root, index) => { if (!nodes.has(root)) dangling(at("roots", index), "a root must name a node"); });
      (data.nodes as Obj[]).forEach((node, index) => {
        for (const key of Object.keys(node.cells ?? {})) if (!columns.has(key)) dangling(at("nodes", index, "cells", key), "a cell must belong to a declared column");
        (node.children as string[]).forEach((child, at2) => { if (!nodes.has(child)) dangling(at("nodes", index, "children", at2), "a child must name a node"); });
      });
      detectTreeCycles(data, nodes, (index, childIndex) => issues.add("TREE_CYCLE", at("nodes", index, "children", childIndex), "a node is not its own descendant", "Break the cycle; use a graph for cyclic structure or a second occurrence node with its own id."));
      break;
    }
    case "graph": {
      const nodeIds = new Set<string>((data.nodes as Obj[]).map((node) => node.id));
      const edges = new Map<string, Obj>();
      (data.edges as Obj[]).forEach((edge, index) => {
        if (!edges.has(edge.id)) edges.set(edge.id, edge);
        if (!nodeIds.has(edge.from)) dangling(at("edges", index, "from"), "an edge endpoint must name a node");
        if (!nodeIds.has(edge.to)) dangling(at("edges", index, "to"), "an edge endpoint must name a node");
      });
      if (data.focus && !nodeIds.has(data.focus.node)) dangling(at("focus", "node"), "focus.node must name a node");
      (data.paths ?? []).forEach((path: Obj, index: number) => {
        const known = (path.edgeIds as string[]).map((id) => edges.get(id));
        known.forEach((edge, at2) => { if (edge === undefined) dangling(at("paths", index, "edgeIds", at2), "a path must name edges"); });
        for (let at2 = 1; at2 < known.length; at2++) {
          const previous = known[at2 - 1];
          const current = known[at2];
          if (previous !== undefined && current !== undefined && previous.to !== current.from) {
            issues.add("PATH_DISCONTINUOUS", at("paths", index, "edgeIds", at2), "path edges are contiguous", `Edge "${current.id}" starts at "${current.from}" but the previous edge "${previous.id}" ends at "${previous.to}".`);
          }
        }
      });
      break;
    }
    case "source": {
      const excerpt = data.excerpt as Obj;
      const [first, last] = excerpt.anchor.lines as number[];
      const excerptOk = first! <= last!;
      if (!excerptOk) issues.add("INVALID_LINE_RANGE", at("excerpt", "anchor", "lines"), "lines: [first, last] with first <= last", "Use one-based inclusive lines with the first line not after the last.");
      (data.annotations as Obj[]).forEach((annotation, index) => {
        const [start, end] = annotation.lines as number[];
        if (start! > end!) {
          issues.add("INVALID_LINE_RANGE", at("annotations", index, "lines"), "lines: [first, last] with first <= last", "Use one-based inclusive lines with the first line not after the last.");
        } else if (excerptOk && (start! < first! || end! > last!)) {
          issues.add("ANNOTATION_OUTSIDE_EXCERPT", at("annotations", index, "lines"), `lines inside the excerpt [${first}, ${last}]`, `Annotate only lines ${first} to ${last}, the lines the stored excerpt covers.`);
        }
      });
      break;
    }
    case "shape": {
      const fieldIds = new Set<string>((data.fields as Obj[]).map((field) => field.id));
      (data.fields as Obj[]).forEach((field, index) => {
        (field.children as string[]).forEach((child, at2) => { if (!fieldIds.has(child)) dangling(at("fields", index, "children", at2), "a child must name a field"); });
        if (field.ref !== undefined && !fieldIds.has(field.ref)) dangling(at("fields", index, "ref"), "ref must name a field");
      });
      break;
    }
    case "notebook": {
      void itemIds;
      break; // notebook references to other views are checked per bundle; bare source ids below
    }
    case "example": {
      const seenRunIds = new Set<string>();
      (data.runs as Obj[]).forEach((run, index) => {
        if (seenRunIds.has(run.runId)) issues.add("DUPLICATE_ID", at("runs", index, "runId"), "run ids are unique within a view", `The run id "${run.runId}" is already recorded in this view.`);
        seenRunIds.add(run.runId);
        checkRunRules(run, at("runs", index), issues);
      });
      break;
    }
  }
}

/** Depth-first walk from the roots (then any unvisited node, in array order); every edge into a node on the current path closes a cycle. */
function detectTreeCycles(data: Obj, nodes: Map<string, { node: Obj; index: number }>, report: (nodeIndex: number, childIndex: number) => void): void {
  const state = new Map<string, "open" | "done">();
  const walk = (startId: string): void => {
    const start = nodes.get(startId);
    if (start === undefined || state.has(startId)) return;
    const stack: Array<{ id: string; next: number }> = [{ id: startId, next: 0 }];
    state.set(startId, "open");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { id: string; next: number };
      const entry = nodes.get(frame.id) as { node: Obj; index: number };
      const children: string[] = entry.node.children ?? [];
      if (frame.next >= children.length) {
        state.set(frame.id, "done");
        stack.pop();
        continue;
      }
      const childIndex = frame.next++;
      const childId = children[childIndex] as string;
      if (!nodes.has(childId)) continue;
      const childState = state.get(childId);
      if (childState === "open") report(entry.index, childIndex);
      else if (childState === undefined) {
        state.set(childId, "open");
        stack.push({ id: childId, next: 0 });
      }
    }
  };
  for (const root of data.roots as string[]) walk(root);
  for (const node of data.nodes as Obj[]) walk(node.id);
}

function checkNotebookSourceTargets(view: Obj, base: string, sources: SourceIndex, issues: IssueSet): void {
  (view.data.blocks as Obj[]).forEach((block, index) => {
    for (const key of ["supports", "contradicts"] as const) {
      (block[key] ?? []).forEach((target: Json, at: number) => {
        if (typeof target === "string" && sources.get(target) === undefined) {
          issues.add("DANGLING_REFERENCE", `${base}/data/blocks/${index}/${key}/${at}`, "a bare evidence target must be a source id of this view", `"${target}" is not a source declared by this view; use a source id or {viewId, itemId}.`);
        }
      });
    }
  });
}

/** Checks one view instance on its own (everything that needs no other member). */
function checkView(view: Obj, base: string, issues: IssueSet): void {
  const sources = sourceIndexOf(view.sources ?? []);
  const entries = itemsOfView(view, base);
  const itemIds = checkDuplicateIds(entries, issues);
  const files = new Map<string, Set<string>>();
  for (const repository of view.freshness?.repositories ?? []) files.set(repository.id, new Set(Object.keys(repository.files ?? {})));
  const recorded = (repository: string, path: string): boolean => files.get(repository)?.has(path) === true;
  for (const entry of entries) checkItem(entry, sources, itemIds, recorded, issues);
  if (view.data !== undefined) {
    checkComponent(view, base, itemIds, issues);
    if (view.component === "notebook") checkNotebookSourceTargets(view, base, sources, issues);
  }
}

/** The item ids a notebook may point at in a view. */
function itemIdsOf(view: Obj): Set<string> {
  return new Set(itemsOfView(view, "").map((entry) => entry.item.id as string));
}

function stableEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** Cross-member rules of a bundle (also reused for the bundle inside a run output). */
function checkBundle(bundle: Obj, prefix: string, context: ReferenceContext | undefined, issues: IssueSet): void {
  const entities = bundle.entities as Obj[];
  const definitions = bundle.definitions as Obj[];
  const views = bundle.views as Obj[];

  // identities (S8): a later member that repeats an identity with different content conflicts; an exact repeat is idempotent
  const entityByIdentity = new Map<string, Obj>();
  entities.forEach((entity, index) => {
    const key = `${entity.snapshotId}\u0000${entity.repository}\u0000${entity.kind}\u0000${entity.id}`;
    const first = entityByIdentity.get(key);
    if (first === undefined) entityByIdentity.set(key, entity);
    else if (!stableEqual(first, entity)) issues.add("IDENTITY_CONFLICT", `${prefix}/entities/${index}`, "an entity identity has one content per snapshot", "Use a new snapshot id for changed entity data; the same (repository, kind, id, snapshot) cannot be redefined.");
  });
  const definitionById = new Map<string, Obj>();
  definitions.forEach((definition, index) => {
    const first = definitionById.get(definition.id);
    if (first === undefined) definitionById.set(definition.id, definition);
    else if (!stableEqual(first, definition)) issues.add("IDENTITY_CONFLICT", `${prefix}/definitions/${index}`, "a definition id has one content", "Use a new definition id; an existing definition cannot be redefined in the same bundle.");
    const known = context?.definitions?.find((candidate) => candidate.id === definition.id);
    if (known !== undefined && (known.component !== definition.component || known.entityKind !== definition.entityKind)) {
      issues.add("IDENTITY_CONFLICT", `${prefix}/definitions/${index}`, "a definition id has one content", `Definition "${definition.id}" is already registered with component "${known.component}" and entity kind "${known.entityKind}".`);
    }
  });
  const viewByIdentity = new Map<string, Obj>();
  views.forEach((view, index) => {
    const key = `${view.snapshotId}\u0000${view.id}`;
    const first = viewByIdentity.get(key);
    if (first === undefined) viewByIdentity.set(key, view);
    else if (!stableEqual(first, view)) issues.add("IDENTITY_CONFLICT", `${prefix}/views/${index}`, "a view identity has one content per snapshot", "Use a new snapshot id for a changed view; (view id, snapshot) is immutable.");
  });

  // alias cycles: every definition that lies ON a forward cycle
  const forwardTarget = (definition: Obj): string | undefined => definition.forward?.viewDefinitionId;
  definitions.forEach((definition, index) => {
    if (definition.forward !== undefined && !definitionById.has(definition.forward.viewDefinitionId) && context?.definitions?.some((known) => known.id === definition.forward.viewDefinitionId) !== true) {
      issues.add("DANGLING_REFERENCE", `${prefix}/definitions/${index}/forward/viewDefinitionId`, "a forward must name a registered definition", `No definition "${definition.forward.viewDefinitionId}" is registered.`);
    }
    let cursor: string | undefined = forwardTarget(definition);
    for (let steps = 0; cursor !== undefined && steps <= definitions.length; steps++) {
      if (cursor === definition.id) {
        issues.add("ALIAS_CYCLE", `${prefix}/definitions/${index}/forward`, "forward chains are acyclic", "Break the cycle: a definition must not forward, directly or through others, to itself.");
        break;
      }
      const next = definitionById.get(cursor);
      cursor = next === undefined ? undefined : forwardTarget(next);
    }
  });

  // view -> entity, definition, metadata agreement (MC12, S8)
  const contextEntityKeys = new Set((context?.entities ?? []).map((entity) => `${entity.snapshotId}\u0000${entity.repository}\u0000${entity.kind}\u0000${entity.id}`));
  views.forEach((view, index) => {
    const entityKey = `${view.snapshotId}\u0000${view.entity.repository}\u0000${view.entity.kind}\u0000${view.entity.id}`;
    if (!entityByIdentity.has(entityKey) && !contextEntityKeys.has(entityKey)) {
      issues.add("DANGLING_REFERENCE", `${prefix}/views/${index}/entity`, "a view's entity must be registered", `Add entity ${view.entity.repository}/${view.entity.kind}/${view.entity.id} for snapshot "${view.snapshotId}" to the bundle's entities.`);
    }
    const definition: DefinitionMetadata | undefined = definitionById.has(view.viewDefinitionId)
      ? { id: view.viewDefinitionId, component: definitionById.get(view.viewDefinitionId)?.component, entityKind: definitionById.get(view.viewDefinitionId)?.entityKind }
      : context?.definitions?.find((known) => known.id === view.viewDefinitionId);
    if (definition === undefined) {
      issues.add("DANGLING_REFERENCE", `${prefix}/views/${index}/viewDefinitionId`, "a view's definition must be registered", `Add a definition "${view.viewDefinitionId}" to the bundle or register it first.`);
      return;
    }
    if (definition.component !== view.component) issues.add("DEFINITION_MISMATCH", `${prefix}/views/${index}/component`, `component: ${definition.component}`, `Definition "${definition.id}" is a "${definition.component}" view; this instance is "${view.component}".`);
    if (definition.entityKind !== view.entity.kind) issues.add("DEFINITION_MISMATCH", `${prefix}/views/${index}/entity/kind`, `entity kind: ${definition.entityKind}`, `Definition "${definition.id}" is for entity kind "${definition.entityKind}"; this instance's entity has kind "${view.entity.kind}".`);
  });

  // notebook references to other views (bundle scope only)
  const viewIdsInBundle = new Map<string, Set<string>>();
  for (const view of views) {
    const ids = viewIdsInBundle.get(view.id) ?? new Set<string>();
    for (const id of itemIdsOf(view)) ids.add(id);
    viewIdsInBundle.set(view.id, ids);
  }
  const itemsOfViewId = (viewId: string): Set<string> | null => {
    const found = new Set<string>();
    let any = false;
    const inBundle = viewIdsInBundle.get(viewId);
    if (inBundle !== undefined) { any = true; for (const id of inBundle) found.add(id); }
    for (const known of context?.views ?? []) if (known.id === viewId) { any = true; for (const id of known.itemIds) found.add(id); }
    return any ? found : null;
  };
  views.forEach((view, index) => {
    if (view.component !== "notebook" || view.data === undefined) return;
    (view.data.blocks as Obj[]).forEach((block, at) => {
      const blockPointer = `${prefix}/views/${index}/data/blocks/${at}`;
      for (const key of ["viewId", "exampleId"] as const) {
        if (typeof block[key] === "string" && itemsOfViewId(block[key]) === null) {
          issues.add("DANGLING_REFERENCE", `${blockPointer}/${key}`, "a notebook block must name a registered view", `No view "${block[key]}" is in this bundle or the session.`);
        }
      }
      for (const key of ["supports", "contradicts"] as const) {
        (block[key] ?? []).forEach((target: Json, targetIndex: number) => {
          if (target === null || typeof target !== "object") return; // bare source ids: checked per view
          const items = itemsOfViewId(target.viewId);
          if (items === null || !items.has(target.itemId)) {
            issues.add("DANGLING_REFERENCE", `${blockPointer}/${key}/${targetIndex}`, "evidence must name an existing view item", `View "${target.viewId}" ${items === null ? "is not in this bundle or the session" : `has no item "${target.itemId}"`}.`);
          }
        });
      }
    });
  });
}

/** Context checks for a lone envelope (session putView): entity and definition must already be known. */
function checkEnvelopeContext(view: Obj, context: ReferenceContext, issues: IssueSet): void {
  if (context.entities !== undefined) {
    const known = context.entities.some((entity) => entity.snapshotId === view.snapshotId && entity.repository === view.entity.repository && entity.kind === view.entity.kind && entity.id === view.entity.id);
    if (!known) issues.add("DANGLING_REFERENCE", "/entity", "a view's entity must be registered", `Register entity ${view.entity.repository}/${view.entity.kind}/${view.entity.id} for snapshot "${view.snapshotId}" first (a bundle import registers entities with their views).`);
  }
  if (context.definitions !== undefined) {
    const definition = context.definitions.find((candidate) => candidate.id === view.viewDefinitionId);
    if (definition === undefined) {
      issues.add("DANGLING_REFERENCE", "/viewDefinitionId", "a view's definition must be registered", `Register a definition "${view.viewDefinitionId}" first.`);
    } else {
      if (definition.component !== view.component) issues.add("DEFINITION_MISMATCH", "/component", `component: ${definition.component}`, `Definition "${definition.id}" is a "${definition.component}" view; this instance is "${view.component}".`);
      if (definition.entityKind !== view.entity.kind) issues.add("DEFINITION_MISMATCH", "/entity/kind", `entity kind: ${definition.entityKind}`, `Definition "${definition.id}" is for entity kind "${definition.entityKind}"; this instance's entity has kind "${view.entity.kind}".`);
    }
  }
}

// ---- public entry points -------------------------------------------------------------------------------------------

const VERSION_PROPERTY = "/schemaVersion";
const PINNED: Record<DocumentKind, string> = { envelope: "paneweft.view/1", bundle: "paneweft.bundle/1", run: "paneweft.run/1" };

function classify(root: unknown, expected: DocumentKind | null): { kind: DocumentKind | "unknown"; issue: IssueSet | null } {
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    const issues = new IssueSet();
    issues.add("TYPE", "", "type: object", "Submit a JSON object: an envelope (paneweft.view/1) or a bundle (paneweft.bundle/1).");
    return { kind: "unknown", issue: issues };
  }
  const version = (root as Obj).schemaVersion;
  if (version === undefined) {
    const issues = new IssueSet();
    issues.add("REQUIRED", VERSION_PROPERTY, "required: schemaVersion", expected === null ? 'Add "schemaVersion": "paneweft.view/1" (envelope) or "paneweft.bundle/1" (bundle).' : `Add "schemaVersion": "${PINNED[expected]}".`);
    return { kind: "unknown", issue: issues };
  }
  const kindOfVersion: DocumentKind | null = version === PINNED.envelope ? "envelope" : version === PINNED.bundle ? "bundle" : version === PINNED.run ? "run" : null;
  if (expected === null ? kindOfVersion === "run" || kindOfVersion === null : kindOfVersion !== expected) {
    const issues = new IssueSet();
    const literal = expected === null ? `"${PINNED.envelope}" or "${PINNED.bundle}"` : `"${PINNED[expected]}"`;
    issues.add("SCHEMA_VERSION", VERSION_PROPERTY, `const: ${literal}`, `Use the literal ${literal}.`);
    const guess = typeof version === "string" && version.startsWith("paneweft.bundle") ? "bundle" : typeof version === "string" && version.startsWith("paneweft.view") ? "envelope" : "unknown";
    return { kind: expected ?? guess, issue: issues };
  }
  return { kind: kindOfVersion as DocumentKind, issue: null };
}

function reportOf(kind: DocumentKind | "unknown", issues: IssueSet): ValidationReport {
  if (issues.size === 0 && kind !== "unknown") return { ok: true, kind, notes: [] };
  return { ok: false, kind, errors: issues.sorted() };
}

export function validateSubmission(input: unknown, context?: ReferenceContext): ValidationReport {
  const { kind, issue } = classify(input, null);
  if (issue !== null) return reportOf(kind, issue);
  const root = input as Obj;
  const kindOfDocument = kind as "envelope" | "bundle";
  const limits = limitIssues(root, kindOfDocument);
  if (limits.size > 0) return reportOf(kindOfDocument, limits);
  const validate = schemaRegistry().validators[kindOfDocument];
  const issues = new IssueSet();
  if (!validate(root)) {
    normaliseAjvErrors(validate.errors ?? [], issues, "");
    return reportOf(kindOfDocument, issues);
  }
  if (kindOfDocument === "envelope") {
    checkView(root, "", issues);
    if (context !== undefined) checkEnvelopeContext(root, context, issues);
  } else {
    (root.views as Obj[]).forEach((view, index) => checkView(view, `/views/${index}`, issues));
    checkBundle(root, "", context, issues);
  }
  return reportOf(kindOfDocument, issues);
}

/** Validates a `paneweft.run/1` document (runner output / example_record input). */
export function validateRunOutput(input: unknown, context?: ReferenceContext): ValidationReport {
  const { kind, issue } = classify(input, "run");
  if (issue !== null) return reportOf(kind, issue);
  const root = input as Obj;
  const limits = limitIssues(root, "run");
  if (limits.size > 0) return reportOf("run", limits);
  const validate = schemaRegistry().validators.run;
  const issues = new IssueSet();
  if (!validate(root)) {
    normaliseAjvErrors(validate.errors ?? [], issues, "");
    return reportOf("run", issues);
  }
  const bundle = root.bundle as Obj;
  // Run and assertion evidence resolves against the output's own sources plus the sources of its bundle's views (val.md Q4, S4).
  const sources = sourceIndexOf([...((root.sources as Obj[] | undefined) ?? []), ...(bundle.views as Obj[]).flatMap((view) => view.sources as Obj[])]);
  const run = root.run as Obj;
  const entries: LocatedItem[] = [
    { pointer: "/run", item: run, ownRunId: run.runId },
    ...(run.assertions as Obj[]).map((assertion, index) => ({ pointer: `/run/assertions/${index}`, item: assertion })),
  ];
  const itemIds = checkDuplicateIds(entries, issues);
  for (const entry of entries) checkItem(entry, sources, itemIds, null, issues);
  checkRunRules(run, "/run", issues);
  if (run.result !== undefined) {
    const inBundle = (bundle.entities as Obj[]).some((entity) => entity.repository === run.result.repository && entity.kind === run.result.kind && entity.id === run.result.id);
    const inContext = (context?.entities ?? []).some((entity) => entity.repository === run.result.repository && entity.kind === run.result.kind && entity.id === run.result.id);
    if (!inBundle && !inContext) {
      issues.add("DANGLING_REFERENCE", "/run/result", "a run's result must be a registered entity", `Register entity ${run.result.repository}/${run.result.kind}/${run.result.id} in the output bundle so the result can be inspected.`);
    }
  }
  (bundle.views as Obj[]).forEach((view, index) => checkView(view, `/bundle/views/${index}`, issues));
  checkBundle(bundle, "/bundle", context, issues);
  return reportOf("run", issues);
}
