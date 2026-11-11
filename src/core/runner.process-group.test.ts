// T12 (tier-2 review): a runner is an owner-registered program, and it may start helpers of its own. On timeout only the runner itself was killed
// (SIGKILL to one pid), so a grandchild survived and went on running. The runner is now started as the leader of its own process group
// (`detached`) and the whole group is killed on timeout (and on abort). Process-level facts are read from outside: /proc/<pid>/stat says whether
// a pid is gone or a zombie; the fixture reports its own pid, group and its grandchild's pid.
// proves: CLAIM(runner-timeout-kills-group) CLAIM(no-payload-exec)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runExample } from "./runner.ts";
import { mustFail } from "../../test/helpers/must.ts";
import { importAll, openOk } from "../../test/helpers/store-session.ts";
import { EXAMPLE_KEY, SCENARIO_RUNNER_ID, runnerDefinition, runnerScript, writeRegistry } from "../../test/helpers/store-runner.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();

/** Whether `pid` is a live process: present in /proc and not a zombie (a killed child awaiting reaping is dead for this purpose). */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return (stat.split(") ").pop() ?? "").charAt(0) !== "Z";
  } catch {
    return false;
  }
}
interface Reported { pid: number; pgid: number; grandchild: number }

async function setup(timeoutMs: number) {
  const base = tmp("group");
  const workspace = join(base, "ws");
  mkdirSync(workspace);
  const session = await openOk(join(base, "s"));
  await importAll(session);
  const registryFile = writeRegistry(join(base, "registry"), [runnerDefinition("grandchild-runner.mjs", workspace, { extraArgv: ["pids.json"], timeoutMs })]);
  const reported = (): Reported => JSON.parse(readFileSync(join(workspace, "pids.json"), "utf8")) as Reported;
  const start = (signal?: AbortSignal) => runExample(session, { runnerRegistryFile: registryFile, runnerId: SCENARIO_RUNNER_ID, parameters: {}, key: EXAMPLE_KEY, ...(signal === undefined ? {} : { signal }) });
  return { workspace, reported, start };
}

describe("runner process group (T12)", () => {
  // why: control, so the tests below cannot be vacuous: the fixture really starts a live grandchild in the runner's group when run directly.
  it("control: the fixture starts a live grandchild in its own group (run directly, then cleaned up)", async () => {
    const base = tmp("group-control");
    const child = spawn(process.execPath, [runnerScript("grandchild-runner.mjs"), "out.json", "pids.json"], { cwd: base, stdio: "ignore", detached: true });
    try {
      await vi.waitFor(() => expect(existsSync(join(base, "pids.json"))).toBe(true), { timeout: 10_000, interval: 25 });
      const seen = JSON.parse(readFileSync(join(base, "pids.json"), "utf8")) as Reported;
      expect(seen.pid).toBe(child.pid);
      expect(alive(seen.pid)).toBe(true);
      expect(alive(seen.grandchild)).toBe(true);
      expect(seen.pgid).toBe(seen.pid); // detached: the child leads its own group
    } finally {
      process.kill(-(child.pid as number), "SIGKILL");
    }
  });

  // why: the runner must lead its own group (that is what makes group-kill possible without touching paneweft itself): its group id is its pid,
  //   and it is not paneweft's own group.
  it("the runner is started as the leader of a new process group", async () => {
    const { reported, start } = await setup(1500);
    mustFail(await start());
    const seen = reported();
    expect(seen.pgid).toBe(seen.pid);
    expect(seen.pgid).not.toBe(process.pid);
  });

  // why: the finding. After RUNNER_TIMEOUT neither the runner nor the grandchild it started may still be running.
  it("a timeout kills the runner AND its grandchild", async () => {
    const { reported, start } = await setup(1500);
    const error = mustFail(await start());
    expect(error.code).toBe("RUNNER_TIMEOUT");
    const seen = reported();
    expect(Number.isInteger(seen.grandchild) && seen.grandchild > 1).toBe(true);
    await vi.waitFor(() => expect([alive(seen.pid), alive(seen.grandchild)]).toEqual([false, false]), { timeout: 5000, interval: 25 });
  });

  // why: the same group kill on abort (the CLI aborts on SIGINT/SIGTERM, because a detached runner no longer receives the terminal's signals).
  //   The run is stopped as soon as the fixture reports its pids; the answer is RUNNER_FAILED with details.aborted, not a timeout, and both die.
  it("aborting the run kills the runner and its grandchild and answers RUNNER_FAILED (aborted)", async () => {
    const { workspace, reported, start } = await setup(60_000);
    const controller = new AbortController();
    const finished = start(controller.signal);
    await vi.waitFor(() => expect(existsSync(join(workspace, "pids.json"))).toBe(true), { timeout: 10_000, interval: 25 });
    await vi.waitFor(() => expect(reported().grandchild).toBeGreaterThan(1), { timeout: 5000, interval: 25 });
    controller.abort();
    const error = mustFail(await finished);
    expect(error.code).toBe("RUNNER_FAILED");
    expect(error.details).toMatchObject({ aborted: true });
    const seen = reported();
    await vi.waitFor(() => expect([alive(seen.pid), alive(seen.grandchild)]).toEqual([false, false]), { timeout: 5000, interval: 25 });
  });
});
