// Real child process for the flock write-lock tests (session.write-lock.test.ts). It runs the actual Session; IPC barriers suspend the
// actual critical section at named hook points, and nothing about the lock, the read or the commit is simulated.
// Every hook point reports {event, pid, ...} to the parent. A point named in `job.pause` additionally waits until the parent releases it.
// `job.log` (a file path) receives one O_APPEND line "enter <pid>" when the lock is acquired and "leave <pid>" right after the manifest
// rename, still inside the lock; the kernel orders those appends, so the file is a total order of critical sections across processes.
import { appendFileSync, readdirSync } from "node:fs";
import { openSession, type SessionTestHooks } from "../../src/core/session.ts";

const [dir, jobText] = process.argv.slice(2);
const job = JSON.parse(jobText!) as {
  kind: "import" | "notebook";
  bundle?: unknown;
  pageId?: string;
  revision?: number;
  blocks?: unknown[];
  lockWaitMs?: number;
  pause?: string[];
  log?: string;
};
const pausing = new Set(job.pause ?? []);
const waiters = new Map<string, () => void>();
const permits = new Set<string>();
process.on("message", (message: { release: string }) => {
  const resume = waiters.get(message.release);
  if (resume) { waiters.delete(message.release); resume(); }
  else permits.add(message.release);
});
async function hit(event: string, extra: Record<string, unknown> = {}): Promise<void> {
  process.send!({ event, pid: process.pid, ...extra });
  if (!pausing.has(event) || permits.delete(event)) return;
  await new Promise<void>((resolve) => waiters.set(event, resolve));
}
const descriptors = (): number => readdirSync("/proc/self/fd").length;

const fdsBefore = descriptors();
const hooks: SessionTestHooks = {
  beforeLockAcquire: () => hit("before-lock"),
  afterHelperSpawned: ({ helperPid }) => hit("helper-spawned", { helperPid }),
  afterLockAcquired: () => { if (job.log) appendFileSync(job.log, `enter ${process.pid}\n`); return hit("lock-acquired"); },
  afterManifestRead: () => hit("read"),
  afterWrite: ({ count }) => hit("staged", { count }),
  beforeManifestSwap: () => hit("before-swap"),
  beforeManifestRename: () => hit("before-rename"),
  afterManifestRename: () => { if (job.log) appendFileSync(job.log, `leave ${process.pid}\n`); return hit("after-rename"); },
};
const opened = await openSession(dir!, { testHooks: hooks, ...(job.lockWaitMs === undefined ? {} : { lockWaitMs: job.lockWaitMs }) });
if (!opened.ok) process.send!({ event: "done", pid: process.pid, result: opened });
else {
  const result = job.kind === "import"
    ? await opened.value.importBundle(job.bundle)
    : await opened.value.notebookUpdate(job.pageId!, job.revision!, { blocks: job.blocks! });
  await opened.value.close();
  process.send!({ event: "done", pid: process.pid, result, fdsBefore, fdsAfter: descriptors() });
}
process.disconnect();
