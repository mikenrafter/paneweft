// F3: the SDK dependency recipe has one source of truth (`sdk-source.ts`), and what the docs and scaffolds print must agree with it and with this checkout.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../test/helpers/fixtures.ts";
import { sdkMirror } from "../../test/helpers/sdk-git.ts";
import { SDK_GIT_REV, SDK_GIT_URL, sdkDependencySource, sdkDependencyToml } from "./sdk-source.ts";

const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

describe("[F3] the pinned SDK source", () => {
  // why: F3. A branch or tag name in `rev` is not a pin; `cargo` accepts a short sha, which is ambiguous as a repository grows. The recipe is a full commit.
  // proves: CLAIM(F3-rev-policy)
  it("is a full 40-hex commit of the public repository over https", () => {
    expect(SDK_GIT_REV).toMatch(/^[0-9a-f]{40}$/);
    expect(SDK_GIT_URL).toBe("https://github.com/mikenrafter/paneweft");
  });

  // why: F3. Scaffolds pin the SDK at SDK_GIT_REV. If `crates/` changed after that commit, an instrumented repository would build an SDK the host's tools do not
  // know (the wire format, the macros). The test compares the two trees; it fails with the commands that fix it. The pin is checked against the real object store, so a
  // pin on a commit that this checkout does not have fails too (sdkMirror throws).
  // proves: CLAIM(F3-rev-policy)
  it("names a commit whose crates equal this checkout's crates", () => {
    sdkMirror();
    const diff = execFileSync("git", ["diff", "--stat", SDK_GIT_REV, "--", "crates/paneweft", "crates/paneweft-macros", "Cargo.toml"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(diff, `crates/ changed since the pinned commit ${SDK_GIT_REV}. Push the change, then set SDK_GIT_REV in src/v1/sdk-source.ts (and the docs that quote it) to the pushed commit.`).toBe("");
  });

  // why: F3. Four places print the recipe for people and agents; each must carry exactly the pin the scaffold uses, so one bump changes all of them (and a doc that
  // still tells the vendoring recipe, which no longer exists, fails).
  // proves: CLAIM(F3-docs-agree)
  it("is the pin every document quotes, and no document tells the vendoring recipe", () => {
    for (const path of ["README.md", "docs/v1-red-contract.md", "skills/paneweft-views/SKILL.md"]) {
      const text = read(path);
      expect(text, `${path} quotes the pinned git dependency`).toContain(`git = "${SDK_GIT_URL}"`);
      expect(text, `${path} quotes the pinned rev`).toContain(`rev = "${SDK_GIT_REV}"`);
      expect([...text.matchAll(/rev = "([0-9a-f]{40})"/g)].map((m) => m[1]).filter((rev) => rev !== SDK_GIT_REV), `${path} quotes no other rev`).toEqual([]);
      expect(text, `${path} does not tell the vendoring recipe`).not.toMatch(/vendor-rust-sdk|vendor\/paneweft/);
    }
  });
});

describe("[F3] reading how Cargo.toml declares the SDK", () => {
  // why: F3. The scaffold's steps depend on what the manifest already says; each form a person writes must be classified, and the printed recipe must parse back to what was meant.
  // proves: CLAIM(F3-git-sdk)
  it("classifies none, path, git with and without a rev, and the inline form", () => {
    expect(sdkDependencySource(undefined)).toEqual({ kind: "none" });
    expect(sdkDependencySource('[package]\nname = "x"\n')).toEqual({ kind: "none" });
    expect(sdkDependencySource('[dependencies.paneweft]\npath = "../p/crates/paneweft"\noptional = true\n')).toEqual({ kind: "path", path: "../p/crates/paneweft" });
    expect(sdkDependencySource('[dependencies]\npaneweft = { path = "../p", optional = true }\n')).toEqual({ kind: "path", path: "../p" });
    expect(sdkDependencySource(`[dependencies.paneweft]\ngit = "${SDK_GIT_URL}"\noptional = true\n\n[features]\npaneweft = ["dep:paneweft"]\n`)).toEqual({ kind: "git", url: SDK_GIT_URL, rev: undefined });
    expect(sdkDependencySource(`[dependencies]\npaneweft = { git = "${SDK_GIT_URL}", rev = "abc", optional = true }\n`)).toEqual({ kind: "git", url: SDK_GIT_URL, rev: "abc" });
    expect(sdkDependencySource('[dependencies.paneweft]\nversion = "1"\n')).toEqual({ kind: "other" });
    expect(sdkDependencySource(`# git = "nope"\n${sdkDependencyToml().join("\n")}\n[features]\nx = []\n`)).toEqual({ kind: "git", url: SDK_GIT_URL, rev: SDK_GIT_REV });
  });
});
