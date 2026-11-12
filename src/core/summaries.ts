// Bounded summaries of one view (design sections 2 and 4): the mandatory header, the matching facts as a stream of entries, and the
// text / JSON renderings of one page of it. Pure: it reads an envelope and its freshness, never a session.
//
// CLAIM(header-mandatory): question, completeness, freshness, snapshot, whole-view provenance counts, evidence coverage, filters, order
//   and counts are printed on every page, even when nothing matches; only items are ever left out [design section 4; MC4, MC5].
// CLAIM(counts-describe-the-filter): `total` counts the view's primary collection, `matched` the filtered one; provenance and evidence
//   describe the WHOLE view so a filter cannot hide what the view is made of [red-contract section 3; MC5].
// Units: list rows, tree nodes, graph edges, source lines, shape fields, notebook blocks, example runs.
import type { Envelope } from "./wire.ts";
import type { FreshnessResult } from "./freshness.ts";
import { viewItems, UNIT_OF_COMPONENT, type AnyItem } from "./items.ts";
import { graphNeighborhood } from "./layout.ts";
import { compareCodeUnits, ownValue } from "./canonical.ts";
import { jsonOfSlot, textOfSlot, type Entry, type Format, type Layout, type PageState } from "./pager.ts";

export type Scalar = string | number | boolean | null;
export interface ViewFilter { text?: string; columns?: Record<string, Scalar>; provenance?: string[]; relation?: string[]; status?: string[] }
export interface ViewOrder { key: string; direction: "asc" | "desc" }
export interface ViewFocus { itemId: string; expand?: boolean }
export interface ViewQuery { filter: ViewFilter; order?: ViewOrder; focus?: ViewFocus; embedDepth: number }

/** What an embedded view contributes to a notebook block at embedDepth 1. */
export type EmbedInfo =
  | { kind: "view"; viewId: string; component: string; headerLine: string }
  | { kind: "notebook"; viewId: string; blocks: AnyItem[] };

export class QueryError extends Error {
  readonly pointer: string;
  readonly code: "DANGLING_REFERENCE" | "CONSTRAINT";
  constructor(code: "DANGLING_REFERENCE" | "CONSTRAINT", pointer: string, message: string) {
    super(message);
    this.pointer = pointer;
    this.code = code;
  }
}

export interface Gap { id: string; question: string; reason: string }

/**
 * The runs of an example view that were recorded (session.recordExampleRun) rather than written into the envelope, as example-runs.ts merged them:
 * run item id -> {runId, contentHash of the stored run output}. `notice` names recorded runs that could not be merged. Absent for every other view.
 */
export interface RecordedRuns { byItemId: ReadonlyMap<string, { runId: string; contentHash: string }>; notice: string | null }

export interface ViewSummary {
  view: { id: string; title: string; component: string; snapshotId: string };
  question: string;
  completeness: Envelope["completeness"];
  freshness: FreshnessResult;
  provenance: Record<AnyItem["provenance"], number>;
  evidenceSources: string[];
  filters: ViewFilter;
  order: ViewOrder | null;
  unit: string;
  total: number;
  matched: number;
  notice: string | null;
  /** Text lines between the first body line and the items (e.g. `basis: observed`). */
  bodyPrelude: string[];
  /** Members merged into a JSON reply besides the standard ones. */
  jsonExtras: Record<string, unknown>;
  /** Text lines after the items (always present on every page). */
  footer: (page: PageState) => string[];
  entries: Entry[];
  gaps: Gap[];
}

// ---- small helpers -----------------------------------------------------------------------------------------------

const oneLine = (text: string): string => text.replace(/\r\n|\r|\n/g, "\\n");
const show = (value: unknown): string => (typeof value === "string" ? value : value === null ? "null" : String(value));
const entityOf = (item: AnyItem): { repository: string; id: string; kind: string } | undefined => item.entity ?? (item.result as AnyItem["entity"]);
const entityPart = (item: AnyItem): string => {
  const entity = entityOf(item);
  return entity === undefined ? "(no entity)" : `${entity.kind}:${entity.id}`;
};
/** Longest cell value (in characters) a text line prints; a longer one is cut with a marker that counts what was left out (#13). */
const CELL_CLIP_POINTS = 160;

