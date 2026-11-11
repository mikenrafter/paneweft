// Deterministic graph layout (design section 5: fixed layered or grid; no force simulation).
// docs/red-contract.md "Layout v1" is normative, including the edge-path rule, as amended by round 2 (S6):
// every point of every route lies inside the canvas, self loops included.
//
// CLAIM(layout-deterministic): the output depends only on the SET of nodes and edges: nodes and edges are sorted by id (code-unit
//   order) before anything is computed, every number is an integer, there is no randomness and no iteration over hash order
//   [layout.test.ts shuffle property, MC9].
// CLAIM(layout-contained): nodes lie inside width x height and every route point lies inside the canvas; the left gutter used by
//   same-layer routes (x = node.x - 6 / - 12) fits inside the 16 px margin [layout.test.ts S6 fixture walk, geometry golden].
// Layering: strongly connected components are one group; a group's layer is 0 without incoming groups, else 1 + the deepest
// predecessor group; a self loop does not count. Edges between groups therefore always run to a deeper layer; only edges inside a
// group (same layer) and self loops need the special routes below.
export const LAYOUT_VERSION = "layout/1";
export const LAYOUT_V1 = { nodeWidth: 160, nodeHeight: 40, gapX: 80, gapY: 24, margin: 16 } as const;

export interface GraphLayoutInput {
  nodes: Array<{ id: string }>;
  edges: Array<{ id: string; from: string; to: string }>;
  layout: "layered" | "grid";
}
export interface GraphLayout {
  version: string;
  layout: "layered" | "grid";
  width: number;
  height: number;
  nodes: Array<{ id: string; x: number; y: number; layer: number; row: number }>;
  edges: Array<{ id: string; d: string }>;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const { nodeWidth, nodeHeight, gapX, gapY, margin } = LAYOUT_V1;

/** Tarjan's strongly connected components, iterative (graphs are bounded at 200 nodes, but nothing here recurses). */
function stronglyConnectedGroups(ids: string[], successors: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];
  let counter = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    const work: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    index.set(root, counter); low.set(root, counter); counter++;
    stack.push(root); onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { id: string; next: number };
      const out = successors.get(frame.id) ?? [];
      if (frame.next < out.length) {
        const to = out[frame.next++] as string;
        if (!index.has(to)) {
          index.set(to, counter); low.set(to, counter); counter++;
          stack.push(to); onStack.add(to);
          work.push({ id: to, next: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.id, Math.min(low.get(frame.id) as number, index.get(to) as number));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) low.set(parent.id, Math.min(low.get(parent.id) as number, low.get(frame.id) as number));
      if (low.get(frame.id) === index.get(frame.id)) {
        const group: string[] = [];
        for (;;) {
          const member = stack.pop() as string;
          onStack.delete(member);
          group.push(member);
          if (member === frame.id) break;
        }
        groups.push(group.sort(byCodeUnit));
      }
    }
  }
  return groups;
}

