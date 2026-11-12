// F3: a build of a crate that has the paneweft feature OFF needs nothing from the paneweft checkout. The spec's recipe made the SDK an optional path dependency on a checkout
// next to the repository; Cargo reads optional path dependencies even when their feature is off, so vigil stopped building (and its Nix build with it) wherever the checkout
// is absent. The fixture crates live inside the paneweft repository, so their path always existed and no test could see it. These tests use REAL cargo on a crate copied OUT of
// the paneweft repository, where the sibling checkout does not exist.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, REPO_ROOT } from "../helpers/fixtures.ts";
import { useTempDirs } from "../helpers/tmp.ts";

const tmp = useTempDirs();
const cargo = (() => { try { return execFileSync("which", ["cargo"], { encoding: "utf8" }).trim(); } catch { return `${process.env.HOME}/.cargo/bin/cargo`; } })();

/** The watchfile fixture crate (in-crate views and examples behind the `paneweft` feature) copied to a directory with no paneweft checkout anywhere above it. */
function crateOutsideTheCheckout(): string {
  const root = join(tmp("vendoring"), "vigil");
  cpSync(join(FIXTURES, "crates/watchfile"), root, { recursive: true });
  return root;
}
const runCargo = (root: string, args: string[]) => spawnSync(cargo, args, { cwd: root, encoding: "utf8", env: { ...process.env, CARGO_TARGET_DIR: join(root, "target"), CARGO_TERM_COLOR: "never" } });

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

  // why: F3, the recipe. The SDK is copied into the repository (scripts/vendor-rust-sdk.mjs) and the optional dependency points at the copy. With no checkout anywhere, the release
  // build with the feature off succeeds and holds no trace of the SDK; with the feature on, the same crate builds and its tests (the catalogue export and the in-crate
  // examples) run against the copy.
  // proves: CLAIM(F3-vendored-sdk)
  it("a crate with the SDK copied into it builds with the feature off, and with it on", () => {
    const root = crateOutsideTheCheckout();
    const vendored = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/vendor-rust-sdk.mjs"), "vendor/paneweft"], { cwd: root, encoding: "utf8" });
    expect(vendored.status, vendored.stdout + vendored.stderr).toBe(0);
    expect(readdirSync(join(root, "vendor/paneweft")).sort()).toEqual(["VENDORED", "paneweft", "paneweft-macros"]);
    const manifest = readFileSync(join(root, "vendor/paneweft/paneweft/Cargo.toml"), "utf8");
    expect(manifest, "inherited keys are written out; a copy has no workspace").not.toMatch(/workspace\s*=\s*true/);
    expect(manifest, "a copy carries no dev-dependencies").not.toContain("dev-dependencies");
    writeFileSync(join(root, "Cargo.toml"), readFileSync(join(root, "Cargo.toml"), "utf8").replace('path = "../../../crates/paneweft"', 'path = "vendor/paneweft/paneweft"'));

    const lock = runCargo(root, ["generate-lockfile", "--offline"]);
    expect(lock.status, lock.stderr).toBe(0);
    const release = runCargo(root, ["build", "--release", "--offline", "--locked"]);
    expect(release.status, release.stderr).toBe(0);
    const rlib = readdirSync(join(root, "target/release")).find((name) => name.endsWith(".rlib"));
    expect(rlib, "the release build produced the library").toBeDefined();
    // markers the SDK leaves in anything that links it (the directory of this test is named after paneweft too, so the bare word proves nothing)
    const built = readFileSync(join(root, "target/release", rlib as string));
    for (const marker of ["paneweft_", "PANEWEFT_", "linkme", "paneweft::"]) expect(built.includes(marker), `a feature-off build holds no trace of the SDK: ${marker}`).toBe(false);
    expect(runCargo(root, ["tree", "--offline", "--locked"]).stdout, "the SDK is not in the feature-off dependency graph").not.toMatch(/paneweft(-macros)? v\d/);

    const tests = runCargo(root, ["test", "--offline", "--locked", "--features", "paneweft", "--lib"]);
    expect(tests.status, tests.stdout + tests.stderr).toBe(0);
    expect(tests.stdout).toMatch(/test result: ok\. [1-9]\d* passed/);
    expect(existsSync(join(root, "vendor/paneweft/VENDORED"))).toBe(true);
  }, 600_000);
});
