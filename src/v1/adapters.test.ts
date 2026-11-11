// Registered collection adapters (IV16, IV17, IV18; amendments S6, N4): selection safety, literal argv, the outcome model for BOTH
// adapters against literal fixtures, and instrumentation checks. No test here spawns a shell.
import { cpSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, REPO_ROOT, loadFixture } from "../../test/helpers/v1-world.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { VITEST_COLLECT_SCRIPT, buildProcess, checkInstrumentation, loadAdapters, reconcile, registerAdapter, selectExamples, type AdapterRecord } from "./adapters.ts";
import { validateAgainstV1 } from "./schemas.ts";

const tmp = useTempDirs();
const watchCatalogue = loadFixture<any>("v1/catalogues/watchfile.catalogue.json");
const cmCatalogue = loadFixture<any>("v1/catalogues/containmarks.catalogue.json");
const cargo: AdapterRecord = { schemaVersion: "paneweft.adapter/1", id: "cargo", kind: "cargo", grammar: "cargo-test/1", repo: "vg", executable: "/usr/bin/cargo", workspaceRoot: "/work/vigil", entry: ".", features: ["paneweft"], supportedVersions: ["1.97"], limits: { timeoutMs: 60000, logBytes: 65536 }, queue: { wrapper: "qex", cpu: "1", mem: "1GB" } };
const vitest: AdapterRecord = { schemaVersion: "paneweft.adapter/1", id: "vitest", kind: "vitest", grammar: "vitest-run/1", repo: "cm", executable: "/usr/bin/node", workspaceRoot: "/work/cm", entry: ".", features: [], supportedVersions: ["5.1"], limits: { timeoutMs: 60000, logBytes: 65536 }, queue: { wrapper: "qex", cpu: "1", mem: "1GB" } };
const runtime = { runId: "run-x", stagingDir: "/stage", attempt: 1 };

describe("[IV16] selection safety", () => {
  // why: IV16. A request selects declared examples by exact id; the result carries each example's selector from the catalogue (data).
  // proves: CLAIM(IV16)
  it("resolves exact ids to catalogue selectors", () => {
    const selection = must(selectExamples(cargo, watchCatalogue, { examples: ["watch.pending", "watch.cancelled"] }), "select");
    expect(selection.examples.map((e) => e.id)).toEqual(["watch.cancelled", "watch.pending"]);
    expect(selection.examples[0]!.selector).toEqual({ runner: "cargo", name: "tests::paneweft_example_watch_cancelled", package: "watchfile", target: "lib" });
  });

  // why: IV16. Argv-shaped, shell-shaped, path-shaped, over-long, empty and uppercase ids all fail BEFORE anything runs. The list is
  // pinned by hand; each is also checked to have a safe sibling that passes (positive control above).
  // proves: CLAIM(IV16)
  it.each(["--exact", "watch.pending --nocapture", "watch.pending; rm -rf /", "$(id)", "`id`", "../../etc/passwd", "watch.pending\n--include-ignored", "WATCH.PENDING", "", "a".repeat(129), "watch pending", "watch.pending|cat"])("refuses the example id %j", (id) => {
    const error = mustFail(selectExamples(cargo, watchCatalogue, { examples: [id] }), "injection");
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.errors[0]!.pointer).toBe("/examples/0");
  });

  // why: IV16. An id that is well formed but not in the catalogue lists candidates (a near miss is a typo, not an attack) and runs nothing.
  // proves: CLAIM(IV16) CLAIM(IV14)
  it("an unknown id lists candidates", () => {
    const error = mustFail(selectExamples(cargo, watchCatalogue, { examples: ["watch.pendng"] }), "unknown");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.details).toMatchObject({ candidates: expect.arrayContaining(["watch.pending"]) });
  });

  // why: IV16. A payload cannot install a runner or change the root: these members are refused by name with FORBIDDEN_PROPERTY.
  // proves: CLAIM(IV16)
  it.each(["executable", "argv", "runner", "workspaceRoot", "cwd", "env", "shell", "command"])("refuses the request member %s", (member) => {
    const error = mustFail(selectExamples(cargo, watchCatalogue, { examples: ["watch.pending"], [member]: "/bin/sh" }), "forbidden member");
    expect(error.errors.map((e) => [e.code, e.pointer])).toContainEqual(["FORBIDDEN_PROPERTY", `/${member}`]);
  });

  // why: IV16. Examples of different targets cannot share one process in week one: the refusal says to collect each target separately.
  // proves: CLAIM(IV16)
  it("refuses examples that span targets", () => {
    const catalogue = structuredClone(watchCatalogue);
    catalogue.examples[0].selector.target = "it";
    const error = mustFail(selectExamples(cargo, catalogue, { examples: ["watch.pending", "watch.cancelled"] }), "span targets");
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.message).toContain("each target");
  });

  // why: IV16. Adapter records are validated at registration: relative executables, an entry that escapes the root, a bad id and
  // unknown members are refused, and a good record is stored and read back (CLI-only path).
  // proves: CLAIM(IV16)
  it("registration refuses unsafe records and round-trips a good one", async () => {
    const dir = tmp("adapters");
    for (const [label, record] of [["relative executable", { ...cargo, executable: "cargo" }], ["escaping entry", { ...cargo, entry: "../elsewhere" }], ["bad id", { ...cargo, id: "Cargo; ls" }], ["unknown member", { ...cargo, shell: "bash" }]] as const) {
      const error = mustFail(await registerAdapter(dir, record), label);
      expect(["INVALID_ARGUMENT", "VALIDATION_FAILED"], label).toContain(error.code);
    }
    must(await registerAdapter(dir, cargo), "register");
    expect(must(await loadAdapters(dir), "load")).toEqual([cargo]);
  });
});

