// Owner-configured runners (design 5, owner question 4; MC17; red-contract 10). Every test runs a REAL
// child process: the tiny independent scripts in fixtures/runners (plain node ESM, no src/ imports) are
// started by runExample through a registry file the test writes, exactly as an owner would.
// Process-level facts (pid gone, canary file absent, argv recorded by the child itself) are observed from
// outside, never through the code under test.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, describe, expect, it } from "vitest";
import { loadRunnerRegistry, runExample } from "./runner.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { sha256Hex } from "../../test/helpers/hash.ts";
import { importAll, openOk } from "../../test/helpers/store-session.ts";
import { EXAMPLE_KEY, SCENARIO_RUNNER_ID, passOutput, runnerDefinition, runnerScript, writeRegistry, type RunnerOptions } from "../../test/helpers/store-runner.ts";
import { treeSnapshot } from "../../test/helpers/store-fs.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
const resultOf = (runId: string) => ({ repository: "r", id: `result-${runId}`, kind: "json/value" });
const pairs = (error: { errors: Array<{ code: string; pointer: string }> }) => error.errors.map((issue) => [issue.code, issue.pointer]);

async function setup(script: string, options: RunnerOptions = {}) {
  const base = tmp("runner");
  const workspace = join(base, "ws");
  mkdirSync(workspace);
  const sessionDir = join(base, "s");
  const session = await openOk(sessionDir);
  await importAll(session);
  const registryFile = writeRegistry(join(base, "registry"), [runnerDefinition(script, workspace, options)]);
  const run = (parameters: Record<string, string | number | boolean | null> = {}, runnerId = SCENARIO_RUNNER_ID) =>
    runExample(session, { runnerRegistryFile: registryFile, runnerId, parameters, key: EXAMPLE_KEY });
  return { base, workspace, sessionDir, session, registryFile, run };
}
const read = (workspace: string, name: string) => readFileSync(join(workspace, name), "utf8");

describe("loadRunnerRegistry", () => {
  // why: the registry is an owner-written file `{ "runners": [...] }` (red-contract 10); loading returns the
  //   definitions exactly, in file order.
  // proves: CLAIM(MC17)
  it("[MC17] returns the runner definitions of the file exactly, in file order", async () => {
    const base = tmp("runner");
    const a = runnerDefinition("pass-runner.mjs", base, { id: "alpha" });
    const b = runnerDefinition("fail-runner.mjs", base, { id: "beta", timeoutMs: 1234 });
    const file = writeRegistry(base, [b, a]);
    expect(must(await loadRunnerRegistry(file))).toEqual([b, a]);
  });

  // why: a registry file that does not exist yields no runners; the failure is RUNNER_NOT_FOUND, never a throw
  //   (store.md#10).
  // proves: CLAIM(MC17)
  it("[MC17] a missing registry file is RUNNER_NOT_FOUND, not an exception", async () => {
    const base = tmp("runner");
    expect(mustFail(await loadRunnerRegistry(join(base, "nope.json"))).code).toBe("RUNNER_NOT_FOUND");
  });
});

