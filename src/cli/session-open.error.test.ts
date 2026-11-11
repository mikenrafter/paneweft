// T8: when openSession fails (the session directory cannot be created), main.ts swallowed the error and answered SESSION_REQUIRED
// ("pass --session DIR") even though --session WAS given. The real error (STORAGE_FAILED naming the directory and the cause) is reported instead.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCliInProcess } from "../../test/helpers/cli.ts";
import { parseBody } from "../../test/helpers/wire-session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();

/** A session path that can never be created, even by root: its parent is a regular file. */
function unwritable(): string {
  const parent = join(tmp("open-error"), "a-file");
  writeFileSync(parent, "not a directory");
  return join(parent, "session");
}

describe("cli: a session that cannot be opened reports why (T8)", () => {
  // why: SESSION_REQUIRED tells the caller to pass --session, which they did; the actionable fact is the storage error and the path.
  // proves: CLAIM(cli-is-an-adapter)
  it.each([
    ["search", ["search", "--query", "x"]],
    ["open", ["open", "--args", '{"snapshotId":"s","entity":{"repository":"r","id":"i","kind":"k"}}']],
    ["example run", ["example", "run", "RUNNER", "--view", "v", "--snapshot", "s", "--runners", "/nonexistent.json"]],
    ["serve", ["serve", "--port", "0"]],
  ])("[T8] `%s` with an unwritable --session: exit 1, STORAGE_FAILED naming the directory, not SESSION_REQUIRED", async (_name, argv) => {
    const dir = unwritable();
    const run = await runCliInProcess(["--session", dir, ...argv]);
    expect(run.exitCode, run.stdout + run.stderr).toBe(1);
    const body = parseBody(run.stdout);
    expect(body.code).toBe("STORAGE_FAILED");
    expect(body.message).toContain(dir);
    expect(run.stdout).not.toContain("SESSION_REQUIRED");
    expect(run.stderr).toBe("");
  });

  // why: the same through the environment variable.
  // proves: CLAIM(cli-is-an-adapter)
  it("[T8] the same error when the directory comes from PANEWEFT_SESSION", async () => {
    const dir = unwritable();
    const run = await runCliInProcess(["search", "--query", "x"], { env: { PANEWEFT_SESSION: dir } });
    expect(run.exitCode).toBe(1);
    expect(parseBody(run.stdout).code).toBe("STORAGE_FAILED");
  });

  // why: controls. A command that needs no session still works when the session path is bad (it never opens it), and a command that needs a
  //   session but is given none is still SESSION_REQUIRED: only the open failure changed.
  // proves: CLAIM(cli-is-an-adapter)
  it("[T8] `components` ignores a bad --session; `search` with no session is still SESSION_REQUIRED", async () => {
    const fine = await runCliInProcess(["--session", unwritable(), "components", "--format", "json"]);
    expect(fine.exitCode).toBe(0);
    const none = await runCliInProcess(["search", "--query", "x"], { env: {} });
    expect(none.exitCode).toBe(1);
    expect(parseBody(none.stdout).code).toBe("SESSION_REQUIRED");
  });
});
