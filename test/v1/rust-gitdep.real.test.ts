// F3: a build of a crate that has the paneweft feature OFF needs nothing from the paneweft checkout. The spec's recipe made the SDK an optional path dependency on a checkout
// next to the repository; Cargo reads optional path dependencies even when their feature is off, so vigil stopped building (and its Nix build with it) wherever the checkout
// is absent. The recipe is now a rev-pinned git dependency on the public repository. The fixture crates live inside the paneweft repository, so their path always existed and no test could see it. These tests use REAL cargo on a crate copied OUT of
// the paneweft repository, where the sibling checkout does not exist.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../helpers/fixtures.ts";
import { sdkGitEnv } from "../helpers/sdk-git.ts";
import { SDK_GIT_REV, SDK_GIT_URL } from "../../src/v1/sdk-source.ts";
import { useTempDirs } from "../helpers/tmp.ts";

const tmp = useTempDirs();
const cargo = (() => { try { return execFileSync("which", ["cargo"], { encoding: "utf8" }).trim(); } catch { return `${process.env.HOME}/.cargo/bin/cargo`; } })();

/** The watchfile fixture crate (in-crate views and examples behind the `paneweft` feature) copied to a directory with no paneweft checkout anywhere above it. */
function crateOutsideTheCheckout(): string {
  const root = join(tmp("vendoring"), "vigil");
  cpSync(join(FIXTURES, "crates/watchfile"), root, { recursive: true });
  return root;
}
const runCargo = (root: string, args: string[], extra: Record<string, string> = {}) => spawnSync(cargo, args, { cwd: root, encoding: "utf8", env: { ...process.env, ...extra, CARGO_TARGET_DIR: join(root, "target"), CARGO_TERM_COLOR: "never" } });

describe("[F3] a feature-off build needs nothing from paneweft", () => {
  // why: F3, the defect itself. The old recipe (an optional path dependency outside the repository) fails a plain `cargo build --release` when the checkout is absent. This is the
  // characterization that explains the recipe below; it stays green because the old recipe is still what a fixture inside this repository uses.
  // proves: CLAIM(F3-defect)
  it("an optional path dependency outside the repository breaks the build where it is absent", () => {
    const root = crateOutsideTheCheckout();
    const built = runCargo(root, ["build", "--release", "--offline"]);
    expect(built.status).not.toBe(0);
    expect(built.stderr).toMatch(/failed to (read|load)[^\n]*\n?[^\n]*Cargo\.toml/);
    expect(built.stderr).toContain("paneweft");
  });

  // why: F3, the recipe. The SDK is a rev-pinned git dependency on the public repository (here served by a local mirror of this checkout, the same commit the scaffold pins). With
  // no checkout anywhere, after one `cargo fetch` the release build with the feature off succeeds OFFLINE and holds no trace of the SDK; with the feature on, the same crate
  // builds and its tests (the catalogue export and the in-crate examples) run against the git checkout. Cargo finds `paneweft` and its path dependency `paneweft-macros`
  // inside the repository and resolves the workspace-inherited keys itself, so no manifest is rewritten.
  // proves: CLAIM(F3-git-sdk)
  it("a crate with the SDK as a pinned git dependency builds offline after one fetch with the feature off, and builds and tests with it on", () => {
    const root = crateOutsideTheCheckout();
    const manifestPath = join(root, "Cargo.toml");
    const original = readFileSync(manifestPath, "utf8");
    const recipe = original.replace('path = "../../../crates/paneweft"', `git = "${SDK_GIT_URL}"\nrev = "${SDK_GIT_REV}"`);
    expect(recipe, "the fixture's path line was replaced by the recipe").not.toBe(original);
    writeFileSync(manifestPath, recipe);
    const env = sdkGitEnv();

    const fetched = runCargo(root, ["fetch"], env);
    expect(fetched.status, fetched.stderr).toBe(0);
    const lock = readFileSync(join(root, "Cargo.lock"), "utf8");
    expect(lock, "the lock names the git source at the pinned commit").toContain(`source = "git+${SDK_GIT_URL}?rev=${SDK_GIT_REV}#${SDK_GIT_REV}"`);

    const release = runCargo(root, ["build", "--release", "--offline", "--locked"], env);
    expect(release.status, release.stderr).toBe(0);
    const rlib = readdirSync(join(root, "target/release")).find((name) => name.endsWith(".rlib"));
    expect(rlib, "the release build produced the library").toBeDefined();
    // markers the SDK leaves in anything that links it (the directory of this test is named after paneweft too, so the bare word proves nothing)
    const built = readFileSync(join(root, "target/release", rlib as string));
    for (const marker of ["paneweft_", "PANEWEFT_", "linkme", "paneweft::"]) expect(built.includes(marker), `a feature-off build holds no trace of the SDK: ${marker}`).toBe(false);
    expect(runCargo(root, ["tree", "--offline", "--locked"], env).stdout, "the SDK is not in the feature-off dependency graph").not.toMatch(/paneweft(-macros)? v\d/);

    const tests = runCargo(root, ["test", "--offline", "--locked", "--features", "paneweft", "--lib"], env);
    expect(tests.status, tests.stdout + tests.stderr).toBe(0);
    expect(tests.stdout).toMatch(/test result: ok\. [1-9]\d* passed/);
  }, 600_000);

  // why: F3, the failure the recipe must not hide. A rev that the remote does not have fails the fetch loudly and early (a bad pin is not discovered at a customer's release build).
  // proves: CLAIM(F3-git-sdk)
  it("a rev the remote does not have fails at fetch, naming the rev", () => {
    const root = crateOutsideTheCheckout();
    const manifestPath = join(root, "Cargo.toml");
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace('path = "../../../crates/paneweft"', `git = "${SDK_GIT_URL}"\nrev = "${"2".repeat(40)}"`));
    const fetched = runCargo(root, ["fetch"], sdkGitEnv());
    expect(fetched.status).not.toBe(0);
    expect(fetched.stderr).toContain("2".repeat(40).slice(0, 7));
  }, 120_000);
});
