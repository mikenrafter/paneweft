// Stdio MCP server over the official TypeScript SDK, pinned at @modelcontextprotocol/sdk 1.32.2
// (design section 5). Tool input schemas are the canonical src/schemas/tools/*.schema.json,
// dereferenced into self-contained JSON Schema; no hand-maintained Zod contract. Logs go to stderr;
// stdout carries protocol messages only.
//
// CLAIM(mcp-budget): the text of all content blocks plus any structuredContent together fit the
//   request's maxBytes [design section 4, "any repeated MCP content"; mcp.test.ts, MC3/MC11].
import type { Session } from "../core/session.ts";

/** STUB: resolves immediately without serving. Real implementation serves until stdin closes. */
export async function runMcpStdio(_sessionDir: string | null, _session: Session | null): Promise<void> {
  process.stderr.write("paneweft mcp: not implemented\n");
}
