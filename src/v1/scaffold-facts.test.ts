// S3: `paneweft::test_adapter!()` is needed once per TEST BINARY. The scaffold's fact "this binary already has the hook" looks only at the files that are compiled into the
// binary of the file the scaffold patches: the library's tests (src/), one integration-test binary per file of tests/ (or per directory of tests/), one binary per target of src/bin.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { fakeCargoAdapter } from "../../test/helpers/v1-world.ts";
import { binaryFiles, rustFacts } from "./scaffold-facts.ts";

const tmp = useTempDirs();
const HOOK = "paneweft::test_adapter!();\n";

function crate(files: Record<string, string>) {
  const root = tmp("facts");
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "c"\nversion = "0.0.0"\nedition = "2021"\n');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const adapter = fakeCargoAdapter({ workspaceRoot: root, entry: "." });
  return (source: string) => rustFacts(adapter, source).testAdapter;
}

describe("[S3] which files make up the test binary of a source file", () => {
  // why: S3. The hook of one binary does not cover another; a table of source files and the files of their binary.
  // proves: CLAIM(S3-hook-per-binary)
  it("names the library, each integration test and each binary target as separate binaries", () => {
    const files = ["src/lib.rs", "src/util/mod.rs", "src/main.rs", "src/bin/tool.rs", "src/bin/multi/main.rs", "src/bin/multi/helper.rs", "tests/a.rs", "tests/b.rs", "tests/dir/main.rs", "tests/dir/part.rs"];
    const of = (source: string) => files.filter(binaryFiles(source));
    expect(of("src/lib.rs")).toEqual(["src/lib.rs", "src/util/mod.rs"]);
    expect(of("src/util/mod.rs")).toEqual(["src/lib.rs", "src/util/mod.rs"]);
    expect(of("src/main.rs")).toEqual(["src/main.rs"]);
    expect(of("src/bin/tool.rs")).toEqual(["src/bin/tool.rs"]);
    expect(of("src/bin/multi/main.rs")).toEqual(["src/bin/multi/main.rs", "src/bin/multi/helper.rs"]);
    expect(of("tests/a.rs")).toEqual(["tests/a.rs"]);
    expect(of("tests/dir/main.rs")).toEqual(["tests/dir/main.rs", "tests/dir/part.rs"]);
  });
});

describe("[S3] the hook is looked for in the binary of the file being patched", () => {
  // why: S3 (review field r1). The only hook was in tests/existing.rs; the crate-wide answer "a hook exists" suppressed the hook the library-test binary needed.
  // proves: CLAIM(S3-hook-per-binary)
  it("a hook in an integration test does not count for the library, nor the other way round", () => {
    const hasHook = crate({ "src/lib.rs": "pub struct Boat;\n", "tests/existing.rs": HOOK });
    expect(hasHook("src/lib.rs")).toBe(false);
    expect(hasHook("tests/existing.rs")).toBe(true);
    expect(hasHook("tests/other.rs")).toBe(false);
    const libHook = crate({ "src/lib.rs": "mod hook;\n", "src/hook.rs": HOOK, "tests/existing.rs": "// no hook\n" });
    expect(libHook("src/lib.rs"), "a hook in any module file of the library counts for the library").toBe(true);
    expect(libHook("tests/existing.rs")).toBe(false);
  });
});
