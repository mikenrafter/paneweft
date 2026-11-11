// The session write lock: a kernel-managed flock(2) on a descriptor of the permanent file `<session>/.write.lock`.
//
// Why a helper process: Node has no flock(2). util-linux `flock(1)` can take the lock on an INHERITED descriptor and exit; flock locks belong
// to the open file description, which the helper shares with this process, so the lock outlives the helper and ends when the LAST descriptor on
// that description closes: here, when this module closes its handle, or when this process dies by any means (the kernel closes it).
// There is therefore no owner record, no staleness judgement and no recovery protocol: a crashed holder cannot leave the lock behind.
//
// Protocol of one acquisition (withWriteLock):
//   1. open `<dir>/.write.lock` read-write, creating it if needed: a FRESH open per call, even within one process (two opens contend).
//      The file is permanent: never unlinked, renamed, replaced or written.
//   2. spawn `flock --exclusive --timeout <seconds> 3` directly (no shell) with that handle as the child's descriptor 3; stdin/stdout ignored,
//      stderr drained. The helper blocks in the kernel until it holds the lock or the timeout passes.
//   3. wait for the helper's exit. Exit code 0 without a signal is the ONLY acquisition. (The `spawn` event only says a process exists.)
//   4. run the critical section.
//   5. close the descriptor in `finally`, after the critical section's promise settled. Nothing else releases the lock.
// Every failure before step 4 (spawn error, contention timeout, a signal, a nonzero exit, an exception in the spawn callback) runs no critical
// section; a helper that might still be running is killed and reaped BEFORE the descriptor is closed.
//
// CLAIM(flock-acquisition): the critical section starts only after the helper exited 0 with no signal [write-lock.test.ts, session.write-lock.test.ts]
// CLAIM(flock-exclusion): two acquisitions, from two processes or from two opens in one process, never run their sections at the same time
//   [session.write-lock.test.ts, write-lock.test.ts]
// CLAIM(flock-crash-safety): the lock is released by the kernel when its holder dies, at any point [session.write-lock.test.ts, SIGKILL cases]
// CLAIM(flock-no-leak): on every outcome the descriptor is closed and no helper is left running or unreaped [write-lock.test.ts, session.write-lock.test.ts]
// CLAIM(flock-dependency): a missing `flock` binary is reported as its own failure kind naming util-linux [write-lock.test.ts, session.write-lock.test.ts]
// Failures are WriteLockError with a `kind`; errors thrown by the critical section or by `onHelperSpawned` pass through unchanged.
// Linux/util-linux only: `flock(1)` from util-linux must be on PATH (documented in README.md).
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export const WRITE_LOCK_FILE = ".write.lock";
/** The descriptor number the helper sees the lock file as (the fourth `stdio` entry). `flock(1)` takes it as its last argument. */
const HELPER_DESCRIPTOR = 3;
/** flock(1) exits with this code when --timeout expired (its default --conflict-exit-code). */
const EXIT_TIMEOUT = 1;
const STDERR_KEPT_CHARS = 2000;

/**
 * - `contended`: another descriptor held the lock for the whole wait (retryable).
 * - `flock-missing`: there is no `flock` program on PATH (util-linux is not installed).
 * - `flock-failed`: the helper could not be started, was killed, or exited with an error other than the timeout.
 * - `lock-file-unavailable`: `<dir>/.write.lock` could not be opened.
 */
export type WriteLockFailureKind = "contended" | "flock-missing" | "flock-failed" | "lock-file-unavailable";

export class WriteLockError extends Error {
  readonly kind: WriteLockFailureKind;
  constructor(kind: WriteLockFailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface WriteLockOptions {
  /** How long the helper waits for a lock another descriptor holds, in whole milliseconds (>= 1). */
  waitMs: number;
  /** Called with the helper's pid right after it was spawned, before the lock is known to be held. Awaited; if it throws, the helper is killed and reaped. */
  onHelperSpawned?: (helperPid: number) => void | Promise<void>;
}

interface HelperOutcome {
  /** False when the process could not be started (ENOENT, EACCES ...); then `spawnError` says why and there is no exit status. */
  started: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError: NodeJS.ErrnoException | null;
  stderr: string;
}

/**
 * Runs `criticalSection` while holding the exclusive write lock of the session directory `directory` (which must exist).
 * Rejects with WriteLockError when the lock was not acquired; the section has not run then. Otherwise settles like the section, and the
 * lock is released only after the section settled.
 */
export async function withWriteLock<T>(directory: string, options: WriteLockOptions, criticalSection: () => Promise<T>): Promise<T> {
  const path = join(directory, WRITE_LOCK_FILE);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDWR | constants.O_CREAT);
  } catch (error) {
    throw new WriteLockError("lock-file-unavailable", `cannot open the session lock file "${path}": ${describe(error)}`);
  }
  try {
    await acquire(handle, options);
    return await criticalSection();
  } finally {
    // Closing releases the lock. A failing close() still closes the descriptor on Linux and the section's outcome is already decided,
    // so a close error must not replace it.
    await handle.close().catch(() => undefined);
  }
}

