// Real child process used by session.processes.test.ts. IPC barriers suspend the actual store's
// critical section; they do not simulate a read, write, lock, or operation result.
import { openSession } from "../../src/core/session.ts";

const [dir, job] = process.argv.slice(2);
const spec = JSON.parse(job!);
const pausing = new Set<string>(spec.pause ?? []);
const waiters = new Map<string, () => void>();
const permits = new Set<string>();
process.on("message", (message: { release: string }) => {
  const resume = waiters.get(message.release);
  if (resume) { waiters.delete(message.release); resume(); }
  else permits.add(message.release);
});
async function barrier(event: string, extra: Record<string, unknown> = {}): Promise<void> {
  process.send!({ event, pid: process.pid, ...extra });
  if (permits.delete(event)) return;
  await new Promise<void>((resolve) => waiters.set(event, resolve));
}
const opened = await openSession(dir!, { testHooks: {
  beforeLockAcquire: () => barrier("before-lock"),
  onLockContended: () => barrier("contended"),
  afterManifestRead: () => barrier("read"),
  afterStaleObserved: () => barrier("stale-observed"),
  // the recovery-protocol barriers (review round 2) are opt-in per writer: a job lists them in `pause`, so older tests never block on them
  afterRecoveryMutexTaken: () => (pausing.has("mutex-held") ? barrier("mutex-held") : undefined),
  afterMutexStaleObserved: () => (pausing.has("mutex-stale-observed") ? barrier("mutex-stale-observed") : undefined),
  afterDisplaced: ({ target }) => (pausing.has("displaced") ? barrier("displaced", { target }) : undefined),
  afterStaleResolved: ({ broke }) => { process.send!({ event: "stale-resolved", pid: process.pid, broke }); }, // reported, not a barrier
}, ...(spec.lockWaitMs === undefined ? {} : { lockWaitMs: spec.lockWaitMs }) });
if (!opened.ok) process.send!({ event: "done", result: opened });
else {
  const result = spec.kind === "import"
    ? await opened.value.importBundle(spec.bundle)
    : await opened.value.notebookUpdate(spec.pageId, spec.revision, { blocks: spec.blocks });
  await opened.value.close();
  process.send!({ event: "done", result });
}
process.disconnect();
