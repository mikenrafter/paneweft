// The seven components as plain DOM (docs/viewer-dom-contract.md, docs/contract-additions/dom.md).
// Rendering is a pure function of (envelope, summary, per-pane UI state): no handlers are attached here. mount.ts listens once at
// the root and reads the data-* attributes below, so every control stays reachable by the same attributes the tests use.
// Everything shown arrives through textContent or attributes; the only markup sink is the sanitised Markdown renderer.
import type { Envelope } from "../core/wire.ts";
import type { Result } from "../core/errors.ts";
import type { AnyItem } from "../core/items.ts";
import type { SourceOpening } from "../core/links.ts";
import { computeGraphLayout, graphNeighborhood } from "../core/layout.ts";
import { renderMarkdown } from "../core/markdown.ts";
import { completenessLine, type ViewSummary } from "../core/summaries.ts";
import { compareCodeUnits, ownValue } from "../core/canonical.ts";
import { append, h, svg, type Child } from "./dom.ts";
import type { ViewModel } from "./source.ts";

export interface SourceView { itemId: string; result: Result<SourceOpening>; /** The whole stored excerpt, when it was fetched; else the opening's own lines are shown. */ lines?: Array<{ n: number; text: string }> }
export interface PaneUi {
  filterText: string;
  /** all | supported | disputed | open */
  claimStatus: string;
  hiddenRelations: Set<string>;
  /** Explicit expand/collapse of tree nodes, shape fields and notebook blocks; absent = the default. */
  expanded: Map<string, boolean>;
  roving: string | null;
  /** Id of the item whose actions menu is open. */
  menu: string | null;
  opened: SourceView | null;
  /** Id of the declared source whose detail is shown (an evidence control with data-source was activated); null = none. */
  sourceDetail: string | null;
  highlight: [number, number] | null;
  notes: Map<string, string>;
  error: { code: string; message: string } | null;
}
export const newPaneUi = (): PaneUi => ({
  filterText: "", claimStatus: "all", hiddenRelations: new Set(), expanded: new Map(), roving: null, menu: null, opened: null, sourceDetail: null, highlight: null, notes: new Map(), error: null,
});

export interface ComponentContext {
  doc: Document;
  locale: string;
  layoutVersion: string;
  paneIndex: number;
  envelope: Envelope;
  summary: ViewSummary;
  ui: PaneUi;
  selection: string[];
  /** Notebook: the models of embedded views by view id (null: could not be loaded). */
  embeds: ReadonlyMap<string, ViewModel | null>;
  /** Shows the notebook editing controls (block moves, revision). */
  editable: boolean;
  notebookRevision?: number;
  /** False inside an embedded view: no controls, no further embedding. */
  interactive: boolean;
  /** The unfiltered summary of an embedded view's model. */
  summarise: (model: ViewModel) => ViewSummary;
}

type Item = AnyItem;
const entityOf = (item: Item): { repository: string; id: string; kind: string } | undefined => item.entity ?? (item.result as Item["entity"]);
const hasTarget = (item: Item): boolean => entityOf(item) !== undefined || item.anchor !== undefined;

// ---- shared parts -------------------------------------------------------------------------------------------------------------

type Position = { x: number; y: number };
const whereAt = (at: Position | undefined, dx: number, dy: number) => (at === undefined ? {} : { x: at.x + dx, y: at.y + dy });

/** The provenance word and, for an inferred fact, its reason. */
function provenanceParts(ctx: ComponentContext, item: Item, inSvg: boolean, at?: Position): Child[] {
  const make = inSvg
    ? (attrs: Record<string, string | number | undefined>, text: string) => svg(ctx.doc, "text", { "font-size": 10, ...attrs }, text)
    : (attrs: Record<string, string | number | undefined>, text: string) => h(ctx.doc, "span", attrs, text);
  const out: Child[] = [make({ "data-pw": "provenance-badge", "data-provenance": item.provenance, ...whereAt(at, 8, 34) }, item.provenance)];
  if (item.provenance === "inferred" && typeof item.reason === "string") out.push(make({ "data-pw": "inferred-reason", ...whereAt(at, 8, 46) }, item.reason));
  return out;
}

/**
 * One control per evidence source id. In HTML a native button. In an SVG a `<text>` made a button (review round 2, S9): role, tabindex 0 and a
 * name that says which source it shows and for which item, because several items cite the same source. An SVG control must not sit inside a
 * role="button" graph node (nested interactive controls), so graph nodes place theirs beside the node, at absolute coordinates.
 */
