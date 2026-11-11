// The stdio MCP server, driven by a real MCP client (SDK 1.32.2) and by a raw JSON-RPC child process.
// Claims: MC11 (tools/list matches the canonical contract; errors map to isError), MC3 (one text block, no
// structuredContent, bytes within maxBytes, a clean stdout), MC17 (no tool executes a runner; a payload cannot name one).
// Placement: co-located with src/mcp/server.ts.
// SDK facts relied on (checked in node_modules): Client.listTools() -> { tools: [{name, description, inputSchema}] };
//   Client.callTool({name, arguments}) -> { content: [{type:'text', text}], isError?, structuredContent? } and REJECTS with
//   McpError on protocol errors; the stdio transport frames messages as one JSON per line; the server echoes the client's
//   protocolVersion when supported (2025-03-26 is in SUPPORTED_PROTOCOL_VERSIONS).
// Tool schema expectations are a LITERAL table written from design 5 and src/schemas/tools/*.schema.json read once; no
// canonical schema is imported to build an expectation, except as the second validator of the equivalence claim.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSession } from "../core/session.ts";
import { createSchemaRegistry } from "../schemas/index.ts";
import { connectMcp } from "../../test/helpers/mcp-client.ts";
import { must } from "../../test/helpers/must.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { callTool, sharedMcp, spawnRawMcp } from "../../test/helpers/wire-mcp.ts";
import { compileRaw, unresolvedRefs } from "../../test/helpers/wire-schema.ts";
import {
  TOOL_NAMES_LITERAL, issuePairs, lazyShared, parseBody, seedClosed, sharedTempDirs, wireJson, wireText, type ToolNameLiteral,
} from "../../test/helpers/wire-session.ts";

const dirs = sharedTempDirs();
const makeTemp = useTempDirs();
const readDir = lazyShared(() => seedClosed(dirs("mcp-read"), { extraViews: ["view-wide-list.json"] }));
const mcp = sharedMcp(readDir);

const WATCH = { repository: "r", id: "watch", kind: "vigil/watch" };