describe("runExample: recorded outcomes", () => {
  // why: MC17: "Run a tiny independent fixture runner that returns an entity after an assertion." The run is
  //   recorded as passed under the run id PANEWEFT_RUN_ID that the runner itself saw, and its result entity is
  //   registered and resolvable.
  // proves: CLAIM(MC17)
  it("[MC17] a passing runner: recorded as passed under the run id the runner received; result entity registered", async () => {
    const { workspace, session, run } = await setup("pass-runner.mjs");
    const recorded = must(await run());
    const seen = read(workspace, "seen-run-id.txt");
    expect(seen).not.toBe("");
    expect(recorded).toMatchObject({ runId: seen, viewId: "vigil-one-write", snapshotId: "snap-1", status: "passed" });
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([recorded]);
    expect(must(await session.getEntity(resultOf(seen), "snap-1")).label).toBe("recorded result");
  });

  // why: failed assertions with a result are accepted and recorded as failed (design 2.7).
  // proves: CLAIM(MC17)
  it("[MC17] a runner with a failing assertion but a result: recorded as failed, result registered", async () => {
    const { session, run } = await setup("fail-runner.mjs");
    const recorded = must(await run());
    expect(recorded.status).toBe("failed");
    expect(must(await session.getEntity(resultOf(recorded.runId), "snap-1")).id).toBe(`result-${recorded.runId}`);
  });

  // why: an infrastructure error run (message, no result) is a valid, recorded outcome and registers no entity.
  // proves: CLAIM(MC17)
  it("[MC17] an error runner: recorded as error, no result entity registered", async () => {
    const { session, run } = await setup("error-runner.mjs");
    expect(must(await run()).status).toBe("error");
    expect((await session.listEntities("snap-1")).map((e) => e.id)).toEqual(["mcp", "notes", "watch"]);
  });

  // why: MC17: "repeated runs with distinct run IDs". paneweft generates the id; two runs never share one, and
  //   both are listed in order. A fixed id would make the second run DUPLICATE_RUN.
  // proves: CLAIM(MC17)
  it("[MC17] two runs of the same runner get distinct run ids and are both listed", async () => {
    const { workspace, session, run } = await setup("pass-runner.mjs");
    const first = must(await run());
    const firstSeen = read(workspace, "seen-run-id.txt");
    const second = must(await run());
    const secondSeen = read(workspace, "seen-run-id.txt");
    expect(first.runId).toBe(firstSeen);
    expect(second.runId).toBe(secondSeen);
    expect(first.runId).not.toBe(second.runId);
    expect(must(await session.listRuns(EXAMPLE_KEY)).map((r) => r.runId)).toEqual([first.runId, second.runId]);
  });

  // why: the registry file is the owner's; running never writes to it (nothing in the API installs or edits
  //   runners). Its bytes are identical after a run.
  // proves: CLAIM(MC17)
  it("[MC17] the registry file is byte-identical after a run", async () => {
    const { registryFile, run } = await setup("pass-runner.mjs");
    const before = sha256Hex(readFileSync(registryFile));
    must(await run());
    expect(sha256Hex(readFileSync(registryFile))).toBe(before);
  });
});

describe("runExample: runner lookup (a payload cannot install a runner)", () => {
  // why: an id that is not in the owner's file is RUNNER_NOT_FOUND, and nothing is spawned (no output file,
  //   no seen-run-id marker in the workspace).
  // proves: CLAIM(MC17)
  it("[MC17] an unknown runner id is RUNNER_NOT_FOUND and nothing is executed", async () => {
    const { workspace, run } = await setup("pass-runner.mjs");
    expect(mustFail(await run({}, "ghost")).code).toBe("RUNNER_NOT_FOUND");
    expect(existsSync(join(workspace, "seen-run-id.txt"))).toBe(false);
  });

  // why: the submitted example view names runnerId "vigil-one-write" (a bundle is untrusted input), but the
  //   owner's registry has only "other". The scenario's name must not conjure a runner: RUNNER_NOT_FOUND.
  // proves: CLAIM(MC17)
  it("[MC17] the runner id named by a submitted scenario is RUNNER_NOT_FOUND when the owner's registry lacks it", async () => {
    const { workspace, session, run } = await setup("pass-runner.mjs", { id: "other" });
    const view = must(await session.getView(EXAMPLE_KEY));
    expect((view.envelope.data as { scenario: { runnerId: string } }).scenario.runnerId).toBe("vigil-one-write");
    expect(mustFail(await run()).code).toBe("RUNNER_NOT_FOUND");
    expect(existsSync(join(workspace, "seen-run-id.txt"))).toBe(false);
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
  });

  // why: with no registry file at all there is no runner to run.
  // proves: CLAIM(MC17)
  it("[MC17] a missing registry file is RUNNER_NOT_FOUND", async () => {
    const { base, session } = await setup("pass-runner.mjs");
    const result = await runExample(session, { runnerRegistryFile: join(base, "absent.json"), runnerId: SCENARIO_RUNNER_ID, parameters: {}, key: EXAMPLE_KEY });
    expect(mustFail(result).code).toBe("RUNNER_NOT_FOUND");
  });
});

