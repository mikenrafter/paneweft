// Stdio MCP server over the official TypeScript SDK, pinned at @modelcontextprotocol/sdk 1.32.2
// (design section 5). Tool input schemas are the canonical src/schemas/tools/*.schema.json,
// dereferenced into self-contained JSON Schema; no hand-maintained Zod contract. Logs go to stderr;
// stdout carries protocol messages only.
//
// CLAIM(mcp-budget): the text of all content blocks plus any structuredContent together fit the
//   request's maxBytes [design section 4, "any repeated MCP content"; mcp.test.ts, MC3/MC11].
//   Every result is exactly ONE text block holding the operation's body, and carries no structuredContent.
// CLAIM(mcp-is-an-adapter): arguments reach the shared validator unchanged (an argument error is an isError result with the
//   INVALID_ARGUMENT body, not a protocol error), so CLI and MCP answer one request with the same bytes [parity.test.ts, MC11].
// The low-level Server is used on purpose: the high-level McpServer wants a Zod schema per tool, which would be a second,
// hand-maintained contract. SDK major versions move these entry points (a 2.x split exists); this file is the only
// non-test importer of the SDK.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { executeOperation } from "../core/operations.ts";
import type { Session } from "../core/session.ts";
import { TOOL_NAMES, loadSchemaDocuments } from "../schemas/index.ts";

type Json = any;

/** Replaces every `$ref` by its target (urn:paneweft ids and local `#/...` pointers), so an advertised schema stands alone. */
function dereference(schema: Json, documents: Map<string, Json>, root: Json, seen: string[] = []): Json {
  if (Array.isArray(schema)) return schema.map((entry) => dereference(entry, documents, root, seen));
  if (schema === null || typeof schema !== "object") return schema;
  if (typeof schema.$ref === "string") {
    const [id, fragment = ""] = schema.$ref.split("#");
    const base = id === "" ? root : documents.get(id);
    if (base === undefined) throw new Error(`unresolvable $ref ${schema.$ref}`);
    if (seen.includes(schema.$ref)) throw new Error(`cyclic $ref ${schema.$ref}`);
    let target = base;
    for (const token of fragment.split("/").slice(1)) target = target[token.replace(/~1/g, "/").replace(/~0/g, "~")];
    const { $ref: _ref, ...siblings } = schema;
    return { ...dereference(target, documents, base, [...seen, schema.$ref]), ...dereference(siblings, documents, root, seen) };
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) if (key !== "$id" && key !== "$schema" && key !== "$defs") out[key] = dereference(value, documents, root, seen);
  return out;
}

export function toolDescriptors(): Array<{ name: string; description: string; inputSchema: Json }> {
  const documents = new Map(loadSchemaDocuments().map((entry) => [entry.id, entry.document as Json]));
  return TOOL_NAMES.map((name) => {
    const document = documents.get(`urn:paneweft:schema:tool:${name}:1`) as Json;
    const { title: _title, description, ...schema } = document;
    return { name, description: String(description), inputSchema: dereference({ $schema: "https://json-schema.org/draft/2020-12/schema", ...schema }, documents, document) };
  });
}

/** Serves until stdin closes (the client went away), then returns. */
export async function runMcpStdio(_sessionDir: string | null, session: Session | null): Promise<void> {
  const server = new Server({ name: "paneweft", version: "0.0.0" }, { capabilities: { tools: {} } });
  const tools = toolDescriptors();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const outcome = await executeOperation(session, request.params.name, request.params.arguments ?? {});
    return { content: [{ type: "text" as const, text: outcome.body }], isError: !outcome.ok };
  });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.once("end", () => resolve());
    process.stdin.once("close", () => resolve());
  });
  await server.connect(transport);
  await closed;
  await server.close().catch(() => {});
}
