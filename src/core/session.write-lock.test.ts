// Review S2 (tier-1 step-back): the userspace stale-lock recovery is replaced by a kernel-managed flock(2) on a descriptor of the permanent
// file `<session>/.write.lock` (src/core/write-lock.ts). These tests use REAL processes with IPC barriers (test/helpers/lock-writer.ts): a holder
// is suspended inside its critical section, contenders are observed waiting on the kernel lock (their `flock` helper is alive and owns
// descriptor 3 = the lock file), and crashes are SIGKILLs delivered at named points. Nothing about the lock, the read or the commit is simulated;
// only the helper program is replaced where a test needs a helper that misbehaves (fake `flock` scripts first on PATH).
// proves: CLAIM(process-lock) CLAIM(flock-exclusion) CLAIM(flock-crash-safety) CLAIM(flock-no-premature-mutation) CLAIM(flock-no-leak)
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSession, type SessionTestHooks } from "./session.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { descriptorTarget, fakeFlockDirectory, isRunning, lines, pathWith, processState, realFlock, spawnLockWriter } from "../../test/helpers/lock-writer-host.ts";
import { inSnapshot, openOk, subBundle } from "../../test/helpers/store-session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill("SIGKILL"); });

const importing = (viewId: string, extra: { pause?: string[]; log?: string; lockWaitMs?: number } = {}) => ({ kind: "import" as const, bundle: subBundle([viewId]), ...extra });
const manifestOf = (dir: string): { generation: number; views: Array<{ viewId: string }> } => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const lockPath = (dir: string): string => join(realpathSync(dir), ".write.lock");
const viewIds = async (dir: string): Promise<string[]> => { const s = await openOk(dir); try { return (await s.listViews()).map((v) => v.viewId); } finally { await s.close(); } };
/** The targets of all descriptors this process has open. */
const openDescriptors = (): string[] => readdirSync("/proc/self/fd").map((fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { return "?"; } });
/** A promise and its resolver, for in-process barriers. */
function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
/** Runs `body` with PATH replaced; spawn() reads process.env.PATH at spawn time. */
async function withPath<T>(path: string, body: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = path;
  try { return await body(); } finally { process.env.PATH = saved; }
}

describe("[S2] flock exclusion across real processes", () => {
  // why: the lock must serialise independent OS processes. A holder is suspended INSIDE its critical section (after the kernel granted the lock);
  //   two more writers start. Their flock helpers must be alive and hold descriptor 3 = the lock file (that is what "waiting on the kernel lock"
  //   looks like from outside). The kernel-ordered O_APPEND log must then read enter/leave/enter/leave/enter/leave, and all three imports must
  //   survive (no lost update: generation 3, three views). Fails if the lock is missing (B and C never wait: no helper) or too weak (log interleaves).
  // proves: CLAIM(flock-exclusion) CLAIM(process-lock)
  it("[S2] three contenders: contention is demonstrable, critical sections never overlap, no update is lost", async () => {
    const dir = tmp("three");
    const log = join(tmp("three-log"), "sections.log");
    const a = spawnLockWriter(dir, importing("modules", { pause: ["lock-acquired"], log }), children);
    await a.waitFor("lock-acquired");
    const b = spawnLockWriter(dir, importing("layout", { log }), children);
    const c = spawnLockWriter(dir, importing("delivery-path", { log }), children);
    const helpers = [(await b.waitFor("helper-spawned")).helperPid!, (await c.waitFor("helper-spawned")).helperPid!];
    for (const helper of helpers) {
      expect(isRunning(helper), "a contender's helper is still waiting while A holds the lock").toBe(true);
      expect(descriptorTarget(helper, 3), "the helper owns the inherited lock descriptor").toBe(lockPath(dir));
    }
    expect(lines(log), "only A is inside a critical section").toEqual([`enter ${a.child.pid}`]);

    a.release("lock-acquired");
    const results = await Promise.all([a.done(), b.done(), c.done()]);

    for (const finished of results) expect(finished.result).toMatchObject({ ok: true });
    const entries = lines(log);
    expect(entries).toHaveLength(6);
    const pids = new Set<string>();
    for (let index = 0; index < entries.length; index += 2) {
      const [, pid] = entries[index]!.split(" ");
      expect(entries[index]).toBe(`enter ${pid}`);
      expect(entries[index + 1], "a section ends before the next one begins").toBe(`leave ${pid}`);
      pids.add(pid!);
    }
    expect(pids.size, "three different processes").toBe(3);
    expect(entries[0]).toBe(`enter ${a.child.pid}`);
    expect(manifestOf(dir).generation).toBe(3);
    expect(await viewIds(dir)).toEqual(["delivery-path", "layout", "modules"]);
    for (const helper of helpers) expect(processState(helper), "helpers are reaped, not left behind").toBeNull();
  });
});

