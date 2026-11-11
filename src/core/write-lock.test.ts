// The write-lock primitive (src/core/write-lock.ts) in isolation: how the helper is started, what counts as acquisition, and what is cleaned up
// on every failure path. Session-level behaviour (crashes, contention between processes, CONFLICT mapping) is in session.write-lock.test.ts.
// Fake `flock` programs are put first on PATH (spawn reads process.env.PATH when it spawns); they make the helper observable or misbehave.
// proves: CLAIM(flock-acquisition) CLAIM(flock-no-premature-mutation) CLAIM(flock-no-leak) CLAIM(flock-dependency)
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WriteLockError, withWriteLock } from "./write-lock.ts";
import { fakeFlockDirectory, isRunning, processState, realFlock } from "../../test/helpers/lock-writer-host.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";

const tmp = useTempDirs();
const openDescriptors = (): string[] => readdirSync("/proc/self/fd").map((fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { return "?"; } }).sort();
async function withExactPath<T>(path: string, body: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = path;
  try { return await body(); } finally { process.env.PATH = saved; }
}
/** `directory` first, then the real PATH (so a fake flock shadows the real one). */
const withPath = <T>(directory: string, body: () => Promise<T>): Promise<T> => withExactPath(`${directory}:${process.env.PATH ?? ""}`, body);
/** Lets pending promise continuations and I/O callbacks run several times; a deterministic "give it a chance", not a sleep. */
async function yieldToEventLoop(turns = 20): Promise<void> { for (let turn = 0; turn < turns; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve)); }
const warm = async (dir: string) => withWriteLock(dir, { waitMs: 5000 }, async () => undefined); // creates the lock file and the process-wide spawn plumbing