describe("runExample: timeouts and process control", () => {
  // why: control for the timeout test: the sleeper fixture really records the pid of a LIVE process (kill 0
  //   succeeds) that it announces on stdout. Without this, "pid is gone" below could be vacuous.
  // proves: CLAIM(MC17)
  it("[MC17] control: the sleep runner records a live pid before it sleeps", async () => {
    const workspace = tmp("runner");
    const child = spawn(process.execPath, [runnerScript("sleep-runner.mjs"), "out.json", "pid.txt", "30000"], { cwd: workspace, stdio: ["ignore", "pipe", "ignore"] });
    const announced = await new Promise<string>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", (chunk) => resolve(String(chunk)));
    }).catch((error: unknown) => assert.fail(`could not start the sleep runner: ${String(error)}`));
    const pid = Number(readFileSync(join(workspace, "pid.txt"), "utf8"));
    expect(announced.trim()).toBe(`ready ${pid}`);
    expect(pid).toBe(child.pid);
    expect(() => process.kill(pid, 0)).not.toThrow();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  });

  // why: the same runner with a short sleep and a generous timeout completes and is recorded: the timeout
  //   test fails because of the timeout, not because the runner is broken.
  // proves: CLAIM(MC17)
  it("[MC17] control: the sleep runner with a short sleep passes through runExample", async () => {
    const { run } = await setup("sleep-runner.mjs", { extraArgv: ["pid.txt", "50"], timeoutMs: 20_000 });
    expect(must(await run()).status).toBe("passed");
  });

  // why: MC17: "timeout ... process killed". A 30 s sleeper with a 1 s timeout yields RUNNER_TIMEOUT, no run is
  //   recorded, and the process it started no longer exists (kill 0 -> ESRCH). A runner left alive after its
  //   timeout would leak a process per attempt.
  // proves: CLAIM(MC17)
  it("[MC17] RUNNER_TIMEOUT: the sleeping process is killed and gone, nothing is recorded", async () => {
    const { workspace, session, run } = await setup("sleep-runner.mjs", { extraArgv: ["pid.txt", "30000"], timeoutMs: 1000 });
    const error = mustFail(await run());
    expect(error.code).toBe("RUNNER_TIMEOUT");
    const pid = Number(read(workspace, "pid.txt"));
    expect(Number.isInteger(pid) && pid > 1 && pid !== process.pid).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
  });
});