function evidenceLinks(ctx: ComponentContext, item: Item, inSvg: boolean, at?: Position): Child[] {
  const owner = typeof item.label === "string" ? item.label : item.id;
  return item.evidence.map((source, index) => {
    const open = ctx.ui.sourceDetail === source ? { "aria-expanded": "true" } : {}; // present only while the detail is shown: the goldens pin aria-expanded on every other control
    return inSvg
      ? svg(ctx.doc, "text", { "data-pw": "evidence-link", "data-source": source, role: "button", tabindex: 0, "aria-label": `Evidence ${source} of ${owner}`, "font-size": 10, ...open, ...whereAt(at, 60 + index * 30, 34) }, source)
      : h(ctx.doc, "button", { type: "button", "data-pw": "evidence-link", "data-source": source, ...open }, source);
  });
}

function badge(ctx: ComponentContext, item: Item, inSvg: boolean, at?: Position): Child[] {
  return [...provenanceParts(ctx, item, inSvg, at), ...evidenceLinks(ctx, item, inSvg, at)];
}

/** The actions button (and, while open, its menu as the next sibling) of an item that has an entity or an anchor. */
function actions(ctx: ComponentContext, item: Item): Child[] {
  if (!ctx.interactive || !hasTarget(item)) return [];
  const open = ctx.ui.menu === item.id;
  const button = h(ctx.doc, "button", {
    type: "button", "data-pw": "actions-button", "data-item": item.id, "aria-haspopup": "menu", "aria-expanded": open ? "true" : "false", "aria-label": `Actions for ${item.id}`,
  }, "...");
  if (!open) return [button];
  const kinds: Array<"open-entity" | "open-source"> = [];
  if (entityOf(item) !== undefined) kinds.push("open-entity");
  if (item.anchor !== undefined) kinds.push("open-source");
  const label = { "open-entity": "Open entity", "open-source": "Open source" } as const;
  const menu = h(ctx.doc, "div", { "data-pw": "actions-menu", role: "menu", "data-item": item.id, "aria-label": `Actions for ${item.id}` },
    ...kinds.map((kind) => h(ctx.doc, "button", { type: "button", "data-pw": "menu-item", role: "menuitem", tabindex: -1, "data-kind": kind, "data-item": item.id }, label[kind])));
  return [button, menu];
}

const noTarget = (ctx: ComponentContext, item?: Item): HTMLElement => (item?.notCaptured === undefined
  ? h(ctx.doc, "span", { "data-pw": "no-target" }, "no entity or source")
  : h(ctx.doc, "span", { "data-pw": "no-target", "data-reason": item.notCaptured.reason }, `not captured: ${item.notCaptured.reason}`));

/** badge, reason, links, then (rows, nodes, fields) the no-target note or the actions. */
function factChildren(ctx: ComponentContext, item: Item, kind: "plain" | "actionable"): Child[] {
  const out = badge(ctx, item, false);
  if (kind === "actionable") out.push(...(hasTarget(item) ? actions(ctx, item) : [noTarget(ctx, item)]));
  return out;
}

function formatCell(ctx: ComponentContext, value: unknown, format: string): string {
  if (value === null || value === undefined) return "";
  if (format === "number" && typeof value === "number") {
    try { return new Intl.NumberFormat(ctx.locale).format(value); } catch { return String(value); }
  }
  return String(value);
}

function roving(ctx: ComponentContext, visible: string[]): string | undefined {
  if (ctx.ui.roving !== null && visible.includes(ctx.ui.roving)) return ctx.ui.roving;
  return ctx.selection.find((id) => visible.includes(id)) ?? visible[0];
}

// ---- list ---------------------------------------------------------------------------------------------------------------------

