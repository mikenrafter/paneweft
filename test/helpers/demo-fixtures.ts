// Demo fixtures (design section 6) and the independent oracles the demo suites share.
// Nothing here imports from src/ except types: the walkers below are written from the component
// shapes in design section 2 so they stay an oracle independent of the code under test.
import { loadFixture } from "./fixtures.ts";
import type { ReferenceContext } from "../../src/core/validate.ts";

export type AnyJson = Record<string, any>;

export const VIGIL_SNAPSHOT = "vigil-d064373";
export const RESIDUAL_SNAPSHOT = "residual-32c0836";
export const STORY_SNAPSHOT = "story-1";
export const STORY_VIEW_ID = "story-context-change";

export const vigilBundle = (): AnyJson => loadFixture("demos/vigil.bundle.json") as AnyJson;
export const residualBundle = (): AnyJson => loadFixture("demos/residual.bundle.json") as AnyJson;
export const storyBundle = (): AnyJson => loadFixture("demos/story.bundle.json") as AnyJson;

/** The nine demo views, pinned by name on purpose (an emptied fixture must break tests). */
export const DEMO_VIEWS = [
  { id: "vigil-lifecycle", snapshotId: VIGIL_SNAPSHOT, component: "graph", bundle: "vigil" },
  { id: "vigil-delivery-path", snapshotId: VIGIL_SNAPSHOT, component: "graph", bundle: "vigil" },
  { id: "vigil-one-write", snapshotId: VIGIL_SNAPSHOT, component: "example", bundle: "vigil" },
  { id: "vigil-cancel-guard", snapshotId: VIGIL_SNAPSHOT, component: "source", bundle: "vigil" },
  { id: "residual-view-entrypoints", snapshotId: RESIDUAL_SNAPSHOT, component: "list", bundle: "residual" },
  { id: "residual-selection-shape", snapshotId: RESIDUAL_SNAPSHOT, component: "shape", bundle: "residual" },
  { id: "residual-selection-switch", snapshotId: RESIDUAL_SNAPSHOT, component: "example", bundle: "residual" },
  { id: "residual-key-union", snapshotId: RESIDUAL_SNAPSHOT, component: "source", bundle: "residual" },
  { id: STORY_VIEW_ID, snapshotId: STORY_SNAPSHOT, component: "notebook", bundle: "story" },
] as const;
export type DemoView = (typeof DEMO_VIEWS)[number];

/** The six design-section-6 views the story page embeds, in the page's block order. */
export const SIX_EMBEDDED = [
  { block: "v1", viewId: "vigil-lifecycle", snapshotId: VIGIL_SNAPSHOT, component: "graph" },
  { block: "v2", viewId: "vigil-delivery-path", snapshotId: VIGIL_SNAPSHOT, component: "graph" },
  { block: "v3", viewId: "vigil-one-write", snapshotId: VIGIL_SNAPSHOT, component: "example" },
  { block: "r1", viewId: "residual-view-entrypoints", snapshotId: RESIDUAL_SNAPSHOT, component: "list" },
  { block: "r2", viewId: "residual-selection-shape", snapshotId: RESIDUAL_SNAPSHOT, component: "shape" },
  { block: "r3", viewId: "residual-selection-switch", snapshotId: RESIDUAL_SNAPSHOT, component: "example" },
] as const;

export function bundleOf(view: DemoView): AnyJson {
  return view.bundle === "vigil" ? vigilBundle() : view.bundle === "residual" ? residualBundle() : storyBundle();
}
export function viewOf(view: { id?: string; viewId?: string }): AnyJson {
  const id = view.id ?? view.viewId;
  for (const bundle of [vigilBundle(), residualBundle(), storyBundle()]) {
    const found = bundle.views.find((candidate: AnyJson) => candidate.id === id);
    if (found) return found;
  }
  throw new Error(`demo view ${String(id)} is not in any demo bundle`);
}

/**
 * Hand-derived expectations per demo view, written as literals (not computed from the fixtures):
 * `unit`/`total` follow red-contract section 3 (graph edges, list rows, shape fields, source lines, notebook
 * blocks, example runs); `items` is the number of Items counted by hand (contract addition A6); `sources` are
 * the source ids the items cite; `completeness` is the exact header line of red-contract section 3.
 */