/** CLAIM(text-column-keys): delimiters and controls in keys are quoted/escaped [operations.column-keys.test.ts]. */
const columnKey = (key: string): string => /[\s=|"\\\u0000-\u001f\u007f-\u009f]/u.test(key)
  ? JSON.stringify(key).replace(/[\u007f-\u009f\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
  : key;

/**
 * The columns after `skip` (the one already printed as the row's name) as ` | key=value ...` in declared order; strings are JSON-quoted so a
 * separator inside a value cannot be misread. A value over CELL_CLIP_POINTS is cut as `"head…"[+N chars]`. Absent cells are not printed.
 * `clipped` counts the cut cells so the page can say so (#13: text used to print the first column only).
 */
function otherColumns(cells: Record<string, Scalar>, columns: Array<{ key: string }>, skip: string | undefined): { text: string; clipped: number } {
  const parts: string[] = [];
  let clipped = 0;
  for (const { key } of columns) {
    if (key === skip || !Object.hasOwn(cells, key)) continue;
    const name = columnKey(key);
    const value = cells[key] as Scalar;
    if (typeof value !== "string") { parts.push(`${name}=${JSON.stringify(value)}`); continue; }
    const points = Array.from(value);
    if (points.length <= CELL_CLIP_POINTS) { parts.push(`${name}=${JSON.stringify(value)}`); continue; }
    clipped++;
    parts.push(`${name}=${JSON.stringify(`${points.slice(0, CELL_CLIP_POINTS - 1).join("")}…`)}[+${points.length - (CELL_CLIP_POINTS - 1)} chars]`);
  }
  return { text: parts.length === 0 ? "" : ` | ${parts.join(" ")}`, clipped };
}
/** ` | label="..."` for an item that has a label the line does not already print (an edge, a shape field); whole, never clipped: the text form is where the full label lives (#9, #12). */
const labelPart = (item: AnyItem): string => (typeof item.label === "string" ? ` | label=${JSON.stringify(item.label)}` : "");
const clippedLine = (clipped: number): string[] => (clipped === 0 ? [] : [`clipped: ${clipped} cell${clipped === 1 ? "" : "s"} over ${CELL_CLIP_POINTS} characters (marked [+N chars]; the full values are in --format json)`]);

const trailer = (item: AnyItem): string => `${item.provenance}; ${item.evidence.join(",")}${item.reason === undefined ? "" : `; ${oneLine(item.reason)}`}`;

function strings(item: AnyItem): string[] {
  const out: string[] = [];
  if (typeof item.label === "string") out.push(item.label);
  const cells = item.cells as Record<string, Scalar> | undefined;
  if (cells !== undefined) for (const value of Object.values(cells)) if (typeof value === "string") out.push(value);
  for (const key of ["relation", "from", "to", "markdown", "statement", "path", "type", "runId", "status", "error"]) {
    const value = item[key];
    if (typeof value === "string") out.push(value);
  }
  return out;
}

function matches(item: AnyItem, filter: ViewFilter): boolean {
  if (filter.text !== undefined) {
    const needle = filter.text.toLowerCase();
    if (!strings(item).some((candidate) => candidate.toLowerCase().includes(needle))) return false;
  }
  if (filter.columns !== undefined) {
    const cells = (item.cells ?? {}) as Record<string, Scalar>;
    for (const [key, wanted] of Object.entries(filter.columns)) if (!Object.hasOwn(cells, key) || cells[key] !== wanted) return false;
  }
  if (filter.provenance !== undefined && !filter.provenance.includes(item.provenance)) return false;
  if (filter.relation !== undefined && typeof item.relation === "string" && !filter.relation.includes(item.relation)) return false;
  if (filter.status !== undefined && (item.kind !== "claim" || !filter.status.includes(item.status as string))) return false;
  return true;
}

function compareScalar(a: Scalar, b: Scalar): number {
  const rank = (value: Scalar): number => (value === null ? 0 : typeof value === "boolean" ? 1 : typeof value === "number" ? 2 : 3);
  const byType = rank(a) - rank(b);
  if (byType !== 0) return byType < 0 ? -1 : 1;
  if (a === null || b === null) return 0;
  if (typeof a === "string") return compareCodeUnits(a, b as string);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function filtersLine(filter: ViewFilter): string {
  const parts: string[] = [];
  if (filter.text !== undefined) parts.push(`text=${JSON.stringify(filter.text)}`);
  for (const key of Object.keys(filter.columns ?? {}).sort(compareCodeUnits)) parts.push(`columns.${key}=${JSON.stringify((filter.columns as Record<string, Scalar>)[key])}`);
  if (filter.provenance !== undefined) parts.push(`provenance=${filter.provenance.join(",")}`);
  if (filter.relation !== undefined) parts.push(`relation=${filter.relation.join(",")}`);
  if (filter.status !== undefined) parts.push(`status=${filter.status.join(",")}`);
  return parts.length === 0 ? "none" : parts.join(" ");
}

export function freshnessLine(freshness: FreshnessResult): string {
  switch (freshness.status) {
    case "fresh": return "fresh";
    case "stale": return `stale (changed: ${freshness.changedPaths.map((entry) => (entry.change === undefined ? entry.path : `${entry.path}: ${entry.change}`)).join(", ")})`;
    case "unknown": {
      const tooLarge = (freshness.unverified ?? []).filter((entry) => entry.code === "FILE_TOO_LARGE");
      const files = tooLarge.flatMap((entry) => (entry.paths ?? []).map((path) => `${entry.repository}:${path}`));
      const parts = [
        ...(freshness.inaccessibleRoots.length > 0 || tooLarge.length === 0 ? [`inaccessible: ${freshness.inaccessibleRoots.join(", ")}`] : []),
        ...(tooLarge.length > 0 ? [`too large to hash: ${files.join(", ")}`] : []),
      ];
      return `unknown (${parts.join("; ")})`;
    }
    case "unverified": return `unverified (${freshness.unverified.map((entry) => `${entry.repository}: ${entry.reason}`).join("; ")})`;
  }
}

export function freshnessJson(freshness: FreshnessResult): Record<string, unknown> {
  switch (freshness.status) {
    case "fresh": return { status: "fresh" };
    case "stale": return {
      status: "stale",
      changedPaths: freshness.changedPaths.map((entry) => entry.path),
      inaccessibleRoots: freshness.inaccessibleRoots,
      ...(freshness.unverified === undefined ? {} : { unverified: freshness.unverified }),
    };
    case "unknown": return { status: "unknown", inaccessibleRoots: freshness.inaccessibleRoots, ...(freshness.unverified === undefined ? {} : { unverified: freshness.unverified }) };
    case "unverified": return { status: "unverified", unverified: freshness.unverified };
  }
}

export function completenessLine(completeness: Envelope["completeness"]): string {
  switch (completeness.status) {
    case "complete": return `complete (${completeness.criterion})`;
    case "partial": {
      const first = completeness.gaps[0] as Gap;
      return `partial (${completeness.gaps.length} gaps; first: ${first.id}: ${first.question})`;
    }
    case "unsupported": return `unsupported (${completeness.reason}; missing: ${completeness.missingCapabilities.join(", ")})`;
  }
}

function noticeFor(completeness: Envelope["completeness"], total: number, matched: number): string | null {
  if (completeness.status === "unsupported") return `this view is unsupported: ${completeness.reason}`;
  if (matched === 0 && total > 0) return `no items match the current filters (0 of ${total})`;
  if (total === 0) return completeness.status === "complete" ? "0 items within this scope" : "no items returned; completeness is partial (see gaps)";
  return null;
}

// ---- per-component entries -----------------------------------------------------------------------------------------

interface Built { total: number; matched: number; entries: Entry[]; bodyPrelude: string[]; jsonExtras: Record<string, unknown>; footer: (page: PageState) => string[]; order: ViewOrder | null }

const entry = (id: string, json: unknown, text: string, extra: Partial<Entry> = {}): Entry => ({ id, kind: "item", countable: true, json, text, ...extra });
const none = (): string[] => [];

function listEntries(data: any, query: ViewQuery): Built {
  const columns: Array<{ key: string }> = data.columns;
  const order: ViewOrder = query.order ?? data.order;
  if (query.order !== undefined && !columns.some((column) => column.key === query.order?.key)) {
    throw new QueryError("DANGLING_REFERENCE", "/order/key", `order.key "${query.order.key}" is not a column of this view`);
  }
  const sign = order.direction === "asc" ? 1 : -1;
  const rows = (data.rows as AnyItem[]).filter((row) => matches(row, query.filter)).sort((a, b) => {
    const cells = (row: AnyItem) => (row.cells ?? {}) as Record<string, Scalar>;
    const byKey = compareScalar(ownValue(cells(a), order.key) ?? null, ownValue(cells(b), order.key) ?? null) * sign;
    return byKey !== 0 ? byKey : compareCodeUnits(a.id, b.id);
  });
  const firstKey = columns[0]?.key;
  let clipped = 0;
  const lines = rows.map((row) => {
    const cells = (row.cells ?? {}) as Record<string, Scalar>;
    const named = firstKey !== undefined && Object.hasOwn(cells, firstKey);
    const head = named ? show(cells[firstKey as string]) : (row.label ?? row.id);
    const others = otherColumns(cells, columns, named ? firstKey : undefined);
    clipped += others.clipped;
    return entry(row.id, row, `${oneLine(head)} -> ${entityPart(row)}; ${trailer(row)}${others.text}`);
  });
  return { total: data.rows.length, matched: rows.length, entries: lines, bodyPrelude: clippedLine(clipped), jsonExtras: {}, footer: none, order };
}

function treeEntries(data: any, query: ViewQuery): Built {
  const nodes = data.nodes as AnyItem[];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const preorder: Array<{ node: AnyItem; depth: number }> = [];
  const walk = (rootId: string): void => {
    const stack: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
    while (stack.length > 0) {
      const { id, depth } = stack.pop() as { id: string; depth: number };
      const node = byId.get(id);
      if (node === undefined || visited.has(id)) continue;
      visited.add(id);
      preorder.push({ node, depth });
      const children = (node.children as string[]) ?? [];
      for (let index = children.length - 1; index >= 0; index--) stack.push({ id: children[index] as string, depth: depth + 1 });
    }
  };
  for (const root of data.roots as string[]) walk(root);
  for (const node of nodes) walk(node.id);
  let scope = preorder;
  if (query.focus !== undefined) {
    const focus = query.focus.itemId;
    if (!byId.has(focus)) throw new QueryError("DANGLING_REFERENCE", "/focus/itemId", `focus item "${focus}" is not in this view`);
    const inside = new Set<string>();
    const gather = (id: string): void => { if (inside.has(id)) return; inside.add(id); for (const child of (byId.get(id)?.children as string[] | undefined) ?? []) gather(child); };
    gather(focus);
    scope = preorder.filter(({ node }) => inside.has(node.id));
  }
  const matchSet = new Set(scope.filter(({ node }) => matches(node, query.filter)).map(({ node }) => node.id));
  const keep = new Set<string>(matchSet);
  const parentOf = new Map<string, string>();
  for (const { node } of preorder) for (const child of (node.children as string[]) ?? []) if (!parentOf.has(child)) parentOf.set(child, node.id);
  for (const id of matchSet) for (let parent = parentOf.get(id); parent !== undefined && !keep.has(parent); parent = parentOf.get(parent)) keep.add(parent);
  const entries: Entry[] = [];
  const columns = data.columns as Array<{ key: string }>;
  const firstKey = columns[0]?.key;
  let clipped = 0;
  for (const { node, depth } of preorder) {
    if (!keep.has(node.id)) continue;
    const context = !matchSet.has(node.id);
    const cells = (node.cells ?? {}) as Record<string, Scalar>;
    const named = firstKey !== undefined && Object.hasOwn(cells, firstKey);
    const name = named ? show(cells[firstKey as string]) : (node.label ?? node.id);
    const others = otherColumns(cells, columns, named ? firstKey : undefined);
    clipped += others.clipped;
    const children = (node.children as string[]) ?? [];
    const state = node.childrenState === "not_loaded" ? "not_loaded; children=?" : `${children.length > 0 ? "expanded" : "leaf"}; children=${children.length}`;
    const text = `${"  ".repeat(depth)}${oneLine(name)} [${state}; ${trailer(node)}]${others.text}${context ? " [context]" : ""}`;
    entries.push(entry(node.id, context ? { ...node, context: true } : node, text, { countable: !context }));
  }
  return { total: nodes.length, matched: matchSet.size, entries, bodyPrelude: clippedLine(clipped), jsonExtras: {}, footer: none, order: null };
}

function graphEntries(data: any, query: ViewQuery): Built {
  const edges = data.edges as AnyItem[];
  let scope = edges;
  const focus = query.focus === undefined ? data.focus : undefined;
  if (query.focus !== undefined) {
    const id = query.focus.itemId;
    const asEdge = edges.find((edge) => edge.id === id);
    if (asEdge !== undefined) scope = [asEdge];
    else if ((data.nodes as AnyItem[]).some((node) => node.id === id)) {
      const hood = graphNeighborhood({ nodes: data.nodes, edges: edges as unknown as Array<{ id: string; from: string; to: string }> }, { node: id, direction: "both", depth: query.focus.expand === true ? 2 : 1 });
      const ids = new Set(hood.edgeIds);
      scope = edges.filter((edge) => ids.has(edge.id));
    } else throw new QueryError("DANGLING_REFERENCE", "/focus/itemId", `focus item "${id}" is not in this view`);
  } else if (focus !== undefined) {
    const hood = graphNeighborhood({ nodes: data.nodes, edges: edges as unknown as Array<{ id: string; from: string; to: string }> }, focus);
    const ids = new Set(hood.edgeIds);
    scope = edges.filter((edge) => ids.has(edge.id));
  }
  const kept = scope.filter((edge) => matches(edge, query.filter)).sort((a, b) => compareCodeUnits(a.id, b.id));
  const lines = kept.map((edge) => entry(edge.id, edge, `${edge.from} -${edge.relation}-> ${edge.to}; ${trailer(edge)}${labelPart(edge)}`));
  return { total: edges.length, matched: kept.length, entries: lines, bodyPrelude: [], jsonExtras: {}, footer: none, order: null };
}

function sourceEntries(data: any, query: ViewQuery): Built {
  const excerpt = data.excerpt as AnyItem & { text: string; anchor: { lines: [number, number] } };
  const first = excerpt.anchor.lines[0];
  const all = excerpt.text.split("\n");
  if (all[all.length - 1] === "") all.pop();
  const provenanceOk = query.filter.provenance === undefined || query.filter.provenance.includes(excerpt.provenance);
  const needle = query.filter.text?.toLowerCase();
  let lines = all.map((text, index) => ({ n: first + index, text })).filter(({ text }) => provenanceOk && (needle === undefined || text.toLowerCase().includes(needle)));
  if (query.focus !== undefined) {
    const target = (data.annotations as AnyItem[]).find((annotation) => annotation.id === query.focus?.itemId);
    if (target === undefined && excerpt.id !== query.focus.itemId) throw new QueryError("DANGLING_REFERENCE", "/focus/itemId", `focus item "${query.focus.itemId}" is not in this view`);
    if (target !== undefined) {
      const [a, b] = target.lines as unknown as [number, number];
      lines = lines.filter(({ n }) => n >= a && n <= b);
    }
  }
  const entries: Entry[] = lines.map(({ n, text }) => entry(`L${n}`, { id: `L${n}`, line: n, text }, `${n}: ${oneLine(text)}`));
  for (const annotation of data.annotations as Array<AnyItem & { lines: [number, number]; message: string; claimIds: string[] }>) {
    const claims = annotation.claimIds.length > 0 ? ` (claims: ${annotation.claimIds.join(", ")})` : "";
    entries.push(entry(annotation.id, { id: annotation.id, kind: "annotation", lines: annotation.lines, message: annotation.message, claimIds: annotation.claimIds, provenance: annotation.provenance, evidence: annotation.evidence },
      `annotation ${annotation.id} lines ${annotation.lines[0]}-${annotation.lines[1]}: ${oneLine(annotation.message)}${claims}`, { countable: false }));
  }
  const lastLine = first + all.length - 1;
  const footer = (page: PageState): string[] => {
    if (page.omitted === 0) return [];
    const next = entries.slice(page.nextIndex).find((candidate) => candidate.countable);
    return next === undefined ? [] : [`omitted lines ${(next.json as { line: number }).line}-${lastLine}`];
  };
  return { total: all.length, matched: lines.length, entries, bodyPrelude: [], jsonExtras: {}, footer, order: null };
}

function shapeEntries(data: any, query: ViewQuery): Built {
  const fields = (data.fields as AnyItem[]).filter((field) => matches(field, query.filter));
  const lines = fields.map((field) => {
    const example = "example" in field ? (field.example === null ? "example: null" : `example: ${JSON.stringify(field.example)}`) : "no example";
    const ref = field.ref === undefined ? "" : `; ref=${field.ref}`;
    return entry(field.id, field, `${oneLine(String(field.path))}: ${field.type} (${field.presence}); ${trailer(field)}${ref}; ${example}${labelPart(field)}`);
  });
  return { total: data.fields.length, matched: fields.length, entries: lines, bodyPrelude: [`basis: ${data.basis}`], jsonExtras: { basis: data.basis }, footer: none, order: null };
}

function notebookEntries(data: any, query: ViewQuery, embeds: ReadonlyMap<string, EmbedInfo>): Built {
  const blocks = (data.blocks as AnyItem[]).filter((block) => matches(block, query.filter));
  const lines = blocks.map((block) => {
    let head: string;
    switch (block.kind) {
      case "prose": head = `${block.id} prose: ${oneLine(String(block.markdown))}`; break;
      case "view": head = `${block.id} view: ${block.viewId}`; break;
      case "claim": head = `${block.id} claim [${block.status}]: ${oneLine(String(block.statement))}`; break;
      default: head = `${block.id} example: ${block.exampleId}`;
    }
    let text = `${head} (${block.provenance}; ${block.evidence.join(",")})`;
    let json: unknown = block;
    const embed = embeds.get(block.id);
    if (embed !== undefined) {
      if (embed.kind === "view") {
        text += `\n  ${embed.headerLine}`;
        json = { ...block, embedded: { viewId: embed.viewId, component: embed.component, header: embed.headerLine } };
      } else {
        text += embed.blocks.map((inner) => `\n  ${inner.id} ${inner.kind}: ${oneLine(String(inner.markdown ?? inner.statement ?? inner.viewId ?? inner.exampleId ?? ""))}`).join("");
        json = { ...block, embedded: { viewId: embed.viewId, blocks: embed.blocks } };
      }
    }
    return entry(block.id, json, text);
  });
  return { total: data.blocks.length, matched: blocks.length, entries: lines, bodyPrelude: [], jsonExtras: {}, footer: none, order: null };
}

function exampleEntries(data: any, query: ViewQuery, recorded: RecordedRuns | undefined): Built {
  const runs = (data.runs as AnyItem[]).filter((run) => matches(run, query.filter));
  const lines = runs.map((run) => {
    const assertions = (run.assertions ?? []) as Array<AnyItem & { statement: string; passed: boolean }>;
    const passed = assertions.filter((assertion) => assertion.passed).length;
    const failed = assertions.filter((assertion) => !assertion.passed).map((assertion) => oneLine(assertion.statement));
    const result = run.result === undefined ? "" : `; result=${entityPart({ ...run, entity: undefined } as AnyItem)}`;
    const detail = `${failed.length > 0 ? `; failed: ${failed.join(" | ")}` : ""}${run.error === undefined ? "" : `; error: ${oneLine(String(run.error))}`}`;
    const origin = recorded?.byItemId.get(run.id);
    // an envelope run is printed and serialised exactly as before; a recorded run says so (origin, contentHash of its stored output)
    return entry(run.id, origin === undefined ? run : { ...run, origin: "recorded", contentHash: origin.contentHash }, `${run.runId}: ${run.status}; assertions=${passed}/${assertions.length}${result}${detail}; ${trailer(run)}${origin === undefined ? "" : "; recorded"}`);
  });
  const runnerId = (data.scenario as { runnerId: string }).runnerId;
  const rerun = `paneweft example run ${runnerId}`;
  const footer = (): string[] => [...(data.runs.length === 0 ? ["not run"] : []), `rerun: ${rerun}`];
  return { total: data.runs.length, matched: runs.length, entries: lines, bodyPrelude: [], jsonExtras: { rerun, ...(data.runs.length === 0 ? { notRun: true } : {}) }, footer, order: null };
}

const BUILDERS: Record<Envelope["component"], (data: any, query: ViewQuery, embeds: ReadonlyMap<string, EmbedInfo>, recorded: RecordedRuns | undefined) => Built> = {
  list: (data, query) => listEntries(data, query),
  tree: (data, query) => treeEntries(data, query),
  graph: (data, query) => graphEntries(data, query),
  source: (data, query) => sourceEntries(data, query),
  shape: (data, query) => shapeEntries(data, query),
  notebook: (data, query, embeds) => notebookEntries(data, query, embeds),
  example: (data, query, _embeds, recorded) => exampleEntries(data, query, recorded),
};

// ---- the summary ---------------------------------------------------------------------------------------------------

export function summariseView(envelope: Envelope, freshness: FreshnessResult, query: ViewQuery, embeds: ReadonlyMap<string, EmbedInfo> = new Map(), recorded?: RecordedRuns): ViewSummary {
  const unit = UNIT_OF_COMPONENT[envelope.component];
  const items = viewItems(envelope);
  const provenance = { read: 0, parsed: 0, compiled: 0, observed: 0, inferred: 0 };
  const sources = new Set<string>();
  for (const item of items) {
    provenance[item.provenance]++;
    for (const id of item.evidence) sources.add(id);
  }
  if (query.order !== undefined && envelope.component !== "list") throw new QueryError("CONSTRAINT", "/order", "order applies to list views only");
  const built: Built = envelope.data === undefined
    ? { total: 0, matched: 0, entries: [], bodyPrelude: [], jsonExtras: {}, footer: none, order: null }
    : BUILDERS[envelope.component](envelope.data, query, embeds, recorded);
  const gaps = envelope.completeness.status === "partial" ? (envelope.completeness.gaps as Gap[]) : [];
  const entries: Entry[] = [...built.entries];
  for (const gap of gaps.slice(1)) entries.push({ id: gap.id, kind: "gap", countable: false, json: gap, text: `gap: ${gap.id}: ${oneLine(gap.question)}` });
  return {
    view: { id: envelope.id, title: envelope.title, component: envelope.component, snapshotId: envelope.snapshotId },
    question: envelope.question,
    completeness: envelope.completeness,
    freshness,
    provenance,
    evidenceSources: [...sources].sort(compareCodeUnits),
    filters: query.filter,
    order: built.order,
    unit,
    total: built.total,
    matched: built.matched,
    notice: [noticeFor(envelope.completeness, built.total, built.matched), recorded?.notice ?? null].filter((part): part is string => part !== null).join("; ") || null,
    bodyPrelude: built.bodyPrelude,
    jsonExtras: built.jsonExtras,
    footer: built.footer,
    entries,
    gaps,
  };
}

// ---- rendering one page ---------------------------------------------------------------------------------------------

export interface ReplyExtras {
  /** Text lines before the header (render's `stored:` / `viewer:` lines). */
  preamble?: string[];
  /** Members merged into the JSON reply. */
  json?: Record<string, unknown>;
  /** Text lines after the items on every page (open_entity's `available:` lines). */
  footer?: string[];
}

function completenessJson(summary: ViewSummary, pageGaps: Gap[]): Record<string, unknown> {
  const completeness = summary.completeness;
  if (completeness.status === "complete") return { status: "complete", criterion: completeness.criterion };
  if (completeness.status === "unsupported") return { status: "unsupported", reason: completeness.reason, missingCapabilities: completeness.missingCapabilities };
  return { status: "partial", gapCount: summary.gaps.length, gaps: pageGaps };
}

/** Renders one page of a summary. `cursorAt` supplies the cursor tokens the pager asks for. */
export function layoutOf(summary: ViewSummary, cursorAt: Layout["cursorAt"], extras: ReplyExtras = {}): Layout {
  const render = (page: PageState, format: Format): string => {
    const returned = page.returned;
    // truncated: item bytes remain (items not yet started, or an item cut mid-way); gaps alone do not make a reply "truncated"
    const counts = { unit: summary.unit, total: summary.total, matched: summary.matched, returned, omitted: page.omitted, truncated: page.omitted > 0 || page.pending };
    const pageGaps: Gap[] = [...(page.first && summary.gaps.length > 0 ? [summary.gaps[0] as Gap] : []), ...page.slots.flatMap((slot) => (slot.type === "whole" && slot.entry.kind === "gap" ? [slot.entry.json as Gap] : []))];
    if (format === "json") {
      const reply: Record<string, unknown> = {
        schemaVersion: "paneweft.reply/1",
        view: summary.view,
        question: summary.question,
        completeness: completenessJson(summary, pageGaps),
        freshness: freshnessJson(summary.freshness),
        provenance: summary.provenance,
        evidence: { sources: summary.evidenceSources },
        filters: summary.filters,
        order: summary.order,
        counts,
        ...(summary.notice === null ? {} : { notice: summary.notice }),
        ...summary.jsonExtras,
        ...(extras.json ?? {}),
        items: page.slots.filter((slot) => !(slot.type === "whole" && slot.entry.kind === "gap")).map(jsonOfSlot),
        cursor: page.cursor,
      };
      return JSON.stringify(reply);
    }
    const lines: string[] = [...(extras.preamble ?? [])];
    lines.push(
      `paneweft.reply/1 view=${summary.view.id} component=${summary.view.component}`,
      `question: ${oneLine(summary.question)}`,
      `snapshot: ${summary.view.snapshotId}`,
      `completeness: ${oneLine(completenessLine(summary.completeness))}`,
      `freshness: ${freshnessLine(summary.freshness)}`,
      `provenance: ${(["read", "parsed", "compiled", "observed", "inferred"] as const).map((key) => `${key}=${summary.provenance[key]}`).join(" ")}`,
      `evidence: sources=${summary.evidenceSources.join(",")}`,
      `filters: ${filtersLine(summary.filters)}`,
      `order: ${summary.order === null ? "none" : `${summary.order.key} ${summary.order.direction}`}`,
      `counts: unit=${counts.unit} total=${counts.total} matched=${counts.matched} returned=${counts.returned} omitted=${counts.omitted} truncated=${counts.truncated}`,
      `${returned}/${summary.matched} matched ${summary.unit} returned; ${page.omitted} omitted`,
    );
    if (summary.notice !== null) lines.push(summary.notice);
    lines.push(...summary.bodyPrelude);
    for (const slot of page.slots) lines.push(textOfSlot(slot));
    lines.push(...summary.footer(page), ...(extras.footer ?? []));
    if (page.cursor !== null) lines.push(`cursor: ${page.cursor}`);
    return lines.join("\n") + "\n";
  };
  return { entries: summary.entries, render, cursorAt };
}