function renderList(ctx: ComponentContext): HTMLElement {
  const data = ctx.envelope.data as { columns: Array<{ key: string; title: string; format: string }>; rows: Item[] };
  const byId = new Map(data.rows.map((row) => [row.id, row]));
  const rows = ctx.summary.entries.map((entry) => byId.get(entry.id)).filter((row): row is Item => row !== undefined);
  const order = ctx.summary.order;
  const rove = roving(ctx, rows.map((row) => row.id));
  const header = h(ctx.doc, "div", { role: "row" }, ...data.columns.map((column) => h(ctx.doc, "div", {
    "data-pw": "column-header", role: "columnheader", "data-id": column.key,
    "aria-sort": order !== null && order.key === column.key ? (order.direction === "asc" ? "ascending" : "descending") : undefined,
  }, column.title)));
  const rowElement = (row: Item): HTMLElement => {
    const cells = (row.cells ?? {}) as Record<string, unknown>;
    return h(ctx.doc, "div", {
      "data-pw": "row", role: "row", "data-id": row.id, "data-provenance": row.provenance, "aria-selected": ctx.selection.includes(row.id) ? "true" : "false", tabindex: row.id === rove ? 0 : -1,
    },
    ...data.columns.map((column) => h(ctx.doc, "div", { "data-pw": "cell", role: "gridcell", "data-id": column.key }, formatCell(ctx, ownValue(cells, column.key), column.format))),
    h(ctx.doc, "div", { role: "gridcell" }, ...factChildren(ctx, row, "actionable")));
  };
  const ungrouped = rows.filter((row) => typeof row.group !== "string");
  const labels = [...new Set(rows.flatMap((row) => (typeof row.group === "string" ? [row.group] : [])))].sort(compareCodeUnits);
  const body: Child[] = ungrouped.map(rowElement);
  for (const label of labels) {
    body.push(h(ctx.doc, "div", { "data-pw": "group", role: "row" }, h(ctx.doc, "div", { role: "gridcell" }, label)));
    for (const row of rows) if (row.group === label) body.push(rowElement(row));
  }
  return h(ctx.doc, "div", { "data-pw": "list", role: "grid", "aria-label": ctx.envelope.title }, header, ...body);
}

// ---- tree and shape (flat pre-order lists with expansion) -----------------------------------------------------------------------

interface Flat { item: Item; depth: number; ancestors: string[]; children: string[] }

function flatten(items: Item[], roots: string[], childrenOf: (item: Item) => string[]): Flat[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const out: Flat[] = [];
  const walk = (rootId: string): void => {
    const stack: Array<{ id: string; depth: number; ancestors: string[] }> = [{ id: rootId, depth: 0, ancestors: [] }];
    while (stack.length > 0) {
      const { id, depth, ancestors } = stack.pop() as { id: string; depth: number; ancestors: string[] };
      const item = byId.get(id);
      if (item === undefined || seen.has(id)) continue;
      seen.add(id);
      const children = childrenOf(item);
      out.push({ item, depth, ancestors, children });
      for (let index = children.length - 1; index >= 0; index--) stack.push({ id: children[index] as string, depth: depth + 1, ancestors: [...ancestors, id] });
    }
  };
  for (const root of roots) walk(root);
  for (const item of items) walk(item.id);
  return out;
}

function expandedState(ctx: ComponentContext, flat: Flat, expandable: boolean): boolean {
  if (!expandable) return false;
  if (ctx.ui.filterText !== "") return true;
  return ctx.ui.expanded.get(flat.item.id) ?? flat.depth === 0;
}

function visibleFlat(ctx: ComponentContext, all: Flat[], keep: Set<string>, expandableOf: (flat: Flat) => boolean): Flat[] {
  const state = new Map(all.map((flat) => [flat.item.id, expandedState(ctx, flat, expandableOf(flat))]));
  return all.filter((flat) => keep.has(flat.item.id) && flat.ancestors.every((ancestor) => state.get(ancestor) === true));
}

function renderTree(ctx: ComponentContext): HTMLElement {
  const data = ctx.envelope.data as { columns: Array<{ key: string; format: string }>; roots: string[]; nodes: Item[] };
  const all = flatten(data.nodes, data.roots, (node) => (node.children as string[]) ?? []);
  const keep = new Set(ctx.summary.entries.map((entry) => entry.id));
  const expandable = (flat: Flat) => flat.children.length > 0 || flat.item.childrenState === "not_loaded";
  const visible = visibleFlat(ctx, all, keep, expandable);
  const rove = roving(ctx, visible.map((flat) => flat.item.id));
  const nodes = visible.map((flat) => {
    const node = flat.item;
    const can = expandable(flat);
    const cells = (node.cells ?? {}) as Record<string, unknown>;
    return h(ctx.doc, "div", {
      "data-pw": "node", role: "treeitem", "data-id": node.id, "data-provenance": node.provenance, "aria-level": flat.depth + 1, "aria-selected": ctx.selection.includes(node.id) ? "true" : "false",
      "aria-expanded": can ? String(expandedState(ctx, flat, true)) : undefined, "data-children-state": String(node.childrenState), tabindex: node.id === rove ? 0 : -1,
    },
    can && h(ctx.doc, "button", { type: "button", "data-pw": "toggle", "data-item": node.id, "aria-label": `Toggle ${node.id}` }),
    ...data.columns.map((column) => h(ctx.doc, "span", { "data-pw": "cell", "data-id": column.key }, formatCell(ctx, ownValue(cells, column.key), column.format))),
    ...badge(ctx, node, false),
    node.childrenState === "not_loaded" && h(ctx.doc, "span", { "data-pw": "load-affordance" }, "needs evidence: children not loaded"),
    ...(hasTarget(node) ? actions(ctx, node) : [noTarget(ctx)]));
  });
  return h(ctx.doc, "div", { "data-pw": "tree", role: "tree", "aria-label": ctx.envelope.title }, ...nodes);
}

