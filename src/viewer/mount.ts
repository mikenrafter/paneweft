// Plain-DOM viewer (design section 5): renders validated view models only; labels, source text,
// Markdown and URLs are data. docs/viewer-dom-contract.md is normative for the DOM structure.
//
// Shape of the code: the inspector reducer (src/core/inspector.ts) owns navigation. It is synchronous, the source is not, so every
// action first loads what the reducer will ask about (rankings, view models), then reduces, then loads and renders. Rendering is a
// full, deterministic rebuild from (inspector state, caches, per-pane UI state); one set of delegated listeners on the container
// reads the data-* attributes the renderers wrote. Nothing in here uses a timer.
import type { Entity, EntityRef, Envelope } from "../core/wire.ts";
import type { Result } from "../core/errors.ts";
import { referencedSnapshot, viewItems, type AnyItem } from "../core/items.ts";
import { initialInspectorState, reduceInspector, type InspectorAction, type InspectorState, type InspectorWorld, type PaneState } from "../core/inspector.ts";
import { LAYOUT_VERSION } from "../core/layout.ts";
import type { RankOutput, RankedView } from "../core/registry.ts";
import { completenessLine, freshnessLine, summariseView, type RecordedRuns, type ViewFilter, type ViewSummary } from "../core/summaries.ts";
import { compareCodeUnits } from "../core/canonical.ts";
import { HAS_EMPTY_STATE, newPaneUi, renderComponent, renderOpenedSource, renderSourceDetail, type ComponentContext, type PaneUi } from "./components.ts";
import { append, h, type Child } from "./dom.ts";
import type { ViewerSource, ViewModel } from "./source.ts";

export interface MountOptions {
  source: ViewerSource;
  viewport: { width: number; height: number };
  locale: string;
  layoutVersion?: string;
  /** Shows the notebook editing controls (block moves). The shipped bundle sets it; read-only mounts leave it off. */
  editable?: boolean;
}
export interface ViewerHandle {
  state(): InspectorState;
  openEntity(entity: EntityRef, snapshotId: string, preferredViewDefinitionId?: string): Promise<void>;
  /** Resolves when no render or source request is in flight. Tests await it after each event. */
  whenIdle(): Promise<void>;
  destroy(): void;
}

const NARROW_BELOW = 640;
const PROVENANCE_ORDER = ["read", "parsed", "compiled", "observed", "inferred"] as const;
const keyOfEntity = (entity: EntityRef, snapshotId: string): string => JSON.stringify([snapshotId, entity.repository, entity.kind, entity.id]);
const entityRefOf = (item: AnyItem): EntityRef | undefined => {
  const found = item.entity ?? (item.result as AnyItem["entity"]);
  return found === undefined ? undefined : { repository: found.repository, id: found.id, kind: found.kind };
};
const available = (view: RankedView): boolean => view.availability.status === "available";

interface FocusSpec { pane: string | null; selector: string; selection: [number | null, number | null] | null }
/** Attributes that identify a control among its siblings, in the order they are matched. */
const IDENTITY = ["data-id", "data-item", "data-definition-id", "data-pane-index", "data-source", "data-view-id", "data-kind", "data-direction"] as const;