/** Resolves when the helper reported the lock acquired; otherwise throws WriteLockError (or the callback's error) after cleaning the helper up. */
async function acquire(handle: FileHandle, options: WriteLockOptions): Promise<void> {
  const seconds = options.waitMs / 1000;
  let child: ChildProcess;
  try {
    child = spawn("flock", ["--exclusive", "--timeout", String(seconds), String(HELPER_DESCRIPTOR)], { stdio: ["ignore", "ignore", "pipe", handle.fd] });
  } catch (error) {
    throw new WriteLockError("flock-failed", `cannot start the \`flock\` program: ${describe(error)}`);
  }
  const outcome = watch(child);
  try {
    if (child.pid !== undefined) await options.onHelperSpawned?.(child.pid);
    assertAcquired(await outcome, options.waitMs);
  } catch (error) {
    await terminateAndReap(child, outcome); // a no-op for a helper that already ended
    throw error;
  }
}

/** Collects the helper's end: exit, spawn failure and a bounded copy of stderr (which is drained fully so the helper never blocks on a full pipe). */
function watch(child: ChildProcess): Promise<HelperOutcome> {
  return new Promise<HelperOutcome>((resolve) => {
    let stderr = "";
    let spawnError: NodeJS.ErrnoException | null = null;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { if (stderr.length < STDERR_KEPT_CHARS) stderr += chunk.slice(0, STDERR_KEPT_CHARS - stderr.length); });
    child.stderr?.on("error", () => undefined);
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => resolve({ started: child.pid !== undefined, code, signal, spawnError, stderr });
    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
      if (child.pid !== undefined) return; // it started: its exit and 'close' follow
      // It never started, so there is no exit. Node closes the stderr socketpair it had already made a moment AFTER 'error'; answering before that
      // would return with a descriptor still open (CLAIM(flock-no-leak)), so wait for the stream's own close.
      const stream = child.stderr;
      if (stream === null || stream.destroyed) finish(null, null);
      else { stream.once("close", () => finish(null, null)); stream.destroy(); }
    });
    // 'close' follows 'exit' once stdio ended, so the kept stderr is complete and no pipe of ours is left open.
    child.once("close", finish);
  });
}

function assertAcquired(result: HelperOutcome, waitMs: number): void {
  if (!result.started) {
    if (result.spawnError?.code === "ENOENT") {
      throw new WriteLockError("flock-missing", "the `flock` program was not found on PATH; the session write lock needs util-linux (install the util-linux package)");
    }
    throw new WriteLockError("flock-failed", `cannot start the \`flock\` program: ${describe(result.spawnError ?? "no process was created")}`);
  }
  if (result.signal !== null) {
    throw new WriteLockError("flock-failed", `the \`flock\` helper was killed by ${result.signal} before it reported the lock${tail(result.stderr)}`);
  }
  if (result.code === 0) return;
  if (result.code === EXIT_TIMEOUT) {
    throw new WriteLockError("contended", `another writer held the session lock for more than ${waitMs} ms`);
  }
  throw new WriteLockError("flock-failed", `the \`flock\` helper exited with code ${String(result.code)}${tail(result.stderr)}`);
}

/** SIGKILLs the helper if it still runs, then waits for it to be reaped. After this returns no process of ours holds the descriptor. */
async function terminateAndReap(child: ChildProcess, outcome: Promise<HelperOutcome>): Promise<void> {
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await outcome;
}

const tail = (stderr: string): string => (stderr.trim() === "" ? "" : `: ${stderr.trim()}`);
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