function renderShape(ctx: ComponentContext): HTMLElement {
  const data = ctx.envelope.data as { basis: string; root: string; fields: Item[] };
  const all = flatten(data.fields, [data.root], (field) => (field.children as string[]) ?? []);
  const keep = new Set(ctx.summary.entries.map((entry) => entry.id));
  const filtered = ctx.ui.filterText !== "";
  const expandable = (flat: Flat) => flat.children.length > 0;
  const visible = filtered ? all.filter((flat) => keep.has(flat.item.id)) : visibleFlat(ctx, all, keep, expandable);
  const pathOf = new Map(data.fields.map((field) => [field.id, String(field.path)]));
  const rove = roving(ctx, visible.map((flat) => flat.item.id));
  const fields = visible.map((flat) => {
    const field = flat.item;
    const can = expandable(flat);
    return h(ctx.doc, "div", {
      "data-pw": "field", role: "treeitem", "data-id": field.id, "data-path": String(field.path), "data-presence": String(field.presence), "data-provenance": field.provenance,
      "aria-level": flat.depth + 1, "aria-selected": ctx.selection.includes(field.id) ? "true" : "false", "aria-expanded": can ? String(expandedState(ctx, flat, true)) : undefined,
      tabindex: field.id === rove ? 0 : -1,
    },
    can && h(ctx.doc, "button", { type: "button", "data-pw": "toggle", "data-item": field.id, "aria-label": `Toggle ${field.id}` }),
    h(ctx.doc, "span", { "data-pw": "field-path" }, String(field.path)),
    typeof field.label === "string" && h(ctx.doc, "span", { "data-pw": "field-label" }, field.label),
    h(ctx.doc, "span", { "data-pw": "field-type" }, String(field.type)),
    h(ctx.doc, "span", { "data-pw": "field-example" }, "example" in field ? JSON.stringify(field.example) : "no example"),
    typeof field.ref === "string" && h(ctx.doc, "span", { "data-pw": "field-ref" }, `ref: ${pathOf.get(field.ref) ?? field.ref}`),
    ...badge(ctx, field, false),
    ...(hasTarget(field) ? actions(ctx, field) : [noTarget(ctx)]));
  });
  return h(ctx.doc, "div", { "data-pw": "shape", role: "tree", "data-kind": data.basis, "aria-label": ctx.envelope.title }, ...fields);
}

// ---- graph --------------------------------------------------------------------------------------------------------------------

interface GraphParts { relationFilters: HTMLElement[]; graph: SVGElement; edgeList: HTMLElement; omitted: HTMLElement | null }

/** Longest edge label (in characters) the drawing prints; the edge list and the note's <title> keep the whole label (#12). */
const EDGE_NOTE_POINTS = 28;
function edgeNote(ctx: ComponentContext, label: string, mid: Position): SVGElement {
  const points = Array.from(label);
  const shown = points.length <= EDGE_NOTE_POINTS ? label : `${points.slice(0, EDGE_NOTE_POINTS - 1).join("")}…`;
  return svg(ctx.doc, "text", { "data-pw": "edge-note", x: mid.x, y: mid.y + 8, "font-size": 10, "data-truncated": points.length > EDGE_NOTE_POINTS ? "true" : undefined }, shown, svg(ctx.doc, "title", {}, label));
}

