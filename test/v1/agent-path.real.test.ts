// The agent path with the REAL SDKs and REAL runners: the stable-libtest cargo adapter against fixtures/crates/watchfile and the
// vitest adapter against fixtures/packages/containmarks-lite. Only the queue is faked (it runs the command). This is the SDK <-> host
// contract end to end: worker artifacts written by the Rust and TypeScript SDKs are the host's only input.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeV1Operation } from "../../src/v1/tools.ts";
import { createJobService, type JobService } from "../../src/v1/jobs.ts";
import { openV1Reader } from "../../src/v1/read.ts";
import { FIXTURES, REPO_ROOT, fakeCargoAdapter, makeRepo, useFakeQex, useV1Sessions, write } from "../helpers/v1-world.ts";
import { must } from "../helpers/must.ts";
import { useTempDirs } from "../helpers/tmp.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const fake = useFakeQex();
const cargoBinary = (): string => { try { return execFileSync("which", ["cargo"], { encoding: "utf8" }).trim(); } catch { return `${process.env.HOME}/.cargo/bin/cargo`; } };

async function cargoWorld() {
  const { session, dir } = await open();
  const root = tmp("real-watchfile");
  cpSync(join(FIXTURES, "crates/watchfile"), root, { recursive: true });
  const manifest = readFileSync(join(root, "Cargo.toml"), "utf8");
  writeFileSync(join(root, "Cargo.toml"), manifest.replace("../../../crates/paneweft", join(REPO_ROOT, "crates/paneweft")));
  // Dependency resolution is fixture preparation. Fingerprint the resolved lock, so the test isolates the deliberate source edit.
  execFileSync(cargoBinary(), ["generate-lockfile", "--manifest-path", join(root, "Cargo.toml"), "--offline"], { cwd: root, stdio: "pipe" });
  makeRepo(root, { ".gitignore": "target/\n" });
  must(await session.registerRepository({ id: "vg", root }), "register");
  const qex = fake();
  qex.env.CARGO_TARGET_DIR = join(REPO_ROOT, "target/fixtures");
  const adapter = fakeCargoAdapter({ executable: cargoBinary(), workspaceRoot: root, limits: { timeoutMs: 900_000, logBytes: 1_048_576 } });
  writeFileSync(join(dir, "adapters.json"), JSON.stringify({ adapters: [adapter] }));
  const jobs: JobService = createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter] });
  const call = async (tool: string, args: Record<string, unknown>) => { const outcome = await executeV1Operation({ session, sessionDir: dir, jobs }, tool, { format: "json", ...args }); return { outcome, payload: JSON.parse(outcome.body) }; };
  const finish = async (id: string) => vi.waitFor(async () => { const s = must(await jobs.status(id, { waitSeconds: 5 }), "status"); expect(["succeeded", "failed", "cancelled"], JSON.stringify(s)).toContain(s.state); return s; }, { timeout: 880_000, interval: 250 });
  return { session, dir, root, jobs, call, finish, qex };
}

