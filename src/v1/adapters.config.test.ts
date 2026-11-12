// The vitest adapter names the repository's compiler and runner configuration (field test F5). `tsconfig.json` and `vitest.config.ts` were hard-coded, the
// whole repository was typechecked, and a pre-existing type error in code the instrumentation never imports (`scripts/capture-readme-assets.ts`) blocked every collect;
// the repository's own vitest config had to list the paneweft reporter. Both are fields of the adapter record, validated and relative to its root.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildProcess, registerAdapter, type AdapterRecord } from "./adapters.ts";
import { createJobService } from "./jobs.ts";
import { makeVitest3Repo } from "../../test/helpers/vitest3.ts";
import { must, mustFail } from "../../test/helpers/must.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { fakeCargoAdapter, useFakeQex, useV1Sessions } from "../../test/helpers/v1-world.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const fake = useFakeQex();

function vitestRecord(root: string, extra: Record<string, unknown> = {}): AdapterRecord {
  return { schemaVersion: "paneweft.adapter/1", id: "vitest", kind: "vitest", grammar: "vitest-run/1", repo: "cm", executable: process.execPath, workspaceRoot: root, entry: ".", features: [], supportedVersions: ["3.2"], limits: { timeoutMs: 600_000, logBytes: 65_536 }, queue: { wrapper: "qex", cpu: "1", mem: "1GB", tags: ["paneweft"] }, ...extra } as AdapterRecord;
}
const RUNTIME = { runId: "run-x", stagingDir: "/tmp/staging-x", attempt: 1 };
const SELECTION = { examples: [{ id: "mapping.work", selector: { runner: "vitest" as const, name: "example:mapping.work" } }], views: [] };

describe("[F5] the adapter record names its tsconfig and vitest config", () => {
  // why: F5. The two files were literals in the argv. A record that names them passes them through; one that does not keeps the old defaults.
  // proves: CLAIM(F5-adapter-config)
  it("uses the named files in the argv and the defaults otherwise", () => {
    const named = must(buildProcess(vitestRecord("/work/cm", { tsconfig: "tsconfig.paneweft.json", vitestConfig: "vitest.paneweft.config.ts" }), SELECTION as never, "run", RUNTIME), "named").argv;
    expect(named.slice(named.indexOf("--tsconfig"), named.indexOf("--tsconfig") + 2)).toEqual(["--tsconfig", "tsconfig.paneweft.json"]);
    expect(named.slice(named.indexOf("--config"), named.indexOf("--config") + 2)).toEqual(["--config", "vitest.paneweft.config.ts"]);
    const plain = must(buildProcess(vitestRecord("/work/cm"), SELECTION as never, "run", RUNTIME), "plain").argv;
    expect(plain.slice(plain.indexOf("--tsconfig"), plain.indexOf("--tsconfig") + 2)).toEqual(["--tsconfig", "tsconfig.json"]);
    expect(plain.slice(plain.indexOf("--config"), plain.indexOf("--config") + 2)).toEqual(["--config", "vitest.config.ts"]);
  });

  // why: F5. The names are the owner's, but they are paths the host reads: relative to the adapter root, inside it, existing files, and only for a vitest adapter.
  // proves: CLAIM(F5-adapter-config-validated)
  describe("registration validates them", () => {
    const setup = async () => {
      const root = tmp("f5-root");
      mkdirSync(join(root, "config"), { recursive: true });
      writeFileSync(join(root, "tsconfig.paneweft.json"), "{}");
      writeFileSync(join(root, "config/vitest.paneweft.ts"), "export default {};");
      const { dir } = await open();
      return { root, dir };
    };

    it("accepts files that exist under the adapter root, in subdirectories too", async () => {
      const { root, dir } = await setup();
      const registered = must(await registerAdapter(dir, vitestRecord(root, { tsconfig: "tsconfig.paneweft.json", vitestConfig: "config/vitest.paneweft.ts" })), "register");
      expect(registered).toMatchObject({ tsconfig: "tsconfig.paneweft.json", vitestConfig: "config/vitest.paneweft.ts" });
    });

    it.each([
      ["an absolute path", { tsconfig: "/etc/passwd" }, "/tsconfig"],
      ["a path that leaves the root", { tsconfig: "../outside.json" }, "/tsconfig"],
      ["a path that leaves the root through a subdirectory", { vitestConfig: "config/../../outside.ts" }, "/vitestConfig"],
      ["a file that does not exist", { tsconfig: "tsconfig.missing.json" }, "/tsconfig"],
      ["a directory", { vitestConfig: "config" }, "/vitestConfig"],
    ])("refuses %s", async (_name, extra, pointer) => {
      const { root, dir } = await setup();
      const refused = mustFail(await registerAdapter(dir, vitestRecord(root, extra)), "refused");
      expect(JSON.stringify(refused.errors.map((issue) => issue.pointer)), refused.message).toContain(pointer);
    });

    it("refuses them on a cargo adapter", async () => {
      const { root, dir } = await setup();
      const refused = mustFail(await registerAdapter(dir, { ...fakeCargoAdapter({ workspaceRoot: root }), tsconfig: "tsconfig.paneweft.json" }), "cargo");
      expect(JSON.stringify(refused.errors.map((issue) => issue.pointer))).toContain("/tsconfig");
    });
  });
});

