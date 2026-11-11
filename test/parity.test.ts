// CLI/MCP parity over the SAME literal request bytes (design section 7, MC11), plus the four visible
// completeness states through both transports (MC4).
// Placement: cross-cutting by nature (two transports, one request file each); neither src/cli nor src/mcp owns it.
// Method: every request is a committed file under fixtures/wire. The CLI reads the file with --args-file; the MCP
// client sends the parsed same JSON as tools/call arguments. Each case asserts (a) byte-identical bodies and
// (b) the contract's literal values, so two copies of one wrong generator cannot pass (test-quality 3 "parity").
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSession } from "../src/core/session.ts";
import { spawnPaneweft, type CliRun } from "./helpers/cli.ts";
import { REPO_ROOT } from "./helpers/fixtures.ts";
import { connectMcp, type McpTextResult } from "./helpers/mcp-client.ts";
import { must } from "./helpers/must.ts";
import { callTool, sharedMcp } from "./helpers/wire-mcp.ts";
import {
  CLI_WORDS, issuePairs, lazyShared, parseBody, replyLines, seedClosed, sharedTempDirs, wireJson, wirePath,
  type ToolNameLiteral,
} from "./helpers/wire-session.ts";

const dirs = sharedTempDirs();
const FOUR_STATE_VIEWS = ["view-empty-complete.json", "view-empty-partial.json", "view-unsupported.json", "view-wide-list.json"];
/** One read-only session shared by all read cases (CLI processes and the MCP server open the same directory). */
const readDir = lazyShared(() => seedClosed(dirs("parity-read"), { extraViews: FOUR_STATE_VIEWS }));
const readMcp = sharedMcp(readDir);

interface Pair { cli: CliRun; mcp: McpTextResult }
type CliTool = ToolNameLiteral;

async function readPair(tool: CliTool, file: string, session = true): Promise<Pair> {
  const dir = await readDir();
  const cli = await spawnPaneweft([...(session ? ["--session", dir] : []), ...CLI_WORDS[tool], "--args-file", wirePath(file)]);
  const mcp = await callTool(await readMcp(), tool, wireJson(file));
  return { cli, mcp };
}
/** For mutating requests: two identically seeded, separate sessions so that neither transport sees the other's write. */
async function freshPair(tool: CliTool, file: string, args?: { path: string; json: Record<string, any> }): Promise<Pair & { cliDir: string; mcpDir: string }> {
  const cliDir = await seedClosed(dirs("parity-cli"));
  const mcpDir = await seedClosed(dirs("parity-mcp"));
  const cli = await spawnPaneweft(["--session", cliDir, ...CLI_WORDS[tool], "--args-file", args?.path ?? wirePath(file)]);
  const connection = await connectMcp(mcpDir);
  try {
    return { cli, mcp: await callTool(connection, tool, args?.json ?? wireJson(file)), cliDir, mcpDir };
  } finally {
    await connection.close();
  }
}

/** CLI stdout is the body (red-contract 9); exit 0 iff the MCP result is not an error; MCP returns exactly one text block. */
function expectParity({ cli, mcp }: Pair): void {
  expect(cli.stdout, "CLI stdout must equal the MCP text byte for byte").toBe(mcp.text);
  expect(cli.exitCode).toBe(mcp.isError ? 1 : 0);
  expect(mcp.blocks).toBe(1);
}
const FRESHNESS = /^freshness: (fresh|stale \(changed: .+\)|unknown \(inaccessible: .+\)|unverified \(.+\))$/;
/** Header lines except `freshness:` (whose value depends on repository registration); asserts the freshness line's form and position. */
function withoutFreshness(lines: string[], freshnessIndex: number): string[] {
  expect(lines[freshnessIndex], "freshness line position (red-contract 3: after completeness)").toMatch(FRESHNESS);
  return lines.filter((_, index) => index !== freshnessIndex);
}
const LIST_QUESTION = "question: What is in this set, and which members matter?";