describe("[IV22 groundwork] Rust: real cargo, real SDK", () => {
  // why: spec sections 3 and 9. Refreshing the catalogue runs the reserved export tests of the real crate; discovery then lists the real
  // types/views/examples; collecting the composed example runs the generated libtest wrappers and imports the REAL captured values: the
  // views show the real status and events, nothing from `summary` leaks, the nested example has its parent edge, the run is host_collected.
  // proves: CLAIM(IV1) CLAIM(IV3) CLAIM(IV5) CLAIM(IV7) CLAIM(IV8) CLAIM(IV14) CLAIM(IV22-recipe)
  it("discovers, collects and reads real captured values", async () => {
    const w = await cargoWorld();
    must(await w.jobs.refreshCatalogue({ requestId: "cat-1", repo: "vg", adapter: "cargo" }), "refresh");
    expect((await w.finish("cat-1")).state).toBe("succeeded");
    const types = await w.call("list_types", { repo: "vg" });
    expect(types.payload.items.map((t: any) => t.typeId)).toEqual(["vigil::watch::Event", "vigil::watch::WatchFile"]);
    expect((await w.call("list_examples", { repo: "vg", type: "vigil::watch::WatchFile" })).payload.items.map((e: any) => e.id)).toEqual(expect.arrayContaining(["watch.cancelled", "watch.pending", "watch.redelivered"]));

    must(await w.jobs.collect({ requestId: "real-1", repo: "vg", adapter: "cargo", examples: ["watch.redelivered"] }), "collect");
    const done = await w.finish("real-1");
    expect(done).toMatchObject({ state: "succeeded", collectionStatus: "succeeded" });
    const run = must(await openV1Reader(w.session).run("run-real-1"), "run");
    expect(run.origin).toBe("host_collected");
    expect(run.run.examples.map((e) => [e.id, e.outcome, e.verified]).sort()).toEqual([["watch.cancelled", "passed", true], ["watch.pending", "passed", true], ["watch.redelivered", "passed", true]]);
    const parents = Object.fromEntries(run.run.invocations.map((i) => [i.exampleId, run.run.invocations.find((p) => p.id === i.parent)?.exampleId ?? null]));
    expect(parents).toEqual({ "watch.redelivered": null, "watch.cancelled": "watch.redelivered", "watch.pending": "watch.cancelled" });

    const status = await w.call("view_result", { run: "run-real-1", view: "watch.status" });
    expect(status.outcome.ok, status.outcome.body.slice(0, 300)).toBe(true);
    const events = await w.call("view_result", { run: "run-real-1", view: "watch.events" });
    expect(events.payload.items.map((r: any) => r.cells)).toEqual([{ event: "e-1", tick: 3, redelivered: false }, { event: "e-1", tick: 6, redelivered: true }]);
    const stored = readdirSync(join(w.dir, "objects")).map((n) => readFileSync(join(w.dir, "objects", n), "utf8")).join("\n");
    expect(stored, "positive control: captured text is searchable").toContain("e-1");
    expect(stored, "the omitted summary never reaches the session").not.toContain("SECRET LOG LINE");
  }, 900_000);

  // why: spec section 6 repair loop. Seeded failures (a wrong expectation; a plain panic) are collected: the job fails, both examples are
  // reported with distinct outcomes, explain_failure points at tests/seeded.rs, the old snapshot stays readable; after the fix and a
  // recollection the example passes, and the edit made the OLD catalogue stale in between.
  // proves: CLAIM(IV17) CLAIM(IV19) CLAIM(IV18) CLAIM(IV22-recipe)
  it("collects seeded failures, explains them, and repairs", async () => {
    const w = await cargoWorld();
    must(await w.jobs.refreshCatalogue({ requestId: "cat-2", repo: "vg", adapter: "cargo" }), "refresh");
    await w.finish("cat-2");
    must(await w.jobs.collect({ requestId: "seed-1", repo: "vg", adapter: "cargo", examples: ["watch.seeded-failure", "watch.seeded-error"] }), "collect");
    const failed = await w.finish("seed-1");
    expect(failed).toMatchObject({ state: "failed", collectionStatus: "failed" });
    const run = must(await openV1Reader(w.session).run("run-seed-1"), "run");
    expect(Object.fromEntries(run.run.examples.map((e) => [e.id, e.outcome]))).toEqual({ "watch.seeded-failure": "failed", "watch.seeded-error": "error" });
    const diagnostics = await Promise.all(failed.diagnosticIds.map(async (id) => (await w.call("explain_failure", { diagnostic: id })).payload.items[0]));
    const byExample = Object.fromEntries(diagnostics.map((d: any) => [d.exampleId, d]));
    expect(byExample["watch.seeded-failure"]).toMatchObject({ category: "assertion", source: { path: "tests/seeded.rs" } });
    expect(byExample["watch.seeded-error"]).toMatchObject({ category: "runner" });
    write(w.root, "tests/seeded.rs", readFileSync(join(w.root, "tests/seeded.rs"), "utf8").replace("WatchStatus::Cancelled); // wrong on purpose", "WatchStatus::Pending);"));
    expect((await w.call("list_types", { repo: "vg" })).payload.freshness).toMatchObject({ status: "stale", reasons: ["tests/seeded.rs: modified"] });
    must(await w.jobs.collect({ requestId: "seed-2", repo: "vg", adapter: "cargo", examples: ["watch.seeded-failure"] }), "recollect");
    expect(await w.finish("seed-2")).toMatchObject({ state: "succeeded" });
    expect((await w.call("view_result", { run: "run-seed-1", view: "watch.status" })).outcome.ok, "the old snapshot is still readable").toBe(true);
  }, 900_000);
});

