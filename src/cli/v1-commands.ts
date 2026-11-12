// The v1 CLI command table (spec section 6): kebab-case words mapped to the same handlers and errors as the MCP tools.
// RED PHASE: this table is NOT wired into main.ts yet (the v0 help and usage tests pin the existing surface); green merges it
// and amends those pins. The wiring is asserted by test/v1/surface.test.ts.
import type { V1ToolName } from "../v1/schemas.ts";

export interface V1Command {
  words: string[];
  tool: V1ToolName;
  /** flag -> argument name of the tool */
  flags: Record<string, string>;
  example: string;
}

export const V1_COMMANDS: readonly V1Command[] = [
  { words: ["types"], tool: "list_types", flags: { "--repo": "repo", "--language": "language", "--query": "query" }, example: "paneweft types --repo vigil" },
  { words: ["views"], tool: "list_views_for_type", flags: { "--repo": "repo", "--type": "type", "--target": "target" }, example: "paneweft views --repo vigil --type vigil::watch::WatchFile" },
  { words: ["examples"], tool: "list_examples", flags: { "--repo": "repo", "--type": "type", "--view": "view", "--tag": "tag" }, example: "paneweft examples --repo vigil --type vigil::watch::WatchFile" },
  { words: ["scaffold", "view"], tool: "scaffold_view", flags: { "--repo": "repo", "--type": "type", "--question": "question", "--component": "component" }, example: "paneweft scaffold view --repo vigil --type vigil::watch::WatchFile --question 'Which events survive?'" },
  { words: ["scaffold", "example"], tool: "scaffold_example", flags: { "--repo": "repo", "--type": "type", "--example": "example" }, example: "paneweft scaffold example --repo vigil --type vigil::watch::WatchFile" },
  { words: ["collect"], tool: "collect", flags: { "--request-id": "requestId", "--repo": "repo", "--adapter": "adapter", "--example": "examples" }, example: "paneweft collect --request-id r1 --repo vigil --adapter cargo --example watch.cancelled" },
  { words: ["collection", "status"], tool: "collection_status", flags: { "--wait-seconds": "waitSeconds", "--log-cursor": "logCursor" }, example: "paneweft collection status r1" },
  { words: ["collection", "cancel"], tool: "cancel_collection", flags: {}, example: "paneweft collection cancel r1" },
  { words: ["result"], tool: "view_result", flags: { "--run": "run", "--job": "job", "--view": "view", "--example": "example", "--observation": "observation" }, example: "paneweft result --run run-1 --view watch.events" },
  { words: ["failure"], tool: "explain_failure", flags: { "--evidence-page": "evidencePage" }, example: "paneweft failure diag-1" },
];

/** CLI-only commands that no MCP tool may mirror: registering an adapter and trusting a renderer digest are owner decisions. */
export const V1_OWNER_ONLY_COMMANDS: readonly string[][] = [["adapter", "add"], ["adapter", "list"], ["renderers", "trust"], ["renderers", "list"], ["catalogue", "refresh"]];
