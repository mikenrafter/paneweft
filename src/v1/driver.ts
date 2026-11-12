// Jobs that advance without anyone asking (F20). A collection job is driven by whoever calls `status`: it submits the run stage after the catalogue export and imports the results when
// qex says the job stopped. A CLI `collect` exits as soon as the job is submitted and an MCP client may go away, so in the field test the export finished, and the run stage and the
// import never happened until somebody polled. The service therefore hands each job it submitted to a DRIVER: a detached process that does what a polling agent would do, `status` with
// a wait, until the job is terminal. It owns nothing the files do not hold: a driver that dies, a server that restarts or an agent that polls instead all work (S2, S41), and
// `cancel` reaches the same job from any process.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TERMINAL_JOB_STATES, type JobService } from "./jobs.ts";

const DRIVER_MAIN = fileURLToPath(new URL("./driver-main.ts", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface DriveOptions {
  /** How long a job may stay `indeterminate` (qex unreachable) before the driver gives up. A later `status` or `collect` still advances it. */
  indeterminateMs?: number;
  /** Pause between looks at an `indeterminate` job. */
  retryMs?: number;
}

/** Follows `jobId` to its end: `status` with the longest wait, again and again. Returns the state it left the job in, or the error code that ended the drive. */
export async function driveJob(jobs: JobService, jobId: string, options: DriveOptions = {}): Promise<string> {
  const indeterminateMs = options.indeterminateMs ?? 10 * 60_000;
  const retryMs = options.retryMs ?? 5_000;
  let stuckSince: number | undefined;
  for (;;) {
    const status = await jobs.status(jobId, { waitSeconds: 30 });
    if (!status.ok) return status.error.code;
    const state = status.value.state;
    if (TERMINAL_JOB_STATES.includes(state)) return state;
    if (state === "indeterminate") {
      stuckSince ??= Date.now();
      if (Date.now() - stuckSince > indeterminateMs) return state;
      await sleep(retryMs);
    } else stuckSince = undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The `drive` hook of a job service: starts `driver-main.ts` for the job as a detached process (own session, no stdio, log in the job directory) unless the driver recorded for the
 * job is still alive. The child inherits this process's environment and node flags, so a driver sees the same qex, session and loader as the process that submitted the job. */
export function spawnJobDriver(sessionDir: string, options: { execArgv?: string[]; env?: NodeJS.ProcessEnv } = {}): (jobId: string) => void {
  return (jobId) => {
    const directory = join(sessionDir, "jobs", jobId);
    try {
      mkdirSync(directory, { recursive: true });
      const recorded = (() => { try { return JSON.parse(readFileSync(join(directory, "driver.json"), "utf8")) as { pid?: number }; } catch { return undefined; } })();
      if (typeof recorded?.pid === "number" && alive(recorded.pid)) return;
      const log = openSync(join(directory, "driver.log"), "a");
      try {
        const child = spawn(process.execPath, [...(options.execArgv ?? process.execArgv), DRIVER_MAIN, sessionDir, jobId], { detached: true, stdio: ["ignore", log, log], env: options.env ?? process.env });
        child.on("error", () => undefined);
        child.unref();
        if (child.pid !== undefined) writeFileSync(join(directory, "driver.json"), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }));
      } finally {
        closeSync(log);
      }
    } catch {
      // a job that cannot be driven is still advanced by whoever polls it
    }
  };
}