describe("parity: valid and invalid submissions (MC11)", () => {
  // #4: `validate` with a session compares the input with the session (as render does), and the MCP server always has one, so the CLI is given the same
  //   session here. The CLI without a session validates the document alone and says `identity: none` (operations.validate-session.test.ts).
  // why: a valid graph is accepted identically by both transports; the verdict shape `valid: true` is proposed in
  //      docs/contract-additions/wire.md (WIRE-1) because the contract only says "returns valid".
  // proves: CLAIM(MC11)
  it("[MC11] validate-valid-graph.json: exit 0 / not an error, byte-identical, valid true", async () => {
    const pair = await readPair("validate", "validate-valid-graph.json");
    expectParity(pair);
    expect(pair.cli.exitCode).toBe(0);
    expect(parseBody(pair.cli.stdout, "stdout").valid).toBe(true);
  });

  // why: the design's own MC1 example (string depth) through both transports: same code, same pointer, one issue, and
  //      the rule text "type: integer" (red-contract 2: constraint states the rule; hints are never empty).
  // proves: CLAIM(MC11), CLAIM(MC1)
  it("[MC11] validate-graph-string-depth.json: VALIDATION_FAILED with exactly [TYPE /data/focus/depth], identical bodies", async () => {
    const pair = await readPair("validate", "validate-graph-string-depth.json");
    expectParity(pair);
    expect(pair.cli.exitCode).toBe(1);
    expect(pair.mcp.isError).toBe(true);
    const body = parseBody(pair.cli.stdout, "stdout");
    expect(body.schemaVersion).toBe("paneweft.error/1");
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.retryable).toBe(false);
    expect(body.errors.map(({ code, pointer, constraint }: any) => ({ code, pointer, constraint }))).toEqual([
      { code: "TYPE", pointer: "/data/focus/depth", constraint: "type: integer" },
    ]);
    expect(typeof body.errors[0].hint === "string" && body.errors[0].hint.length > 0, "hint is never empty").toBe(true);
  });

  // why: an unknown component is its own issue code and stops data checking (red-contract 2): exactly one issue.
  // proves: CLAIM(MC11), CLAIM(MC1)
  it("[MC11] validate-unknown-component.json: VALIDATION_FAILED with exactly [UNKNOWN_COMPONENT /component]", async () => {
    const pair = await readPair("validate", "validate-unknown-component.json");
    expectParity(pair);
    const body = parseBody(pair.cli.stdout, "stdout");
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(issuePairs(body)).toEqual([["UNKNOWN_COMPONENT", "/component"]]);
  });

  // why: render of a valid envelope agrees across transports and its summary carries the mandatory header (design 4):
  //      view, question, snapshot, completeness, provenance counts, evidence, filters, order, counts. Header lines are the
  //      red-contract 3 text form for the list fixture (1 row, provenance read, source s1).
  // proves: CLAIM(MC11), CLAIM(MC3)
  it("[MC11] render-valid.json (text): identical bodies and the red-contract 3 header for view `modules`", async () => {
    const pair = await freshPair("render", "render-valid.json");
    expectParity(pair);
    expect(pair.cli.exitCode).toBe(0);
    const all = replyLines(pair.cli.stdout);
    const start = all.findIndex((line) => line.startsWith("paneweft.reply/1 "));
    expect(start, "the summary starts with the reply header line").toBeGreaterThanOrEqual(0);
    const lines = all.slice(start); // render may print its own lines (ids, viewer URL) before the summary: WIRE-2
    expect(withoutFreshness(lines, 4).slice(0, 8)).toEqual([
      "paneweft.reply/1 view=modules component=list",
      LIST_QUESTION,
      "snapshot: snap-1",
      "completeness: complete (all modules in the fixture)",
      "provenance: read=1 parsed=0 compiled=0 observed=0 inferred=0",
      "evidence: sources=s1",
      "filters: none",
      "order: name asc",
    ]);
    expect(lines).toContain("counts: unit=rows total=1 matched=1 returned=1 omitted=0 truncated=false");
  });

  // why: JSON render: viewerUrl is null without a running viewer (red-contract 8) and the counts are the exact ones of the
  //      one-row fixture; field placement (top level, reply fields) is WIRE-2 in docs/contract-additions/wire.md.
  // proves: CLAIM(MC11)
  it("[MC11] render-valid-json.json: identical bodies, viewerUrl null, counts {rows 1/1/1/0}", async () => {
    const pair = await freshPair("render", "render-valid-json.json");
    expectParity(pair);
    const body = parseBody(pair.cli.stdout, "stdout");
    expect(body.viewerUrl).toBeNull();
    expect(body.counts).toEqual({ unit: "rows", total: 1, matched: 1, returned: 1, omitted: 0, truncated: false });
    expect(body.view.id).toBe("modules");
    expect(body.cursor).toBeNull();
  });

  // why: a rejected render fails identically (exit 1 / isError) with the unknown property at its exact pointer, and stores
  //      nothing (atomic: the session lists the same views as before the request, in both sessions).
  // proves: CLAIM(MC11), CLAIM(MC20)
  it("[MC11] render-invalid.json: VALIDATION_FAILED [UNKNOWN_PROPERTY /data/rows/0/colour], identical, nothing stored", async () => {
    const pair = await freshPair("render", "render-invalid.json");
    expectParity(pair);
    expect(pair.cli.exitCode).toBe(1);
    const body = parseBody(pair.cli.stdout, "stdout");
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(issuePairs(body)).toEqual([["UNKNOWN_PROPERTY", "/data/rows/0/colour"]]);
    for (const dir of [pair.cliDir, pair.mcpDir]) {
      const session = must(await openSession(dir), "reopen");
      expect((await session.listViews()).length, `views in ${dir}`).toBe(7);
      await session.close();
    }
  });
});

