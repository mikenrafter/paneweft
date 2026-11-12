// `paneweft` command line (design section 5). Every operation command is a thin adapter over
// executeOperation and accepts the MCP tool's arguments verbatim as `--args '<json>'`,
// `--args-file FILE` or `--args-file -` (stdin), so CLI and MCP can be fed the same request bytes.
// Ergonomic flags are sugar for the same arguments. docs/red-contract.md "CLI" is normative.
//
// Exit codes: 0 ok; 1 operation error (error body on stdout); 2 usage error (message on stderr).
//
// CLAIM(cli-is-an-adapter): this file only turns argv into the tool's argument object and prints the operation's body; validation,
//   budgets, cursors and errors all come from executeOperation, so CLI and MCP bodies for one request are byte-identical
//   [test/parity.test.ts, MC11]. The two exceptions are `example run` (it executes an owner runner, which only the CLI may do) and the
//   long-running `serve` / `mcp` commands.
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { executeOperation, type OperationOutcome } from "../core/operations.ts";
import { boundError, replyBudget } from "../core/reply-budget.ts";
import { openSession, type Session } from "../core/session.ts";
import { runExample } from "../core/runner.ts";
import type { OperationError } from "../core/errors.ts";
import type { ToolName } from "../schemas/index.ts";
import { V1_COMMANDS, type V1Command } from "./v1-commands.ts";
import { executeV1Operation } from "../v1/tools.ts";
import { V1_TOOL_NAMES, type V1ToolName } from "../v1/schemas.ts";
import { loadAdapters, registerAdapter } from "../v1/adapters.ts";
import type { JobService } from "../v1/jobs.ts";
import { createSessionJobService } from "../v1/service.ts";
import { digestRenderer, identifyRenderer, openTrustStore } from "../v1/renderer.ts";
import { INVENTORY_FILE, formatInventory, loadInventory, rejectedCataloguePath, updateInventory, type RejectedCatalogue } from "../v1/inventory.ts";
import { writeDurably } from "../v1/durable.ts";
import type { Catalogue } from "../generated/v1/Catalogue.ts";

export interface CliIo {
  stdin: string | null;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** `true` hands each job to a detached driver (F20), as the bin entry does; absent, nothing is spawned (in-process callers poll). */
  drive?: boolean;
}

class UsageError extends Error {}

type Sugar = (value: string, args: Record<string, unknown>) => void;
interface Command {
  words: string[];
  summary: string;
  tool?: ToolName | V1ToolName;
  /** value flags besides the common ones */
  flags: Record<string, Sugar>;
  /** repeatable value flags (collected by name) */
  repeatable?: string[];
  /** flags that take no value (their presence is the setting) */
  switches?: string[];
  positional?: { name: string };
  /** v1: the tool argument the positional fills (collection status JOB, failure DIAGNOSTIC). */
  positionalArgument?: string;
  /** One concrete invocation, runnable from the repository root against the committed fixtures; shown by `--help` (#2). */
  example: string;
}

const COMMON_FLAGS = ["--args", "--args-file", "--format", "--max-bytes", "--cursor"] as const;

function setOnce(args: Record<string, unknown>, key: string, value: unknown, flag: string): void {
  if (key in args) throw new UsageError(`${flag} sets "${key}", which --args already gives; use one of them`);
  args[key] = value;
}

