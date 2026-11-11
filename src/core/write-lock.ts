// The session write lock: a kernel-managed flock(2) on a descriptor of the permanent file `<session>/.write.lock`.
// RED-PHASE STUB: the API is final, the body is not written yet (tests/ are red against it).

export const WRITE_LOCK_FILE = ".write.lock";

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
  /** Called with the helper's pid right after it was spawned, before the lock is known to be held. Awaited. */
  onHelperSpawned?: (helperPid: number) => void | Promise<void>;
}

export async function withWriteLock<T>(_directory: string, _options: WriteLockOptions, _criticalSection: () => Promise<T>): Promise<T> {
  throw new Error("NOT_IMPLEMENTED: withWriteLock");
}