describe("[IV16] argv grammars", () => {
  // why: IV16. cargo-test/1 is literal and exact (no shell, elements are data): one --exact per example, one test thread, the
  // collector's identity in the environment. Written out by hand from docs/v1-red-contract.md section 9.
  // proves: CLAIM(IV16) CLAIM(IV17)
  it("cargo run mode", () => {
    const selection = must(selectExamples(cargo, watchCatalogue, { examples: ["watch.cancelled", "watch.pending"] }), "select");
    expect(must(buildProcess(cargo, selection, "run", runtime), "build")).toEqual({
      executable: "/usr/bin/cargo",
      argv: ["test", "--manifest-path", "/work/vigil/Cargo.toml", "--features", "paneweft", "--lib", "--", "--exact", "tests::paneweft_example_watch_cancelled", "--exact", "tests::paneweft_example_watch_pending", "--test-threads=1"],
      cwd: "/work/vigil",
      env: { CARGO_TERM_COLOR: "never", PANEWEFT_ATTEMPT: "1", PANEWEFT_COLLECT: "1", PANEWEFT_RUN_ID: "run-x", PANEWEFT_STAGING_DIR: "/stage" },
    });
  });

  // why: spec section 2: catalogue mode runs ONLY the reserved export tests (a substring filter, no --exact) and does not execute example bodies.
  // proves: CLAIM(IV3) CLAIM(IV14)
  it("cargo catalogue mode", () => {
    const process = must(buildProcess(cargo, { examples: [], views: [] }, "catalogue", runtime), "build");
    expect(process.argv).toEqual(["test", "--manifest-path", "/work/vigil/Cargo.toml", "--features", "paneweft", "--lib", "--tests", "--", "paneweft_catalogue_export", "--test-threads=1"]);
    expect(process.env).toEqual({ CARGO_TERM_COLOR: "never", PANEWEFT_ATTEMPT: "1", PANEWEFT_CATALOGUE: "1", PANEWEFT_COLLECT: "1", PANEWEFT_RUN_ID: "run-x", PANEWEFT_STAGING_DIR: "/stage" });
  });

  // why: IV16/IV18. vitest-run/1 goes through the HOST-owned script that typechecks first and runs vitest second as one queue job; the
  // name pattern is an anchored, regex-escaped alternation of exact example titles (a dot in an id must not match any character).
  // proves: CLAIM(IV16) CLAIM(IV18)
  it("vitest run mode", () => {
    const selection = must(selectExamples(vitest, cmCatalogue, { examples: ["mapping.work", "mapping.renamed"] }), "select");
    expect(must(buildProcess(vitest, selection, "run", runtime), "build")).toEqual({
      executable: "/usr/bin/node",
      argv: [VITEST_COLLECT_SCRIPT, "--staging", "/stage", "--root", "/work/cm", "--tsconfig", "tsconfig.json", "--vitest", "/work/cm/node_modules/vitest/vitest.mjs", "--config", "vitest.config.ts", "--name-pattern", "^example:mapping\\.renamed$|^example:mapping\\.work$"],
      cwd: "/work/cm",
      env: { PANEWEFT_ATTEMPT: "1", PANEWEFT_COLLECT: "1", PANEWEFT_RUN_ID: "run-x", PANEWEFT_STAGING_DIR: "/stage" },
    });
  });

  // why: the vitest collection script is shipped by paneweft, not by the repository under test, and must exist.
  // proves: CLAIM(IV16)
  it("the collection script is host owned", () => {
    expect(VITEST_COLLECT_SCRIPT.startsWith(REPO_ROOT)).toBe(true);
    expect(() => readFileSync(VITEST_COLLECT_SCRIPT, "utf8")).not.toThrow();
  });
});

