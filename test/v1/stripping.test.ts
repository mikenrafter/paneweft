// Release stripping (IV4): compiled dependency graphs and bundle artifacts, with accidental-activation controls. Never an
// environment variable's name; never a source grep.
import { cpSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PANEWEFT_SDK_SENTINEL } from "../../packages/paneweft-ts/src/index.ts";
import { checkBundleStripping, checkCargoReleaseGraph } from "../../src/v1/release-check.ts";
import { FIXTURES, REPO_ROOT } from "../helpers/v1-world.ts";
import { must } from "../helpers/must.ts";
import { useTempDirs } from "../helpers/tmp.ts";

const tmp = useTempDirs();
const crate = (name: string) => join(FIXTURES, "crates", name, "Cargo.toml");
const fixture = join(FIXTURES, "packages/containmarks-lite");
const MARKERS = [PANEWEFT_SDK_SENTINEL, "paneweft.views", "defineManifest"];

describe("[IV4] Rust release graph", () => {
  // why: IV4. The release recipe (no --features paneweft) resolves a graph WITHOUT the paneweft crate.
  // proves: CLAIM(IV4)
  it("a release build without the feature does not depend on paneweft", async () => {
    const report = must(await checkCargoReleaseGraph(crate("release-clean"), "paneweft"), "release-clean");
    expect(report).toEqual({ clean: true, paths: [] });
  }, 180_000);

  // why: IV4 accidental-activation control. Cargo features are additive: a dependency that turns the feature on leaks the SDK into the
  // release graph, and the report names the whole dependency path.
  // proves: CLAIM(IV4)
  it("a dependency that activates the feature is caught with its path", async () => {
    const report = must(await checkCargoReleaseGraph(crate("release-leaky"), "paneweft"), "release-leaky");
    expect(report).toEqual({ clean: false, paths: [["release-leaky", "watchfile", "paneweft"]] });
  }, 180_000);

  // why: IV4 positive control for the control: the instrumented crate itself, built with its default features, is clean.
  // proves: CLAIM(IV4)
  it("the instrumented crate is clean by default", async () => {
    expect(must(await checkCargoReleaseGraph(crate("watchfile"), "paneweft"), "watchfile")).toEqual({ clean: true, paths: [] });
  }, 180_000);
});

describe("[IV4] TypeScript production bundle", () => {
  // why: IV4. The production entry bundles without the SDK sentinel, the manifest or the manifest helper; the development entry bundles
  // WITH them (positive control: the markers are findable when present).
  // proves: CLAIM(IV4)
  it("the production entry is clean and the development entry is not", async () => {
    expect(must(await checkBundleStripping(join(fixture, "src/index.ts"), MARKERS), "production")).toEqual({ clean: true, findings: [] });
    const development = must(await checkBundleStripping(join(fixture, "src/dev.ts"), MARKERS), "development");
    expect(development.clean).toBe(false);
    expect(development.findings.map((f) => f.marker).sort()).toEqual(expect.arrayContaining([PANEWEFT_SDK_SENTINEL, "defineManifest"]));
  }, 120_000);

  // why: IV4 accidental-import control. A production entry that re-exports an instrumentation file pulls the SDK into the bundle even
  // though the SDK is "only a dev dependency": installing it as a dev dependency does not strip anything. The report names the module.
  // proves: CLAIM(IV4)
  it("a production entry that imports an instrumentation module is caught", async () => {
    const dir = tmp("leaky-bundle");
    cpSync(fixture, dir, { recursive: true, filter: (source) => !source.includes("node_modules") });
    symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
    writeFileSync(join(dir, "tsconfig.json"), readFileSync(join(dir, "tsconfig.json"), "utf8").replaceAll("../../../tsconfig.json", join(REPO_ROOT, "tsconfig.json")).replaceAll("../../../packages", join(REPO_ROOT, "packages")));
    writeFileSync(join(dir, "src/index.ts"), `${readFileSync(join(dir, "src/index.ts"), "utf8")}\nexport { Mapping } from "./mappings/containerMappings.paneweft.ts";\n`);
    const report = must(await checkBundleStripping(join(dir, "src/index.ts"), MARKERS), "leaky");
    expect(report.clean).toBe(false);
    expect(report.findings.some((f) => f.module.endsWith("containerMappings.paneweft.ts") || f.module.includes("paneweft-ts"))).toBe(true);
  }, 120_000);
});