describe("[F5] collecting on a repository whose own typecheck fails elsewhere (real Vitest 3.2.4)", () => {
  /** The ContainMarks situation: a script no example imports has a type error and is covered by the repository's tsconfig; the repository's vitest config is its own. */
  function brokenRepo(): string {
    const root = tmp("f5-repo");
    makeVitest3Repo(root);
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts/capture-readme-assets.ts"), 'export const broken: number = "not a number";\n');
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", types: [], strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, verbatimModuleSyntax: true }, include: ["src", "tests", "scripts", "paneweft.views.ts", "vitest.config.ts"] }));
    writeFileSync(join(root, "tsconfig.paneweft.json"), JSON.stringify({ extends: "./tsconfig.json", include: ["src", "tests", "paneweft.views.ts"] }));
    // the repository's own config does not know paneweft; the instrumentation's does
    writeFileSync(join(root, "vitest.config.ts"), 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });\n');
    writeFileSync(join(root, "vitest.paneweft.config.ts"), 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["tests/**/*.test.ts"], reporters: ["default", "@paneweft/sdk/vitest-reporter"] } });\n');
    return root;
  }
  async function collect(root: string, extra: Record<string, unknown>, id: string) {
    const { session, dir } = await open();
    must(await session.registerRepository({ id: "cm", root }), "register");
    const jobs = createJobService({ session, sessionDir: dir, qex: fake().client, adapters: [vitestRecord(root, extra)] });
    must(await jobs.collect({ requestId: id, repo: "cm", adapter: "vitest", examples: ["mapping.renamed"] }), "collect");
    return vi.waitFor(async () => { const s = must(await jobs.status(id, { waitSeconds: 5 }), "status"); expect(["succeeded", "failed"]).toContain(s.state); return s; }, { timeout: 280_000, interval: 250 });
  }

  // why: F5 control. With the defaults the unrelated error blocks the collect, as in the field test (`TS2322` at scripts/capture-readme-assets.ts), and the job gets no further.
  // proves: CLAIM(F5-adapter-config)
  it("fails on the unrelated type error when the adapter names nothing", async () => {
    const done = await collect(brokenRepo(), {}, "f5-a");
    expect(done.state).toBe("failed");
    expect(JSON.stringify(done.diagnosticIds)).toContain("diag-compile-1");
  }, 600_000);

  // why: F5. The adapter's own tsconfig (extending the repository's, listing only what the instrumentation touches) and its own vitest config: the collect succeeds, the example runs.
  // proves: CLAIM(F5-adapter-config)
  it("succeeds with an adapter tsconfig and vitest config that scope the work", async () => {
    const done = await collect(brokenRepo(), { tsconfig: "tsconfig.paneweft.json", vitestConfig: "vitest.paneweft.config.ts" }, "f5-b");
    expect(done, JSON.stringify(done)).toMatchObject({ state: "succeeded", counts: { selected: 1, passed: 1 } });
  }, 600_000);
});