describe("[S6] outcome model, literal fixtures for both adapters", () => {
  const summarize = (run: any) => ({
    collection: { status: run.collection.status, complete: run.collection.complete, missingInvocations: run.collection.missingInvocations, compile: run.collection.compile },
    counts: run.collection.counts,
    examples: Object.fromEntries(run.examples.map((e: any) => [e.id, { outcome: e.outcome, verified: e.verified, attempts: e.attempts.length, priorFailures: e.priorFailures.length, suiteFailedAfter: e.suiteFailedAfter }])),
    suites: run.suites.map((s: any) => ({ phase: s.phase, outcome: s.outcome, examples: s.examples })),
  });

  for (const kind of ["cargo", "vitest"] as const) {
    const scenarios = loadFixture<any>(`v1/outcomes/${kind}.scenarios.json`).scenarios as any[];
    for (const scenario of scenarios) {
      // why: S6. Each scenario's expected summary was written by hand from the amendment; both adapters must agree on the shared ones.
      // proves: CLAIM(S6-outcomes) CLAIM(IV17) CLAIM(IV6) CLAIM(N4-expected-failure)
      it(`${kind}: ${scenario.scenario}`, () => {
        const run = must(reconcile(kind, scenario.input), scenario.scenario);
        expect(summarize(run), scenario.why).toEqual(scenario.expected);
        expect(validateAgainstV1("urn:paneweft:schema:v1:test-run:1", run), "the reconciled run satisfies the schema").toEqual([]);
        expect((run as any).meta, "origin is host metadata stamped at import, never produced here").toBeUndefined();
      });
    }
  }

  // why: S6 "Rust Result::Err and panics are failures": the error text from the worker artifact survives into the example record.
  // proves: CLAIM(S6-outcomes)
  it("keeps the failure message of an error", () => {
    const scenario = loadFixture<any>("v1/outcomes/cargo.scenarios.json").scenarios.find((s: any) => s.scenario === "panic-or-err-is-error");
    const run = must(reconcile("cargo", scenario.input), "reconcile") as any;
    expect(run.invocations[0].native).toEqual({ outcome: "error", message: "boom" });
  });
});

describe("[IV18] instrumentation compile and typecheck", () => {
  // why: IV18 (Rust). A renamed field in the domain struct makes the instrumentation fail to compile; the diagnostic is category
  // `compiler` and points at the VIEW's line in the author's file. A copy of the watchfile fixture is mutated in a temp dir.
  // proves: CLAIM(IV18)
  it("a renamed Rust field is a compiler diagnostic in the view file", async () => {
    const dir = tmp("renamed-rust");
    cpSync(join(FIXTURES, "crates/watchfile"), dir, { recursive: true });
    const manifest = readFileSync(join(dir, "Cargo.toml"), "utf8");
    writeFileSync(join(dir, "Cargo.toml"), manifest.replace("../../../crates/paneweft", join(REPO_ROOT, "crates/paneweft")));
    const source = readFileSync(join(dir, "src/lib.rs"), "utf8");
    writeFileSync(join(dir, "src/lib.rs"), source.replace("pub tick: u64,", "pub tick_count: u64,"));
    const adapter: AdapterRecord = { ...cargo, workspaceRoot: dir, executable: "/home/user/.cargo/bin/cargo" };
    const report = must(await checkInstrumentation(adapter), "check");
    expect(report.ok).toBe(false);
    const diagnostic = report.diagnostics.find((d) => d.category === "compiler");
    expect(diagnostic, JSON.stringify(report)).toBeDefined();
    expect(diagnostic!.source?.path).toBe("src/lib.rs");
    expect(diagnostic!.message).toContain("tick");
  }, 180_000);

  // why: IV18 (TS). A renamed record property fails `tsc --noEmit` against the instrumentation configuration BEFORE vitest runs
  // (vitest's own transform does not typecheck); the diagnostic is category `typecheck` with file, line and TS code.
  // proves: CLAIM(IV18)
  it("a renamed TypeScript property is a typecheck diagnostic in the view file", async () => {
    const dir = tmp("renamed-ts");
    cpSync(join(FIXTURES, "packages/containmarks-lite"), dir, { recursive: true, filter: (source) => !source.includes("node_modules") });
    const tsconfig = readFileSync(join(dir, "tsconfig.json"), "utf8");
    writeFileSync(join(dir, "tsconfig.json"), tsconfig.replaceAll("../../../tsconfig.json", join(REPO_ROOT, "tsconfig.json")).replaceAll("../../../packages", join(REPO_ROOT, "packages")));
    symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
    const models = readFileSync(join(dir, "src/models.ts"), "utf8");
    writeFileSync(join(dir, "src/models.ts"), models.replace("firstSeenIndex", "firstSeenPosition"));
    const adapter: AdapterRecord = { ...vitest, workspaceRoot: dir, executable: process.execPath };
    const report = must(await checkInstrumentation(adapter), "check");
    expect(report.ok).toBe(false);
    const diagnostic = report.diagnostics.find((d) => d.category === "typecheck");
    expect(diagnostic, JSON.stringify(report)).toBeDefined();
    expect(diagnostic!.source?.path).toBe("src/mappings/containerMappings.paneweft.ts");
    expect(diagnostic!.message).toContain("TS2339");
  }, 180_000);
});