function renderGraphParts(ctx: ComponentContext): GraphParts {
  const data = ctx.envelope.data as { nodes: Item[]; edges: Item[]; layout: "layered" | "grid"; focus?: { node: string; direction: "in" | "out" | "both"; depth: number } };
  const edgesAsLinks = data.edges as unknown as Array<{ id: string; from: string; to: string; relation: string } & Item>;
  let scopeNodes = [...data.nodes].sort((a, b) => compareCodeUnits(a.id, b.id));
  let scopeEdges = [...edgesAsLinks].sort((a, b) => compareCodeUnits(a.id, b.id));
  let omitted: HTMLElement | null = null;
  if (data.focus !== undefined) {
    const hood = graphNeighborhood({ nodes: data.nodes, edges: edgesAsLinks }, data.focus);
    const nodeIds = new Set(hood.nodeIds);
    const edgeIds = new Set(hood.edgeIds);
    scopeNodes = scopeNodes.filter((node) => nodeIds.has(node.id));
    scopeEdges = scopeEdges.filter((edge) => edgeIds.has(edge.id));
    const count = data.nodes.length - scopeNodes.length;
    omitted = h(ctx.doc, "div", { "data-pw": "omitted-neighborhood" }, `${count} ${count === 1 ? "node" : "nodes"} omitted by focus`);
  }
  const layout = computeGraphLayout({ nodes: scopeNodes, edges: scopeEdges, layout: data.layout });
  const place = new Map(layout.nodes.map((node) => [node.id, node]));
  const route = new Map(layout.edges.map((edge) => [edge.id, edge.d]));
  const shown = new Set(ctx.summary.entries.map((entry) => entry.id));
  const visibleEdges = scopeEdges.filter((edge) => shown.has(edge.id));

  const relations = [...new Set(data.edges.map((edge) => String((edge as unknown as { relation: string }).relation)))].sort(compareCodeUnits);
  const relationFilters = relations.map((relation) => {
    const box = h(ctx.doc, "input", { type: "checkbox", "data-pw": "relation-filter", "data-id": relation, "aria-label": `Show ${relation}` }) as HTMLInputElement;
    box.checked = !ctx.ui.hiddenRelations.has(relation);
    return box;
  });

  const rows = scopeNodes.map((node) => {
    const at = place.get(node.id) as { x: number; y: number };
    const label = typeof node.label === "string" ? node.label : node.id;
    const mark = data.focus !== undefined && data.focus.node === node.id ? "focus" : undefined;
    // the node is a button, so its evidence controls are its siblings, drawn at the same place (review round 2, S9)
    return [svg(ctx.doc, "g", {
      "data-pw": "graph-node", "data-id": node.id, "data-provenance": node.provenance, "data-group": typeof node.group === "string" ? node.group : undefined, "data-x": at.x, "data-y": at.y,
      "data-status": mark, role: "button", tabindex: 0, transform: `translate(${at.x} ${at.y})`,
    },
    svg(ctx.doc, "rect", { width: 160, height: 40, rx: 4, fill: "none", stroke: "currentColor", "stroke-width": mark === undefined ? 1 : 3 }),
    svg(ctx.doc, "text", { x: 8, y: 16, "font-size": 12 }, label),
    ...provenanceParts(ctx, node, true, { x: 0, y: 0 })),
    ...evidenceLinks(ctx, node, true, at)];
  });
  const edgeElements = visibleEdges.map((edge) => {
    const d = route.get(edge.id) ?? "";
    const numbers = (d.match(/-?\d+/g) ?? []).map(Number);
    const mid = numbers.length >= 4 ? { x: Math.round(((numbers[0] ?? 0) + (numbers[numbers.length - 2] ?? 0)) / 2), y: Math.round(((numbers[1] ?? 0) + (numbers[numbers.length - 1] ?? 0)) / 2) } : { x: 0, y: 0 };
    return svg(ctx.doc, "g", { "data-pw": "graph-edge", "data-id": edge.id, "data-provenance": edge.provenance },
      svg(ctx.doc, "path", { "data-pw": "edge-path", d, fill: "none", stroke: "currentColor" }),
      svg(ctx.doc, "text", { "data-pw": "edge-label", x: mid.x, y: mid.y - 4, "font-size": 10 }, edge.relation),
      typeof edge.label === "string" && edgeNote(ctx, edge.label, mid),
      ...badge(ctx, edge, true, { x: mid.x, y: mid.y - 22 }));
  });
  const root = svg(ctx.doc, "svg", {
    "data-pw": "graph", role: "group", "aria-label": ctx.envelope.title, width: layout.width, height: layout.height, viewBox: `0 0 ${layout.width} ${layout.height}`,
  },
  svg(ctx.doc, "text", { "data-pw": "layout-info", "data-layout": layout.layout, "data-layout-version": ctx.layoutVersion, x: 0, y: 10, "font-size": 1, opacity: 0 }, `${layout.width} x ${layout.height}`),
  ...rows.flat(), ...edgeElements);
  const edgeList = h(ctx.doc, "div", { "data-pw": "graph-edge-list" },
    ...visibleEdges.map((edge) => h(ctx.doc, "div", { "data-pw": "graph-edge-item", "data-id": edge.id }, `${edge.from} -${edge.relation}-> ${edge.to}`,
      typeof edge.label === "string" && h(ctx.doc, "span", { "data-pw": "edge-list-label" }, edge.label), ...actions(ctx, edge))));
  return { relationFilters, graph: root, edgeList, omitted };
}

// ---- source -------------------------------------------------------------------------------------------------------------------