describe("runExample: bad output is RUNNER_OUTPUT_INVALID and imports nothing", () => {
  // why: non-JSON output is rejected as invalid output, not as a crash; no run is recorded.
  // proves: CLAIM(MC17)
  it("[MC17] garbage output: RUNNER_OUTPUT_INVALID, nothing recorded", async () => {
    const { session, run } = await setup("garbage-runner.mjs");
    expect(mustFail(await run()).code).toBe("RUNNER_OUTPUT_INVALID");
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
  });

  // why: schema-invalid output carries the issues with pointers (red-contract 10: "details list pointers"),
  //   here the one fault the fixture has: a passed run without a result.
  // proves: CLAIM(MC17)
  it("[MC17] schema-invalid output: RUNNER_OUTPUT_INVALID listing REQUIRED at /run/result", async () => {
    const { session, run } = await setup("schema-bad-runner.mjs");
    const error = mustFail(await run());
    expect(error.code).toBe("RUNNER_OUTPUT_INVALID");
    expect(pairs(error)).toEqual([["REQUIRED", "/run/result"]]);
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
  });

  // why: a runner that exits 0 and writes nothing has produced no output: RUNNER_OUTPUT_INVALID.
  // proves: CLAIM(MC17)
  it("[MC17] a runner that writes no output: RUNNER_OUTPUT_INVALID", async () => {
    const { session, run } = await setup("no-output-runner.mjs");
    expect(mustFail(await run()).code).toBe("RUNNER_OUTPUT_INVALID");
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
  });

  // why: red-contract 10: "a stale output file is deleted before the run". A valid-looking file from an
  //   EARLIER run lies in the workspace; a runner that writes nothing must not get that file imported.
  //   Positive control right after: a runner that does write replaces it and its own run is recorded.
  // proves: CLAIM(MC17)
  it("[MC17] a stale output file from an earlier run is not imported when the runner writes nothing", async () => {
    const { workspace, session, registryFile, run } = await setup("no-output-runner.mjs");
    writeFileSync(join(workspace, "out.json"), JSON.stringify(passOutput("old-run")));
    expect(mustFail(await run()).code).toBe("RUNNER_OUTPUT_INVALID");
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
    expect(mustFail(await session.getEntity(resultOf("old-run"), "snap-1")).code).toBe("NOT_FOUND");

    writeRegistry(join(registryFile, ".."), [runnerDefinition("pass-runner.mjs", workspace)]); // same file, now a runner that writes
    writeFileSync(join(workspace, "out.json"), JSON.stringify(passOutput("old-run")));
    const recorded = must(await run());
    expect(recorded.runId).not.toBe("old-run");
  });

  // why: the deletion itself, observed from inside the runner: a stale out.json lies in the workspace, and the
  //   probe runner records whether it still exists when it starts. Independent of any run-id check, so it
  //   catches an implementation that merely happens to reject the stale file later.
  // proves: CLAIM(MC17)
  it("[MC17] a stale output file is removed before the runner starts (the runner sees no out.json)", async () => {
    const { workspace, run } = await setup("probe-runner.mjs");
    writeFileSync(join(workspace, "out.json"), JSON.stringify(passOutput("old-run")));
    must(await run());
    expect(read(workspace, "stale-seen.txt")).toBe("no");
  });

  // why: the run id belongs to paneweft; output whose run.runId differs from PANEWEFT_RUN_ID (forged or stale)
  //   is rejected and its entity is not registered.
  // proves: CLAIM(MC17)
  it("[MC17] output whose run.runId differs from PANEWEFT_RUN_ID: RUNNER_OUTPUT_INVALID, nothing registered", async () => {
    const { session, run } = await setup("wrong-id-runner.mjs");
    expect(mustFail(await run()).code).toBe("RUNNER_OUTPUT_INVALID");
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
    expect(mustFail(await session.getEntity(resultOf("forged-run"), "snap-1")).code).toBe("NOT_FOUND");
  });

  // why: runner output bundles are registered atomically with the run (red-contract 10): a valid run whose
  //   bundle holds an invalid member (alias cycle) is rejected whole - no run, no result entity, session tree
  //   untouched.
  // proves: CLAIM(MC17) CLAIM(MC20)
  it("[MC17] a valid run with an invalid bundle member: RUNNER_OUTPUT_INVALID (ALIAS_CYCLE), nothing visible, tree identical", async () => {
    const { sessionDir, session, run } = await setup("bad-bundle-runner.mjs");
    const treeBefore = treeSnapshot(sessionDir);
    const error = mustFail(await run());
    expect(error.code).toBe("RUNNER_OUTPUT_INVALID");
    expect([...new Set(error.errors.map((issue) => issue.code))]).toEqual(["ALIAS_CYCLE"]);
    expect(error.errors.every((issue) => issue.pointer === "/bundle/definitions/0/forward" || issue.pointer === "/bundle/definitions/1/forward")).toBe(true);
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
    expect((await session.listEntities("snap-1")).map((e) => e.id)).toEqual(["mcp", "notes", "watch"]);
    expect(treeSnapshot(sessionDir)).toEqual(treeBefore);
  });
});

describe("runExample: process failures", () => {
  // why: a runner that crashes (exit 3, stderr) is RUNNER_FAILED with its exit code, distinct from
  //   RUNNER_OUTPUT_INVALID (it never produced output) and from RUNNER_TIMEOUT.
  // proves: CLAIM(MC17)
  it("[MC17] a crashing runner: RUNNER_FAILED with details.exitCode 3, nothing recorded", async () => {
    const { session, run } = await setup("crash-runner.mjs");
    const error = mustFail(await run());
    expect(error.code).toBe("RUNNER_FAILED");
    expect(error.details).toMatchObject({ exitCode: 3 });
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
  });

  // why: an executable that does not exist must surface as a typed error, not as an unhandled spawn error.
  // proves: CLAIM(MC17)
  it("[MC17] a missing executable: RUNNER_FAILED, not an exception", async () => {
    const { run } = await setup("pass-runner.mjs", { executable: "/nonexistent/paneweft-fixture-binary" });
    expect(mustFail(await run()).code).toBe("RUNNER_FAILED");
  });
});