const COMMANDS: Command[] = [
  { words: ["components"], summary: "list the supported components and their questions", tool: "list_components", flags: { "--capability": (v, a) => setOnce(a, "capability", v, "--capability") }, example: "paneweft components --capability focus-neighborhood" },
  { words: ["describe"], summary: "describe one component: schema, limits, a valid example", tool: "describe_component", flags: { "--component": (v, a) => setOnce(a, "component", v, "--component") }, positional: { name: "COMPONENT" }, example: "paneweft describe graph" },
  { words: ["validate"], summary: "validate an envelope or bundle without storing it", tool: "validate", flags: { "--file": () => undefined }, example: "paneweft validate --file fixtures/components/all.bundle.json" },
  { words: ["render"], summary: "validate, store and summarise an envelope or bundle", tool: "render", flags: { "--file": () => undefined }, example: "paneweft render --file fixtures/components/all.bundle.json" },
  { words: ["register"], summary: "register a view definition against an expected registry revision", tool: "register_view", flags: { "--file": () => undefined, "--expected-revision": () => undefined }, example: "paneweft register --file fixtures/wire/definition-valid.json --expected-revision 0" },
  { words: ["open"], summary: "open an entity at a snapshot: pane state, views and a bounded answer", tool: "open_entity", flags: {}, example: "paneweft open --args-file fixtures/wire/open-entity-watch.json" },
  { words: ["navigate"], summary: "follow an item of a pane to its target", tool: "navigate", flags: {}, example: "paneweft navigate --args '{\"pane\":{\"entity\":{\"repository\":\"r\",\"kind\":\"vigil/watch\",\"id\":\"watch\"},\"snapshotId\":\"snap-1\",\"viewDefinitionId\":\"def-modules\",\"selection\":[],\"filters\":{},\"pinned\":false},\"itemId\":\"mcp\"}'" },
  { words: ["inspect"], summary: "a bounded slice of a stored view (filter, order, focus, cursor)", tool: "inspect_view", flags: { "--view": (v, a) => setOnce(a, "viewId", v, "--view"), "--snapshot": (v, a) => setOnce(a, "snapshotId", v, "--snapshot") }, example: "paneweft inspect --view modules --snapshot snap-1 --max-bytes 2048" },
  { words: ["search"], summary: "search entities, view titles, examples and claims", tool: "search", flags: { "--query": (v, a) => setOnce(a, "query", v, "--query") }, example: "paneweft search --query cancellation" },
  { words: ["notebook", "create"], summary: "create a notebook page", tool: "notebook_create", flags: { "--file": () => undefined }, example: "paneweft notebook create --file fixtures/components/notebook.json" },
  { words: ["notebook", "get"], summary: "read a notebook page", tool: "notebook_get", flags: { "--page": (v, a) => setOnce(a, "pageId", v, "--page"), "--snapshot": (v, a) => setOnce(a, "snapshotId", v, "--snapshot"), "--revision": () => undefined }, example: "paneweft notebook get --page cancellation-notebook" },
  { words: ["notebook", "update"], summary: "replace a notebook page's blocks against an expected revision", tool: "notebook_update", flags: {}, example: "paneweft notebook update --args-file fixtures/wire/notebook-update-a.json" },
  { words: ["example", "record"], summary: "record one run of an example with its result bundle", tool: "example_record", flags: {}, example: "paneweft example record --args-file fixtures/wire/example-record-valid.json" },
  { words: ["example", "run"], summary: "run an owner-registered runner and record its result", flags: { "--runners": () => undefined, "--view": () => undefined, "--snapshot": () => undefined, "--format": () => undefined }, repeatable: ["--param"], positional: { name: "RUNNER_ID" }, example: "paneweft example run pass --view vigil-one-write --snapshot snap-1 --runners runners.json --param name=value" },
  { words: ["repo", "add"], summary: "register a repository root (ID=ROOT) so freshness can be checked; CLI only", flags: {}, positional: { name: "ID=ROOT" }, example: "paneweft repo add r=." },
  { words: ["repo", "list"], summary: "list the registered repository roots", flags: { "--format": () => undefined }, example: "paneweft repo list --format json" },
  { words: ["serve"], summary: "serve the local viewer for a session", flags: { "--host": () => undefined, "--port": () => undefined, "--assets": () => undefined }, repeatable: ["--repo"], example: "paneweft serve --port 0 --repo r=." },
  { words: ["mcp"], summary: "serve the tools over stdio MCP", flags: {}, example: "paneweft mcp" },
];
const TOP_LEVEL = ["components", "describe", "validate", "render", "register", "open", "navigate", "inspect", "search", "notebook", "example", "repo", "serve", "mcp", "types", "views", "examples", "scaffold", "collect", "collection", "result", "failure", "adapter", "renderers", "catalogue", "inventory"];

// ---- v1: the agent tools (kebab-case words over the same handlers as MCP) and the owner-only commands ---------------------------------

const V1_SUMMARY: Record<V1ToolName, string> = {
  list_types: "list the types of a repository with their views and examples (reads the catalogue, runs nothing)",
  list_views_for_type: "list the views of one type: questions, sources, examples, last capture (runs nothing)",
  list_examples: "list example definitions with claims, selectors and last outcomes (runs nothing)",
  scaffold_view: "print a source patch and a failing output test for a new view (writes nothing)",
  scaffold_example: "print an example patch with an unimplemented assertion (writes nothing)",
  collect: "run registered examples through the owner's adapter and the qex queue (EXECUTES repository code)",
  collection_status: "read a collection job: state, counts, diagnostics, snapshots (waits up to 30 s)",
  cancel_collection: "cancel a collection job through qex",
  view_result: "read a stored view of a run or job as bounded text",
  explain_failure: "explain a stored diagnostic with its evidence and a next action",
};
const V1_POSITIONAL: Partial<Record<V1ToolName, { name: string; argument: string }>> = {
  collection_status: { name: "JOB", argument: "job" },
  cancel_collection: { name: "JOB", argument: "job" },
  explain_failure: { name: "DIAGNOSTIC", argument: "diagnostic" },
};
const V1_INTEGER_ARGUMENTS = new Set(["waitSeconds", "evidencePage"]);

function v1Command(spec: V1Command): Command {
  const flags: Record<string, Sugar> = {};
  const repeatable: string[] = [];
  for (const [flag, argument] of Object.entries(spec.flags)) {
    if (argument === "examples") repeatable.push(flag);
    else flags[flag] = (value, args) => {
      if (V1_INTEGER_ARGUMENTS.has(argument)) {
        if (!/^\d+$/.test(value)) throw new UsageError(`${flag} must be a non-negative integer, not "${value}"`);
        setOnce(args, argument, Number(value), flag);
      } else setOnce(args, argument, value, flag);
    };
  }
  const positional = V1_POSITIONAL[spec.tool];
  return { words: spec.words, summary: V1_SUMMARY[spec.tool], tool: spec.tool, flags, ...(repeatable.length > 0 ? { repeatable } : {}), ...(positional === undefined ? {} : { positional: { name: positional.name }, positionalArgument: positional.argument }), example: spec.example };
}