function originText(repository: string, revision: string | null | undefined, path: string): string {
  return `${repository} ${revision ?? "no revision"} ${path}`;
}

function sourceLines(ctx: ComponentContext, lines: Array<{ n: number; text: string }>, highlight: [number, number] | null): HTMLElement[] {
  return lines.map(({ n, text }) => h(ctx.doc, "div", {
    "data-pw": "source-line", "data-line": n, "data-highlighted": highlight !== null && n >= highlight[0] && n <= highlight[1] ? "true" : "false",
  }, h(ctx.doc, "span", { "data-pw": "line-number" }, String(n)), h(ctx.doc, "code", {}, text)));
}

/** The notices that explain how current the stored excerpt is. The excerpt itself is never hidden. */
function currencyNotices(ctx: ComponentContext, opening: SourceOpening | null): HTMLElement[] {
  if (opening === null || opening.status !== "resolved") return [];
  const { state } = opening.currency;
  if (state === "stale") {
    return [h(ctx.doc, "div", { "data-pw": "stale-notice", role: "note" }, `The recorded file hash does not match the file now (hash mismatch); showing the stored excerpt of ${opening.path}.`)];
  }
  if (state === "unknown") {
    return [h(ctx.doc, "div", { "data-pw": "unknown-notice", role: "note" }, `The current state of ${opening.path} is unknown (repository ${opening.repository} is not registered or not readable); showing the stored excerpt.`)];
  }
  return [];
}

function openedResolved(ui: PaneUi): SourceOpening | null {
  return ui.opened !== null && ui.opened.result.ok && ui.opened.result.value.status === "resolved" ? ui.opened.result.value : null;
}

function renderSource(ctx: ComponentContext): HTMLElement {
  const data = ctx.envelope.data as { excerpt: Item & { text: string; anchor: { repository: string; path: string; lines: [number, number] } }; annotations: Array<Item & { lines: [number, number]; message: string; claimIds: string[] }> };
  const excerpt = data.excerpt;
  const revision = ctx.envelope.freshness.repositories.find((candidate) => candidate.id === excerpt.anchor.repository)?.gitRev ?? null;
  const shown = new Set(ctx.summary.entries.filter((entry) => /^L\d+$/.test(entry.id)).map((entry) => Number(entry.id.slice(1))));
  const all = excerpt.text.split("\n");
  if (all[all.length - 1] === "") all.pop();
  const lines = all.map((text, index) => ({ n: excerpt.anchor.lines[0] + index, text })).filter(({ n }) => shown.has(n));
  const opening = openedResolved(ctx.ui);
  return h(ctx.doc, "div", { "data-pw": "source", role: "region", "aria-label": ctx.envelope.title },
    h(ctx.doc, "div", { "data-pw": "fact", "data-id": excerpt.id, "data-provenance": excerpt.provenance },
      h(ctx.doc, "span", { "data-pw": "source-origin" }, originText(excerpt.anchor.repository, revision, excerpt.anchor.path)), ...badge(ctx, excerpt, false)),
    ...currencyNotices(ctx, opening),
    ...sourceLines(ctx, lines, ctx.ui.highlight),
    ...data.annotations.map((annotation) => h(ctx.doc, "div", { "data-pw": "fact", "data-id": annotation.id, "data-provenance": annotation.provenance },
      h(ctx.doc, "button", { type: "button", "data-pw": "annotation", "data-id": annotation.id, "data-lines": `${annotation.lines[0]}-${annotation.lines[1]}` },
        annotation.claimIds.length > 0 ? `${annotation.message} (claims: ${annotation.claimIds.join(", ")})` : annotation.message),
      ...badge(ctx, annotation, false))));
}

/** Review S9: what the view declares about one source (every member of the source object, sorted by name), shown when an evidence control is activated. */
export function renderSourceDetail(ctx: ComponentContext, sourceId: string): HTMLElement {
  const declared = ctx.envelope.sources.find((candidate) => candidate.id === sourceId) as Record<string, unknown> | undefined;
  if (declared === undefined) {
    return h(ctx.doc, "div", { "data-pw": "source-detail", "data-source": sourceId, role: "region", "aria-label": `Source ${sourceId}` }, `source ${sourceId} is not declared by this view`);
  }
  const show = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));
  return h(ctx.doc, "div", { "data-pw": "source-detail", "data-source": sourceId, role: "region", "aria-label": `Source ${sourceId}` },
    ...Object.keys(declared).sort(compareCodeUnits).map((name) =>
      h(ctx.doc, "div", { "data-pw": "source-field", "data-name": name, "data-value": show(declared[name]) }, `${name}: ${show(declared[name])}`)));
}

