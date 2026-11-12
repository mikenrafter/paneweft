// Vitest integration (IV6, S6): examples run in a REAL nested vitest run of the fixture package, with the collector's environment.
// The worker captures the value inside the test; the reporter finalizes the native outcome after hooks and teardown. Literal
// expectations only: the reporter.json shape is docs/v1-red-contract.md section 7.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../test/helpers/fixtures.ts";

const FIXTURE = join(REPO_ROOT, "fixtures/packages/containmarks-lite");
const created: string[] = [];
afterEach(() => { for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface NestedRun { exitCode: number; stdout: string; staging: string }

function runNested(files: string[]): Promise<NestedRun> {
  const staging = mkdtempSync(join(tmpdir(), "paneweft-vitest-"));
  created.push(staging);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && key !== "TEST"));
  const child = spawn(process.execPath, [join(REPO_ROOT, "node_modules/vitest/vitest.mjs"), "run", "--root", FIXTURE, "--config", join(FIXTURE, "vitest.config.ts"), ...files], {
    cwd: FIXTURE,
    env: { ...env, PANEWEFT_COLLECT: "1", PANEWEFT_RUN_ID: "run-nested", PANEWEFT_STAGING_DIR: staging, PANEWEFT_ATTEMPT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (part: Buffer) => void (stdout += part.toString("utf8")));
  child.stderr.on("data", (part: Buffer) => void (stdout += part.toString("utf8")));
  return new Promise((resolve) => child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, staging })));
}

const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const invocations = (staging: string): any[] => (existsSync(join(staging, "invocations")) ? readdirSync(join(staging, "invocations")).filter((n) => !n.endsWith(".started.json")).map((n) => readJson(join(staging, "invocations", n))) : []);

describe("[IV6] a real vitest worker", () => {
  // why: IV6. The worker captures each returned object and writes completion records; the nested composition has a parent edge; the
  // reporter reconciles the final native result of every test. Five invocations: work, renamed (+ its nested work), zero-check, dead end.
  // proves: CLAIM(IV6) CLAIM(IV7) CLAIM(IV8)
  it("captures returned objects in the worker and reconciles final outcomes in the reporter", async () => {
    const run = await runNested(["tests/mappings.paneweft.test.ts"]);
    expect(run.exitCode, run.stdout).toBe(0);
    const records = invocations(run.staging);
    expect(records.map((r) => r.exampleId).sort()).toEqual(["mapping.dead-end.naive-split", "mapping.renamed", "mapping.work", "mapping.work", "mapping.zero-check"]);
    const renamed = records.find((r) => r.exampleId === "mapping.renamed");
    const nested = records.filter((r) => r.exampleId === "mapping.work").find((r) => r.parent === renamed.id);
    expect(nested, "the nested use of mapping.work has renamed as parent").toBeDefined();
    expect(records.find((r) => r.exampleId === "mapping.zero-check")).toMatchObject({ native: { outcome: "passed" }, verified: false });
    expect(records.find((r) => r.exampleId === "mapping.dead-end.naive-split")).toMatchObject({ native: { outcome: "passed" }, expectedFailure: { matched: true } });
    for (const record of records) {
      const graph = readJson(join(run.staging, "captures", `${record.capture.captureId}.json`));
      expect(graph.runId, "the capture carries the collector's run id").toBe("run-nested");
      expect(graph.objects[0].typeId).toBe("containmarks::ContainerMappingRecord");
    }
    const report = readJson(join(run.staging, "reporter.json"));
    expect(report.schemaVersion).toBe("paneweft.vitest-report/1");
    expect(report.runId).toBe("run-nested");
    expect(report.tests.map((t: any) => [t.name, t.state]).sort()).toEqual([["example:mapping.dead-end.naive-split", "passed"], ["example:mapping.renamed", "passed"], ["example:mapping.work", "passed"], ["example:mapping.zero-check", "passed"]]);
    expect(report.suites).toEqual([]);
  }, 120_000);

  // why: S6 (suite outcome). A test body returns a useful object, THEN afterAll throws: the invocation record stays `passed` (the
  // example's own result is unchanged), the reporter records a failed teardown suite that names the example, the run exits nonzero.
  // proves: CLAIM(S6-outcomes) CLAIM(IV6)
  it("a teardown failure is a suite outcome attached to the example, not a changed example result", async () => {
    const run = await runNested(["tests/teardown-failure.paneweft.test.ts"]);
    expect(run.exitCode, "a failed afterAll must fail the run").not.toBe(0);
    const records = invocations(run.staging);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ exampleId: "mapping.work", native: { outcome: "passed" } });
    const report = readJson(join(run.staging, "reporter.json"));
    expect(report.suites).toEqual([{ file: "tests/teardown-failure.paneweft.test.ts", phase: "teardown", outcome: "failed", message: "teardown exploded", examples: ["mapping.work"] }]);
    expect(report.tests.map((t: any) => [t.name, t.state])).toEqual([["example:mapping.work", "passed"]]);
  }, 120_000);

  // why: S6/IV5. A failed recorded check fails the vitest test (the error is rethrown), the invocation is `failed` with the claim
  // recorded as failed, and the capture still happened (the returned object is retained as diagnostic evidence).
  // proves: CLAIM(S6-outcomes) CLAIM(IV5)
  it("a failed check fails the test and is recorded as failed", async () => {
    const run = await runNested(["tests/failing-check.paneweft.test.ts"]);
    expect(run.exitCode).not.toBe(0);
    const [record] = invocations(run.staging);
    expect(record).toMatchObject({ exampleId: "mapping.seeded-failure", native: { outcome: "failed" }, checks: [{ claim: "CM-SEED", passed: false }], verified: false });
    expect(record.capture.outcome).toBe("captured");
    const report = readJson(join(run.staging, "reporter.json"));
    expect(report.tests.map((t: any) => [t.name, t.state])).toEqual([["example:mapping.seeded-failure", "failed"]]);
  }, 120_000);
});
