// The `paneweft` command line (docs/red-contract.md section 9, design section 5).
// Claims: MC11 (CLI agrees with MCP on contracts and failures; help, usage errors and sugar are part of the CLI contract),
// MC4 (a failed operation is visible as an error body, exit 1), MC17 (no payload can name a runner; missing runner).
// Placement: co-located with src/cli/main.ts. Argument handling runs in-process (fast); the exit-code mapping of the real
// bin entry is checked with a spawned process. Request files are the committed literals under fixtures/wire.
// Decisions the contract leaves open are listed in docs/contract-additions/wire.md and cited as CLI-n.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSession } from "../core/session.ts";
import { runCliInProcess, spawnPaneweft } from "../../test/helpers/cli.ts";
import { must } from "../../test/helpers/must.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { issuePairs, parseBody, runnerRegistryFor, seedClosed, wireJson, wirePath, wireText } from "../../test/helpers/wire-session.ts";

const makeTemp = useTempDirs();

/** The twelve commands of red-contract 9, pinned by name (an emptied list must not pass). */
const COMMANDS = ["components", "describe", "validate", "render", "open", "navigate", "inspect", "search", "notebook", "example", "serve", "mcp"];

describe("cli: help and unknown commands", () => {
  // why: an agent discovers the surface through `--help`; a command missing from it is undiscoverable (red-contract 9).
  // proves: CLAIM(MC11)
  it("[MC11] `paneweft --help` exits 0 and lists all twelve commands on stdout, nothing on stderr", async () => {
    const run = await runCliInProcess(["--help"]);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    const missing = COMMANDS.filter((command) => !new RegExp(`^\\s*${command}\\b`, "m").test(run.stdout));
    expect(missing, `commands not listed at a line start in:\n${run.stdout}`).toEqual([]);
  });

  // why: every command documents itself; `--help` must not execute the command (serve/mcp would block forever, the
  //      others would hit SESSION_REQUIRED), so exit 0 with usage text mentioning the command is the contract.
  // proves: CLAIM(MC11)
  describe.each(COMMANDS)("command %s", (command) => {
    it("[MC11] `--help` exits 0 with usage text naming the command, empty stderr", async () => {
      const run = await runCliInProcess([command, "--help"]);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain(command);
      expect(run.stderr).toBe("");
    });
  });

  // why: the two-level commands must list their subcommands in their own help (red-contract 9).
  // proves: CLAIM(MC11)
  it("[MC11] `notebook --help` lists create, get, update and `example --help` lists record, run", async () => {
    const notebook = await runCliInProcess(["notebook", "--help"]);
    for (const word of ["create", "get", "update"]) expect(notebook.stdout, `notebook help mentions ${word}`).toMatch(new RegExp(`\\b${word}\\b`));
    const example = await runCliInProcess(["example", "--help"]);
    for (const word of ["record", "run"]) expect(example.stdout, `example help mentions ${word}`).toMatch(new RegExp(`\\b${word}\\b`));
  });

  // why: a typo must not silently do something else: exit 2, the diagnosis on stderr, NOTHING on stdout (stdout is
  //      reserved for reply bodies; a script piping it would otherwise parse an error text as data).
  // proves: CLAIM(MC11)
  it("[MC11] an unknown command exits 2 with the name on stderr and empty stdout", async () => {
    const run = await runCliInProcess(["frobnicate"]);
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("frobnicate");
  });

  // why: the real bin entry must turn runCli's number into the process exit status and print only to the right streams.
  // proves: CLAIM(MC11)
  it("[MC11] the spawned bin exits 0 for --help and 2 for an unknown command (exit code reaches the OS)", async () => {
    const help = await spawnPaneweft(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("components");
    const unknown = await spawnPaneweft(["frobnicate"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain("frobnicate");
  });
});

describe("cli: usage errors are exit 2 with the diagnosis on stderr and EMPTY stdout", () => {
  const dir = () => makeTemp("cli-usage");
  // Each row is one fault. `mention` is the token the diagnosis must name so the user can find the culprit.
  // why: usage errors are the caller's mistake, not an operation result: exit 2, stderr text, stdout empty (red-contract 9).
  //      They are detected before any operation runs, so they win over SESSION_REQUIRED (no session is given here).
  // proves: CLAIM(MC11)
  const cases: Array<[string, string[], string, string | null]> = [
    ["unknown flag after the command", ["components", "--bogus"], "--bogus", null],
    ["unknown flag before the command", ["--bogus", "components"], "--bogus", null],
    ["stray positional argument", ["components", "stray"], "stray", null],
    ["--args is not valid JSON", ["validate", "--args", "{not json"], "--args", null],
    ["--args-file content is not valid JSON (stdin)", ["validate", "--args-file", "-"], "--args-file", "{not json"],
    ["--args-file names a file that does not exist", ["validate", "--args-file", "/nonexistent-dir/args.json"], "/nonexistent-dir/args.json", null],
    ["--file names a file that does not exist", ["validate", "--file", "/nonexistent-dir/doc.json"], "/nonexistent-dir/doc.json", null],
    ["--max-bytes is not a number", ["inspect", "--max-bytes", "abc"], "--max-bytes", null],
    ["--max-bytes has trailing garbage", ["inspect", "--max-bytes", "4096abc"], "--max-bytes", null],
    ["--max-bytes is fractional", ["inspect", "--max-bytes", "2048.5"], "--max-bytes", null],
    ["--max-bytes is empty", ["inspect", "--max-bytes", ""], "--max-bytes", null],
    ["--args has no value", ["validate", "--args"], "--args", null],
    ["--file has no value", ["validate", "--file"], "--file", null],
    ["--format has no value", ["components", "--format"], "--format", null],
    ["--session has no value", ["--session"], "--session", null],
    ["--args and --args-file together (CLI-1)", ["validate", "--args", "{}", "--args-file", "-"], "--args", "{}"],
    ["notebook without a subcommand", ["notebook"], "notebook", null],
    ["notebook with an unknown subcommand", ["notebook", "frobnicate"], "frobnicate", null],
    ["example without a subcommand", ["example"], "example", null],
    ["example with an unknown subcommand", ["example", "frobnicate"], "frobnicate", null],
    ["example run without a runner id", ["example", "run"], "run", null],
  ];
  it.each(cases)("[MC11] %s", async (_label, argv, mention, stdin) => {
    const run = await runCliInProcess(argv, { stdin, cwd: dir() });
    expect({ exitCode: run.exitCode, stdout: run.stdout }).toEqual({ exitCode: 2, stdout: "" });
    expect(run.stderr).toContain(mention);
  });

  // why: control for the matrix above: the same commands with correct arguments are NOT usage errors, so the matrix
  //      is not satisfied by a CLI that rejects everything (every row above would then pass).
  // proves: CLAIM(MC11)
  it("[MC11] control: the corrected invocations are accepted (exit 0)", async () => {
    const withValue = await runCliInProcess(["components", "--format", "json"]);
    expect(withValue.exitCode).toBe(0);
    expect(withValue.stdout).not.toBe("");
    const withFile = await runCliInProcess(["validate", "--args-file", "-"], { stdin: wireText("validate-valid-graph.json") });
    expect(withFile.exitCode).toBe(0);
  });
});

describe("cli: operation errors are exit 1 with the error body on STDOUT", () => {
  // why: a missing required tool argument is the tool's INVALID_ARGUMENT, not a CLI usage error, so that the CLI body
  //      equals the MCP body for the same request (CLI-2; design 5 "CLI and MCP produce the same error codes").
  // proves: CLAIM(MC11)
  it("[MC11] `describe` without a component: exit 1, INVALID_ARGUMENT with REQUIRED at /component", async () => {
    const run = await runCliInProcess(["describe"]);
    expect(run.exitCode).toBe(1);
    const body = parseBody(run.stdout, "stdout");
    expect(body.schemaVersion).toBe("paneweft.error/1");
    expect(body.code).toBe("INVALID_ARGUMENT");
    expect(issuePairs(body)).toEqual([["REQUIRED", "/component"]]);
  });

  // why: `--max-bytes` must reach the operation as a NUMBER: 1024 gives the documented BUDGET_TOO_SMALL (minimumBytes
  //      2048, red-contract 3) and the error body itself fits the requested 1024 bytes; a string would give TYPE.
  // proves: CLAIM(MC11), CLAIM(MC3)
  it("[MC11] `inspect --max-bytes 1024`: exit 1, BUDGET_TOO_SMALL with details.minimumBytes 2048, body within 1024 bytes", async () => {
    const dir = await seedClosed(makeTemp("cli-budget"));
    const run = await runCliInProcess(["--session", dir, "inspect", "--args", '{"viewId":"modules","snapshotId":"snap-1"}', "--max-bytes", "1024"]);
    expect(run.exitCode).toBe(1);
    const body = parseBody(run.stdout, "stdout");
    expect(body.code).toBe("BUDGET_TOO_SMALL");
    expect(body.details).toEqual({ minimumBytes: 2048 });
    expect(Buffer.byteLength(run.stdout)).toBeLessThanOrEqual(1024);
  });

  // why: above the maximum is INVALID_ARGUMENT at /maxBytes (red-contract 3), proving the flag is not clamped silently.
  // proves: CLAIM(MC11)
  it("[MC11] `inspect --max-bytes 40000`: exit 1, INVALID_ARGUMENT with OUT_OF_RANGE at /maxBytes", async () => {
    const dir = await seedClosed(makeTemp("cli-budget"));
    const run = await runCliInProcess(["--session", dir, "inspect", "--args", '{"viewId":"modules","snapshotId":"snap-1"}', "--max-bytes", "40000"]);
    expect(run.exitCode).toBe(1);
    const body = parseBody(run.stdout, "stdout");
    expect(body.code).toBe("INVALID_ARGUMENT");
    expect(issuePairs(body)).toEqual([["OUT_OF_RANGE", "/maxBytes"]]);
  });

  // why: operations that need stored data cannot run without a session; the answer is SESSION_REQUIRED (exit 1, body on
  //      stdout), not a crash and not a usage error. Arguments are valid, so no other error can preempt it.
  //      Pairs are (command words, request fixture or inline JSON).
  // proves: CLAIM(MC11)
  describe.each([
    ["render", ["render"], "render-valid.json"],
    ["inspect", ["inspect"], "inspect-list-filter.json"],
    ["search", ["search"], "search-cancel.json"],
    ["open", ["open"], "open-entity-watch.json"],
    ["notebook create", ["notebook", "create"], "notebook-create.json"],
    ["notebook get", ["notebook", "get"], "notebook-get.json"],
    ["example record", ["example", "record"], "example-record-valid.json"],
  ])("without a session: %s", (_label, words, file) => {
    it("[MC11] exit 1 with SESSION_REQUIRED", async () => {
      const run = await runCliInProcess([...words, "--args-file", wirePath(file)], { env: {} });
      expect(run.exitCode).toBe(1);
      expect(parseBody(run.stdout, "stdout").code).toBe("SESSION_REQUIRED");
    });
  });
  it("[MC11] without a session: navigate with valid arguments also answers SESSION_REQUIRED", async () => {
    const run = await runCliInProcess(["navigate", "--args", '{"pane":{},"itemId":"i"}'], { env: {} });
    expect(run.exitCode).toBe(1);
    expect(parseBody(run.stdout, "stdout").code).toBe("SESSION_REQUIRED");
  });

  // why: the stateless commands (catalogue, schema description, validation) must work with no session (CLI-3), so an
  //      agent can check a payload before any session exists. Control for the SESSION_REQUIRED group above.
  // proves: CLAIM(MC11)
  it("[MC11] components, describe and validate work without a session (exit 0)", async () => {
    expect((await runCliInProcess(["components"], { env: {} })).exitCode).toBe(0);
    expect((await runCliInProcess(["describe", "--component", "list"], { env: {} })).exitCode).toBe(0);
    expect((await runCliInProcess(["validate", "--args-file", wirePath("validate-valid-graph.json")], { env: {} })).exitCode).toBe(0);
  });
});

describe("cli: flags are sugar for the same arguments", () => {
  const argsOf = (value: unknown) => JSON.stringify(value);

  // why: `validate --file F` must be the same request as `--args '{"input": <F>}'`: same body, same exit code. The
  //      pinned part is independent: an unknown component is VALIDATION_FAILED with UNKNOWN_COMPONENT at /component.
  // proves: CLAIM(MC11)
  it("[MC11] `validate --file F --format json` equals `validate --args {input,format}` and reports UNKNOWN_COMPONENT at /component", async () => {
    const document = wireJson("envelope-unknown-component.json");
    const viaFlags = await runCliInProcess(["validate", "--file", wirePath("envelope-unknown-component.json"), "--format", "json"]);
    const viaArgs = await runCliInProcess(["validate", "--args", argsOf({ input: document, format: "json" })]);
    expect(viaFlags).toEqual(viaArgs);
    expect(viaFlags.exitCode).toBe(1);
    const body = parseBody(viaFlags.stdout, "stdout");
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(issuePairs(body)).toEqual([["UNKNOWN_COMPONENT", "/component"]]);
  });

  // why: --component and --format are sugar too; with format json the describe page parses and names the component.
  // proves: CLAIM(MC11)
  it("[MC11] `describe --component list --format json` equals the --args form and its page names the component `list`", async () => {
    const viaFlags = await runCliInProcess(["describe", "--component", "list", "--format", "json"]);
    const viaArgs = await runCliInProcess(["describe", "--args", argsOf({ component: "list", format: "json" })]);
    expect(viaFlags).toEqual(viaArgs);
    expect(viaFlags.exitCode).toBe(0);
    expect(parseBody(viaFlags.stdout, "stdout").component).toBe("list");
  });

  // why: flags and --args merge (CLI-4: they must not conflict); the merged request equals the all-in-args request.
  // proves: CLAIM(MC11)
  it("[MC11] --args {component} plus --format json merges into one request", async () => {
    const merged = await runCliInProcess(["describe", "--args", '{"component":"graph"}', "--format", "json"]);
    const single = await runCliInProcess(["describe", "--args", '{"component":"graph","format":"json"}']);
    expect(merged).toEqual(single);
    expect(parseBody(merged.stdout, "stdout").component).toBe("graph");
  });

  // why: --cursor is passed verbatim; a garbage cursor is CURSOR_INVALID (red-contract 3), identical to the --args form.
  // proves: CLAIM(MC11)
  it("[MC11] `describe --component graph --cursor not-a-cursor` is CURSOR_INVALID, equal to the --args form", async () => {
    const viaFlags = await runCliInProcess(["describe", "--component", "graph", "--cursor", "not-a-cursor"]);
    const viaArgs = await runCliInProcess(["describe", "--args", argsOf({ component: "graph", cursor: "not-a-cursor" })]);
    expect(viaFlags).toEqual(viaArgs);
    expect(viaFlags.exitCode).toBe(1);
    expect(parseBody(viaFlags.stdout, "stdout").code).toBe("CURSOR_INVALID");
  });

  // why: `--args-file -` reads the request from stdin; stdin and a file with the same bytes give the same answer.
  // proves: CLAIM(MC11)
  it("[MC11] `--args-file -` with the bytes on stdin equals `--args-file FILE`", async () => {
    const viaFile = await runCliInProcess(["validate", "--args-file", wirePath("validate-graph-string-depth.json")]);
    const viaStdin = await runCliInProcess(["validate", "--args-file", "-"], { stdin: wireText("validate-graph-string-depth.json") });
    expect(viaStdin).toEqual(viaFile);
    expect(viaFile.exitCode).toBe(1);
    expect(issuePairs(parseBody(viaFile.stdout, "stdout"))).toEqual([["TYPE", "/data/focus/depth"]]);
  });
});

describe("cli: session selection", () => {
  // why: PANEWEFT_SESSION is the documented fallback for --session (red-contract 9): same session, same body.
  // proves: CLAIM(MC11)
  it("[MC11] PANEWEFT_SESSION gives the same answer as --session", async () => {
    const dir = await seedClosed(makeTemp("cli-env"));
    const request = ["inspect", "--args-file", wirePath("inspect-list-filter.json")];
    const viaFlag = await runCliInProcess(["--session", dir, ...request]);
    const viaEnv = await runCliInProcess(request, { env: { PANEWEFT_SESSION: dir } });
    expect(viaFlag.exitCode).toBe(0);
    expect(viaFlag.stdout).toContain("paneweft.reply/1 view=modules component=list");
    expect(viaEnv).toEqual(viaFlag);
  });

  // why: an explicit --session wins over the ambient environment (CLI-5); a render goes to the flag's session only.
  //      The side effect is checked through the core: view `empty-complete` appears in B and not in A.
  // proves: CLAIM(MC11)
  it("[MC11] --session beats PANEWEFT_SESSION: the render lands in the flag's session only", async () => {
    const envDir = await seedClosed(makeTemp("cli-env-a"));
    const flagDir = await seedClosed(makeTemp("cli-env-b"));
    const request = { input: wireJson("view-empty-complete.json"), format: "json" };
    const run = await runCliInProcess(["--session", flagDir, "render", "--args", JSON.stringify(request)], { env: { PANEWEFT_SESSION: envDir } });
    expect(run.exitCode, run.stdout.slice(0, 300)).toBe(0);
    const viewIds = async (dir: string) => {
      const session = must(await openSession(dir), "openSession");
      const ids = (await session.listViews()).map((key) => key.viewId).sort();
      await session.close();
      return ids;
    };
    expect(await viewIds(flagDir)).toContain("empty-complete");
    expect(await viewIds(envDir)).not.toContain("empty-complete");
  });
});

describe("cli: examples and runners (MC17)", () => {
  // why: `example run NOPE` against an owner registry that does not contain NOPE is RUNNER_NOT_FOUND (red-contract 10),
  //      exit 1, with the error body on stdout; the registry is owner-written (CLI-6 names the flags).
  // proves: CLAIM(MC17)
  it("[MC17] `example run NOPE` with a registry lacking it: exit 1, RUNNER_NOT_FOUND", async () => {
    const dir = await seedClosed(makeTemp("cli-run"));
    const workspace = makeTemp("cli-run-ws");
    const registry = join(workspace, "runners.json");
    writeFileSync(registry, runnerRegistryFor({ workspace }));
    const run = await runCliInProcess(["--session", dir, "example", "run", "NOPE", "--runners", registry, "--view", "vigil-one-write", "--snapshot", "snap-1"]);
    expect(run.exitCode).toBe(1);
    expect(parseBody(run.stdout, "stdout").code).toBe("RUNNER_NOT_FOUND");
  });

  // why: with no registry configured there is no runner at all; the answer is the same RUNNER_NOT_FOUND (CLI-6).
  // proves: CLAIM(MC17)
  it("[MC17] `example run NOPE` with no registry configured: exit 1, RUNNER_NOT_FOUND", async () => {
    const dir = await seedClosed(makeTemp("cli-run"));
    const run = await runCliInProcess(["--session", dir, "example", "run", "NOPE", "--view", "vigil-one-write", "--snapshot", "snap-1"], { env: {} });
    expect(run.exitCode).toBe(1);
    expect(parseBody(run.stdout, "stdout").code).toBe("RUNNER_NOT_FOUND");
  });

  // why: a payload cannot install or execute a runner (design 5, owner question 4): a runner definition inside the run
  //      output or its bundle, or `argv` as a tool argument, is refused and records nothing. The canary path is named by
  //      the payload's argv; it must not exist afterwards. Control: the same output without the runner is recorded.
  // proves: CLAIM(MC17)
  it("[MC17] `example record` refuses a runner in the output (VALIDATION_FAILED) or an argv argument (INVALID_ARGUMENT), records nothing", async () => {
    const dir = await seedClosed(makeTemp("cli-record"));
    const scratch = makeTemp("cli-record-files");
    const canary = join(scratch, "canary");
    const record = async (name: string) => {
      const file = join(scratch, name);
      writeFileSync(file, wireText(name).replaceAll("{canary}", canary));
      return runCliInProcess(["--session", dir, "example", "record", "--args-file", file]);
    };
    const inOutput = await record("example-record-runner-in-output.json");
    expect(inOutput.exitCode).toBe(1);
    const outputBody = parseBody(inOutput.stdout, "stdout");
    expect(outputBody.code).toBe("VALIDATION_FAILED");
    expect(outputBody.errors.map((issue: any) => issue.code)).toEqual(["UNKNOWN_PROPERTY"]);
    expect(outputBody.errors[0].pointer).toMatch(/\/runner$/);

    const inBundle = await record("example-record-runner-in-bundle.json");
    expect(inBundle.exitCode).toBe(1);
    const bundleBody = parseBody(inBundle.stdout, "stdout");
    expect(bundleBody.code).toBe("VALIDATION_FAILED");
    expect(bundleBody.errors[0].pointer).toMatch(/\/runners$/);

    const asArgument = await record("example-record-argv-argument.json");
    expect(asArgument.exitCode).toBe(1);
    const argumentBody = parseBody(asArgument.stdout, "stdout");
    expect(argumentBody.code).toBe("INVALID_ARGUMENT");
    expect(issuePairs(argumentBody)).toEqual([["UNKNOWN_PROPERTY", "/argv"]]);

    const session = must(await openSession(dir), "reopen");
    expect(must(await session.listRuns({ viewId: "vigil-one-write", snapshotId: "snap-1" }), "listRuns")).toEqual([]);
    await session.close();
    expect(() => readFileSync(canary)).toThrow(/ENOENT/);

    const control = await runCliInProcess(["--session", dir, "example", "record", "--args-file", wirePath("example-record-valid.json")]);
    expect(control.exitCode, control.stdout.slice(0, 300)).toBe(0);
  });
});