describe("[S2] withWriteLock: how the helper is started", () => {
  // why: the contract fixes the invocation: `flock --exclusive --timeout <seconds> 3` spawned DIRECTLY (no shell), stdin/stdout ignored, the
  //   lock-file handle inherited as descriptor 3. A fake flock records what it was given: its argv, its parent pid (== this process means no
  //   `sh -c` in between), and where descriptors 0, 1 and 3 point. A fractional second count must survive (250 ms -> "0.25").
  // proves: CLAIM(flock-acquisition)
  it("[S2] spawns flock directly with the exact arguments and the lock file as descriptor 3", async () => {
    const dir = tmp("args");
    const record = join(tmp("args-out"), "record.txt");
    const fake = fakeFlockDirectory(tmp("fake-args"), `fd0=$(readlink /proc/$$/fd/0); fd1=$(readlink /proc/$$/fd/1); fd3=$(readlink /proc/$$/fd/3)\n{ echo "argv:$*"; echo "ppid:$PPID"; echo "fd0:$fd0"; echo "fd1:$fd1"; echo "fd3:$fd3"; } > ${record}\nexec ${realFlock()} "$@"`);

    await withPath(fake, () => withWriteLock(dir, { waitMs: 250 }, async () => undefined));

    const facts = Object.fromEntries(readFileSync(record, "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1)]));
    expect(facts.argv).toBe("--exclusive --timeout 0.25 3");
    expect(facts.ppid, "spawned directly by this process, not through a shell").toBe(String(process.pid));
    expect(facts.fd0).toBe("/dev/null");
    expect(facts.fd1).toBe("/dev/null");
    expect(facts.fd3, "descriptor 3 is the permanent lock file").toBe(join(realpathSync(dir), ".write.lock"));
  });

  // why: the helper's `spawn` event is NOT readiness; only its exit code 0 is. A fake flock blocks on a FIFO before it runs the real flock: the
  //   helper exists (onHelperSpawned fired) but no lock is held yet, and the critical section must not start until the helper exits 0.
  //   Fails if the critical section starts on spawn.
  // proves: CLAIM(flock-acquisition) CLAIM(flock-no-premature-mutation)
  it("[S2] the critical section starts only after the helper exits 0, not when it is spawned", async () => {
    const dir = tmp("readiness");
    const fifo = join(tmp("fifo"), "gate");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const fake = fakeFlockDirectory(tmp("fake-gate"), `read -r _ < ${fifo}\nexec ${realFlock()} "$@"`);
    let entered = false;
    let spawned: () => void = () => {};
    const spawnedSeen = new Promise<void>((resolve) => { spawned = resolve; });

    const running = withPath(fake, () => withWriteLock(dir, { waitMs: 10_000, onHelperSpawned: () => spawned() }, async () => { entered = true; return "section result"; }));
    await spawnedSeen;
    await yieldToEventLoop();
    expect(entered, "helper spawned, lock not yet reported: the section must wait").toBe(false);

    writeFileSync(fifo, "go\n"); // opens the gate; the fake now runs the real flock
    expect(await running).toBe("section result");
    expect(entered).toBe(true);
  });
});

describe("[S2] withWriteLock: failure paths clean up", () => {
  // why: if anything throws while the helper is still running (here: the onHelperSpawned callback), the helper must be terminated AND reaped before
  //   the descriptor is closed and the error is rethrown; otherwise it could still win the lock later, or be left as a zombie. The fake helper
  //   blocks forever on a FIFO nobody opens, so only an active kill can end it.
  // proves: CLAIM(flock-no-leak)
  it("[S2] an error while the helper runs: the helper is killed and reaped, the descriptor closed, the section never runs", async () => {
    const dir = tmp("terminate");
    await warm(dir);
    const before = openDescriptors();
    const fifo = join(tmp("fifo-never"), "never");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const fake = fakeFlockDirectory(tmp("fake-hang"), `read -r _ < ${fifo}\nexec ${realFlock()} "$@"`);
    let helperPid = 0;
    let entered = false;

    const failure = await withPath(fake, () => withWriteLock(dir, { waitMs: 60_000, onHelperSpawned: (pid) => { helperPid = pid; throw new Error("callback failed"); } }, async () => { entered = true; })).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("callback failed");
    expect(entered).toBe(false);
    expect(helperPid).toBeGreaterThan(0);
    expect(processState(helperPid), "killed and reaped before the error surfaced").toBeNull();
    expect(openDescriptors()).toEqual(before);
    await warm(dir); // the lock is not held by anything
  });

  // why: a throwing critical section must surface its own error unchanged and still close the descriptor, so the next acquisition succeeds at once.
  // proves: CLAIM(flock-no-leak)
  it("[S2] a critical section that throws: the error is rethrown unchanged and the lock is released", async () => {
    const dir = tmp("throws");
    await warm(dir);
    const before = openDescriptors();
    const marker = new Error("section failed");

    const failure = await withWriteLock(dir, { waitMs: 5000 }, async () => { throw marker; }).then(() => null, (error: unknown) => error);

    expect(failure).toBe(marker);
    expect(openDescriptors()).toEqual(before);
    expect(await withWriteLock(dir, { waitMs: 100 }, async () => "again")).toBe("again");
  });

  // why: the lock must not be released while the critical section is still doing I/O, whatever the caller does meanwhile. A second acquisition of
  //   the SAME file from the same process (a fresh open: flock is per open file description) must time out as `contended` for as long as the
  //   section runs, and succeed right after. Nesting is how one process contends with itself.
  // proves: CLAIM(flock-acquisition) CLAIM(flock-exclusion)
  it("[S2] a second open in the same process is contended while the section runs (kind contended), then free", async () => {
    const dir = tmp("nested");
    const inner = await withWriteLock(dir, { waitMs: 5000 }, async () => {
      const contention = await withWriteLock(dir, { waitMs: 150 }, async () => "must not run").then(() => null, (error: unknown) => error);
      return contention;
    });

    expect(inner).toBeInstanceOf(WriteLockError);
    expect((inner as WriteLockError).kind).toBe("contended");
    expect(await withWriteLock(dir, { waitMs: 100 }, async () => "free again")).toBe("free again");
  });

  // why: the missing-binary case must be its own kind (the Session maps it to an error naming util-linux) and never run the section.
  // proves: CLAIM(flock-dependency)
  it("[S2] no flock on PATH: WriteLockError flock-missing naming util-linux; the section never runs; the descriptor is closed", async () => {
    const dir = tmp("missing");
    await warm(dir);
    const before = openDescriptors();
    let entered = false;

    const failure = await withExactPath(tmp("nothing-here"), () => withWriteLock(dir, { waitMs: 1000 }, async () => { entered = true; }).then(() => null, (error: unknown) => error));

    expect(failure).toBeInstanceOf(WriteLockError);
    expect((failure as WriteLockError).kind).toBe("flock-missing");
    expect((failure as WriteLockError).message).toMatch(/util-linux/);
    expect(entered).toBe(false);
    expect(openDescriptors()).toEqual(before);
  });

  // why: when `flock` cannot be started, Node closes the stderr pipe it had already made a moment AFTER it reports the error. Returning before that
  //   leaves a socket open (seen once in a loaded full-suite run). Every rejection must come back with the descriptor table exactly as before, so
  //   the table is compared right after each of 40 rejections (the window is a couple of milliseconds, so one comparison could miss it).
  // proves: CLAIM(flock-no-leak)
  it("[S2] repeated spawn failures leave the descriptor table unchanged at the moment each one is reported", async () => {
    const dir = tmp("repeat-missing");
    await warm(dir);
    const before = openDescriptors();
    const kinds: string[] = [];
    let drift: string[] | null = null;

    await withExactPath(tmp("still-nothing"), async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const failure = await withWriteLock(dir, { waitMs: 1000 }, async () => undefined).then(() => null, (error: unknown) => error);
        kinds.push((failure as WriteLockError).kind);
        const now = openDescriptors();
        if (drift === null && JSON.stringify(now) !== JSON.stringify(before)) drift = now.filter((target, index) => target !== before[index]);
      }
    });

    expect(new Set(kinds)).toEqual(new Set(["flock-missing"]));
    expect(drift, "descriptors that differ from the baseline right after a rejection").toBeNull();
  });

  // why: the lock file cannot be opened (a directory stands where the file should be): its own kind, section never runs, nothing leaks.
  // proves: CLAIM(flock-no-leak)
  it("[S2] a lock file that cannot be opened: WriteLockError lock-file-unavailable", async () => {
    const dir = tmp("unopenable");
    mkdirSync(join(dir, ".write.lock"));
    let entered = false;

    const failure = await withWriteLock(dir, { waitMs: 1000 }, async () => { entered = true; }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(WriteLockError);
    expect((failure as WriteLockError).kind).toBe("lock-file-unavailable");
    expect(entered).toBe(false);
  });

  // why: a helper process that is not running is not the same as a helper that was reaped. Sanity control for the probes used above: isRunning
  //   must be true for a live process and false for a pid that does not exist, or the "reaped" assertions would pass vacuously.
  // proves: CLAIM(flock-no-leak)
  it("[S2] control: the process probes tell a live pid from a dead one", () => {
    expect(isRunning(process.pid)).toBe(true);
    expect(isRunning(2 ** 22 + 12345)).toBe(false);
    expect(processState(2 ** 22 + 12345)).toBeNull();
  });
});