const OWNER_COMMANDS: Command[] = [
  { words: ["adapter", "add"], summary: "register a collection adapter record (owner decision; CLI only)", flags: { "--file": () => undefined }, example: "paneweft adapter add --file fixtures/v1/adapters/cargo.json" },
  { words: ["adapter", "list"], summary: "list the registered adapters", flags: { "--format": () => undefined }, example: "paneweft adapter list --format json" },
  { words: ["renderers", "trust"], summary: "trust a repo-owned renderer by its content digest (owner decision; CLI only)", flags: { "--repo": () => undefined, "--id": () => undefined, "--digest": () => undefined }, example: "paneweft renderers trust --repo cm --id mapping-card --digest e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  { words: ["renderers", "digest"], summary: "print the asset digest and the payload schema digest of a renderer directory, and the declaration that names them (CLI only)", flags: { "--repo": () => undefined, "--id": () => undefined, "--format": () => undefined }, example: "paneweft renderers digest --repo cm --id mapping-card" },
  { words: ["renderers", "list"], summary: "list the renderers under a registered root with their digests and trust", flags: { "--repo": () => undefined, "--format": () => undefined }, example: "paneweft renderers list --repo cm" },
  { words: ["inventory", "update"], summary: "write paneweft.inventory.json from the stored catalogue: lists every id the catalogue has, keeps declared ids it lacks unless --prune (owner/developer command; CLI only)", flags: { "--repo": () => undefined, "--adapter": () => undefined }, switches: ["--prune"], example: "paneweft inventory update --repo vg --adapter cargo" },
  { words: ["catalogue", "refresh"], summary: "rebuild the stored catalogue ahead of time by running the reserved export tests through qex (owner/developer command; a collect exports it itself)", flags: { "--repo": () => undefined, "--adapter": () => undefined, "--request-id": () => undefined }, example: "paneweft catalogue refresh --repo vg --adapter cargo" },
];
COMMANDS.push(...V1_COMMANDS.map(v1Command), ...OWNER_COMMANDS);
const GROUP_SUMMARY: Record<string, string> = { notebook: "create, get and update notebook pages", repo: "register and list repository roots (CLI only)", example: "record or run examples", scaffold: "print a patch for a new view or example (writes nothing)", collection: "status and cancel of collection jobs", adapter: "register and list collection adapters (CLI only)", renderers: "trust, list and digest repo-owned renderers (CLI only)", catalogue: "refresh the compiled catalogue", inventory: "write the checked-in view inventory from the stored catalogue (CLI only)" };


function helpText(): string {
  const width = Math.max(...TOP_LEVEL.map((word) => word.length));
  const lines = TOP_LEVEL.map((word) => {
    const first = COMMANDS.find((command) => command.words[0] === word) as Command;
    const summary = first.words.length === 1 ? first.summary : (GROUP_SUMMARY[word] ?? "record or run examples");
    return `  ${word.padEnd(width)}  ${summary}`;
  });
  return [
    "paneweft - portable moldable views for coding agents",
    "",
    "usage: paneweft [--session DIR] <command> [options]",
    "",
    "commands:",
    ...lines,
    "",
    "common options: --args JSON | --args-file FILE|-  --format text|json  --max-bytes N  --cursor TOKEN",
    "The session directory defaults to $PANEWEFT_SESSION. Run `paneweft <command> --help` for a command.",
    "",
  ].join("\n");
}

function commandHelp(words: string[]): string {
  const subcommands = COMMANDS.filter((command) => command.words.length === 2 && command.words[0] === words[0]);
  if (words.length === 1 && subcommands.length > 0) {
    return [`usage: paneweft ${words[0]} <subcommand> [options]`, "", "subcommands:", ...subcommands.map((command) => `  ${command.words[1]}  ${command.summary}`), ""].join("\n");
  }
  const command = COMMANDS.find((candidate) => candidate.words.join(" ") === words.join(" ")) as Command;
  const flags = [...(command.tool === undefined ? [] : COMMON_FLAGS), ...Object.keys(command.flags), ...(command.repeatable ?? []), ...(command.switches ?? [])];
  const lines = [`usage: paneweft ${command.words.join(" ")}${command.positional ? ` ${command.positional.name}` : ""} [options]`, "", command.summary];
  if (flags.length > 0) lines.push("", `options: ${flags.join(" ")}`);
  lines.push("", `example: ${command.example}`);
  return lines.join("\n") + "\n";
}

interface Parsed {
  session: string | undefined;
  command: Command;
  values: Map<string, string>;
  repeated: Map<string, string[]>;
  positional: string[];
}

function parseArguments(argv: string[]): Parsed | { help: string } {
  let session: string | undefined;
  let index = 0;
  const valueOf = (flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    index++;
    return value;
  };
  // 1. global options, then the command word
  let first: string | undefined;
  for (; index < argv.length; index++) {
    const token = argv[index] as string;
    if (token === "--help" || token === "-h") return { help: helpText() };
    if (token === "--session") { session = valueOf("--session"); continue; }
    if (token.startsWith("-")) throw new UsageError(`unknown option ${token}`);
    first = token;
    index++;
    break;
  }
  if (first === undefined) throw new UsageError("no command given; run `paneweft --help`");
  const group = COMMANDS.filter((command) => command.words[0] === first);
  if (group.length === 0) throw new UsageError(`unknown command "${first}"; run \`paneweft --help\``);
  // 2. the subcommand of a two-level command
  let words = [first];
  if ((group[0] as Command).words.length === 2) {
    const next = argv[index];
    if (next === "--help" || next === "-h") return { help: commandHelp([first]) };
    if (next === undefined || next.startsWith("-")) throw new UsageError(`${first} needs a subcommand: ${group.map((command) => command.words[1]).join(", ")}`);
    if (!group.some((command) => command.words[1] === next)) throw new UsageError(`unknown subcommand "${next}" of ${first}; expected ${group.map((command) => command.words[1]).join(", ")}`);
    words = [first, next];
    index++;
  }
  const command = COMMANDS.find((candidate) => candidate.words.join(" ") === words.join(" ")) as Command;
  // 3. the command's own options and positionals
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const positional: string[] = [];
  const allowed = new Set<string>([...(command.tool !== undefined ? COMMON_FLAGS : []), ...Object.keys(command.flags), ...(command.repeatable ?? []), ...(command.switches ?? [])]);
  for (; index < argv.length; index++) {
    const token = argv[index] as string;
    if (token === "--help" || token === "-h") return { help: commandHelp(command.words) };
    if (token === "--session") { session = valueOf("--session"); continue; }
    if (token.startsWith("-")) {
      if (!allowed.has(token)) throw new UsageError(`unknown option ${token} for ${command.words.join(" ")}`);
      if ((command.switches ?? []).includes(token)) { values.set(token, "true"); continue; }
      const value = valueOf(token);
      if ((command.repeatable ?? []).includes(token)) repeated.set(token, [...(repeated.get(token) ?? []), value]);
      else values.set(token, value);
      continue;
    }
    if (command.positional !== undefined && positional.length === 0) { positional.push(token); continue; }
    throw new UsageError(`unexpected argument "${token}" for ${command.words.join(" ")}`);
  }
  return { session, command, values, repeated, positional };
}

async function readJson(source: string, label: string, io: CliIo, path: string | null): Promise<unknown> {
  let text: string;
  if (path === "-") text = io.stdin ?? "";
  else if (path !== null) {
    try {
      text = await readFile(resolve(io.cwd, path), "utf8");
    } catch {
      throw new UsageError(`${label} cannot read ${path}`);
    }
  } else text = source;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${label}${path === null ? "" : ` ${path}`} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function buildArguments(parsed: Parsed, io: CliIo): Promise<Record<string, unknown>> {
  const { command, values } = parsed;
  if (values.has("--args") && values.has("--args-file")) throw new UsageError("--args and --args-file both give the request; use one of them");
  let args: Record<string, unknown> = {};
  if (values.has("--args")) {
    const parsedArgs = await readJson(values.get("--args") as string, "--args", io, null);
    if (parsedArgs === null || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) throw new UsageError("--args must be a JSON object");
    args = parsedArgs as Record<string, unknown>;
  } else if (values.has("--args-file")) {
    const parsedArgs = await readJson("", "--args-file", io, values.get("--args-file") as string);
    if (parsedArgs === null || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) throw new UsageError("--args-file must contain a JSON object");
    args = parsedArgs as Record<string, unknown>;
  }
  for (const [flag, sugar] of Object.entries(command.flags)) {
    const value = values.get(flag);
    if (value === undefined) continue;
    if (flag === "--file") {
      const document = await readJson("", "--file", io, value);
      if (command.tool === "register_view") setOnce(args, "definition", document, "--file");
      else setOnce(args, "input", document, "--file");
    } else if (flag === "--expected-revision") {
      if (!/^\d+$/.test(value)) throw new UsageError("--expected-revision must be a non-negative integer");
      setOnce(args, "expectedRevision", Number(value), "--expected-revision");
    } else if (flag === "--revision") {
      if (!/^[1-9]\d*$/.test(value)) throw new UsageError("--revision must be a positive integer");
      setOnce(args, "revision", Number(value), "--revision");
    } else sugar(value, args);
  }
  const v1Positional = V1_POSITIONAL[command.tool as V1ToolName];
  if (v1Positional !== undefined && parsed.positional[0] !== undefined) setOnce(args, v1Positional.argument, parsed.positional[0], v1Positional.name);
  const v1Examples = parsed.repeated.get("--example");
  if (v1Examples !== undefined && command.tool === "collect") setOnce(args, "examples", v1Examples, "--example");
  if (command.tool === "describe_component" && parsed.positional[0] !== undefined) {
    const given = parsed.positional[0];
    if ("component" in args && args.component !== given) throw new UsageError(`describe got the component "${given}" as an argument but "${String(args.component)}" from --component/--args; give it once`);
    args.component = given;
  }
  if (command.tool === "register_view" && !values.has("--args") && !values.has("--args-file")) {
    if (!values.has("--file")) throw new UsageError("register needs --file DEFINITION.json (or --args)");
    if (!values.has("--expected-revision")) throw new UsageError("register needs --expected-revision N (or --args)");
  }
  if (values.has("--format")) {
    const format = values.get("--format") as string;
    if (format !== "text" && format !== "json") throw new UsageError(`--format must be text or json, not "${format}"`);
    setOnce(args, "format", format, "--format");
  }
  if (values.has("--max-bytes")) {
    const text = values.get("--max-bytes") as string;
    if (!/^-?\d+$/.test(text)) throw new UsageError(`--max-bytes must be a base-10 integer, not "${text}"`);
    setOnce(args, "maxBytes", Number(text), "--max-bytes");
  }
  if (values.has("--cursor")) setOnce(args, "cursor", values.get("--cursor"), "--cursor");
  return args;
}

function print(io: CliIo, outcome: OperationOutcome): number {
  io.stdout(outcome.body);
  return outcome.ok ? 0 : 1;
}

/** Prints an error that did not come from an operation, within the default reply budget (these commands take no --max-bytes). */
function printError(error: OperationError, io: CliIo): number {
  io.stdout(JSON.stringify(boundError(error, replyBudget(undefined))));
  return 1;
}

function errorBody(code: OperationError["code"], message: string, io: CliIo): number {
  return printError({ schemaVersion: "paneweft.error/1", code, message, errors: [], retryable: false }, io);
}

async function runExampleCommand(parsed: Parsed, session: Session | null, io: CliIo): Promise<number> {
  const runnerId = parsed.positional[0];
  if (runnerId === undefined) throw new UsageError("example run needs a runner id");
  const view = parsed.values.get("--view");
  const snapshot = parsed.values.get("--snapshot");
  if (view === undefined) throw new UsageError("example run needs --view VIEW_ID");
  if (snapshot === undefined) throw new UsageError("example run needs --snapshot SNAPSHOT_ID");
  const parameters: Record<string, string | number | boolean | null> = {};
  for (const entry of parsed.repeated.get("--param") ?? []) {
    const at = entry.indexOf("=");
    if (at <= 0) throw new UsageError(`--param needs name=value, not "${entry}"`);
    const raw = entry.slice(at + 1);
    let value: string | number | boolean | null = raw;
    try {
      const parsedValue = JSON.parse(raw) as unknown;
      if (parsedValue === null || ["string", "number", "boolean"].includes(typeof parsedValue)) value = parsedValue as string | number | boolean | null;
    } catch { /* a plain string */ }
    parameters[entry.slice(0, at)] = value;
  }
  const format = parsed.values.get("--format") ?? "text";
  if (format !== "text" && format !== "json") throw new UsageError(`--format must be text or json, not "${format}"`);
  if (session === null) return errorBody("SESSION_REQUIRED", "example run needs a session; pass --session DIR (or set PANEWEFT_SESSION)", io);
  const registry = parsed.values.get("--runners") ?? io.env.PANEWEFT_RUNNERS;
  if (registry === undefined) return errorBody("RUNNER_NOT_FOUND", "no runner registry is configured; pass --runners FILE (or set PANEWEFT_RUNNERS)", io);
  // The runner leads its own process group (runner.ts), so the terminal's Ctrl-C (or hang-up) does not reach it: stop it ourselves.
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop); // the terminal or ssh session closing: its default action would kill the CLI and leave the runner's group running
  let result: Awaited<ReturnType<typeof runExample>>;
  try {
    result = await runExample(session, { runnerRegistryFile: resolve(io.cwd, registry), runnerId, parameters, key: { viewId: view, snapshotId: snapshot }, signal: abort.signal });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
  }
  if (!result.ok) return printError(result.error, io);
  const run = result.value;
  io.stdout(format === "json" ? JSON.stringify({ schemaVersion: "paneweft.example_run/1", recorded: run }) : `recorded run ${run.runId}: ${run.status}\nview: ${run.viewId}@${run.snapshotId}\n`);
  return 0;
}

/** `repo add ID=ROOT` / `repo list`: repository roots decide whether freshness can be verified. CLI only: no MCP tool can name a directory to trust. */
async function repoCommand(parsed: Parsed, session: Session | null, io: CliIo): Promise<number> {
  const word = parsed.command.words.join(" ");
  if (session === null) throw new UsageError(`${word} needs --session DIR (or PANEWEFT_SESSION)`);
  if (word === "repo add") {
    const entry = parsed.positional[0];
    const at = entry === undefined ? -1 : entry.indexOf("=");
    if (entry === undefined || at <= 0 || at === entry.length - 1) throw new UsageError(`repo add needs ID=ROOT, not ${entry === undefined ? "nothing" : `"${entry}"`}`);
    const root = resolve(io.cwd, entry.slice(at + 1));
    const registered = await session.registerRepository({ id: entry.slice(0, at), root });
    if (!registered.ok) return printError(registered.error, io);
    io.stdout(`registered ${entry.slice(0, at)} -> ${root}\n`);
    return 0;
  }
  const format = parsed.values.get("--format") ?? "text";
  if (format !== "text" && format !== "json") throw new UsageError(`--format must be text or json, not "${format}"`);
  const repositories = await session.repositories();
  io.stdout(format === "json" ? JSON.stringify({ schemaVersion: "paneweft.repositories/1", repositories }) : repositories.map((repository) => `${repository.id}=${repository.root}\n`).join(""));
  return 0;
}

async function serveCommand(parsed: Parsed, session: Session | null, io: CliIo, dir: string | undefined): Promise<number> {
  if (session === null) throw new UsageError("serve needs --session DIR (or PANEWEFT_SESSION)");
  for (const entry of parsed.repeated.get("--repo") ?? []) {
    const at = entry.indexOf("=");
    if (at <= 0) throw new UsageError(`--repo needs id=ROOT, not "${entry}"`);
    const registered = await session.registerRepository({ id: entry.slice(0, at), root: resolve(io.cwd, entry.slice(at + 1)) });
    if (!registered.ok) return errorBody(registered.error.code, registered.error.message, io);
  }
  const port = parsed.values.get("--port");
  if (port !== undefined && !/^\d+$/.test(port)) throw new UsageError(`--port must be an integer, not "${port}"`);
  const { startViewer } = await import("../viewer/server.ts");
  const started = await startViewer({
    session,
    ...(dir === undefined || dir === "" ? {} : { sessionDirectory: resolve(io.cwd, dir) }),
    ...(parsed.values.has("--host") ? { host: parsed.values.get("--host") as string } : {}),
    ...(port === undefined ? {} : { port: Number(port) }),
    ...(parsed.values.has("--assets") ? { assetsDirectory: resolve(io.cwd, parsed.values.get("--assets") as string) } : {}),
  });
  if (!started.ok) return printError(started.error, io);
  const server = started.value;
  io.stdout(`paneweft viewer: ${server.urlFor()}\n`);
  await new Promise<void>((resolveStop) => {
    const stop = () => resolveStop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await server.close();
  return 0;
}

// ---- v1 wiring ------------------------------------------------------------------------------------------------------------------

async function v1Context(session: Session | null, dir: string | undefined, io: CliIo): Promise<{ session: Session | null; sessionDir: string | null; jobs: JobService | null }> {
  if (session === null || dir === undefined || dir === "") return { session: null, sessionDir: null, jobs: null };
  const sessionDir = resolve(io.cwd, dir);
  const jobs = await createSessionJobService(session, sessionDir, { drive: io.drive === true });
  return { session, sessionDir, jobs };
}

function required(parsed: Parsed, flag: string): string {
  const value = parsed.values.get(flag);
  if (value === undefined) throw new UsageError(`${parsed.command.words.join(" ")} needs ${flag}`);
  return value;
}

/** Owner-only commands: registering an adapter, trusting a renderer digest and compiling a catalogue. No MCP tool mirrors them. */
async function ownerCommand(parsed: Parsed, session: Session | null, dir: string | undefined, io: CliIo): Promise<number> {
  const word = parsed.command.words.join(" ");
  if (session === null || dir === undefined || dir === "") throw new UsageError(`${word} needs --session DIR (or PANEWEFT_SESSION)`);
  const sessionDir = resolve(io.cwd, dir);
  const format = parsed.values.get("--format") ?? "text";
  if (format !== "text" && format !== "json") throw new UsageError(`--format must be text or json, not "${format}"`);
  if (word === "adapter add") {
    const record = await readJson("", "--file", io, required(parsed, "--file"));
    const registered = await registerAdapter(sessionDir, record);
    if (!registered.ok) return printError(registered.error, io);
    io.stdout(`registered adapter ${registered.value.id} for ${registered.value.repo} (${registered.value.grammar})\n`);
    return 0;
  }
  if (word === "adapter list") {
    const adapters = await loadAdapters(sessionDir);
    if (!adapters.ok) return printError(adapters.error, io);
    io.stdout(format === "json" ? JSON.stringify({ schemaVersion: "paneweft.adapters/1", adapters: adapters.value }) : adapters.value.map((adapter) => `${adapter.id} repo=${adapter.repo} ${adapter.grammar} ${adapter.executable} root=${adapter.workspaceRoot}/${adapter.entry} features=${adapter.features.join(",") || "none"}\n`).join(""));
    return 0;
  }
  if (word === "renderers trust" || word === "renderers list" || word === "renderers digest") {
    const repo = required(parsed, "--repo");
    const root = (await session.repositories()).find((candidate) => candidate.id === repo);
    if (root === undefined) return errorBody("REPOSITORY_NOT_REGISTERED", `repository "${repo}" has no registered root; run: paneweft repo add ${repo}=<dir>`, io);
    const renderers = resolve(root.root, "renderers");
    const trust = openTrustStore(sessionDir);
    if (word === "renderers digest") {
      const id = required(parsed, "--id");
      const identity = await identifyRenderer(renderers, id);
      if (!identity.ok) return printError(identity.error, io);
      const { assetDigest, payloadSchemaDigest, apiVersion } = identity.value;
      const declaration = `defineRenderer({ id: ${JSON.stringify(id)}, apiVersion: ${apiVersion}, assetDigest: ${JSON.stringify(assetDigest)}, payloadSchemaDigest: ${JSON.stringify(payloadSchemaDigest)} })`;
      const rust = `paneweft::Renderer::<Payload>::new(${JSON.stringify(id)}, ${apiVersion}, ${JSON.stringify(assetDigest)}, ${JSON.stringify(payloadSchemaDigest)})`;
      const trusted = await trust.isTrusted({ repo, id, digest: assetDigest });
      io.stdout(format === "json"
        ? JSON.stringify({ schemaVersion: "paneweft.renderer-digests/1", repo, id, apiVersion, assetDigest, payloadSchemaDigest, trusted, declarations: { typescript: declaration, rust } })
        : [`renderer ${id} of ${repo} (apiVersion ${apiVersion}, ${trusted ? "trusted" : "not trusted"})`, `assetDigest: ${assetDigest}`, `payloadSchemaDigest: ${payloadSchemaDigest}`, `TypeScript: ${declaration}`, `Rust: ${rust}`, `then collect again; the owner reviews the files and runs: paneweft renderers trust --repo ${repo} --id ${id} --digest ${assetDigest}`, ""].join("\n"));
      return 0;
    }
    if (word === "renderers trust") {
      const id = required(parsed, "--id");
      const digest = required(parsed, "--digest");
      const current = await digestRenderer(renderers, id);
      if (!current.ok) return printError(current.error, io);
      if (current.value.digest !== digest) return errorBody("CONFLICT", `the renderer "${id}" has digest ${current.value.digest} now, not ${digest}: review the current files and trust that digest`, io);
      const trusted = await trust.trust({ repo, id, digest });
      if (!trusted.ok) return printError(trusted.error, io);
      io.stdout(`trusted ${repo}/${id} at ${digest}\n`);
      return 0;
    }
    const { readdir } = await import("node:fs/promises");
    const rows: Array<{ id: string; digest: string | null; trusted: boolean }> = [];
    for (const name of (await readdir(renderers).catch(() => [])).sort()) {
      const digested = await digestRenderer(renderers, name);
      rows.push({ id: name, digest: digested.ok ? digested.value.digest : null, trusted: digested.ok && (await trust.isTrusted({ repo, id: name, digest: digested.value.digest })) });
    }
    io.stdout(format === "json" ? JSON.stringify({ schemaVersion: "paneweft.renderers/1", repo, renderers: rows }) : rows.map((row) => `${row.id} ${row.digest ?? "(incomplete)"} ${row.trusted ? "trusted" : "untrusted"}\n`).join(""));
    return 0;
  }
  if (word === "inventory update") {
    const repo = required(parsed, "--repo");
    const adapterId = required(parsed, "--adapter");
    const loaded = await loadAdapters(sessionDir);
    if (!loaded.ok) return printError(loaded.error, io);
    const adapter = loaded.value.find((candidate) => candidate.repo === repo && candidate.id === adapterId);
    if (adapter === undefined) return errorBody("NOT_FOUND", `no adapter "${adapterId}" is registered for repository "${repo}": ${loaded.value.map((candidate) => `${candidate.repo}/${candidate.id}`).join(", ") || "none registered"}`, io);
    // S1: the export the inventory check rejected is the latest one and holds the author's intended addition or removal; the stored catalogue is the last ACCEPTED export
    const rejected = await readFile(rejectedCataloguePath(sessionDir, repo, adapterId), "utf8").then((text) => JSON.parse(text) as RejectedCatalogue, () => undefined);
    const stored = await readFile(resolve(sessionDir, "catalogues", repo, `${adapterId}.json`), "utf8").then((text) => JSON.parse(text) as { catalogue: Catalogue }, () => undefined);
    if (rejected === undefined && stored === undefined) return errorBody("NOT_FOUND", `no catalogue is stored for ${repo}/${adapterId} and no export was rejected: run \`paneweft catalogue refresh --repo ${repo} --adapter ${adapterId}\` or collect an example first (either exports the catalogue), then update the inventory`, io);
    const source = rejected?.catalogue ?? (stored as { catalogue: Catalogue }).catalogue;
    const root = resolve(adapter.workspaceRoot, adapter.entry);
    const current = await loadInventory(root);
    if (!current.ok) return errorBody("INVALID_ARGUMENT", current.message, io);
    const update = updateInventory(source, current.value, parsed.values.has("--prune"));
    await writeDurably(resolve(root, INVENTORY_FILE), formatInventory(update.inventory, await readFile(resolve(root, INVENTORY_FILE), "utf8").catch(() => undefined)));
    // the stored record carries the inventory it was exported against and the ids that file did not list; both now describe the file just written (a rejected export is not the stored record: the next refresh stores it)
    if (rejected === undefined && stored !== undefined) {
      const { inventoryDrift: _drift, ...record } = stored as unknown as Record<string, unknown>;
      await writeDurably(resolve(sessionDir, "catalogues", repo, `${adapterId}.json`), JSON.stringify({ ...record, inventory: update.inventory }));
    }
    const parts = [`inventory ${resolve(root, INVENTORY_FILE)}${rejected === undefined ? "" : ` (from the export rejected at ${rejected.rejectedAt}; refresh the catalogue to accept it)`}: added ${update.added.views.length} views and ${update.added.examples.length} examples`];
    if (update.changed.length > 0) parts.push(`updated the module or type of ${update.changed.join(", ")}`);
    if (update.pruned.length > 0) parts.push(`dropped ${update.pruned.join(", ")}`);
    else if (update.missing.length > 0) parts.push(`kept ${update.missing.join(", ")}, which the catalogue lacks (pass --prune to drop them once the removal is intended)`);
    io.stdout(`${parts.join("; ")}\n`);
    return 0;
  }
  // catalogue refresh
  const context = await v1Context(session, dir, io);
  const jobs = context.jobs;
  if (jobs === null) throw new UsageError("catalogue refresh needs a session");
  const requestId = parsed.values.get("--request-id") ?? `catalogue-${required(parsed, "--repo")}-${required(parsed, "--adapter")}-${Date.now().toString(36)}`;
  const started = await jobs.refreshCatalogue({ requestId, repo: required(parsed, "--repo"), adapter: required(parsed, "--adapter") });
  if (!started.ok) return printError(started.error, io);
  for (;;) {
    const status = await jobs.status(requestId, { waitSeconds: 30 });
    if (!status.ok) return printError(status.error, io);
    if (["succeeded", "failed", "cancelled"].includes(status.value.state)) {
      io.stdout(`catalogue refresh ${requestId}: ${status.value.state}${status.value.diagnosticIds.length > 0 ? `; diagnostics ${status.value.diagnosticIds.join(", ")} (paneweft failure <id>)` : ""}\n`);
      return status.value.state === "succeeded" ? 0 : 1;
    }
    if (status.value.state === "indeterminate") return errorBody("INTERNAL", `the job is indeterminate: ${status.value.indeterminate?.evidence.join("; ") ?? ""}`, io);
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    const parsed = parseArguments(argv);
    if ("help" in parsed) { io.stdout(parsed.help); return 0; }
    const { command } = parsed;
    const dir = parsed.session ?? io.env.PANEWEFT_SESSION;
    const needsSession = command.tool === undefined || !["list_components", "describe_component", "validate"].includes(command.tool);
    const args = command.tool === undefined ? {} : await buildArguments(parsed, io);
    let session: Session | null = null;
    if (dir !== undefined && dir !== "" && needsSession) {
      const opened = await openSession(resolve(io.cwd, dir));
      // the directory WAS given; saying SESSION_REQUIRED would hide why it cannot be used
      if (!opened.ok) return printError(opened.error, io);
      session = opened.value;
    } else if (dir !== undefined && dir !== "" && command.tool === "validate" && (await isDirectory(resolve(io.cwd, dir)))) {
      // `validate` compares with a session when it is given one that exists (#4); it never creates one, and a session it cannot open leaves it
      // document-only, which its reply labels `identity: none`
      const opened = await openSession(resolve(io.cwd, dir));
      if (opened.ok) session = opened.value;
    }
    try {
      const word = command.words.join(" ");
      if (word === "example run") return await runExampleCommand(parsed, session, io);
      if (word === "repo add" || word === "repo list") return await repoCommand(parsed, session, io);
      if (word === "serve") return await serveCommand(parsed, session, io, dir);
      if (["adapter add", "adapter list", "renderers trust", "renderers list", "renderers digest", "catalogue refresh", "inventory update"].includes(word)) return await ownerCommand(parsed, session, dir, io);
      if ((V1_TOOL_NAMES as readonly string[]).includes(command.tool as string)) {
        const context = await v1Context(session, dir, io);
        return print(io, await executeV1Operation(context, command.tool as string, args));
      }
      if (word === "mcp") {
        const { runMcpStdio } = await import("../mcp/server.ts");
        await runMcpStdio(session);
        return 0;
      }
      return print(io, await executeOperation(session, command.tool as ToolName, args));
    } finally {
      await session?.close();
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`paneweft: ${error.message}\n`);
      return 2;
    }
    io.stderr(`paneweft: unexpected failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return 70;
  }
}