/** E3: the stored excerpt of a followed source link, shown as the last child of a non-source pane. */
export function renderOpenedSource(ctx: ComponentContext, opening: SourceOpening & { status: "resolved" }, lines?: Array<{ n: number; text: string }>): HTMLElement {
  return h(ctx.doc, "div", { "data-pw": "source", role: "region", "aria-label": `Source ${opening.path}` },
    h(ctx.doc, "span", { "data-pw": "source-origin" }, originText(opening.repository, opening.revision, opening.path)),
    ...currencyNotices(ctx, opening),
    ...sourceLines(ctx, lines ?? opening.stored.lines, opening.highlight));
}

// ---- notebook -----------------------------------------------------------------------------------------------------------------

function renderNotebook(ctx: ComponentContext): HTMLElement {
  const data = ctx.envelope.data as { blocks: Item[] };
  const byId = new Map(data.blocks.map((block) => [block.id, block]));
  const shown = ctx.summary.entries.map((entry) => byId.get(entry.id)).filter((block): block is Item => block !== undefined);
  const open = (id: string) => ctx.ui.expanded.get(id) === true;

  const statusSelect = h(ctx.doc, "select", { "data-pw": "claim-filter", "aria-label": "Claim status" },
    ...["all", "supported", "disputed", "open"].map((value) => h(ctx.doc, "option", { value }, value))) as HTMLSelectElement;
  statusSelect.value = ctx.ui.claimStatus;

  const link = (kind: "supports" | "contradicts", target: unknown): HTMLElement => typeof target === "string"
    ? h(ctx.doc, "button", { type: "button", "data-pw": "evidence-link", "data-kind": kind, "data-source": target, ...(ctx.ui.sourceDetail === target ? { "aria-expanded": "true" } : {}) }, target)
    : h(ctx.doc, "button", { type: "button", "data-pw": "evidence-link", "data-kind": kind, "data-view-id": (target as { viewId: string }).viewId, "data-id": (target as { itemId: string }).itemId },
      `${(target as { viewId: string }).viewId}#${(target as { itemId: string }).itemId}`);

  const blocks = shown.map((block, position) => {
    const kind = String(block.kind);
    const foldable = kind === "claim" || kind === "view";
    const note = ctx.ui.notes.get(block.id);
    const parts: Child[] = [];
    if (foldable && ctx.interactive) parts.push(h(ctx.doc, "button", { type: "button", "data-pw": "toggle", "data-item": block.id, "aria-expanded": String(open(block.id)), "aria-label": `Toggle ${block.id}` }));
    if (kind === "prose") {
      const prose = h(ctx.doc, "div", { "data-pw": "prose" });
      prose.innerHTML = renderMarkdown(String(block.markdown)); // sanitised Markdown is the only markup sink
      parts.push(prose);
    } else if (kind === "view") {
      const viewId = String(block.viewId);
      const model = ctx.embeds.get(viewId) ?? null;
      const inner: Child[] = [model === null ? viewId : model.envelope.title];
      if (model !== null) {
        inner.push(h(ctx.doc, "span", { "data-pw": "completeness", "data-status": model.envelope.completeness.status }, completenessLine(model.envelope.completeness)));
        if (open(block.id) && model.envelope.completeness.status !== "unsupported" && model.envelope.data !== undefined && ctx.interactive) inner.push(renderEmbedded(ctx, model));
      }
      parts.push(h(ctx.doc, "div", { "data-pw": "embedded-view", "data-view-id": viewId }, ...inner));
    } else if (kind === "claim") {
      parts.push(h(ctx.doc, "span", {}, String(block.statement)), h(ctx.doc, "span", { "data-pw": "claim-status", "data-status": String(block.status) }, String(block.status)));
    } else if (ctx.interactive) {
      // review S9: an example block opens the example it names (a view id or a scenario id)
      parts.push(h(ctx.doc, "button", { type: "button", "data-pw": "example-link", "data-item": block.id, "data-example-id": String(block.exampleId) }, `example: ${String(block.exampleId)}`));
    } else {
      parts.push(h(ctx.doc, "span", {}, `example: ${String(block.exampleId)}`));
    }
    parts.push(...badge(ctx, block, false));
    if (kind === "claim" && open(block.id)) {
      for (const target of (block.supports as unknown[]) ?? []) parts.push(link("supports", target));
      for (const target of (block.contradicts as unknown[]) ?? []) parts.push(link("contradicts", target));
    }
    if (note !== undefined) parts.push(h(ctx.doc, "span", { "data-pw": "no-target" }, note));
    if (ctx.editable && ctx.interactive) {
      if (position > 0) parts.push(h(ctx.doc, "button", { type: "button", "data-pw": "block-move", "data-direction": "up", "data-item": block.id, "aria-label": `Move ${block.id} up` }, "Move up"));
      if (position < shown.length - 1) parts.push(h(ctx.doc, "button", { type: "button", "data-pw": "block-move", "data-direction": "down", "data-item": block.id, "aria-label": `Move ${block.id} down` }, "Move down"));
    }
    return h(ctx.doc, "div", { "data-pw": "block", "data-id": block.id, "data-kind": kind, "data-provenance": block.provenance }, ...parts);
  });
  return h(ctx.doc, "div", { "data-pw": "notebook", role: "region", "aria-label": ctx.envelope.title },
    ctx.interactive ? statusSelect : null,
    ctx.editable && ctx.notebookRevision !== undefined && h(ctx.doc, "div", { "data-pw": "notebook-revision", "data-revision": ctx.notebookRevision }, `revision ${ctx.notebookRevision}`),
    ...blocks);
}

