// Parent side of test/helpers/lock-writer.ts, plus /proc probes and fake `flock` programs for the write-lock tests.
// Linux only (the write lock itself is: it needs util-linux flock and /proc is how the tests see processes and descriptors).
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface WriterEvent { event: string; pid?: number; helperPid?: number; count?: number; result?: any; fdsBefore?: number; fdsAfter?: number; lockDescriptors?: number }
export interface LockWriter {
  readonly child: ChildProcess;
  /** Every event received so far, in order (including ones already awaited). */
  readonly seen: readonly WriterEvent[];
  /** The next unread event with this name; rejects if the child exits first without sending it. */
  waitFor(event: string): Promise<WriterEvent>;
  release(event: string): void;
  /** The "done" event (the mutation's result), or a rejection if the child died first. */
  done(): Promise<WriterEvent>;
  kill(): Promise<void>;
}
export interface WriterJob {
  kind: "import" | "notebook";
  bundle?: unknown;
  pageId?: string;
  revision?: number;
  blocks?: unknown[];
  lockWaitMs?: number;
  /** Hook points at which the child waits for `release`. */
  pause?: string[];
  log?: string;
}

export function spawnLockWriter(dir: string, job: WriterJob, registry: ChildProcess[], env: NodeJS.ProcessEnv = {}): LockWriter {
  const child = fork(fileURLToPath(new URL("./lock-writer.ts", import.meta.url)), [dir, JSON.stringify(job)], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, ...env },
  });
  registry.push(child);
  const seen: WriterEvent[] = [];
  const unread: WriterEvent[] = [];
  const waiting: Array<{ event: string; resolve: (event: WriterEvent) => void; reject: (error: Error) => void }> = [];
  let exited = false;
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  child.stdout?.resume();
  child.on("message", (message: WriterEvent) => {
    seen.push(message);
    const index = waiting.findIndex((waiter) => waiter.event === message.event);
    if (index >= 0) waiting.splice(index, 1)[0]!.resolve(message);
    else unread.push(message);
  });
  child.on("exit", () => {
    exited = true;
    for (const waiter of waiting.splice(0)) waiter.reject(new Error(`writer ${child.pid} exited before sending "${waiter.event}"${stderr === "" ? "" : `; stderr: ${stderr.slice(-600)}`}`));
  });
  const waitFor = (event: string): Promise<WriterEvent> => {
    const index = unread.findIndex((candidate) => candidate.event === event);
    if (index >= 0) return Promise.resolve(unread.splice(index, 1)[0]!);
    if (exited) return Promise.reject(new Error(`writer ${child.pid} exited before sending "${event}"${stderr === "" ? "" : `; stderr: ${stderr.slice(-600)}`}`));
    return new Promise((resolve, reject) => waiting.push({ event, resolve, reject }));
  };
  return {
    child, seen, waitFor,
    release: (event) => { if (child.connected) child.send({ release: event }); },
    done: () => waitFor("done"),
    kill: () => new Promise<void>((resolve) => {
      if (exited) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    }),
  };
}

// ---- /proc probes -----------------------------------------------------------------------------------------------------------

/** The process state letter from /proc/<pid>/stat (R, S, D, T, Z ...), or null when the pid does not exist. */
export function processState(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
  } catch { return null; }
}
/** Alive and not a zombie. */
export const isRunning = (pid: number): boolean => { const state = processState(pid); return state !== null && state !== "Z"; };
/** Where descriptor `fd` of `pid` points, or null. */
export function descriptorTarget(pid: number, fd: number): string | null {
  try { return readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { return null; }
}

// ---- fake flock programs ----------------------------------------------------------------------------------------------------

/** The real flock's absolute path (the fakes delegate to it). */
export function realFlock(): string {
  const found = spawnSync("sh", ["-c", "command -v flock"], { encoding: "utf8" });
  const path = found.stdout.trim();
  if (found.status !== 0 || path === "") throw new Error("util-linux flock is not installed on this machine; the write-lock tests need it");
  return path;
}
/** Creates `<dir>/flock` as an executable /bin/sh script and returns `dir` (put it first on PATH). */
export function fakeFlockDirectory(directory: string, body: string, mode = 0o755): string {
  mkdirSync(directory, { recursive: true });
  const script = join(directory, "flock");
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, mode);
  return directory;
}
/** A PATH with `directory` first, then the real one. */
export const pathWith = (directory: string): string => `${directory}:${process.env.PATH ?? ""}`;
export const lines = (path: string): string[] => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line !== "") : []);
