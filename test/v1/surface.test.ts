// The agent surface (IV14, IV19; amendment S1): the new tools are advertised over MCP, the new commands exist on the CLI, both are thin
// adapters over one handler (byte-identical bodies), owner-only actions have no MCP twin, and the initialization instructions teach the
// SDK-first loop. RED: the v1 tools are not wired into src/mcp/server.ts or src/cli/main.ts yet; the v0 pins (thirteen tools in
// usage.test.ts, repo.test.ts, operations.discovery.test.ts) must be amended in green because this file is the amendment.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeV1Operation } from "../../src/v1/tools.ts";
import { V1_COMMANDS, V1_OWNER_ONLY_COMMANDS } from "../../src/cli/v1-commands.ts";
import { V1_ACTING_TOOLS, V1_READ_ONLY_TOOLS, V1_REQUIRED_TOOL_NAMES, V1_TOOL_NAMES } from "../../src/v1/schemas.ts";
import { runCliInProcess, spawnPaneweft } from "../helpers/cli.ts";
import { connectMcp } from "../helpers/mcp-client.ts";
import { FIXTURES, fakeCargoAdapter, makeRepo, seedToolSession, useV1Sessions } from "../helpers/v1-world.ts";
import { useTempDirs } from "../helpers/tmp.ts";

const open = useV1Sessions();
const tmp = useTempDirs();

async function seeded() {
  const { session, dir } = await open();
  const root = tmp("surface-root");
  cpSync(join(FIXTURES, "crates/watchfile"), root, { recursive: true });
  makeRepo(root, {});
  await seedToolSession(dir, session, root, fakeCargoAdapter({ workspaceRoot: root }));
  await session.close();
  return { dir, root };
}

describe("[MCP] advertised tools", () => {
  // why: S1. The nine required v1 tools (and the optional tenth) are advertised next to the thirteen v0 tools, each with a
  // self-contained schema (no $ref), additionalProperties false, and an honest description. Read-only tools carry the read-only
  // annotation; collect and cancel do not and say they act. Annotations are hints, not enforcement (spec section 6).
  // proves: CLAIM(S1-week-one-cut) CLAIM(IV14)
  it("lists the v1 tools with schemas, annotations and honest descriptions", async () => {
    const { dir } = await seeded();
    const mcp = await connectMcp(dir);
    try {
      const tools = await mcp.listTools() as Array<{ name: string; description?: string; inputSchema: any; annotations?: { readOnlyHint?: boolean } }>;
      const names = tools.map((t) => t.name);
      for (const name of V1_REQUIRED_TOOL_NAMES) expect(names, name).toContain(name);
      expect(names.length).toBeGreaterThanOrEqual(22);
      for (const name of V1_REQUIRED_TOOL_NAMES) {
        const tool = tools.find((t) => t.name === name)!;
        expect(JSON.stringify(tool.inputSchema), `${name} is self contained`).not.toContain("$ref");
        expect(tool.inputSchema.additionalProperties, name).toBe(false);
        expect(tool.annotations?.readOnlyHint === true, `${name} read-only annotation`).toBe((V1_READ_ONLY_TOOLS as readonly string[]).includes(name));
      }
      expect(tools.find((t) => t.name === "collect")!.description).toMatch(/EXECUTES CODE/);
      for (const name of V1_ACTING_TOOLS) expect(tools.find((t) => t.name === name)!.annotations?.readOnlyHint).not.toBe(true);
    } finally {
      await mcp.close();
    }
  }, 60_000);

  // why: spec section 6. The initialization instructions teach the SDK-first loop (discover, scaffold, collect, read, explain), name
  // only advertised tools, keep the JSON fallback sentence, and no longer claim that no tool runs code: collection is the one narrow,
  // owner-registered exception.
  // proves: CLAIM(S1-week-one-cut) CLAIM(IV14)
  it("instructions teach the SDK loop and state the narrow execution rule", async () => {
    const { dir } = await seeded();
    const mcp = await connectMcp(dir);
    try {
      const instructions = mcp.instructions() ?? "";
      for (const needle of ["list_types", "list_views_for_type", "scaffold_view", "collect", "collection_status", "view_result", "explain_failure", "JSON fallback"]) expect(instructions, needle).toContain(needle);
      expect(instructions).not.toMatch(/no tool runs code/i);
      expect(instructions).toMatch(/collect[^.]*registered adapter/i);
      const advertised = new Set((await mcp.listTools()).map((t) => t.name));
      for (const name of instructions.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) if (V1_TOOL_NAMES.includes(name as never)) expect(advertised.has(name), `${name} is named but not advertised`).toBe(true);
    } finally {
      await mcp.close();
    }
  }, 60_000);

  // why: spec section 6. Registering an adapter and trusting a renderer are owner decisions: no MCP tool exists for them, and the CLI
  // commands do.
  // proves: CLAIM(IV16) CLAIM(IV12)
  it("exposes no MCP tool for adapter registration or renderer trust", async () => {
    const { dir } = await seeded();
    const mcp = await connectMcp(dir);
    try {
      const names = (await mcp.listTools()).map((t) => t.name);
      expect(names.filter((n) => /adapter|trust|renderer/i.test(n))).toEqual([]);
    } finally {
      await mcp.close();
    }
    expect(V1_OWNER_ONLY_COMMANDS).toEqual([["adapter", "add"], ["adapter", "list"], ["renderers", "trust"], ["renderers", "list"], ["renderers", "digest"], ["catalogue", "refresh"], ["inventory", "update"]]);
    for (const words of V1_OWNER_ONLY_COMMANDS) {
      const run = await runCliInProcess([...words, "--help"]);
      expect([run.exitCode, run.stdout].join(" "), words.join(" ")).toMatch(/^0 usage: paneweft /);
    }
  }, 60_000);
});