describe("[S2] a crashed holder never wedges or corrupts the session", () => {
  // why: the kernel drops a flock when the last descriptor on its open file description closes, so SIGKILL of the holder at ANY point must let
  //   the next writer in, and the manifest it then reads must be complete: the old one before the rename, the new one after it. The successor
  //   is started while the holder is paused, so it is demonstrably waiting (alive helper) when the holder dies. Before the flock rewrite this
  //   needed identity records, recovery mutexes and tombstones; here nothing may be needed.
  //   Points: right after acquisition, after one object was staged, with the new manifest written but not renamed, right after the rename.
  // proves: CLAIM(flock-crash-safety) CLAIM(atomic-manifest)
  it.each([
    ["lock-acquired", false],
    ["staged", false],
    ["before-rename", false],
    ["after-rename", true],
  ] as const)("[S2] SIGKILL of the holder at %s: the waiting writer proceeds and reads a complete manifest (holder's change committed: %s)", async (point, committed) => {
    const dir = tmp("kill");
    const seed = await openOk(dir);
    must(await seed.importBundle(subBundle(["layout"])));
    await seed.close();
    const holder = spawnLockWriter(dir, importing("modules", { pause: [point] }), children);
    await holder.waitFor(point);
    const successor = spawnLockWriter(dir, importing("delivery-path"), children);
    const waiting = await successor.waitFor("helper-spawned");
    expect(isRunning(waiting.helperPid!), "the successor is blocked behind the holder").toBe(true);

    await holder.kill();
    const finished = await successor.done();

    expect(finished.result).toMatchObject({ ok: true });
    expect(await viewIds(dir)).toEqual(committed ? ["delivery-path", "layout", "modules"] : ["delivery-path", "layout"]);
    expect(manifestOf(dir).generation, "seed + successor (+ holder when it committed)").toBe(committed ? 3 : 2);
    const observer = await openOk(dir);
    try {
      expect((await observer.exportBundle()).views.map((view) => view.id), "every referenced object is present and verifies").toEqual(committed ? ["delivery-path", "layout", "modules"] : ["delivery-path", "layout"]);
      must(await observer.importBundle(subBundle(["modules"])), "the killed holder's change can be (re)applied");
      expect((await observer.listViews()).map((view) => view.viewId)).toEqual(["delivery-path", "layout", "modules"]);
    } finally { await observer.close(); }
  });

  // why: the flock helper is a separate process that shares the open file description. If the WRITER dies while its helper still waits, the helper
  //   is the last holder: it must acquire when the real holder leaves, exit at once, and so free the lock. A later writer must not be wedged by it.
  // proves: CLAIM(flock-no-leak) CLAIM(flock-crash-safety)
  it("[S2] SIGKILL of a waiting writer: its orphaned helper acquires and exits, and the next writer is not blocked", async () => {
    const dir = tmp("orphan");
    const holder = spawnLockWriter(dir, importing("modules", { pause: ["lock-acquired"] }), children);
    await holder.waitFor("lock-acquired");
    const waiter = spawnLockWriter(dir, importing("layout"), children);
    const { helperPid } = await waiter.waitFor("helper-spawned");
    await waiter.kill();

    holder.release("lock-acquired");
    expect((await holder.done()).result).toMatchObject({ ok: true });
    const next = spawnLockWriter(dir, importing("delivery-path"), children);
    expect((await next.done()).result).toMatchObject({ ok: true });

    expect(isRunning(helperPid!), "the orphaned helper is gone").toBe(false);
    expect(await viewIds(dir)).toEqual(["delivery-path", "modules"]);
  });
});

