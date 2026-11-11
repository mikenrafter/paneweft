// Review round 2, S2: the recovery mutex was reaped by AGE, a crash after the lock was renamed left an orphan tombstone, and "is the owner
// alive" was `kill(pid, 0)` (a reused pid looks alive). Decision: a lock (main or recovery mutex) is stale ONLY when the identity it records
// (boot_id, pid, process start time; process-identity.ts) is dead, never by age; recovery runs under the mutex, re-reads the lock, renames it
// to a tombstone, verifies the tombstone, and orphan tombstones of dead identities are removed.
// Real OS processes (test/helpers/session-writer.ts) are held at named barriers inside the recovery protocol, so every interleaving below is
// forced, not hoped for. A "crash" is SIGKILL of a writer held at a barrier. Layout: `.lock/owner`, `.lock.recovery/owner` (JSON identity + token).
// Mutation notes (old logic, age-based mutex reaping + kill(pid,0)): fails PID reuse, boot id, paused recoverer, crashed mutex holder, crash
// after rename, orphan tombstone, replacement mutex, unreadable-owner age tests; passes the controls.
// proves: CLAIM(process-lock) CLAIM(stale-lock-recovery) CLAIM(process-identity)
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSession } from "./session.ts";
import { identityOf, type ProcessIdentity } from "./process-identity.ts";
import { must } from "../../test/helpers/must.ts";
import { autoRelease, spawnWriter, type ProcessWriter } from "../../test/helpers/process-writer.ts";
import { subBundle } from "../../test/helpers/store-session.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill("SIGKILL"); });
const HOUR = 3600;
const TEST_TIMEOUT = 30_000;
/** The barriers every writer passes on the way to or through the critical section. */
const ROUTINE = ["before-lock", "contended", "stale-observed", "read"] as const;

interface LockDoc extends ProcessIdentity { token: string }

