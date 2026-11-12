// The collection job lifecycle through qex (S2, S3, N1, N2; IV17): two-phase submission, request dedupe, crash points, recovery,
// cancellation in every state, descendants stopping, import after a failing run. A FAKE qex (fixtures/v1/bin/qex) is on PATH and the
// registered adapter's executable is a fake cargo, so everything is deterministic and executions are countable.
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FIXTURES, fakeCargoAdapter, loadFixture, makeRepo, useFakeQex, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { Capture, defineType } from "../../packages/paneweft-ts/src/index.ts";
import { specLimits } from "../../packages/paneweft-ts/test/support.ts";
import { err, ok } from "../core/errors.ts";
import type { QexClient } from "./qex.ts";
import { buildQexSubmitArgv, createJobService, type CrashPoint, type JobService } from "./jobs.ts";
import { openV1Reader } from "./read.ts";

const open = useV1Sessions();
const fake = useFakeQex();
const catalogue = loadFixture<any>("v1/catalogues/watchfile.catalogue.json");

async function world(options: { crashAt?: (p: CrashPoint) => void | Promise<void>; cancelWaitMs?: number } = {}) {
  const { session, dir } = await open();
  const qex = fake();
  const adapter = fakeCargoAdapter();
  const service = (extra: { crashAt?: (p: CrashPoint) => void | Promise<void>; env?: NodeJS.ProcessEnv } = {}): JobService => createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter], ...(extra.env ? { env: extra.env } : {}), catalogueFor: async () => catalogue, cancelWaitMs: options.cancelWaitMs ?? 3000, ...(extra.crashAt ? { crashAt: extra.crashAt } : options.crashAt ? { crashAt: options.crashAt } : {}) });
  return { session, dir, qex, adapter, service };
}
const request = (requestId: string, extra: object = {}) => ({ requestId, repo: "vg", adapter: "cargo", examples: ["watch.pending"], ...extra });
const settle = async (service: JobService, id: string, want: string[]) => vi.waitFor(async () => { const view = must(await service.status(id), "status"); expect(want, JSON.stringify(view)).toContain(view.state); return view; }, { timeout: 20_000, interval: 50 });

describe("[N1] two-phase submission", () => {
  // why: N1 / IV17. The exact `qex submit` vector: dedupe key `paneweft:<id>`, 24h window, the id file inside the job directory, the
  // adapter's claims and tags, the collector's environment sorted by key, a literal command. No shell. Written out by hand.
  // proves: CLAIM(N1-two-phase) CLAIM(IV16)
  it("submits with the dedupe key, window and id file", async () => {
    const { qex, adapter, dir, service } = await world();
    must(await service({ env: {} }).collect(request("job-a")), "collect");
    const submit = qex.calls().find((c) => c[0] === "submit")!;
    const jobDir = join(dir, "jobs", "job-a");
    expect(submit.slice(0, submit.indexOf("--"))).toEqual(["submit", "--dedupe-key", `paneweft:${JSON.parse(readFileSync(join(dir, "collection-session.json"), "utf8")).id}:job-a`, "--dedupe-window", "24h", "--id-file", join(jobDir, "qex.id"), "--cwd", adapter.workspaceRoot, "--name", "paneweft-job-a", "--cpu", "1", "--mem", "1GB", "--tag", "paneweft", "--timeout", "60s", "--env-capture", "minimal", "--env", "CARGO_TERM_COLOR=never", "--env", "PANEWEFT_ATTEMPT=1", "--env", "PANEWEFT_COLLECT=1", "--env", "PANEWEFT_RUN_ID=run-job-a", "--env", `PANEWEFT_STAGING_DIR=${join(jobDir, "staging", "run-job-a")}`]);
    expect(submit[submit.indexOf("--") + 1]).toBe(adapter.executable);
    expect(submit.slice(submit.indexOf("--") + 2).slice(0, 2)).toEqual(["test", "--manifest-path"]);
  });

  // why: the pure builder is what the service calls: same inputs, same vector (a regression pin for the literal above).
  // proves: CLAIM(N1-two-phase)
  it("buildQexSubmitArgv is the pure source of that vector", () => {
    const adapter = fakeCargoAdapter();
    const argv = buildQexSubmitArgv(adapter, "job-a", { executable: adapter.executable, argv: ["test"], cwd: adapter.workspaceRoot, env: { PANEWEFT_RUN_ID: "run-job-a" } }, "/s/jobs/job-a", 60_000, "paneweft:test-session:job-a");
    expect(argv.slice(0, 6)).toEqual(["submit", "--dedupe-key", "paneweft:test-session:job-a", "--dedupe-window", "24h", "--id-file"]);
    expect(argv.slice(-2)).toEqual([adapter.executable, "test"]);
  });

  // why: N1. The intent file is created first (before any qex call), with the parameters and the generated dedupe key, via O_EXCL.
  // proves: CLAIM(N1-two-phase) CLAIM(S3-job-lifecycle)
  it("writes intent.json with the parameters before qex is called", async () => {
    const { qex, dir, service } = await world({ crashAt: (point) => { if (point === "after-intent") throw new Error("crash"); } });
    await expect(service().collect(request("job-b"))).rejects.toThrow("crash");
    const intent = JSON.parse(readFileSync(join(dir, "jobs", "job-b", "intent.json"), "utf8"));
    expect(intent).toMatchObject({ schemaVersion: "paneweft.job-intent/1", requestId: "job-b", dedupeKey: `paneweft:${JSON.parse(readFileSync(join(dir, "collection-session.json"), "utf8")).id}:job-b`, params: { repo: "vg", adapter: "cargo", examples: ["watch.pending"] } });
    expect(qex.calls().filter((c) => c[0] === "submit")).toEqual([]);
  });

  // why: S3 dedupe. The same request id with identical parameters returns the existing job (created:false, one qex job, one execution);
  // different parameters under the same id are CONFLICT and do not submit anything.
  // proves: CLAIM(S3-job-lifecycle) CLAIM(IV17)
  it("dedupes by request id and refuses different parameters", async () => {
    const { qex, service } = await world();
    const first = must(await service().collect(request("job-c")), "first");
    const second = must(await service().collect(request("job-c")), "second");
    expect([first.created, second.created]).toEqual([true, false]);
    expect(second.qexId).toBe(first.qexId);
    await settle(service(), "job-c", ["succeeded"]);
    expect(qex.jobs()).toHaveLength(1);
    expect(qex.executions()).toHaveLength(1);
    const conflict = mustFail(await service().collect(request("job-c", { examples: ["watch.cancelled"] })), "different params");
    expect(conflict.code).toBe("CONFLICT");
    expect(qex.jobs()).toHaveLength(1);
  });

  // why: N1. A partial intent file (a failed fsync) is treated as never created: the same request id then creates a job normally.
  // proves: CLAIM(N1-two-phase)
  it("a truncated intent file is treated as never created", async () => {
    const { dir, service, qex } = await world();
    mkdirSync(join(dir, "jobs", "job-d"), { recursive: true });
    writeFileSync(join(dir, "jobs", "job-d", "intent.json"), '{"schemaVersion":"paneweft.job-in');
    const view = must(await service().collect(request("job-d")), "collect over a partial intent");
    expect(view.created).toBe(true);
    await settle(service(), "job-d", ["succeeded"]);
    expect(qex.executions()).toHaveLength(1);
  });
});

