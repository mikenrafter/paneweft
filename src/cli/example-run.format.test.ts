// T7: `example run` has its own output branch for `--format json` (a `paneweft.example_run/1` document), but main.ts refused `--format` for it as an
// unknown option, so the branch could never run. `--format text|json` is now accepted and validated like the operation commands'.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCliInProcess } from "../../test/helpers/cli.ts";
import { importAll, openOk } from "../../test/helpers/store-session.ts";
import { EXAMPLE_KEY, SCENARIO_RUNNER_ID, runnerDefinition, writeRegistry } from "../../test/helpers/store-runner.ts";
import { parseBody } from "../../test/helpers/wire-session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();

async function world() {
  const base = tmp("run-format");
  const workspace = join(base, "ws");
  mkdirSync(workspace);
  const sessionDir = join(base, "s");
  const session = await openOk(sessionDir);
  await importAll(session);
  await session.close();
  const registry = writeRegistry(join(base, "registry"), [runnerDefinition("pass-runner.mjs", workspace)]);
  const argv = (...extra: string[]) => ["--session", sessionDir, "example", "run", SCENARIO_RUNNER_ID, "--runners", registry, "--view", EXAMPLE_KEY.viewId, "--snapshot", EXAMPLE_KEY.snapshotId, ...extra];
  return { argv };
}

describe("cli: example run --format (T7)", () => {
  // why: `--format json` must reach the JSON branch: exit 0 and one parseable document naming the recorded run. Run ids are generated, so the
  //   assertion is on shape and on the fixed fields (status, view, snapshot), not on the id's text.
  // proves: CLAIM(cli-is-an-adapter)
  it("[T7] `example run ... --format json` prints a paneweft.example_run/1 document", async () => {
    const { argv } = await world();
    const run = await runCliInProcess(argv("--format", "json"));
    expect([run.exitCode, run.stderr]).toEqual([0, ""]);
    const body = parseBody(run.stdout);
    expect(body.schemaVersion).toBe("paneweft.example_run/1");
    expect(body.recorded).toMatchObject({ viewId: "vigil-one-write", snapshotId: "snap-1", status: "passed" });
    expect(body.recorded.runId).toMatch(/^run-/);
  });

  // why: text stays the default and with `--format text`: the two-line human form.
  // proves: CLAIM(cli-is-an-adapter)
  it("[T7] the default and `--format text` print `recorded run <id>: passed` and the view line", async () => {
    const { argv } = await world();
    for (const extra of [[], ["--format", "text"]]) {
      const run = await runCliInProcess(argv(...extra));
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toMatch(/^recorded run run-\S+: passed\nview: vigil-one-write@snap-1\n$/);
    }
  });

  // why: a value other than text|json is a usage error (exit 2), the same as for the operation commands, and no run is executed or recorded.
  // proves: CLAIM(MC11)
  it("[T7] `--format yaml` is a usage error, exit 2, empty stdout", async () => {
    const { argv } = await world();
    const run = await runCliInProcess(argv("--format", "yaml"));
    expect([run.exitCode, run.stdout]).toEqual([2, ""]);
    expect(run.stderr).toContain("--format must be text or json");
  });
});