describe("[CLI] commands and parity", () => {
  // why: S1 / spec section 6. Every v1 tool has a kebab-case CLI command; each prints help with a runnable example and exits 0.
  // proves: CLAIM(S1-week-one-cut) CLAIM(IV19)
  it("has a command per tool, each with help", async () => {
    expect(V1_COMMANDS.map((c) => c.tool).sort()).toEqual([...V1_TOOL_NAMES].sort());
    for (const command of V1_COMMANDS) {
      const run = await runCliInProcess([...command.words, "--help"]);
      expect(run.exitCode, command.words.join(" ")).toBe(0);
      expect(run.stdout, command.words.join(" ")).toContain(`usage: paneweft ${command.words.join(" ")}`);
      expect(run.stdout).toContain(`example: ${command.example}`);
    }
    const top = await runCliInProcess(["--help"]);
    for (const word of ["types", "views", "examples", "scaffold", "collect", "collection", "result", "failure", "adapter", "renderers"]) expect(top.stdout, word).toMatch(new RegExp(`^  ${word}\\s`, "m"));
  });

  // why: CLAIM(cli-is-an-adapter) for v1: one request, one body, three paths (CLI, MCP, the shared handler): byte-identical, including
  // the error body of a refused request. The facts are the catalogue's, so this also proves the CLI reads the same session store.
  // proves: CLAIM(IV19) CLAIM(IV14)
  it("CLI, MCP and the handler return the same bytes", async () => {
    const { dir } = await seeded();
    const request: Array<[string[], string, Record<string, unknown>]> = [
      [["types", "--repo", "vg"], "list_types", { repo: "vg" }],
      [["views", "--repo", "vg", "--type", "vigil::watch::WatchFile"], "list_views_for_type", { repo: "vg", type: "vigil::watch::WatchFile" }],
      [["examples", "--repo", "vg"], "list_examples", { repo: "vg" }],
      [["views", "--repo", "vg", "--type", ""], "list_views_for_type", { repo: "vg", type: "" }],
    ];
    const mcp = await connectMcp(dir);
    try {
      for (const [words, tool, args] of request) {
        const cli = await spawnPaneweft(["--session", dir, ...words, "--format", "json"]);
        const viaMcp = await mcp.call(tool, { ...args, format: "json" });
        expect(cli.stdout.trim(), `${tool}: CLI body`).toBe(viaMcp.text.trim());
        expect(cli.exitCode, `${tool}: exit code`).toBe(viaMcp.isError ? 1 : 0);
      }
    } finally {
      await mcp.close();
    }
    const direct = await executeV1Operation({ session: null, sessionDir: dir, jobs: null }, "list_types", { repo: "vg", format: "json" });
    expect(direct.body.length).toBeGreaterThan(0);
  }, 120_000);

  // why: --args-file feeds the CLI the MCP tool's arguments verbatim (v0 convention); a usage error is exit 2 on stderr.
  // proves: CLAIM(IV19)
  it("accepts --args-file and reports usage errors with exit 2", async () => {
    const { dir } = await seeded();
    const file = join(dir, "args.json");
    writeFileSync(file, JSON.stringify({ repo: "vg", format: "json" }));
    const run = await runCliInProcess(["--session", dir, "types", "--args-file", file]);
    expect(run.exitCode, run.stdout.slice(0, 300) + run.stderr).toBe(0);
    expect(JSON.parse(run.stdout).tool).toBe("list_types");
    const usage = await runCliInProcess(["--session", dir, "collect", "--no-such-flag"]);
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr).toContain("--no-such-flag");
  });
});