describe("[N1][S3] crash points", () => {
  // why: N1 crash test BEFORE the qex acknowledgement: qex never created the job (provably absent in `qex list`), the intent exists and
  // is unsubmitted. Recovery by a new service submits exactly once: one qex job, one execution.
  // proves: CLAIM(N1-two-phase) CLAIM(S3-job-lifecycle)
  it("a crash before the qex acknowledgement is recovered by submitting once", async () => {
    const { qex, service } = await world();
    qex.control({ failBeforeAck: true });
    const attempt = await service().collect(request("job-e"));
    expect(attempt.ok, "qex was unavailable: the call reports it").toBe(false);
    qex.control({ failBeforeAck: false });
    const view = await settle(service(), "job-e", ["succeeded"]);
    expect(view.runId).toBe("run-job-e");
    expect(qex.jobs()).toHaveLength(1);
    expect(qex.executions()).toHaveLength(1);
  });

  // why: N1 crash test AFTER the acknowledgement: qex has the job (and started it) but paneweft died before it learned the id. Recovery
  // adopts the job found by its dedupe key and NEVER submits again: still one qex job and one execution.
  // proves: CLAIM(N1-two-phase) CLAIM(S3-job-lifecycle)
  it("a crash after the qex acknowledgement adopts the job by its dedupe key", async () => {
    const { qex, service } = await world();
    qex.control({ crashAfterAck: true });
    const attempt = await service().collect(request("job-f"));
    expect(attempt.ok).toBe(false);
    qex.control({ crashAfterAck: false });
    const view = await settle(service(), "job-f", ["succeeded"]);
    expect(view.qexId).toBe("fq-1");
    expect(qex.calls().filter((c) => c[0] === "submit")).toHaveLength(1);
    expect(qex.executions()).toHaveLength(1);
  });

  // why: N1. If `qex list` cannot answer and the intent is unsubmitted, absence is NOT proven: the state is `indeterminate` with the
  // evidence, and nothing is ever resubmitted automatically.
  // proves: CLAIM(N1-two-phase)
  it("reports indeterminate with evidence and never resubmits when qex list is unavailable", async () => {
    const { qex, service } = await world({ crashAt: (point) => { if (point === "after-intent") throw new Error("crash"); } });
    await expect(service().collect(request("job-g"))).rejects.toThrow("crash");
    qex.control({ listFails: true });
    const view = must(await service({ crashAt: () => {} }).status("job-g"), "status");
    expect(view.state).toBe("indeterminate");
    expect(view.indeterminate?.evidence.join(" ")).toContain("qex list");
    expect(qex.calls().filter((c) => c[0] === "submit")).toEqual([]);
    qex.control({ listFails: true });
    expect(must(await service({ crashAt: () => {} }).status("job-g"), "again").state, "still indeterminate: no automatic resubmit").toBe("indeterminate");
    expect(qex.calls().filter((c) => c[0] === "submit")).toEqual([]);
  });

  // why: S3. After submit, a crash before the id file / submitted state is recovered from qex's own record (id file, else list): the
  // lifecycle ends succeeded with exactly one execution, for each crash point of the submission.
  // proves: CLAIM(S3-job-lifecycle)
  it.each<CrashPoint>(["after-qex-submit", "after-id-file", "after-submitted-state"])("recovers a crash at %s with one execution", async (point) => {
    const { qex, service } = await world({ crashAt: (p) => { if (p === point) throw new Error("crash"); } });
    await expect(service().collect(request("job-h"))).rejects.toThrow("crash");
    const view = await settle(service({ crashAt: () => {} }), "job-h", ["succeeded"]);
    expect(view.snapshotIds).toEqual(["snap-run-job-h"]);
    expect(qex.jobs()).toHaveLength(1);
    expect(qex.executions()).toHaveLength(1);
  });

  // why: S3 import crash points: a crash while importing is resumed or rolled back on the next status call: one terminal import, never
  // two. Each point leaves exactly one run in the session at the end.
  // proves: CLAIM(S3-job-lifecycle) CLAIM(IV20)
  it.each<CrashPoint>(["import:before-write", "import:after-objects", "import:after-manifest", "import:before-terminal-state"])("recovers a crash at %s with one import", async (point) => {
    const { session, service, qex } = await world({ crashAt: (p) => { if (p === point) throw new Error("crash"); } });
    must(await service().collect(request("job-i")), "collect");
    await vi.waitFor(async () => { await expect(service().status("job-i")).rejects.toThrow("crash"); }, { timeout: 20_000, interval: 50 });
    const view = await settle(service({ crashAt: () => {} }), "job-i", ["succeeded"]);
    expect(view.state).toBe("succeeded");
    expect(must(await openV1Reader(session).runs(), "runs")).toHaveLength(1);
    expect(qex.executions()).toHaveLength(1);
  });
});

describe("[N2][S2] cancellation", () => {
  // why: N2 queued: `qex cancel` is issued, the job never runs (zero executions), the outcome is cancelled.
  // proves: CLAIM(N2-cancellation) CLAIM(S2-cancel-through-qex)
  it("cancels a queued job with qex cancel and nothing runs", async () => {
    const { qex, service } = await world();
    qex.control({ hold: true });
    must(await service().collect(request("job-j")), "collect");
    const result = must(await service().cancel("job-j"), "cancel");
    expect(result).toMatchObject({ outcome: "cancelled", state: "cancelled", qexActions: ["cancel"] });
    expect(qex.executions()).toHaveLength(0);
  });

  // why: N2 starting: qex refuses `cancel` for a starting job, paneweft then issues `qex kill`, waits for a terminal qex state and only
  // then reports cancelled. Both calls are in the qex call log, in that order.
  // proves: CLAIM(N2-cancellation) CLAIM(S2-cancel-through-qex)
  it("falls back to qex kill when the job is starting", async () => {
    const { qex, service } = await world();
    qex.control({ startDelayMs: 5000 });
    must(await service().collect(request("job-k")), "collect");
    await vi.waitFor(() => expect(qex.jobs()[0]?.state).toBe("starting"), { timeout: 10_000, interval: 25 });
    const result = must(await service().cancel("job-k"), "cancel");
    expect(result).toMatchObject({ outcome: "cancelled", qexActions: ["cancel", "kill"] });
    expect(qex.calls().map((c) => c[0]).filter((c) => c === "cancel" || c === "kill")).toEqual(["cancel", "kill"]);
    expect(qex.jobs()[0].state).toBe("killed");
  });

  // why: S5. The fake's delayed starter ignored a job that was killed while it waited out its start delay and launched it anyway, so
  // the test that cancels a `starting` job proved nothing: it asserted before the delay expired. Here the delay is waited out and
  // the runner must never have executed; the job stays killed.
  // Rejects a starter that begins a job whose recorded state is no longer queued/starting.
  // proves: CLAIM(N2-cancellation) CLAIM(S5-fake-fidelity)
  it("never starts a job that was killed during its start delay", async () => {
    const { qex, service } = await world();
    qex.control({ startDelayMs: 600 });
    must(await service().collect(request("job-k2")), "collect");
    await vi.waitFor(() => expect(qex.jobs()[0]?.state).toBe("starting"), { timeout: 10_000, interval: 10 });
    const result = must(await service().cancel("job-k2"), "cancel");
    expect(result).toMatchObject({ outcome: "cancelled", qexActions: ["cancel", "kill"] });
    await new Promise((resolve) => setTimeout(resolve, 1400));
    expect(qex.executions(), "the runner never began").toHaveLength(0);
    expect(qex.jobs()[0].state).toBe("killed");
  });

  // why: S2 / N2 running + descendants. Cancelling a running job kills the PROCESS GROUP: a grandchild that appends a heartbeat stops
  // (the file stops growing after cancel returns). Killing only the waiter would leave it running (S2: never assume that stops the job).
  // proves: CLAIM(S2-cancel-through-qex) CLAIM(N2-cancellation) CLAIM(IV17)
  it("stops descendants of a running job", async () => {
    const { qex, dir, service } = await world();
    const heartbeat = join(dir, "heartbeat");
    const ready = join(dir, "ready");
    qex.scenario({ mode: "heartbeat", heartbeatFile: heartbeat, readyFile: ready });
    must(await service().collect(request("job-l")), "collect");
    await vi.waitFor(() => { expect(existsSync(ready)).toBe(true); expect(existsSync(heartbeat) && statSync(heartbeat).size > 2).toBe(true); }, { timeout: 15_000, interval: 25 });
    const result = must(await service().cancel("job-l"), "cancel");
    expect(result).toMatchObject({ outcome: "cancelled", qexActions: expect.arrayContaining(["kill"]) });
    const size = statSync(heartbeat).size;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(statSync(heartbeat).size, "the grandchild kept writing after cancel returned").toBe(size);
  });

  // why: S2 "after the MCP client disconnects": a NEW service instance (a later session, no shared memory) cancels the job from the
  // durable record alone.
  // proves: CLAIM(S2-cancel-through-qex)
  it("cancels from a different service instance", async () => {
    const { qex, dir, service } = await world();
    qex.scenario({ mode: "heartbeat", heartbeatFile: join(dir, "hb"), readyFile: join(dir, "ready2") });
    must(await service().collect(request("job-m")), "collect");
    await vi.waitFor(() => expect(existsSync(join(dir, "ready2"))).toBe(true), { timeout: 15_000, interval: 25 });
    const later = service();
    expect(must(await later.cancel("job-m"), "cancel").outcome).toBe("cancelled");
  });

  // why: N2 completed: cancelling a finished job is a no-op that returns the terminal state.
  // proves: CLAIM(N2-cancellation)
  it("cancel after completion is a no-op", async () => {
    const { qex, service } = await world();
    must(await service().collect(request("job-n")), "collect");
    await settle(service(), "job-n", ["succeeded"]);
    const callsBefore = qex.calls().length;
    expect(must(await service().cancel("job-n"), "cancel")).toMatchObject({ outcome: "already-terminal", state: "succeeded", qexActions: [] });
    expect(qex.calls().filter((c) => c[0] === "kill" || c[0] === "cancel")).toEqual([]);
    expect(qex.calls().length).toBeGreaterThanOrEqual(callsBefore);
  });

  // why: N2 importing: cancel during the import lets the atomic import finish and says cancel-too-late with the terminal outcome.
  // proves: CLAIM(N2-cancellation) CLAIM(IV20)
  it("cancel during import is too late and the import finishes", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { session, service } = await world({ crashAt: async (p) => { if (p === "import:before-write") await gate; } });
    const svc = service();
    must(await svc.collect(request("job-o")), "collect");
    const advancing = svc.status("job-o", { waitSeconds: 20 });
    await vi.waitFor(async () => expect(must(await service({ crashAt: () => {} }).status("job-o"), "peek").state).toBe("importing"), { timeout: 15_000, interval: 25 });
    const cancelled = must(await service({ crashAt: () => {} }).cancel("job-o"), "cancel");
    expect(cancelled).toMatchObject({ outcome: "cancel-too-late" });
    release();
    await advancing;
    expect(must(await service({ crashAt: () => {} }).status("job-o"), "after").state).toBe("succeeded");
    expect(must(await openV1Reader(session).runs(), "runs")).toHaveLength(1);
  });
});

