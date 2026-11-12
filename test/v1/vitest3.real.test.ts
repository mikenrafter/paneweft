// The TypeScript half of the agent path on the REAL Vitest 3.2.4 that ContainMarks pins (field test F1, F2). paneweft's own suite runs Vitest 5, so the
// fixtures under fixtures/packages resolve `vitest` 5 and hid both failures. Here the repository's `node_modules` is a real install of 3.2.4
// (test/helpers/vitest3.ts), the SDK is linked as `npm i -D @paneweft/sdk@file:...` links it, and nothing is aliased to paneweft's source.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createJobService } from "../../src/v1/jobs.ts";
import { openV1Reader } from "../../src/v1/read.ts";
import { makeVitest3Repo } from "../helpers/vitest3.ts";
import { REPO_ROOT, useFakeQex, useV1Sessions } from "../helpers/v1-world.ts";
import { must } from "../helpers/must.ts";
import { useTempDirs } from "../helpers/tmp.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const fake = useFakeQex();

interface NestedRun { exitCode: number; output: string; staging: string }

/** `vitest run` of the Vitest 3 repository, with the collector's environment (what the host script runs after the typecheck). */
function runVitest3(root: string): Promise<NestedRun> {
  const staging = mkdtempSync(join(tmpdir(), "paneweft-v3-staging-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && key !== "TEST"));
  const child = spawn(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--root", root], { cwd: root, env: { ...env, PANEWEFT_COLLECT: "1", PANEWEFT_RUN_ID: "run-v3", PANEWEFT_STAGING_DIR: staging, PANEWEFT_ATTEMPT: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (part: Buffer) => void (output += part.toString("utf8")));
  child.stderr.on("data", (part: Buffer) => void (output += part.toString("utf8")));
  return new Promise((resolve) => child.on("close", (code) => resolve({ exitCode: code ?? -1, output, staging })));
}

function vitestAdapter(root: string) {
  return { schemaVersion: "paneweft.adapter/1", id: "vitest", kind: "vitest", grammar: "vitest-run/1", repo: "cm", executable: process.execPath, workspaceRoot: root, entry: ".", features: [], supportedVersions: ["3.2"], limits: { timeoutMs: 300_000, logBytes: 1_048_576 }, queue: { wrapper: "qex", cpu: "1", mem: "1GB" } } as any;
}

describe("[F1] the reporter on Vitest 3", () => {
  // why: F1. `reporters: ['default', '@paneweft/sdk/vitest-reporter']` is loaded by Vitest 3 in its MAIN process, where importing `vitest` throws
  // "Vitest failed to access its internal state"; the reporter entry must not import it. Vitest 3.2's TestModule has no `relativeModuleId`, so the
  // record's file is derived from `moduleId` and the project root: a test record without a file is the field-test defect.
  // proves: CLAIM(F1-reporter-entry) CLAIM(F1-file)
  it("loads in the main process and records every example test with its repository-relative file", async () => {
    const root = tmp("v3repo");
    makeVitest3Repo(root);
    const run = await runVitest3(root);
    expect(run.output, "the reporter must load").not.toContain("Failed to load custom Reporter");
    expect(run.exitCode, run.output.slice(-2000)).toBe(0);
    const report = JSON.parse(readFileSync(join(run.staging, "reporter.json"), "utf8"));
    expect(report.tests.map((test: any) => [test.name, test.file, test.state]).sort()).toEqual([
      ["example:mapping.dead-end.naive-split", "tests/mappings.paneweft.test.ts", "passed"],
      ["example:mapping.renamed", "tests/mappings.paneweft.test.ts", "passed"],
      ["example:mapping.work", "tests/mappings.paneweft.test.ts", "passed"],
      ["example:mapping.zero-check", "tests/mappings.paneweft.test.ts", "passed"],
    ]);
    rmSync(run.staging, { recursive: true, force: true });
  }, 120_000);
});

describe("[F2] the catalogue export on Vitest 3", () => {
  // why: F2. The manifest imports an example module that does `import { expect } from "vitest"` at its top level (spec section 3's own pattern);
  // under Vitest 3 evaluating that import outside a worker throws, so the export crashed and the first collect of every Vitest 3 repository failed.
  // The catalogue export never runs an example, so it must not evaluate the test runner.
  // proves: CLAIM(F2-no-runner-in-export)
  it("exports the catalogue and collects when an example module imports vitest at its top level", async () => {
    const { session, dir } = await open();
    const root = tmp("v3collect");
    makeVitest3Repo(root);
    must(await session.registerRepository({ id: "cm", root }), "register");
    const qex = fake();
    const adapter = vitestAdapter(root);
    const jobs = createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter] });
    must(await jobs.collect({ requestId: "v3-1", repo: "cm", adapter: "vitest", examples: ["mapping.renamed"] }), "collect");
    const done = await vi.waitFor(async () => { const s = must(await jobs.status("v3-1", { waitSeconds: 5 }), "status"); expect(["succeeded", "failed"]).toContain(s.state); return s; }, { timeout: 280_000, interval: 250 });
    expect(done, JSON.stringify(done)).toMatchObject({ state: "succeeded", counts: { selected: 1, passed: 1 } });
    const record = JSON.parse(readFileSync(join(dir, "catalogues", "cm", "vitest.json"), "utf8"));
    expect(record.catalogue.examples.map((example: any) => example.id)).toEqual(["mapping.dead-end.naive-split", "mapping.renamed", "mapping.work", "mapping.zero-check"]);
    const run = must(await openV1Reader(session).run("run-v3-1"), "run");
    expect(run.run.examples.map((example: any) => [example.id, example.outcome]).sort()).toEqual([["mapping.renamed", "passed"], ["mapping.work", "passed"]]);
    expect(existsSync(join(root, "node_modules/vitest/package.json"))).toBe(true);
    expect((JSON.parse(readFileSync(join(root, "node_modules/vitest/package.json"), "utf8")) as { version: string }).version, "the repository runs the pinned Vitest 3").toBe("3.2.4");
    void REPO_ROOT;
  }, 600_000);
});
