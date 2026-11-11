// T3: `paneweft repo add ID=ROOT` and `repo list` register and show repository roots WITHOUT starting the viewer (before this, the only way to
// register a root was `serve --repo`). Roots decide whether freshness can be verified (freshness: unverified -> fresh/stale), so an agent
// that only uses the CLI or MCP needs a way to set them. The registration is CLI-only: no MCP tool can name a filesystem path to trust.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSession } from "../core/session.ts";
import { executeOperation } from "../core/operations.ts";
import { toolDescriptors } from "../mcp/server.ts";
import { runCliInProcess } from "../../test/helpers/cli.ts";
import { must } from "../../test/helpers/must.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { parseBody, seedClosed } from "../../test/helpers/wire-session.ts";

const makeTemp = useTempDirs();
const registered = async (dir: string) => {
  const session = must(await openSession(dir), "open");
  const repositories = await session.repositories();
  await session.close();
  return repositories;
};

describe("cli: repo add / repo list (T3)", () => {
  // why: the core claim: `repo add r=ROOT` stores the registration in the session, exit 0, without any server (no server.json appears).
  //   A relative ROOT is resolved against the caller's working directory, like `serve --repo`, so the stored root is absolute.
  // proves: CLAIM(repo-add)
  it("[T3] `repo add r=work/r` stores the absolute root, prints it, exit 0, and starts no viewer", async () => {
    const dir = makeTemp("repo");
    const cwd = makeTemp("repo-cwd");
    mkdirSync(join(cwd, "work", "r"), { recursive: true });
    const run = await runCliInProcess(["--session", dir, "repo", "add", "r=work/r"], { cwd });
    expect([run.exitCode, run.stderr]).toEqual([0, ""]);
    expect(run.stdout).toBe(`registered r -> ${join(cwd, "work", "r")}\n`);
    expect(await registered(dir)).toEqual([{ id: "r", root: join(cwd, "work", "r") }]);
    expect(() => writeFileSync(join(dir, "server.json"), "", { flag: "wx" })).not.toThrow(); // the file did not exist
  });

  // why: ids and roots are plain strings; a root may itself contain "=", so the id ends at the FIRST "=".
  // proves: CLAIM(repo-add)
  it("[T3] the id ends at the first `=`; the root may contain `=`", async () => {
    const dir = makeTemp("repo");
    const run = await runCliInProcess(["--session", dir, "repo", "add", "r=/srv/a=b"]);
    expect(run.exitCode).toBe(0);
    expect(await registered(dir)).toEqual([{ id: "r", root: "/srv/a=b" }]);
  });

  // why: registering an id again replaces its root (registerRepository's rule); the list never shows two roots for one id.
  // proves: CLAIM(repo-add)
  it("[T3] adding the same id again replaces its root; `repo list` shows both repositories sorted by id", async () => {
    const dir = makeTemp("repo");
    for (const entry of ["z=/one", "a=/two", "z=/three"]) expect((await runCliInProcess(["--session", dir, "repo", "add", entry])).exitCode).toBe(0);
    const text = await runCliInProcess(["--session", dir, "repo", "list"]);
    expect([text.exitCode, text.stdout]).toEqual([0, "a=/two\nz=/three\n"]);
    const json = await runCliInProcess(["--session", dir, "repo", "list", "--format", "json"]);
    expect(json.exitCode).toBe(0);
    expect(parseBody(json.stdout)).toEqual({ schemaVersion: "paneweft.repositories/1", repositories: [{ id: "a", root: "/two" }, { id: "z", root: "/three" }] });
  });

  // why: an empty list is still an answer (exit 0, no repositories), not an error.
  // proves: CLAIM(repo-add)
  it("[T3] `repo list` on a session without roots prints nothing in text and an empty array in JSON, exit 0", async () => {
    const dir = makeTemp("repo");
    expect(await runCliInProcess(["--session", dir, "repo", "list"])).toMatchObject({ exitCode: 0, stdout: "" });
    expect(parseBody((await runCliInProcess(["--session", dir, "repo", "list", "--format", "json"])).stdout).repositories).toEqual([]);
  });

  // why: the point of registering a root is that freshness can be checked. After `repo add r=ROOT` a rendered view of repository r no longer
  //   says the repository is unregistered (the reply names REPOSITORY_NOT_REGISTERED before, and not after).
  // proves: CLAIM(repo-add)
  it("[T3] after `repo add`, `inspect` no longer reports repository r as not registered", async () => {
    const dir = await seedClosed(makeTemp("repo-fresh"));
    const before = await runCliInProcess(["--session", dir, "inspect", "--view", "modules", "--snapshot", "snap-1", "--format", "json"]);
    expect(JSON.stringify(parseBody(before.stdout).freshness)).toContain("REPOSITORY_NOT_REGISTERED");
    const root = makeTemp("repo-root");
    expect((await runCliInProcess(["--session", dir, "repo", "add", `r=${root}`])).exitCode).toBe(0);
    const after = await runCliInProcess(["--session", dir, "inspect", "--view", "modules", "--snapshot", "snap-1", "--format", "json"]);
    expect(JSON.stringify(parseBody(after.stdout).freshness)).not.toContain("REPOSITORY_NOT_REGISTERED");
  });

  // why: malformed input is a usage error (exit 2, diagnosis on stderr, stdout empty) and registers nothing. No "=", an empty id, an empty
  //   root, no argument at all, two arguments, and no session are each distinct mistakes.
  // proves: CLAIM(repo-add)
  it.each([
    ["no `=`", ["repo", "add", "r"], "ID=ROOT"],
    ["empty id", ["repo", "add", "=/x"], "ID=ROOT"],
    ["empty root", ["repo", "add", "r="], "ID=ROOT"],
    ["no argument", ["repo", "add"], "ID=ROOT"],
    ["two arguments", ["repo", "add", "a=/x", "b=/y"], "unexpected argument"],
    ["unknown subcommand", ["repo", "remove", "a"], "unknown subcommand"],
    ["no subcommand", ["repo"], "needs a subcommand"],
  ])("[T3] usage error (exit 2, empty stdout, nothing stored): %s", async (_name, argv, mention) => {
    const dir = makeTemp("repo");
    const run = await runCliInProcess(["--session", dir, ...argv]);
    expect([run.exitCode, run.stdout]).toEqual([2, ""]);
    expect(run.stderr).toContain(mention);
    expect(await registered(dir)).toEqual([]);
  });

  it("[T3] without a session `repo add` and `repo list` are usage errors that name --session", async () => {
    for (const argv of [["repo", "add", "r=/x"], ["repo", "list"]]) {
      const run = await runCliInProcess(argv, { env: {} });
      expect([run.exitCode, run.stdout]).toEqual([2, ""]);
      expect(run.stderr).toContain("--session");
    }
  });

  // why: discoverability: both the top-level help and `repo --help` list the command; a command nobody can find is not shipped.
  // proves: CLAIM(MC11)
  it("[T3] `--help` lists `repo`, and `repo --help` lists add and list", async () => {
    expect((await runCliInProcess(["--help"])).stdout).toMatch(/^\s*repo\b/m);
    const help = await runCliInProcess(["repo", "--help"]);
    expect(help.exitCode).toBe(0);
    for (const word of ["add", "list"]) expect(help.stdout).toMatch(new RegExp(`\\b${word}\\b`));
    expect((await runCliInProcess(["repo", "add", "--help"])).stdout).toContain("ID=ROOT");
  });
});

describe("repo registration is CLI-only (T3)", () => {
  // why: a tool that registers roots would let a model name any directory the viewer and freshness checks may then read. The tool set is the
  //   canonical thirteen and none of them (or any repo-ish name) registers a root; calling such a name is UNKNOWN_OPERATION.
  // proves: CLAIM(no-payload-exec) (roots are owner-set)
  it("[T3] no MCP tool is named repo*/register_repository and executeOperation rejects those names", async () => {
    const names = toolDescriptors().map((tool) => tool.name);
    expect(names).toHaveLength(13);
    expect(names.filter((name) => /repo/i.test(name))).toEqual([]);
    const session = must(await openSession(makeTemp("repo-op")), "open");
    for (const name of ["repo_add", "repo_list", "register_repository", "repo"]) {
      const outcome = await executeOperation(session, name, { id: "r", root: "/etc" });
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? "" : outcome.error.code).toBe("UNKNOWN_OPERATION");
    }
    expect(await session.repositories()).toEqual([]);
    await session.close();
  });
});