/** Per tool: required property names and all property names (sorted), then vectors both validators must judge alike. */
const TABLE: Record<ToolNameLiteral, { required: string[]; properties: string[]; valid: unknown[]; invalid: unknown[] }> = {
  list_components: {
    required: [], properties: ["capability", "cursor", "format", "maxBytes"],
    valid: [{}, { capability: "x", format: "json", maxBytes: 2048, cursor: "c" }],
    invalid: [{ capability: "" }, { unknown: 1 }],
  },
  describe_component: {
    required: ["component"], properties: ["component", "cursor", "format", "maxBytes"],
    valid: [{ component: "graph" }, { component: "list", maxBytes: 32768 }],
    invalid: [{ component: "heatmap" }, {}],
  },
  validate: {
    required: ["input"], properties: ["format", "input", "maxBytes"],
    valid: [{ input: {} }],
    invalid: [{ input: "x" }, { input: {}, maxBytes: 1 }],
  },
  register_view: {
    required: ["definition", "expectedRevision"], properties: ["definition", "expectedRevision", "format", "maxBytes"],
    valid: [{ definition: {}, expectedRevision: 0 }],
    invalid: [{ definition: {}, expectedRevision: -1 }, { definition: {} }],
  },
  render: {
    required: ["input"], properties: ["format", "input", "maxBytes"],
    valid: [{ input: {} }, { input: { a: 1 }, format: "json", maxBytes: 2048 }, { input: {}, format: "text", maxBytes: 32768 }],
    invalid: [{}, { input: {}, maxBytes: 2047 }, { input: {}, maxBytes: 32769 }, { input: {}, format: "yaml" }, { input: [] }, { input: {}, extra: true }],
  },
  open_entity: {
    required: ["entity", "snapshotId"], properties: ["cursor", "entity", "format", "maxBytes", "preferredViewDefinitionId", "snapshotId"],
    valid: [
      { snapshotId: "snap-1", entity: WATCH },
      { snapshotId: "snap-1", entity: WATCH, preferredViewDefinitionId: "def-modules", format: "json" },
      { snapshotId: "s", entity: { repository: "r", id: "m", kind: "code/module" }, cursor: "c", maxBytes: 4096 },
    ],
    invalid: [
      { snapshotId: "s", entity: { repository: "r", id: "m" } },
      { snapshotId: "s", entity: { repository: "r", id: "m", kind: "Bad Kind" } },
      { snapshotId: "s", entity: WATCH, preferredViewDefinitionId: "" },
      { entity: WATCH },
      { snapshotId: "s", entity: { ...WATCH, extra: 1 } },
    ],
  },
  navigate: {
    required: ["itemId", "pane"], properties: ["action", "format", "itemId", "maxBytes", "pane"],
    valid: [{ pane: {}, itemId: "i" }, { pane: { a: 1 }, itemId: "i", action: "open-source" }],
    invalid: [{ pane: {}, itemId: "i", action: "open-shell" }, { pane: {} }],
  },
  inspect_view: {
    required: ["snapshotId", "viewId"],
    properties: ["cursor", "embedDepth", "filter", "focus", "format", "maxBytes", "order", "snapshotId", "viewId"],
    valid: [
      { viewId: "v", snapshotId: "s" },
      {
        viewId: "v", snapshotId: "s",
        filter: { text: "x", columns: { k: 1, j: "s", n: null }, provenance: ["read", "inferred"], relation: ["calls"], status: ["open", "supported"] },
        order: { key: "name", direction: "desc" }, focus: { itemId: "i", expand: true }, embedDepth: 1, cursor: "c", format: "json", maxBytes: 2048,
      },
      { viewId: "v", snapshotId: "s", embedDepth: 0, focus: { itemId: "i" } },
    ],
    invalid: [
      { viewId: "v", snapshotId: "s", embedDepth: 2 },
      { viewId: "v", snapshotId: "s", filter: { provenance: ["guess"] } },
      { viewId: "v" },
      { viewId: "v", snapshotId: "s", filter: { regex: "x" } },
      { viewId: "v", snapshotId: "s", order: { key: "k", direction: "sideways" } },
      { viewId: "", snapshotId: "s" },
    ],
  },
  search: {
    required: ["query"], properties: ["cursor", "format", "maxBytes", "query", "scope"],
    valid: [
      { query: "cancel" },
      { query: "c", scope: { entity: WATCH, snapshotId: "snap-1" } },
      { query: "x".repeat(256) },
    ],
    invalid: [
      {},
      { query: "" },
      { query: "x".repeat(257) },
      { query: "c", scope: { entity: WATCH } },
      { query: "c", scope: { entity: { repository: "r", id: "w", kind: "Bad Kind" }, snapshotId: "s" } },
    ],
  },
  notebook_create: {
    required: ["input"], properties: ["format", "input", "maxBytes"],
    valid: [{ input: {} }],
    invalid: [{}, { input: {}, maxBytes: 1 }],
  },
  notebook_get: {
    required: ["pageId"], properties: ["cursor", "format", "maxBytes", "pageId", "revision"],
    valid: [{ pageId: "p" }, { pageId: "p", revision: 2 }],
    invalid: [{ pageId: "p", revision: 0 }, { revision: 1 }],
  },
  notebook_update: {
    required: ["blocks", "expectedRevision", "pageId"], properties: ["blocks", "expectedRevision", "format", "maxBytes", "pageId", "sources"],
    valid: [{ pageId: "p", expectedRevision: 1, blocks: [] }, { pageId: "p", expectedRevision: 3, blocks: [{ a: 1 }], sources: [{}] }],
    invalid: [{ pageId: "p", expectedRevision: 0, blocks: [] }, { pageId: "p", expectedRevision: 1, blocks: {} }, { pageId: "p", expectedRevision: 1 }],
  },
  example_record: {
    required: ["output", "snapshotId", "viewId"], properties: ["format", "maxBytes", "output", "snapshotId", "viewId"],
    valid: [{ viewId: "v", snapshotId: "s", output: {} }],
    invalid: [{ viewId: "v", snapshotId: "s", output: "x" }, { viewId: "v", snapshotId: "s", output: {}, argv: ["sh"] }],
  },
};