export const DEMO_EXPECT: Record<string, { unit: string; total: number; items: number; sources: string[]; completeness: string }> = {
  "vigil-lifecycle": {
    unit: "edges", total: 10, items: 14, sources: ["s-watch", "s-engine", "s-tick"], // 4 nodes + 10 edges
    completeness: "completeness: partial (3 gaps; first: firing-rules: Which input changes make each fire rule (change, condition, judge) fire a tick?)",
  },
  "vigil-delivery-path": {
    unit: "edges", total: 11, items: 21, sources: ["s-mcp"], // 10 nodes + 11 edges
    completeness: "completeness: partial (2 gaps; first: delivery-bookkeeping: What does Vigil::commit_delivery record, and which failures can occur between the flush and the commit?)",
  },
  "vigil-one-write": {
    unit: "runs", total: 0, items: 1, sources: ["s-e2e"], // the scenario only; runs []
    completeness: "completeness: partial (2 gaps; first: observed-run-missing: Does one write after watch creation reach the first keepalive result in this checkout?)",
  },
  "vigil-cancel-guard": {
    unit: "lines", total: 31, items: 6, sources: ["s-mcp"], // lines 155..185 = 31 lines; excerpt + 5 annotations
    completeness: "completeness: complete (the cited lines 155-185 of src/mcp.rs, quoted verbatim; nothing outside them is claimed)",
  },
  "residual-view-entrypoints": {
    unit: "rows", total: 3, items: 3, sources: ["s-land"], // bundle, heatmap, regions
    completeness: "completeness: complete (the three declared LandscapeView choices bundle, heatmap and regions (web/src/nkp-landscape.ts:22-24); dynamic behavior and other UI panels are not claimed)",
  },
  "residual-selection-shape": {
    unit: "fields", total: 16, items: 16, sources: ["s-land", "s-sel"], // root, selected, active, module, key, 3 variants, detail, 5 detail fields, entityDetail, toggle
    completeness: "completeness: complete (the three variants of the EntityKey union declared at web/src/landscape-selection.ts:15 (component, force, attractor), with the selection state of mountLandscape and the EntityDetail type and functions named in the fields)",
  },
  "residual-selection-switch": {
    unit: "runs", total: 0, items: 1, sources: ["s-test"],
    completeness: "completeness: partial (2 gaps; first: observed-run-missing: Does a selection survive a view switch and a filter change in this checkout?)",
  },
  "residual-key-union": {
    unit: "lines", total: 15, items: 4, sources: ["s-sel"], // lines 1..15; excerpt + 3 annotations
    completeness: "completeness: complete (the cited lines 1-15 of web/src/landscape-selection.ts, quoted verbatim; nothing outside them is claimed)",
  },
  [STORY_VIEW_ID]: {
    unit: "blocks", total: 12, items: 12, sources: ["sv", "sv-e2e", "sr", "sd"], // the design's ten blocks + ex1 + ex2
    completeness: "completeness: partial (2 gaps; first: vigil-run-missing: Does the vigil one-write scenario pass in this checkout?)",
  },
};

/** Every Item of a view's data, per the component shapes of design section 2. */
export function itemsOfView(view: AnyJson): AnyJson[] {
  const data = view.data;
  switch (view.component) {
    case "graph": return [...data.nodes, ...data.edges];
    case "list": return [...data.rows];
    case "shape": return [...data.fields];
    case "source": return [data.excerpt, ...data.annotations];
    case "notebook": return [...data.blocks];
    case "example": return [data.scenario, ...data.runs, ...data.runs.flatMap((run: AnyJson) => run.assertions)];
    default: throw new Error(`unknown component ${String(view.component)}`);
  }
}
/** Item ids plus graph path ids: the one id namespace of a view (red-contract section 2, DUPLICATE_ID). */
export function idNamespaceOfView(view: AnyJson): string[] {
  const paths = view.component === "graph" ? (view.data.paths ?? []).map((path: AnyJson) => path.id) : [];
  return [...itemsOfView(view).map((item) => item.id as string), ...paths];
}