export function computeGraphLayout(input: GraphLayoutInput): GraphLayout {
  const ids = [...new Set(input.nodes.map((node) => node.id))].sort(byCodeUnit);
  const known = new Set(ids);
  const edges = [...input.edges].filter((edge) => known.has(edge.from) && known.has(edge.to)).sort((a, b) => byCodeUnit(a.id, b.id));
  const placement = new Map<string, { layer: number; row: number }>();

  if (input.layout === "grid") {
    const columns = Math.ceil(Math.sqrt(ids.length));
    ids.forEach((id, position) => placement.set(id, { layer: position % columns, row: Math.floor(position / columns) }));
  } else {
    const successors = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const edge of edges) successors.get(edge.from)?.push(edge.to);
    const groups = stronglyConnectedGroups(ids, successors);
    const groupOf = new Map<string, number>();
    groups.forEach((group, position) => group.forEach((id) => groupOf.set(id, position)));
    const incoming = new Map<number, Set<number>>(groups.map((_, position) => [position, new Set<number>()]));
    for (const edge of edges) {
      const from = groupOf.get(edge.from) as number;
      const to = groupOf.get(edge.to) as number;
      if (from !== to) incoming.get(to)?.add(from);
    }
    const layerOfGroup = new Map<number, number>();
    const resolve = (start: number): number => {
      // longest path over the condensation, memoised and iterative
      const pending: number[] = [start];
      while (pending.length > 0) {
        const group = pending[pending.length - 1] as number;
        if (layerOfGroup.has(group)) { pending.pop(); continue; }
        const predecessors = [...(incoming.get(group) as Set<number>)];
        const missing = predecessors.filter((predecessor) => !layerOfGroup.has(predecessor));
        if (missing.length > 0) { pending.push(...missing); continue; }
        layerOfGroup.set(group, predecessors.length === 0 ? 0 : 1 + Math.max(...predecessors.map((predecessor) => layerOfGroup.get(predecessor) as number)));
        pending.pop();
      }
      return layerOfGroup.get(start) as number;
    };
    groups.forEach((_, position) => resolve(position));
    const byLayer = new Map<number, number[]>();
    groups.forEach((_, position) => {
      const layer = layerOfGroup.get(position) as number;
      byLayer.set(layer, [...(byLayer.get(layer) ?? []), position]);
    });
    for (const [layer, members] of byLayer) {
      members.sort((a, b) => byCodeUnit((groups[a] as string[])[0] as string, (groups[b] as string[])[0] as string));
      let row = 0;
      for (const group of members) for (const id of groups[group] as string[]) placement.set(id, { layer, row: row++ });
    }
  }

  const maxLayer = Math.max(-1, ...[...placement.values()].map((entry) => entry.layer));
  const rowsInLayer = new Map<number, number>();
  for (const { layer } of placement.values()) rowsInLayer.set(layer, (rowsInLayer.get(layer) ?? 0) + 1);
  const maxRows = Math.max(0, ...rowsInLayer.values());
  const width = ids.length === 0 ? 2 * margin : 2 * margin + (maxLayer + 1) * nodeWidth + maxLayer * gapX;
  const height = ids.length === 0 ? 2 * margin : 2 * margin + maxRows * nodeHeight + (maxRows - 1) * gapY;

  const nodes = ids.map((id) => {
    const { layer, row } = placement.get(id) as { layer: number; row: number };
    return { id, x: margin + layer * (nodeWidth + gapX), y: margin + row * (nodeHeight + gapY), layer, row };
  });
  const at = new Map(nodes.map((node) => [node.id, node]));

  const route = (edge: { from: string; to: string }): string => {
    const from = at.get(edge.from) as (typeof nodes)[number];
    const to = at.get(edge.to) as (typeof nodes)[number];
    if (edge.from === edge.to) {
      // contained U below the node (S6): leaves and re-enters the bottom side, 12 px below it
      return `M ${from.x + 100} ${from.y + 40} L ${from.x + 100} ${from.y + 52} L ${from.x + 60} ${from.y + 52} L ${from.x + 60} ${from.y + 40}`;
    }
    if (input.layout === "grid") return `M ${from.x + 80} ${from.y + 20} L ${to.x + 80} ${to.y + 20}`;
    if (from.layer < to.layer) return `M ${from.x + nodeWidth} ${from.y + 20} L ${to.x} ${to.y + 20}`;
    // same layer (a member of the same strongly connected group): through the left gutter, 6 px out going down, 12 px going up
    const gutter = from.x - (to.y > from.y ? 6 : 12);
    return `M ${from.x} ${from.y + 20} L ${gutter} ${from.y + 20} L ${gutter} ${to.y + 20} L ${to.x} ${to.y + 20}`;
  };

  return {
    version: LAYOUT_VERSION,
    layout: input.layout,
    width,
    height,
    nodes,
    edges: edges.map((edge) => ({ id: edge.id, d: route(edge) })),
  };
}

export interface GraphFocus { node: string; direction: "in" | "out" | "both"; depth: number }
/**
 * Nodes reached within `depth` traversal steps, and the edges traversed to reach them: every edge examined from a node expanded at
 * a distance below `depth`, in an allowed direction (so an edge that closes onto an already visited node is included).
 * An unknown focus gives empty sets. Both lists are sorted by code-unit id.
 */
export function graphNeighborhood(input: Pick<GraphLayoutInput, "nodes" | "edges">, focus: GraphFocus): { nodeIds: string[]; edgeIds: string[] } {
  const known = new Set(input.nodes.map((node) => node.id));
  if (!known.has(focus.node)) return { nodeIds: [], edgeIds: [] };
  const edges = input.edges.filter((edge) => known.has(edge.from) && known.has(edge.to));
  const distance = new Map<string, number>([[focus.node, 0]]);
  const traversed = new Set<string>();
  let frontier = [focus.node];
  for (let level = 0; level < focus.depth && frontier.length > 0; level++) {
    const next: string[] = [];
    const current = new Set(frontier);
    for (const edge of edges) {
      if (focus.direction !== "in" && current.has(edge.from)) {
        traversed.add(edge.id);
        if (!distance.has(edge.to)) { distance.set(edge.to, level + 1); next.push(edge.to); }
      }
      if (focus.direction !== "out" && current.has(edge.to)) {
        traversed.add(edge.id);
        if (!distance.has(edge.from)) { distance.set(edge.from, level + 1); next.push(edge.from); }
      }
    }
    frontier = next;
  }
  return { nodeIds: [...distance.keys()].sort(byCodeUnit), edgeIds: [...traversed].sort(byCodeUnit) };
}