describe("mcp: tools/list matches the contract (MC11, MC17)", () => {
  // why: the advertised surface is exactly the design 5 table: thirteen short stable names, no more (a fourteenth, e.g. a
  //      runner, would be an unreviewed capability) and no fewer. Sorted comparison pins the SET, not the order.
  // proves: CLAIM(MC11), CLAIM(MC17)
  it("[MC11] tools/list names are exactly the thirteen of design section 5", async () => {
    const names = (await (await mcp()).listTools()).map((tool) => tool.name).sort();
    expect(names).toEqual([...TOOL_NAMES_LITERAL].sort());
    expect(names).toHaveLength(13);
  });

  // why: each tool is described for an agent, declares an object input with additionalProperties false (so a payload cannot
  //      smuggle fields such as argv), and takes exactly the required/known property names of the canonical contract.
  //      The table above is the literal derivation; emptying the tools list cannot pass because rows are pinned by name.
  // proves: CLAIM(MC11)
  describe.each(TOOL_NAMES_LITERAL)("tool %s", (name) => {
    it("[MC11] has a description, an object inputSchema with additionalProperties false, and the literal required/property names", async () => {
      const tool = (await (await mcp()).listTools()).find((candidate) => candidate.name === name);
      expect(tool, `tool ${name} is listed`).toBeDefined();
      expect(typeof tool!.description === "string" && tool!.description.trim().length > 0, "non-empty description").toBe(true);
      expect(tool!.inputSchema.type).toBe("object");
      expect(tool!.inputSchema.additionalProperties).toBe(false);
      expect([...(tool!.inputSchema.required ?? [])].sort()).toEqual(TABLE[name].required);
      expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual(TABLE[name].properties);
    });

    // why: the advertised schema must be usable by a client that has never seen urn:paneweft:schema:* (self-contained: every $ref
    //      resolves inside the document) AND must judge inputs like the canonical schema. Both are compiled with raw Ajv 2020 and
    //      shown the same literal vectors. The canonical verdicts are asserted too, so a wrong vector cannot hide behind agreement.
    // proves: CLAIM(MC11)
    it("[MC11] its advertised inputSchema is self-contained and accepts/rejects the same literal vectors as the canonical schema", async () => {
      const walkerControl = unresolvedRefs({ properties: { a: { $ref: "urn:paneweft:schema:common:1#/$defs/Id" }, b: { $ref: "#/$defs/Missing" }, c: { $ref: "#/$defs/Ok" } }, $defs: { Ok: {} } });
      expect(walkerControl.map((entry) => entry.ref).sort(), "control: the walker flags urn and dangling refs, not local ones").toEqual(["#/$defs/Missing", "urn:paneweft:schema:common:1#/$defs/Id"]);

      const tool = (await (await mcp()).listTools()).find((candidate) => candidate.name === name);
      expect(tool, `tool ${name} is listed`).toBeDefined();
      expect(unresolvedRefs(tool!.inputSchema), "$ref values that leave the document").toEqual([]);
      const advertised = compileRaw(tool!.inputSchema);
      const canonical = createSchemaRegistry().getSchema(`urn:paneweft:schema:tool:${name}:1`)!;
      const { valid, invalid } = TABLE[name];
      for (const vector of valid) {
        expect(canonical(vector), `canonical accepts ${JSON.stringify(vector).slice(0, 120)}`).toBe(true);
        expect(advertised(vector), `advertised accepts ${JSON.stringify(vector).slice(0, 120)}: ${JSON.stringify(advertised.errors)}`).toBe(true);
      }
      for (const vector of invalid) {
        expect(canonical(vector), `canonical rejects ${JSON.stringify(vector).slice(0, 120)}`).toBe(false);
        expect(advertised(vector), `advertised rejects ${JSON.stringify(vector).slice(0, 120)}`).toBe(false);
      }
    });
  });

  // why: MC17 "no tool implies executing a runner" looked at from the surface: no name and no description (once sentences that
  //      deny execution, such as "Never executes anything.", are set aside) uses an execution verb. The screen is shown to
  //      flag bad examples first, so it cannot pass vacuously.
  // proves: CLAIM(MC17)
  it("[MC17] no tool name or description implies running a runner or executing anything", async () => {
    const badName = /(^|_)(run|runs|exec|execute|shell|spawn|rerun|install)(_|$)/;
    const badText = /\b(runs|executes|launches|spawns|invokes|rerun|reruns|installs)\b|\bshell\b|\brunner\b/i;
    const affirmative = (description: string) => description.split(/(?<=[.!?])\s+/).filter((sentence) => !/\b(never|not|no)\b/i.test(sentence)).join(" ");
    expect(["example_run", "run_example", "exec", "install_runner"].every((name) => badName.test(name)), "control: names").toBe(true);
    expect(["Runs a runner by id.", "Executes argv in a shell.", "Rerun the scenario."].every((text) => badText.test(affirmative(text))), "control: texts").toBe(true);
    expect(badText.test(affirmative("Record one run of a scenario. Never executes anything."))).toBe(false);

    const tools = await (await mcp()).listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES_LITERAL].sort());
    for (const tool of tools) {
      expect(badName.test(tool.name), `name ${tool.name}`).toBe(false);
      expect(badText.test(affirmative(tool.description ?? "")), `description of ${tool.name}`).toBe(false);
    }
  });
});