/** Context describing views that live outside the submitted document. */
export function referenceContext(views: readonly AnyJson[]): ReferenceContext {
  return {
    views: views.map((view) => ({ id: view.id, snapshotId: view.snapshotId, itemIds: itemsOfView(view).map((item) => item.id as string) })),
  };
}
/** All eight non-story demo views as the outside world of the story bundle. */
export function contextOfOtherEight(): ReferenceContext {
  return referenceContext([...vigilBundle().views, ...residualBundle().views]);
}

// ---- an independent semantic checker for the cheap rules of red-contract section 2 -------------

function checkItem(path: string, item: AnyJson, sourceIds: Set<string>, problems: string[]): void {
  if (!Array.isArray(item.evidence) || item.evidence.length === 0) problems.push(`${path}: evidence is empty`);
  for (const [index, id] of (item.evidence ?? []).entries()) {
    if (!sourceIds.has(id)) problems.push(`${path}/evidence/${index}: unknown source ${String(id)}`);
  }
  if (item.provenance !== "read") problems.push(`${path}: provenance is ${String(item.provenance)}, demos are source-inspected only`);
  if (item.anchor) {
    const [first, last] = item.anchor.lines;
    if (first > last) problems.push(`${path}/anchor/lines: reversed ${first}..${last}`);
  }
}

export interface OutsideViews { [viewId: string]: { snapshotId: string; itemIds: Set<string> } }

export function outsideViewsOf(bundles: readonly AnyJson[]): OutsideViews {
  const result: OutsideViews = {};
  for (const bundle of bundles) {
    for (const view of bundle.views) result[view.id] = { snapshotId: view.snapshotId, itemIds: new Set(idNamespaceOfView(view)) };
  }
  return result;
}