describe("[S2] a lock helper that dies or misbehaves never lets a mutation through", () => {
  // why: the contract says exit code 0 WITHOUT a signal is the only acquisition. A helper that really acquired the lock and is then killed before
  //   it reports must be treated as a failure: nothing is read or written, and the descriptor is closed so the lock is not leaked.
  //   The fake `flock` runs the real one, then SIGKILLs itself (so the kernel lock IS held at that moment).
  // proves: CLAIM(flock-no-premature-mutation) CLAIM(flock-no-leak)
  it("[S2] helper killed right after it acquired: STORAGE_FAILED, no read, no write, no leaked lock or descriptor", async () => {
    const dir = tmp("died-after");
    const fake = fakeFlockDirectory(tmp("fake-die"), `${realFlock()} "$@" || exit $?\nkill -KILL $$`);
    const writer = spawnLockWriter(dir, importing("modules"), children, { PATH: pathWith(fake) });
    const finished = await writer.done();

    expect(finished.result).toMatchObject({ ok: false, error: { code: "STORAGE_FAILED", retryable: false, details: { cause: "flock-failed" } } });
    expect(finished.result.error.message).toMatch(/SIGKILL/);
    expect(writer.seen.map((event) => event.event), "no critical-section hook ran").not.toContain("lock-acquired");
    expect(writer.seen.map((event) => event.event)).not.toContain("read");
    expect(readdirSync(dir).filter((name) => name !== ".write.lock"), "nothing was written").toEqual([]);
    expect(finished.fdsAfter, "the descriptor was closed").toBe(finished.fdsBefore);
    const next = spawnLockWriter(dir, importing("modules"), children);
    expect((await next.done()).result, "the lock is not leaked").toMatchObject({ ok: true });
  });

  // why: killing the helper while it waits fails the acquisition, but a helper that is merely STOPPED must not be mistaken for ready either.
  //   The holder leaves while B's helper is stopped; the lock is free, yet B must not enter until the helper reports. Then the helper is killed:
  //   B fails, nothing was written by B, and a third writer proceeds. Fails if "spawned" or "lock is free" were taken for readiness.
  // proves: CLAIM(flock-no-premature-mutation)
  it("[S2] stopped then killed helper: no mutation before or after, the lock stays usable", async () => {
    const dir = tmp("stopped");
    const holder = spawnLockWriter(dir, importing("modules", { pause: ["lock-acquired"] }), children);
    await holder.waitFor("lock-acquired");
    const waiter = spawnLockWriter(dir, importing("layout"), children);
    const { helperPid } = await waiter.waitFor("helper-spawned");
    process.kill(helperPid!, "SIGSTOP");

    holder.release("lock-acquired");
    expect((await holder.done()).result).toMatchObject({ ok: true });
    process.kill(helperPid!, "SIGKILL");
    const finished = await waiter.done();

    expect(finished.result).toMatchObject({ ok: false, error: { code: "STORAGE_FAILED", details: { cause: "flock-failed" } } });
    expect(waiter.seen.map((event) => event.event)).not.toContain("lock-acquired");
    expect(finished.fdsAfter).toBe(finished.fdsBefore);
    expect(await viewIds(dir), "only the holder's change exists").toEqual(["modules"]);
    const next = spawnLockWriter(dir, importing("layout"), children);
    expect((await next.done()).result).toMatchObject({ ok: true });
    expect(await viewIds(dir)).toEqual(["layout", "modules"]);
  });

  // why: other helper failures (bad usage, no permission) are not "someone else holds the lock": they are STORAGE_FAILED naming the exit code and
  //   the helper's own message, not a retryable CONFLICT, and nothing is mutated.
  // proves: CLAIM(flock-no-premature-mutation)
  it("[S2] helper exits with an error: STORAGE_FAILED carrying its exit code and stderr, not a CONFLICT", async () => {
    const dir = tmp("exit-error");
    const fake = fakeFlockDirectory(tmp("fake-err"), `echo "boom: cannot lock" >&2\nexit 64`);
    const writer = spawnLockWriter(dir, importing("modules"), children, { PATH: pathWith(fake) });
    const finished = await writer.done();

    expect(finished.result).toMatchObject({ ok: false, error: { code: "STORAGE_FAILED", retryable: false, details: { cause: "flock-failed" } } });
    expect(finished.result.error.message).toMatch(/64/);
    expect(finished.result.error.message).toMatch(/boom: cannot lock/);
    expect(readdirSync(dir).filter((name) => name !== ".write.lock")).toEqual([]);
  });

  // why: the helper's stderr is a pipe. If the parent does not drain it, a chatty helper blocks on a full pipe (64 KiB) and never exits, so the
  //   acquisition hangs. This fake writes 1 MiB to stderr, THEN runs the real flock; the mutation must still succeed.
  // proves: CLAIM(flock-no-leak)
  it("[S2] a helper that writes 1 MiB to stderr before locking does not hang the acquisition", async () => {
    const dir = tmp("chatty");
    const fake = fakeFlockDirectory(tmp("fake-chatty"), `head -c 1048576 /dev/zero | tr '\\0' 'x' >&2\nexec ${realFlock()} "$@"`);
    const writer = spawnLockWriter(dir, importing("modules"), children, { PATH: pathWith(fake) });
    expect((await writer.done()).result).toMatchObject({ ok: true });
  }, 15_000);
});