describe("mcp: tool results (MC11, MC3)", () => {
  // why: success is isError false with ONE text block and NO structuredContent (red-contract 3), because any repeated content
  //      would double the bytes against the same maxBytes. The body is the reply.
  // proves: CLAIM(MC3)
  it("[MC3] a successful call returns exactly one text block, isError false and no structuredContent", async () => {
    const result = await callTool(await mcp(), "inspect_view", wireJson("inspect-list-filter.json"));
    expect(result.isError).toBe(false);
    expect(result.blocks).toBe(1);
    expect((result.raw as any).content[0].type).toBe("text");
    expect((result.raw as any).structuredContent).toBeUndefined();
    expect(result.text.startsWith("paneweft.reply/1 view=modules component=list")).toBe(true);
  });

  // why: an operation error is isError true with the error body as the single text block (design 4, red-contract 2), never a
  //      protocol error, so the agent reads code and pointers like any reply.
  // proves: CLAIM(MC11)
  it("[MC11] an operation error is isError true with the paneweft.error/1 body as one text block, no structuredContent", async () => {
    const result = await callTool(await mcp(), "validate", wireJson("validate-graph-string-depth.json"));
    expect(result.isError).toBe(true);
    expect(result.blocks).toBe(1);
    expect((result.raw as any).structuredContent).toBeUndefined();
    const body = parseBody(result.text, "text");
    expect(body.schemaVersion).toBe("paneweft.error/1");
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(issuePairs(body)).toEqual([["TYPE", "/data/focus/depth"]]);
  });

  // why: arguments that violate the advertised schema reach the shared validator and come back as INVALID_ARGUMENT (MCP-1), the
  //      same code the CLI gives, instead of an SDK protocol error that would hide the pointers.
  // proves: CLAIM(MC11)
  it("[MC11] a call violating the schema (maxBytes 40000) is isError INVALID_ARGUMENT [OUT_OF_RANGE /maxBytes]", async () => {
    const result = await callTool(await mcp(), "inspect_view", wireJson("inspect-budget-too-big.json"));
    expect(result.isError).toBe(true);
    const body = parseBody(result.text, "text");
    expect(body.code).toBe("INVALID_ARGUMENT");
    expect(issuePairs(body)).toEqual([["OUT_OF_RANGE", "/maxBytes"]]);
  });

  // why: an unknown tool name is UNKNOWN_OPERATION (an existing code) as an isError result (MCP-2), so an agent sees a normal
  //      error body, not a transport failure.
  // proves: CLAIM(MC11)
  it("[MC11] tools/call of an unknown tool is isError UNKNOWN_OPERATION", async () => {
    const result = await callTool(await mcp(), "frobnicate", {});
    expect(result.isError).toBe(true);
    expect(parseBody(result.text, "text").code).toBe("UNKNOWN_OPERATION");
  });

  // why: the MCP edge adds its own bytes risk: the budget covers ALL content text (design 4 "any repeated MCP content"). For
  //      every reply-producing tool and both budgets 2048 and 8192, in both formats: one block, no structuredContent, bytes <=
  //      maxBytes, JSON parses, no U+FFFD. `wide-list` has 40 rows of ~200 bytes of multibyte text, so it cannot fit either budget.
  // proves: CLAIM(MC3)
  describe.each([
    ["inspect_view wide-list", "inspect_view", { viewId: "wide-list", snapshotId: "snap-1" }],
    ["inspect_view modules", "inspect_view", { viewId: "modules", snapshotId: "snap-1" }],
    ["describe_component graph", "describe_component", { component: "graph" }],
    ["search cancel", "search", { query: "cancel" }],
    ["open_entity watch", "open_entity", { snapshotId: "snap-1", entity: WATCH }],
    ["render modules", "render", { input: wireJson("render-valid.json").input }],
  ] as const)("%s", (_label, tool, base) => {
    it("[MC3] stays within maxBytes 2048 and 8192, as one text block, in text and json", async () => {
      for (const maxBytes of [2048, 8192]) {
        for (const format of ["text", "json"] as const) {
          const result = await callTool(await mcp(), tool, { ...base, maxBytes, format });
          const where = `${tool} maxBytes=${maxBytes} ${format}`;
          expect(result.isError, `${where}: ${result.text.slice(0, 160)}`).toBe(false);
          expect(result.blocks, where).toBe(1);
          expect((result.raw as any).structuredContent, where).toBeUndefined();
          expect(Buffer.byteLength(result.text), where).toBeLessThanOrEqual(maxBytes);
          expect(result.text, where).not.toContain("�");
          if (format === "json") parseBody(result.text, where);
        }
      }
    });
  });

  // why: an error body is part of the reply budget too (red-contract 3 "The error body itself is within the requested budget"):
  //      a 1024-byte request answers BUDGET_TOO_SMALL in at most 1024 bytes.
  // proves: CLAIM(MC3)
  it("[MC3] the BUDGET_TOO_SMALL error for maxBytes 1024 fits in 1024 bytes", async () => {
    const result = await callTool(await mcp(), "inspect_view", wireJson("inspect-budget-too-small.json"));
    expect(result.isError).toBe(true);
    expect(parseBody(result.text, "text").code).toBe("BUDGET_TOO_SMALL");
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1024);
  });

  // why: continuation cursors work through the MCP edge: following them yields every row once, in the view's order
  //      (row-00..row-39, names sort like ids), each page within the budget, the last page without a cursor.
  //      Page counts by arithmetic: a JSON row item is >= 200 bytes, so 40 rows exceed 8192 bytes and need >= 2 pages.
  //      JSON field names (items[].id, cursor, counts) are WIRE-2 in docs/contract-additions/wire.md.
  // proves: CLAIM(MC3), CLAIM(MC19)
  it.each([2048, 8192])("[MC3] following cursors at maxBytes %i returns the 40 wide rows once each, in order, every page within budget", async (maxBytes) => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result = await callTool(await mcp(), "inspect_view", { viewId: "wide-list", snapshotId: "snap-1", format: "json", maxBytes, ...(cursor === null ? {} : { cursor }) });
      expect(result.isError, result.text.slice(0, 200)).toBe(false);
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(maxBytes);
      const body = parseBody(result.text, `page ${pages}`);
      expect(body.counts.total).toBe(40);
      expect(body.counts.matched).toBe(40);
      expect(body.counts.returned + body.counts.omitted, "returned + omitted = matched (red-contract 3)").toBe(40 - seen.length);
      seen.push(...body.items.map((item: any) => item.id));
      cursor = body.cursor;
      expect(cursor === null, "cursor is null iff omitted = 0").toBe(body.counts.omitted === 0);
      pages += 1;
    } while (cursor !== null && pages < 60);
    expect(cursor).toBeNull();
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(seen).toEqual(Array.from({ length: 40 }, (_, index) => `row-${String(index).padStart(2, "0")}`));
  });
});

