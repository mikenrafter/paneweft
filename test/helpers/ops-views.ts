// Builders for the operation-layer tests (tag: ops). Every view is the committed component fixture with
// `patch()` applied, so a negative or large case differs from a known-valid document by named changes only.
// Entities and definitions reuse the shapes of fixtures/components/all.bundle.json (repository `r`).
import { clone, componentFixture } from "./fixtures.ts";
import { patch, type PatchOp } from "./patch.ts";

export type Json = any;
export const WATCH = { repository: "r", id: "watch", kind: "vigil/watch" } as const;
export const MCP = { repository: "r", id: "mcp", kind: "code/module" } as const;
export const NOTES = { repository: "r", id: "notes", kind: "notes/page" } as const;
export const SHA = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"; // sha256("hello\n")

export interface ViewSpec {
  id?: string;
  snapshotId?: string;
  title?: string;
  question?: string;
  definitionId?: string;
  entity?: { repository: string; id: string; kind: string };
  completeness?: Json;
  sources?: Json[];
}

function retarget(base: Json, spec: ViewSpec): PatchOp[] {
  const ops: PatchOp[] = [];
  const set = (path: string, value: unknown) => ops.push({ op: "replace", path, value });
  if (spec.id !== undefined) set("/id", spec.id);
  if (spec.snapshotId !== undefined) set("/snapshotId", spec.snapshotId);
  if (spec.title !== undefined) set("/title", spec.title);
  if (spec.question !== undefined) set("/question", spec.question);
  if (spec.definitionId !== undefined) set("/viewDefinitionId", spec.definitionId);
  if (spec.entity !== undefined) set("/entity", spec.entity);
  if (spec.completeness !== undefined) set("/completeness", spec.completeness);
  if (spec.sources !== undefined) set("/sources", spec.sources);
  return ops;
}

export const complete = (criterion: string) => ({ status: "complete", criterion });
export const partial = (...gaps: Array<[string, string, string?]>) => ({
  status: "partial",
  gaps: gaps.map(([id, question, reason]) => ({ id, question, reason: reason ?? `reason of ${id}` })),
});
export const unsupported = (reason: string, ...missing: string[]) => ({ status: "unsupported", reason, missingCapabilities: missing });

export function fileSource(id: string, path = "src/mcp.rs"): Json {
  return { id, kind: "file", repository: "r", path, sha256: SHA, capturedAt: "2026-11-11T00:00:00Z", method: "read" };
}
export function commandSource(id: string, runId?: string): Json {
  return {
    id, kind: "command", sha256: SHA, capturedAt: "2026-11-11T00:00:00Z", method: `tool ${id}`,
    ...(runId === undefined ? {} : { runId, argv: ["tool", id], exitCode: 0 }),
  };
}

export function item(id: string, extra: Json = {}): Json {
  return { id, provenance: "read", evidence: ["s1"], ...extra };
}
export function row(id: string, cells: Record<string, string | number | boolean | null>, extra: Json = {}): Json {
  return item(id, { cells, ...extra });
}
export const moduleRef = (id: string) => ({ repository: "r", id, kind: "code/module" });

// ---- per-component builders ---------------------------------------------------------------------

export interface ListSpec extends ViewSpec {
  rows?: Json[];
  columns?: Json[];
  order?: { key: string; direction: "asc" | "desc" };
}
export function listView(spec: ListSpec = {}): Json {
  const base = componentFixture("list");
  const ops = retarget(base, spec);
  if (spec.rows !== undefined) ops.push({ op: "replace", path: "/data/rows", value: spec.rows });
  if (spec.columns !== undefined) ops.push({ op: "replace", path: "/data/columns", value: spec.columns });
  if (spec.order !== undefined) ops.push({ op: "replace", path: "/data/order", value: spec.order });
  return patch(base, ...ops);
}

export interface TreeSpec extends ViewSpec { roots?: string[]; nodes?: Json[] }
export function treeView(spec: TreeSpec = {}): Json {
  const base = componentFixture("tree");
  const ops = retarget(base, spec);
  if (spec.roots !== undefined) ops.push({ op: "replace", path: "/data/roots", value: spec.roots });
  if (spec.nodes !== undefined) ops.push({ op: "replace", path: "/data/nodes", value: spec.nodes });
  return patch(base, ...ops);
}
export const treeNode = (id: string, name: string, children: string[] = [], extra: Json = {}) =>
  item(id, { cells: { name }, children, childrenState: "complete", ...extra });