export async function mountViewer(container: HTMLElement, options: MountOptions): Promise<ViewerHandle> {
  const doc = container.ownerDocument;
  const win = doc.defaultView as Window & typeof globalThis;
  const { source, locale } = options;
  const layoutVersion = options.layoutVersion ?? LAYOUT_VERSION;
  const narrow = options.viewport.width < NARROW_BELOW;
  const uid = `pw${Math.random().toString(36).slice(2, 8)}`; // element ids only; never visible in structure

  let state: InspectorState = initialInspectorState();
  let lastError: { code: string; message: string } | null = null;
  let activePane: number | null = null;
  let pendingFocus: { pane: string | null; selector: string } | null = null;
  let destroyed = false;

  const entities = new Map<string, Result<Entity>>();
  const rankings = new Map<string, Result<RankOutput>>();
  const views = new Map<string, Result<ViewModel>>();
  const embeds = new Map<string, Result<ViewModel>>();
  const uiByKey = new Map<string, PaneUi>();

  // ---- work queue: actions run one at a time; whenIdle waits for the queue ----------------------------------------------------
  let tail: Promise<void> = Promise.resolve();
  const pending = new Set<Promise<void>>();
  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = tail.then(async () => { if (!destroyed) await task(); }).catch((error: unknown) => {
      lastError = { code: "INTERNAL", message: String(error) };
      if (!destroyed) render();
    });
    tail = run;
    pending.add(run);
    void run.then(() => pending.delete(run));
    return run;
  }
  async function whenIdle(): Promise<void> {
    while (pending.size > 0) await Promise.all([...pending]);
  }

  // ---- loading ---------------------------------------------------------------------------------------------------------------
  async function ensureEntity(entity: EntityRef, snapshotId: string): Promise<void> {
    const key = keyOfEntity(entity, snapshotId);
    if (!entities.has(key)) entities.set(key, await source.getEntity(entity, snapshotId));
    if (!rankings.has(key)) rankings.set(key, await source.applicableViews(entity, snapshotId));
  }
  async function ensureView(entity: EntityRef, snapshotId: string, definitionId: string): Promise<void> {
    if (definitionId.startsWith("builtin:")) return;
    const key = JSON.stringify([keyOfEntity(entity, snapshotId), definitionId]);
    if (!views.has(key)) views.set(key, await source.getViewFor(entity, snapshotId, definitionId));
  }
  const viewOf = (entity: EntityRef, snapshotId: string, definitionId: string): Result<ViewModel> | undefined =>
    views.get(JSON.stringify([keyOfEntity(entity, snapshotId), definitionId]));

  async function loadAll(): Promise<void> {
    for (const pane of state.trail) {
      await ensureEntity(pane.entity, pane.snapshotId);
      await ensureView(pane.entity, pane.snapshotId, pane.viewDefinitionId);
      const model = viewOf(pane.entity, pane.snapshotId, pane.viewDefinitionId);
      if (model?.ok && model.value.envelope.component === "notebook") {
        for (const block of viewItems(model.value.envelope)) {
          const viewId = block.kind === "view" ? String(block.viewId) : null;
          if (viewId === null) continue;
          const snapshotId = referencedSnapshot(model.value.envelope, viewId);
          const key = JSON.stringify([snapshotId, viewId]);
          if (!embeds.has(key)) embeds.set(key, await source.getView({ viewId, snapshotId }));
        }
      }
    }
  }

  // ---- the reducer's world, answered from what has been loaded -----------------------------------------------------------------
  const world: InspectorWorld = {
    initialView(entity, snapshotId, preferred) {
      const ranked = rankings.get(keyOfEntity(entity, snapshotId));
      if (ranked === undefined || !ranked.ok) return undefined;
      const wanted = preferred === undefined ? undefined : ranked.value.views.find((view) => view.definitionId === preferred);
      if (wanted !== undefined && available(wanted)) return preferred;
      return ranked.value.selected?.definitionId;
    },
    hasView(entity, snapshotId, definitionId) {
      const ranked = rankings.get(keyOfEntity(entity, snapshotId));
      return ranked !== undefined && ranked.ok && ranked.value.views.some((view) => view.definitionId === definitionId && available(view));
    },
    itemTarget(entity, snapshotId, definitionId, itemId) {
      const model = viewOf(entity, snapshotId, definitionId);
      const item = model !== undefined && model.ok ? viewItems(model.value.envelope).find((candidate) => candidate.id === itemId) : undefined;
      if (item === undefined) return { kind: "missing" };
      const target = entityRefOf(item);
      return target === undefined ? { kind: "none" } : { kind: "entity", entity: target };
    },
    itemExists(entity, snapshotId, definitionId, itemId) {
      const model = viewOf(entity, snapshotId, definitionId);
      return model !== undefined && model.ok && viewItems(model.value.envelope).some((candidate) => candidate.id === itemId);
    },
  };

  // ---- state changes -----------------------------------------------------------------------------------------------------------
  function commit(next: InspectorState): void {
    if (next === state) return;
    state = next;
    activePane = null;
    win.history.pushState({ paneweft: state }, "");
  }
  async function prepare(action: InspectorAction): Promise<{ code: string; message: string } | null> {
    if (action.type === "open") {
      await ensureEntity(action.entity, action.snapshotId);
      const ranked = rankings.get(keyOfEntity(action.entity, action.snapshotId));
      const found = entities.get(keyOfEntity(action.entity, action.snapshotId));
      if (found !== undefined && !found.ok) return { code: found.error.code, message: found.error.message };
      if (ranked !== undefined && !ranked.ok) return { code: ranked.error.code, message: ranked.error.message };
      if (action.viewDefinitionId !== undefined) await ensureView(action.entity, action.snapshotId, action.viewDefinitionId);
    } else if (action.type === "select") {
      const pane = state.trail[action.paneIndex];
      if (pane !== undefined) {
        const model = viewOf(pane.entity, pane.snapshotId, pane.viewDefinitionId);
        const item = model !== undefined && model.ok ? viewItems(model.value.envelope).find((candidate) => candidate.id === action.itemId) : undefined;
        const target = item === undefined ? undefined : entityRefOf(item);
        if (target !== undefined) await ensureEntity(target, pane.snapshotId);
      }
    } else if (action.type === "switchView") {
      const pane = state.trail[action.paneIndex];
      if (pane !== undefined) await ensureView(pane.entity, pane.snapshotId, action.viewDefinitionId);
    }
    return null;
  }
  async function dispatch(action: InspectorAction): Promise<void> {
    lastError = await prepare(action);
    if (lastError === null) {
      const outcome = reduceInspector(state, action, world);
      if (outcome.notice !== undefined && outcome.notice.code !== "NO_TARGET") lastError = { code: outcome.notice.code, message: outcome.notice.message };
      commit(outcome.state);
    }
    await loadAll();
    render();
  }

  // ---- per-pane UI state --------------------------------------------------------------------------------------------------------
  function uiOf(index: number): PaneUi {
    const pane = state.trail[index] as PaneState;
    const key = JSON.stringify([index, keyOfEntity(pane.entity, pane.snapshotId), pane.viewDefinitionId]);
    let ui = uiByKey.get(key);
    if (ui === undefined) { ui = newPaneUi(); uiByKey.set(key, ui); }
    return ui;
  }
  function filterFor(model: ViewModel, ui: PaneUi): ViewFilter {
    const filter: ViewFilter = {};
    if (ui.filterText !== "") filter.text = ui.filterText;
    if (model.envelope.component === "graph" && ui.hiddenRelations.size > 0) {
      const edges = ((model.envelope.data as { edges?: Array<{ relation: string }> } | undefined)?.edges ?? []);
      filter.relation = [...new Set(edges.map((edge) => edge.relation))].filter((relation) => !ui.hiddenRelations.has(relation)).sort(compareCodeUnits);
    }
    if (model.envelope.component === "notebook" && ui.claimStatus !== "all") filter.status = [ui.claimStatus];
    return filter;
  }
  const recordedOf = (model: ViewModel): RecordedRuns | undefined => model.recordedRuns === undefined ? undefined
    : { byItemId: new Map(model.recordedRuns.runs.map((run) => [run.itemId, { runId: run.runId, contentHash: run.contentHash }])), notice: model.recordedRuns.notice };
  const summarise = (model: ViewModel, filter: ViewFilter = {}): ViewSummary => summariseView(model.envelope, model.freshness, { filter, embedDepth: 0 }, undefined, recordedOf(model));

  // ---- rendering ----------------------------------------------------------------------------------------------------------------
  function emptyMessage(summary: ViewSummary, filtered: boolean): string | null {
    if (summary.total === 0) {
      const completeness = summary.completeness;
      if (completeness.status === "complete") return "0 items within this scope";
      if (completeness.status === "partial") {
        const gap = completeness.gaps[0];
        return `no items returned; completeness is partial: ${gap?.id ?? "?"}: ${gap?.question ?? ""}`;
      }
      return null;
    }
    return summary.matched === 0 && filtered ? `no items match the current filters (0 of ${summary.total})` : null;
  }

  function statusStrip(model: ViewModel, summary: ViewSummary): HTMLElement {
    const counts = PROVENANCE_ORDER.map((name) => `${name}=${summary.provenance[name]}`).join(" ");
    return h(doc, "div", { "data-pw": "status-strip" },
      h(doc, "div", { "data-pw": "completeness", "data-status": model.envelope.completeness.status }, completenessLine(model.envelope.completeness)),
      h(doc, "div", { "data-pw": "freshness", "data-status": model.freshness.status }, freshnessLine(model.freshness)),
      h(doc, "div", { "data-pw": "snapshot" }, model.envelope.snapshotId),
      h(doc, "div", { "data-pw": "provenance-summary" }, counts),
      h(doc, "div", { "data-pw": "evidence-coverage" }, `sources=${summary.evidenceSources.join(",")}`));
  }

  function builtinPanel(which: string, entity: Entity | undefined): HTMLElement {
    if (entity === undefined) return h(doc, "div", {}, "no entity record");
    if (which === "builtin:raw") return h(doc, "pre", {}, JSON.stringify(entity, null, 2));
    const rows: Array<[string, string]> = [
      ["repository", entity.repository], ["kind", entity.kind], ["id", entity.id], ["snapshot", entity.snapshotId], ["label", entity.label],
      ["data roles", entity.dataRoles.join(", ")], ["relations", entity.relations.map((relation) => `${relation.name} -> ${relation.target.kind}:${relation.target.id}`).join("; ")],
    ];
    return h(doc, "dl", {}, ...rows.flatMap(([name, value]) => [h(doc, "dt", {}, name), h(doc, "dd", {}, value)]));
  }

  function renderPane(index: number, pane: PaneState): HTMLElement {
    const entityKey = keyOfEntity(pane.entity, pane.snapshotId);
    const entityResult = entities.get(entityKey);
    const entity = entityResult !== undefined && entityResult.ok ? entityResult.value : undefined;
    const label = entity?.label ?? pane.entity.id;
    const ranked = rankings.get(entityKey);
    const rankedViews = ranked !== undefined && ranked.ok ? ranked.value.views : [];
    const ui = uiOf(index);
    const panelId = `${uid}-panel-${index}`;
    const tabId = (n: number) => `${uid}-tab-${index}-${n}`;
    const tabs = rankedViews.filter(available);
    const selectedAt = Math.max(0, tabs.findIndex((view) => view.definitionId === pane.viewDefinitionId));
    const unavailable = rankedViews.filter((view) => !available(view));

    const tablist = h(doc, "div", { "data-pw": "view-tabs", role: "tablist", "aria-label": "Views" }, ...tabs.map((view, n) => h(doc, "button", {
      type: "button", id: tabId(n), "data-pw": "tab", role: "tab", "aria-selected": n === selectedAt ? "true" : "false", "aria-controls": panelId,
      "data-definition-id": view.definitionId, tabindex: n === selectedAt ? 0 : -1,
    }, view.title)));

    const needs = unavailable.length === 0 ? null : h(doc, "details", { "data-pw": "needs-evidence" }, h(doc, "summary", {}, "Needs evidence"),
      ...unavailable.map((view) => h(doc, "div", { "data-pw": "unavailable-view" },
        view.availability.status === "needs_data" ? `${view.title}: needs ${view.availability.missingRoles.join(", ")}`
          : view.availability.status === "unsupported" ? `${view.title}: ${view.availability.reason}` : view.title)));

    const parts: Child[] = [];
    const panelChildren: Child[] = [];
    let opened: HTMLElement | null = null;
    let detail: HTMLElement | null = null;
    const model = pane.viewDefinitionId.startsWith("builtin:") ? undefined : viewOf(pane.entity, pane.snapshotId, pane.viewDefinitionId);
    if (pane.viewDefinitionId.startsWith("builtin:")) {
      panelChildren.push(builtinPanel(pane.viewDefinitionId, entity));
    } else if (model === undefined || !model.ok) {
      const failure = model !== undefined && !model.ok ? model.error : undefined;
      panelChildren.push(h(doc, "div", { "data-pw": "error", role: "alert", "data-code": failure?.code ?? "NOT_FOUND" }, `${failure?.code ?? "NOT_FOUND"}: ${failure?.message ?? "the view could not be loaded"}`));
    } else {
      const view = model.value;
      const summary = summarise(view, filterFor(view, ui));
      const input = h(doc, "input", { type: "search", "data-pw": "filter-input", "aria-label": "Filter" }) as HTMLInputElement;
      input.value = ui.filterText;
      parts.push(statusStrip(view, summarise(view)), input,
        h(doc, "div", { "data-pw": "match-count", "data-matched": summary.matched, "data-total": summary.total }, `${summary.matched} of ${summary.total} match`));
      const context: ComponentContext = {
        doc, locale, layoutVersion, paneIndex: index, envelope: view.envelope, summary, ui, selection: pane.selection, interactive: true,
        embeds: embedModels(view.envelope), editable: options.editable === true, summarise: (inner) => summarise(inner),
        ...(view.notebookRevision === undefined ? {} : { notebookRevision: view.notebookRevision }),
      };
      if (ui.error !== null) panelChildren.push(h(doc, "div", { "data-pw": "error", role: "alert", "data-code": ui.error.code }, `${ui.error.code}: ${ui.error.message}`));
      const message = HAS_EMPTY_STATE.has(view.envelope.component) ? emptyMessage(summary, ui.filterText !== "" || ui.hiddenRelations.size > 0 || ui.claimStatus !== "all") : null;
      if (message !== null) panelChildren.push(h(doc, "div", { "data-pw": "empty-state" }, message));
      else panelChildren.push(renderComponent(context));
      const resolved = ui.opened !== null && ui.opened.result.ok ? ui.opened.result.value : null;
      if (view.envelope.component !== "source" && resolved !== null && resolved.status === "resolved") opened = renderOpenedSource(context, resolved, ui.opened?.lines);
      if (ui.sourceDetail !== null) detail = renderSourceDetail(context, ui.sourceDetail);
    }
    const panel = h(doc, "div", { "data-pw": "tabpanel", id: panelId, role: "tabpanel", "aria-labelledby": tabs.length > 0 ? tabId(selectedAt) : undefined }, ...panelChildren);

    return h(doc, "section", {
      "data-pw": "pane", "aria-label": label, "data-pane-index": index, "data-entity-id": pane.entity.id, "data-snapshot-id": pane.snapshotId, "data-view-id": pane.viewDefinitionId,
      "data-pinned": String(pane.pinned), hidden: narrow && index !== (activePane ?? state.trail.length - 1) ? "" : undefined,
    },
    h(doc, "button", { type: "button", "data-pw": "pin", "aria-pressed": String(pane.pinned) }, "Pin"),
    tablist, needs, ...parts, panel, detail, opened);
  }

  function embedModels(envelope: Envelope): Map<string, ViewModel | null> {
    const found = new Map<string, ViewModel | null>();
    if (envelope.component !== "notebook") return found;
    for (const block of viewItems(envelope)) {
      if (block.kind !== "view") continue;
      const viewId = String(block.viewId);
      const result = embeds.get(JSON.stringify([referencedSnapshot(envelope, viewId), viewId]));
      found.set(viewId, result !== undefined && result.ok ? result.value : null);
    }
    return found;
  }

  function captureFocus(): FocusSpec | null {
    const active = doc.activeElement as HTMLElement | null;
    if (active === null || active === doc.body || !container.contains(active)) return null;
    const pw = active.getAttribute("data-pw");
    if (pw === null) return null;
    const selector = `[data-pw="${pw}"]${IDENTITY.filter((name) => active.hasAttribute(name)).map((name) => `[${name}=${JSON.stringify(active.getAttribute(name))}]`).join("")}`;
    const input = active as HTMLInputElement;
    return {
      pane: active.closest('[data-pw="pane"]')?.getAttribute("data-pane-index") ?? null, selector,
      selection: typeof input.selectionStart === "number" ? [input.selectionStart, input.selectionEnd] : null,
    };
  }
  function restoreFocus(spec: FocusSpec | { pane: string | null; selector: string } | null): void {
    if (spec === null) return;
    const scope = spec.pane === null ? container : container.querySelector(`[data-pw="pane"][data-pane-index="${spec.pane}"]`) ?? container;
    const target = scope.querySelector<HTMLElement>(spec.selector);
    if (target === null) return;
    target.focus();
    const range = (spec as FocusSpec).selection;
    if (range !== undefined && range !== null && range[0] !== null && range[1] !== null) { try { (target as HTMLInputElement).setSelectionRange(range[0], range[1]); } catch { /* not a text input */ } }
  }

  function render(): void {
    if (destroyed) return;
    const focus = pendingFocus ?? captureFocus();
    pendingFocus = null;
    const active = activePane ?? state.trail.length - 1;
    const trail = h(doc, "nav", { "data-pw": "pane-trail", "aria-label": "Pane trail" }, ...state.trail.map((pane, index) => {
      const known = entities.get(keyOfEntity(pane.entity, pane.snapshotId));
      return h(doc, "button", { type: "button", "data-pw": "crumb", "data-pane-index": index, "aria-current": index === active ? "page" : undefined }, known !== undefined && known.ok ? known.value.label : pane.entity.id);
    }));
    const root = h(doc, "div", { "data-pw": "viewer" }, trail, ...state.trail.map((pane, index) => renderPane(index, pane)),
      lastError !== null && h(doc, "div", { "data-pw": "error", role: "alert", "data-code": lastError.code }, `${lastError.code}: ${lastError.message}`));
    container.replaceChildren(root);
    restoreFocus(focus);
  }

  // ---- actions bound to controls --------------------------------------------------------------------------------------------------
  function paneOf(element: Element): number | null {
    const raw = element.closest('[data-pw="pane"]')?.getAttribute("data-pane-index");
    return raw === null || raw === undefined ? null : Number(raw);
  }
  const currentModel = (index: number): ViewModel | undefined => {
    const pane = state.trail[index];
    const found = pane === undefined ? undefined : viewOf(pane.entity, pane.snapshotId, pane.viewDefinitionId);
    return found !== undefined && found.ok ? found.value : undefined;
  };

  async function openSource(index: number, itemId: string, highlight: [number, number] | null): Promise<void> {
    const pane = state.trail[index];
    const model = currentModel(index);
    if (pane === undefined || model === undefined) return;
    const ui = uiOf(index);
    ui.menu = null;
    const result = await source.openItemSource({ viewId: model.envelope.id, snapshotId: pane.snapshotId }, itemId);
    ui.opened = { itemId, result };
    if (result.ok && result.value.status === "resolved" && model.envelope.component !== "source") {
      // The opening carries the anchored lines; the pane shows the whole stored excerpt with those lines highlighted.
      const holder = await source.getView({ viewId: result.value.stored.viewId, snapshotId: result.value.stored.snapshotId });
      if (holder.ok && holder.value.envelope.component === "source") {
        const excerpt = (holder.value.envelope.data as { excerpt: { text: string; anchor: { lines: [number, number] } } }).excerpt;
        const all = excerpt.text.split("\n");
        if (all[all.length - 1] === "") all.pop();
        ui.opened.lines = all.map((text, offset) => ({ n: excerpt.anchor.lines[0] + offset, text }));
      }
    }
    ui.highlight = highlight ?? (result.ok && result.value.status === "resolved" ? result.value.highlight : null);
    if (!result.ok) ui.error = { code: result.error.code, message: result.error.message };
    else if (result.value.status === "unresolved") ui.error = { code: result.value.code, message: result.value.message };
    else ui.error = null;
    render();
  }

  async function followLink(index: number, blockId: string, viewId: string, itemId: string): Promise<void> {
    const pane = state.trail[index];
    if (pane === undefined) return;
    const ui = uiOf(index);
    const holder = currentModel(index);
    const snapshotId = holder === undefined ? pane.snapshotId : referencedSnapshot(holder.envelope, viewId, itemId);
    const model = await source.getView({ viewId, snapshotId });
    const item = model.ok ? viewItems(model.value.envelope).find((candidate) => candidate.id === itemId) : undefined;
    if (!model.ok || item === undefined) {
      ui.notes.set(blockId, `no entity or source: ${model.ok ? `item "${itemId}" is not in view "${viewId}"` : `view "${viewId}" cannot be opened (${model.error.code})`}`);
      render();
      return;
    }
    ui.notes.delete(blockId);
    const { entity, viewDefinitionId } = model.value.envelope;
    await ensureEntity(entity, snapshotId);
    await ensureView(entity, snapshotId, viewDefinitionId);
    lastError = null;
    const outcome = reduceInspector(state, { type: "open", entity, snapshotId, viewDefinitionId }, world);
    if (outcome.notice !== undefined) lastError = { code: outcome.notice.code, message: outcome.notice.message };
    else {
      const trail = outcome.state.trail.map((entry, position, all) => (position === all.length - 1 ? { ...entry, selection: [itemId] } : entry));
      commit({ ...outcome.state, trail });
    }
    await loadAll();
    render();
  }

  /** Review S9: opens the example a notebook block names (a view id, else a scenario id) in the next pane, in the snapshot the notebook's links name. */
  async function followExample(index: number, blockId: string, exampleId: string): Promise<void> {
    const pane = state.trail[index];
    if (pane === undefined) return;
    const ui = uiOf(index);
    const holder = currentModel(index);
    const snapshotId = holder === undefined ? pane.snapshotId : referencedSnapshot(holder.envelope, exampleId);
    const found = await source.findExample(exampleId, snapshotId);
    if (!found.ok) {
      ui.notes.set(blockId, `no example: "${exampleId}" cannot be opened (${found.error.code})`);
      render();
      return;
    }
    ui.notes.delete(blockId);
    const { entity, viewDefinitionId } = found.value.envelope;
    await ensureEntity(entity, snapshotId);
    await ensureView(entity, snapshotId, viewDefinitionId);
    lastError = null;
    const outcome = reduceInspector(state, { type: "open", entity, snapshotId, viewDefinitionId }, world);
    if (outcome.notice !== undefined) lastError = { code: outcome.notice.code, message: outcome.notice.message };
    else commit(outcome.state);
    await loadAll();
    render();
  }

  async function moveBlock(index: number, blockId: string, direction: "up" | "down"): Promise<void> {
    const pane = state.trail[index];
    const model = currentModel(index);
    if (pane === undefined || model === undefined || model.envelope.component !== "notebook") return;
    const ui = uiOf(index);
    const blocks = [...(model.envelope.data as { blocks: unknown[] }).blocks] as Array<{ id: string }>;
    const at = blocks.findIndex((block) => block.id === blockId);
    const to = direction === "up" ? at - 1 : at + 1;
    if (at < 0 || to < 0 || to >= blocks.length) return;
    [blocks[at], blocks[to]] = [blocks[to] as { id: string }, blocks[at] as { id: string }];
    const written = await source.updateNotebook(model.envelope.id, model.notebookRevision ?? 1, blocks, model.envelope.snapshotId);
    if (!written.ok) { ui.error = { code: written.error.code, message: written.error.message }; render(); return; }
    ui.error = null;
    views.delete(JSON.stringify([keyOfEntity(pane.entity, pane.snapshotId), pane.viewDefinitionId]));
    await loadAll();
    render();
  }

  function setExpanded(index: number, itemId: string, next: boolean): void {
    uiOf(index).expanded.set(itemId, next);
    pendingFocus = { pane: String(index), selector: `[data-pw="toggle"][data-item=${JSON.stringify(itemId)}]` };
    render();
  }

  function closeMenu(index: number): void {
    const ui = uiOf(index);
    const item = ui.menu;
    ui.menu = null;
    if (item !== null) pendingFocus = { pane: String(index), selector: `[data-pw="actions-button"][data-item=${JSON.stringify(item)}]` };
    render();
  }

  /** The control a click or Enter/Space on `target` means, or null. */
  const ACTIVATABLE = new Set(["crumb", "pin", "tab", "toggle", "actions-button", "menu-item", "annotation", "evidence-link", "example-link", "result-link", "block-move", "no-target", "row", "node", "field", "graph-node"]);
  function controlOf(target: EventTarget | null): HTMLElement | null {
    let element = target instanceof win.Element ? (target as HTMLElement) : null;
    while (element !== null && element !== container) {
      const name = element.getAttribute("data-pw");
      if (name !== null && ACTIVATABLE.has(name)) return element;
      element = element.parentElement;
    }
    return null;
  }

  function activate(control: HTMLElement): void {
    const name = control.getAttribute("data-pw") as string;
    const index = paneOf(control);
    if (name === "crumb") {
      activePane = Number(control.getAttribute("data-pane-index"));
      render();
      return;
    }
    if (index === null || state.trail[index] === undefined) return;
    const ui = uiOf(index);
    const item = control.getAttribute("data-item") ?? control.getAttribute("data-id") ?? "";
    switch (name) {
      case "pin":
        void enqueue(() => dispatch({ type: "pin", paneIndex: index }));
        return;
      case "tab":
        void enqueue(() => dispatch({ type: "switchView", paneIndex: index, viewDefinitionId: control.getAttribute("data-definition-id") as string }));
        return;
      case "toggle": {
        const holder = control.closest('[data-pw="node"], [data-pw="field"]') ?? control;
        setExpanded(index, item, holder.getAttribute("aria-expanded") !== "true");
        return;
      }
      case "actions-button": {
        ui.menu = ui.menu === item ? null : item;
        pendingFocus = { pane: String(index), selector: ui.menu === null ? `[data-pw="actions-button"][data-item=${JSON.stringify(item)}]` : '[data-pw="actions-menu"] [data-pw="menu-item"]' };
        render();
        return;
      }
      case "menu-item": {
        const kind = control.getAttribute("data-kind");
        ui.menu = null;
        if (kind === "open-source") void enqueue(() => openSource(index, item, null));
        else void enqueue(() => { ui.roving = item; return dispatch({ type: "select", paneIndex: index, itemId: item }); });
        return;
      }
      case "annotation": {
        const range = (control.getAttribute("data-lines") ?? "").split("-").map(Number);
        const lines: [number, number] | null = range.length === 2 && range.every(Number.isInteger) ? [range[0] as number, range[1] as number] : null;
        void enqueue(() => openSource(index, control.getAttribute("data-id") as string, lines));
        return;
      }
      case "evidence-link": {
        const viewId = control.getAttribute("data-view-id");
        if (viewId !== null) {
          const blockId = control.closest('[data-pw="block"]')?.getAttribute("data-id") ?? "";
          void enqueue(() => followLink(index, blockId, viewId, control.getAttribute("data-id") as string));
          return;
        }
        const sourceId = control.getAttribute("data-source");
        if (sourceId !== null) {
          // review S9: show (or hide) what the view declares about this source
          ui.sourceDetail = ui.sourceDetail === sourceId ? null : sourceId;
          pendingFocus = { pane: String(index), selector: `[data-pw="evidence-link"][data-source=${JSON.stringify(sourceId)}]${control.hasAttribute("data-kind") ? `[data-kind=${JSON.stringify(control.getAttribute("data-kind"))}]` : ""}` };
          render();
        }
        return;
      }
      case "example-link": {
        const blockId = control.getAttribute("data-item") ?? "";
        void enqueue(() => followExample(index, blockId, control.getAttribute("data-example-id") as string));
        return;
      }
      case "result-link":
        void enqueue(() => { ui.menu = null; return dispatch({ type: "select", paneIndex: index, itemId: item }); });
        return;
      case "block-move":
        void enqueue(() => moveBlock(index, item, control.getAttribute("data-direction") === "up" ? "up" : "down"));
        return;
      case "no-target":
        return;
      default:
        void enqueue(() => { ui.roving = item; ui.menu = null; return dispatch({ type: "select", paneIndex: index, itemId: item }); });
    }
  }

  // ---- delegated listeners -------------------------------------------------------------------------------------------------------
  const onClick = (event: Event): void => {
    const control = controlOf(event.target);
    if (control !== null) activate(control);
  };

  function moveWithin(control: HTMLElement, name: string, key: string): boolean {
    const pane = control.closest('[data-pw="pane"]');
    if (pane === null) return false;
    const items = Array.from(pane.querySelectorAll<HTMLElement>(`[data-pw="${name}"]`));
    const at = items.indexOf(control);
    if (at < 0) return false;
    const to = key === "Home" ? 0 : key === "End" ? items.length - 1 : key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
    const next = items[to] as HTMLElement;
    for (const item of items) item.setAttribute("tabindex", item === next ? "0" : "-1");
    const index = paneOf(control);
    if (index !== null) uiOf(index).roving = next.getAttribute("data-id");
    next.focus();
    return true;
  }

  const onKeyDown = (event: Event): void => {
    const key = (event as KeyboardEvent).key;
    const target = event.target instanceof win.Element ? (event.target as HTMLElement) : null;
    if (target === null) return;
    if (key === "Escape") {
      const index = paneOf(target);
      const open = index !== null ? index : state.trail.findIndex((_, position) => uiOf(position).menu !== null);
      if (open !== null && open >= 0 && state.trail[open] !== undefined && uiOf(open).menu !== null) { event.preventDefault(); closeMenu(open); }
      return;
    }
    const field = target.tagName;
    if (field === "INPUT" || field === "SELECT" || field === "TEXTAREA") return;
    const control = controlOf(target);
    if (control === null) return;
    const name = control.getAttribute("data-pw") as string;
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      activate(control);
      return;
    }
    if (name === "tab" && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) {
      const tabs = Array.from((control.closest('[data-pw="view-tabs"]') as HTMLElement).querySelectorAll<HTMLElement>('[data-pw="tab"]'));
      const at = tabs.indexOf(control);
      const to = key === "Home" ? 0 : key === "End" ? tabs.length - 1 : key === "ArrowRight" ? (at + 1) % tabs.length : (at - 1 + tabs.length) % tabs.length;
      const next = tabs[to] as HTMLElement;
      const index = paneOf(control);
      if (index === null) return;
      event.preventDefault();
      pendingFocus = { pane: String(index), selector: `[data-pw="tab"][data-definition-id=${JSON.stringify(next.getAttribute("data-definition-id"))}]` };
      void enqueue(() => dispatch({ type: "switchView", paneIndex: index, viewDefinitionId: next.getAttribute("data-definition-id") as string }));
      return;
    }
    if (name === "menu-item" && ["ArrowDown", "ArrowUp"].includes(key)) {
      const items = Array.from((control.closest('[data-pw="actions-menu"]') as HTMLElement).querySelectorAll<HTMLElement>('[data-pw="menu-item"]'));
      const at = items.indexOf(control);
      event.preventDefault();
      items[key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length]?.focus();
      return;
    }
    if ((name === "row" || name === "node" || name === "field") && ["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) {
      if (moveWithin(control, name, key)) event.preventDefault();
      return;
    }
    if ((name === "node" || name === "field") && (key === "ArrowRight" || key === "ArrowLeft")) {
      const index = paneOf(control);
      const expanded = control.getAttribute("aria-expanded");
      if (index !== null && expanded !== null && ((key === "ArrowRight" && expanded === "false") || (key === "ArrowLeft" && expanded === "true"))) {
        event.preventDefault();
        uiOf(index).roving = control.getAttribute("data-id");
        pendingFocus = { pane: String(index), selector: `[data-pw="${name}"][data-id=${JSON.stringify(control.getAttribute("data-id"))}]` };
        uiOf(index).expanded.set(control.getAttribute("data-id") as string, key === "ArrowRight");
        render();
      }
    }
  };
  const onKeyUp = (event: Event): void => {
    // A button's click for Space fires on keyup; keydown already activated, so cancel the second activation.
    if ((event as KeyboardEvent).key === " " && controlOf(event.target) !== null) event.preventDefault();
  };

  const onInput = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (target === null) return;
    const index = paneOf(target);
    if (index === null || state.trail[index] === undefined) return;
    const ui = uiOf(index);
    const name = target.getAttribute("data-pw");
    if (name === "filter-input" && event.type === "input") {
      ui.filterText = (target as HTMLInputElement).value;
      render();
    } else if (name === "claim-filter" && event.type === "change") {
      ui.claimStatus = (target as HTMLSelectElement).value;
      render();
    } else if (name === "relation-filter") {
      const relation = target.getAttribute("data-id") as string;
      if ((target as HTMLInputElement).checked) ui.hiddenRelations.delete(relation); else ui.hiddenRelations.add(relation);
      render();
    }
  };

  const onPopState = (event: Event): void => {
    const saved = (event as PopStateEvent).state as { paneweft?: InspectorState } | null;
    if (saved?.paneweft === undefined) return;
    const restored = saved.paneweft;
    void enqueue(async () => {
      state = restored;
      activePane = null;
      lastError = null;
      await loadAll();
      render();
    });
  };

  container.addEventListener("click", onClick);
  container.addEventListener("keydown", onKeyDown);
  container.addEventListener("keyup", onKeyUp);
  container.addEventListener("input", onInput);
  container.addEventListener("change", onInput);
  win.addEventListener("popstate", onPopState);
  render();

  return {
    state: () => state,
    openEntity(entity, snapshotId, preferredViewDefinitionId) {
      return enqueue(async () => {
        entities.clear();
        rankings.clear();
        await dispatch({ type: "open", entity, snapshotId, ...(preferredViewDefinitionId === undefined ? {} : { viewDefinitionId: preferredViewDefinitionId }) });
      });
    },
    whenIdle,
    destroy() {
      destroyed = true;
      container.removeEventListener("click", onClick);
      container.removeEventListener("keydown", onKeyDown);
      container.removeEventListener("keyup", onKeyUp);
      container.removeEventListener("input", onInput);
      container.removeEventListener("change", onInput);
      win.removeEventListener("popstate", onPopState);
      container.replaceChildren();
    },
  };
}