describe("mcp: sessions and registration over the wire", () => {
  // why: without --session the server still starts; stateless tools work and stored-data tools say SESSION_REQUIRED (MCP-3),
  //      the same behaviour as the CLI, so an agent can validate before a session exists.
  // proves: CLAIM(MC11)
  it("[MC11] a server started without --session answers describe_component and validate, and SESSION_REQUIRED for render", async () => {
    const connection = await connectMcp(null);
    try {
      expect((await callTool(connection, "describe_component", { component: "list", format: "json" })).isError).toBe(false);
      expect((await callTool(connection, "validate", wireJson("validate-valid-graph.json"))).isError).toBe(false);
      const render = await callTool(connection, "render", wireJson("render-valid.json"));
      expect(render.isError).toBe(true);
      expect(parseBody(render.text, "text").code).toBe("SESSION_REQUIRED");
    } finally {
      await connection.close();
    }
  });

  // why: register_view is MCP-only (no CLI command) and must follow the registry revision protocol of red-contract 5:
  //      expectedRevision = current -> success and revision+1; a stale one -> CONFLICT with details.currentRevision.
  // proves: CLAIM(MC12)
  it("[MC12] register_view: current revision succeeds, the stale revision is CONFLICT {currentRevision}, the next one succeeds", async () => {
    const dir = await seedClosed(makeTemp("mcp-register"));
    const before = must(await openSession(dir), "open");
    const revision = (await before.listDefinitions()).revision;
    await before.close();
    const definition = (id: string) => ({ id, entityKind: "vigil/watch", title: `Extra ${id}`, priority: 5, component: "list", requires: [], dataRole: "modules" });
    const connection = await connectMcp(dir);
    try {
      const first = await callTool(connection, "register_view", { definition: definition("def-mcp-1"), expectedRevision: revision });
      expect(first.isError, first.text.slice(0, 200)).toBe(false);
      const stale = await callTool(connection, "register_view", { definition: definition("def-mcp-2"), expectedRevision: revision });
      expect(stale.isError).toBe(true);
      const body = parseBody(stale.text, "text");
      expect(body.code).toBe("CONFLICT");
      expect(body.details).toEqual({ currentRevision: revision + 1 });
      const second = await callTool(connection, "register_view", { definition: definition("def-mcp-2"), expectedRevision: revision + 1 });
      expect(second.isError, second.text.slice(0, 200)).toBe(false);
    } finally {
      await connection.close();
    }
    const after = must(await openSession(dir), "reopen");
    const definitions = await after.listDefinitions();
    await after.close();
    expect(definitions.revision).toBe(revision + 2);
    expect(definitions.definitions.map((entry) => entry.id)).toEqual(expect.arrayContaining(["def-mcp-1", "def-mcp-2"]));
  });
});