async function idleProcess(): Promise<{ child: ChildProcess; identity: ProcessIdentity }> {
  const child = spawn(process.execPath, ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(child);
  const [chunk] = (await once(child.stdout!, "data")) as [Buffer];
  return { child, identity: await identityOf(Number(chunk.toString().trim())) };
}
/** The recorded identity of a real process that has exited. */
async function deadIdentity(): Promise<ProcessIdentity> {
  const { child, identity } = await idleProcess();
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  return identity;
}
async function crash(writer: ProcessWriter): Promise<void> {
  const exited = once(writer.child, "exit");
  writer.child.kill("SIGKILL");
  await exited;
}
/** Plants `<dir>/<name>/owner`, optionally with a modification time an hour in the past (age must never matter). */
function plant(dir: string, name: string, doc: Partial<LockDoc> | string, options: { old?: boolean } = {}): string {
  const path = join(dir, name);
  mkdirSync(path);
  writeFileSync(join(path, "owner"), typeof doc === "string" ? doc : JSON.stringify(doc));
  if (options.old) age(path);
  return path;
}
/** Makes a lock directory and its owner record (if it has one) look an hour old. */
function age(path: string): void {
  const when = new Date(Date.now() - HOUR * 1000);
  for (const target of [join(path, "owner"), path]) if (existsSync(target)) utimesSync(target, when, when);
}
const ownerOf = (path: string): LockDoc => JSON.parse(readFileSync(join(path, "owner"), "utf8"));
const lockEntries = (dir: string): string[] => readdirSync(dir).filter((name) => name.startsWith(".lock"));
const job = (viewId: string, extra: Record<string, unknown> = {}) => ({ kind: "import", bundle: subBundle([viewId]), ...extra });
const viewIds = async (dir: string): Promise<string[]> => (await must(await openSession(dir)).listViews()).map((view) => view.viewId);

describe("[S2/r2] a lock is stale only when its recorded process identity is dead", () => {
  // why: kill(pid, 0) says "alive" for ANY process that got the dead owner's pid, so the lock would be held for ever.
  it("PID reuse: a lock whose pid is running but started at a different time is recovered", async () => {
    const dir = tmp("lock-reuse");
    const { identity } = await idleProcess();
    plant(dir, ".lock", { ...identity, startTime: (identity.startTime as number) + 1, token: "reused" });
    const writer = spawnWriter(dir, job("layout", { lockWaitMs: 5000 }), children);
    autoRelease(writer, ROUTINE);
    expect((await writer.waitFor("done")).result).toMatchObject({ ok: true });
    expect(await viewIds(dir)).toEqual(["layout"]);
    expect(lockEntries(dir)).toEqual([]);
  }, TEST_TIMEOUT);

  // why: after a reboot every pid is reused and start times restart, so only the boot id can tell the lock belongs to a previous boot.
  it("a lock recorded under another boot id is recovered even though its pid and start time match a running process", async () => {
    const dir = tmp("lock-boot");
    const { identity } = await idleProcess();
    plant(dir, ".lock", { ...identity, bootId: "00000000-0000-0000-0000-000000000000", token: "previous-boot" });
    const writer = spawnWriter(dir, job("layout", { lockWaitMs: 5000 }), children);
    autoRelease(writer, ROUTINE);
    expect((await writer.waitFor("done")).result).toMatchObject({ ok: true });
    expect(lockEntries(dir)).toEqual([]);
  }, TEST_TIMEOUT);

  // control: the same plant with the TRUE identity must keep its lock, however old the files are; otherwise "recover everything" would pass the tests above.
  it("control: a lock of a live process is never broken, even when its files are an hour old", async () => {
    const dir = tmp("lock-live");
    const { identity } = await idleProcess();
    const lock = plant(dir, ".lock", { ...identity, token: "live-owner" }, { old: true });
    const writer = spawnWriter(dir, job("layout", { lockWaitMs: 800 }), children);
    autoRelease(writer, ROUTINE);
    expect((await writer.waitFor("done")).result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(ownerOf(lock)).toMatchObject({ pid: identity.pid, token: "live-owner" });
  }, TEST_TIMEOUT);

  // why: a lock nobody can attribute to a process (garbled, or from a crash between mkdir and write in the old protocol) has no identity to judge;
  //      its age proves nothing, so it is kept and the contender reports CONFLICT.
  it("a lock whose owner record is unreadable is never broken by age", async () => {
    const dir = tmp("lock-garbled");
    const lock = plant(dir, ".lock", "not json", { old: true });
    const writer = spawnWriter(dir, job("layout", { lockWaitMs: 800 }), children);
    autoRelease(writer, ROUTINE);
    expect((await writer.waitFor("done")).result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe("not json");
  }, TEST_TIMEOUT);
});

describe("[S2/r2] the recovery mutex is reaped only when its holder is dead", () => {
  // why: age does not prove abandonment. P is alive, holds the mutex and is merely paused; Q must neither reap the mutex nor break the lock.
  it("a live recoverer that is paused inside the mutex is not reaped, whatever the age of the mutex", async () => {
    const dir = tmp("mutex-paused");
    const lock = plant(dir, ".lock", { ...(await deadIdentity()), token: "dead-owner" });
    const paused = spawnWriter(dir, job("layout", { lockWaitMs: 30_000, pause: ["mutex-held"] }), children);
    autoRelease(paused, ROUTINE);
    await paused.waitFor("mutex-held");
    const mutex = join(dir, ".lock.recovery");
    age(mutex);

    const impatient = spawnWriter(dir, job("modules", { lockWaitMs: 1200 }), children);
    autoRelease(impatient, ROUTINE);
    expect((await impatient.waitFor("done")).result, "Q must wait for the live recoverer and give up with CONFLICT").toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(ownerOf(mutex).pid, "P's mutex is untouched").toBe(paused.child.pid);
    expect(ownerOf(lock).token, "the dead lock is still the one P is about to remove").toBe("dead-owner");

    paused.release("mutex-held");
    expect((await paused.waitFor("done")).result).toMatchObject({ ok: true });
    expect(await viewIds(dir)).toEqual(["layout"]);
    expect(lockEntries(dir)).toEqual([]);
  }, TEST_TIMEOUT);

  // why: a recoverer that dies inside the mutex must not wedge recovery for everybody else until some timer expires.
  it("a recoverer that crashed while holding the mutex: the next contender reaps the dead mutex and recovers at once", async () => {
    const dir = tmp("mutex-crashed");
    plant(dir, ".lock", { ...(await deadIdentity()), token: "dead-owner" });
    const doomed = spawnWriter(dir, job("layout", { pause: ["mutex-held"] }), children);
    autoRelease(doomed, ROUTINE);
    await doomed.waitFor("mutex-held");
    await crash(doomed);
    expect(lockEntries(dir), "precondition: the dead recoverer left its mutex behind").toContain(".lock.recovery");

    const next = spawnWriter(dir, job("modules", { lockWaitMs: 4000 }), children);
    autoRelease(next, ROUTINE);
    expect((await next.waitFor("done")).result).toMatchObject({ ok: true });
    expect(await viewIds(dir)).toEqual(["modules"]);
    expect(lockEntries(dir)).toEqual([]);
  }, TEST_TIMEOUT);

  // why: X judged mutex M1 dead and is held; Y then reaped M1 and now holds its own M2 at the same path. When X resumes it must find that
  //      what it moved aside is not M1, put M2 back and report nothing removed (a rename is by NAME and would otherwise take the live M2).
  it("replacement-mutex race: a contender that judged the old mutex dead cannot take the live mutex that replaced it", async () => {
    const dir = tmp("mutex-replaced");
    const lock = plant(dir, ".lock", { ...(await deadIdentity()), token: "dead-owner" });
    plant(dir, ".lock.recovery", { ...(await deadIdentity()), token: "dead-mutex" }, { old: true });

    const late = spawnWriter(dir, job("modules", { lockWaitMs: 2500, pause: ["mutex-stale-observed"] }), children);
    autoRelease(late, ROUTINE);
    await late.waitFor("mutex-stale-observed"); // X has judged "dead-mutex" abandoned and is held right before taking it away

    const first = spawnWriter(dir, job("layout", { lockWaitMs: 30_000, pause: ["mutex-held"] }), children);
    autoRelease(first, ROUTINE);
    await first.waitFor("mutex-held"); // Y reaped the old mutex and holds a new one
    expect(lockEntries(dir), "control: a mutex is on disk (Y's)").toContain(".lock.recovery");

    late.release("mutex-stale-observed");
    expect((await late.waitFor("done")).result, "X must not have got through by removing Y's live mutex").toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(ownerOf(join(dir, ".lock.recovery")).pid, "Y's mutex survived X's attempt").toBe(first.child.pid);
    expect(ownerOf(lock).token, "and the dead lock is still waiting for Y").toBe("dead-owner");

    first.release("mutex-held");
    autoRelease(first, ["mutex-held"]); // Y takes the mutex again for the recovery proper after its start-up sweep
    expect((await first.waitFor("done")).result).toMatchObject({ ok: true });
    expect(await viewIds(dir)).toEqual(["layout"]);
    expect(lockEntries(dir)).toEqual([]);
  }, TEST_TIMEOUT);
});

describe("[S2/r2] a crash between renaming the lock and deleting its tombstone leaves nothing behind", () => {
  // why: the recoverer died after the rename: the lock path is free, a tombstone of the dead owner is on disk and the mutex is orphaned.
  it("crash after the rename: the next contender acquires, and the orphan tombstone and mutex are gone", async () => {
    const dir = tmp("crash-after-rename");
    plant(dir, ".lock", { ...(await deadIdentity()), token: "dead-owner" });
    const doomed = spawnWriter(dir, job("layout", { pause: ["displaced"] }), children);
    autoRelease(doomed, ROUTINE);
    expect(await doomed.waitFor("displaced")).toMatchObject({ target: "lock" });
    await crash(doomed);
    const orphans = lockEntries(dir).filter((name) => name.startsWith(".lock.stale"));
    expect(orphans, "precondition: one orphan tombstone of the dead owner").toHaveLength(1);
    expect(ownerOf(join(dir, orphans[0] as string)).token).toBe("dead-owner");

    const next = spawnWriter(dir, job("modules", { lockWaitMs: 4000 }), children);
    autoRelease(next, ROUTINE);
    expect((await next.waitFor("done")).result).toMatchObject({ ok: true });
    expect(await viewIds(dir)).toEqual(["modules"]);
    expect(lockEntries(dir), "no lock, mutex or tombstone is left").toEqual([]);
  }, TEST_TIMEOUT);

  // why: the sweep on start-up and before recovery removes tombstones of dead identities even when no mutex is involved.
  it("an orphan tombstone of a dead identity is removed by the next writer", async () => {
    const dir = tmp("orphan-tombstone");
    plant(dir, ".lock.stale.1.abcdef", { ...(await deadIdentity()), token: "dead-owner" });
    const writer = spawnWriter(dir, job("layout"), children);
    autoRelease(writer, ROUTINE);
    expect((await writer.waitFor("done")).result).toMatchObject({ ok: true });
    expect(lockEntries(dir)).toEqual([]);
  }, TEST_TIMEOUT);

  // control: a tombstone whose identity is alive is somebody's lock in flight; deleting it would be the bug this finding is about.
  it("control: a tombstone of a live identity is kept", async () => {
    const dir = tmp("live-tombstone");
    const { identity } = await idleProcess();
    plant(dir, ".lock.stale.1.abcdef", { ...identity, token: "live-owner" });
    const writer = spawnWriter(dir, job("layout"), children);
    autoRelease(writer, ROUTINE);
    expect((await writer.waitFor("done")).result).toMatchObject({ ok: true });
    expect(lockEntries(dir)).toEqual([".lock.stale.1.abcdef"]);
  }, TEST_TIMEOUT);
});

describe("[S2/r2] what a holder records, and the staging leftovers of a crash", () => {
  // why: recovery trusts this record to decide life or death, so it must be the writer's true identity, complete from the first moment the lock exists.
  it("a held lock records the holder's own boot id, pid and process start time", async () => {
    const dir = tmp("lock-record");
    const holder = spawnWriter(dir, job("layout"), children);
    autoRelease(holder, ["before-lock"]);
    await holder.waitFor("read"); // inside the critical section
    const expected = await identityOf(holder.child.pid as number);
    expect(ownerOf(join(dir, ".lock"))).toMatchObject({ bootId: expected.bootId, pid: expected.pid, startTime: expected.startTime });
    expect(expected.startTime, "the oracle itself must have a start time").not.toBeNull();
    holder.release("read");
    expect((await holder.waitFor("done")).result).toMatchObject({ ok: true });
    expect(lockEntries(dir)).toEqual([]);
  }, TEST_TIMEOUT);

  // why: a writer that dies while building its lock leaves a staging directory named after its identity; the name alone says whether to keep it.
  it("a staging directory of a dead identity is removed, one of a live identity is kept", async () => {
    const dir = tmp("staging");
    const dead = await deadIdentity();
    const live = (await idleProcess()).identity;
    const staging = (identity: ProcessIdentity, suffix: string) => `.lock.new.${identity.bootId}.${identity.pid}.${identity.startTime}.${suffix}`;
    plant(dir, staging(dead, "aaaaaa"), { ...dead, token: "dead-staging" });
    plant(dir, staging(live, "bbbbbb"), { ...live, token: "live-staging" });
    const writer = spawnWriter(dir, job("layout"), children);
    autoRelease(writer, ROUTINE);
    expect((await writer.waitFor("done")).result).toMatchObject({ ok: true });
    expect(lockEntries(dir)).toEqual([staging(live, "bbbbbb")]);
  }, TEST_TIMEOUT);
});

describe("[S2/r2] the tombstone is verified, and a live lock that was moved aside is put back", () => {
  // why: if what the recoverer renamed is NOT the dead lock it judged (a live owner took the path in the meantime), it must be restored, and the
  //      recoverer must not report that it broke anything. The swap is simulated by writing a live identity into the tombstone while the
  //      recoverer is held between the rename and the verification.
  it("a live lock found in the tombstone is restored to the lock path and the contender does not acquire", async () => {
    const dir = tmp("restore-live");
    plant(dir, ".lock", { ...(await deadIdentity()), token: "dead-owner" });
    const { identity } = await idleProcess();
    const recoverer = spawnWriter(dir, job("layout", { lockWaitMs: 1000, pause: ["displaced"] }), children);
    autoRelease(recoverer, ROUTINE);
    await recoverer.waitFor("displaced");
    const tombstone = lockEntries(dir).find((name) => name.startsWith(".lock.stale")) as string;
    writeFileSync(join(dir, tombstone, "owner"), JSON.stringify({ ...identity, token: "live-owner" }));
    recoverer.release("displaced");
    expect((await recoverer.waitFor("done")).result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(ownerOf(join(dir, ".lock")), "the live lock is back").toMatchObject({ pid: identity.pid, token: "live-owner" });
    expect(lockEntries(dir).filter((name) => name.startsWith(".lock.stale")), "no tombstone is left").toEqual([]);
  }, TEST_TIMEOUT);

  // why: if the path was retaken before the live lock could be put back, two owners may now be running; that must be reported, not swallowed.
  it("a live lock that cannot be restored because the path was retaken is reported as STORAGE_FAILED, not as a plain timeout", async () => {
    const dir = tmp("restore-impossible");
    plant(dir, ".lock", { ...(await deadIdentity()), token: "dead-owner" });
    const displaced = await idleProcess();
    const retaker = await idleProcess();
    const recoverer = spawnWriter(dir, job("layout", { lockWaitMs: 1000, pause: ["displaced"] }), children);
    autoRelease(recoverer, ROUTINE);
    await recoverer.waitFor("displaced");
    const tombstone = lockEntries(dir).find((name) => name.startsWith(".lock.stale")) as string;
    writeFileSync(join(dir, tombstone, "owner"), JSON.stringify({ ...displaced.identity, token: "displaced-owner" }));
    plant(dir, ".lock", { ...retaker.identity, token: "retaker" });
    recoverer.release("displaced");
    const done = (await recoverer.waitFor("done")).result;
    expect(done).toMatchObject({ ok: false, error: { code: "STORAGE_FAILED" } });
    expect(done.error.message).toMatch(/displaced|moved aside|restore/i);
    expect(ownerOf(join(dir, ".lock")).token, "the live holder of the path is left alone").toBe("retaker");
  }, TEST_TIMEOUT);
});