describe("[IV22 groundwork] TypeScript: real vitest, real SDK", () => {
  // why: the TS half of the same contract: the host-owned collection script typechecks, runs vitest with the paneweft reporter, and the
  // host imports the three real mapping examples; the stored mapping.details view carries the three fields; the zero-check example is
  // counted exploratory, not verified.
  // proves: CLAIM(IV1) CLAIM(IV6) CLAIM(IV8) CLAIM(IV18) CLAIM(IV22-recipe)
  it("collects mapping examples through typecheck + vitest", async () => {
    const { session, dir } = await open();
    const root = join(FIXTURES, "packages/containmarks-lite");
    must(await session.registerRepository({ id: "cm", root }), "register");
    const qex = fake();
    const adapter = { schemaVersion: "paneweft.adapter/1", id: "vitest", kind: "vitest", grammar: "vitest-run/1", repo: "cm", executable: process.execPath, workspaceRoot: root, entry: ".", features: [], supportedVersions: ["5.1"], limits: { timeoutMs: 300_000, logBytes: 1_048_576 }, queue: { wrapper: "qex", cpu: "1", mem: "1GB" } } as any;
    writeFileSync(join(dir, "adapters.json"), JSON.stringify({ adapters: [adapter] }));
    const jobs = createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter] });
    must(await jobs.refreshCatalogue({ requestId: "cat-ts", repo: "cm", adapter: "vitest" }), "refresh");
    await vi.waitFor(async () => expect(must(await jobs.status("cat-ts", { waitSeconds: 5 }), "status").state).toBe("succeeded"), { timeout: 280_000, interval: 250 });
    must(await jobs.collect({ requestId: "ts-1", repo: "cm", adapter: "vitest", examples: ["mapping.renamed", "mapping.zero-check"] }), "collect");
    const done = await vi.waitFor(async () => { const s = must(await jobs.status("ts-1", { waitSeconds: 5 }), "status"); expect(s.state).toBe("succeeded"); return s; }, { timeout: 280_000, interval: 250 });
    expect(done.counts).toMatchObject({ selected: 2, passed: 2, verified: 1, exploratory: 1 });
    const call = async (tool: string, args: Record<string, unknown>) => JSON.parse((await executeV1Operation({ session, sessionDir: dir, jobs }, tool, { format: "json", ...args })).body);
    const ambiguous = await call("view_result", { run: "run-ts-1", view: "mapping.details" });
    expect(ambiguous.code, "work (nested) and renamed each captured a mapping: the selector is ambiguous").toBe("UNRESOLVED_TARGET");
    const renamed = ambiguous.details.candidates.find((c: any) => c.exampleId === "mapping.renamed");
    const details = await call("view_result", { run: "run-ts-1", view: renamed.view });
    expect(details.items.map((f: any) => [f.path, f.example]).filter(([, e]: any) => e !== undefined)).toEqual(expect.arrayContaining([["$.original index", 4], ["$.container ID", "firefox-container-3"], ["$.backup name", "Research"]]));
  }, 600_000);
});

describe("[T8] TypeScript: a collect on a repository with no stored catalogue", () => {
  // why: T4 made the first collect export the catalogue itself. The vitest adapter takes that path through the host-owned script in `--catalogue` mode and then
  // in run mode; the cargo path had a test, the vitest path none. No `catalogue refresh` is run here.
  // proves: CLAIM(T4-run-exports)
  it("exports the catalogue, resolves the id and collects, with no owner step", async () => {
    const { session, dir } = await open();
    const root = join(FIXTURES, "packages/containmarks-lite");
    must(await session.registerRepository({ id: "cm", root }), "register");
    const qex = fake();
    const adapter = { schemaVersion: "paneweft.adapter/1", id: "vitest", kind: "vitest", grammar: "vitest-run/1", repo: "cm", executable: process.execPath, workspaceRoot: root, entry: ".", features: [], supportedVersions: ["5.1"], limits: { timeoutMs: 300_000, logBytes: 1_048_576 }, queue: { wrapper: "qex", cpu: "1", mem: "1GB" } } as any;
    const jobs = createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter] });
    expect(existsSync(join(dir, "catalogues", "cm", "vitest.json")), "no owner step has run").toBe(false);
    must(await jobs.collect({ requestId: "ts-first", repo: "cm", adapter: "vitest", examples: ["mapping.renamed"] }), "collect");
    const done = await vi.waitFor(async () => { const s = must(await jobs.status("ts-first", { waitSeconds: 5 }), "status"); expect(["succeeded", "failed"]).toContain(s.state); return s; }, { timeout: 280_000, interval: 250 });
    expect(done, JSON.stringify(done)).toMatchObject({ state: "succeeded", counts: { selected: 1, passed: 1 } });
    expect(qex.jobs().map((job) => job.state), "one catalogue export, then the run").toEqual(["completed", "completed"]);
    const record = JSON.parse(readFileSync(join(dir, "catalogues", "cm", "vitest.json"), "utf8"));
    expect(record.catalogue.examples.map((example: any) => example.id), "the export stored the catalogue").toContain("mapping.renamed");
    // mapping.renamed runs mapping.work inside it (the fixture nests them), so the run records both
    const outcomes = must(await openV1Reader(session).run("run-ts-first"), "run").run.examples.map((example: any) => [example.id, example.outcome]);
    expect(outcomes).toContainEqual(["mapping.renamed", "passed"]);
    expect(outcomes.every((pair: unknown[]) => pair[1] === "passed")).toBe(true);
  }, 600_000);
});