describe("[S2] a missing or unusable flock is reported, never ignored", () => {
  // why: util-linux `flock` is a declared runtime dependency. Without it a mutation must fail EXPLICITLY (naming util-linux and flock, with a
  //   machine-readable cause distinct from contention and from other helper failures) and must not mutate: proceeding unlocked would silently
  //   lose updates. PATH points at an empty directory.
  // proves: CLAIM(flock-dependency)
  it("[S2] no flock on PATH: STORAGE_FAILED cause flock-missing naming util-linux; nothing written; descriptor closed", async () => {
    const dir = tmp("missing");
    const empty = tmp("empty-path");
    const writer = spawnLockWriter(dir, importing("modules"), children, { PATH: empty });
    const finished = await writer.done();

    expect(finished.result).toMatchObject({ ok: false, error: { code: "STORAGE_FAILED", retryable: false, details: { cause: "flock-missing" } } });
    expect(finished.result.error.message).toMatch(/util-linux/);
    expect(finished.result.error.message).toMatch(/flock/);
    expect(writer.seen.map((event) => event.event)).not.toContain("lock-acquired");
    expect(readdirSync(dir).filter((name) => name !== ".write.lock")).toEqual([]);
    expect(finished.fdsAfter).toBe(finished.fdsBefore);
  });

  // why: a `flock` that exists but cannot be executed is a different failure from a missing one (the fix differs), and also must not mutate.
  // proves: CLAIM(flock-dependency)
  it("[S2] a flock that cannot be executed: STORAGE_FAILED cause flock-failed, not flock-missing", async () => {
    const dir = tmp("noexec");
    const fake = fakeFlockDirectory(tmp("fake-noexec"), "exit 0", 0o644);
    const writer = spawnLockWriter(dir, importing("modules"), children, { PATH: fake });
    const finished = await writer.done();

    expect(finished.result).toMatchObject({ ok: false, error: { code: "STORAGE_FAILED", details: { cause: "flock-failed" } } });
    expect(readdirSync(dir).filter((name) => name !== ".write.lock")).toEqual([]);
  });
});

