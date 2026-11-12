// why: dogfooding note #2. `paneweft describe graph` was rejected (`unexpected argument "graph" for describe`; the working form was `describe --component graph`)
//   and `--help` listed switches without one concrete call, so the reader had to guess the shape of each command. Now `describe` takes the component as a
//   positional argument as well as `--component`, and `<command> --help` carries exactly one `example:` line: a real invocation, against committed fixtures,
//   that the parser accepts (for the commands that do not run forever, it is run).
// proves: CLAIM(cli-is-an-adapter), CLAIM(readme-usage): what the help shows is what the parser takes.
import { describe, expect, it } from "vitest";
import { runCliInProcess } from "../../test/helpers/cli.ts";
import { REPO_ROOT } from "../../test/helpers/fixtures.ts";
import { parseBody } from "../../test/helpers/wire-session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { join } from "node:path";

const tmp = useTempDirs();

// Pinned by name on purpose (emptying this list must break the suite): every command word sequence `paneweft --help` and the group helps advertise.
const COMMANDS: string[][] = [
  ["components"], ["describe"], ["validate"], ["render"], ["register"], ["open"], ["navigate"], ["inspect"], ["search"],
  ["notebook", "create"], ["notebook", "get"], ["notebook", "update"], ["example", "record"], ["example", "run"], ["repo", "add"], ["repo", "list"], ["serve"], ["mcp"],
  // v1 (docs/v1-red-contract.md section 11): the agent tools and the owner-only commands, pinned by name like the v0 ones
  ["types"], ["views"], ["examples"], ["scaffold", "view"], ["scaffold", "example"], ["collect"], ["collection", "status"], ["collection", "cancel"], ["result"], ["failure"],
  ["adapter", "add"], ["adapter", "list"], ["renderers", "trust"], ["renderers", "list"], ["renderers", "digest"], ["catalogue", "refresh"], ["inventory", "update"],
];
/** These two run until interrupted, so their example is checked against the command's own option list instead of being run. */
const LONG_RUNNING = new Set(["serve", "mcp"]);

/** Splits a shell line into words, honouring single and double quotes. */
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

async function exampleOf(command: string[]): Promise<{ help: string; line: string; argv: string[] }> {
  const run = await runCliInProcess([...command, "--help"]);
  expect(run.exitCode, `${command.join(" ")} --help: ${run.stderr}`).toBe(0);
  const examples = run.stdout.split("\n").filter((line) => line.startsWith("example: "));
  expect(examples, `${command.join(" ")} --help must carry exactly one example: line\n${run.stdout}`).toHaveLength(1);
  const line = (examples[0] as string).slice("example: ".length);
  const argv = words(line);
  expect(argv[0], line).toBe("paneweft");
  expect(argv.slice(1, 1 + command.length), `the example of ${command.join(" ")} must call that command: ${line}`).toEqual(command);
  return { help: run.stdout, line, argv: argv.slice(1) };
}

describe("[#2] describe takes the component as an argument", () => {
  // why: the finding. `describe graph` and `describe --component graph` are the same request and give the same bytes.
  it("[#2] `describe graph` equals `describe --component graph`", async () => {
    const positional = await runCliInProcess(["describe", "graph", "--max-bytes", "2048"]);
    const flagged = await runCliInProcess(["describe", "--component", "graph", "--max-bytes", "2048"]);
    expect(positional.exitCode, positional.stdout + positional.stderr).toBe(0);
    expect(positional.stdout).toContain("component=graph");
    expect(positional.stdout).toBe(flagged.stdout);
  });

  // why: two sources for one value must agree or be refused; guessing which wins is how a wrong schema gets copied.
  it("[#2] a positional that disagrees with --component is a usage error naming both; the same value twice is accepted", async () => {
    const clash = await runCliInProcess(["describe", "graph", "--component", "list"]);
    expect(clash.exitCode).toBe(2);
    expect(clash.stderr).toContain("graph");
    expect(clash.stderr).toContain("list");
    const same = await runCliInProcess(["describe", "graph", "--component", "graph"]);
    expect(same.exitCode, same.stdout + same.stderr).toBe(0);
  });

  // why: control: an unknown component is the operation's error (it names the choices), not a usage error, exactly as with the flag.
  it("[#2] `describe heatmap` fails like `--component heatmap`: exit 1, INVALID_ARGUMENT", async () => {
    const run = await runCliInProcess(["describe", "heatmap"]);
    expect(run.exitCode).toBe(1);
    expect(parseBody(run.stdout).code).toBe("INVALID_ARGUMENT");
  });

  // why: no second positional.
  it("[#2] a second positional is still a usage error", async () => {
    const run = await runCliInProcess(["describe", "graph", "list"]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('unexpected argument "list"');
  });
});

describe("[#2] every command's --help carries one concrete, working example", () => {
  it.each(COMMANDS.map((command) => [command.join(" ")]))("[#2] %s: exactly one `example:` line, calling that command, naming only options it lists", async (name) => {
    const command = (name as string).split(" ");
    const { help, argv } = await exampleOf(command);
    const options = (/^options: (.*)$/m.exec(help)?.[1] ?? "").split(" ");
    for (const token of argv.filter((word) => word.startsWith("--") && word !== "--session")) {
      expect(options, `${token} in the example of ${command.join(" ")} is not in its options line`).toContain(token);
    }
  });

  // why: an example that does not run is worse than none. Each one is run against the committed fixtures in a fresh session; it may fail as an operation
  //   (exit 1: e.g. a notebook page that was never created) but must never be a usage error (2) or a crash (70).
  it("[#2] each example is accepted by the parser (exit 0 or 1, never a usage error), run from the repository root", async () => {
    const env = { PANEWEFT_SESSION: join(tmp("help-examples"), "session") };
    for (const command of COMMANDS.filter((candidate) => !LONG_RUNNING.has(candidate[0] as string))) {
      const { line, argv } = await exampleOf(command);
      const run = await runCliInProcess(argv, { env, cwd: REPO_ROOT });
      expect([run.exitCode, line], run.stdout.slice(0, 300) + run.stderr).not.toEqual([2, line]);
      expect([run.exitCode, line], run.stdout.slice(0, 300) + run.stderr).not.toEqual([70, line]);
    }
  }, 60_000);

  // why: the group helps (`notebook --help`) list subcommands; they are pinned too, so a new subcommand without an example fails here.
  it("[#2] the commands in this table are exactly the commands of the CLI", async () => {
    const top = (await runCliInProcess(["--help"])).stdout.split("\n").filter((line) => /^ {2}\S/.test(line)).map((line) => line.trim().split(/\s+/)[0] as string);
    const known = new Set(COMMANDS.map((command) => command[0] as string));
    expect([...known].sort()).toEqual([...top].sort());
    for (const group of ["notebook", "example", "repo", "scaffold", "collection", "adapter", "renderers", "catalogue", "inventory"]) {
      const listed = (await runCliInProcess([group, "--help"])).stdout.split("\n").filter((line) => /^ {2}\S/.test(line)).map((line) => line.trim().split(/\s+/)[0] as string);
      expect(COMMANDS.filter((command) => command[0] === group).map((command) => command[1]).sort()).toEqual([...listed].sort());
    }
  });
});
