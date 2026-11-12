// A runner that fails BEFORE it runs anything is reported as what it is (field test F7, F30a). Against the real Vitest 3.2.4 repository: an exception while
// the catalogue export imports the manifest, and an adapter whose executable has vanished. Both used to surface as a registration problem with cargo advice
// (`paneweft::test_adapter!()`), whatever the runner.
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeV1Operation } from "../../src/v1/tools.ts";
import { createJobService } from "../../src/v1/jobs.ts";
import { makeVitest3Repo } from "../helpers/vitest3.ts";
import { fakeCargoAdapter, useFakeQex, useV1Sessions } from "../helpers/v1-world.ts";
import { must } from "../helpers/must.ts";
import { useTempDirs } from "../helpers/tmp.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const fake = useFakeQex();

const vitestAdapter = (root: string, overrides: Record<string, unknown> = {}) => ({ schemaVersion: "paneweft.adapter/1", id: "vitest", kind: "vitest", grammar: "vitest-run/1", repo: "cm", executable: process.execPath, workspaceRoot: root, entry: ".", features: [], supportedVersions: ["3.2"], limits: { timeoutMs: 300_000, logBytes: 1_048_576 }, queue: { wrapper: "qex", cpu: "1", mem: "1GB" }, ...overrides }) as any;

async function failedDiagnostic(adapter: any, repo: string, root: string, session: any, dir: string, qex: ReturnType<typeof fake>) {
  must(await session.registerRepository({ id: repo, root }), "register");
  const jobs = createJobService({ session, sessionDir: dir, qex: qex.client, adapters: [adapter] });
  must(await jobs.collect({ requestId: "rf-1", repo, adapter: adapter.id, examples: ["mapping.renamed"] }), "collect");
  const done = await vi.waitFor(async () => { const s = must(await jobs.status("rf-1", { waitSeconds: 5 }), "status"); expect(["succeeded", "failed"]).toContain(s.state); return s; }, { timeout: 120_000, interval: 250 });
  expect(done.state, JSON.stringify(done)).toBe("failed");
  const explained = JSON.parse((await executeV1Operation({ session, sessionDir: dir, jobs }, "explain_failure", { format: "json", diagnostic: done.diagnosticIds[0] })).body);
  return explained.items[0];
}

describe("[F7] a manifest that cannot be imported", () => {
  // why: F7. `paneweft.views.ts` imports an example module that throws while it is evaluated. The diagnostic said `registration` and told the author to add
  // `paneweft::test_adapter!()` to a TypeScript repository; the real cause was only in the stderr slice. It is a `runner` problem, its message carries the
  // exception, and its next action is about the manifest and the modules it imports.
  // proves: CLAIM(F7-manifest-import)
  it("is a runner failure that names the exception and the manifest, with no cargo advice", async () => {
    const { session, dir } = await open();
    const root = tmp("f7manifest");
    makeVitest3Repo(root);
    appendFileSync(join(root, "tests/mappings.examples.ts"), "\nthrow new Error('example module exploded on import');\n");
    const diagnostic = await failedDiagnostic(vitestAdapter(root), "cm", root, session, dir, fake());
    expect(diagnostic.category).toBe("runner");
    expect(diagnostic.message).toContain("example module exploded on import");
    expect(diagnostic.nextAction).toMatch(/paneweft\.views\.ts/);
    expect(`${diagnostic.message} ${diagnostic.nextAction}`).not.toMatch(/test_adapter|cargo/i);
  }, 300_000);
});

describe("[F7, F30a] a runner that cannot start", () => {
  // why: F30a. An adapter record whose executable is gone (a cargo moved by an upgrade, a node from a collected garbage generation): qex reports the job
  // failed with `error: qex could not start ...` and no exit code. That is "the runner could not start", for either runner, with the path and the owner action.
  // proves: CLAIM(F7-runner-not-started)
  it.each(["vitest", "cargo"] as const)("reports a missing %s executable as a runner failure naming the path", async (kind) => {
    const { session, dir } = await open();
    const root = tmp("f7exe");
    makeVitest3Repo(root);
    const adapter = kind === "vitest" ? vitestAdapter(root, { executable: "/nonexistent/bin/node" }) : fakeCargoAdapter({ executable: "/nonexistent/bin/cargo", repo: "cm", workspaceRoot: root });
    const diagnostic = await failedDiagnostic(adapter, "cm", root, session, dir, fake());
    expect(diagnostic.category).toBe("runner");
    expect(diagnostic.message).toMatch(/could not start/);
    expect(diagnostic.message).toContain(adapter.executable);
    expect(diagnostic.nextAction).toMatch(/paneweft adapter/);
    expect(`${diagnostic.message} ${diagnostic.nextAction}`).not.toMatch(/test_adapter/);
  }, 300_000);
});
void writeFileSync;
