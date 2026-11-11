// Review S2: two contenders could both judge the same dead lock owner stale. One recovered and acquired the lock; the other then
// removed the LIVE replacement lock, so two processes mutated the session at once.
// These tests use real OS processes. IPC barriers (test/helpers/session-writer.ts) hold a contender between "I judged the owner dead"
// and "I break the lock" while another contender completes recovery, which makes the interleaving deterministic, without sleeps.
// Mutation note: the pre-fix logic (unlink owner, rmdir, by pathname, no ownership check) FAILS the first test: the late contender reports
// broke=true and removes the live owner file. The second test is the symmetric guard (all contenders at once); the pre-fix logic happened to
// pass it in the observed interleaving, so it protects the new protocol rather than proving the old defect.
// proves: CLAIM(process-lock) CLAIM(stale-lock-recovery)
import { spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSession } from "./session.ts";
import { must } from "../../test/helpers/must.ts";
import { firstToSend, spawnWriter } from "../../test/helpers/process-writer.ts";
import { subBundle } from "../../test/helpers/store-session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill(); });

/** The pid of a process that has already exited (so `kill(pid, 0)` says ESRCH). */
function deadPid(): number {
  const run = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(run.stdout);
}
/** A session directory whose lock was left behind by a writer that died holding it. */
function sessionWithDeadLock(): { dir: string; lock: string } {
  const dir = tmp("stale-lock");
  const lock = join(dir, ".lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner"), JSON.stringify({ pid: deadPid(), token: "dead-owner-token" }));
  return { dir, lock };
}
const importing = (viewId: string) => ({ kind: "import", bundle: subBundle([viewId]) });
const ownerOf = (lock: string): { pid: number; token: string } => JSON.parse(readFileSync(join(lock, "owner"), "utf8"));

describe("[S2] stale lock recovery never removes a live replacement lock", () => {
  // why: B judges the dead owner stale and is held; A recovers and takes the lock; B is released and must NOT touch A's lock.
  it("a contender that judged the dead owner stale earlier cannot break the lock the first contender now holds", async () => {
    const { dir, lock } = sessionWithDeadLock();
    const late = spawnWriter(dir, importing("layout"), children);
    await late.waitFor("before-lock"); late.release("before-lock");
    await late.waitFor("contended"); late.release("contended");
    const observed = await late.waitFor("stale-observed"); // B has judged "dead-owner-token" stale and is held here

    const first = spawnWriter(dir, importing("modules"), children);
    await first.waitFor("before-lock"); first.release("before-lock");
    await first.waitFor("contended"); first.release("contended");
    await first.waitFor("stale-observed"); first.release("stale-observed");
    const holding = await first.waitFor("read"); // A recovered the dead lock and now holds its own, inside the critical section
    expect(holding.pid).not.toBe(observed.pid);
    expect(ownerOf(lock).pid, "control: the live lock on disk is A's").toBe(holding.pid);

    late.release("stale-observed");
    const resolved = await late.waitFor("stale-resolved");
    expect(resolved.broke, "B must not report that it broke the lock").toBe(false);
    expect(ownerOf(lock).pid, "A's live lock must survive B's recovery attempt").toBe(holding.pid);

    first.release("read");
    const doneFirst = await first.waitFor("done");
    late.release("read"); // B may now acquire (after A released) and read; releasing is harmless if it never gets there
    const doneLate = await late.waitFor("done");
    expect(doneFirst.result).toMatchObject({ ok: true });
    expect(doneLate.result).toMatchObject({ ok: true });
    const observer = must(await openSession(dir));
    expect((await observer.listViews()).map((view) => view.viewId)).toEqual(["layout", "modules"]);
    expect(readdirSync(dir).filter((name) => name.startsWith(".lock")), "no lock or tombstone is left behind").toEqual([]);
  });

  // why: three contenders judge the same dead owner at once; exactly one may break it, and only one may hold the lock afterwards.
  it("three contenders that all judged the same dead owner stale: exactly one breaks it, only one reads inside the lock", async () => {
    const { dir } = sessionWithDeadLock();
    const writers = [spawnWriter(dir, importing("layout"), children), spawnWriter(dir, importing("modules"), children), spawnWriter(dir, importing("delivery-path"), children)];
    for (const writer of writers) {
      await writer.waitFor("before-lock"); writer.release("before-lock");
      await writer.waitFor("contended"); writer.release("contended");
      await writer.waitFor("stale-observed");
    }
    for (const writer of writers) writer.release("stale-observed");
    const outcomes = await Promise.all(writers.map((writer) => writer.waitFor("stale-resolved")));
    expect(outcomes.filter((outcome) => outcome.broke === true), "exactly one contender removed the dead lock").toHaveLength(1);

    // whoever acquired is now at "read"; the others must still be waiting. Release one holder at a time.
    const finished: unknown[] = [];
    const pending = new Set(writers);
    while (pending.size > 0) {
      const { writer: holder } = await firstToSend([...pending], "read");
      holder.release("read");
      finished.push((await holder.waitFor("done")).result);
      pending.delete(holder);
    }
    expect(finished.every((result) => (result as { ok: boolean }).ok)).toBe(true);
    const observer = must(await openSession(dir));
    expect((await observer.listViews()).map((view) => view.viewId)).toEqual(["delivery-path", "layout", "modules"]);
  });
});