describe("[S2] contention, timeout and handles inside one process", () => {
  // why: a contender that cannot get the lock within lockWaitMs must answer a RETRYABLE CONFLICT (the caller can retry), must not mutate, and
  //   must leave no helper process or descriptor behind. The holder is a real process suspended in its critical section.
  // proves: CLAIM(flock-timeout) CLAIM(flock-no-leak)
  it("[S2] lock wait timeout: retryable CONFLICT, helper reaped, nothing written, and the same call succeeds once the holder is done", async () => {
    const dir = tmp("timeout");
    const holder = spawnLockWriter(dir, importing("modules", { pause: ["lock-acquired"] }), children);
    await holder.waitFor("lock-acquired");
    let helperPid = 0;
    const contender = await openOk(dir, { lockWaitMs: 250, testHooks: { afterHelperSpawned: ({ helperPid: pid }) => { helperPid = pid; } } });
    const before = openDescriptors().length;

    const error = mustFail(await contender.importBundle(subBundle(["layout"])));

    expect(error).toMatchObject({ code: "CONFLICT", retryable: true });
    expect(error.message).toMatch(/retry/);
    expect(helperPid, "a helper was spawned").toBeGreaterThan(0);
    expect(processState(helperPid), "the timed-out helper exited and was reaped").toBeNull();
    expect(openDescriptors().length, "no descriptor leaked").toBe(before);
    expect(existsSync(join(dir, "manifest.json")), "nothing was written").toBe(false);

    holder.release("lock-acquired");
    expect((await holder.done()).result).toMatchObject({ ok: true });
    must(await contender.importBundle(subBundle(["layout"])), "retry after the holder finished");
    expect(await contender.listViews().then((views) => views.map((view) => view.viewId))).toEqual(["layout", "modules"]);
    await contender.close();
  });

  // why: flock locks belong to the OPEN FILE DESCRIPTION, not the process, so two independent opens of the lock file contend even inside one process
  //   (a pid-based lock cannot do that). This is also the case of two Session handles in one server. A patient contender waits and then succeeds.
  // proves: CLAIM(flock-exclusion)
  it("[S2] two independent handles in one process contend: the second times out as CONFLICT, a patient third waits and succeeds", async () => {
    const dir = tmp("same-process");
    const holding = latch();
    const gate = latch();
    const holder = await openOk(dir, { testHooks: { afterLockAcquired: async () => { holding.open(); await gate.promise; } } });
    const holderCall = holder.importBundle(subBundle(["modules"]));
    await holding.promise;

    const impatient = await openOk(dir, { lockWaitMs: 200 });
    expect(mustFail(await impatient.importBundle(subBundle(["layout"]))).code).toBe("CONFLICT");

    const waiting = latch();
    const patient = await openOk(dir, { testHooks: { afterHelperSpawned: () => waiting.open() } });
    const patientCall = patient.importBundle(subBundle(["delivery-path"]));
    await waiting.promise;
    gate.open();

    expect(must(await holderCall)).toBeDefined();
    expect(must(await patientCall)).toBeDefined();
    expect((await patient.listViews()).map((view) => view.viewId)).toEqual(["delivery-path", "modules"]);
  });

  // why: nothing in a failed or successful mutation may keep a descriptor open. After a warm-up (the first spawn creates process-wide plumbing),
  //   the set of this process's descriptors must be IDENTICAL after every kind of outcome, and none may still point at the lock file.
  //   Outcomes: success, validation failure, exception inside the critical section, failed save, lock timeout, missing flock.
  // proves: CLAIM(flock-no-leak)
  it("[S2] no descriptor leaks after success, validation failure, exceptions, failed save, timeout and missing flock", async () => {
    const dir = tmp("fds");
    const plain = await openOk(dir);
    must(await plain.importBundle(subBundle(["layout"]))); // warm-up
    const baseline = openDescriptors().sort();

    must(await plain.importBundle(subBundle(["modules"])));
    expect(mustFail(await plain.importBundle({ ...subBundle(["delivery-path"]), schemaVersion: "nonsense" })).code).toBe("VALIDATION_FAILED");
    const throwing = (hooks: SessionTestHooks) => openOk(dir, { testHooks: hooks });
    const inside = await throwing({ afterManifestRead: () => { throw new Error("boom inside the critical section"); } });
    expect(mustFail(await inside.importBundle(subBundle(["delivery-path"]))).code).toBe("STORAGE_FAILED");
    const failedSave = await throwing({ beforeManifestSwap: () => { throw new Error("disk full"); } });
    expect(mustFail(await failedSave.importBundle(subBundle(["delivery-path"]))).code).toBe("STORAGE_FAILED");
    const holding = latch();
    const gate = latch();
    const holder = await throwing({ afterLockAcquired: async () => { holding.open(); await gate.promise; } });
    const heldCall = holder.importBundle(subBundle(["delivery-path"]));
    await holding.promise;
    expect(mustFail(await (await openOk(dir, { lockWaitMs: 100 })).importBundle(subBundle(["watch-shape"]))).code).toBe("CONFLICT");
    gate.open();
    must(await heldCall);
    const nobody = await withPath(tmp("no-flock"), async () => mustFail(await plain.importBundle(subBundle(["watch-shape"]))));
    expect(nobody.details).toMatchObject({ cause: "flock-missing" });

    const after = openDescriptors().sort();
    expect(after.filter((target) => target.endsWith(".write.lock")), "no descriptor still points at the lock file").toEqual([]);
    expect(after).toEqual(baseline);
  });

  // why: an exception inside the critical section (and a handle closed mid-mutation) must neither wedge the lock nor release it EARLY:
  //   close() of the handle whose mutation is in flight does not release the lock, so a contender still gets CONFLICT until the mutation
  //   finishes; a throw inside the section releases it, so the next writer is not blocked and the manifest is as before.
  // proves: CLAIM(flock-no-premature-mutation) CLAIM(flock-no-leak)
  it("[S2] close() during a mutation does not release the lock; an exception inside the section does", async () => {
    const dir = tmp("cancel");
    const seed = await openOk(dir);
    must(await seed.importBundle(subBundle(["layout"])));
    const holding = latch();
    const gate = latch();
    const holder = await openOk(dir, { testHooks: { afterLockAcquired: async () => { holding.open(); await gate.promise; } } });
    const heldCall = holder.importBundle(subBundle(["modules"]));
    await holding.promise;

    await holder.close();
    const contender = await openOk(dir, { lockWaitMs: 150 });
    expect(mustFail(await contender.importBundle(subBundle(["delivery-path"]))).code, "still held after close()").toBe("CONFLICT");
    gate.open();
    expect(must(await heldCall)).toBeDefined();
    expect(manifestOf(dir).generation).toBe(2);

    const thrower = await openOk(dir, { testHooks: { afterManifestRead: () => { throw new Error("boom"); } } });
    expect(mustFail(await thrower.importBundle(subBundle(["delivery-path"]))).code).toBe("STORAGE_FAILED");
    expect(manifestOf(dir).generation, "the failed mutation changed nothing").toBe(2);
    must(await contender.importBundle(subBundle(["delivery-path"])), "the lock was released by the exception");
    expect(manifestOf(dir).generation).toBe(3);
  });
});

