// One tiny valid `data` payload per v0 component: the examples of design section 2, which `describe_component` returns so an agent
// can copy a shape that is known to validate. Each is the component's `data` body (the envelope around it is described by the
// envelope schema). src/core/operations.budget.test.ts validates every one against its component schema.
import type { ComponentId } from "../schemas/index.ts";

export const COMPONENT_EXAMPLES: Record<ComponentId, unknown> = {
  list: { columns: [{ key: "name", title: "Module", format: "text" }], rows: [{ id: "mcp", cells: { name: "mcp.rs" }, provenance: "read", evidence: ["s1"] }], order: { key: "name", direction: "asc" } },
  tree: {
    columns: [{ key: "name", title: "Name", format: "text" }],
    roots: ["r"],
    nodes: [
      { id: "r", cells: { name: "src" }, children: ["c"], childrenState: "complete", provenance: "read", evidence: ["s1"] },
      { id: "c", cells: { name: "mcp.rs" }, children: [], childrenState: "complete", provenance: "read", evidence: ["s1"] },
    ],
  },
  graph: {
    nodes: [{ id: "a", label: "MCP", provenance: "read", evidence: ["s1"] }, { id: "b", label: "Engine", provenance: "read", evidence: ["s1"] }],
    edges: [{ id: "e", from: "a", to: "b", relation: "invokes", provenance: "read", evidence: ["s1"] }],
    layout: "layered",
    paths: [{ id: "p", edgeIds: ["e"] }],
  },
  source: {
    excerpt: { id: "x", anchor: { repository: "r", path: "src/check.ts", lines: [4, 4] }, language: "typescript", text: "if (!allowed) return denied;", provenance: "read", evidence: ["s1"] },
    annotations: [{ id: "a", lines: [4, 4], message: "Denial branch", claimIds: ["C1"], provenance: "read", evidence: ["s1"] }],
  },
  shape: { basis: "declared", root: "f", fields: [{ id: "f", path: "watch_id", type: "string", presence: "required", children: [], provenance: "read", evidence: ["s1"] }] },
  notebook: {
    blocks: [
      { id: "b1", kind: "prose", markdown: "Why does cancellation preserve a result?", provenance: "read", evidence: ["s1"] },
      { id: "b2", kind: "view", viewId: "delivery-path", provenance: "read", evidence: ["s1"] },
    ],
  },
  example: { scenario: { id: "once", label: "One change fires", runnerId: "vigil-one-write", parameters: {}, provenance: "read", evidence: ["s1"] }, runs: [] },
};