describe("mcp: stdout carries protocol messages only (MC3)", () => {
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw-test", version: "0.0.0" } } };

  // why: stdio MCP breaks on any stray byte on stdout (design 5 "Log to stderr"). A raw child (no SDK client in between) answers
  //      initialize, tools/list and a failing tools/call; EVERY stdout line must parse as a JSON-RPC 2.0 message, and the
  //      responses carry the facts we know: the echoed protocol version, a tools capability, 13 tools, isError for the bad call.
  // proves: CLAIM(MC3)
  it("[MC3] every stdout line of `paneweft mcp` is a JSON-RPC message, over initialize, tools/list and a failing call", async () => {
    const dir = await readDir();
    const child = spawnRawMcp(dir);
    try {
      child.send(initialize);
      const init = await child.response(1);
      expect(init.result.protocolVersion).toBe("2025-03-26");
      expect(typeof init.result.capabilities.tools).toBe("object");
      child.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      child.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const listed = await child.response(2);
      expect(listed.result.tools).toHaveLength(13);
      child.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "validate", arguments: wireJson("validate-unknown-component.json") } });
      const called = await child.response(3);
      expect(called.result.isError).toBe(true);
      expect(parseBody(called.result.content[0].text, "content").code).toBe("VALIDATION_FAILED");
      expect(child.lines.length).toBeGreaterThanOrEqual(3);
      for (const line of child.lines) {
        let message: any;
        try { message = JSON.parse(line); } catch { message = null; }
        expect(message, `stdout line is not JSON: ${JSON.stringify(line.slice(0, 120))}`).not.toBeNull();
        expect(message.jsonrpc, `line ${line.slice(0, 80)}`).toBe("2.0");
        expect("method" in message || "id" in message, `line ${line.slice(0, 80)}`).toBe(true);
      }
    } finally {
      child.kill();
    }
  });

  // why: a stdio server that outlives its client leaks processes; it must exit, with status 0, once stdin closes (design 5).
  // proves: CLAIM(MC3)
  it("[MC3] the server exits with status 0 when stdin closes", async () => {
    const dir = await readDir();
    const child = spawnRawMcp(dir);
    try {
      child.send(initialize);
      await child.response(1);
      expect(await child.closeStdinAndWaitForExit()).toBe(0);
    } finally {
      child.kill();
    }
  });
});

