// F12: the scaffolds apply as given. The field test applied `scaffold_view` to vigil (a second `mod tests` in a file that has one: E0428; no Cargo
// feature; `assert!(false)` with no way to build the view) and to ContainMarks (identifiers cut mid-word; no manifest, no reporter, no SDK install;
// `matched=0 returned=0` on a reply that returns a patch). Here the reply is APPLIED to a copy of a repository that has none of the wiring, the
// commands it names are RUN, and the output test is run red with real cargo and a real Vitest, then made green by implementing the view.
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, REPO_ROOT, fakeCargoAdapter, loadFixture, useV1Sessions } from "../../test/helpers/v1-world.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { executeV1Operation, type V1Context } from "./tools.ts";
import { wordSlug, wordTitle } from "./scaffold-facts.ts";

const open = useV1Sessions();
const tmp = useTempDirs();
const watchfile = loadFixture<any>("v1/catalogues/watchfile.catalogue.json");
const containmarks = loadFixture<any>("v1/catalogues/containmarks.catalogue.json");
const record = (repo: string, adapter: string, catalogue: unknown) => JSON.stringify({ schemaVersion: "paneweft.catalogue-record/1", repo, adapter, catalogue, fingerprint: { digest: "0".repeat(64), members: [], declaredExtras: [], exclusions: [] }, collectedAt: "2026-11-11T12:00:00Z" });

interface Reply { patches: Array<{ path: string; text: string }>; outputTest: { path: string; text: string }; registration: string; setup: Array<{ step: string; command?: string }> }

describe("[F12] identifiers and titles are cut at word boundaries", () => {
  // why: F12. The field test's scaffold for ContainMarks produced the id `containermappingrecord.which_original_index_and_container_does_` and the title
  // `...does this mapping preserv`: a slice at 40 and 60 characters. A cut word is a wrong name that is then committed.
  // proves: CLAIM(F12-words)
  it("keeps whole words, never ends on a separator and never starts with a digit", () => {
    const question = "Which original index and container does this mapping preserve?";
    const slug = wordSlug(question, 48);
    expect(slug).toBe("which_original_index_and_container_does_this");
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(wordSlug("Which?", 48)).toBe("which");
    expect(wordSlug("???", 48)).toBe("view");
    expect(wordSlug("2 fast 2 furious", 48)).toBe("view_2_fast_2_furious");
    expect(wordSlug("a".repeat(70), 48), "a single word longer than the limit is dropped, not cut").toBe("view");
    expect(wordTitle(question, 80)).toBe("Which original index and container does this mapping preserve");
    expect(wordTitle("Which events survive a cancel, and which of them were delivered twice before the save failed?", 60)).toBe("Which events survive a cancel, and which of them were");
  });
});