/** Returns human-readable problems; [] means every cheap rule holds. `known` maps every demo view id to its snapshot and item ids. */
export function checkBundleSemantics(bundle: AnyJson, known: OutsideViews): string[] {
  const problems: string[] = [];
  const entityKeys = new Set(bundle.entities.map((e: AnyJson) => `${e.repository}/${e.id}/${e.kind}/${e.snapshotId}`));
  const definitions = new Map<string, AnyJson>(bundle.definitions.map((d: AnyJson) => [d.id, d]));
  for (const [v, view] of bundle.views.entries() as IterableIterator<[number, AnyJson]>) {
    const base = `/views/${v}`;
    const sourceIds = new Set<string>((view.sources as AnyJson[]).map((s) => s.id));
    if (sourceIds.size !== view.sources.length) problems.push(`${base}/sources: duplicate source id`);

    // unique ids in one namespace
    const seen = new Set<string>();
    for (const id of idNamespaceOfView(view)) {
      if (seen.has(id)) problems.push(`${base}: duplicate id ${id}`);
      seen.add(id);
    }
    // entity and definition exist in the bundle, component agrees
    const entity = view.entity;
    if (!entityKeys.has(`${entity.repository}/${entity.id}/${entity.kind}/${view.snapshotId}`)) problems.push(`${base}/entity: not registered by the bundle`);
    const definition = definitions.get(view.viewDefinitionId);
    if (!definition) problems.push(`${base}/viewDefinitionId: unknown ${String(view.viewDefinitionId)}`);
    else if (definition.component !== view.component || definition.entityKind !== entity.kind) problems.push(`${base}: definition ${definition.id} disagrees with the view's component or entity kind`);

    // freshness: files equal the used source paths, hashes equal the sources' hashes
    for (const repo of view.freshness.repositories as AnyJson[]) {
      if (!view.scope.repositories.includes(repo.id)) problems.push(`${base}/freshness: repository ${repo.id} is not in scope.repositories`);
      if (!view.scope.roots.includes(repo.root)) problems.push(`${base}/freshness: root ${repo.root} is not in scope.roots`);
      const used = (view.sources as AnyJson[]).filter((s) => s.repository === repo.id && s.path !== undefined);
      const usedPaths = used.map((s) => s.path as string).sort();
      const recorded = Object.keys(repo.files).sort();
      if (JSON.stringify(usedPaths) !== JSON.stringify(recorded)) problems.push(`${base}/freshness/${repo.id}: files ${JSON.stringify(recorded)} differ from used sources ${JSON.stringify(usedPaths)}`);
      for (const s of used) if (repo.files[s.path] !== s.sha256) problems.push(`${base}/freshness/${repo.id}/${s.path}: hash differs from source ${s.id}`);
    }
    for (const repoId of view.scope.repositories as string[]) {
      if (!(view.freshness.repositories as AnyJson[]).some((r) => r.id === repoId)) problems.push(`${base}/scope: repository ${repoId} has no freshness entry`);
    }

    // every source is cited by at least one item (no orphan evidence)
    const cited = new Set<string>();
    const items = itemsOfView(view);
    for (const [i, item] of items.entries()) {
      checkItem(`${base}/item/${i}(${String(item.id)})`, item, sourceIds, problems);
      for (const id of item.evidence ?? []) cited.add(id);
      if (item.anchor) {
        const repo = (view.freshness.repositories as AnyJson[]).find((r) => r.id === item.anchor.repository);
        if (!repo) problems.push(`${base}/item/${item.id}/anchor: repository ${item.anchor.repository} not in freshness`);
        else if (!(item.anchor.path in repo.files)) problems.push(`${base}/item/${item.id}/anchor: ${item.anchor.path} has no recorded hash`);
      }
    }
    for (const id of sourceIds) if (!cited.has(id)) problems.push(`${base}: source ${id} is cited by no item`);

    // component rules
    const data = view.data;
    if (view.component === "graph") {
      const nodeIds = new Set<string>(data.nodes.map((n: AnyJson) => n.id));
      const edgeById = new Map<string, AnyJson>(data.edges.map((e: AnyJson) => [e.id, e]));
      for (const [i, edge] of data.edges.entries() as IterableIterator<[number, AnyJson]>) {
        if (!nodeIds.has(edge.from)) problems.push(`${base}/data/edges/${i}/from: unknown node ${edge.from}`);
        if (!nodeIds.has(edge.to)) problems.push(`${base}/data/edges/${i}/to: unknown node ${edge.to}`);
      }
      for (const [p, path] of (data.paths ?? []).entries() as IterableIterator<[number, AnyJson]>) {
        let previous: AnyJson | undefined;
        for (const [k, edgeId] of path.edgeIds.entries() as IterableIterator<[number, string]>) {
          const edge = edgeById.get(edgeId);
          if (!edge) { problems.push(`${base}/data/paths/${p}/edgeIds/${k}: unknown edge ${edgeId}`); previous = undefined; continue; }
          if (previous && previous.to !== edge.from) problems.push(`${base}/data/paths/${p}/edgeIds/${k}: starts at ${edge.from}, previous ended at ${previous.to}`);
          previous = edge;
        }
      }
      if (data.focus && !nodeIds.has(data.focus.node)) problems.push(`${base}/data/focus/node: unknown node`);
    } else if (view.component === "list") {
      const columnKeys = new Set<string>(data.columns.map((c: AnyJson) => c.key));
      if (!columnKeys.has(data.order.key)) problems.push(`${base}/data/order/key: unknown column ${data.order.key}`);
      for (const [i, row] of data.rows.entries() as IterableIterator<[number, AnyJson]>) {
        for (const key of Object.keys(row.cells)) if (!columnKeys.has(key)) problems.push(`${base}/data/rows/${i}/cells/${key}: unknown column`);
      }
    } else if (view.component === "shape") {
      const fieldIds = new Set<string>(data.fields.map((f: AnyJson) => f.id));
      if (!fieldIds.has(data.root)) problems.push(`${base}/data/root: unknown field`);
      const parents = new Map<string, number>();
      for (const [i, field] of data.fields.entries() as IterableIterator<[number, AnyJson]>) {
        for (const child of field.children as string[]) {
          if (!fieldIds.has(child)) problems.push(`${base}/data/fields/${i}/children: unknown field ${child}`);
          parents.set(child, (parents.get(child) ?? 0) + 1);
        }
        if (field.ref !== undefined && !fieldIds.has(field.ref)) problems.push(`${base}/data/fields/${i}/ref: unknown field ${field.ref}`);
      }
      for (const field of data.fields as AnyJson[]) {
        const count = parents.get(field.id) ?? 0;
        if (field.id === data.root ? count !== 0 : count !== 1) problems.push(`${base}/data/fields/${field.id}: has ${count} parents`);
      }
    } else if (view.component === "source") {
      const [first, last] = data.excerpt.anchor.lines as [number, number];
      if (first > last) problems.push(`${base}/data/excerpt/anchor/lines: reversed`);
      if (data.excerpt.text.split("\n").length !== last - first + 1) problems.push(`${base}/data/excerpt/text: ${data.excerpt.text.split("\n").length} lines for range ${first}-${last}`);
      for (const [i, annotation] of data.annotations.entries() as IterableIterator<[number, AnyJson]>) {
        const [a, z] = annotation.lines as [number, number];
        if (a > z) problems.push(`${base}/data/annotations/${i}/lines: reversed`);
        else if (a < first || z > last) problems.push(`${base}/data/annotations/${i}/lines: outside excerpt ${first}-${last}`);
      }
    } else if (view.component === "notebook") {
      for (const [i, block] of data.blocks.entries() as IterableIterator<[number, AnyJson]>) {
        if (block.kind === "view" && !(block.viewId in known)) problems.push(`${base}/data/blocks/${i}/viewId: unknown view ${block.viewId}`);
        if (block.kind === "example" && !(block.exampleId in known)) problems.push(`${base}/data/blocks/${i}/exampleId: unknown view ${block.exampleId}`);
        if (block.kind === "claim") {
          for (const key of ["supports", "contradicts"] as const) {
            for (const [k, target] of (block[key] as unknown[]).entries()) {
              if (typeof target === "string") {
                if (!sourceIds.has(target)) problems.push(`${base}/data/blocks/${i}/${key}/${k}: unknown source ${target}`);
              } else {
                const t = target as AnyJson;
                if (!known[t.viewId]?.itemIds.has(t.itemId)) problems.push(`${base}/data/blocks/${i}/${key}/${k}: unknown {viewId,itemId}`);
              }
            }
          }
        }
      }
    } else if (view.component === "example") {
      for (const run of data.runs as AnyJson[]) {
        if (run.status === "passed" && run.assertions.some((a: AnyJson) => a.passed === false)) problems.push(`${base}: passed run with a failed assertion`);
      }
    }

    // completeness
    const completeness = view.completeness;
    if (completeness.status === "partial") {
      const gapIds = (completeness.gaps ?? []).map((g: AnyJson) => g.id);
      if (gapIds.length === 0) problems.push(`${base}/completeness: partial without gaps`);
      if (new Set(gapIds).size !== gapIds.length) problems.push(`${base}/completeness: duplicate gap id`);
    } else if (completeness.status === "complete" && !completeness.criterion) problems.push(`${base}/completeness: complete without criterion`);

    // links
    const linkIds = new Set<string>();
    for (const [l, lnk] of (view.links as AnyJson[]).entries()) {
      if (linkIds.has(lnk.id)) problems.push(`${base}/links/${l}: duplicate link id`);
      linkIds.add(lnk.id);
      const target = known[lnk.viewId];
      if (!target) problems.push(`${base}/links/${l}/viewId: unknown view ${lnk.viewId}`);
      else {
        if (target.snapshotId !== lnk.snapshotId) problems.push(`${base}/links/${l}/snapshotId: ${lnk.snapshotId} is not the snapshot ${target.snapshotId} of ${lnk.viewId}`);
        if (lnk.itemId !== undefined && !target.itemIds.has(lnk.itemId)) problems.push(`${base}/links/${l}/itemId: ${lnk.itemId} is not in ${lnk.viewId}`);
      }
    }
  }
  return problems;
}