describe("[S2] the lock file is permanent and readers take no lock", () => {
  // why: the lock identity is the inode of `.write.lock`: if any code path unlinked, renamed or recreated it, two writers could lock two different
  //   files and run concurrently. It is created once, never written, and the directory holds nothing else lock-related (no .lock directories,
  //   tombstones, staging directories or owner records).
  // proves: CLAIM(flock-permanent-file)
  it("[S2] .write.lock keeps its inode and content across successes, failures and several handles; no other lock artefacts exist", async () => {
    const dir = tmp("permanent");
    const lock = join(dir, ".write.lock");
    writeFileSync(lock, "keep");
    const inode = statSync(lock).ino;
    const first = await openOk(dir);
    const second = await openOk(dir, { testHooks: { beforeManifestSwap: () => { throw new Error("fail once"); } } });
    must(await first.importBundle(subBundle(["layout"])));
    expect(mustFail(await second.importBundle(subBundle(["modules"]))).code).toBe("STORAGE_FAILED");
    mustFail(await first.importBundle({ schemaVersion: "nonsense" }));
    must(await (await openOk(dir)).importBundle(subBundle(["modules"])));

    expect(statSync(lock).ino).toBe(inode);
    expect(readFileSync(lock, "utf8"), "the lock file is never written").toBe("keep");
    expect(readdirSync(dir).sort(), "no .lock, tombstone, staging or owner artefacts").toEqual([".write.lock", "manifest.json", "objects"]);
  });

  // why: readers take no lock (design: the manifest is replaced atomically, so a reader sees the old or the new one). A reader must therefore
  //   neither wait for a writer that is suspended in its critical section, nor create the lock file in a session nobody has written to.
  // proves: CLAIM(readers-lock-free)
  it("[S2] readers complete while a writer holds the lock, and reading an unwritten session creates no lock file", async () => {
    const dir = tmp("readers");
    const empty = await openOk(dir);
    expect(await empty.listViews()).toEqual([]);
    expect((await empty.exportBundle()).views).toEqual([]);
    expect(readdirSync(dir), "reading wrote nothing").toEqual([]);

    must(await empty.importBundle(subBundle(["layout"])));
    const holding = latch();
    const gate = latch();
    const holder = await openOk(dir, { testHooks: { afterLockAcquired: async () => { holding.open(); await gate.promise; } } });
    const heldCall = holder.importBundle(subBundle(["modules"]));
    await holding.promise;

    const reader = await openOk(dir);
    expect((await reader.listViews()).map((view) => view.viewId)).toEqual(["layout"]);
    expect((await reader.exportBundle()).views.map((view) => view.id)).toEqual(["layout"]);
    expect(must(await reader.getView({ viewId: "layout", snapshotId: "snap-1" })).envelope.id).toBe("layout");
    gate.open();
    must(await heldCall);
  });
});