describe("[F12] the Rust scaffold applies to a crate that has no paneweft wiring and a `mod tests` of its own", () => {
  async function plainWorld() {
    const { session, dir } = await open();
    const root = join(tmp("plain"), "boat");
    cpSync(join(FIXTURES, "crates/plain"), root, { recursive: true });
    cpSync(join(REPO_ROOT, "Cargo.lock"), join(root, "Cargo.lock")); // the versions the SDK builds with, so the check needs no network
    const withBoat = structuredClone(watchfile);
    withBoat.types.push({ typeId: "plain::Boat", source: { path: "src/lib.rs", symbol: "Boat" } });
    mkdirSync(join(dir, "catalogues", "vg"), { recursive: true });
    writeFileSync(join(dir, "catalogues", "vg", "cargo.json"), record("vg", "cargo", withBoat));
    writeFileSync(join(dir, "adapters.json"), JSON.stringify({ adapters: [fakeCargoAdapter({ workspaceRoot: root })] }));
    const context: V1Context = { session, sessionDir: dir, jobs: null };
    const scaffold = async (tool: string, args: Record<string, unknown>, format: "json" | "text" = "json") => {
      const outcome = await executeV1Operation(context, tool, { format, repo: "vg", maxBytes: 32768, ...args });
      expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
      return format === "json" ? (JSON.parse(outcome.body).details as Reply) : outcome.body;
    };
    /** Applies the reply as given: a patch to an existing file is appended to it; the setup commands are run in the crate. */
    const apply = (reply: Reply, options: { skipOutputTest?: boolean } = {}): void => {
      for (const entry of reply.setup) {
        if (entry.command === undefined) continue;
        const ran = spawnSync("bash", ["-c", entry.command], { cwd: root, encoding: "utf8" });
        expect(ran.status, `setup step "${entry.step}": ${entry.command}\n${ran.stdout}${ran.stderr}`).toBe(0);
      }
      for (const file of [...reply.patches, ...(options.skipOutputTest === true ? [] : [reply.outputTest])]) {
        mkdirSync(dirname(join(root, file.path)), { recursive: true });
        appendFileSync(join(root, file.path), `\n${file.text}`);
      }
    };
    /** The messages of a cargo run without its progress lines (the compiler's complaint is what a failing assertion needs to show). */
    const messages = (output: string): string => output.split("\n").filter((line) => !/^\s*(Compiling|Checking|Fresh|Running|Finished)/.test(line)).join("\n").slice(0, 2500);
    const cargo = (...args: string[]) => {
      const split = args.indexOf("--") < 0 ? args.length : args.indexOf("--");
      const result = spawnSync("cargo", [...args.slice(0, split), "--features", "paneweft", "--offline", ...args.slice(split)], { cwd: root, encoding: "utf8", env: { ...process.env, CARGO_TARGET_DIR: join(REPO_ROOT, "target", "scaffold-plain"), CARGO_TERM_COLOR: "never" } });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };
    return { scaffold, apply, cargo, messages, root };
  }

  // why: F12. The scaffold's output test was a second `#[cfg(...)] mod tests` (E0428 in a file that has one), the Cargo feature and the optional dependency
  // were not part of the reply, and the body was `assert!(false)` with no way to build the view. Here the crate has an existing `mod tests`, no feature and
  // no SDK. Applying the reply AS GIVEN (running its setup commands, appending its patches and its test) must compile; the test must fail at run time
  // (not at compile time), on the TODO that asks for a real value; and clippy must accept it with -D warnings.
  // proves: CLAIM(F12-rust-applies)
  it("compiles as given, fails red at run time and passes clippy -D warnings", () => {
    return (async () => {
      const world = await plainWorld();
      const reply = (await world.scaffold("scaffold_view", { type: "plain::Boat", question: "Which crew does this boat carry?" })) as Reply;
      expect(reply.setup.map((entry) => entry.command).filter(Boolean).join("\n"), "the vendoring command names this checkout's script").toContain(join(REPO_ROOT, "scripts/vendor-rust-sdk.mjs"));
      expect(reply.patches.map((patch) => patch.path)).toEqual(["src/lib.rs", "Cargo.toml"]);
      expect(reply.outputTest.text).not.toMatch(/\bmod tests\b/);
      expect(reply.outputTest.text).toContain("mod paneweft_view_tests");
      expect(reply.outputTest.text).not.toContain("assert!(false");
      world.apply(reply);

      const built = world.cargo("test", "--no-run");
      expect(built.status, `the scaffold must compile as given:\n${world.messages(built.output)}`).toBe(0);
      const red = world.cargo("test", "--lib");
      expect(red.status, "the output test is red").not.toBe(0);
      expect(red.output).toMatch(/paneweft_view_tests::which_crew_does_this_boat_carry_answers_the_question[^\n]*FAILED/);
      expect(red.output, "the pre-existing test still runs").toContain("a_boat_keeps_its_name ... ok");
      expect(red.output).toContain("TODO");
      expect(red.output, "red at run time, not at compile time").not.toContain("could not compile");
      const lint = world.cargo("clippy", "--all-targets", "--", "-D", "warnings");
      expect(lint.status, `clippy -D warnings:\n${world.messages(lint.output)}`).toBe(0);

      // the author builds a value: the test now fails on an ASSERTION about the view (an unsupported view has no data to read)
      const lib = join(world.root, "src/lib.rs");
      writeFileSync(lib, readFileSync(lib, "utf8").replace("        None\n", "        Some(Boat::new(\"Ada\", 3))\n"));
      const second = world.cargo("test", "--lib");
      expect(second.status).not.toBe(0);
      expect(second.output).toMatch(/assertion `left == right` failed[^\n]*\n[\s\S]*unsupported|the view is still unsupported/);

      // ...and implements the view: the test passes
      const implemented = readFileSync(lib, "utf8").replace("_cx: &mut", "cx: &mut").replace(/ {8}Ok\(paneweft::View::unsupported\([^\n]*\n/, "        let mut details = cx.details();\n        details.field(\"crew\", self.crew);\n        details.finish()\n");
      writeFileSync(lib, implemented);
      const green = world.cargo("test", "--lib");
      expect(green.status, green.output.slice(-1500)).toBe(0);
      expect(world.cargo("clippy", "--all-targets", "--", "-D", "warnings").status).toBe(0);
    })();
  }, 600_000);

  // why: F12. `scaffold_example` put its example in `mod examples` and never mentioned `paneweft::test_adapter!()` or the feature. As given, the reply must
  // compile with the feature on, and the crate must still build with it off and the SDK absent from the build (the release recipe).
  // proves: CLAIM(F12-rust-applies) CLAIM(F3-vendored-sdk)
  it("an example scaffold compiles as given, with the feature on and with it off", async () => {
    const world = await plainWorld();
    // an example returns a value of a type that has views (`Inspectable`): the view scaffold comes first, as the skill says
    world.apply((await world.scaffold("scaffold_view", { type: "plain::Boat", question: "Which crew does this boat carry?" })) as Reply, { skipOutputTest: true });
    const reply = (await world.scaffold("scaffold_example", { type: "plain::Boat", example: "boat.new" })) as Reply;
    expect(reply.patches.map((patch) => patch.path), "the crate is wired by now: only the example").toEqual(["src/lib.rs"]);
    expect(reply.patches[0]!.text).toContain("paneweft::test_adapter!();");
    world.apply(reply, { skipOutputTest: true });
    const on = world.cargo("test", "--no-run");
    expect(on.status, world.messages(on.output)).toBe(0);
    const off = spawnSync("cargo", ["build", "--release", "--offline"], { cwd: world.root, encoding: "utf8", env: { ...process.env, CARGO_TARGET_DIR: join(REPO_ROOT, "target", "scaffold-plain") } });
    expect(off.status, off.stderr).toBe(0);
  }, 600_000);

  // why: F12. A crate that already carries the feature, the dependency and a `test_adapter!` gets none of them again (a second feature line is a
  // Cargo error), and a second view scaffold is told to add its test to the module the first one made.
  // proves: CLAIM(F12-rust-applies)
  it("emits no Cargo patch and no setup command for a crate that is already wired, and reuses its test module", async () => {
    const world = await plainWorld();
    const first = (await world.scaffold("scaffold_view", { type: "plain::Boat", question: "Which crew does this boat carry?" })) as Reply;
    world.apply(first);
    const again = (await world.scaffold("scaffold_view", { type: "plain::Boat", question: "What is the boat called?" })) as Reply;
    expect(again.patches.map((patch) => patch.path)).toEqual(["src/lib.rs"]);
    expect(again.setup.filter((entry) => entry.command !== undefined)).toEqual([]);
    expect(again.outputTest.text).not.toContain("mod paneweft_view_tests {");
    expect(again.outputTest.text).toMatch(/inside the existing `mod paneweft_view_tests`/);
  }, 120_000);

  // why: F12, found by running the README's own commands: `scaffold_example` refused `source` (UNKNOWN_PROPERTY), so on a fresh repository, where no catalogue names the type yet,
  // the example scaffold could not be asked for at all although the view scaffold could. Both take the explicit source now.
  // proves: CLAIM(F12-rust-applies)
  it("scaffold_example takes an explicit source when no catalogue is stored", async () => {
    const world = await plainWorld();
    const reply = (await world.scaffold("scaffold_example", { type: "plain::Fresh", source: { path: "src/lib.rs", symbol: "Boat" }, example: "boat.fresh" })) as Reply;
    expect(reply.patches[0]!.text).toContain("#[paneweft::example(id = \"boat.fresh\"");
    expect(reply.patches[0]!.text).toContain("use super::Boat;");
  });

  // why: F12. The text reply (what an agent reads) carries the setup, the test and a counts line that agrees with what was returned.
  // proves: CLAIM(F12-counts)
  it("counts the patches it returns", async () => {
    const world = await plainWorld();
    const body = (await world.scaffold("scaffold_view", { type: "plain::Boat", question: "Which crew does this boat carry?" }, "text")) as string;
    expect(body).toContain("counts: unit=patches total=2 matched=2 returned=2 omitted=0 truncated=false");
    expect(body).toContain("setup:");
    expect(body).toContain("vendor-rust-sdk.mjs");
  });
});

describe("[F12] the TypeScript scaffold brings the manifest, the reporter wiring and the SDK install", () => {
  /** The containmarks-lite package copied WITHOUT its manifest and with a vitest config that lists no reporter, the state of a repository nobody has instrumented. */
  async function bareWorld(options: { manifest?: boolean; reporter?: boolean } = {}) {
    const { session, dir } = await open();
    const root = tmp("cmbare");
    cpSync(join(FIXTURES, "packages/containmarks-lite"), root, { recursive: true });
    rmSync(join(root, "node_modules"), { recursive: true, force: true });
    symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
    // the instrumentation exists in the fixture; the scaffold is asked for a view of a type that has none yet
    rmSync(join(root, "src/mappings/containerMappings.paneweft.ts"));
    rmSync(join(root, "tests/mappings.examples.ts"));
    rmSync(join(root, "tests/mappings.paneweft.test.ts"), { force: true });
    rmSync(join(root, "tests/failing-check.paneweft.test.ts"), { force: true });
    rmSync(join(root, "tests/teardown-failure.paneweft.test.ts"), { force: true });
    if (options.manifest === true) writeFileSync(join(root, "paneweft.views.ts"), 'import { defineManifest } from "@paneweft/sdk";\n\nexport const manifest = defineManifest({ runners: ["vitest"], modules: [] });\n');
    else { rmSync(join(root, "paneweft.views.ts")); rmSync(join(root, "src/dev.ts")); }
    const alias = { "@paneweft/sdk": join(REPO_ROOT, "packages/paneweft-ts/src/index.ts"), "@paneweft/sdk/vitest": join(REPO_ROOT, "packages/paneweft-ts/src/vitest.ts"), "@paneweft/sdk/vitest-reporter": join(REPO_ROOT, "packages/paneweft-ts/src/vitest-reporter.ts") };
    writeFileSync(join(root, "vitest.config.ts"), options.reporter === true
      ? `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["tests/**/*.test.ts"], reporters: ["default", "@paneweft/sdk/vitest-reporter"] } });\n`
      : `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });\n`);
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2023", lib: ["ES2023", "DOM"], module: "NodeNext", moduleResolution: "NodeNext", types: ["node"], typeRoots: [join(REPO_ROOT, "node_modules/@types")], strict: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true, isolatedModules: true, allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true, baseUrl: ".", paths: Object.fromEntries(Object.entries(alias).map(([name, path]) => [name, [path]])) },
      include: ["src", "tests", "paneweft.views.ts"],
    }));
    const cm = structuredClone(containmarks);
    mkdirSync(join(dir, "catalogues", "cm"), { recursive: true });
    writeFileSync(join(dir, "catalogues", "cm", "vitest.json"), record("cm", "vitest", { ...cm, types: [...cm.types.filter((type: any) => type.typeId !== "containmarks::ContainerMappingRecord"), { typeId: "containmarks::ContainerMappingRecord", source: { path: "src/models.ts", symbol: "ContainerMappingRecord" } }], views: [], examples: [] }));
    writeFileSync(join(dir, "adapters.json"), JSON.stringify({ adapters: [fakeCargoAdapter({ id: "vitest", kind: "vitest", grammar: "vitest-run/1", repo: "cm", workspaceRoot: root, entry: "." })] }));
    const context: V1Context = { session, sessionDir: dir, jobs: null };
    const scaffold = async (tool: string, args: Record<string, unknown>) => {
      const outcome = await executeV1Operation(context, tool, { format: "json", repo: "cm", maxBytes: 32768, ...args });
      expect(outcome.ok, outcome.body.slice(0, 300)).toBe(true);
      return JSON.parse(outcome.body).details as Reply;
    };
    const apply = (reply: Reply): void => {
      for (const file of [...reply.patches, reply.outputTest]) {
        mkdirSync(dirname(join(root, file.path)), { recursive: true });
        if (existsSync(join(root, file.path))) appendFileSync(join(root, file.path), `\n${file.text}`);
        else writeFileSync(join(root, file.path), file.text);
      }
    };
    const tsc = (): string => {
      const result = spawnSync(process.execPath, [join(REPO_ROOT, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.json")], { encoding: "utf8" });
      return `${result.stdout}${result.stderr}`.trim();
    };
    const vitest = (...args: string[]) => {
      const config = join(root, "vitest.alias.config.ts");
      const aliases = Object.entries(alias).map(([find, replacement]) => `{ find: /^${find.replace(/[/@]/g, "\\$&")}$/, replacement: ${JSON.stringify(replacement)} }`);
      writeFileSync(config, `import { defineConfig } from "vitest/config";\nexport default defineConfig({ resolve: { alias: [${aliases.join(", ")}] }, test: { include: ["tests/**/*.test.ts"] } });\n`);
      const result = spawnSync(process.execPath, [join(REPO_ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", config, "--root", root, ...args], { encoding: "utf8", cwd: root });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };
    return { scaffold, apply, tsc, vitest, root };
  }

  // why: F12. The ContainMarks reply said "add an entry to paneweft.views.ts" though no manifest existed and none was scaffolded, and said nothing about installing
  // `@paneweft/sdk` or wiring the reporter in `vitest.config.ts`. Here the repository has none of them: the reply must hand out a manifest that type-checks with the
  // module, the exact install line for THIS checkout, and the reporter line; once the manifest and the reporter exist, it must not hand them out again.
  // proves: CLAIM(F12-ts-applies)
  it("returns a manifest, the install line and the reporter wiring for a repository without them, and only what is missing otherwise", async () => {
    const bare = await bareWorld();
    const reply = await bare.scaffold("scaffold_view", { type: "containmarks::ContainerMappingRecord", question: "Which original index and container does this mapping preserve?" });
    expect(reply.patches.map((patch) => patch.path)).toEqual(["src/ContainerMappingRecord.paneweft.ts", "paneweft.views.ts"]);
    const [module, manifest] = reply.patches;
    expect(module!.text).toContain('id: "containermappingrecord.which_original_index_and_container_does_this"');
    expect(module!.text).toContain('title: "Which original index and container does this mapping preserve"');
    expect(manifest!.text).toContain('import { defineManifest } from "@paneweft/sdk";');
    expect(manifest!.text).toContain("runners: [\"vitest\"]");
    expect(manifest!.text).toMatch(/path: "src\/ContainerMappingRecord\.paneweft\.ts", types: \[ContainerMappingRecordToken\], views: \[which_original_index_and_container_does_this\]/);
    const commands = reply.setup.map((entry) => entry.command).filter(Boolean);
    expect(commands).toContain(`npm install --save-dev @paneweft/sdk@file:${join(REPO_ROOT, "packages/paneweft-ts")}`);
    expect(reply.setup.map((entry) => entry.step).join("\n")).toContain('reporters: ["default", "@paneweft/sdk/vitest-reporter"]');
    bare.apply(reply);
    expect(bare.tsc(), "the module, the manifest and the output test type-check together").toBe("");

    const wired = await bareWorld({ manifest: true, reporter: true });
    const quiet = await wired.scaffold("scaffold_view", { type: "containmarks::ContainerMappingRecord", question: "Which original index and container does this mapping preserve?" });
    expect(quiet.patches.map((patch) => patch.path), "an existing manifest is edited by the registration step, not replaced").toEqual(["src/ContainerMappingRecord.paneweft.ts"]);
    expect(quiet.setup.map((entry) => entry.step).join("\n")).not.toContain("reporters:");
    expect(quiet.registration).toContain("paneweft.views.ts");
  }, 120_000);

  // why: F12. The TypeScript output test was `assert.fail(...)` with no way to build the view. It must build the view in memory with the SDK's `Capture`, run red
  // on an ASSERTION (never a TypeError on a view that has no data), and pass once the value exists and the view is implemented. Run under a real Vitest.
  // proves: CLAIM(F12-ts-red-recipe)
  it("the output test builds the view in memory: red on an assertion, green once the view is implemented", async () => {
    const world = await bareWorld();
    const reply = await world.scaffold("scaffold_view", { type: "containmarks::ContainerMappingRecord", question: "Which backup name does this mapping keep?" });
    world.apply(reply);
    const red = world.vitest();
    expect(red.status, red.output.slice(-1500)).not.toBe(0);
    expect(red.output).toContain("TODO: build a ContainerMappingRecord");
    expect(red.output).not.toContain("TypeError");

    const test = join(world.root, reply.outputTest.path);
    writeFileSync(test, readFileSync(test, "utf8").replace(/function sample\(\): unknown \{\n[^\n]*\n\}/, "function sample(): unknown {\n  return { firstSeenIndex: 1, cookieStoreId: \"firefox-container-1\", backupName: \"Work\" };\n}"));
    const assertion = world.vitest();
    expect(assertion.status).not.toBe(0);
    expect(assertion.output).toMatch(/AssertionError/);
    expect(assertion.output).toContain("unsupported");
    expect(assertion.output).not.toContain("TypeError");

    const module = join(world.root, reply.patches[0]!.path);
    writeFileSync(module, readFileSync(module, "utf8").replace(/ {4}return view\.unsupported\([^\n]*\n/, "    return view.details().field(\"backup name\", value.backupName).done();\n"));
    const green = world.vitest();
    expect(green.status, green.output.slice(-1500)).toBe(0);
  }, 180_000);
});