/** One level of an embedded view: the same renderers over its own summary, without controls. */
function renderEmbedded(ctx: ComponentContext, model: ViewModel): HTMLElement {
  const inner: ComponentContext = {
    ...ctx, envelope: model.envelope, summary: ctx.summarise(model), ui: newPaneUi(), selection: [], embeds: new Map(), interactive: false, editable: false,
  };
  return renderComponent(inner) as HTMLElement;
}

// ---- example ------------------------------------------------------------------------------------------------------------------

function renderExample(ctx: ComponentContext): HTMLElement {
  const data = ctx.envelope.data as { scenario: Item & { runnerId: string }; runs: Array<Item & { runId: string; status: string; assertions: Array<Item & { statement: string; passed: boolean }>; result?: { repository: string; id: string; kind: string }; error?: string }> };
  const scenario = data.scenario;
  const byId = new Map(data.runs.map((run) => [run.id, run]));
  const runs = ctx.summary.entries.map((entry) => byId.get(entry.id)).filter((run): run is (typeof data.runs)[number] => run !== undefined);
  const originOf = (run: { id: string }): string => ((ctx.summary.entries.find((entry) => entry.id === run.id)?.json as { origin?: string } | undefined)?.origin) ?? "envelope";
  return h(ctx.doc, "div", { "data-pw": "example", role: "region", "aria-label": ctx.envelope.title },
    h(ctx.doc, "div", { "data-pw": "scenario" }, `${typeof scenario.label === "string" ? scenario.label : scenario.id} (${scenario.runnerId})`, ...badge(ctx, scenario, false)),
    data.runs.length === 0 && h(ctx.doc, "div", { "data-pw": "not-run" }, "not run"),
    ...runs.map((run) => h(ctx.doc, "div", { "data-pw": "run", "data-id": run.id, "data-provenance": run.provenance, "data-run-id": run.runId, "data-status": run.status, "data-origin": originOf(run) }, `${run.runId}: ${run.status}`,
      ...run.assertions.map((assertion) => h(ctx.doc, "div", { "data-pw": "assertion", "data-id": assertion.id, "data-passed": String(assertion.passed) }, `${assertion.statement} ${assertion.passed ? "PASS" : "FAIL"}`, ...badge(ctx, assertion, false))),
      run.result !== undefined && ctx.interactive && h(ctx.doc, "button", { type: "button", "data-pw": "result-link", "data-item": run.id }, `${run.result.kind}:${run.result.id}`),
      run.error !== undefined && h(ctx.doc, "span", {}, run.error),
      ...badge(ctx, run, false))),
    h(ctx.doc, "div", { "data-pw": "rerun-instruction" }, `paneweft example run ${scenario.runnerId}`));
}

// ---- entry point --------------------------------------------------------------------------------------------------------------

/** Components that show the "empty-state" instead of a root when they hold nothing to show. */
export const HAS_EMPTY_STATE = new Set(["list", "tree", "graph", "shape", "notebook"]);

export function renderComponent(ctx: ComponentContext): HTMLElement | null {
  if (ctx.envelope.data === undefined) return null;
  switch (ctx.envelope.component) {
    case "list": return renderList(ctx);
    case "tree": return renderTree(ctx);
    case "shape": return renderShape(ctx);
    case "source": return renderSource(ctx);
    case "notebook": return renderNotebook(ctx);
    case "example": return renderExample(ctx);
    case "graph": {
      const parts = renderGraphParts(ctx);
      return append(h(ctx.doc, "div", { "data-graph-parts": "true" }), ...parts.relationFilters, parts.graph, parts.omitted, parts.edgeList);
    }
  }
}
