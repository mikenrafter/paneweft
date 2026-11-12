// Adapter registration checks that the runner it names exists (F30a).
import { describe, expect, it } from "vitest";
import { mustFail, must } from "../../test/helpers/must.ts";
import { useTempDirs } from "../../test/helpers/tmp.ts";
import { loadAdapters, registerAdapter, type AdapterRecord } from "./adapters.ts";

const tmp = useTempDirs();
const cargo: AdapterRecord = { schemaVersion: "paneweft.adapter/1", id: "cargo", kind: "cargo", grammar: "cargo-test/1", repo: "vg", executable: process.execPath, workspaceRoot: "/work/vigil", entry: ".", features: ["paneweft"], supportedVersions: ["1.97"], limits: { timeoutMs: 60000, logBytes: 65536 }, queue: { wrapper: "qex", cpu: "1", mem: "1GB" } };

describe("[F30a] registration checks the executable", () => {
  // why: F30a. `adapter add` accepted an adapter whose executable does not exist; the first collect then failed with the catch-all registration
  // diagnostic about `paneweft::test_adapter!()`. An absolute path that names no executable file is refused at registration, naming the path.
  // proves: CLAIM(F30a-executable-exists)
  it("refuses an absolute executable that does not exist or is not executable, and accepts one that is", async () => {
    const dir = tmp("adapters-exe");
    const missing = mustFail(await registerAdapter(dir, { ...cargo, executable: "/nonexistent/bin/cargo" }), "missing");
    expect(missing.errors.map((e) => [e.code, e.pointer])).toContainEqual(["CONSTRAINT", "/executable"]);
    expect(missing.message).toContain("/nonexistent/bin/cargo");
    const directory = mustFail(await registerAdapter(dir, { ...cargo, executable: dir }), "directory");
    expect(directory.errors.map((e) => e.pointer)).toContain("/executable");
    must(await registerAdapter(dir, cargo), "an executable that exists");
    expect(must(await loadAdapters(dir), "load")).toEqual([cargo]);
  });
});