describe("[IV17] what a finished job leaves", () => {
  // why: IV17 / spec section 8. A run whose example FAILED still imports: the job ends `failed` (the command reports failure), the
  // snapshot and the captured object exist, and the diagnostics are recorded; a valid bundle is not a successful collection.
  // proves: CLAIM(IV17) CLAIM(IV8)
  it("imports a failing run and reports the job as failed", async () => {
    const { session, qex, service } = await world();
    qex.scenario({ mode: "fail" });
    must(await service().collect(request("job-p")), "collect");
    const view = await settle(service(), "job-p", ["failed"]);
    expect(view.collectionStatus).toBe("failed");
    expect(view.snapshotIds).toEqual(["snap-run-job-p"]);
    const run = must(await openV1Reader(session).run("run-job-p"), "run");
    expect(run.origin).toBe("host_collected");
    expect(run.run.examples.map((e) => [e.id, e.outcome])).toEqual([["watch.pending", "failed"]]);
  });

  // why: spec section 8 / IV8. An artifact of ANOTHER run (a stale file in the staging directory) can never satisfy this run: it is not
  // imported, lands in quarantine/ with a diagnostic, and the collection is not a success.
  // proves: CLAIM(IV8) CLAIM(IV17)
  it("quarantines an artifact of a different run", async () => {
    const { session, qex, dir, service } = await world();
    qex.scenario({ graphRunId: "run-SOMEONE-ELSE" });
    must(await service().collect(request("job-q")), "collect");
    const view = await settle(service(), "job-q", ["failed"]);
    expect(view.collectionStatus).toBe("failed");
    expect(view.diagnosticIds.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "jobs", "job-q", "quarantine", "captures", "inv-1.json")), "the foreign capture sits in quarantine").toBe(true);
    const run = must(await openV1Reader(session).run("run-job-q"), "the native results are still recorded");
    expect(run.run.invocations[0]!.capture.outcome).toBe("failed");
    expect(run.run.examples[0]!.verified).toBe(false);
    const object = await openV1Reader(session).object({ snapshotId: "snap-run-job-q", captureId: "inv-1", objectId: "o1" });
    expect(object.ok, "no object of the foreign capture became part of the snapshot").toBe(false);
  });

  // why: the write lock is NOT held while tests run (spec section 6): a v0 write during a running collection succeeds immediately.
  // proves: CLAIM(IV17) CLAIM(IV20)
  it("does not hold the session write lock while the runner runs", async () => {
    const { session, qex, dir, service } = await world();
    qex.scenario({ mode: "heartbeat", heartbeatFile: join(dir, "hb3"), readyFile: join(dir, "ready3") });
    must(await service().collect(request("job-r")), "collect");
    await vi.waitFor(() => expect(existsSync(join(dir, "ready3"))).toBe(true), { timeout: 15_000, interval: 25 });
    const started = Date.now();
    must(await session.importBundle(loadFixture("components/all.bundle.json")), "v0 write during the run");
    expect(Date.now() - started).toBeLessThan(2000);
    await service().cancel("job-r");
  });

  // why: concurrent jobs get separate run and staging ids (spec section 6).
  // proves: CLAIM(S3-job-lifecycle)
  it("gives concurrent jobs separate run and staging directories", async () => {
    const { qex, dir, service } = await world();
    const a = must(await service().collect(request("job-s1")), "a");
    const b = must(await service().collect(request("job-s2")), "b");
    expect([a.runId, b.runId]).toEqual(["run-job-s1", "run-job-s2"]);
    await settle(service(), "job-s1", ["succeeded"]);
    await settle(service(), "job-s2", ["succeeded"]);
    expect(existsSync(join(dir, "jobs", "job-s1", "staging", "run-job-s1"))).toBe(true);
    expect(existsSync(join(dir, "jobs", "job-s2", "staging", "run-job-s2"))).toBe(true);
    expect(qex.executions()).toHaveLength(2);
  });

  // why: status waits are bounded: more than 30 seconds is INVALID_ARGUMENT with the limit in the message.
  // proves: CLAIM(IV19)
  it("refuses a wait longer than 30 seconds", async () => {
    const { service } = await world();
    must(await service().collect(request("job-t")), "collect");
    const error = mustFail(await service().status("job-t", { waitSeconds: 31 }), "wait");
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.message).toContain("30");
  });

  // why: an unknown job id is NOT_FOUND, not a crash.
  // proves: CLAIM(IV19)
  it("an unknown job is NOT_FOUND", async () => {
    const { service } = await world();
    expect(mustFail(await service().status("job-none"), "status").code).toBe("NOT_FOUND");
    expect(mustFail(await service().cancel("job-none"), "cancel").code).toBe("NOT_FOUND");
  });

  // why: collect with an unregistered adapter fails before anything is written, with the setup command in the hint (IV16).
  // proves: CLAIM(IV16)
  it("rejects an unregistered adapter with the setup command", async () => {
    const { dir, service, qex } = await world();
    const error = mustFail(await service().collect(request("job-u", { adapter: "ghost" })), "unregistered");
    expect(error.code).toBe("NOT_FOUND");
    expect(JSON.stringify(error.errors)).toContain("paneweft adapter add");
    expect(existsSync(join(dir, "jobs", "job-u"))).toBe(false);
    expect(qex.calls()).toEqual([]);
  });

  // why: the runner fixture and the fake qex are part of the contract of these tests; they must exist and be executable.
  // proves: CLAIM(IV17)
  it("the fake runner fixtures exist", () => {
    expect(statSync(join(FIXTURES, "v1/bin/qex")).isFile()).toBe(true);
    expect(statSync(join(FIXTURES, "v1/runners/fake-cargo.mjs")).isFile()).toBe(true);
  });
});

describe("[S1] a job id is a name, never a path", () => {
  // why: S1. status and cancel took the caller's id straight into `jobs/<id>/`, so `../evil` read a record planted beside the jobs directory as a job.
  // Rejects the implementation that joins the id without checking it against the request-id grammar.
  // proves: CLAIM(S1-confinement)
  it("answers NOT_FOUND for an id with path separators and reads nothing outside jobs/", async () => {
    const { dir, service } = await world();
    must(await service().collect(request("job-s1a")), "collect");
    const planted = join(dir, "evil");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "intent.json"), readFileSync(join(dir, "jobs", "job-s1a", "intent.json")));
    writeFileSync(join(planted, "state.json"), JSON.stringify({ schemaVersion: "paneweft.job/1", requestId: "evil", state: "succeeded", qexId: null, runId: null, history: [] }));
    for (const hostile of ["../evil", "..", ".", "a/b", ""]) {
      expect(mustFail(await service().status(hostile), `status ${JSON.stringify(hostile)}`).code).toBe("NOT_FOUND");
      expect(mustFail(await service().cancel(hostile), `cancel ${JSON.stringify(hostile)}`).code).toBe("NOT_FOUND");
    }
  });
});

describe("[S4] a job qex stopped with a signal still imports", () => {
  const heartbeat = async (world_: Awaited<ReturnType<typeof world>>, name: string) => {
    const { qex, dir } = world_;
    qex.scenario({ mode: "heartbeat", heartbeatFile: join(dir, `hb-${name}`), readyFile: join(dir, `ready-${name}`) });
    return join(dir, `ready-${name}`);
  };

  // why: S4. Real qex reports a killed job as state killed, exit_code null, signal 15 (a number). The job service passed the number into the
  // string-only test-run schema, so a collection that somebody killed (not through paneweft) could not be imported and status threw.
  // The fake now speaks the real shapes (src/v1/qex.contract.test.ts pins them against captured output).
  // proves: CLAIM(S4-real-qex) CLAIM(IV17)
  it("imports a collection that was killed from outside, with the signal named", async () => {
    const w = await world();
    const ready = await heartbeat(w, "kill");
    const started = must(await w.service().collect(request("job-sig")), "collect");
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 15_000, interval: 25 });
    must(await w.qex.client.kill(started.qexId!), "an operator kills the job");
    const view = await settle(w.service(), "job-sig", ["failed", "cancelled"]);
    const run = must(await openV1Reader(w.session).run("run-job-sig"), "the run imported");
    expect(run.run.collection.exitCode).toBeNull();
    expect(run.run.collection.signal).toBe("SIGKILL");
    expect(view.snapshotIds).toEqual(["snap-run-job-sig"]);
  });

  // why: S4. A job qex stopped at its time limit has state timeout, exit_code null and signal 15. It imports as a timed-out collection.
  // proves: CLAIM(S4-real-qex) CLAIM(IV17)
  it("imports a collection that hit its time limit as timed-out", async () => {
    const w = await world();
    w.qex.control({ timeoutAfterMs: 500 });
    await heartbeat(w, "limit");
    must(await w.service().collect(request("job-lim")), "collect");
    const view = await settle(w.service(), "job-lim", ["failed"]);
    expect(view.collectionStatus).toBe("timed-out");
    const run = must(await openV1Reader(w.session).run("run-job-lim"), "the run imported");
    expect(run.run.collection).toMatchObject({ status: "timed-out", timedOut: true, exitCode: null, signal: "SIGTERM" });
  });
});