describe("parity: bounded replies (MC11, MC3, MC4, MC5)", () => {
  // why: golden for the filtered list reply, derived by hand from red-contract 3 (header order, counts line, body line,
  //      item line format `<cell> -> <kind>:<id>; <provenance>; <evidence>`), identical over both transports. The filter is
  //      case-insensitive (`MCP` matches `mcp.rs`). `freshness:` is checked for form only.
  // proves: CLAIM(MC11), CLAIM(MC3)
  it("[MC11] inspect-list-filter.json: identical bodies and the hand-derived text reply", async () => {
    const pair = await readPair("inspect_view", "inspect-list-filter.json");
    expectParity(pair);
    expect(pair.cli.exitCode).toBe(0);
    const lines = replyLines(pair.cli.stdout);
    expect(withoutFreshness(lines, 4)).toEqual([
      "paneweft.reply/1 view=modules component=list",
      LIST_QUESTION,
      "snapshot: snap-1",
      "completeness: complete (all modules in the fixture)",
      "provenance: read=1 parsed=0 compiled=0 observed=0 inferred=0",
      "evidence: sources=s1",
      'filters: text="MCP"',
      "order: name asc",
      "counts: unit=rows total=1 matched=1 returned=1 omitted=0 truncated=false",
      "1/1 matched rows returned; 0 omitted",
      "mcp.rs -> code/module:mcp; read; s1",
    ]);
  });

  // why: a filter that matches nothing still states question, completeness, provenance and evidence of the WHOLE view (design 4,
  //      MC5) and the exact notice `no items match the current filters (0 of 1)`; counts keep total 1.
  // proves: CLAIM(MC11), CLAIM(MC4), CLAIM(MC5)
  it("[MC11] inspect-list-nomatch.json: header and counts survive an empty match, with the filter notice", async () => {
    const pair = await readPair("inspect_view", "inspect-list-nomatch.json");
    expectParity(pair);
    const lines = replyLines(pair.cli.stdout);
    expect(lines).toContain('filters: text="zzz"');
    expect(lines).toContain("provenance: read=1 parsed=0 compiled=0 observed=0 inferred=0");
    expect(lines).toContain("evidence: sources=s1");
    expect(lines).toContain("completeness: complete (all modules in the fixture)");
    expect(lines).toContain("counts: unit=rows total=1 matched=0 returned=0 omitted=0 truncated=false");
    expect(lines.some((line) => line.includes("no items match the current filters (0 of 1)"))).toBe(true);
    expect(lines.some((line) => line.includes("mcp.rs ->"))).toBe(false);
  });

  // why: maxBytes below 2048 is BUDGET_TOO_SMALL with the minimum (red-contract 3), the error body fits the requested 1024
  //      bytes, and both transports say the same.
  // proves: CLAIM(MC11), CLAIM(MC3)
  it("[MC11] inspect-budget-too-small.json: BUDGET_TOO_SMALL minimumBytes 2048, identical, body within 1024 bytes", async () => {
    const pair = await readPair("inspect_view", "inspect-budget-too-small.json");
    expectParity(pair);
    expect(pair.cli.exitCode).toBe(1);
    const body = parseBody(pair.cli.stdout, "stdout");
    expect(body.code).toBe("BUDGET_TOO_SMALL");
    expect(body.details).toEqual({ minimumBytes: 2048 });
    expect(Buffer.byteLength(pair.cli.stdout)).toBeLessThanOrEqual(1024);
  });

  // why: above 32768 is INVALID_ARGUMENT at /maxBytes (red-contract 3), not BUDGET_TOO_SMALL and not clamped.
  // proves: CLAIM(MC11), CLAIM(MC3)
  it("[MC11] inspect-budget-too-big.json: INVALID_ARGUMENT [OUT_OF_RANGE /maxBytes], identical", async () => {
    const pair = await readPair("inspect_view", "inspect-budget-too-big.json");
    expectParity(pair);
    const body = parseBody(pair.cli.stdout, "stdout");
    expect(body.code).toBe("INVALID_ARGUMENT");
    expect(issuePairs(body)).toEqual([["OUT_OF_RANGE", "/maxBytes"]]);
  });

  // why: discovery replies page under a 2048-byte budget (red-contract 3 describe_component): page by page, both transports
  //      return identical bytes, every page fits 2048, chunk indexes are 0..n-1 with a constant chunkCount, and the
  //      concatenation is the document {id, question, capabilities, limits, schema, example} whose schema equals the
  //      canonical file (read from disk here as the independent oracle). The graph schema alone is 2388 bytes pretty-printed
  //      and the example envelope adds more, so one 2048-byte page cannot hold the document: chunkCount >= 2.
  // proves: CLAIM(MC11), CLAIM(MC3)
  it("[MC11] describe-graph-2048.json: paged identically over both transports; the chunks reassemble to the canonical schema", async () => {
    const chunks: string[] = [];
    let cursor: string | null = null;
    let chunkCount = -1;
    for (let page = 0; page < 40; page += 1) {
      const cliArgs = ["describe", "--args-file", wirePath("describe-graph-2048.json"), ...(cursor === null ? [] : ["--cursor", cursor])];
      const cli = await spawnPaneweft(cliArgs);
      const mcp = await callTool(await readMcp(), "describe_component", { ...wireJson("describe-graph-2048.json"), ...(cursor === null ? {} : { cursor }) });
      expectParity({ cli, mcp });
      expect(cli.exitCode).toBe(0);
      expect(Buffer.byteLength(mcp.text), `page ${page}`).toBeLessThanOrEqual(2048);
      const body = parseBody(cli.stdout, `page ${page}`);
      expect(body.component).toBe("graph");
      expect(body.chunkIndex).toBe(page);
      if (page === 0) chunkCount = body.chunkCount;
      expect(body.chunkCount).toBe(chunkCount);
      chunks.push(body.chunk);
      cursor = body.cursor ?? null;
      if (cursor === null) break;
    }
    expect(cursor, "the last page has no cursor within 40 pages").toBeNull();
    expect(chunks.length).toBe(chunkCount);
    expect(chunkCount).toBeGreaterThanOrEqual(2);
    const document = JSON.parse(chunks.join(""));
    expect(Object.keys(document).sort()).toEqual(["capabilities", "example", "id", "limits", "question", "schema"]);
    expect(document.id).toBe("graph");
    expect(document.schema).toEqual(JSON.parse(readFileSync(join(REPO_ROOT, "src", "schemas", "components", "graph.schema.json"), "utf8")));
  });

  // why: search is the same operation on both transports; the query `cancel` (case-insensitive) must find the notebook view
  //      titled `Cancellation notebook` (fixture notebook.json title), so its id appears in the reply (design 3 search indexes
  //      "view titles/questions, notebook pages and claims").
  // proves: CLAIM(MC11)
  it("[MC11] search-cancel.json: identical bodies, the cancellation notebook is found", async () => {
    const pair = await readPair("search", "search-cancel.json");
    expectParity(pair);
    expect(pair.cli.exitCode).toBe(0);
    expect(pair.cli.stdout).toContain("cancellation-notebook");
  });

  // why: open_entity lists applicable views by rankViews (red-contract 5): priority ascending, then the always-available
  //      built-ins metadata (1000) and raw (1001). Fixture priorities: modules 10, layout 20, delivery 30, source 40, shape 50,
  //      example 60. Order is checked by first occurrence in the (shape-agnostic) JSON text.
  // proves: CLAIM(MC11), CLAIM(MC12)
  it("[MC11] open-entity-watch.json: identical bodies and the views in rank order", async () => {
    const pair = await readPair("open_entity", "open-entity-watch.json");
    expectParity(pair);
    expect(pair.cli.exitCode).toBe(0);
    const expectedOrder = ["def-modules", "def-layout", "def-delivery", "def-source", "def-shape", "def-example", "builtin:metadata", "builtin:raw"];
    const positions = expectedOrder.map((id) => pair.cli.stdout.indexOf(`"${id}"`));
    expect(positions.every((position) => position >= 0), `every view id appears: ${JSON.stringify(positions)}`).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  // why: the catalogue lists the seven v0 components on both transports (design 5 "components").
  // proves: CLAIM(MC11)
  it("[MC11] `components --format json` equals list_components {format:json} and names all seven components", async () => {
    const cli = await spawnPaneweft(["components", "--format", "json"]);
    const mcp = await callTool(await readMcp(), "list_components", { format: "json" });
    expectParity({ cli, mcp });
    for (const id of ["list", "tree", "graph", "source", "shape", "notebook", "example"]) expect(cli.stdout, id).toContain(`"${id}"`);
  });
});

describe("parity: a missing required argument is the tool's INVALID_ARGUMENT on both transports (MC11)", () => {
  // Required properties come from design 5 and the tool schemas (read once), sorted by pointer (red-contract 2: sorted by
  // (pointer, code)). register_view has no CLI command and is checked over MCP only below.
  // why: CLI and MCP must reject an empty request with the same code and the same issues, for every tool that has required fields.
  // proves: CLAIM(MC11)
  const table: Array<[CliTool, Array<[string, string]>]> = [
    ["describe_component", [["REQUIRED", "/component"]]],
    ["validate", [["REQUIRED", "/input"]]],
    ["render", [["REQUIRED", "/input"]]],
    ["open_entity", [["REQUIRED", "/entity"], ["REQUIRED", "/snapshotId"]]],
    ["navigate", [["REQUIRED", "/itemId"], ["REQUIRED", "/pane"]]],
    ["inspect_view", [["REQUIRED", "/snapshotId"], ["REQUIRED", "/viewId"]]],
    ["search", [["REQUIRED", "/query"]]],
    ["notebook_create", [["REQUIRED", "/input"]]],
    ["notebook_get", [["REQUIRED", "/pageId"]]],
    ["notebook_update", [["REQUIRED", "/blocks"], ["REQUIRED", "/expectedRevision"], ["REQUIRED", "/pageId"]]],
    ["example_record", [["REQUIRED", "/output"], ["REQUIRED", "/snapshotId"], ["REQUIRED", "/viewId"]]],
  ];
  it.each(table)("[MC11] %s with `{}`: INVALID_ARGUMENT with the required properties, identical bodies", async (tool, issues) => {
    const dir = await readDir();
    const cli = await spawnPaneweft(["--session", dir, ...CLI_WORDS[tool], "--args", "{}"]);
    const mcp = await callTool(await readMcp(), tool, {});
    expectParity({ cli, mcp });
    expect(cli.exitCode).toBe(1);
    const body = parseBody(cli.stdout, "stdout");
    expect(body.code).toBe("INVALID_ARGUMENT");
    expect(issuePairs(body)).toEqual(issues);
  });
  it("[MC11] register_view with `{}` over MCP: INVALID_ARGUMENT [REQUIRED /definition, REQUIRED /expectedRevision]", async () => {
    const mcp = await callTool(await readMcp(), "register_view", {});
    expect(mcp.isError).toBe(true);
    const body = parseBody(mcp.text, "text");
    expect(body.code).toBe("INVALID_ARGUMENT");
    expect(issuePairs(body)).toEqual([["REQUIRED", "/definition"], ["REQUIRED", "/expectedRevision"]]);
  });
});

describe("the four visible states through CLI and MCP (MC4)", () => {
  // Pinned strings: red-contract 3 (header `completeness:` variants and the `notice` table). Views: fixtures/wire/view-*.json.
  const STATES = {
    completeEmpty: {
      file: "inspect-empty-complete.json",
      completeness: "completeness: complete (every module of the empty fixture scope)",
      notice: "0 items within this scope",
    },
    partialEmpty: {
      file: "inspect-empty-partial.json",
      completeness: "completeness: partial (1 gaps; first: g1: Were generated modules scanned?)",
      notice: "no items returned; completeness is partial (see gaps)",
    },
    unsupported: {
      file: "inspect-unsupported.json",
      completeness: "completeness: unsupported (No language service is available.; missing: cap-a, cap-b)",
      notice: "this view is unsupported: No language service is available.",
    },
  };
  const bodyOf = async (state: keyof typeof STATES) => {
    const pair = await readPair("inspect_view", STATES[state].file);
    expectParity(pair);
    expect(pair.cli.exitCode).toBe(0); // a domain result, not an operation error
    return pair.cli.stdout;
  };

  // why: complete-and-empty is a positive statement ("0 items within this scope"), counts all zero, filters none.
  // proves: CLAIM(MC4)
  it("[MC4] complete-empty: the completeness line, zero counts and the `0 items within this scope` notice", async () => {
    const text = await bodyOf("completeEmpty");
    const lines = replyLines(text);
    expect(lines[0]).toBe("paneweft.reply/1 view=empty-complete component=list");
    expect(lines).toContain(STATES.completeEmpty.completeness);
    expect(lines).toContain("counts: unit=rows total=0 matched=0 returned=0 omitted=0 truncated=false");
    expect(lines).toContain("provenance: read=0 parsed=0 compiled=0 observed=0 inferred=0");
    expect(lines.some((line) => line.includes(STATES.completeEmpty.notice))).toBe(true);
  });

  // why: partial-and-empty must never read as "nothing exists": the gap count and first gap are named, and the notice says
  //      completeness is partial (design 4 "never replaces an unknown count with zero"; red-contract 3 notice table).
  // proves: CLAIM(MC4)
  it("[MC4] partial-empty: the first gap is named and the notice is the partial one, never `0 items within this scope`", async () => {
    const text = await bodyOf("partialEmpty");
    const lines = replyLines(text);
    expect(lines).toContain(STATES.partialEmpty.completeness);
    expect(lines.some((line) => line.includes(STATES.partialEmpty.notice))).toBe(true);
    expect(text).not.toContain("0 items within this scope");
  });

  // why: unsupported carries no data: reason and missing capabilities are visible, and the notice says unsupported.
  // proves: CLAIM(MC4)
  it("[MC4] unsupported: reason and missing capabilities are visible with the unsupported notice", async () => {
    const text = await bodyOf("unsupported");
    const lines = replyLines(text);
    expect(lines[0]).toBe("paneweft.reply/1 view=unsupported-view component=list");
    expect(lines).toContain(STATES.unsupported.completeness);
    expect(lines.some((line) => line.includes(STATES.unsupported.notice))).toBe(true);
    expect(text).not.toContain("0 items within this scope");
  });

  // why: the fourth state is an operation error: no reply header, an error body, exit 1 / isError. Rejecting a partial payload
  //      without gaps is MC4's other half and belongs to validation tests; here the failure is a render the validator refuses.
  // proves: CLAIM(MC4)
  it("[MC4] failed operation: an error body (exit 1 / isError), not a reply, on both transports", async () => {
    const pair = await freshPair("render", "render-invalid.json");
    expectParity(pair);
    expect(pair.cli.exitCode).toBe(1);
    expect(pair.mcp.isError).toBe(true);
    expect(pair.cli.stdout.startsWith("paneweft.reply/1")).toBe(false);
    expect(pair.cli.stdout).not.toContain("completeness:");
    expect(parseBody(pair.cli.stdout, "stdout").schemaVersion).toBe("paneweft.error/1");
  });

  // why: the four states must be distinguishable from each other: each notice appears in exactly its own state's body
  //      (cross-negatives), so a renderer that prints one generic message for several states fails.
  // proves: CLAIM(MC4)
  it("[MC4] each state's notice appears in no other state's body", async () => {
    const bodies = {
      completeEmpty: await bodyOf("completeEmpty"),
      partialEmpty: await bodyOf("partialEmpty"),
      unsupported: await bodyOf("unsupported"),
    };
    for (const own of Object.keys(STATES) as Array<keyof typeof STATES>) {
      for (const other of Object.keys(STATES) as Array<keyof typeof STATES>) {
        const has = bodies[other].includes(STATES[own].notice);
        expect(has, `notice of ${own} in the body of ${other}`).toBe(own === other);
      }
    }
  });
});

describe("[S9] register: CLI `paneweft register` and MCP register_view are the same operation", () => {
  // why: S9 adds `paneweft register --file` (design 5 lists no register command, so a registry could only be changed through MCP).
  //   The arguments contain the registry REVISION, which depends on how the seed counted (store.md 5: not pinned), so the request
  //   bytes are written per run from the revision a probe session reports, then given VERBATIM to both transports (--args-file
  //   and tools/call). Three cases, as the brief names them: success, invalid definition, revision conflict. Each asserts byte-identical
  //   bodies and exit code (0 / 1), and the contract's literal values, so two copies of one wrong generator cannot pass.
  // proves: CLAIM(MC11) CLAIM(MC12) CLAIM(S9-register)
  const definition = (id: string, extra: Record<string, unknown> = {}) => ({ id, entityKind: "vigil/watch", title: `Extra ${id}`, priority: 5, component: "list", requires: [], dataRole: "modules", ...extra });
  async function revisionOfSeed(): Promise<number> {
    const probe = must(await openSession(await seedClosed(dirs("parity-probe"))), "open probe");
    const revision = (await probe.listDefinitions()).revision;
    await probe.close();
    return revision;
  }
  function requestFile(name: string, json: Record<string, any>) {
    const path = join(dirs("parity-register-args"), name);
    writeFileSync(path, JSON.stringify(json));
    return { path, json };
  }

  it("[S9] success: expectedRevision = current -> identical JSON bodies, exit 0, revision + 1 on both sides", async () => {
    const revision = await revisionOfSeed();
    const pair = await freshPair("register_view", "", requestFile("ok.json", { definition: definition("def-extra"), expectedRevision: revision, format: "json" }));
    expectParity(pair);
    expect(pair.cli.exitCode).toBe(0);
    const body = parseBody(pair.cli.stdout, "stdout");
    expect(body.revision).toBe(revision + 1);
    for (const dir of [pair.cliDir, pair.mcpDir]) {
      const session = must(await openSession(dir), "reopen");
      const stored = await session.listDefinitions();
      await session.close();
      expect(stored.revision).toBe(revision + 1);
      expect(stored.definitions.map((d) => d.id)).toContain("def-extra");
    }
  });
  it("[S9] invalid definition: component 'matrix' -> VALIDATION_FAILED with UNKNOWN_COMPONENT at /definition/component, identical, exit 1, registry unchanged", async () => {
    const revision = await revisionOfSeed();
    const pair = await freshPair("register_view", "", requestFile("bad.json", { definition: definition("def-bad", { component: "matrix" }), expectedRevision: revision, format: "json" }));
    expectParity(pair);
    expect(pair.cli.exitCode).toBe(1);
    const body = parseBody(pair.cli.stdout, "stdout");
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(issuePairs(body)).toEqual([["UNKNOWN_COMPONENT", "/definition/component"]]);
    const session = must(await openSession(pair.cliDir), "reopen");
    expect((await session.listDefinitions()).revision).toBe(revision);
    await session.close();
  });
  it("[S9] revision conflict: a stale expectedRevision -> CONFLICT {currentRevision}, identical, exit 1, retryable", async () => {
    const revision = await revisionOfSeed();
    const pair = await freshPair("register_view", "", requestFile("stale.json", { definition: definition("def-stale"), expectedRevision: revision + 7, format: "json" }));
    expectParity(pair);
    expect(pair.cli.exitCode).toBe(1);
    const body = parseBody(pair.cli.stdout, "stdout");
    expect(body.code).toBe("CONFLICT");
    expect(body.details).toEqual({ currentRevision: revision });
    expect(body.retryable).toBe(true);
  });
});
