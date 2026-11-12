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
import { createSessionJobService } from "../v1/service.ts";
import { V1_TOOL_NAMES } from "../v1/schemas.ts";
import { executeV1Operation, v1ToolDescriptors } from "../v1/tools.ts";
import { resolve } from "node:path";
import { dereference } from "../schemas/dereference.ts";
import { TOOL_NAMES, loadSchemaDocuments } from "../schemas/index.ts";

type Json = any;

export function toolDescriptors(): Array<{ name: string; description: string; inputSchema: Json; annotations?: { readOnlyHint: boolean } }> {
  const documents = new Map(loadSchemaDocuments().map((entry) => [entry.id, entry.document as Json]));
  return TOOL_NAMES.map((name) => {
    const document = documents.get(`urn:paneweft:schema:tool:${name}:1`) as Json;
    const { title: _title, description, ...schema } = document;
    return { name, description: String(description), inputSchema: dereference({ $schema: "https://json-schema.org/draft/2020-12/schema", ...schema }, documents, document) };
  });
}

/**
 * Shown to the model by MCP clients (the initialize result's `instructions`): the workflow and the paging rule are the two things a tool list cannot
 * say. Every snake_case name here must be an advertised tool (instructions.test.ts).
 */
export const INSTRUCTIONS = [
  "paneweft turns facts you give it into validated, immutable view snapshots and answers in bounded text.",
  "Workflow: list_components (pick the component that answers your question), describe_component (its schema, limits and a valid example to copy),",
  "validate (stores nothing; fix each error at its JSON pointer using its hint), render (validates and stores; a stored view never changes, so changed",
  "content needs a new snapshotId), then inspect_view, open_entity, navigate and search to read it back. notebook_create, notebook_get and notebook_update",
  "keep an investigation page: pass the revision you read as expectedRevision.",
  "Every reply fits maxBytes (default 8192, between 2048 and 32768) and opens with a header saying what is complete, fresh and left out.",
  "When a reply ends with a cursor, repeat the SAME request with that cursor to get the next page; a different request needs a new cursor-free call.",
  "Freshness stays unverified until the session owner registers the repository root; no tool reads outside registered roots.",
  "For code with an SDK: list_types, list_views_for_type, list_examples read the catalogue (stale means unproven), scaffold_view prints a patch (writes nothing; you edit),",
  "collect runs exact example ids through an owner-registered adapter (the one tool that runs code), then collection_status, view_result, explain_failure.",
  "No SDK, a read-only repo or a one-off question: the JSON fallback above.",
].join(" ");

/** Serves until stdin closes (the client went away), then returns. The v1 tools read adapters, catalogues and jobs from the session directory. */
export async function runMcpStdio(session: Session | null): Promise<void> {
  const server = new Server({ name: "paneweft", version: "0.0.0" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const tools = [...toolDescriptors(), ...v1ToolDescriptors()];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  const v1 = async () => {
    if (session === null) return { session: null, sessionDir: null, jobs: null };
    const sessionDir = resolve(session.dir);
    const jobs = await createSessionJobService(session, sessionDir);
    return { session, sessionDir, jobs };
  };
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if ((V1_TOOL_NAMES as readonly string[]).includes(request.params.name)) {
      const outcome = await executeV1Operation(await v1(), request.params.name, request.params.arguments ?? {});
      return { content: [{ type: "text" as const, text: outcome.body }], isError: !outcome.ok };
    }
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
