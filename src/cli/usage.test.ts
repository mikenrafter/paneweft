// T2 (tier-2 review S2): the README "Usage" section must be something an agent or operator can follow end to end.
// Prose cannot be tested, so the section is held to what can be: its commands exist (`--help` of every `paneweft ...` line exits 0), its
// "try it" blocks (info string `sh try`) really run in order against the committed fixtures, its MCP client config really starts an MCP
// server, the workflow it shows is the one the design prescribes, and `engines` states the Node version type stripping needs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runCliInProcess } from "../../test/helpers/cli.ts";
import { REPO_ROOT } from "../../test/helpers/fixtures.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
const README = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
const PACKAGE = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { engines: { node: string }; bin: Record<string, string> };

/** Text of the `## heading` section (up to the next `## `), or null. */
function section(heading: string, text = README, level = "##"): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `${level} ${heading}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith(`${level} `) || (level === "###" && line.startsWith("## ")));
  return rest.slice(0, end < 0 ? rest.length : end).join("\n");
}

interface Block { info: string; lines: string[] }
function fencedBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const line of text.split("\n")) {
    const fence = /^```(.*)$/.exec(line);
    if (fence !== null) {
      if (current === null) current = { info: (fence[1] as string).trim(), lines: [] };
      else { blocks.push(current); current = null; }
    } else if (current !== null) current.lines.push(line);
  }
  return blocks;
}

/** Splits one shell line into words, honouring single and double quotes (no expansion, no escapes: README lines are written to need none). */
function words(line: string): string[] {
  const out: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (const char of line) {
    if (quote !== null) { if (char === quote) quote = null; else word = (word ?? "") + char; continue; }
    if (char === "'" || char === '"') { quote = char; word ??= ""; continue; }
    if (/\s/.test(char)) { if (word !== null) { out.push(word); word = null; } continue; }
    word = (word ?? "") + char;
  }
  if (word !== null) out.push(word);
  return out;
}
/** The `paneweft ...` command lines of the blocks (comments and other lines skipped), as argv without the leading `paneweft`. */
const commandLines = (blocks: Block[]): string[][] => blocks.flatMap((block) => block.lines.filter((line) => line.startsWith("paneweft ")).map((line) => words(line).slice(1)));
/** The command words (`render`, `notebook get`, `repo add`) of an argv: leading words that are not options. */
const commandWords = (argv: string[]): string[] => {
  const skip = argv[0] === "--session" ? 2 : 0;
  const rest = argv.slice(skip);
  const first = rest[0] as string;
  return ["notebook", "example", "repo"].includes(first) ? [first, rest[1] as string] : [first];
};

const USAGE = section("Usage");

