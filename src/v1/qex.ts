// The qex client: the queue is the supervisor that outlives MCP clients (amendments S2, S3, N1, N2).
// Spawns the `qex` found on the given PATH with a literal argument vector; no shell.
import { execFile } from "node:child_process";
import { err, ok, type Result } from "../core/errors.ts";

export interface QexJob {
  id: string;
  name?: string;
  state: "queued" | "starting" | "running" | "completed" | "failed" | "killed" | "timeout" | "expired" | "oom" | "cancelled" | "skipped";
  exit_code: number | null;
  signal: string | null;
  dedupe_key: string | null;
  cwd?: string;
  command?: string[];
}

export const QEX_TERMINAL_STATES: ReadonlyArray<QexJob["state"]> = ["completed", "failed", "killed", "timeout", "expired", "oom", "cancelled", "skipped"];

export interface QexClient {
  /** `args` are the full argument vector after `qex`, starting with "submit". Returns the job id. */
  submit(args: string[]): Promise<Result<{ id: string }>>;
  /** `qex list --json --all`. */
  list(): Promise<Result<QexJob[]>>;
  status(id: string): Promise<Result<QexJob>>;
  cancel(id: string): Promise<Result<void>>;
  kill(id: string): Promise<Result<void>>;
  logs(id: string, options?: { tail?: number }): Promise<Result<string>>;
  /** Blocks until the job stops or `timeoutMs` passes (event driven: no polling loop); resolves with the stopped job, or `undefined` when
   * the wait ended with the job still running. */
  wait(id: string, timeoutMs: number): Promise<Result<QexJob | undefined>>;
}

interface Executed { code: number | null; stdout: string; stderr: string; spawnFailed?: string }

function execute(executable: string, args: string[], env: NodeJS.ProcessEnv | undefined): Promise<Executed> {
  return new Promise((resolve) => {
    execFile(executable, args, { env, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) return resolve({ code: 0, stdout, stderr });
      const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
      if (typeof code === "number") return resolve({ code, stdout, stderr });
      resolve({ code: null, stdout, stderr, spawnFailed: error.message });
    });
  });
}

function waitFor(executable: string, id: string, timeoutMs: number, env: NodeJS.ProcessEnv | undefined): Promise<Result<QexJob | undefined>> {
  return new Promise((resolve) => {
    execFile(executable, ["wait", id], { env, timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null && (error as { killed?: boolean }).killed === true) return resolve(ok(undefined));
      // `qex wait` exits with the job's own status, so a nonzero exit is not a failure to wait; what matters is the job it printed.
      try {
        const job = toJob(JSON.parse(stdout));
        resolve(ok(job));
      } catch {
        resolve(ok(undefined));
      }
    });
  });
}

function failure(verb: string, result: Executed): Result<never> {
  const detail = result.spawnFailed ?? (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`);
  return err("RUNNER_FAILED", `qex ${verb} failed: ${detail}`, { retryable: result.code !== 1, details: { exitCode: result.code, stderr: result.stderr.slice(0, 1000) } });
}

/** The job object of a `qex status --json` / list entry, tolerating a wrapper member named `job`. */
function toJob(value: unknown): QexJob | undefined {
  const candidate = (value as { job?: unknown } | null)?.job ?? value;
  if (candidate === null || typeof candidate !== "object") return undefined;
  const job = candidate as Partial<QexJob>;
  if (typeof job.id !== "string" || typeof job.state !== "string") return undefined;
  return { ...(job as QexJob), exit_code: job.exit_code ?? null, signal: job.signal ?? null, dedupe_key: job.dedupe_key ?? null };
}

/** Spawns the `qex` found on `env.PATH` (tests put the fake first). No shell. */
export function createQexClient(options: { executable?: string; env?: NodeJS.ProcessEnv } = {}): QexClient {
  const executable = options.executable ?? "qex";
  const call = (args: string[]): Promise<Executed> => execute(executable, args, options.env);
  return {
    async submit(args) {
      const result = await call(args);
      if (result.code !== 0) return failure("submit", result);
      const id = result.stdout.trim().split("\n")[0]?.trim() ?? "";
      return id.length === 0 ? err("RUNNER_OUTPUT_INVALID", "qex submit printed no job id") : ok({ id });
    },
    async list() {
      const result = await call(["list", "--json", "--all"]);
      if (result.code !== 0) return failure("list", result);
      try {
        const parsed = JSON.parse(result.stdout) as unknown;
        const entries = Array.isArray(parsed) ? parsed : ((parsed as { jobs?: unknown[] } | null)?.jobs ?? []);
        return ok(entries.map(toJob).filter((job): job is QexJob => job !== undefined));
      } catch {
        return err("RUNNER_OUTPUT_INVALID", "qex list --json printed something that is not JSON");
      }
    },
    async status(id) {
      const result = await call(["status", id, "--json"]);
      if (result.code !== 0) return failure("status", result);
      try {
        const job = toJob(JSON.parse(result.stdout));
        return job === undefined ? err("RUNNER_OUTPUT_INVALID", "qex status --json printed no job") : ok(job);
      } catch {
        return err("RUNNER_OUTPUT_INVALID", "qex status --json printed something that is not JSON");
      }
    },
    async cancel(id) {
      const result = await call(["cancel", id]);
      return result.code === 0 ? ok(undefined) : failure("cancel", result);
    },
    async kill(id) {
      const result = await call(["kill", id]);
      return result.code === 0 ? ok(undefined) : failure("kill", result);
    },
    wait: (id, timeoutMs) => waitFor(executable, id, timeoutMs, options.env),
    async logs(id, logOptions = {}) {
      const result = await call(["logs", id, ...(logOptions.tail === undefined ? [] : ["--tail", String(logOptions.tail)])]);
      return result.code === 0 ? ok(result.stdout) : failure("logs", result);
    },
  };
}
