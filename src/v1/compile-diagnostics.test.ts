// Compile diagnostics (field test F6). `cm-2` had 41 tsc errors; the collection listed 20 and nothing said that 21 were dropped, and every listed error said
// "fix the view source", also the 27 that sit in the paneweft SDK outside the repository root. The input below is the output of the REAL TypeScript compiler
// on a project whose files are partly under its root, partly outside it (the SDK), as in the field test.
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../test/helpers/fixtures.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { compileDiagnostics } from "./compile-diagnostics.ts";

const tmp = useTempDirs();

/** A project `<base>/app` with `own` type errors of its own and an SDK copy `<base>/sdk/packages/paneweft-ts` and a stray `<base>/shared` file outside the root. */
function realTscOutput(own: number, sdk: number, shared: number): { root: string; output: string } {
  const base = tmp("f6");
  const root = join(base, "app");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(base, "sdk/packages/paneweft-ts/src"), { recursive: true });
  mkdirSync(join(base, "shared"), { recursive: true });
  const body = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i}: number = "not a number ${i}";`).join("\n");
  writeFileSync(join(root, "src/views.ts"), body(own));
  writeFileSync(join(base, "sdk/packages/paneweft-ts/src/builders.ts"), body(sdk));
  writeFileSync(join(base, "shared/helpers.ts"), body(shared));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "es2022", module: "esnext", moduleResolution: "bundler" }, files: ["src/views.ts", "../sdk/packages/paneweft-ts/src/builders.ts", "../shared/helpers.ts"] }));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  const run = spawnSync(process.execPath, [join(REPO_ROOT, "node_modules/typescript/lib/tsc.js"), "--pretty", "false", "-p", "tsconfig.json"], { cwd: root, encoding: "utf8" });
  return { root, output: `${run.stdout}${run.stderr}` };
}

describe("[F6] compile diagnostics say what was left out and where the error is", () => {
  // why: F6. 41 errors, 20 listed, no count. The reply must say how many more there are and break the total down, so the reader knows whether fixing the listed ones will do.
  // proves: CLAIM(F6-omitted-count)
  it("adds a diagnostic with the omitted count and the breakdown when more than 20 errors exist", () => {
    const { root, output } = realTscOutput(14, 14, 13);
    expect(output.match(/error TS/g)).toHaveLength(41);
    const diagnostics = compileDiagnostics({ log: "", typecheck: { output }, kind: "vitest", root });
    const listed = diagnostics.filter((d) => d.id.startsWith("diag-compile-") && d.id !== "diag-compile-omitted");
    expect(listed).toHaveLength(20);
    const omitted = diagnostics.find((d) => d.id === "diag-compile-omitted")!;
    expect(omitted, "the omission is a diagnostic").toBeDefined();
    expect(omitted.message).toContain("21 more");
    expect(omitted.message).toContain("41 in total");
    expect(omitted.message).toContain("14 in the repository");
    expect(omitted.message).toContain("14 in the paneweft SDK");
    expect(omitted.message).toContain("13 outside the repository root");
    expect(omitted.nextAction).toContain("--log-cursor 0");
  });

  // why: F6. At most 20 errors: nothing is omitted, so no omission diagnostic is invented.
  // proves: CLAIM(F6-omitted-count)
  it("adds nothing when everything is listed", () => {
    const { root, output } = realTscOutput(3, 0, 0);
    const diagnostics = compileDiagnostics({ log: "", typecheck: { output }, kind: "vitest", root });
    expect(diagnostics.map((d) => d.id)).toEqual(["diag-compile-1", "diag-compile-2", "diag-compile-3"]);
  });

  // why: F6. `paneweft failure run-cm-2:diag-compile-20` -> `source: ../paneweft/packages/paneweft-ts/src/builders.ts:6:103 ... next: Fix the named property or type in the view source`.
  // An error in the SDK, or in a file outside the root, says so and does not send the reader to the view source.
  // proves: CLAIM(F6-next-action)
  it("tells an SDK error, an error outside the root and an error in the repository apart", () => {
    const { root, output } = realTscOutput(1, 1, 1);
    const byPath = Object.fromEntries(compileDiagnostics({ log: "", typecheck: { output }, kind: "vitest", root }).map((d) => [d.source!.path, d]));
    const sdk = byPath["../sdk/packages/paneweft-ts/src/builders.ts"]!;
    const outside = byPath["../shared/helpers.ts"]!;
    const own = byPath["src/views.ts"]!;
    expect(sdk.nextAction).toMatch(/paneweft SDK/);
    expect(sdk.nextAction).not.toMatch(/Fix the named/);
    expect(outside.nextAction).toMatch(/outside the repository root/);
    expect(outside.nextAction).not.toMatch(/Fix the named/);
    expect(own.nextAction).toMatch(/Fix the named property or type in the view source/);
    // F5: an error in a repository file the instrumentation may not even import points at the adapter's tsconfig, the way to scope the typecheck
    expect(own.nextAction).toMatch(/adapter with a `tsconfig`/);
  });

  // why: F6 for Rust. The same classification for a cargo log: the SDK's git checkout under CARGO_HOME (where the git dependency compiles from), a `cargo vendor` path, a path outside the root, and the author's file.
  // proves: CLAIM(F6-next-action)
  it("classifies cargo errors by the path of their span", () => {
    const log = [
      "error[E0599]: no method named `field` found", " --> src/watch.rs:10:5", "",
      "error[E0308]: mismatched types", " --> /home/user/.cargo/git/checkouts/paneweft-1a2b3c/cb01e0e/crates/paneweft/src/lib.rs:3:9", "",
      "error[E0308]: mismatched types", " --> vendor/paneweft/src/lib.rs:3:9", "",
      "error[E0432]: unresolved import", " --> /somewhere/else/lib.rs:1:5", "",
    ].join("\n");
    const found = compileDiagnostics({ log, typecheck: undefined, kind: "cargo", root: "/work/vigil" });
    expect(found.map((d) => d.source!.path)).toEqual(["src/watch.rs", "/home/user/.cargo/git/checkouts/paneweft-1a2b3c/cb01e0e/crates/paneweft/src/lib.rs", "vendor/paneweft/src/lib.rs", "/somewhere/else/lib.rs"]);
    expect(found[0]!.nextAction).toMatch(/Fix the named field or type in the view source/);
    expect(found[0]!.nextAction, "cargo has no tsconfig to scope").not.toMatch(/tsconfig/);
    expect(found[1]!.nextAction).toMatch(/paneweft SDK/);
    expect(found[2]!.nextAction).toMatch(/paneweft SDK/);
    expect(found[3]!.nextAction).toMatch(/outside the repository root/);
  });

  // why: F6. With no parseable error the fallback stays one diagnostic carrying the output (unchanged behaviour).
  // proves: CLAIM(F6-omitted-count)
  it("keeps the single fallback diagnostic when nothing parses", () => {
    const found = compileDiagnostics({ log: "something broke", typecheck: undefined, kind: "cargo", root: "/work/vigil" });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "diag-compile-1", category: "compiler", message: "the instrumentation did not compile" });
  });
});