describe("[S3] a collect request can only lower the capture bounds", () => {
  const limitsEnv = (qex: Awaited<ReturnType<typeof world>>["qex"]): Record<string, number> | undefined => {
    const submit = qex.calls().find((c) => c[0] === "submit")!;
    const entry = submit.filter((_, i) => submit[i - 1] === "--env").find((pair) => pair.startsWith("PANEWEFT_LIMITS="));
    return entry === undefined ? undefined : JSON.parse(entry.slice("PANEWEFT_LIMITS=".length));
  };

  // why: S3. The `limits` of a collect request went to the worker's environment as given: a payload could ask for 2^40 bytes. Rejects the
  // implementation that forwards the request's numbers. Lower numbers still pass through; higher ones become the SDK default.
  // proves: CLAIM(S3-clamp)
  it("clamps a bound above the SDK default and keeps a lower one", async () => {
    const { qex, service } = await world();
    must(await service().collect(request("job-l1", { limits: { collectionBytes: 2 ** 40, objects: 5, depth: 99 } })), "collect");
    expect(limitsEnv(qex)).toEqual({ collectionBytes: 33_554_432, depth: 4, objects: 5 });
  });

  // why: S3. The operator's ceiling (the adapter's limitCeilings) is below the SDK default: it wins over the request.
  // proves: CLAIM(S3-clamp)
  it("clamps to the adapter's operator ceiling", async () => {
    const { session, dir } = await open();
    const qex = fake();
    const adapter = fakeCargoAdapter({ limitCeilings: { objects: 3 } });
    const service = createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter], catalogueFor: async () => catalogue, cancelWaitMs: 3000 });
    must(await service.collect(request("job-l2", { limits: { objects: 500, rootBytes: 1024 } })), "collect");
    expect(limitsEnv(qex)).toEqual({ objects: 3, rootBytes: 1024 });
  });

  // why: S3. Names and values that are not bounds are refused before anything is written: unknown names, floats, negatives, strings,
  // unsafe integers and a non-object.
  // proves: CLAIM(S3-clamp)
  it.each([{ bogus: 1 }, { objects: 1.5 }, { objects: -1 }, { objects: "5" }, { rootBytes: 2 ** 60 }, { objects: 0 }, [5], "many"])("refuses limits %j", async (limits) => {
    const { dir, service, qex } = await world();
    const error = mustFail(await service().collect(request("job-l3", { limits })), "limits");
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(existsSync(join(dir, "jobs", "job-l3"))).toBe(false);
    expect(qex.calls()).toEqual([]);
  });
});

describe("[S3r2] the operator's ceilings bind every collect, and the reply says what was clamped", () => {
  const SDK = { depth: 4, objects: 1000, references: 4000, rootBytes: 2 * 1024 * 1024, stringBytes: 16 * 1024, pageRows: 100, collectionBytes: 32 * 1024 * 1024, roots: 100, viewRows: 10_000, viewBudgetMs: 100 };
  const limitsEnv = (qex: Awaited<ReturnType<typeof world>>["qex"]): Record<string, number> | undefined => {
    const submit = qex.calls().find((c) => c[0] === "submit")!;
    const entry = submit.filter((_, i) => submit[i - 1] === "--env").find((pair) => pair.startsWith("PANEWEFT_LIMITS="));
    return entry === undefined ? undefined : JSON.parse(entry.slice("PANEWEFT_LIMITS=".length));
  };
  const withCeilings = async (limitCeilings: Record<string, number>) => {
    const { session, dir } = await open();
    const qex = fake();
    const adapter = fakeCargoAdapter({ limitCeilings });
    const service = createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter], catalogueFor: async () => catalogue, cancelWaitMs: 3000 });
    return { qex, service };
  };

  // why: S3 (round 2). Ceilings were applied to the members a request NAMED. A request without `limits`, with `{}`, or with other members left
  // the SDK defaults active, so the operator's number never bit. Effective = min(operator ceiling, SDK default), and a request may only lower it.
  // Rejects an implementation that starts from the SDK defaults and applies the ceiling to requested members only.
  // proves: CLAIM(S3-clamp)
  it.each([["no limits", undefined], ["an empty object", {}], ["another bound", { rootBytes: 1024 }]])("applies the ceiling when the request has %s", async (_name, limits) => {
    const { qex, service } = await withCeilings({ objects: 3 });
    must(await service.collect(request("job-c1", limits === undefined ? {} : { limits })), "collect");
    expect(limitsEnv(qex)).toEqual({ objects: 3, ...(limits === undefined ? {} : limits) });
  });

  // why: S3 (round 2). A ceiling ABOVE the SDK default does not raise anything: the effective number is the smaller of the two.
  // proves: CLAIM(S3-clamp)
  it("never lets a ceiling above the SDK default raise a bound", async () => {
    const { qex, service } = await withCeilings({ objects: 1_000_000, collectionBytes: 2 ** 40 });
    must(await service.collect(request("job-c2", { limits: { objects: 999_999 } })), "collect");
    expect(limitsEnv(qex)).toEqual({ objects: 1000 });
  });

  // why: S3 (round 2). The owner wants to SEE the clamp: the job reply carries what was requested, what is in force for every bound, and which
  // requested bounds were cut. A request that asks for no more than allowed clamps nothing.
  // proves: CLAIM(S3-clamp)
  it("reports requested, effective and clamped in the reply of collect and of status", async () => {
    const { service } = await withCeilings({ objects: 3 });
    const created = must(await service.collect(request("job-c3", { limits: { objects: 500, rootBytes: 1024 } })), "collect");
    const expected = { requested: { objects: 500, rootBytes: 1024 }, effective: { ...SDK, objects: 3, rootBytes: 1024 }, clamped: ["objects"] };
    expect((created as any).limits).toEqual(expected);
    expect(((await settle(service, "job-c3", ["succeeded", "failed"])) as any).limits).toEqual(expected);
    const modest = must(await service.collect(request("job-c4", { limits: { objects: 2 } })), "collect");
    expect((modest as any).limits).toEqual({ requested: { objects: 2 }, effective: { ...SDK, objects: 2 }, clamped: [] });
    const none = must(await service.collect(request("job-c5")), "collect");
    expect((none as any).limits).toEqual({ requested: {}, effective: { ...SDK, objects: 3 }, clamped: [] });
  });

  // why: S3 (round 2). The same request id with the same EFFECTIVE bounds is the same job: no limits, `{}` and a request equal to the default
  // are one parameter set.
  // proves: CLAIM(S3-clamp) CLAIM(S3-job-lifecycle)
  it("treats absent, empty and default-equal limits as one request", async () => {
    const { service } = await withCeilings({});
    must(await service.collect(request("job-c6")), "collect");
    expect(must(await service.collect(request("job-c6", { limits: {} })), "collect").created).toBe(false);
  });
});

