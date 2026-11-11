// Who a process is, in a way that survives pid reuse and reboots (review round 2, S2). Used by the session lock to decide whether the
// holder of a lock still exists.
// CLAIM(process-identity): an identity is (boot_id, pid, process start time). A recorded identity is DEAD only when its process cannot be the
//   same one any more: the machine booted since (boot_id differs), or there is no such pid (or it is a zombie), or the pid now belongs to a process
//   that started at a different time. Age never enters; a missing field can only make an identity look LIVE, never dead
//   [process-identity.test.ts, session.lock-recovery.test.ts].
// Sources (Linux): /proc/sys/kernel/random/boot_id, and field 22 (starttime, clock ticks since boot) of /proc/<pid>/stat. The stat line is
//   `pid (comm) state ppid ...` where comm may itself contain spaces and parentheses, so fields are counted after the LAST ")".
// Without /proc the boot id and start time are null and only "no such pid" proves death (kill(pid, 0) says ESRCH); a reused pid then
// looks live, which keeps a lock held rather than breaking a live one.
import { readFile } from "node:fs/promises";

export interface ProcessIdentity {
  readonly bootId: string | null;
  readonly pid: number;
  /** /proc/<pid>/stat field 22; null when it cannot be read. */
  readonly startTime: number | null;
}

let cachedBootId: Promise<string | null> | undefined;
/** The kernel's id of this boot, or null where /proc does not provide it. */
export function currentBootId(): Promise<string | null> {
  cachedBootId ??= readFile("/proc/sys/kernel/random/boot_id", "utf8").then((text) => text.trim() || null, () => null);
  return cachedBootId;
}

type ProcState = { kind: "absent" } | { kind: "unknown" } | { kind: "present"; state: string; startTime: number };

/** What /proc says about `pid` now: absent (no such process), unknown (/proc cannot answer) or present. */
async function readProcState(pid: number): Promise<ProcState> {
  let text: string;
  try {
    text = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "unknown" };
    return (await readFile("/proc/self/stat", "utf8").then(() => true, () => false)) ? { kind: "absent" } : { kind: "unknown" };
  }
  const close = text.lastIndexOf(")");
  const fields = close < 0 ? [] : text.slice(close + 2).split(" "); // fields[0] is field 3 (state); field 22 is fields[19]
  const startTime = Number(fields[19]);
  return fields[0] !== undefined && Number.isInteger(startTime) ? { kind: "present", state: fields[0], startTime } : { kind: "unknown" };
}

/** The identity of the process `pid` right now (null start time when /proc cannot say). */
export async function identityOf(pid: number): Promise<ProcessIdentity> {
  const proc = await readProcState(pid);
  return { bootId: await currentBootId(), pid, startTime: proc.kind === "present" ? proc.startTime : null };
}

/** True unless `identity` is provably gone (see CLAIM(process-identity)). */
export async function isAlive(identity: ProcessIdentity): Promise<boolean> {
  const bootId = await currentBootId();
  if (identity.bootId !== null && bootId !== null && identity.bootId !== bootId) return false;
  const proc = await readProcState(identity.pid);
  if (proc.kind === "absent") return false;
  if (proc.kind === "unknown") return killSaysAlive(identity.pid);
  if (proc.state === "Z" || proc.state === "X") return false; // exited, only the table entry is left
  return identity.startTime === null || identity.startTime === proc.startTime;
}

function killSaysAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
