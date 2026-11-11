// Review round 2, S2: the session lock needs to know whether the process that recorded a lock still exists. Age and `kill(pid, 0)` cannot say
// (a reused pid looks live, a slow live owner looks old), so identity is (boot_id, pid, start time of the process).
// These tests use real processes and an oracle that does not share the production parse: `ps -o etimes` plus /proc/uptime give the start
// instant independently of /proc/<pid>/stat field counting.
// proves: CLAIM(process-identity)
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { currentBootId, identityOf, isAlive } from "./process-identity.ts";

const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill("SIGKILL"); });

/** Starts a node child that prints its pid and idles; `title` becomes its comm, which /proc/<pid>/stat shows in parentheses. */
async function idleChild(title?: string): Promise<number> {
  const child = spawn(process.execPath, ["-e", `${title === undefined ? "" : `process.title = ${JSON.stringify(title)};`} console.log(process.pid); setInterval(() => {}, 1000)`], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(child);
  const [chunk] = (await once(child.stdout!, "data")) as [Buffer];
  return Number(chunk.toString().trim());
}
async function killed(pid: number): Promise<void> {
  const child = children.find((candidate) => candidate.pid === pid)!;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
/** Seconds since boot at which `pid` started, from `ps` (elapsed) and /proc/uptime: shares no parsing with the code under test. */
function startSecondsByOracle(pid: number): number {
  const elapsed = Number(execFileSync("ps", ["-o", "etimes=", "-p", String(pid)], { encoding: "utf8" }).trim());
  const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  return uptime - elapsed;
}
const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());

describe("[S2] identityOf reads boot id and process start time", () => {
  // why: a wrong field or a comm with spaces would silently give another number, and every "same process" decision would then be wrong.
  it.each([[undefined, "plain command name"], ["a) S 9 (b c", "command name with ')' ' ' and '('"]] as const)("start time of a child with a %2$s matches the independent oracle", async (title, _label) => {
    const pid = await idleChild(title);
    if (title !== undefined) expect(readFileSync(`/proc/${pid}/comm`, "utf8"), "precondition: the comm really contains the parse trap").toContain(")");
    const identity = await identityOf(pid);
    expect(identity.pid).toBe(pid);
    expect(identity.startTime).not.toBeNull();
    expect(Math.abs((identity.startTime as number) / ticksPerSecond - startSecondsByOracle(pid))).toBeLessThan(2.5);
    expect(identity.bootId).toBe(readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
    expect(await currentBootId()).toBe(identity.bootId);
  });

  it("two processes started at different times have different identities, and one process keeps its identity", async () => {
    const first = await idleChild();
    const second = await idleChild();
    expect(await identityOf(first)).toEqual(await identityOf(first));
    expect(await identityOf(first)).not.toEqual(await identityOf(second));
  });
});

describe("[S2] isAlive is false only when the recorded process cannot be the same one", () => {
  it("a running process is alive with its own identity", async () => {
    const pid = await idleChild();
    expect(await isAlive(await identityOf(pid))).toBe(true);
    expect(await isAlive(await identityOf(process.pid))).toBe(true);
  });

  it("a process that exited is dead, and a pid nobody has is dead", async () => {
    const pid = await idleChild();
    const identity = await identityOf(pid);
    await killed(pid);
    expect(await isAlive(identity)).toBe(false);
    expect(await isAlive({ bootId: identity.bootId, pid: 2 ** 22 + 12345, startTime: null })).toBe(false);
  });

  // why: the pid of a dead owner can be handed to an unrelated live process; `kill(pid, 0)` then says "alive" and the lock would be held forever.
  it("PID reuse: the same pid with a different start time is dead", async () => {
    const pid = await idleChild();
    const identity = await identityOf(pid);
    expect(await isAlive({ ...identity, startTime: (identity.startTime as number) + 1 })).toBe(false);
    expect(await isAlive({ ...identity, startTime: (identity.startTime as number) - 1 })).toBe(false);
    expect(await isAlive(identity), "control: the true start time is alive").toBe(true);
  });

  it("a different boot id is dead even for a pid that is running now", async () => {
    const pid = await idleChild();
    const identity = await identityOf(pid);
    expect(await isAlive({ ...identity, bootId: "00000000-0000-0000-0000-000000000000" })).toBe(false);
  });

  // why: absent facts must never prove death, or a legacy or partial record would get a live owner's lock broken.
  it("missing boot id or start time cannot make a running process look dead", async () => {
    const pid = await idleChild();
    const identity = await identityOf(pid);
    expect(await isAlive({ bootId: null, pid, startTime: null })).toBe(true);
    expect(await isAlive({ ...identity, startTime: null })).toBe(true);
    expect(await isAlive({ ...identity, bootId: null })).toBe(true);
  });

  // why: a zombie still has a /proc entry with its old start time, but its owner is gone.
  it("an exited child that nobody has reaped (zombie) is dead", async () => {
    const holder = spawn("bash", ["-c", "sh -c 'exit 0' & echo $!; exec sleep 60"], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(holder);
    const [chunk] = (await once(holder.stdout!, "data")) as [Buffer];
    const zombie = Number(chunk.toString().trim());
    for (let attempt = 0; attempt < 400 && !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${zombie}/stat`, "utf8")); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(readFileSync(`/proc/${zombie}/stat`, "utf8"), "precondition: the child is a zombie").toMatch(/^\d+ \(.*\) Z /);
    expect(await isAlive(await identityOf(zombie))).toBe(false);
  });
});