export interface GraphSpec extends ViewSpec { nodes?: Json[]; edges?: Json[]; focus?: Json; paths?: Json[] | null }
export function graphView(spec: GraphSpec = {}): Json {
  const base = componentFixture("graph");
  const ops = retarget(base, spec);
  if (spec.nodes !== undefined) ops.push({ op: "replace", path: "/data/nodes", value: spec.nodes });
  if (spec.edges !== undefined) ops.push({ op: "replace", path: "/data/edges", value: spec.edges });
  if (spec.paths === null) ops.push({ op: "remove", path: "/data/paths" });
  else if (spec.paths !== undefined) ops.push({ op: "replace", path: "/data/paths", value: spec.paths });
  if (spec.focus !== undefined) ops.push({ op: "add", path: "/data/focus", value: spec.focus });
  return patch(base, ...ops);
}
export const node = (id: string, extra: Json = {}) => item(id, extra);
export const edge = (id: string, from: string, to: string, relation: string, extra: Json = {}) => item(id, { from, to, relation, ...extra });

export interface SourceSpec extends ViewSpec { excerpt?: Json; annotations?: Json[] }
export function sourceView(spec: SourceSpec = {}): Json {
  const base = componentFixture("source");
  const ops = retarget(base, spec);
  if (spec.excerpt !== undefined) ops.push({ op: "replace", path: "/data/excerpt", value: spec.excerpt });
  if (spec.annotations !== undefined) ops.push({ op: "replace", path: "/data/annotations", value: spec.annotations });
  return patch(base, ...ops);
}

export interface ShapeSpec extends ViewSpec { fields?: Json[]; root?: string; basis?: "declared" | "observed" }
export function shapeView(spec: ShapeSpec = {}): Json {
  const base = componentFixture("shape");
  const ops = retarget(base, spec);
  if (spec.fields !== undefined) ops.push({ op: "replace", path: "/data/fields", value: spec.fields });
  if (spec.root !== undefined) ops.push({ op: "replace", path: "/data/root", value: spec.root });
  if (spec.basis !== undefined) ops.push({ op: "replace", path: "/data/basis", value: spec.basis });
  return patch(base, ...ops);
}
export const shapeField = (id: string, path: string, type: string, extra: Json = {}) =>
  item(id, { path, type, presence: "required", children: [], ...extra });

export interface NotebookSpec extends ViewSpec { blocks?: Json[] }
export function notebookView(spec: NotebookSpec = {}): Json {
  const base = componentFixture("notebook");
  const ops = retarget(base, spec);
  if (spec.blocks !== undefined) ops.push({ op: "replace", path: "/data/blocks", value: spec.blocks });
  return patch(base, ...ops);
}
export const proseBlock = (id: string, markdown: string, extra: Json = {}) => item(id, { kind: "prose", markdown, ...extra });
export const viewBlock = (id: string, viewId: string, extra: Json = {}) => item(id, { kind: "view", viewId, ...extra });
export const claimBlock = (id: string, statement: string, status: "supported" | "disputed" | "open", extra: Json = {}) =>
  item(id, { kind: "claim", statement, status, supports: [], contradicts: [], ...extra });
export const exampleBlock = (id: string, exampleId: string, extra: Json = {}) => item(id, { kind: "example", exampleId, ...extra });

export interface ExampleSpec extends ViewSpec { scenario?: Json; runs?: Json[] }
export function exampleView(spec: ExampleSpec = {}): Json {
  const base = componentFixture("example");
  const ops = retarget(base, spec);
  if (spec.scenario !== undefined) ops.push({ op: "replace", path: "/data/scenario", value: spec.scenario });
  if (spec.runs !== undefined) ops.push({ op: "replace", path: "/data/runs", value: spec.runs });
  return patch(base, ...ops);
}

/** An unsupported view: no `data` body (envelope schema), a reason and the missing capabilities. */
export function unsupportedView(base: Json, reason: string, ...missing: string[]): Json {
  return patch(base, { op: "replace", path: "/completeness", value: unsupported(reason, ...missing) }, { op: "remove", path: "/data" });
}

