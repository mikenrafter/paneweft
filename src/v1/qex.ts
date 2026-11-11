// The qex client: the queue is the supervisor that outlives MCP clients (amendments S2, S3, N1, N2).
import type { Result } from "../core/errors.ts";
import { notImplemented } from "./stub.ts";

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
}

/** Spawns the `qex` found on `env.PATH` (tests put the fake first). No shell. STUB. */
export function createQexClient(options: { executable?: string; env?: NodeJS.ProcessEnv } = {}): QexClient {
  const fail = <T>(what: string): Promise<Result<T>> => Promise.resolve(notImplemented(what));
  return { submit: () => fail("qex submit"), list: () => fail("qex list"), status: () => fail("qex status"), cancel: () => fail("qex cancel"), kill: () => fail("qex kill"), logs: () => fail("qex logs") };
}
