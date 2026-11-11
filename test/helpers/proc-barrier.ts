// Parent side of the S5 multi-process tests: spawns real `node --import tsx` children, releases them from the barrier
// inside the session's critical section, and records WHAT HAPPENED, not what should have.
//
// Policy: both children start together (after both are ready). A child that reaches the barrier is released once the OTHER
// child has also reached it, or - if the other cannot get in - after GRACE_MS. With mutual exclusion the second child
// cannot reach the barrier while the first is inside, so `reachedBeforeFirstRelease` is 1; without it, both reach it within
// milliseconds and are released together (the interleaving a lock exists to forbid). The grace window is real time spent only
// in the passing case; process start-up skew is excluded because the start is synchronised.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./fixtures.ts";

export const GRACE_MS = 1000;
export interface ChildOutcome { id: string; exitCode: number; result: { ok: boolean; code?: string; details?: unknown } | null; stderr: string }
export interface BarrierRun { outcomes: ChildOutcome[]; reachedBeforeFirstRelease: number; events: string[] }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runBarriered(sessionDir: string, barrierDir: string, operations: Array<{ id: string; operation: Record<string, unknown> }>): Promise<BarrierRun> {
  mkdirSync(barrierDir, { recursive: true });
  const exited = new Map<string, ChildOutcome>();
  const done = operations.map(({ id, operation }) => new Promise<void>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "test/helpers/proc-session-child.ts", sessionDir, barrierDir, id, JSON.stringify(operation)], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (part: Buffer) => void (stdout += part.toString("utf8")));
    child.stderr.on("data", (part: Buffer) => void (stderr += part.toString("utf8")));
    child.on("close", (code) => {
      const last = stdout.trim().split("\n").pop() ?? "";
      let result: ChildOutcome["result"] = null;
      try { result = JSON.parse(last); } catch { /* reported through result: null */ }
      exited.set(id, { id, exitCode: code ?? -1, result, stderr });
      resolve();
    });
  }));

  const has = (file: string) => existsSync(join(barrierDir, file));
  const ids = operations.map((o) => o.id);
  while (!ids.every((id) => has(`ready.${id}`) || exited.has(id))) await sleep(10);
  writeFileSync(join(barrierDir, "start"), "");

  const events: string[] = [];
  const reached = new Set<string>();
  const released = new Set<string>();
  let firstReachedAt: number | null = null;
  let reachedBeforeFirstRelease = 0;
  while (exited.size < ids.length) {
    for (const id of ids) {
      if (!reached.has(id) && has(`reached.${id}`)) {
        reached.add(id);
        events.push(`reached:${id}`);
        firstReachedAt ??= Date.now();
      }
    }
    const everyoneIn = ids.every((id) => reached.has(id) || exited.has(id));
    if (firstReachedAt !== null && (everyoneIn || Date.now() - firstReachedAt >= GRACE_MS)) {
      for (const id of ids) {
        if (reached.has(id) && !released.has(id)) {
          if (released.size === 0) reachedBeforeFirstRelease = reached.size;
          released.add(id);
          writeFileSync(join(barrierDir, `go.${id}`), "");
          events.push(`release:${id}`);
        }
      }
    }
    await sleep(10);
  }
  await Promise.all(done);
  return { outcomes: ids.map((id) => exited.get(id) as ChildOutcome), reachedBeforeFirstRelease, events };
}