describe("[S2] compound reads use one manifest snapshot", () => {
  // why: exportBundle() read the manifest for views and definitions and then re-read it through listEntities(). A writer that commits between the
  //   two reads produced a bundle whose entities were newer than its views (a snapshot's entities without its views). The test commits a second
  //   snapshot from another handle exactly while the export is reading its first object, then requires that the export contains NOTHING of it.
  //   The interleaving is forced by wrapping fs.promises.readFile for one call, not by timing.
  // proves: CLAIM(manifest-snapshot-read)
  it("[S2] exportBundle(): a commit that lands mid-export is not partly visible in the exported bundle", async () => {
    const dir = tmp("snapshot");
    const exporter = await openOk(dir);
    must(await exporter.importBundle(subBundle(["layout", "modules"])));
    const writer = await openOk(dir);
    const entitiesBefore = await exporter.listEntities();
    expect(entitiesBefore.every((entity) => entity.snapshotId === "snap-1")).toBe(true);

    const original = fsPromises.readFile;
    let armed = true;
    let committed = false;
    (fsPromises as { readFile: unknown }).readFile = async (...args: Parameters<typeof original>) => {
      if (armed && String(args[0]).includes(`${join(dir, "objects")}/`)) {
        armed = false;
        must(await writer.importBundle(inSnapshot(subBundle(["layout"]), "snap-2")));
        committed = true;
      }
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    syncBuiltinESMExports();
    let exported;
    try { exported = await exporter.exportBundle(); } finally {
      (fsPromises as { readFile: unknown }).readFile = original;
      syncBuiltinESMExports();
    }

    expect(committed, "precondition: the second snapshot was committed during the export").toBe(true);
    expect((await exporter.listEntities()).some((entity) => entity.snapshotId === "snap-2"), "control: the commit is visible afterwards").toBe(true);
    expect(exported.entities).toEqual(entitiesBefore);
    expect(exported.views.map((view) => view.snapshotId)).toEqual(["snap-1", "snap-1"]);
  });
});
