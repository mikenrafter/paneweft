// The collection job lifecycle through qex (S2, S3, N1, N2; IV17): two-phase submission, request dedupe, crash points, recovery,
// cancellation in every state, descendants stopping, import after a failing run. A FAKE qex (fixtures/v1/bin/qex) is on PATH and the
// registered adapter's executable is a fake cargo, so everything is deterministic and executions are countable.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FIXTURES, fakeCargoAdapter, loadFixture, useFakeQex, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { buildQexSubmitArgv, createJobService, type CrashPoint, type JobService } from "./jobs.ts";
import { openV1Reader } from "./read.ts";

const open = useV1Sessions();
const fake = useFakeQex();
const catalogue = loadFixture<any>("v1/catalogues/watchfile.catalogue.json");

async function world(options: { crashAt?: (p: CrashPoint) => void | Promise<void>; cancelWaitMs?: number } = {}) {
  const { session, dir } = await open();
  const qex = fake();
  const adapter = fakeCargoAdapter();
  const service = (extra: { crashAt?: (p: CrashPoint) => void | Promise<void> } = {}): JobService => createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter], catalogueFor: async () => catalogue, cancelWaitMs: options.cancelWaitMs ?? 3000, ...(extra.crashAt ? { crashAt: extra.crashAt } : options.crashAt ? { crashAt: options.crashAt } : {}) });
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
    must(await service().collect(request("job-a")), "collect");
    const submit = qex.calls().find((c) => c[0] === "submit")!;
    const jobDir = join(dir, "jobs", "job-a");
    expect(submit.slice(0, submit.indexOf("--"))).toEqual(["submit", "--dedupe-key", `paneweft:${JSON.parse(readFileSync(join(dir, "collection-session.json"), "utf8")).id}:job-a`, "--dedupe-window", "24h", "--id-file", join(jobDir, "qex.id"), "--cwd", adapter.workspaceRoot, "--name", "paneweft-job-a", "--cpu", "1", "--mem", "1GB", "--tag", "paneweft", "--timeout", "60s", "--env", "CARGO_TERM_COLOR=never", "--env", "PANEWEFT_ATTEMPT=1", "--env", "PANEWEFT_COLLECT=1", "--env", "PANEWEFT_RUN_ID=run-job-a", "--env", `PANEWEFT_STAGING_DIR=${join(jobDir, "staging", "run-job-a")}`]);
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