/** Points freshness at a real directory holding the inspected bytes ("hello\n", sha256 = SHA), so freshness is fresh. */
export function withFreshnessRoot(view: Json, root: string, files: Record<string, string> = { "src/mcp.rs": SHA }): Json {
  return patch(
    view,
    { op: "replace", path: "/freshness/repositories/0/root", value: root },
    { op: "replace", path: "/freshness/repositories/0/gitRev", value: null }, // a plain directory, not a Git work tree
    { op: "replace", path: "/freshness/repositories/0/files", value: files },
  );
}

// ---- bundles -------------------------------------------------------------------------------------

export interface BundleOptions {
  /** Extra or overriding entities, keyed by repository/kind/id/snapshotId. */
  entities?: Json[];
  /** Extra definitions (a definition with the same id as a synthesised one replaces it). */
  definitions?: Json[];
  /** Entity data roles to grant in addition to the roles of the supplied definitions. */
  extraRoles?: Record<string, string[]>;
}

const entityKey = (e: Json) => `${e.repository}\u0000${e.kind}\u0000${e.id}\u0000${e.snapshotId}`;

/**
 * Wraps views into a valid bundle. For every view an entity (at its snapshot) and a definition are
 * synthesised: definition id = view.viewDefinitionId, data role `role-<definition id>`, which the
 * entity is granted, so every definition is available. The `code/module:mcp` entity exists for every snapshot used.
 */
export function bundleOf(views: Json[], options: BundleOptions = {}): Json {
  const entities = new Map<string, Json>();
  const definitions = new Map<string, Json>();
  const snapshots = new Set<string>(views.map((view) => view.snapshotId as string));
  const addEntity = (ref: Json, snapshotId: string, label?: string) => {
    const key = entityKey({ ...ref, snapshotId });
    if (!entities.has(key)) entities.set(key, { ...clone(ref), snapshotId, label: label ?? ref.id, dataRoles: [], relations: [] });
    return entities.get(key) as Json;
  };
  for (const snapshotId of snapshots) addEntity(MCP, snapshotId, "mcp.rs");
  for (const view of views) {
    const definitionId = view.viewDefinitionId as string;
    const role = `role-${definitionId}`;
    if (!definitions.has(definitionId)) {
      definitions.set(definitionId, { id: definitionId, entityKind: view.entity.kind, title: view.title, priority: 50, component: view.component, requires: [], dataRole: role });
    }
    const entity = addEntity(view.entity, view.snapshotId);
    if (!entity.dataRoles.includes(role)) entity.dataRoles.push(role);
  }
  for (const [id, roles] of Object.entries(options.extraRoles ?? {})) {
    for (const entity of entities.values()) if (entity.id === id) for (const role of roles) if (!entity.dataRoles.includes(role)) entity.dataRoles.push(role);
  }
  for (const entity of options.entities ?? []) entities.set(entityKey(entity), clone(entity));
  for (const definition of options.definitions ?? []) definitions.set(definition.id, clone(definition));
  return { schemaVersion: "paneweft.bundle/1", entities: [...entities.values()], definitions: [...definitions.values()], views: views.map(clone) };
}

export function entityAt(ref: { repository: string; id: string; kind: string }, snapshotId: string, extra: Json = {}): Json {
  return { ...ref, snapshotId, label: ref.id, dataRoles: [], relations: [], ...extra };
}

// ---- large and awkward data ------------------------------------------------------------------------

const pad3 = (n: number) => String(n).padStart(3, "0");

/**
 * 200 rows with multibyte cells. Row i: id `w-<iii>`; name = "€" x (1 + i % 4), then the 3-digit index, then
 * "😀" x (1 + i % 3); every fifth row also has a 120-code-point label of alternating "€😀". All names are
 * distinct, and their code-unit order differs from id order (the euro run length comes first).
 */
export function wideRows(count = 200): Json[] {
  return Array.from({ length: count }, (_, i) => {
    const extra: Json = { entity: moduleRef(`w-${pad3(i)}`) };
    if (i % 5 === 0) extra.label = `lbl-${pad3(i)} ` + "€😀".repeat(56);
    return row(`w-${pad3(i)}`, { name: "€".repeat(1 + (i % 4)) + pad3(i) + "😀".repeat(1 + (i % 3)) }, extra);
  });
}
export function wideListView(spec: ListSpec = {}): Json {
  return listView({ id: "wide", definitionId: "def-wide", title: "Wide", rows: wideRows(), completeness: complete("all 200 generated rows"), ...spec });
}
