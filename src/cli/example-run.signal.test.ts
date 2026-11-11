// T12 (tier-2 review): runners are started detached (their own process group) so a timeout can kill the whole group. A detached runner no longer
// receives the terminal's Ctrl-C, so `paneweft example run` turns SIGINT/SIGTERM into an abort that kills the runner's group. Without that, interrupting
// the CLI would leave the runner (and its helpers) running with nobody to time them out.
// proves: CLAIM(runner-timeout-kills-group)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { REPO_ROOT } from "../../test/helpers/fixtures.ts";
import { importAll, openOk } from "../../test/helpers/store-session.ts";
import { EXAMPLE_KEY, SCENARIO_RUNNER_ID, runnerDefinition, writeRegistry } from "../../test/helpers/store-runner.ts";
import { parseBody } from "../../test/helpers/wire-session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
function alive(pid: number): boolean {
  try { return ((readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop() ?? "").charAt(0)) !== "Z"; } catch { return false; }
}

describe("cli: example run is interruptible (T12)", () => {
  it.each(["SIGINT", "SIGTERM"] as const)("%s to the CLI stops the runner and its grandchild; the CLI reports RUNNER_FAILED (aborted), exit 1", async (signal) => {
    const base = tmp("run-signal");
    const workspace = join(base, "ws");
    mkdirSync(workspace);
    const sessionDir = join(base, "s");
    const session = await openOk(sessionDir);
    await importAll(session);
    await session.close();
    const registry = writeRegistry(join(base, "registry"), [runnerDefinition("grandchild-runner.mjs", workspace, { extraArgv: ["pids.json"], timeoutMs: 120_000 })]);
    const { NODE_OPTIONS: _dropped, ...env } = process.env;
    const child = spawn(process.execPath, ["src/cli/bin.ts", "--session", sessionDir, "example", "run", SCENARIO_RUNNER_ID, "--runners", registry, "--view", EXAMPLE_KEY.viewId, "--snapshot", EXAMPLE_KEY.snapshotId], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (part: Buffer) => void (stdout += part.toString("utf8")));
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("close", (code, by) => resolve({ code, signal: by })));
    let seen: { pid: number; pgid: number; grandchild: number } | undefined;
    try {
      await vi.waitFor(() => {
        expect(existsSync(join(workspace, "pids.json"))).toBe(true);
        seen = JSON.parse(readFileSync(join(workspace, "pids.json"), "utf8"));
      }, { timeout: 15_000, interval: 25 });
      const reported = seen as { pid: number; pgid: number; grandchild: number };
      expect([alive(reported.pid), alive(reported.grandchild)]).toEqual([true, true]);
      child.kill(signal);
      expect(await closed).toEqual({ code: 1, signal: null });
      expect(parseBody(stdout).code).toBe("RUNNER_FAILED");
      expect(parseBody(stdout).details).toMatchObject({ aborted: true });
      await vi.waitFor(() => expect([alive(reported.pid), alive(reported.grandchild)]).toEqual([false, false]), { timeout: 5000, interval: 25 });
    } finally {
      child.kill("SIGKILL");
      if (seen !== undefined) { try { process.kill(-seen.pgid, "SIGKILL"); } catch { /* already gone */ } }
    }
  });
});