describe("mcp: no payload executes anything (MC17)", () => {
  // why: example_record takes a run's RESULT, never a runner (design 5, owner question 4). A runner definition inside the run output
  //      or its bundle, or an `argv` tool argument, is refused: VALIDATION_FAILED (document) / INVALID_ARGUMENT (argument), the
  //      issue names the unknown property, NOTHING is recorded and the canary file the payload's argv names does not appear.
  //      Control (same call, runner removed) records run `run-1`; the final listRuns proves the session was writable.
  // proves: CLAIM(MC17)
  it("[MC17] example_record with a runner in the output or bundle, or an argv argument, is refused and spawns nothing", async () => {
    const dir = await seedClosed(makeTemp("mcp-record"));
    const scratch = mkdtempSync(join(tmpdir(), "paneweft-canary-"));
    const canary = join(scratch, "canary");
    const key = { viewId: "vigil-one-write", snapshotId: "snap-1" };
    const connection = await connectMcp(dir);
    try {
      const withCanary = (file: string) => JSON.parse(wireText(file).replaceAll("{canary}", canary));
      const inOutput = await callTool(connection, "example_record", withCanary("example-record-runner-in-output.json"));
      expect(inOutput.isError).toBe(true);
      const outputBody = parseBody(inOutput.text, "text");
      expect(outputBody.code).toBe("VALIDATION_FAILED");
      expect(outputBody.errors.map((issue: any) => issue.code)).toEqual(["UNKNOWN_PROPERTY"]);
      expect(outputBody.errors[0].pointer).toMatch(/\/runner$/);

      const inBundle = await callTool(connection, "example_record", withCanary("example-record-runner-in-bundle.json"));
      expect(inBundle.isError).toBe(true);
      const bundleBody = parseBody(inBundle.text, "text");
      expect(bundleBody.code).toBe("VALIDATION_FAILED");
      expect(bundleBody.errors[0].pointer).toMatch(/\/runners$/);

      const asArgument = await callTool(connection, "example_record", withCanary("example-record-argv-argument.json"));
      expect(asArgument.isError).toBe(true);
      const argumentBody = parseBody(asArgument.text, "text");
      expect(argumentBody.code).toBe("INVALID_ARGUMENT");
      expect(issuePairs(argumentBody)).toEqual([["UNKNOWN_PROPERTY", "/argv"]]);

      expect(existsSync(canary), "no process was spawned from the payload").toBe(false);
      const control = await callTool(connection, "example_record", wireJson("example-record-valid.json"));
      expect(control.isError, control.text.slice(0, 300)).toBe(false);
    } finally {
      await connection.close();
      rmSync(scratch, { recursive: true, force: true });
    }
    const session = must(await openSession(dir), "reopen");
    const runs = must(await session.listRuns(key), "listRuns");
    await session.close();
    expect(runs.map((run) => [run.runId, run.status])).toEqual([["run-1", "passed"]]);
  });
});