describe("[S6] an intent is published whole or not at all", () => {
  // why: S6. createIntent opened intent.json with O_EXCL and wrote it afterwards; a concurrent caller that read the new, still empty file
  // took it for an abandoned partial, unlinked it, and published ITS parameters under the same request id, so two callers both "created"
  // the job with different parameters. Rejects an implementation that treats an unreadable intent file as abandoned without knowing whether its writer is alive.
  // Four callers with two parameter sets race on each of 30 request ids: exactly one parameter set owns each id, every other caller is told so.
  // proves: CLAIM(S6-intent-publication) CLAIM(N1-two-phase)
  it("lets exactly one parameter set own a request id under concurrent collects", async () => {
    const { dir, service, qex } = await world();
    const sets = [{ examples: ["watch.pending"] }, { examples: ["watch.cancelled"] }];
    const violations: string[] = [];
    for (let round = 0; round < 30; round += 1) {
      const id = `race-${round}`;
      const answers = await Promise.all([0, 1, 0, 1].map((which) => service().collect(request(id, sets[which]!)).then((result) => ({ which, result }))));
      const created = answers.filter((a) => a.result.ok && a.result.value.created);
      const intent = JSON.parse(readFileSync(join(dir, "jobs", id, "intent.json"), "utf8"));
      const owner = sets.findIndex((set) => JSON.stringify(set.examples) === JSON.stringify(intent.params.examples));
      if (created.length !== 1) violations.push(`${id}: ${created.length} callers created the job`);
      for (const answer of answers) {
        const agrees = answer.which === owner;
        if (agrees !== answer.result.ok) violations.push(`${id}: caller with set ${answer.which} got ${answer.result.ok ? "ok" : `${answer.result.error.code} ${answer.result.error.message}`} but the intent holds set ${owner}`);
      }
    }
    expect(violations).toEqual([]);
    expect(qex.calls().filter((c) => c[0] === "submit")).toHaveLength(30);
  }, 120_000);

  // why: S6. A caller that arrives while another caller's intent is still being written must wait for it, not replace it: the intent file
  // never exists in a partial state for a reader (a reader sees nothing or the whole document).
  // proves: CLAIM(S6-intent-publication)
  it("never exposes a partial intent file to a reader", async () => {
    const { dir, service } = await world();
    const seen: string[] = [];
    const watching = (async () => {
      const path = join(dir, "jobs", "watch-1", "intent.json");
      for (let i = 0; i < 4000; i += 1) {
        try { const text = readFileSync(path, "utf8"); JSON.parse(text); seen.push("whole"); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") seen.push(`partial:${String(cause).slice(0, 60)}`); }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    must(await service().collect(request("watch-1")), "collect");
    await watching;
    expect(seen.filter((s) => s.startsWith("partial"))).toEqual([]);
  });
});

describe("[D1] the host holds a capture to the operator's ceilings", () => {
  // why: D1. The worker's own SDK is told the ceilings through PANEWEFT_LIMITS, but the host does not rely on that: a capture that declares
  // bounds above the adapter's limitCeilings (an SDK that ignored its environment, or a hostile one) is quarantined, and the run still imports.
  // Rejects admission that trusts the declared limits of the artifact.
  // proves: CLAIM(D1-host-ceilings)
  it("quarantines a capture that declares more than the adapter's ceiling", async () => {
    const { session, dir } = await open();
    const qex = fake();
    const adapter = fakeCargoAdapter({ limitCeilings: { objects: 2 } });
    const service = createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter], catalogueFor: async () => catalogue, cancelWaitMs: 3000 });
    must(await service.collect(request("job-d1")), "collect");
    const view = await settle(service, "job-d1", ["failed"]);
    expect(view.collectionStatus).toBe("failed");
    expect(existsSync(join(dir, "jobs", "job-d1", "quarantine", "captures", "inv-1.json")), "the oversized capture sits in quarantine").toBe(true);
    expect(must(await openV1Reader(session).run("run-job-d1"), "the run is still recorded").run.invocations[0]!.capture.outcome).toBe("failed");
  });
});

// WHY CLAIM(S39): collectionBytes bounds each capture document. Rejects one staging budget of collectionBytes for the whole run: the second
// of three 2000-byte captures under a 3000-byte limit was quarantined and its invocation lost its capture.
it("[S39] admits every capture of a run that is under collectionBytes though they exceed it together", async () => {
  const { session, dir, qex, service } = await world();
  qex.scenario({ padBytes: 2000, declaredCollectionBytes: 3000 });
  must(await service().collect(request("s39", { examples: ["watch.cancelled", "watch.pending", "watch.redelivered"], limits: { collectionBytes: 3000 } })), "collect");
  const view = await settle(service(), "s39", ["succeeded", "failed"]);
  expect(view.state, JSON.stringify(view)).toBe("succeeded");
  expect(existsSync(join(dir, "jobs", "s39", "quarantine", "captures", "inv-2.json"))).toBe(false);
  const run = must(await openV1Reader(session).run("run-s39"), "run");
  expect(run.run.invocations.map((invocation: any) => invocation.capture.outcome)).toEqual(["captured", "captured", "captured"]);
});

// WHY CLAIM(S39): the per-capture bound still holds at the job: a capture over collectionBytes is quarantined, its neighbours are not.
it("[S39] quarantines a capture over collectionBytes", async () => {
  const { dir, qex, service } = await world();
  qex.scenario({ padBytes: 3001, declaredCollectionBytes: 3000 });
  must(await service().collect(request("s39b", { limits: { collectionBytes: 3000 } })), "collect");
  await settle(service(), "s39b", ["failed"]);
  expect(existsSync(join(dir, "jobs", "s39b", "quarantine", "captures", "inv-1.json"))).toBe(true);
});

// WHY CLAIM(S31): rejects service-wide held.has(id) letting an unrelated status operation advance a live importer.
it("[S31] concurrent calls on one service cannot reenter the owner's import lease", async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const w = await world({ crashAt: async (point) => { if (point === "import:before-write") { enter(); await gate; } } });
  const svc = w.service();
  must(await svc.collect(request("s31")), "collect");
  const owner = svc.status("s31", { waitSeconds: 30 });
  await entered;
  const spy = vi.spyOn(w.qex.client, "status").mockRejectedValue(new Error("unrelated operation entered qex while owner held import lease"));
  try {
    const observer = must(await svc.status("s31"), "observer");
    expect(observer.state).toBe("importing");
    expect(spy).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); release(); await owner; }
});
// WHY CLAIM(S32): rejects advance's permanent early return for an indeterminate state with a known qex id.
it("[S32] observes a known qex id again after one transient status failure without resubmission", async () => {
  const w = await world();
  w.qex.control({ hold: true });
  const svc = w.service();
  const collected = must(await svc.collect(request("s32")), "collect");
  const spy = vi.spyOn(w.qex.client, "status").mockResolvedValueOnce({ ok: false, error: { schemaVersion: "paneweft.error/1", code: "RUNNER_FAILED", message: "temporary disconnect", retryable: true, errors: [] } });
  expect(must(await svc.status("s32"), "first status").state).toBe("indeterminate");
  const recovered = must(await svc.status("s32"), "second status");
  expect(recovered.state).toBe("queued");
  expect(recovered.qexId).toBe(collected.qexId);
  expect(spy).toHaveBeenCalledTimes(2);
  expect(w.qex.calls().filter((c) => c[0] === "submit")).toHaveLength(1);
  spy.mockRestore();
  await svc.cancel("s32");
});
// WHY CLAIM(S38): rejects global paneweft:<request-id> adoption across independent sessions, including recovery by list.
it("[S38] scopes submission and recovery identities to the session", async () => {
  const a = await open(); const b = await open(); const qex = fake(); const adapter = fakeCargoAdapter();
  qex.control({ hold: true });
  const make = (env: typeof a, crashAt?: (p: CrashPoint) => void) => createJobService({ session: env.session, sessionDir: env.dir, qex: qex.client, adapters: [adapter], catalogueFor: async () => catalogue, ...(crashAt === undefined ? {} : { crashAt }) });
  const first = must(await make(a).collect(request("r1")), "first session");
  await expect(make(b, (p) => { if (p === "after-intent") throw new Error("restart"); }).collect(request("r1"))).rejects.toThrow("restart");
  const second = must(await make(b).status("r1"), "recover second session");
  expect(second.qexId).not.toBe(first.qexId);
  expect(qex.jobs()).toHaveLength(2);
  const keys = [a, b].map((env) => JSON.parse(readFileSync(join(env.dir, "jobs/r1/intent.json"), "utf8")).dedupeKey);
  expect(keys[0]).not.toBe(keys[1]);
  await make(a).cancel("r1"); await make(b).cancel("r1");
});

// ---- S41: a waiting status waits whoever holds the lease -------------------------------------------------------------------------------

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** The promise's value once it has settled, or "pending" when it has not within `ms`. */
const within = async <T>(promise: Promise<T>, ms: number): Promise<T | "pending"> => Promise.race([promise, pause(ms).then(() => "pending" as const)]);

// WHY CLAIM(S41): a status with waitSeconds returned at once with the persisted state whenever another operation held the lease, including
// another waiting status (jobs.ts looked at `followed.held`, found false and answered immediately). Rejects that early return.
it("[S41] a second waiting status in one process blocks until the job is terminal and returns the log window", async () => {
  const w = await world();
  w.qex.control({ hold: true });
  const svc = w.service();
  const collected = must(await svc.collect(request("s41")), "collect");
  const first = svc.status("s41", { waitSeconds: 20 });
  const second = svc.status("s41", { waitSeconds: 20, maxLogBytes: 64 });
  expect(await within(second, 1500), "still queued: the waiting status keeps waiting").toBe("pending");
  w.qex.release(collected.qexId!);
  const [a, b] = [must(await first, "first"), must(await second, "second")];
  expect([a.state, b.state]).toEqual(["succeeded", "succeeded"]);
  expect(b.log?.text.length, "maxLogBytes applies on the waiting path").toBeGreaterThan(0);
  expect(b.log!.text.length).toBeLessThanOrEqual(64);
  expect(b.log!.cursor, "the log is longer than the 64 bytes asked for").not.toBeNull();
});

// WHY CLAIM(S41): the wait is bounded by its own deadline, not by the holder's: the second waits its seconds and then answers with what is persisted.
it("[S41] a second waiting status that outlasts its deadline answers with the persisted state at the deadline", async () => {
  const w = await world();
  w.qex.control({ hold: true });
  const svc = w.service();
  must(await svc.collect(request("s41b")), "collect");
  const first = svc.status("s41b", { waitSeconds: 20 });
  const started = Date.now();
  const second = must(await svc.status("s41b", { waitSeconds: 2 }), "second");
  const elapsed = Date.now() - started;
  expect(second.state).toBe("queued");
  expect(elapsed).toBeGreaterThanOrEqual(1900);
  expect(elapsed).toBeLessThan(5000);
  must(await svc.cancel("s41b"), "cancel");
  await first;
});