describe("runExample: argv is literal, parameters are validated", () => {
  const stringParam = { type: "object", properties: { msg: { type: "string" } }, required: ["msg"], additionalProperties: false };

  // why: MC17/MC15: "no shell". A parameter value full of shell metacharacters arrives as ONE literal argv
  //   element (recorded by the child itself in argv.json) and the canary file is NOT created.
  // proves: CLAIM(MC17) CLAIM(MC15)
  it.each([
    "; touch CANARY",
    "$(touch CANARY)",
    "`touch CANARY`",
    "x && touch CANARY",
    "x | touch CANARY",
    "*",
    "~",
    "${HOME} 'q' \"d\" \\ end",
    "--help -rf",
  ])("[MC17] parameter %j arrives as one literal argv element and creates no file", async (value) => {
    const { workspace, run } = await setup("argv-echo-runner.mjs", { extraArgv: ["{param:msg}"], parameterSchema: stringParam });
    must(await run({ msg: value }));
    expect(JSON.parse(read(workspace, "argv.json"))).toEqual([value]);
    expect(existsSync(join(workspace, "CANARY"))).toBe(false);
  });

  // why: positive control for the canary assertions: the runner CAN create a file in the workspace when it is
  //   asked to, so "CANARY absent" above means the shell was not involved, not that files cannot appear.
  // proves: CLAIM(MC17)
  it("[MC17] control: the same runner creates CANARY when explicitly asked to (touch:CANARY)", async () => {
    const { workspace, run } = await setup("argv-echo-runner.mjs", { extraArgv: ["{param:msg}"], parameterSchema: stringParam });
    must(await run({ msg: "touch:CANARY" }));
    expect(existsSync(join(workspace, "CANARY"))).toBe(true);
  });

  // why: design 5: parameters substitute `{param:name}` inside argv elements. Substitution happens inside an
  //   element (prefix and suffix kept), numbers and booleans become their string form.
  // proves: CLAIM(MC17)
  it("[MC17] {param:name} is substituted inside an argv element; numbers and booleans become strings", async () => {
    const { workspace, run } = await setup("argv-echo-runner.mjs", { extraArgv: ["--name={param:name}-x", "{param:n}", "{param:flag}"] });
    must(await run({ name: "v1", n: 42, flag: true }));
    expect(JSON.parse(read(workspace, "argv.json"))).toEqual(["--name=v1-x", "42", "true"]);
  });

  // why: substitution is one pass: a value that itself looks like a placeholder is passed through untouched,
  //   otherwise one parameter could read another.
  // proves: CLAIM(MC17) CLAIM(MC15)
  it("[MC17] a parameter value that looks like a placeholder is not substituted again", async () => {
    const { workspace, run } = await setup("argv-echo-runner.mjs", { extraArgv: ["{param:a}"] });
    must(await run({ a: "{param:b}", b: "SECOND" }));
    expect(JSON.parse(read(workspace, "argv.json"))).toEqual(["{param:b}"]);
  });

  const countSchema = { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false };

  // why: parameters are validated against the runner's parameterSchema BEFORE anything is spawned. Each
  //   fault is INVALID_ARGUMENT with the Ajv-style issue at the parameter; the runner never starts (no argv.json).
  // proves: CLAIM(MC17)
  it.each([
    ["wrong type", { count: "three" }, [["TYPE", "/parameters/count"]]],
    ["missing required parameter", {}, [["REQUIRED", "/parameters/count"]]],
    ["unknown parameter", { count: 3, extra: true }, [["UNKNOWN_PROPERTY", "/parameters/extra"]]],
  ] as const)("[MC17] %s: INVALID_ARGUMENT and the runner is not started", async (_name, parameters, expected) => {
    const { workspace, session, run } = await setup("argv-echo-runner.mjs", { extraArgv: ["{param:count}"], parameterSchema: countSchema });
    const error = mustFail(await run(parameters as Record<string, string | number | boolean | null>));
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(pairs(error)).toEqual(expected);
    expect(existsSync(join(workspace, "argv.json"))).toBe(false);
    expect(must(await session.listRuns(EXAMPLE_KEY))).toEqual([]);
  });

  // why: positive control for the three rejections: a conforming parameter runs and is substituted.
  // proves: CLAIM(MC17)
  it("[MC17] a parameter conforming to the schema runs the runner with the substituted value", async () => {
    const { workspace, run } = await setup("argv-echo-runner.mjs", { extraArgv: ["{param:count}"], parameterSchema: countSchema });
    must(await run({ count: 3 }));
    expect(JSON.parse(read(workspace, "argv.json"))).toEqual(["3"]);
  });
});