describe("README Usage section", () => {
  // why: the review found no way to get from a clone to a running tool: no install, no build step for the viewer (dist/ is gitignored), no
  //   MCP client config, no statement of the workflow. Each of these is a heading an operator will look for.
  // proves: CLAIM(readme-usage)
  it("[T2] has a Usage section with Install, Run the CLI, Agent workflow, MCP client and Repository roots subsections", () => {
    expect(USAGE, "README.md has no '## Usage' section").not.toBeNull();
    for (const heading of ["Install", "Run the CLI", "Agent workflow", "Use it from an MCP client", "Register repository roots"]) {
      expect(section(heading, USAGE ?? "", "###"), `README Usage has no '### ${heading}' subsection`).not.toBeNull();
    }
  });

  // why: install must name the viewer build, because `serve` answers 404 for every asset until `npm run build:viewer` has made dist/.
  // proves: CLAIM(readme-usage)
  it("[T2] Install shows `npm install` and `npm run build:viewer`, in that order, in a shell block", () => {
    const install = section("Install", USAGE ?? "", "###") ?? "";
    const lines = fencedBlocks(install).flatMap((block) => block.lines).map((line) => line.trim());
    const at = (needle: string) => lines.findIndex((line) => line.startsWith(needle));
    expect(at("npm install")).toBeGreaterThanOrEqual(0);
    expect(at("npm run build:viewer")).toBeGreaterThan(at("npm install"));
  });

  // why: bin.ts is run by Node's type stripping (no tsx, see bin.smoke.test.ts), which is unflagged from Node 22.18; an older `engines` lets npm
  //   accept a Node that then fails on the first import.
  // proves: CLAIM(cli-runs-under-node)
  it("[T2] package.json engines.node and the README requirement both say 22.18", () => {
    expect(PACKAGE.engines.node).toBe(">=22.18");
    expect(section("Requirements") ?? "").toContain("22.18");
    expect(README).not.toContain("22.12");
  });

  // why: a README command that does not exist (a renamed flag, a command never built) is the commonest way docs rot. Every `paneweft ...`
  //   line must name a command whose own `--help` works.
  // proves: CLAIM(readme-usage)
  it("[T2] every `paneweft ...` command line in the Usage section names a command that exists", async () => {
    const lines = commandLines(fencedBlocks(USAGE ?? ""));
    expect(lines.length, "the Usage section shows no `paneweft` command lines").toBeGreaterThan(12);
    for (const argv of lines) {
      const run = await runCliInProcess([...commandWords(argv), "--help"]);
      expect([run.exitCode, argv.join(" ")], run.stderr).toEqual([0, argv.join(" ")]);
    }
  });

  // why: the prescribed workflow is components -> describe -> validate -> render -> inspect/open/navigate (design 5); the README must show the
  //   steps in that order or an agent will render before it knows the shape.
  // proves: CLAIM(readme-usage)
  it("[T2] the Agent workflow subsection shows components, describe, validate, render, inspect, open, navigate in that order", () => {
    const flow = commandLines(fencedBlocks(section("Agent workflow", USAGE ?? "", "###") ?? "")).map((argv) => commandWords(argv)[0] as string);
    const wanted = ["components", "describe", "validate", "render", "inspect", "open", "navigate"];
    let position = 0;
    for (const word of flow) if (word === wanted[position]) position++;
    expect(wanted.slice(position), `workflow commands seen: ${flow.join(" ")}`).toEqual([]);
  });

  // why: it states how cursors and budgets work in the text an agent reads: --max-bytes with its limits, --cursor taken from the previous reply.
  // proves: CLAIM(readme-usage)
  it("[T2] the Agent workflow subsection explains --max-bytes (2048..32768) and --cursor", () => {
    const flow = section("Agent workflow", USAGE ?? "", "###") ?? "";
    expect(flow).toContain("--max-bytes");
    expect(flow).toContain("2048");
    expect(flow).toContain("32768");
    expect(flow).toContain("--cursor");
    expect(flow).toContain("cursor:");
  });

  // why: the commands of the blocks marked `sh try` are the README's promise that the steps work. They run, in order, against the committed
  //   fixtures with PANEWEFT_SESSION pointing at a fresh directory; each must succeed (exit 0).
  // proves: CLAIM(readme-usage)
  it("[T2] the `sh try` blocks run in order against the fixtures and every command exits 0", async () => {
    const tries = fencedBlocks(USAGE ?? "").filter((block) => block.info === "sh try");
    expect(tries.length, "no ```sh try block in the Usage section").toBeGreaterThanOrEqual(1);
    const env = { PANEWEFT_SESSION: join(tmp("readme"), "session") };
    const argvs = commandLines(tries);
    expect(argvs.length).toBeGreaterThanOrEqual(6);
    for (const argv of argvs) {
      const run = await runCliInProcess(argv, { env, cwd: REPO_ROOT });
      expect([run.exitCode, argv.join(" ")], run.stdout.slice(0, 400) + run.stderr).toEqual([0, argv.join(" ")]);
    }
  });
});

describe("README MCP client configuration", () => {
  // why: an MCP client is configured with a command and args; the block the README gives must start a real paneweft MCP server (initialize
  //   succeeds, the twenty-three tools (thirteen v0, ten v1) are listed) when its two placeholders are replaced by the repository and a session directory.
  // proves: CLAIM(readme-usage)
  it("[T2] the `json mcp-config` block launches a server that lists the tools", async () => {
    const block = fencedBlocks(section("Use it from an MCP client", USAGE ?? "", "###") ?? "").find((candidate) => candidate.info === "json mcp-config");
    expect(block, "no ```json mcp-config block").toBeDefined();
    const config = JSON.parse((block as Block).lines.join("\n")) as { mcpServers: Record<string, { command: string; args: string[] }> };
    const entry = config.mcpServers.paneweft;
    expect(entry, "mcpServers.paneweft").toBeDefined();
    const session = join(tmp("readme-mcp"), "session");
    const args = (entry as { args: string[] }).args.map((arg) => arg.replace("/path/to/paneweft", REPO_ROOT).replace("/path/to/session", session));
    expect(args.join(" ")).not.toContain("/path/to/");
    expect(args).toContain("mcp");
    const { NODE_OPTIONS: _dropped, ...env } = process.env;
    const transport = new StdioClientTransport({ command: (entry as { command: string }).command, args, env: env as Record<string, string>, stderr: "pipe" });
    const client = new Client({ name: "readme-check", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe("paneweft");
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain("render");
      expect(listed.tools).toHaveLength(23);
    } finally {
      await client.close().catch(() => {});
    }
  });
});