// WHY CLAIM(S41): the same across processes. A status in a CHILD process holds the lease and follows the job; the waiting status here only polls the
// persisted state, so it neither returns early nor spawns a flock helper per poll. The shim `flock` counts the helpers this process starts.
it("[S41] a waiting status blocks while another process holds the lease and does not spawn a flock helper per poll", async () => {
  const w = await world();
  w.qex.control({ hold: true });
  const svc = w.service();
  const collected = must(await svc.collect(request("s41c")), "collect");
  const lock = join(w.dir, "jobs", "s41c", "import-lock", ".write.lock");
  const child: ChildProcess = fork(fileURLToPath(new URL("../../test/helpers/job-status-child.ts", import.meta.url)), [w.dir, "s41c", JSON.stringify({ adapter: w.adapter, catalogue: join(FIXTURES, "v1/catalogues/watchfile.catalogue.json"), waitSeconds: 25 })], { execArgv: ["--import", "tsx"], env: w.qex.env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const childDone = new Promise<any>((resolve, reject) => { child.on("message", (m: any) => { if (m.event === "done") resolve(m.result); }); child.on("exit", (code) => reject(new Error(`child exited ${code} before done`))); });
  childDone.catch(() => {});
  const realFlock = spawnSync("sh", ["-c", "command -v flock"], { encoding: "utf8" }).stdout.trim();
  const shimDir = mkdtempSync(join(tmpdir(), "flock-shim-"));
  const counter = join(shimDir, "count");
  writeFileSync(join(shimDir, "flock"), `#!/bin/sh\necho x >> ${counter}\nexec ${realFlock} "$@"\n`);
  chmodSync(join(shimDir, "flock"), 0o755);
  const held = (): boolean => existsSync(lock) && spawnSync(realFlock, ["--nonblock", lock, "true"]).status === 1;
  try {
    await vi.waitFor(() => expect(held(), "the child holds the lease").toBe(true), { timeout: 20_000, interval: 50 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${savedPath}`;
    const started = Date.now();
    let second: Promise<any>;
    try {
      second = svc.status("s41c", { waitSeconds: 25, maxLogBytes: 64 }).then((r) => must(r, "second"));
      expect(await within(second, 2600), "the second status keeps waiting while the child follows the job").toBe("pending");
    } finally { process.env.PATH = savedPath; }
    const heldFor = Date.now() - started;
    const helpers = existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").length : 0;
    w.qex.release(collected.qexId!);
    const [mine, theirs] = [await second!, await childDone];
    expect(mine.state).toBe("succeeded");
    expect(mine.log?.text.length ?? 0).toBeGreaterThan(0);
    expect(theirs.value.state).toBe("succeeded");
    expect(helpers, `${helpers} flock helpers in ${heldFor} ms of waiting: one per second at most, never one per poll`).toBeLessThanOrEqual(Math.ceil(heldFor / 1000) + 1);
  } finally { child.kill("SIGKILL"); }
});

// ---- T1: admission lowers the views and checks the v0 component schemas; an import that fails still ends the job ------------------------------

/** A graph written by the TS SDK: one object with a list view of `columns` text columns. */
function wideListGraph(columns: number): any {
  const Wide = defineType<{ n: number }>({ id: `t::Wide${columns}`, source: { path: "wide.ts", symbol: "Wide" } });
  Wide.view({ id: "wide.rows", title: "Wide", question: "Which columns?", priority: 1, component: "list", render: (_spec, view) => {
    const table = view.table();
    for (let at = 0; at < columns; at += 1) table.textColumn(`c${at}`, `Column ${at}`);
    table.row({ id: "r1", cells: {} });
    return table.done();
  } });
  const capture = new Capture({ limits: specLimits() });
  capture.publish({ n: 1 }, Wide);
  return capture.finish().toJSON();
}
/** A graph with a shape view whose single field path is `bytes` long (the v0 shape schema allows 1024). */
function longPathGraph(bytes: number): any {
  const Deep = defineType<{ n: number }>({ id: "t::Deep", source: { path: "deep.ts", symbol: "Deep" } });
  Deep.view({ id: "deep.details", title: "Deep", question: "What is it?", priority: 1, component: "shape", render: (_spec, view) => view.details().field("a", 1).done() });
  const capture = new Capture({ limits: specLimits() });
  capture.publish({ n: 1 }, Deep);
  const graph = capture.finish().toJSON() as any;
  graph.views[0].data.fields[1].path = `$.${"a".repeat(bytes - 2)}`;
  return graph;
}
const writeGraph = (dir: string, name: string, graph: unknown): string => { const file = join(dir, `${name}.graph.json`); writeFileSync(file, JSON.stringify(graph)); return file; };

describe("[T1] a capture that cannot be imported is refused at admission", () => {
  // WHY CLAIM(T1-admission): `validateObjectGraph` accepted any view.data and the component schemas ran only in importCollection, so a list view with 65
  // columns (schema maxItems 64) was admitted, the import failed, finish threw after writing finalized.json and the job stayed `importing` for ever.
  // Rejects admission that checks the capture's own schema but not the lowered views.
  for (const [name, graph] of [["65 textColumns", () => wideListGraph(65)], ["a shape field path over 1024 bytes", () => longPathGraph(1025)]] as const) {
    it(`quarantines a capture with ${name} and the job ends failed`, async () => {
      const { session, dir, qex, service } = await world();
      qex.scenario({ captureFile: writeGraph(dir, "t1", graph()) });
      must(await service().collect(request("t1")), "collect");
      const view = await settle(service(), "t1", ["succeeded", "failed"]);
      expect(view.state, JSON.stringify(view)).toBe("failed");
      expect(view.diagnosticIds).toContain("run-t1:diag-inv-1");
      expect(existsSync(join(dir, "jobs", "t1", "quarantine", "captures", "inv-1.json")), "the capture sits in quarantine").toBe(true);
      const diagnostics = JSON.parse(readFileSync(join(dir, "jobs", "t1", "diagnostics.json"), "utf8"));
      expect(diagnostics.find((d: any) => d.id === "diag-inv-1")).toMatchObject({ category: "output-schema" });
      expect(must(await openV1Reader(session).run("run-t1"), "the run is recorded").run.invocations[0]!.capture.outcome).toBe("failed");
    });
  }

  // WHY CLAIM(T1-terminal): whatever fails in the import after admission, finish records terminal `failed` with an import diagnostic; it does not
  // rethrow and leave the job `importing`, where every status and cancel replied INTERNAL. Rejects a finish without a catch.
  it("an import failure after admission ends the job failed, and status and cancel answer normally", async () => {
    const { session, dir, qex, adapter } = await world();
    const failing = new Proxy(session, { get: (target, property) => {
      if (property === "importBundle") return async () => err("STORAGE_FAILED", "disk is full");
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const service = createJobService({ session: failing, sessionDir: dir, qex: qex.client, adapters: [adapter], catalogueFor: async () => catalogue, cancelWaitMs: 3000 });
    must(await service.collect(request("t1b")), "collect");
    const view = await settle(service, "t1b", ["succeeded", "failed"]);
    expect(view.state).toBe("failed");
    expect(view.collectionStatus).toBe("failed");
    expect(view.diagnosticIds.some((id) => id.startsWith("run-t1b:diag-import")), JSON.stringify(view.diagnosticIds)).toBe(true);
    const diagnostics = JSON.parse(readFileSync(join(dir, "jobs", "t1b", "diagnostics.json"), "utf8"));
    expect(diagnostics.find((d: any) => d.id.startsWith("diag-import")).message).toContain("disk is full");
    expect(must(await service.status("t1b"), "status again")).toMatchObject({ state: "failed" });
    expect(must(await service.cancel("t1b"), "cancel")).toMatchObject({ outcome: "already-terminal", state: "failed" });
  });
});

// ---- T2, T3: cancel writes only inside the lease, and says cancelled only when qex stopped the job because of the cancel -----------------------

/** A qex whose `wait` blocks until released: a status that waits through it holds the job's lease for as long as the test wants. */
function gatedWait(qex: QexClient): { client: QexClient; release: () => void; reached: () => boolean } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reached = false;
  return { client: { ...qex, wait: async (id, ms) => { reached = true; await gate; return qex.wait(id, ms); } }, release, reached: () => reached };
}
const historyOf = (dir: string, id: string): string[] => JSON.parse(readFileSync(join(dir, "jobs", id, "state.json"), "utf8")).history.map((entry: any) => entry.state);

describe("[T2] cancel never writes job state outside the lease", () => {
  // WHY CLAIM(T2-lease): a waiting status holds the lease; cancel's finish then did nothing, cancel read `queued`, answered cancelled and wrote that stale
  // state to state.json outside the lease (it could overwrite a terminal state). Rejects a finish-and-record outside withLease.
  it("answers indeterminate and leaves state.json alone when the lease holder does not finish in time", async () => {
    const { session, dir, qex, adapter } = await world();
    const holderQex = gatedWait(qex.client);
    const catalogueFor = async () => catalogue;
    const holder = createJobService({ session, sessionDir: dir, qex: holderQex.client, adapters: [adapter], catalogueFor, cancelWaitMs: 3000 });
    const canceller = createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter], catalogueFor, cancelWaitMs: 1500 });
    qex.control({ hold: true });
    must(await holder.collect(request("t2")), "collect");
    const following = holder.status("t2", { waitSeconds: 25 });
    await vi.waitFor(() => expect(holderQex.reached(), "the status holds the lease inside qex.wait").toBe(true), { timeout: 15_000, interval: 25 });
    const before = readFileSync(join(dir, "jobs", "t2", "state.json"), "utf8");
    const result = must(await canceller.cancel("t2"), "cancel");
    expect(result.outcome, JSON.stringify(result)).toBe("indeterminate");
    expect(readFileSync(join(dir, "jobs", "t2", "state.json"), "utf8"), "cancel wrote state it did not own").toBe(before);
    holderQex.release();
    const final = must(await following, "the holder finishes the job");
    expect(final).toMatchObject({ state: "cancelled" });
    const states = historyOf(dir, "t2");
    expect(states.indexOf("cancelled"), `terminal state is last: ${states.join(",")}`).toBe(states.length - 1);
  });

  // WHY CLAIM(T2-lease): the other legal answer: cancel waits for the holder's terminal state (as the status of S41 does) and reports it. Rejects an
  // immediate reply with the pre-terminal state.
  it("waits for the lease holder's terminal state and reports it", async () => {
    const { session, dir, qex, adapter } = await world();
    const holderQex = gatedWait(qex.client);
    const catalogueFor = async () => catalogue;
    const holder = createJobService({ session, sessionDir: dir, qex: holderQex.client, adapters: [adapter], catalogueFor, cancelWaitMs: 3000 });
    const canceller = createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter], catalogueFor, cancelWaitMs: 15_000 });
    qex.control({ hold: true });
    must(await holder.collect(request("t2b")), "collect");
    const following = holder.status("t2b", { waitSeconds: 25 });
    await vi.waitFor(() => expect(holderQex.reached()).toBe(true), { timeout: 15_000, interval: 25 });
    const cancelling = canceller.cancel("t2b");
    expect(await within(cancelling, 700), "cancel waits while the holder has not finished").toBe("pending");
    holderQex.release();
    expect(must(await cancelling, "cancel")).toMatchObject({ outcome: "cancelled", state: "cancelled" });
    expect(must(await following, "holder")).toMatchObject({ state: "cancelled" });
    const states = historyOf(dir, "t2b");
    expect(states.indexOf("cancelled"), `terminal state is last: ${states.join(",")}`).toBe(states.length - 1);
  });
});

describe("[T3] cancelled means the cancel stopped the job", () => {
  // WHY CLAIM(T3-cancel-too-late): `cancelRequested || killed && cancelRequested` is `cancelRequested`: a job that completed between cancel's status check and
  // `qex cancel` was labelled cancelled, and cancel said cancelled. Rejects labelling by the request alone.
  it("a job that finished before qex cancel keeps its outcome and cancel replies cancel-too-late", async () => {
    const { session, dir, qex, adapter } = await world();
    let stale = false;
    const client: QexClient = { ...qex.client, status: async (id) => {
      const real = await qex.client.status(id);
      if (stale && real.ok) { stale = false; return ok({ ...real.value, state: "running" as const, exit_code: null }); }
      return real;
    } };
    const service = createJobService({ session, sessionDir: dir, qex: client, adapters: [adapter], catalogueFor: async () => catalogue, cancelWaitMs: 3000 });
    must(await service.collect(request("t3")), "collect");
    await vi.waitFor(() => expect(qex.jobs()[0]?.state).toBe("completed"), { timeout: 15_000, interval: 25 });
    stale = true;
    const result = must(await service.cancel("t3"), "cancel");
    expect(result).toMatchObject({ outcome: "cancel-too-late", state: "succeeded", collectionStatus: "succeeded" });
    expect(must(await service.status("t3"), "status")).toMatchObject({ state: "succeeded", collectionStatus: "succeeded" });
    expect(must(await openV1Reader(session).run("run-t3"), "run").run.collection.status).toBe("succeeded");
  });

  // WHY CLAIM(T3-cancel-too-late): the counterpart: a job the cancel did stop is still cancelled (kill of a running job), so the fix is not "never cancelled".
  it("a running job that qex killed because of the cancel is cancelled", async () => {
    const { dir, qex, service } = await world();
    qex.scenario({ mode: "heartbeat", heartbeatFile: join(dir, "hb3"), readyFile: join(dir, "ready3") });
    must(await service().collect(request("t3b")), "collect");
    await vi.waitFor(() => expect(existsSync(join(dir, "ready3"))).toBe(true), { timeout: 15_000, interval: 25 });
    expect(must(await service().cancel("t3b"), "cancel")).toMatchObject({ outcome: "cancelled", state: "cancelled", collectionStatus: "cancelled" });
  });
});

// ---- T4: collect resolves example ids against the catalogue its own run exports ---------------------------------------------------------------

const tmpDirs = useTempDirs();

/** A session with NO stored catalogue (no owner step has run), a git copy of the watchfile crate as the repository, and a service that reads the stored catalogue. */
async function freshWorld() {
  const { session, dir } = await open();
  const root = tmpDirs("t4root");
  cpSync(join(FIXTURES, "crates/watchfile"), root, { recursive: true });
  makeRepo(root, {});
  const qex = fake();
  const adapter = fakeCargoAdapter({ workspaceRoot: root });
  const service = (extra: { crashAt?: (p: CrashPoint) => void | Promise<void> } = {}): JobService => createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter], cancelWaitMs: 3000, ...extra });
  const stored = (): any => (existsSync(join(dir, "catalogues", "vg", "cargo.json")) ? JSON.parse(readFileSync(join(dir, "catalogues", "vg", "cargo.json"), "utf8")).catalogue : null);
  /** What an agent's edit does to the compiled repository: a source changes and the export now declares `watch.fresh`. */
  const declareFresh = (): void => {
    writeFileSync(join(root, "src", "watch_fresh.rs"), "// the new example, implemented\n");
    const base = catalogue.examples.find((example: any) => example.id === "watch.pending");
    const extra = join(dir, "extra.catalogue.json");
    writeFileSync(extra, JSON.stringify({ examples: [{ ...base, id: "watch.fresh", source: { path: "src/watch_fresh.rs", line: 1 }, selector: { ...base.selector, name: "tests::paneweft_example_watch_fresh" } }] }));
    qex.scenario({ catalogueExtra: extra });
  };
  return { session, dir, root, qex, adapter, service, stored, declareFresh };
}

describe("[T4] a collect needs no owner-only catalogue step", () => {
  // WHY CLAIM(T4-run-exports): collect resolved ids only against the stored catalogue, which only the owner-only `catalogue refresh` builds, so on a fresh
  // repository the first collect answered NOT_FOUND ("no catalogue is stored ... run: paneweft catalogue refresh"). Rejects resolution before the run.
  it("collects on a repository with no stored catalogue, and the catalogue the run exported becomes the stored one", async () => {
    const w = await freshWorld();
    expect(w.stored(), "no owner step has run").toBeNull();
    must(await w.service().collect(request("t4a")), "collect");
    const view = await settle(w.service(), "t4a", ["succeeded", "failed"]);
    expect(view.state, JSON.stringify(view)).toBe("succeeded");
    expect(w.stored().examples.map((example: any) => example.id)).toContain("watch.pending");
    expect(w.qex.executions(), "one catalogue export, then the run").toHaveLength(2);
    expect(must(await openV1Reader(w.session).run("run-t4a"), "run").run.examples.map((example: any) => [example.id, example.outcome])).toEqual([["watch.pending", "passed"]]);
    // the stored catalogue is now proven fresh by its fingerprint: the next collect does not export again
    must(await w.service().collect(request("t4b", { examples: ["watch.cancelled"] })), "second collect");
    await settle(w.service(), "t4b", ["succeeded"]);
    expect(w.qex.executions(), "no second export while the sources are unchanged").toHaveLength(3);
  });

  // WHY CLAIM(T4-run-exports): an agent scaffolds an example and implements it; the stored catalogue (an older export) does not declare it. The run's own
  // export is authoritative for that run: it resolves the id and refreshes the stored catalogue. Rejects NOT_FOUND against the stale stored catalogue.
  it("resolves a new example against the run's own export and refreshes the stored catalogue", async () => {
    const w = await freshWorld();
    must(await w.service().collect(request("t4c")), "collect");
    await settle(w.service(), "t4c", ["succeeded"]);
    expect(w.stored().examples.map((example: any) => example.id)).not.toContain("watch.fresh");
    w.declareFresh();
    must(await w.service().collect(request("t4d", { examples: ["watch.fresh"] })), "collect the new example");
    const view = await settle(w.service(), "t4d", ["succeeded", "failed"]);
    expect(view.state, JSON.stringify(view)).toBe("succeeded");
    expect(w.stored().examples.map((example: any) => example.id), "the export refreshed the stored catalogue").toContain("watch.fresh");
    expect(must(await openV1Reader(w.session).run("run-t4d"), "run").run.examples.map((example: any) => [example.id, example.outcome])).toEqual([["watch.fresh", "passed"]]);
  });

  // WHY CLAIM(T4-run-exports): an id that no export declares is still a refusal that names candidates, and nothing of the run executes: the job ends failed
  // with a registration diagnostic after the export. Rejects a run started with an unresolved selector.
  it("an id the run's export does not declare ends the job failed with candidates and runs nothing", async () => {
    const w = await freshWorld();
    must(await w.service().collect(request("t4e", { examples: ["watch.pendng"] })), "collect is accepted: the catalogue that decides does not exist yet");
    const view = await settle(w.service(), "t4e", ["succeeded", "failed"]);
    expect(view.state).toBe("failed");
    const diagnostics = JSON.parse(readFileSync(join(w.dir, "jobs", "t4e", "diagnostics.json"), "utf8"));
    expect(diagnostics[0]).toMatchObject({ category: "registration" });
    expect(diagnostics[0].message).toContain("watch.pendng");
    expect(diagnostics[0].message).toContain("watch.pending");
    expect(w.qex.executions(), "only the export executed").toHaveLength(1);
    expect(w.stored(), "the export still refreshed the stored catalogue").not.toBeNull();
  });

  // WHY CLAIM(T4-run-exports): a catalogue proven fresh by its fingerprint is the export of the very sources the run would see, so an unknown id is refused
  // at once, without a queue job. Keeps the typo check cheap.
  it("refuses an unknown id at once against a stored catalogue that is fresh", async () => {
    const w = await freshWorld();
    must(await w.service().collect(request("t4f")), "collect");
    await settle(w.service(), "t4f", ["succeeded"]);
    const refused = mustFail(await w.service().collect(request("t4g", { examples: ["watch.pendng"] })), "unknown id");
    expect(refused.code).toBe("NOT_FOUND");
    expect(refused.details).toMatchObject({ candidates: expect.arrayContaining(["watch.pending"]) });
    expect(w.qex.executions()).toHaveLength(2);
  });

  // WHY CLAIM(T4-run-exports): an export that fails (the repository does not compile) ends the job failed, runs no example, and leaves the stored catalogue
  // as it was.
  it("an export that fails ends the job failed and stores nothing", async () => {
    const w = await freshWorld();
    w.qex.scenario({ exportExit: 101 });
    must(await w.service().collect(request("t4h")), "collect");
    const view = await settle(w.service(), "t4h", ["succeeded", "failed"]);
    expect(view.state).toBe("failed");
    expect(view.diagnosticIds.length).toBeGreaterThan(0);
    expect(w.qex.executions()).toHaveLength(1);
    expect(w.stored()).toBeNull();
  });

  // WHY CLAIM(T4-run-exports): cancel in the export stage cancels the job; no example ever starts.
  it("cancel while the export is queued ends the job cancelled and runs no example", async () => {
    const w = await freshWorld();
    w.qex.control({ hold: true });
    must(await w.service().collect(request("t4i")), "collect");
    expect(must(await w.service().cancel("t4i"), "cancel")).toMatchObject({ outcome: "cancelled", state: "cancelled" });
    expect(w.qex.executions()).toHaveLength(0);
  });

  // WHY CLAIM(T4-run-exports): a crash between the export's end and the run's submission is recovered from the files alone, with one export and one run.
  it("recovers from a crash after the run stage was decided", async () => {
    const w = await freshWorld();
    const crashing = w.service({ crashAt: (point) => { if ((point as string) === "export:after-run-stage") throw new Error("crash"); } });
    must(await crashing.collect(request("t4j")), "collect");
    await expect(crashing.status("t4j", { waitSeconds: 20 })).rejects.toThrow("crash");
    const view = await settle(w.service(), "t4j", ["succeeded", "failed"]);
    expect(view.state, JSON.stringify(view)).toBe("succeeded");
    expect(w.qex.executions(), "one export, one run").toHaveLength(2);
    expect(w.qex.jobs()).toHaveLength(2);
  });
});

// ---- T5-T7: a finish belongs to the qex job of the stage on disk, and a cancel is never lost across the export -> run switch --------------------------

/** The qex client of one service whose FIRST `status` answer is held back after qex has answered: the caller keeps what it saw while the test moves the job on. */
function staleStatus(qex: QexClient): { client: QexClient; seen: () => boolean; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let seen = false;
  let used = false;
  return { client: { ...qex, status: async (id) => { const real = await qex.status(id); if (used) return real; used = true; seen = true; await gate; return real; } }, seen: () => seen, release };
}

describe("[T5] a finish belongs to the qex job of the stage on disk", () => {
  // WHY CLAIM(T5-stage-identity): cancel read the export's stopped qex job; a status then finished the export and submitted the run; cancel's finish ran
  // against the RUN stage with the EXPORT's job, found an empty staging directory and ended the job failed while the real run kept going uncancelled.
  // Rejects a finish that never compares its qex job with the job of the stage on disk (state.qexId).
  it("a cancel that saw the export stop cancels the run the status submitted, and never finalizes the run from the export job", async () => {
    const w = await freshWorld();
    must(await w.service().collect(request("t5")), "collect");
    await vi.waitFor(() => expect(w.qex.jobs()[0]?.state).toBe("completed"), { timeout: 15_000, interval: 25 });
    w.qex.control({ hold: true });
    const stale = staleStatus(w.qex.client);
    const canceller = createJobService({ session: w.session, sessionDir: w.dir, qex: stale.client, adapters: [w.adapter], cancelWaitMs: 3000 });
    const cancelling = canceller.cancel("t5");
    await vi.waitFor(() => expect(stale.seen(), "cancel holds the export's stopped job").toBe(true), { timeout: 15_000, interval: 10 });
    const moved = must(await w.service().status("t5"), "status finishes the export and submits the run");
    expect(moved, "the run is submitted and queued").toMatchObject({ state: "queued", qexId: "fq-2" });
    stale.release();
    const result = must(await cancelling, "cancel");
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "cancelled", state: "cancelled", collectionStatus: "cancelled" });
    expect(w.qex.jobs().map((job) => job.state), "the export completed, the run was cancelled by qex").toEqual(["completed", "cancelled"]);
    expect(historyOf(w.dir, "t5"), "the run was never imported from the export job").not.toContain("failed");
    expect(w.qex.executions(), "the run never executed").toHaveLength(1);
    expect(must(await w.service().status("t5"), "status again")).toMatchObject({ state: "cancelled" });
  });

  // WHY CLAIM(T5-cancel-recheck): finishExport read cancel.json only at the start of the finish, so a cancel written after that read still got its run
  // submitted. The re-read under the lease, right before the run is decided, ends the job cancelled. Rejects a finishExport that trusts the early read.
  it("a cancel written after the export finish read cancel.json still ends the job cancelled and submits no run", async () => {
    const w = await freshWorld();
    const lateCancel = w.service({ crashAt: (point) => { if ((point as string) === "export:after-run-stage") writeFileSync(join(w.dir, "jobs", "t5b", "cancel.json"), JSON.stringify({ requested: true, at: new Date().toISOString() })); } });
    must(await lateCancel.collect(request("t5b")), "collect");
    const view = await settle(lateCancel, "t5b", ["succeeded", "failed", "cancelled"]);
    expect(view, JSON.stringify(view)).toMatchObject({ state: "cancelled", collectionStatus: "cancelled" });
    expect(w.qex.executions(), "only the export executed").toHaveLength(1);
    expect(w.qex.jobs()).toHaveLength(1);
  });
});

describe("[T6] a cancel is recorded before a stopped export is decided", () => {
  // WHY CLAIM(T6-cancel-first): cancel found the export already stopped, finished it without writing cancel.json, the finish decided the run, and the next status
  // submitted it; cancel itself answered indeterminate. A stopped export with a requested cancel is a cancelled job.
  it("cancel after the export stopped but before it was processed ends the job cancelled and runs nothing", async () => {
    const w = await freshWorld();
    must(await w.service().collect(request("t6")), "collect");
    await vi.waitFor(() => expect(w.qex.jobs()[0]?.state).toBe("completed"), { timeout: 15_000, interval: 25 });
    const result = must(await w.service().cancel("t6"), "cancel");
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "cancelled", state: "cancelled", collectionStatus: "cancelled" });
    expect(must(await w.service().status("t6", { waitSeconds: 2 }), "status")).toMatchObject({ state: "cancelled" });
    expect(w.qex.executions(), "no run was submitted after the cancel").toHaveLength(1);
    expect(w.qex.jobs()).toHaveLength(1);
  });
});

describe("[T7] a storage error while a finish prepares ends the job failed", () => {
  // WHY CLAIM(T7-prepare-in-try): the `importing` write and the log fetch/write sat outside T1's try, so a storage error there left the job `importing` and
  // made every status throw. Here job.log is a directory, so the log cannot be written. Rejects a catch that covers only the import.
  it("an error writing the log ends the job failed with an import diagnostic", async () => {
    const { dir, service } = await world();
    const jobs = service();
    must(await jobs.collect(request("t7")), "collect");
    mkdirSync(join(dir, "jobs", "t7", "job.log"));
    const view = await settle(jobs, "t7", ["failed", "succeeded"]);
    expect(view.state, JSON.stringify(view)).toBe("failed");
    expect(view.diagnosticIds.some((id) => id.startsWith("run-t7:diag-import"))).toBe(true);
    expect(must(await jobs.cancel("t7"), "cancel")).toMatchObject({ outcome: "already-terminal", state: "failed" });
  });
});
