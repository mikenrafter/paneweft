// Deterministic graph layout (design section 5: fixed layered or grid; no force simulation).
// docs/red-contract.md "Layout v1" is normative, including the edge-path rule.
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

/** STUB. */
export function computeGraphLayout(input: GraphLayoutInput): GraphLayout {
  return { version: "", layout: input.layout, width: 0, height: 0, nodes: [], edges: [] };
}

export interface GraphFocus { node: string; direction: "in" | "out" | "both"; depth: number }
/** Nodes reached within `depth` traversal steps, and the edges traversed to reach them. STUB. */
export function graphNeighborhood(_input: Pick<GraphLayoutInput, "nodes" | "edges">, _focus: GraphFocus): { nodeIds: string[]; edgeIds: string[] } {
  return { nodeIds: [], edgeIds: [] };
}
