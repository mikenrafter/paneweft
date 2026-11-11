// A demo-shaped notebook page (design section 6: "What survives a change of context?", claims D1/D2/D3),
// written out as a literal envelope. It references views and items that exist after importing
// fixtures/components/all.bundle.json (delivery-path/e, modules/mcp, layout, vigil-one-write/once), so the
// page is valid whether or not the implementation checks block targets against the session.
import type { Envelope } from "../../src/core/wire.ts";

const HELLO = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"; // sha256("hello\n")
const RESIDUAL_TEST = "d1f9db2be5dffa209793da697ea7c971f4ed07d90a1ab9a15c3ce57f0d5ecd8b"; // design 6 table
const DESIGN = "d130a8070810e4e9e9b0881c45490aa8ea6d1ad63136d07c7230b170f3aadd3d"; // sha256sum docs/design.md on the authoring host

export const PAGE_ID = "context-survival";
export const NOTEBOOK_BLOCK_IDS = ["intro", "v1", "v2", "D1", "r1", "D2", "ex1", "D3"] as const;

export function demoNotebook(): Envelope {
  const source = (id: string, path: string, sha256: string, kind: "file" | "document" = "file") =>
    ({ id, kind, repository: "r", path, sha256, capturedAt: "2026-11-11T00:00:00Z", method: "read" }) as const;
  return {
    schemaVersion: "paneweft.view/1",
    id: PAGE_ID,
    title: "What survives a change of context?",
    question: "Does changing the caller's context lose a result or a selection?",
    entity: { repository: "r", id: "notes", kind: "notes/page" },
    snapshotId: "snap-1",
    component: "notebook",
    viewDefinitionId: "def-story",
    scope: { repositories: ["r"], roots: ["/work/r"], excludes: [], limits: ["fixture"] },
    sources: [
      source("sv", "src/mcp.rs", HELLO),
      source("sr", "web/src/nkp-landscape.test.ts", RESIDUAL_TEST),
      source("sd", "docs/design.md", DESIGN, "document"),
    ],
    generatedAt: "2026-11-11T00:00:00Z",
    freshness: {
      repositories: [{
        id: "r", root: "/work/r", gitRev: null, dirty: false,
        files: { "src/mcp.rs": HELLO, "web/src/nkp-landscape.test.ts": RESIDUAL_TEST, "docs/design.md": DESIGN },
      }],
    },
    links: [],
    completeness: {
      status: "partial",
      gaps: [{ id: "g-runs", question: "Does this checkout satisfy both runnable scenarios?", reason: "No observed run has been recorded." }],
    },
    data: {
      blocks: [
        { id: "intro", kind: "prose", markdown: "What survives a change of context?", provenance: "read", evidence: ["sd"] },
        { id: "v1", kind: "view", viewId: "delivery-path", provenance: "read", evidence: ["sv"] },
        { id: "v2", kind: "view", viewId: "modules", provenance: "read", evidence: ["sv"] },
        {
          id: "D1", kind: "claim", statement: "The MCP wrapper checks cancellation before committing delivery.", status: "supported",
          supports: ["sv", { viewId: "delivery-path", itemId: "e" }], contradicts: [], provenance: "read", evidence: ["sv"],
        },
        { id: "r1", kind: "view", viewId: "layout", provenance: "read", evidence: ["sr"] },
        {
          id: "D2", kind: "claim", statement: "The tests specify selection persistence across view and filter changes.", status: "supported",
          supports: ["sr"], contradicts: [], provenance: "read", evidence: ["sr"],
        },
        { id: "ex1", kind: "example", exampleId: "once", provenance: "read", evidence: ["sr"] },
        {
          id: "D3", kind: "claim", statement: "Does this checkout satisfy both runnable scenarios?", status: "open",
          supports: [], contradicts: [], provenance: "read", evidence: ["sd"],
        },
      ],
    },
  };
}

export type Block = Record<string, any>;
export function demoBlocks(): Block[] {
  return structuredClone((demoNotebook().data as { blocks: Block[] }).blocks);
}
